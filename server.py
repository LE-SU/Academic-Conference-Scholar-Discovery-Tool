from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
import cgi
import base64
import json
import os
import re
import sys
import uuid

ROOT = Path(__file__).resolve().parent
VENDOR = ROOT / "vendor"
if str(VENDOR) not in sys.path:
    sys.path.insert(0, str(VENDOR))

try:
    from pypdf import PdfReader
except Exception as exc:  # pragma: no cover
    PdfReader = None
    PDF_IMPORT_ERROR = str(exc)
else:
    PDF_IMPORT_ERROR = ""

try:
    import fitz
except Exception:  # pragma: no cover
    fitz = None

MAX_REFERENCES_PER_FILE = 80
MAX_AUTHORS_TOTAL = 80
MAX_REFERENCE_IMAGE_PAGES = 6
REFERENCE_IMAGE_DIR = ROOT / "generated" / "reference_sections"
REFERENCE_IMAGE_DIR.mkdir(parents=True, exist_ok=True)
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")


class ScholarDiscoveryHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        if not self.is_authorized():
            self.request_password()
            return
        super().do_GET()

    def do_POST(self):
        if not self.is_authorized():
            self.request_password()
            return
        if self.path == "/api/extract-citations":
            self.extract_citations()
            return
        self.send_error(404, "Unknown endpoint")

    def is_authorized(self):
        if not APP_PASSWORD:
            return True
        header = self.headers.get("Authorization", "")
        if not header.startswith("Basic "):
            return False
        try:
            decoded = base64.b64decode(header.removeprefix("Basic ")).decode("utf-8")
        except Exception:
            return False
        _username, _sep, password = decoded.partition(":")
        return password == APP_PASSWORD

    def request_password(self):
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="Scholar Discovery Tool"')
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"Password required.")

    def extract_citations(self):
        if PdfReader is None:
            self.write_json(
                {
                    "error": f"PDF extraction library is unavailable: {PDF_IMPORT_ERROR}",
                    "files": [],
                    "cited_authors": [],
                    "references": [],
                },
                status=500,
            )
            return

        content_type = self.headers.get("Content-Type", "")
        if not content_type.startswith("multipart/form-data"):
            self.write_json({"error": "Expected multipart/form-data upload."}, status=400)
            return

        form = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ=self.build_cgi_environ())
        uploads = form["pdfs"] if "pdfs" in form else []
        if not isinstance(uploads, list):
            uploads = [uploads]

        files = []
        all_references = []
        all_cited_authors = []
        author_articles = []
        reference_images = []
        citation_highlights = {}
        extraction_errors = []

        with TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)
            for index, item in enumerate(uploads):
                if not getattr(item, "filename", ""):
                    continue
                safe_name = Path(item.filename).name or f"upload-{index}.pdf"
                pdf_path = tmpdir_path / safe_name
                pdf_path.write_bytes(item.file.read())
                try:
                    section = extract_reference_section(pdf_path, item.filename)
                    references = extract_references(section["text"])
                    cited_authors = extract_author_names(references)
                    author_articles.extend(build_author_article_rows(references, item.filename))
                    reference_images.extend(section["images"])
                    merge_highlights(
                        citation_highlights,
                        build_citation_highlights(pdf_path, section["image_records"], cited_authors),
                    )
                    files.append(
                        {
                            "name": item.filename,
                            "references_found": len(references),
                            "text_chars": len(section["text"]),
                            "section_pages": section["pages"],
                            "extraction_method": section["method"],
                        }
                    )
                    all_references.extend(references[:MAX_REFERENCES_PER_FILE])
                    all_cited_authors.extend(cited_authors)
                except Exception as exc:
                    files.append({"name": item.filename, "references_found": 0, "text_chars": 0})
                    extraction_errors.append(f"{item.filename}: {exc}")

        cited_authors = dedupe_author_names(all_cited_authors) or extract_author_names(all_references)
        self.write_json(
            {
                "files": files,
                "references": all_references,
                "reference_images": reference_images,
                "citation_highlights": citation_highlights,
                "author_articles": dedupe_author_article_rows(author_articles),
                "cited_authors": cited_authors,
                "errors": extraction_errors,
                "ocr_available": False,
            }
        )

    def build_cgi_environ(self):
        return {
            "REQUEST_METHOD": "POST",
            "CONTENT_TYPE": self.headers.get("Content-Type", ""),
            "CONTENT_LENGTH": self.headers.get("Content-Length", "0"),
        }

    def write_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def extract_pdf_text(pdf_path):
    reader = PdfReader(str(pdf_path))
    chunks = []
    for page in reader.pages:
        chunks.append(page.extract_text() or "")
    return "\n".join(chunks)


def extract_reference_section(pdf_path, original_name):
    if fitz is None:
        return {
            "text": extract_pdf_text(pdf_path),
            "images": [],
            "image_records": [],
            "pages": [],
            "method": "full_pdf_text_layer_no_reference_images",
        }

    doc = fitz.open(str(pdf_path))
    try:
        heading = find_reference_heading(doc)
        if heading is None:
            return {
                "text": extract_pdf_text(pdf_path),
                "images": [],
                "image_records": [],
                "pages": [],
                "method": "full_pdf_text_layer_heading_not_found",
            }

        images = []
        image_records = []
        text_chunks = []
        start_page = heading["page_index"]
        end_page = min(doc.page_count, start_page + MAX_REFERENCE_IMAGE_PAGES)
        image_group = uuid.uuid4().hex[:10]
        safe_stem = safe_filename(Path(original_name).stem or "pdf")

        for page_index in range(start_page, end_page):
            page = doc[page_index]
            if page_index == start_page:
                x0 = max(0, heading["x0"])
                y0 = max(0, heading["y0"] - 12)
                clip = fitz.Rect(x0, y0, page.rect.width, page.rect.height)
            else:
                clip = page.rect

            text_chunks.extend(extract_reference_blocks_from_page(page, clip))
            image_name = f"{image_group}-{safe_stem}-page-{page_index + 1}.png"
            image_path = REFERENCE_IMAGE_DIR / image_name
            pixmap = page.get_pixmap(matrix=fitz.Matrix(1.7, 1.7), clip=clip, alpha=False)
            pixmap.save(str(image_path))
            images.append(
                {
                    "file": original_name,
                    "page": page_index + 1,
                    "url": f"/generated/reference_sections/{image_name}",
                    "label": f"{original_name} page {page_index + 1}",
                }
            )
            image_records.append(
                {
                    "url": f"/generated/reference_sections/{image_name}",
                    "page_index": page_index,
                    "clip": [clip.x0, clip.y0, clip.x1, clip.y1],
                }
            )

        return {
            "text": "\n\n".join(text_chunks),
            "images": images,
            "image_records": image_records,
            "pages": [image["page"] for image in images],
            "method": "reference_section_image_plus_text_layer",
        }
    finally:
        doc.close()


def find_reference_heading(doc):
    heading_pattern = re.compile(r"^\s*(references|bibliography|works cited)\s*$", re.I)
    for page_index in range(doc.page_count):
        page = doc[page_index]
        page_dict = page.get_text("dict")
        for block in page_dict.get("blocks", []):
            for line in block.get("lines", []):
                line_text = " ".join(span.get("text", "") for span in line.get("spans", [])).strip()
                if heading_pattern.match(line_text):
                    x0 = min(span.get("bbox", [0, 0, 0, 0])[0] for span in line.get("spans", []))
                    y0 = min(span.get("bbox", [0, 0, 0, 0])[1] for span in line.get("spans", []))
                    return {"page_index": page_index, "x0": x0, "y0": y0}
    return None


def extract_reference_blocks_from_page(page, clip):
    blocks = []
    for block in page.get_text("blocks", clip=clip):
        x0, y0, x1, y1, text = block[:5]
        cleaned = clean_line(text)
        if not cleaned:
            continue
        if re.fullmatch(r"(?i)(references|bibliography|works cited)", cleaned):
            continue
        if len(cleaned.split()) < 4:
            continue
        blocks.append((y0, x0, cleaned))
    return [block[2] for block in sorted(blocks)]


def safe_filename(value):
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-")
    return value[:80] or "pdf"


def build_citation_highlights(pdf_path, image_records, cited_authors):
    if fitz is None or not cited_authors:
        return {}

    highlights = {}
    doc = fitz.open(str(pdf_path))
    try:
        for author in cited_authors:
            author_highlights = []
            for image_record in image_records:
                page = doc[image_record["page_index"]]
                clip = fitz.Rect(*image_record["clip"])
                for variant in author_search_variants(author):
                    rects = page.search_for(variant, clip=clip)
                    for rect in rects:
                        if rect.is_empty:
                            continue
                        author_highlights.append(rect_to_percent_highlight(rect, clip, image_record["url"]))
                    if author_highlights:
                        break
            if author_highlights:
                highlights[author] = dedupe_highlights(author_highlights)
    finally:
        doc.close()
    return highlights


def author_search_variants(author):
    variants = [author]
    words = author.split()
    if len(words) >= 2:
        first = " ".join(words[:-1])
        last = words[-1]
        variants.append(f"{last}, {first}")
        variants.append(f"{last}, {first[0]}")
    return dedupe_author_names(variants)


def rect_to_percent_highlight(rect, clip, image_url):
    return {
        "image_url": image_url,
        "left": round(((rect.x0 - clip.x0) / clip.width) * 100, 3),
        "top": round(((rect.y0 - clip.y0) / clip.height) * 100, 3),
        "width": round((rect.width / clip.width) * 100, 3),
        "height": round((rect.height / clip.height) * 100, 3),
    }


def dedupe_highlights(highlights):
    seen = set()
    unique = []
    for highlight in highlights:
        key = (
            highlight["image_url"],
            round(highlight["left"], 1),
            round(highlight["top"], 1),
            round(highlight["width"], 1),
            round(highlight["height"], 1),
        )
        if key not in seen:
            unique.append(highlight)
            seen.add(key)
    return unique


def merge_highlights(target, source):
    for author, highlights in source.items():
        target.setdefault(author, []).extend(highlights)
        target[author] = dedupe_highlights(target[author])


def dedupe_author_names(names):
    seen = set()
    unique = []
    for name in names:
        key = re.sub(r"\s+", " ", name.lower()).strip()
        if key and key not in seen:
            unique.append(name)
            seen.add(key)
    return unique


def extract_references(text):
    normalized = re.sub(r"\r\n?", "\n", text)
    match = re.search(r"(?im)^\s*(references|bibliography|works cited)\s*$", normalized)
    if match:
        normalized = normalized[match.end() :]

    paragraph_refs = [clean_line(part) for part in re.split(r"\n\s*\n+", normalized)]
    paragraph_refs = [ref for ref in paragraph_refs if looks_like_reference(ref)]
    if paragraph_refs:
        return paragraph_refs[:MAX_REFERENCES_PER_FILE]

    lines = [clean_line(line) for line in normalized.splitlines()]
    lines = [line for line in lines if line]
    references = []
    current = []
    ref_start = re.compile(r"^(\[\d+\]|\d+[\).]|[A-Z][a-zA-Z'\-]+,\s+[A-Z])")

    for line in lines:
        if ref_start.search(line) and current:
            references.append(" ".join(current))
            current = [line]
        else:
            current.append(line)

    if current:
        references.append(" ".join(current))

    return [ref for ref in references if looks_like_reference(ref)][:MAX_REFERENCES_PER_FILE]


def clean_line(line):
    line = re.sub(r"(?<=[A-Za-zÀ-ÖØ-öø-ÿ])-\s+(?=[a-zà-öø-ÿ])", "", line)
    return re.sub(r"\s+", " ", line).strip()


def looks_like_reference(text):
    has_year = re.search(r"\b(19|20)\d{2}\b", text)
    has_enough_words = len(text.split()) >= 5
    return bool(has_year and has_enough_words)


def extract_author_names(references):
    names = []
    seen = set()
    for reference in references:
        for name in parse_reference_authors(reference):
            key = re.sub(r"\s+", " ", name.lower()).strip()
            if key and key not in seen:
                names.append(name)
                seen.add(key)
            if len(names) >= MAX_AUTHORS_TOTAL:
                return names
    return names


def build_author_article_rows(references, source_file):
    rows = []
    for reference_index, reference in enumerate(references):
        article_title = extract_reference_title(reference)
        for author in parse_reference_authors(reference):
            rows.append(
                {
                    "author": author,
                    "article": article_title,
                    "reference": reference,
                    "source_file": source_file,
                    "reference_index": reference_index + 1,
                }
            )
    return rows


def extract_reference_title(reference):
    cleaned = re.sub(r"^\[\d+\]\s*", "", reference)
    cleaned = re.sub(r"^\d+[\).]\s*", "", cleaned)
    year_match = re.search(r"\b(19|20)\d{2}[a-z]?\b\.?\s*", cleaned)
    if year_match:
        after_year = cleaned[year_match.end() :]
        title = re.split(r"\.\s+", after_year, maxsplit=1)[0]
        return clean_line(title).strip(".")[:180] or "Unknown article"

    parts = re.split(r"\.\s+", cleaned)
    if len(parts) >= 2:
        return clean_line(parts[1]).strip(".")[:180]
    return clean_line(cleaned)[:180] or "Unknown article"


def dedupe_author_article_rows(rows):
    seen = set()
    unique = []
    for row in rows:
        key = (
            re.sub(r"\s+", " ", row["author"].lower()).strip(),
            re.sub(r"\s+", " ", row["article"].lower()).strip(),
            row["source_file"],
        )
        if key not in seen:
            unique.append(row)
            seen.add(key)
    return unique


def parse_reference_authors(reference):
    author_part = split_before_title_or_year(reference)
    author_part = re.sub(r"^\[\d+\]\s*", "", author_part)
    author_part = re.sub(r"^\d+[\).]\s*", "", author_part)

    natural_names = parse_natural_order_authors(author_part)
    if natural_names:
        return natural_names

    pair_matches = re.findall(
        r"([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'\-]+),\s+([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'\-]+(?:[-\s][A-Z][A-Za-zÀ-ÖØ-öø-ÿ'\-]+)?)",
        author_part,
    )
    if pair_matches:
        return [f"{first} {last}" for last, first in pair_matches]

    author_part = author_part.replace(" and ", "; ")
    pieces = re.split(r";|,(?=\s+[A-Z][A-Za-z'\-]+\s*(?:,|$))", author_part)

    names = []
    for piece in pieces:
        name = normalize_author_piece(piece)
        if name:
            names.append(name)
    return names


def parse_natural_order_authors(author_part):
    normalized = re.sub(r"\bet al\.?", "", author_part, flags=re.I)
    normalized = normalized.replace(" and ", ", ")
    pieces = [piece.strip(" .") for piece in normalized.split(",")]
    pieces = [piece for piece in pieces if piece]
    names = []

    for piece in pieces:
        name = normalize_natural_order_name(piece)
        if not name:
            return []
        names.append(name)

    return names if names else []


def normalize_natural_order_name(piece):
    piece = re.sub(r"[^A-Za-zÀ-ÖØ-öø-ÿ'\-\s\.]", " ", piece)
    piece = re.sub(r"\b[A-Z]\.?\b", "", piece)
    piece = re.sub(r"\s+", " ", piece).strip(" .")
    words = piece.split()
    if len(words) < 2 or len(words) > 4:
        return ""
    if any(word.lower() in {"journal", "conference", "proceedings", "press"} for word in words):
        return ""
    if not all(re.match(r"^[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'\-]+$", word) for word in words):
        return ""
    return " ".join(words)


def split_before_title_or_year(reference):
    year_match = re.search(r"\b(19|20)\d{2}[a-z]?\b", reference)
    sentence_match = re.search(r"\.\s+[A-Z]", reference)
    if year_match and (sentence_match is None or year_match.start() < sentence_match.start()):
        return reference[: year_match.start()]

    if sentence_match:
        candidate = reference[: sentence_match.start()]
        if "," in candidate:
            return candidate

    if year_match:
        return reference[: year_match.start()]
    return reference[:180]


def normalize_author_piece(piece):
    piece = re.sub(r"\bet al\.?", "", piece, flags=re.I)
    piece = re.sub(r"[^A-Za-zÀ-ÖØ-öø-ÿ'\-\s,\.]", " ", piece)
    piece = re.sub(r"\s+", " ", piece).strip(" ,.")
    if not piece:
        return ""

    comma_match = re.match(r"^([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'\-]+),\s+(.+)$", piece)
    if comma_match:
        last = comma_match.group(1)
        first = re.sub(r"\b[A-Z]\.?\b", "", comma_match.group(2)).strip()
        candidate = f"{first} {last}".strip()
    else:
        candidate = re.sub(r"\b[A-Z]\.?\b", "", piece).strip()

    candidate = re.sub(r"\s+", " ", candidate)
    words = candidate.split()
    if len(words) < 2 or len(words) > 5:
        return ""
    if any(word.lower() in {"journal", "conference", "proceedings", "press"} for word in words):
        return ""
    return candidate


def run(port=4174):
    server = ThreadingHTTPServer(("0.0.0.0", port), ScholarDiscoveryHandler)
    print(f"Serving Academic Conference Scholar Discovery at http://localhost:{port}/app/index.html")
    print(f"LAN users can open http://<your-computer-ip>:{port}/app/index.html")
    server.serve_forever()


if __name__ == "__main__":
    selected_port = int(os.environ.get("PORT") or (sys.argv[1] if len(sys.argv) > 1 else 4174))
    run(selected_port)

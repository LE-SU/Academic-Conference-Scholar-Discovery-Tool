const state = {
  files: [],
  scholars: [],
  authorArticles: [],
  confirmedAuthorIds: new Set(),
  referenceImages: [],
  citationHighlights: {},
  activeCitationName: "",
  searchErrors: [],
  shortlist: new Set(),
  sortBy: "score",
  fieldKeywords: [],
};

const OPENALEX_AUTHOR_ENDPOINT = "https://api.openalex.org/authors";
const OPENALEX_RESULTS_PER_AUTHOR = 5;
const OPENALEX_REQUEST_DELAY_MS = 350;
const CITATION_EXTRACTION_ENDPOINT = "/api/extract-citations";

const elements = {
  pdfInput: document.querySelector("#pdfInput"),
  folderInput: document.querySelector("#folderInput"),
  citedAuthorsInput: document.querySelector("#citedAuthorsInput"),
  fieldKeywordsInput: document.querySelector("#fieldKeywordsInput"),
  chooseFilesButton: document.querySelector("#chooseFilesButton"),
  chooseFolderButton: document.querySelector("#chooseFolderButton"),
  dropZone: document.querySelector("#dropZone"),
  fileList: document.querySelector("#fileList"),
  fileCount: document.querySelector("#fileCount"),
  citationCount: document.querySelector("#citationCount"),
  analyzeButton: document.querySelector("#analyzeButton"),
  searchConfirmedButton: document.querySelector("#searchConfirmedButton"),
  selectAllAuthorsButton: document.querySelector("#selectAllAuthorsButton"),
  clearAllAuthorsButton: document.querySelector("#clearAllAuthorsButton"),
  authorArticleRows: document.querySelector("#authorArticleRows"),
  scholarRows: document.querySelector("#scholarRows"),
  referenceImageGrid: document.querySelector("#referenceImageGrid"),
  progressLog: document.querySelector("#progressLog"),
  sortSelect: document.querySelector("#sortSelect"),
  copyButton: document.querySelector("#copyButton"),
  csvButton: document.querySelector("#csvButton"),
  copyEmailsButton: document.querySelector("#copyEmailsButton"),
  emailGrid: document.querySelector("#emailGrid"),
  appStatus: document.querySelector("#appStatus"),
  steps: Array.from(document.querySelectorAll(".step")),
};

elements.chooseFilesButton.addEventListener("click", () => elements.pdfInput.click());
elements.chooseFolderButton.addEventListener("click", () => elements.folderInput.click());
elements.pdfInput.addEventListener("change", (event) => addFiles(event.target.files));
elements.folderInput.addEventListener("change", (event) => addFiles(event.target.files));
elements.analyzeButton.addEventListener("click", analyzeFiles);
elements.searchConfirmedButton.addEventListener("click", searchConfirmedScholars);
elements.selectAllAuthorsButton.addEventListener("click", selectAllAuthorRows);
elements.clearAllAuthorsButton.addEventListener("click", clearAllAuthorRows);
elements.sortSelect.addEventListener("change", (event) => {
  state.sortBy = event.target.value;
  renderScholars();
});
elements.copyButton.addEventListener("click", copyScholarList);
elements.csvButton.addEventListener("click", downloadCsv);
elements.copyEmailsButton.addEventListener("click", copyEmails);
elements.fieldKeywordsInput.addEventListener("input", () => {
  state.fieldKeywords = getFieldKeywords();
  state.scholars = state.scholars.map((scholar) => ({
    ...scholar,
    topicMatch: getTopicRelevance(scholar, state.fieldKeywords),
    matchedKeywords: getMatchedKeywords(scholar, state.fieldKeywords),
  }));
  state.scholars = state.scholars.map((scholar) => ({
    ...scholar,
    score: buildCandidateScore(scholar),
  }));
  renderScholars();
});

["dragenter", "dragover"].forEach((eventName) => {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("is-dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("is-dragging");
  });
});

elements.dropZone.addEventListener("drop", (event) => addFiles(event.dataTransfer.files));

function addFiles(fileList) {
  const selectedFiles = Array.from(fileList);
  const pdfs = selectedFiles.filter((file) => {
    return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  });

  const existingKeys = new Set(state.files.map(getFileKey));
  let addedCount = 0;
  pdfs.forEach((file) => {
    const key = getFileKey(file);
    if (!existingKeys.has(key)) {
      state.files.push(file);
      existingKeys.add(key);
      addedCount += 1;
    }
  });

  state.scholars = [];
  state.authorArticles = [];
  state.confirmedAuthorIds.clear();
  state.referenceImages = [];
  state.citationHighlights = {};
  state.activeCitationName = "";
  state.searchErrors = [];
  state.shortlist.clear();
  setWorkflowStep("upload");
  renderFiles();
  renderAuthorArticles();
  renderScholars();
  renderReferenceImages();
  renderEmails();
  elements.progressLog.textContent = buildUploadMessage(addedCount, selectedFiles.length - pdfs.length);
}

function renderFiles() {
  elements.fileCount.textContent = state.files.length;
  elements.analyzeButton.disabled = state.files.length === 0;

  if (state.files.length === 0) {
    elements.fileList.innerHTML = '<li class="empty-state">No PDFs selected yet.</li>';
    return;
  }

  elements.fileList.innerHTML = state.files
    .map((file) => {
      const path = getDisplayPath(file);
      return `<li>${escapeHtml(file.name)} <strong>${formatSize(file.size)}</strong><span class="file-path">${escapeHtml(path)}</span></li>`;
    })
    .join("");
}

function normalizeAuthorArticles(rows) {
  return rows.map((row, index) => ({
    id: `author-article-${index}`,
    author: row.author || "Unknown author",
    article: row.article || "Unknown article",
    reference: row.reference || "",
    sourceFile: row.source_file || row.sourceFile || "Unknown PDF",
    referenceIndex: row.reference_index || row.referenceIndex || index + 1,
  }));
}

function getConfirmedAuthorNames() {
  const names = state.authorArticles
    .filter((row) => state.confirmedAuthorIds.has(row.id))
    .map((row) => row.author);
  return dedupeNames(names);
}

async function analyzeFiles() {
  if (state.files.length === 0) {
    elements.progressLog.textContent = "Upload a folder or PDFs before clicking Analyze.";
    return;
  }

  elements.analyzeButton.disabled = true;
  elements.copyButton.disabled = true;
  elements.csvButton.disabled = true;
  elements.appStatus.textContent = "Analyzing";
  setWorkflowStep("extract");
  state.scholars = [];
  state.authorArticles = [];
  state.confirmedAuthorIds.clear();
  state.referenceImages = [];
  state.citationHighlights = {};
  state.activeCitationName = "";
  state.searchErrors = [];
  state.shortlist.clear();
  state.fieldKeywords = getFieldKeywords();
  renderScholars();
  renderAuthorArticles();
  renderReferenceImages();
  renderEmails();

  let extraction;
  try {
    elements.progressLog.textContent = `Extracting references from ${state.files.length} PDF file${state.files.length === 1 ? "" : "s"}...`;
    extraction = await extractCitedAuthorsFromPdfs();
  } catch (error) {
    elements.appStatus.textContent = "Extraction failed";
    elements.progressLog.textContent = `PDF citation extraction failed: ${error.message}`;
    elements.analyzeButton.disabled = false;
    return;
  }

  const citedAuthors = extraction.citedAuthors;
  state.authorArticles = extraction.authorArticles;
  state.confirmedAuthorIds.clear();
  state.referenceImages = extraction.referenceImages;
  state.citationHighlights = extraction.citationHighlights;
  state.activeCitationName = "";
  elements.citationCount.textContent = citedAuthors.length;
  elements.citedAuthorsInput.value = citedAuthors.join("\n");
  renderAuthorArticles();
  renderReferenceImages();

  if (extraction.errors.length > 0) {
    state.searchErrors.push(...extraction.errors.map((error) => `PDF extraction: ${error}`));
  }

  if (citedAuthors.length === 0) {
    elements.appStatus.textContent = "No cited authors found";
    elements.progressLog.textContent =
      "PDF text was read, but no cited authors were detected. Try PDFs with selectable text, not scanned image-only PDFs.";
    elements.analyzeButton.disabled = false;
    return;
  }

  setWorkflowStep("extract");
  elements.appStatus.textContent = "Review citations";
  elements.analyzeButton.disabled = false;
  elements.searchConfirmedButton.disabled = state.confirmedAuthorIds.size === 0;
  elements.progressLog.textContent = `Extracted ${state.authorArticles.length} author-article row${state.authorArticles.length === 1 ? "" : "s"} from ${citedAuthors.length} unique cited_author name${citedAuthors.length === 1 ? "" : "s"}. Review the list, click rows to highlight names, then search confirmed scholars.`;
}

async function searchConfirmedScholars() {
  const confirmedAuthors = getConfirmedAuthorNames();
  if (confirmedAuthors.length === 0) {
    elements.progressLog.textContent = "Confirm at least one author before searching scholars.";
    return;
  }

  elements.searchConfirmedButton.disabled = true;
  elements.copyButton.disabled = true;
  elements.csvButton.disabled = true;
  elements.appStatus.textContent = "Searching scholars";
  state.scholars = [];
  state.searchErrors = [];
  state.shortlist.clear();
  state.fieldKeywords = getFieldKeywords();
  renderScholars();
  renderEmails();

  elements.progressLog.textContent = `Searching OpenAlex for ${confirmedAuthors.length} confirmed author${confirmedAuthors.length === 1 ? "" : "s"}...`;

  const candidates = [];
  for (const [index, authorName] of confirmedAuthors.entries()) {
    elements.progressLog.textContent = `OpenAlex search ${index + 1}/${confirmedAuthors.length}: ${authorName}`;
    try {
      const results = await searchOpenAlexAuthor(authorName);
      candidates.push(...results);
    } catch (error) {
      state.searchErrors.push(`${authorName}: ${error.message}`);
    }
    if (index < confirmedAuthors.length - 1) {
      await sleep(OPENALEX_REQUEST_DELAY_MS);
    }
  }

  state.scholars = dedupeCandidates(candidates).map((scholar, index) => ({
    ...scholar,
    id: `candidate-${index}`,
    topicMatch: getTopicRelevance(scholar, state.fieldKeywords),
    matchedKeywords: getMatchedKeywords(scholar, state.fieldKeywords),
  }));
  state.scholars = state.scholars.map((scholar) => ({
    ...scholar,
    score: buildCandidateScore(scholar),
  }));

  setWorkflowStep("rank");
  if (state.scholars.length > 0) {
    elements.appStatus.textContent = "Ranked list ready";
    elements.copyButton.disabled = false;
    elements.csvButton.disabled = false;
  } else {
    elements.appStatus.textContent = "No candidates found";
  }
  elements.analyzeButton.disabled = false;
  elements.searchConfirmedButton.disabled = state.confirmedAuthorIds.size === 0;
  elements.progressLog.textContent = buildOpenAlexSummary(confirmedAuthors.length);
  renderScholars();
}

async function extractCitedAuthorsFromPdfs() {
  const formData = new FormData();
  state.files.forEach((file) => {
    formData.append("pdfs", file, getDisplayPath(file));
  });

  const response = await fetch(CITATION_EXTRACTION_ENDPOINT, {
    method: "POST",
    body: formData,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Local extraction server returned HTTP ${response.status}`);
  }

  return {
    citedAuthors: dedupeNames(payload.cited_authors || []),
    authorArticles: normalizeAuthorArticles(payload.author_articles || []),
    references: payload.references || [],
    referenceImages: payload.reference_images || [],
    citationHighlights: payload.citation_highlights || {},
    files: payload.files || [],
    errors: payload.errors || [],
  };
}

function renderAuthorArticles() {
  const hasRows = state.authorArticles.length > 0;
  elements.searchConfirmedButton.disabled = state.confirmedAuthorIds.size === 0;
  elements.selectAllAuthorsButton.disabled = !hasRows;
  elements.clearAllAuthorsButton.disabled = !hasRows;

  if (!hasRows) {
    elements.authorArticleRows.innerHTML =
      '<tr><td colspan="4" class="empty-table">Analyze PDFs to create an author-article review list.</td></tr>';
    return;
  }

  elements.authorArticleRows.innerHTML = state.authorArticles
    .map((row) => {
      const checked = state.confirmedAuthorIds.has(row.id) ? "checked" : "";
      const isActive = row.author === state.activeCitationName ? "is-active-row" : "";
      return `
        <tr class="${isActive}" data-review-citation="${escapeHtml(row.author)}">
          <td><input type="checkbox" data-confirm-author="${escapeHtml(row.id)}" ${checked} /></td>
          <td><div class="scholar-name">${escapeHtml(row.author)}</div></td>
          <td>${escapeHtml(row.article)}</td>
          <td>${escapeHtml(row.sourceFile)}</td>
        </tr>
      `;
    })
    .join("");

  document.querySelectorAll("[data-confirm-author]").forEach((checkbox) => {
    checkbox.addEventListener("change", (event) => {
      event.stopPropagation();
      const rowId = event.target.dataset.confirmAuthor;
      if (event.target.checked) {
        state.confirmedAuthorIds.add(rowId);
      } else {
        state.confirmedAuthorIds.delete(rowId);
      }
      elements.searchConfirmedButton.disabled = state.confirmedAuthorIds.size === 0;
    });
  });

  document.querySelectorAll("[data-review-citation]").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.target.closest("input")) return;
      state.activeCitationName = row.dataset.reviewCitation;
      elements.progressLog.textContent = buildHighlightMessage(state.activeCitationName);
      renderAuthorArticles();
      renderReferenceImages();
      document.querySelector(".reference-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function selectAllAuthorRows() {
  state.confirmedAuthorIds = new Set(state.authorArticles.map((row) => row.id));
  renderAuthorArticles();
  elements.progressLog.textContent = `Selected all ${state.confirmedAuthorIds.size} author-article row${state.confirmedAuthorIds.size === 1 ? "" : "s"} for scholar search.`;
}

function clearAllAuthorRows() {
  state.confirmedAuthorIds.clear();
  renderAuthorArticles();
  elements.progressLog.textContent = "Cleared all author confirmations.";
}

function renderReferenceImages() {
  if (state.referenceImages.length === 0) {
    elements.referenceImageGrid.innerHTML =
      '<div class="empty-email">After Analyze, extracted References / Bibliography / Works Cited images will appear here.</div>';
    return;
  }

  elements.referenceImageGrid.innerHTML = state.referenceImages
    .map((image) => {
      return `
        <figure class="reference-card">
          <div class="reference-image-wrap">
            <img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.label)}" loading="lazy" />
            ${renderHighlightsForImage(image.url)}
          </div>
          <figcaption>${escapeHtml(image.label)}</figcaption>
        </figure>
      `;
    })
    .join("");
}

function renderHighlightsForImage(imageUrl) {
  if (!state.activeCitationName) return "";
  const highlights = state.citationHighlights[state.activeCitationName] || [];
  return highlights
    .filter((highlight) => highlight.image_url === imageUrl)
    .map((highlight) => {
      return `
        <span
          class="reference-highlight"
          style="left: ${highlight.left}%; top: ${highlight.top}%; width: ${highlight.width}%; height: ${highlight.height}%;"
          aria-hidden="true"
        ></span>
      `;
    })
    .join("");
}

function renderScholars() {
  if (state.scholars.length === 0) {
    elements.scholarRows.innerHTML =
      '<tr><td colspan="11" class="empty-table">Search confirmed scholars to populate this list.</td></tr>';
    elements.copyButton.disabled = true;
    elements.csvButton.disabled = true;
    return;
  }

  const sorted = getSortedScholars();
  elements.scholarRows.innerHTML = sorted
    .map((scholar) => {
      const checked = state.shortlist.has(scholar.id) ? "checked" : "";
      const isActive = scholar.citedAuthor === state.activeCitationName ? "is-active-row" : "";
      return `
        <tr class="${isActive}" data-highlight-citation="${escapeHtml(scholar.citedAuthor)}">
          <td><input type="checkbox" data-shortlist="${scholar.id}" ${checked} /></td>
          <td><div class="scholar-name">${escapeHtml(scholar.name)}</div></td>
          <td>${escapeHtml(scholar.citedAuthor)}</td>
          <td>${escapeHtml(scholar.institution)}</td>
          <td>${scholar.worksCount.toLocaleString()}</td>
          <td>${scholar.citedByCount.toLocaleString()}</td>
          <td><span class="topic-chip">${scholar.topicMatch}%</span></td>
          <td><span class="topic-chip">${escapeHtml(scholar.field)}</span>${renderMatchedKeywords(scholar)}</td>
          <td><a class="profile-link" href="${escapeHtml(scholar.googleScholarUrl)}" target="_blank" rel="noreferrer">Search</a></td>
          <td>${escapeHtml(scholar.email || "Not found")}</td>
          <td><a class="profile-link" href="${escapeHtml(scholar.profileUrl)}" target="_blank" rel="noreferrer">Profile</a></td>
        </tr>
      `;
    })
    .join("");

  document.querySelectorAll("[data-shortlist]").forEach((checkbox) => {
    checkbox.addEventListener("change", (event) => {
      event.stopPropagation();
      const scholarId = event.target.dataset.shortlist;
      if (event.target.checked) {
        state.shortlist.add(scholarId);
      } else {
        state.shortlist.delete(scholarId);
      }
      setWorkflowStep(state.shortlist.size ? "invite" : "rank");
      renderEmails();
    });
  });

  document.querySelectorAll("[data-highlight-citation]").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.target.closest("a")) return;
      state.activeCitationName = row.dataset.highlightCitation;
      elements.progressLog.textContent = buildHighlightMessage(state.activeCitationName);
      renderScholars();
      renderReferenceImages();
      document.querySelector(".reference-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function getSortedScholars() {
  return [...state.scholars].sort((a, b) => {
    if (state.sortBy === "institution") {
      return a.institution.localeCompare(b.institution);
    }
    const sortMap = {
      score: "score",
      citations: "citedByCount",
      works: "worksCount",
      topicMatch: "topicMatch",
    };
    if (state.sortBy === "field") {
      return a.field.localeCompare(b.field);
    }
    return b[sortMap[state.sortBy]] - a[sortMap[state.sortBy]];
  });
}

function renderEmails() {
  const selected = state.scholars.filter((scholar) => state.shortlist.has(scholar.id));
  elements.copyEmailsButton.disabled = selected.length === 0;

  if (selected.length === 0) {
    elements.emailGrid.innerHTML =
      '<div class="empty-email">Select scholars from the ranked list to generate invitation drafts.</div>';
    return;
  }

  elements.emailGrid.innerHTML = selected
    .map((scholar) => {
      return `
        <article class="email-draft">
          <h3>${escapeHtml(scholar.name)}</h3>
          <pre>${escapeHtml(buildEmail(scholar))}</pre>
        </article>
      `;
    })
    .join("");
}

function buildEmail(scholar) {
  return `Subject: Invitation to speak at our academic conference

Dear ${scholar.name},

I am organizing an academic conference session related to ${scholar.field}. Your work at ${scholar.institution} stood out in our review because it aligns strongly with the submitted papers and citation patterns.

Would you be open to joining us as an invited speaker or panel participant?

Best regards,`;
}

function copyScholarList() {
  const text = getSortedScholars()
    .map((scholar, index) => {
      return `${index + 1}. ${scholar.name} | ${scholar.institution} | ${scholar.worksCount} works | ${scholar.citedByCount} cited by | ${scholar.topicMatch}% topic match | ${scholar.field} | email: ${scholar.email || "Not found"} | Google Scholar: ${scholar.googleScholarUrl} | OpenAlex: ${scholar.profileUrl}`;
    })
    .join("\n");
  copyText(text, "Scholar list copied.");
}

function copyEmails() {
  const text = state.scholars
    .filter((scholar) => state.shortlist.has(scholar.id))
    .map(buildEmail)
    .join("\n\n---\n\n");
  copyText(text, "Invitation emails copied.");
}

function copyText(text, successMessage) {
  navigator.clipboard.writeText(text).then(() => {
    elements.progressLog.textContent = successMessage;
  });
}

function downloadCsv() {
  const rows = [
    [
      "rank",
      "cited_author",
      "name",
      "institution",
      "works_count",
      "cited_by_count",
      "topic_match",
      "matched_keywords",
      "concept_field",
      "google_scholar_url",
      "email",
      "openalex_profile_url",
    ],
    ...getSortedScholars().map((scholar, index) => [
      index + 1,
      scholar.citedAuthor,
      scholar.name,
      scholar.institution,
      scholar.worksCount,
      scholar.citedByCount,
      scholar.topicMatch,
      scholar.matchedKeywords.join("; "),
      scholar.field,
      scholar.googleScholarUrl,
      scholar.email || "Not found",
      scholar.profileUrl,
    ]),
  ];
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "scholar_candidates.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function setWorkflowStep(activeStep) {
  const order = ["upload", "extract", "rank", "invite"];
  const activeIndex = order.indexOf(activeStep);
  elements.steps.forEach((step) => {
    const stepIndex = order.indexOf(step.dataset.step);
    step.classList.toggle("is-active", stepIndex === activeIndex);
    step.classList.toggle("is-done", stepIndex < activeIndex);
  });
}

function formatSize(bytes) {
  if (!bytes) return "0 KB";
  const megabytes = bytes / 1024 / 1024;
  if (megabytes >= 1) return `${megabytes.toFixed(1)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getFileKey(file) {
  return `${getDisplayPath(file)}-${file.size}`;
}

function getDisplayPath(file) {
  return file.webkitRelativePath || file.relativePath || file.name;
}

function buildUploadMessage(pdfCount, ignoredCount) {
  if (state.files.length === 0) {
    return ignoredCount
      ? `No PDFs found. ${ignoredCount} non-PDF file${ignoredCount === 1 ? "" : "s"} ignored.`
      : "Upload PDFs and click Analyze to begin.";
  }

  const ignoredText = ignoredCount
    ? ` ${ignoredCount} non-PDF file${ignoredCount === 1 ? "" : "s"} ignored.`
    : "";
  return `${pdfCount} PDF file${pdfCount === 1 ? "" : "s"} added. Click Analyze to extract citations and search scholars.${ignoredText}`;
}

function dedupeNames(names) {
  const seen = new Set();
  return names
    .map((name) => name.trim())
    .filter(Boolean)
    .filter((name) => {
      const key = normalizeName(name);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeName(name) {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

async function searchOpenAlexAuthor(citedAuthor) {
  const params = new URLSearchParams({
    search: citedAuthor,
    "per-page": String(OPENALEX_RESULTS_PER_AUTHOR),
    sort: "cited_by_count:desc",
  });
  const response = await fetch(`${OPENALEX_AUTHOR_ENDPOINT}?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`OpenAlex returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  return (payload.results || []).map((author) => mapOpenAlexAuthor(author, citedAuthor));
}

function mapOpenAlexAuthor(author, citedAuthor) {
  const fields = getFields(author);
  return {
    citedAuthor,
    name: author.display_name || "Unknown author",
    institution: getInstitution(author),
    worksCount: author.works_count || 0,
    citedByCount: author.cited_by_count || 0,
    field: fields[0] || "Unknown field",
    fields,
    googleScholarUrl: buildGoogleScholarUrl(author.display_name || citedAuthor, getInstitution(author)),
    email: getEmail(author),
    profileUrl: getProfileUrl(author),
    openAlexId: author.id || "",
  };
}

function buildGoogleScholarUrl(name, institution) {
  const query = [name, institution === "Unknown institution" ? "" : institution].filter(Boolean).join(" ");
  const params = new URLSearchParams({
    view_op: "search_authors",
    mauthors: query,
    hl: "en",
  });
  return `https://scholar.google.com/citations?${params.toString()}`;
}

function getEmail(author) {
  const candidates = [
    author.email,
    author.email_address,
    author.contact_email,
    author.ids?.email,
  ].filter(Boolean);
  return candidates[0] || "";
}

function getInstitution(author) {
  return (
    author.last_known_institution?.display_name ||
    author.affiliations?.[0]?.institution?.display_name ||
    "Unknown institution"
  );
}

function getField(author) {
  return getFields(author)[0] || "Unknown field";
}

function getFields(author) {
  const topicNames = (author.topics || []).map((topic) => topic.display_name).filter(Boolean);
  const xConceptNames = (author.x_concepts || []).map((concept) => concept.display_name).filter(Boolean);
  const conceptNames = (author.concepts || []).map((concept) => concept.display_name).filter(Boolean);
  return dedupeNames([...topicNames, ...xConceptNames, ...conceptNames]);
}

function getProfileUrl(author) {
  if (author.id?.startsWith("http")) return author.id;
  if (author.id) return `https://openalex.org/${author.id}`;
  return "https://openalex.org/authors";
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = candidate.openAlexId || `${normalizeName(candidate.name)}-${candidate.institution}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildCandidateScore(scholar) {
  const citationSignal = Math.log10(scholar.citedByCount + 1) * 20;
  const worksSignal = Math.log10(scholar.worksCount + 1) * 8;
  const topicSignal = state.fieldKeywords.length ? scholar.topicMatch * 2.2 : 0;
  return Math.round(topicSignal + citationSignal + worksSignal);
}

function buildOpenAlexSummary(authorCount) {
  const keywordText = state.fieldKeywords.length
    ? ` Topic ranking used: ${state.fieldKeywords.join(", ")}.`
    : "";
  const imageText = state.referenceImages.length
    ? ` ${state.referenceImages.length} reference section image${state.referenceImages.length === 1 ? "" : "s"} extracted for review.`
    : " No reference section images were found; PDF text-layer fallback was used.";
  const base = `OpenAlex search complete: ${state.scholars.length} scholar candidate${state.scholars.length === 1 ? "" : "s"} from ${authorCount} unique cited_author name${authorCount === 1 ? "" : "s"}.${imageText}${keywordText}`;
  if (state.searchErrors.length === 0) return base;
  return `${base} ${state.searchErrors.length} search error${state.searchErrors.length === 1 ? "" : "s"}: ${state.searchErrors.join(" | ")}`;
}

function buildHighlightMessage(citationName) {
  const count = state.citationHighlights[citationName]?.length || 0;
  if (count === 0) {
    return `No exact reference-image match found for ${citationName}. This can happen when the PDF text layer uses a different name order or line break.`;
  }
  return `Highlighted ${count} match${count === 1 ? "" : "es"} for ${citationName} in the reference section images.`;
}

function getFieldKeywords() {
  return dedupeNames(
    elements.fieldKeywordsInput.value
      .split(/[\n;,]+/)
      .map((keyword) => keyword.trim())
      .filter(Boolean)
  );
}

function getTopicRelevance(scholar, keywords) {
  if (keywords.length === 0) return 0;
  const haystack = [scholar.field, ...(scholar.fields || [])].join(" ").toLowerCase();
  const matched = getMatchedKeywords(scholar, keywords).length;
  const partialHits = keywords.filter((keyword) => {
    const words = normalizeKeyword(keyword).split(" ").filter((word) => word.length > 3);
    return words.length > 0 && words.some((word) => haystack.includes(word));
  }).length;
  const exactScore = (matched / keywords.length) * 100;
  const partialScore = (partialHits / keywords.length) * 45;
  return Math.min(100, Math.round(exactScore + partialScore));
}

function getMatchedKeywords(scholar, keywords) {
  const haystack = [scholar.field, ...(scholar.fields || [])].join(" ").toLowerCase();
  return keywords.filter((keyword) => haystack.includes(normalizeKeyword(keyword)));
}

function normalizeKeyword(keyword) {
  return keyword.toLowerCase().replace(/\s+/g, " ").trim();
}

function renderMatchedKeywords(scholar) {
  if (!scholar.matchedKeywords?.length) return "";
  return `<span class="file-path">Matched: ${escapeHtml(scholar.matchedKeywords.join(", "))}</span>`;
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

window.scholarDiscoveryApp = {
  addFiles,
  analyzeFiles,
  extractCitedAuthorsFromPdfs,
  getTopicRelevance,
  getMatchedKeywords,
  getState: () => ({
    fileCount: state.files.length,
    scholarCount: state.scholars.length,
    shortlistCount: state.shortlist.size,
  }),
};

const demoMode = new URLSearchParams(window.location.search).get("demo");

if (demoMode === "folder") {
  addFiles([
    {
      name: "sample-conference-paper-01.pdf",
      type: "application/pdf",
      size: 512000,
      webkitRelativePath: "conference-pdfs/session-a/sample-conference-paper-01.pdf",
    },
    {
      name: "sample-conference-paper-02.pdf",
      type: "application/pdf",
      size: 640000,
      webkitRelativePath: "conference-pdfs/session-b/sample-conference-paper-02.pdf",
    },
    {
      name: "notes.txt",
      type: "text/plain",
      size: 1200,
      webkitRelativePath: "conference-pdfs/notes.txt",
    },
  ]);
  elements.citedAuthorsInput.value = "Demo mode needs real PDF files for automatic extraction.";
} else if (demoMode === "1") {
  addFiles([
    { name: "sample-conference-paper-01.pdf", type: "application/pdf", size: 512000 },
    { name: "sample-conference-paper-02.pdf", type: "application/pdf", size: 640000 },
    { name: "sample-conference-paper-03.pdf", type: "application/pdf", size: 720000 },
  ]);
  elements.citedAuthorsInput.value = "Demo mode needs real PDF files for automatic extraction.";
}

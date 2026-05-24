# Academic Conference Scholar Discovery Tool

This project is being built stage by stage as a local web application.

## Stage 1

Stage 1 creates a runnable browser interface:

- Upload multiple PDF files.
- Upload a folder that contains many PDF files.
- Click Analyze.
- See a scholar candidate list in the browser.
- Sort by citation count, institution, works count, field, or overall fit.
- Copy the ranked list.
- Download a CSV.
- Select a shortlist.
- Generate personalized invitation email drafts.

Real bibliography extraction is planned for later stages.

## Stage 2

Stage 2 adds OpenAlex scholar search:

- Enter cited_author names in the `Cited authors` box.
- The app removes duplicate names before searching.
- The app searches OpenAlex Authors with rate limit protection.
- Each cited_author returns up to 5 scholar candidates.
- Candidate rows show name, institution, works_count, cited_by_count,
  concept / field, and OpenAlex profile URL.
- API errors are shown in the progress log without stopping other searches.
- The CSV download is saved as `scholar_candidates.csv`.

## Stage 3

Stage 3 aligns the app with the intended product workflow:

- Upload a folder that contains many PDFs.
- Click `Analyze`.
- The local server extracts text from each PDF.
- The local server looks for `References`, `Bibliography`, or `Works Cited`
  sections.
- The local server extracts cited_author names from reference entries.
- The browser searches OpenAlex for those authors.
- Optional field keywords prioritize candidates whose OpenAlex topics match the
  desired conference field.
- The app returns a ranked scholar candidate list directly.

The `Extracted cited authors` box is now only for review/debugging. You do not
need to type names manually in the normal workflow.

## How to run

Use the local app server:

```bash
python3 server.py 4174
```

Then open:

`http://localhost:4174/app/index.html`

The PDF library is installed locally inside this project under `vendor/`.

If you only run `python3 -m http.server`, the page can open but PDF extraction
will not work because that simple server does not provide the extraction API.

## How to test

1. Click `Choose Folder`.
2. Select a folder that contains PDFs.
3. Optionally enter field keywords, such as `hypertension, blood pressure`.
4. Confirm that the selected PDF count changes.
5. Click `Analyze`.
6. Confirm that `Extracted cited authors` is filled automatically.
7. Confirm that OpenAlex scholar candidates appear.
8. Confirm that `Topic match` is shown and `Overall fit` prioritizes matching fields.
9. Try changing `Sort by`.
10. Click `Download CSV` and confirm the file is named `scholar_candidates.csv`.
11. Check one or more scholars in the `Shortlist` column.
12. Confirm that invitation email drafts appear below the table.

Expected result: the app runs in the browser, calls OpenAlex, and shows scholar
candidates based on cited_author names extracted from uploaded PDFs.

You can also click `Choose Folder` and select a folder that contains many PDFs.
The app will include PDFs inside that folder and its subfolders. Non-PDF files
are ignored.

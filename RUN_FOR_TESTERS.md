# Run the Scholar Discovery Tool Locally

## Requirements

- macOS, Windows, or Linux
- Python 3.9 or newer
- Internet access for OpenAlex scholar search

## Start the app

1. Unzip the package.
2. Open a terminal in the unzipped folder.
3. Run:

```bash
python3 server.py 4174
```

On Windows, use this if `python3` is not available:

```bash
python server.py 4174
```

4. Open this URL in a browser:

```text
http://localhost:4174/app/index.html
```

## Test flow

1. Click `Choose Folder` or `Choose PDFs`.
2. Upload PDFs.
3. Click `Analyze`.
4. Review the generated author-article list.
5. Click a row to highlight the detected author in the reference section image.
6. Select author rows to confirm.
7. Click `Search confirmed scholars`.
8. Review scholar candidates, download CSV, or shortlist candidates.

## Notes

- PDFs should have selectable text for best citation extraction.
- Scanned image-only PDFs may show reference images but may not extract authors well.
- Uploaded PDFs are processed locally on your computer.

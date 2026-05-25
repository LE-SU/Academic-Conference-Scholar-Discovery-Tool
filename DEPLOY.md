# Short-Term Password-Protected Deployment

This app can be deployed as a temporary test website on Render or Railway.

## Required environment variable

Set this variable on the hosting platform:

```text
APP_PASSWORD=choose-a-test-password
```

For Google Scholar profile lookup, also set:

```text
SERPAPI_KEY=your-serpapi-key
```

Also set Python to 3.11 if your platform does not read `.python-version`:

```text
PYTHON_VERSION=3.11.11
```

When visitors open the site, the browser will ask for a username and password.
The username can be anything; the password must match `APP_PASSWORD`.

## Start command

Use:

```bash
python server.py
```

The server reads the platform-provided `PORT` environment variable automatically.

## Build command

Use:

```bash
pip install -r requirements.txt
```

## Important notes

- Uploaded PDFs are processed on the server.
- Generated reference-section images are written under `generated/`.
- Google Scholar does not provide an official public API. The app uses SerpAPI
  when `SERPAPI_KEY` is configured: first a Google search restricted to
  `scholar.google.com/citations`, then the SerpAPI Google Scholar Author API
  when an author id is found.
- Email is shown only when available from public structured metadata. Most
  OpenAlex author records do not include email.
- For a short test, this is fine. For production, add automatic cleanup,
  stricter upload limits, and a real login system.

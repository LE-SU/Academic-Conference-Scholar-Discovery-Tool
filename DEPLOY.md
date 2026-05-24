# Short-Term Password-Protected Deployment

This app can be deployed as a temporary test website on Render or Railway.

## Required environment variable

Set this variable on the hosting platform:

```text
APP_PASSWORD=choose-a-test-password
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
- For a short test, this is fine. For production, add automatic cleanup,
  stricter upload limits, and a real login system.

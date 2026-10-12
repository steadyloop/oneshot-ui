# OneShot

A job-search workspace for students: discover openings, track applications,
and import, customize, and export resumes as PDFs. Includes desktop and phone
layouts, browser-local guest workspaces, and Google sign-in.

Built with vanilla HTML/CSS/JavaScript, FastAPI, PostgreSQL, and Typst.

## Run locally

Requires Python 3.12+, [uv](https://docs.astral.sh/uv/), and PostgreSQL provisioned
with the OneShot schema. Job data comes from a separate ingestion pipeline;
this repository does not include that pipeline, database migrations, or seed data.

```sh
cp .env.example .env
# Configure the database and optional Google sign-in settings in .env.
uv run oneshot-ui
```

Open <http://127.0.0.1:8766>. Dependencies are pinned in `uv.lock`.
`DATABASE_URL` stores account data; optional `JOBS_DATABASE_URL` separates job
data. Register `/api/auth/callback` on your app's origin as the Google OAuth
redirect URI. Company administration is disabled unless
`ONESHOT_COMPANY_EDITOR_EMAIL` is configured.

Guest applications and resumes stay in the browser's local storage; clearing
site data removes them. Resume import and PDF export send content to the server
for processing. Guest data is not automatically merged on sign-in.

## Tests

```sh
node --test tests/web/*.test.js
uv run python -m unittest discover -s tests/api -v
```

JavaScript tests require Node 22.12+ or 24+. Database tests skip unless
`ONESHOT_TEST_DATABASE_URL` points to a local test database with the OneShot schema.
Browser checks in `tests/` additionally require Playwright and Chromium.

## Deployment

`app.py` is the FastAPI entrypoint; `vercel.json` configures Vercel. Set the
variables from `.env.example` in the hosting environment, use the HTTPS origin
for `ONESHOT_PUBLIC_URL`, set `ONESHOT_COOKIE_SECURE=1`, and provide a stable,
random `ONESHOT_SESSION_SECRET`.

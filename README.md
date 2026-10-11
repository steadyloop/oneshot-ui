# OneShot web app

The browser client lives in `web/` and uses HTML, CSS, and JavaScript modules.
The FastAPI server in `api/` serves those files and the same-origin `/api/*`
routes. Jobs come from the separate `xjobscore` pipeline; this app does not run
harvesting or enrichment.

## Running it

```sh
uv run oneshot-ui     # http://127.0.0.1:8766
```

`uv run` installs the dependencies locked in `uv.lock`. Configure database and
Google sign-in settings in a local `.env` or the hosting environment:

```dotenv
DATABASE_URL=postgresql:///your_accounts_database
JOBS_DATABASE_URL=postgresql:///xjobscore_frontend
ONESHOT_GOOGLE_CLIENT_ID=your-client-id
ONESHOT_GOOGLE_CLIENT_SECRET=your-client-secret
ONESHOT_SESSION_SECRET=your-stable-session-secret
ONESHOT_PUBLIC_URL=http://127.0.0.1:8766
ONESHOT_COOKIE_SECURE=0
```

`DATABASE_URL` stores accounts, applications, feedback, and resumes.
`JOBS_DATABASE_URL` optionally separates job, logo, and coverage reads. When it
is unset, both use `DATABASE_URL`. The pipeline publishes stable job IDs to its
serving databases. The web process does not run database migrations.

`ONESHOT_STATIC_DIR` overrides the default `web/` directory. Point it at a
nonexistent directory to run only the JSON API.

## Client structure

| URL | Files |
| --- | --- |
| `/` | `web/discover/` |
| `/application/` | `web/applied/` |
| `/resume/` | `web/resume/` |
| `/source-coverage/` | `web/feeds/` |
| `/login/` | `web/login/` |

Assets are served under `/static/`, relative to `web/`.
[`web/shared/boot.js`](web/shared/boot.js) chooses each page's `desktop.js` or
`phone.js` before drawing it. Phone layouts apply at 760px or less, or on a touch
phone in landscape with a short viewport. Crossing the breakpoint reloads the
page. Both layouts share each page's `core.js`, the API client, and guest storage.
Phones use [`web/phone/shell.js`](web/phone/shell.js) and
[`web/phone/phone.css`](web/phone/phone.css).

Design references remain in the local, Git-ignored `mockup/` directory. They
are outside the served `web/` directory. The optional design-comparison scripts
open these local files directly and skip when the reference is absent.

## Database migrations

The migration scripts are included in this repository. Apply the ones needed
by an older database before deploying code that depends on them:

| Script | Purpose |
| --- | --- |
| [20261006_application_tracker.sql](migrations/20261006_application_tracker.sql) | Adds task/waiting fields and the previous open stage; moves Considering records to Submitted while preserving history and unknown submission dates. |
| [20261006_resume_vocabulary.sql](migrations/20261006_resume_vocabulary.sql) | Adds resume vocabulary storage without replacing saved content. |
| [20261009_application_split_database.sql](migrations/20261009_application_split_database.sql) | Allows an application to reference a posting in the separate jobs database. |
| [20261009_feedback_split_database.sql](migrations/20261009_feedback_split_database.sql) | Allows feedback to reference a posting in the separate jobs database. |

The split-database migrations remove the posting foreign key; account ownership
and account/posting uniqueness remain enforced. The API checks that a posting
exists in the jobs database before saving personal records.

Run a selected script explicitly against the intended accounts database:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/20261006_application_tracker.sql
```

These scripts support repeated application. The company editor has separate
migrations described below.

## Tests

Unit and API checks:

```sh
node --test tests/web/*.test.js
uv run python -m unittest discover -s tests/api -v
```

Use Node 22.12 or newer, or Node 24+, for tests that load JavaScript modules from
CommonJS. PostgreSQL checks skip unless `ONESHOT_TEST_DATABASE_URL` names a local
test database with the required schema. They use rolled-back transactions or
isolated schemas removed afterward; some also need the neighboring `xjobscore`
checkout.

Browser checks require Playwright and Chromium. One way to install test tools
outside this repository is:

```sh
npm install --prefix /tmp/oneshot-ui-tests @playwright/test
/tmp/oneshot-ui-tests/node_modules/.bin/playwright install chromium
export PLAYWRIGHT_MODULE=/tmp/oneshot-ui-tests/node_modules/@playwright/test
node tests/browser/discover_infinite_scroll.cjs
node tests/application_records_browser.cjs
node tests/company_editor_browser.cjs
node tests/resume_workspace_browser.cjs
node tests/feed_other_browser.cjs
node tests/feed_overview_browser.cjs
```

These checks serve the current files and use isolated API fixtures or browser
storage. Resume checks also compile real PDFs using `.venv/bin/python`; set
`ONESHOT_PYTHON` to use another interpreter. `PLAYWRIGHT_CHROMIUM_EXECUTABLE`
optionally selects an existing Chromium executable. Set `ONESHOT_TEST_ORIGIN`
for read-only feed overview checks against a running app instead of fixtures.
`TRACKER_BASELINE_ROOT` optionally compares tracker screenshots against a saved
checkout with the same `web/` layout.

The Python tracker check covers guest persistence, large lists, desktop and
phone workflows, Undo, keyboard use, and signed-in failures:

```sh
uv run --with playwright python tests/browser/applied.py
```

Optional desktop design checks, with local mockups and the app running:

```sh
ONESHOT_URL=http://127.0.0.1:8766 uv run --with playwright python tests/browser/discover_matches_mockup.py
ONESHOT_URL=http://127.0.0.1:8766 uv run --with playwright python tests/browser/feeds_matches_mockup.py
```

## Discover, Applied, Feeds, and Resume

Discover searches titles, companies, skills, and ATS provider names. It uses
published job-type/domain labels and normalized locations, shows one posting
per accepted duplicate group, and supports filters, infinite scroll, Skip,
Undo, and mislabeled reports. Its default scope is classified student roles.

Applied keeps Submitted, In progress, and Closed records. A reply, assessment,
interview, or offer updates the existing record. Closures are explicit and
reversible; age never closes a record automatically. Submitted and Closed lists
paginate at 50 records, with search, filters, and bulk actions. Known submission
dates and previous open stages survive closure and restoration.

Feeds ranks ATS providers by active student jobs eligible for Discover after
location filtering and deduplication. Fleet totals come from the pipeline's
full active-posting count, rather than the smaller serving subset. Today's
appeared/closed counts use Pacific calendar days and deduplication. Closure
requires an ATS, dead-link, or closed-page signal. Aggregates are cached for
five minutes; unavailable values remain unknown and failed refreshes preserve
the last successful overview.

Resume provides a reusable Profile, an inline resume picker, resume-specific
selections and bullet text, and preview/export through Typst. Main and bundled
Barlow designs support saved spacing, GPA visibility, coursework, and ordered
skills. Saved education and older selections remain readable.

## Guests and sign-in

Jobs and Feeds use the server while signed out. Applications, feedback, and
resumes use [`web/shared/guest.js`](web/shared/guest.js), starting empty and
persisting under `oneshot.visitor-data.state.v1` in `localStorage`. Clearing site
data removes that workspace. It stays local to that browser and is not merged
into the account automatically when signing in. A guest resume exports through
the public `POST /api/resume/render/pdf` route.

[`web/shared/account.js`](web/shared/account.js) builds the desktop Profile
control. The phone shell builds its own Profile sheet. A 401 from the identity
probe means guest mode; a private request returning 401 after sign-in sends the
browser to `/login/` for an expired session. The sign-in page loads no shared
API or account modules. Successful logout returns to `/`, which reloads as a
guest. Failed logout stays on the current screen and allows retry.

## Company editor

On desktop, sign in with `msg.shkim@gmail.com`, open Profile, and choose
**Manage companies**. Both administration endpoints independently check the
stored Google-verified email. Guests and other accounts cannot use the editor.

Edits enter a durable `company_edit` queue in the jobs database. Pending values
appear immediately. The `xjobscore` publisher applies patches to canonical
companies before publication and acknowledges only the revision it applied.
Outages preserve pending edits and conflicts remain visible for correction.

Before using the editor, apply its repeatable migrations:

```sh
# xjobscore pipeline database:
psql postgresql:///xjobscore -v ON_ERROR_STOP=1 -f migrations/20261007_company_editor_source.sql
# Each jobs serving database:
psql postgresql:///xjobscore_frontend -v ON_ERROR_STOP=1 -f migrations/20261007_company_editor.sql
```

When jobs use `DATABASE_URL`, apply the serving migration there instead. Restart
the publisher after updating its code; its normal publication interval controls
when edits reach Discover.

## Vercel deployment

`app.py` is the FastAPI entrypoint. Set this repository as the Vercel project
root, leave build/output settings empty, and configure the database and Google
sign-in variables above. Use the deployed HTTPS origin for
`ONESHOT_PUBLIC_URL`, `ONESHOT_COOKIE_SECURE=1`, a stable session secret, and
Neon's pooled connection string when using Neon. Any Google account with a
verified email can sign in. Database connection strings stay server-side;
client calls remain same-origin `/api` requests.

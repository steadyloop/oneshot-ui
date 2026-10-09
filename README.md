# OneShot web app

The browser client and its API live in this repository. The client uses plain
HTML, CSS, and vanilla JS, served as-is. The Python API lives in `api/`.

All data comes from the OneShot API over `/api/*`.
The API reads jobs published by xjobscore and stores accounts, applications,
feedback, and resumes in Postgres. Harvesting and enrichment live in the separate
`xjobscore` repository; this is the only request-facing API.

## Running it

The API server serves this directory during local development, so the normal
flow is unchanged:

```bash
cd oneshot-ui
uv run oneshot-ui     # http://127.0.0.1:8766
```

`uv run` installs the locked dependencies from `pyproject.toml` / `uv.lock`
on first use. The API reads database settings from `.env` locally and from
project settings on Vercel:

```dotenv
DATABASE_URL="your-neon-connection-string"
JOBS_DATABASE_URL=postgresql:///xjobscore_frontend
```

`DATABASE_URL` is the central store for accounts, application tracking, feedback,
and resumes. Optional `JOBS_DATABASE_URL` points job, logo, and coverage reads at
the small local frontend database. When it is unset, all reads use `DATABASE_URL`,
which preserves the hosted app's existing Neon configuration. The xjobscore
publisher initializes and refreshes the local database and Neon independently
using the same stable posting IDs. Job filtering uses stored Gold labels rather
than classifying every title again during each request.

The API finds this directory by walking up from its own package to the repo
root. Override with
`ONESHOT_STATIC_DIR`, or point it at a path that does not exist to run
the API on its own with no client attached.

## Mockups

All standalone design mockups and their supporting files live in [`mockup/`](mockup/README.md).
With the API server running, open them under `/static/mockup/`, followed by
the mockup folder and HTML filename. The catalog includes every variant.

## Tests

```bash
node --test
uv run python -m unittest discover -s tests -v
```

## Discover search

Discover search matches role titles, company names, recognized skills and ATS
provider names (for example, Greenhouse, Lever or Workday). ATS matching is
case-insensitive and includes active sources of deduplicated jobs; each job
still appears once. Existing job-type and focus filters continue to apply.

## Applications tracker

`/application/` keeps the readable board typography with a white canvas and muted
entry backgrounds, compact padding, 6px gaps, and 4px rounded corners. Add to Applied creates a
Submitted record. Replies, including automated
assessment invitations, move the existing record to Replied, Assessment,
Interview or Offer. Closures are explicit and reversible; age never closes a
record automatically. Existing guest and signed-in resume links remain available.

Submitted and Closed use left-aligned tables with 40px desktop rows and 56px
mobile rows. Filters share a quiet toolbar with bulk actions, without shifting
the table during selection. Pagination stays at 50 records per page; Closed
retains outcomes, the last stage, and restoration to that stage. These table
styles do not apply to In progress or the shared application dialogs.

Before deploying the updated API and client, apply the migration to the target
database (the web process does not run DDL):

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/20261006_application_tracker.sql
```

The migration can be rerun safely. It preserves IDs, history, resume references
and known submission dates, moves Considering to Submitted, and leaves unknown
submission dates unset. Guest records migrate locally when their workspace loads.

Validation: `node --test app.test.js application/app.test.js visitor-data.test.js
opportunities/app.test.js source-coverage/app.test.js`. Database checks run with
`ONESHOT_TEST_DATABASE_URL` set to a local database via
`python -m unittest discover -s tests -v`; their schema and data are rolled back.
`tests/application_tracker_browser.py` uses Playwright/Chromium to check the
current tracker workflows in isolated browser storage with its own fixtures;
it does not depend on the design mockups.
`node tests/application_records_browser.cjs` checks 300-record pagination,
responsive tables, selection, Undo, response/restore workflows, and partial API
failures with intercepted requests. Set `PLAYWRIGHT_MODULE` if Playwright is not
installed locally. Optional `TRACKER_BASELINE_ROOT` points to a directory with
saved `application/` assets for pixel comparisons of In progress; screenshots
are written to `TRACKER_ARTIFACTS` (default `/private/tmp/oneshot-tracker-browser`).

## Feed overview

`/source-coverage/` uses the approved job-type dropdown and classification footer.
The page starts at the left content inset; its footer stays at the bottom of the
viewport or below longer provider lists, with 24px of separation. Fleet totals,
daily activity and the clock share one desktop header line without a visible
page title.
All ATS providers share one list, ranked by their active student jobs eligible
for Discover after location filtering and deduplication, before personal filters.
All providers are visible in a compact list, with health bars and percentages,
right-aligned board and job counts separated by a faint pipe. The expand arrow
sits before the provider name; selecting the row shows its board squares.
Desktop rows are 32px tall; mobile rows retain 44px touch targets.

Daily appeared/closed counts are deduplicated and use Pacific calendar days.
Closures use the earliest recorded ATS, dead-link or closed-page signal on a
closed posting; board disappearance alone does not count as closure. The footer
uses the same active-posting total as the header: all `job_posting` rows with
`status = 'active'` in xjobscore, published through the coverage snapshot. This
includes unclassified postings, all locations, duplicates and disabled feeds.
The student-role count comes from the serving database after location filtering
and deduplication, before personal filters. Student-role and daily activity
aggregates are read-only, shared across accounts and cached for five minutes,
with a reset at Pacific midnight.
Unavailable metrics stay unknown; the existing board snapshot remains usable.

Run `python -m unittest discover -s tests -p test_feed_activity.py -v` and
`node --test source-coverage/app.test.js`. The SQL test uses the local database
configured by `ONESHOT_TEST_DATABASE_URL`, temporary tables and a rollback.
With Playwright available, `node tests/feed_other_browser.cjs` checks the compact
provider list, column alignment, header, health summaries, expansion and refresh
behavior with isolated fixtures.
`node tests/feed_overview_browser.cjs` checks the running page;
`ONESHOT_TEST_ORIGIN` overrides the default localhost port 8766.

## Resume workspace

`/resume/` uses the approved workspace mockup: compact editable Profile sections,
an inline resume picker, full-width contact summaries, and availability below
the document toolbar. New resume appears at the bottom of the resume dropdown,
or above the explanatory text when there is no current resume. Document controls
stay on one row and align with the content at narrow and ultrawide widths.
The standalone [mockup](mockup/resume-workspace-mockup/index.html) remains available for design reference.

Guest data stays in the existing browser workspace; signed-in edits use the
account-scoped API. Preview and export use the real Typst renderer with Main
or the bundled Barlow fonts. Design choice and GPA visibility live in the
existing selection JSON; selected coursework and resume-specific bullet text
are honored in the generated PDF. Existing education remains visible without
rewriting saved selections.

Barlow follows the reference PDF design: a centered name and contact block,
light section rules, a right-aligned education detail, visible project domains,
and aligned Languages, Frameworks, Data, and Tools rows. Its Standard and Compact
spacing options retain 10.5pt body text; the choice is stored in
`selection.density`. Skills and coursework print in `selection.skills` order,
independently of the bank's alphabetical browsing order. `data` is a supported
skill category in the existing JSON bank; these changes need no schema migration.

Older databases need the vocabulary column already expected by the resume API.
Apply this repeatable migration before deployment (it was applied locally):

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/20261006_resume_vocabulary.sql
```

Resume validation: `python -m unittest discover -s tests -p test_resume_workspace.py -v`.
Set `ONESHOT_TEST_DATABASE_URL` to a local database to include the rolled-back
account persistence test. With `@playwright/test` and Chromium installed,
`node tests/resume_workspace_browser.cjs` checks guest and signed-in transport,
editing scopes, menu actions, responsive alignment, handoff, and actual PDFs.
The browser check uses `.venv/bin/python` for rendering; set `ONESHOT_PYTHON`
to use another interpreter.

## Sample data

`sample-data.js` retains deterministic fixtures for tests, but production pages
never enable them. Opportunities and Feed Status always use the live API.
Opportunities, Applications, and Resume load the file only for
`OneShotVisitorData`, the separate browser-local guest workspace described
below.

Signed-out Applications starts empty. Jobs added from Opportunities and manually
created applications are persisted in the visitor workspace and appear there.

## Sign-in

Jobs and Feed Status stay server-backed while signed out. Applications and
the resume studio use `oneshot.visitor-data.state.v1` in `localStorage`, seeded
blank and separate from sample fixtures. Clearing site data removes that
workspace, and it does not synchronize across browsers. Signing in swaps private
CRUD to the account-scoped PostgreSQL API; the browser-local workspace is kept
but is not merged automatically.

A browser-local resume exports through the public `POST /api/resume/render/pdf`
route, which takes the whole document in the request.

The 401 → `/login/` handlers cover a signed-in session expiring between the
shared identity probe and a private request. Anonymous private requests are
routed locally and never receive that 401.

`nav-count.js` builds the Profile control in the sidebar footer on all four shells:
an avatar with a Profile label opens a menu with the name, full email address,
and Sign out. Signed out, the same control uses a person icon and links to sign-in,
so nothing shifts when you sign in. Google's `picture_url` layers over initials.

The sidebar's `data-account-slot` stays at the bottom via `margin-top: auto`
in `navigation.css`, with the desktop account menu opening upward. On narrow
screens, Profile stays alongside the other navigation items and its menu stays
inside the viewport.

It is built in JS, not markup, because the four sidebars are hand-copied and not
byte-identical — one code path beats four edits. The identity probe must **not**
redirect on 401: that is the normal browser-local guest state.

`login/` deliberately loads none of the shared scripts, so nothing on it can 401
and bounce it back to itself.

## Company editor

Sign in with `msg.shkim@gmail.com`, open Profile, and choose **Manage companies**.
The shared dialog searches and pages through companies and edits name, domain,
description, and tags. `/api/auth/me` exposes the capability, and both company
administration endpoints independently check the stored Google-verified email.
Guests and other accounts cannot read or write the editor's data.

Edits are saved to a durable `company_edit` queue in the jobs serving database.
The editor shows pending values immediately. Before its next publication,
xjobscore applies the patch to the canonical company, retaining its serving ID
when its domain or name changes. Successful publication acknowledges only the
revision it applied. Outages preserve pending edits; conflicts remain visible
in the editor for correction. Discover reflects edits after publication.

Before running the updated web app and xjobscore publisher, apply the repeatable
migrations from this repository. The web process never runs DDL:

```sh
# Local xjobscore pipeline database:
psql postgresql:///xjobscore -v ON_ERROR_STOP=1 -f migrations/20261007_company_editor_source.sql
# Each OneShot serving database (local jobs DB and hosted DATABASE_URL):
psql postgresql:///xjobscore_frontend -v ON_ERROR_STOP=1 -f migrations/20261007_company_editor.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/20261007_company_editor.sql
```

Restart the xjobscore publisher after updating its code. Its normal publication
interval governs when pending edits reach xjobscore and Discover; running a
publication manually processes them sooner. A publisher dry run leaves the
queue and canonical companies unchanged.

Validation: `python -m unittest discover -s tests -p test_company_admin.py -v`
(with `ONESHOT_TEST_DATABASE_URL` for an isolated PostgreSQL queue check), and
`node tests/company_editor_browser.cjs` (with `PLAYWRIGHT_MODULE` if necessary).
The xjobscore repository includes isolated publication and retry tests in
`xjobscore/tests/test_company_edits_postgres.py`.

## Vercel deployment

This directory is a standalone Vercel project. `app.py` is the FastAPI
entrypoint: it serves these files and the same-origin `/api/*` routes, while the
harvesting pipeline continues to run separately and update Neon. The web
process never starts a crawler.

Set the Vercel project root to this directory, leave the build and output
settings empty, and provide `DATABASE_URL` as a server-side environment
variable. Use Neon's pooled connection string for the deployed function.

Any Google account with a verified email address can sign in.

For sign-in, also configure the `ONESHOT_GOOGLE_CLIENT_ID`,
`ONESHOT_GOOGLE_CLIENT_SECRET`,
`ONESHOT_SESSION_SECRET`,
`ONESHOT_PUBLIC_URL`, and `ONESHOT_COOKIE_SECURE=1`
variables described in the repository's `.env.example`.

The browser keeps its existing relative `/api` URLs. No database connection
string is shipped to JavaScript, and no CORS configuration is needed because
the page and its request API share one origin.

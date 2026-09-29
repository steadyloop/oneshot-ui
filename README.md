# frontend

The browser client for OneShot. Plain HTML, CSS, and vanilla JS — no build step,
no framework, no bundler. Every file here is shipped to the browser as-is.

All data comes from the OneShot API over `/api/*`.
Nothing here talks to Postgres, and nothing here is rendered on a server.

## Running it

The API server serves this directory during local development, so the normal
flow is unchanged:

```bash
cd oneshot-ui
python -m oneshot_ui     # http://127.0.0.1:8766
```

The API finds this directory by walking up from its own package to the repo
root. Override with
`ONESHOT_STATIC_DIR`, or point it at a path that does not exist to run
the API on its own with no client attached.

## Tests

```bash
cd frontend && node --test
```

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

`nav-count.js` builds the account chip in the sidebar footer on all four shells:
avatar, name, email, and a `⋯` menu holding the full address and Sign out. Signed
out it renders the same box as a "Guest / Browser-local · Sign in" link, so nothing
shifts when you sign in. Google's `picture_url` layers over initials drawn
underneath, so a blocked or missing photo degrades instead of leaving a grey disc.

The chip is also what holds the foot of the sidebar down, via `margin-top: auto`
in `navigation.css`. That used to be the sample switch's job — the chip merely
sat beneath it — and moved here when the switch left the sidebar, so the sidebar
is now navigation and identity, nothing else.

It is built in JS, not markup, because the four sidebars are hand-copied and not
byte-identical — one code path beats four edits. The identity probe must **not**
redirect on 401: that is the normal browser-local guest state.

`login/` deliberately loads none of the shared scripts, so nothing on it can 401
and bounce it back to itself.

## Vercel deployment

This directory is a standalone Vercel project. `app.py` is the FastAPI
entrypoint: it serves these files and the same-origin `/api/*` routes, while the
harvesting pipeline continues to run separately and update Neon. The web
process never starts a crawler.

Set the Vercel project root to this directory, leave the build and output
settings empty, and provide `DATABASE_URL` as a server-side environment
variable. Use Neon's pooled connection string for the deployed function.

For sign-in, also configure the `ONESHOT_GOOGLE_CLIENT_ID`,
`ONESHOT_GOOGLE_CLIENT_SECRET`,
`ONESHOT_ALLOWED_EMAILS`, `ONESHOT_SESSION_SECRET`,
`ONESHOT_PUBLIC_URL`, and `ONESHOT_COOKIE_SECURE=1`
variables described in the repository's `.env.example`.

The browser keeps its existing relative `/api` URLs. No database connection
string is shipped to JavaScript, and no CORS configuration is needed because
the page and its request API share one origin.

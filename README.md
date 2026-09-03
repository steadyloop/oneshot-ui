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

`sample-data.js` is a complete in-browser fake of the API. With it on, a page
works with no server and no database — useful for design work and for previewing
a deploy before a backend exists. `transport()` short-circuits to the fake before
`fetch` is reached, so nothing in sample mode reaches the network.

**Fixture mode is Applications-only, and there is no switch.** Opportunities
always talks to the real API. Feed Status is a read-only report on the
harvest itself, and a demo mode there would only hide what the page exists to
show. Resume serves signed-out visitors from their own empty browser-local
workspace instead of a fixture persona — the sample resume content is gone.
Opportunities and Resume still load `sample-data.js`, but only for
`OneShotVisitorData`, the separate browser-local guest workspace — see Sign-in
below. Feed Status loads neither.

The Resume page does have an explicit, browser-local **interactive mockup** for
design review. An empty signed-out workspace offers “Load sample workspace,” and
`/resume/?demo=1` performs the same opt-in load. It seeds fictional content into
`OneShotVisitorData`; from that point every edit uses the normal guest CRUD
routes. This is not fixture mode, never replaces a non-empty workspace, and is
not available for a signed-in account.

`PAGES` in `sample-data.js` maps a pathname to a storage key
(`oneshot.sample-data.enabled.application`), which is what makes fixture mode
resolvable on Applications at all. Every caller is unchanged by this: a page
only ever requests its own data, so "is sample mode on" and "is it on for this
page" are the same question at the one place that asks — `transport()` in
`api-client.js`.

**Fixture mode is guest-only.** With nobody signed in and nothing of your own on
the board, Applications opens on the fixtures; real browser-local work is never
hidden behind them. If a session does turn up while the fixture flag is on — you
signed in from another tab — `disableAll()` clears it and the page reloads if it
was this page's.

## Sign-in

Jobs and Feed Status stay server-backed while signed out. Applications and
the resume studio use `oneshot.visitor-data.state.v1` in `localStorage`, seeded
blank and separate from sample fixtures. Clearing site data removes that
workspace, and it does not synchronize across browsers. Signing in swaps private
CRUD to the account-scoped PostgreSQL API; the browser-local workspace is kept
but is not merged automatically.

`sample-data.js` owns both in-browser transports because they implement the same
request contract, but sample and visitor state use different keys. Browser-local
resumes can run content and coverage checks; export renders through the public
`/api/resume/render/*` routes either way.

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

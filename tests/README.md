# Frontend checks

Use Node 22.12 or later. Browser dependencies are pinned in this directory; the app itself has no JavaScript install or build step.

```sh
cd tests
npm ci
npm run install-browser
npm test
npm run browser
npm run parity
```

The browser suite serves local assets and isolated fixtures. It covers Discover filtering and pagination, tracker saves and Undo, company/account controls, feeds, guest persistence, and resume import/edit/export on desktop and phone. Resume parsing and PDF export use the existing Python environment at `../.venv/bin/python`; set `ONESHOT_PYTHON` to use another interpreter with the repository's locked dependencies.

To compare against a saved copy of the complete frontend:

```sh
ONESHOT_BASELINE_WEB=/absolute/path/to/saved/web npm test
ONESHOT_BASELINE_WEB=/absolute/path/to/saved/web npm run parity
```

Parity checks compare computed styles, geometry and screenshots at 390, 760, 761, 1440 and 2560 pixels, plus touch landscape at 844 × 390. Screenshots default to `/private/tmp/oneshot-frontend-parity`; set `ONESHOT_PARITY_ARTIFACTS` to change the destination. Chromium edge antialiasing gets a small color tolerance; layout and computed styles must match exactly.

Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` when using an already installed Chromium. `PLAYWRIGHT_MODULE` remains available for older external test installations. No browser test writes to production data.

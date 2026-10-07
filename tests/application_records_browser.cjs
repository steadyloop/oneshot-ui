const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
// All requests are intercepted; no real account or application data is touched.
// Optional TRACKER_BASELINE_ROOT compares In progress against saved application assets.
const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.TRACKER_ARTIFACTS || '/private/tmp/oneshot-tracker-browser';
const ORIGIN = 'http://oneshot-preflight.test';
const KEY = 'oneshot.visitor-data.state.v1';
const NOW = '2026-10-07T19:00:00Z';
const files = ['application/index.html', 'application/styles.css', 'application/app.js', 'navigation.css', 'nav-count.js', 'api-client.js', 'sample-data.js'];
fs.mkdirSync(OUT, { recursive: true });
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex');
const manifest = Object.fromEntries(files.map(file => [file, hash(file)]));
const date = days => new Date(Date.parse(NOW) + days * 86400000).toISOString().slice(0, 10);
const row = (id, company, stage, extra = {}) => ({
  id, external: true, company, title: 'Software Engineering Intern', stage,
  last_open_stage: stage === 'closed' ? 'applied' : stage,
  closed_reason: stage === 'closed' ? 'withdrawn' : null,
  submitted_at: date(-20), task_state: stage === 'applied' ? 'waiting' : 'action',
  next_action: null, next_due_at: null, waiting_for: '', note: '', events: [], ...extra
});
const fixture = [
  ...Array.from({ length: 300 }, (_, i) => row(`sent-${i}`, `Company ${String(i).padStart(3, '0')}`, 'applied', { submitted_at: i === 0 ? null : date(-(i % 45)), title: i === 0 ? 'A very long engineering role '.repeat(14) : `Engineering Intern ${i}` })),
  ...Array.from({ length: 18 }, (_, i) => row(`closed-${i}`, `Closed Company ${i}`, 'closed', { closed_reason: ['rejected', 'withdrawn', 'no_reply'][i % 3], last_open_stage: ['applied', 'interview', 'offer'][i % 3] })),
  ...Array.from({ length: 12 }, (_, i) => row(`progress-${i}`, `Active Company ${i}`, ['replied', 'assessment', 'interview', 'offer'][i % 4], { task_state: i === 8 ? 'waiting' : 'action', next_action: i === 8 ? null : `Prepare task ${i}`, next_due_at: i === 8 ? null : date(i % 4 - 1), waiting_for: i === 8 ? 'Recruiter feedback' : '' }))
];
async function routeFiles(context, apiRoute, baselineRoot) {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) throw new Error(`Unexpected external request: ${url.href}`);
    if (url.pathname.startsWith('/api/')) return apiRoute(route, url);
    const relative = url.pathname === '/application/' ? 'application/index.html' : url.pathname.replace(/^\/static\//, '');
    const assetRoot = baselineRoot && relative.startsWith('application/') ? baselineRoot : ROOT;
    const file = path.resolve(assetRoot, relative);
    if (!file.startsWith(assetRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: file });
  });
}
const idle = page => page.waitForFunction(() => document.querySelector('#workspace')?.getAttribute('aria-busy') === 'false');
const counts = page => page.locator('.tabs .count').allTextContents().then(values => values.map(Number));
const stored = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)).applications, KEY);
async function undo(page) { await page.locator('#toast button').click(); await idle(page); }
async function capture(page, name) {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(800, 40);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const snapshot = await page.evaluate(() => {
    const selectors = ['.app-topbar', '.sidebar', '.tabs-row', '.tab', '.progress-layout', '.agenda', '.board-pane', '.column-head', '.card', '.mobile-stages', '.drawer'];
    return Object.fromEntries(selectors.map(selector => [selector, [...document.querySelectorAll(selector)].map(el => {
      const style = getComputedStyle(el), rect = el.getBoundingClientRect();
      return { text: el.textContent.trim(), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, style: Object.fromEntries(['display', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'padding', 'gap', 'color', 'backgroundColor', 'borderRadius'].map(key => [key, style[key]])) };
    })]));
  });
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(snapshot, null, 2));
}
async function compareInProgress(browser, page) {
  if (!process.env.TRACKER_BASELINE_ROOT) return;
  const before = await browser.newContext({ viewport: { width: 1600, height: 1000 }, timezoneId: 'America/Los_Angeles', reducedMotion: 'reduce' });
  await routeFiles(before, (route, url) => url.pathname === '/api/auth/me'
    ? route.fulfill({ status: 401, json: { detail: 'Not signed in' } })
    : route.fulfill({ json: { jobs: [], total: 0 } }), process.env.TRACKER_BASELINE_ROOT);
  await before.addInitScript(({ key, applications }) => localStorage.setItem(key, JSON.stringify({ applications, jobs: [], nextApplicationId: 1, applicationIdPrefix: 'preflight', feedback: [] })), { key: KEY, applications: fixture });
  const original = await before.newPage();
  await original.clock.install({ time: new Date(NOW) });
  await original.goto(`${ORIGIN}/application/`); await idle(original);
  for (const [name, viewport] of [['desktop', { width: 1600, height: 1000 }], ['wide', { width: 2560, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    for (const p of [original, page]) {
      await p.setViewportSize(viewport); await p.evaluate(() => document.fonts.ready);
      await p.mouse.move(0, 0);
    }
    const oldImage = await original.screenshot({ path: path.join(OUT, `before-progress-${name}.png`) });
    const newImage = await page.screenshot({ path: path.join(OUT, `after-progress-${name}.png`) });
    assert(oldImage.equals(newImage), `In progress must remain pixel-identical at ${name}`);
  }
  for (const p of [original, page]) {
    await p.locator('.card-open:visible').first().focus(); await p.keyboard.press('Enter'); await idle(p);
    await p.evaluate(() => document.fonts.ready);
  }
  assert((await original.screenshot()).equals(await page.screenshot()), 'In progress drawer must remain pixel-identical');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1600, height: 1000 });
  await before.close();
}
async function checkRecordsLayout(page, closed = false) {
  assert.equal(Math.round((await page.locator('tbody tr').first().boundingBox()).height), 40);
  assert.equal(await page.locator('tbody tr').nth(1).evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)');
  const action = page.locator('.records-row-action').first();
  await page.mouse.move(0, 0);
  assert.equal(await action.evaluate(el => getComputedStyle(el).opacity), '0');
  await action.focus();
  assert.equal(await action.evaluate(el => getComputedStyle(el).opacity), '1');
  await page.locator('#panel').focus();
  const head = page.locator('thead');
  await page.locator('.table-scroll').evaluate(el => { el.scrollTop = 120; });
  assert.equal(Math.round((await head.boundingBox()).y), Math.round((await page.locator('.table-scroll').boundingBox()).y));
  await page.locator('.table-scroll').evaluate(el => { el.scrollTop = 0; });
  if (!closed) {
    const top = (await head.boundingBox()).y;
    await page.locator('[data-select]').first().check();
    assert.equal((await head.boundingBox()).y, top, 'Bulk actions must not move the table');
    assert.equal(await page.locator('#selected-count').textContent(), '1 selected');
    assert.equal(await page.locator('#drawer').isVisible(), false, 'Selecting a checkbox must not open details');
    await page.locator('[data-action="clear-selection"]').click();
  }
}
async function responsiveRecords(page) {
  for (const view of ['sent', 'closed']) {
    await page.locator(`#tab-${view}`).click();
    await page.locator('#search').fill('');
    assert.equal(await page.locator('tbody tr').count(), view === 'sent' ? 50 : 18);
    for (const width of [320, 390, 600, 760, 768, 900, 1024, 1600, 2560]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `${view} must not overflow at ${width}px`);
      assert(await page.locator('.table-scroll').evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${view} table must fit at ${width}px`);
      assert.equal(Math.round((await page.locator('tbody tr').first().boundingBox()).height), width <= 760 ? 56 : 40);
      if ([390, 1600].includes(width)) await capture(page, `${view}-${width}`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    // Whole-row access, full date/location in the drawer, and the existing primary action.
    await page.locator('tbody tr').first().locator('.waiting-cell').click(); await idle(page);
    assert(await page.locator('#drawer').isVisible());
    assert(await page.locator('#detail-form [name="submittedAt"]').isVisible());
    assert(await page.locator('#detail-form [name="location"]').isVisible());
    assert(await page.locator(`#drawer ${view === 'sent' ? '[data-response]' : '[data-restore]'}`).isVisible());
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement.classList.contains('role-title'));
    if (view === 'sent') {
      const top = (await page.locator('thead').boundingBox()).y;
      await page.locator('#select-page').check();
      assert.equal((await page.locator('thead').boundingBox()).y, top);
      assert(await page.locator('[data-action="bulk-close"]').isVisible());
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
      await page.locator('[data-action="clear-selection"]').click();
      await page.locator('#search').fill('Company 000');
      assert.equal(await page.locator('.table-date').textContent(), '—');
      assert.equal(await page.locator('.table-date').getAttribute('datetime'), null);
      assert(await page.locator('.role-title').evaluate(el => el.scrollWidth > el.clientWidth), 'Long roles truncate within the row');
      assert(await page.locator('.table-scroll').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    }
    await page.locator('#search').fill('no possible matching company');
    assert.equal(await page.locator('.table-empty').count(), 1);
    assert.equal(await page.locator('#result-count').textContent(), `0 of ${view === 'sent' ? 300 : 18}`);
    await page.locator('#search').fill('');
  }
}
(async () => {
  const browser = await chromium.launch();
  const notes = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, timezoneId: 'America/Los_Angeles', reducedMotion: 'reduce' });
    const unexpectedGuest = [];
    await routeFiles(context, async (route, url) => {
      if (url.pathname === '/api/auth/me') return route.fulfill({ status: 401, json: { detail: 'Not signed in' } });
      if (url.pathname === '/api/jobs') return route.fulfill({ json: { jobs: [], total: 0 } });
      unexpectedGuest.push(`${route.request().method()} ${url.pathname}`);
      return route.fulfill({ status: 500, json: { detail: 'Unexpected API request in guest test' } });
    });
    await context.addInitScript(({ key, applications }) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ applications, jobs: [], nextApplicationId: 1, applicationIdPrefix: 'preflight', feedback: [] }));
    }, { key: KEY, applications: fixture });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install({ time: new Date(NOW) });
    await page.goto(`${ORIGIN}/application/`); await idle(page);
    assert.deepEqual(await counts(page), [12, 300, 18]);
    assert.equal(await page.locator('.column').count(), 4);
    assert(await page.locator('.agenda').isVisible());
    await compareInProgress(browser, page);
    await capture(page, 'in-progress-desktop');
    const beforeTab = (await page.locator('#panel').innerHTML()).replace(/ style=""/g, '');
    await page.locator('#tab-sent').click();
    assert.equal(await page.locator('tbody tr').count(), 50);
    assert((await page.locator('.pagination').textContent()).includes('1–50 of 300'));
    assert.equal(await page.locator('#result-count').isVisible(), false);
    await checkRecordsLayout(page);
    await capture(page, 'submitted-desktop');
    await page.locator('#tab-pipeline').click();
    assert.equal((await page.locator('#panel').innerHTML()).replace(/ style=""/g, ''), beforeTab, 'A pure tab round-trip keeps In progress markup unchanged');
    await page.locator('#tab-sent').click();
    await page.locator('[data-page="next"]').click();
    assert((await page.locator('.pagination').textContent()).includes('51–100'));
    await page.locator('[data-select]').first().check();
    await page.locator('[data-page="next"]').click();
    await page.locator('#select-page').check();
    assert.equal(await page.locator('#selected-count').textContent(), '51 selected', 'Selection carries across pages');
    await page.locator('[data-action="clear-selection"]').click();
    await page.locator('#search').fill('Company 299');
    assert.equal(await page.locator('tbody tr').count(), 1);
    assert.equal(await page.locator('#result-count').textContent(), '1 of 300');
    assert.deepEqual(await counts(page), [12, 300, 18]);
    await page.locator('#search').fill('');
    await page.locator('#age-filter').selectOption('7');
    const recent = (await stored(page)).filter(r => r.stage === 'applied' && r.submitted_at && (Date.parse(date(0)) - Date.parse(r.submitted_at)) / 86400000 < 7).length;
    assert((await page.locator('#result-count').textContent()).startsWith(String(recent)));
    await page.locator('#age-filter').selectOption('30');
    assert((await page.locator('.pagination').textContent()).includes('applications'));
    await page.locator('#select-page').check();
    assert.equal(await page.locator('[data-select]:checked').count(), 50);
    await page.locator('[data-action="bulk-close"]').click(); await idle(page);
    assert.deepEqual(await counts(page), [12, 250, 68]);
    await undo(page); assert.deepEqual(await counts(page), [12, 300, 18]);
    await page.locator('#age-filter').selectOption('all');
    await page.locator('#search').fill('Company 000');
    assert((await page.locator('tbody').textContent()).includes('—'));
    await page.locator('.role-title').first().click(); await idle(page);
    assert.equal(await page.locator('#detail-form [name="submittedAt"]').inputValue(), '');
    await page.locator('#detail-form [name="notes"]').fill('Preflight note');
    await page.locator('#detail-form [type="submit"]').click(); await idle(page);
    assert.equal((await stored(page)).find(r => r.id === 'sent-0').submitted_at, null);
    await page.locator('#search').fill('Company 001');
    await page.locator('[data-response]').first().click();
    await page.locator('#response-form [value="assessment"]').check();
    await page.locator('#response-form [name="nextAction"]').fill('Complete assessment');
    await page.locator('#response-submit').click(); await idle(page);
    assert.deepEqual(await counts(page), [13, 299, 18]);
    assert.equal(await page.locator('#tab-pipeline').getAttribute('aria-selected'), 'true');
    await undo(page); assert.deepEqual(await counts(page), [12, 300, 18]);
    await page.locator('#tab-closed').click();
    assert((await page.locator('thead').textContent()).includes('Last stage'));
    await page.locator('#outcome-filter').selectOption('rejected');
    assert.equal(await page.locator('tbody tr').count(), 6);
    await page.locator('#outcome-filter').selectOption('all');
    await checkRecordsLayout(page, true);
    await capture(page, 'closed-desktop');
    await page.locator('[data-restore="closed-1"]').click(); await idle(page);
    assert.equal((await stored(page)).find(r => r.id === 'closed-1').stage, 'interview');
    assert.equal(await page.locator('#tab-pipeline').getAttribute('aria-selected'), 'true');
    await undo(page);
    await page.locator('#tab-pipeline').click();
    assert.equal(await page.locator('.column').count(), 4);
    assert(await page.locator('.agenda').isVisible());
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-mobile-stage="interview"]').click();
    assert.equal(await page.locator('.column:visible').count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    await capture(page, 'in-progress-mobile');
    await page.locator('.card-open:visible').first().focus(); await page.keyboard.press('Enter'); await idle(page);
    await capture(page, 'in-progress-mobile-drawer');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement.classList.contains('card-open'));
    assert.deepEqual(unexpectedGuest, []);
    assert.deepEqual(errors, []);
    notes.push('Guest: 300 records, pagination, cross-page selection, search, recency/outcome filters, bulk closure/Undo, unknown dates, notes, responses, restore-to-previous-stage, and keyboard drawer focus passed.');
    await responsiveRecords(page);
    notes.push('Records: 40px desktop / 56px mobile rows, white backgrounds, keyboard actions, sticky headings, stable bulk toolbar, long-title truncation and no horizontal overflow from 320px to 2560px passed.');
    if (process.env.TRACKER_BASELINE_ROOT) notes.push('In progress and its drawer are pixel-identical to the supplied baseline at desktop, wide and mobile sizes.');
    await context.close();

    const signed = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/Los_Angeles', reducedMotion: 'reduce' });
    let serverRows = Array.from({ length: 50 }, (_, i) => row(String(1000 + i), `Account Company ${i}`, 'applied', { external: false, job_id: 2000 + i }));
    let failId = '1000', activeWrites = 0, maxWrites = 0;
    const writes = [];
    await routeFiles(signed, async (route, url) => {
      if (url.pathname === '/api/auth/me') return route.fulfill({ json: { name: 'Preflight Account', email: 'preflight@example.test' } });
      if (url.pathname === '/api/jobs') return route.fulfill({ json: { jobs: [], total: 0 } });
      if (url.pathname === '/api/applications') return route.fulfill({ json: { applications: serverRows } });
      const id = decodeURIComponent(url.pathname.split('/').at(-1));
      const record = serverRows.find(r => r.id === id);
      if (route.request().method() === 'PATCH') {
        const body = route.request().postDataJSON(); writes.push({ id, body }); activeWrites++; maxWrites = Math.max(maxWrites, activeWrites);
        await new Promise(resolve => setTimeout(resolve, 8)); activeWrites--;
        if (id === failId) return route.fulfill({ status: 503, json: { detail: 'Preflight save unavailable' } });
        if (body.stage === 'closed' && record.stage !== 'closed') record.last_open_stage = record.stage;
        Object.assign(record, body);
        return route.fulfill({ json: record });
      }
      if (record) return route.fulfill({ json: record });
      return route.fulfill({ json: { resumes: [] } });
    });
    const accountPage = await signed.newPage();
    await accountPage.clock.install({ time: new Date(NOW) });
    await accountPage.goto(`${ORIGIN}/application/`); await idle(accountPage);
    await accountPage.locator('#tab-sent').click();
    await accountPage.locator('#select-page').check();
    await accountPage.locator('[data-action="bulk-close"]').click(); await idle(accountPage);
    assert.deepEqual(await counts(accountPage), [0, 1, 49]);
    assert.equal(await accountPage.locator('[data-select]:checked').count(), 1);
    assert(maxWrites <= 6 && maxWrites > 1);
    assert(writes.every(w => !Object.hasOwn(w.body, 'company') && !Object.hasOwn(w.body, 'title')));
    failId = null;
    await undo(accountPage); assert.deepEqual(await counts(accountPage), [0, 50, 0]);
    failId = '1000';
    await accountPage.locator('#search').fill('Account Company 0');
    await accountPage.locator('.role-title').first().click(); await idle(accountPage);
    await accountPage.locator('#detail-form [name="notes"]').fill('Keep this edit if saving fails');
    await accountPage.locator('#detail-form [type="submit"]').click(); await idle(accountPage);
    assert(await accountPage.locator('#drawer').isVisible());
    assert.equal(await accountPage.locator('#detail-form [name="notes"]').inputValue(), 'Keep this edit if saving fails');
    assert((await accountPage.locator('[data-save-error]').textContent()).includes('Preflight save unavailable'));
    notes.push('Mocked signed-in API: partial bulk failure retains failed selection, limits concurrent writes to six, Undo restores successes, discovered fields stay read-only, and failed saves retain edits.');
    await signed.close();
    for (const file of files) assert.equal(hash(file), manifest[file], `Browser verification must not modify ${file}`);
    fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ manifest, fixedTime: NOW, notes }, null, 2));
    console.log(JSON.stringify({ passed: notes, baselines: OUT, sourceFilesChangedByTest: false }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });

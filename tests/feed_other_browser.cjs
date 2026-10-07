const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

// Self-contained browser coverage of the actual feed page and assets.
// PLAYWRIGHT_MODULE=/path/to/playwright node tests/feed_other_browser.cjs
const root = path.resolve(__dirname, '..');
const origin = 'http://oneshot.test';
const labels = { ok: 'healthy', degraded: 'retrying', failing: 'failing', stale: 'overdue', paused: 'paused', never: 'unpolled', unknown: 'unknown' };
function provider(source, discover_jobs, counts) {
  return { source, discover_jobs, boards: Object.entries(counts).flatMap(([state, count]) =>
    Array.from({ length: count }, (_, index) => ({ key: `${source}-${state}-${index}`, company: `${source} company ${index}`, state, coverage: index + 1, last_poll_at: '2026-10-07T08:00:00Z' }))) };
}
const featured = ['workday', 'oracle', 'greenhouse', 'ukg', 'smartrecruiters', 'eightfold']
  .map((source, index) => provider(source, 1000 - index, { ok: 12, degraded: 1, stale: 2 }));
const others = [provider('lever', 100, { ok: 1441, degraded: 73, stale: 397 }),
  ...Array.from({ length: 30 }, (_, index) => provider(index === 29 ? 'custom"]provider' : `other-${index}`, 99 - index,
    index === 0 ? { failing: 1 } : index === 1 ? { ok: 1 } : { ok: 7, degraded: 2, failing: 1, stale: 3, paused: 1, never: 2, unknown: 1 }))];
function snapshot(groups) {
  const providers = [...featured, ...groups];
  const total = providers.reduce((sum, item) => sum + item.boards.reduce((jobs, board) => jobs + board.coverage, 0), 0);
  return { providers, totals: { boards: providers.reduce((sum, item) => sum + item.boards.length, 0), providers: providers.length, active_postings: total, added_today: 0, disappeared_today: 0 }, classification: { total, student_roles: 10 } };
}
let payload = snapshot(others);
let failRefresh = false;
async function serve(context) {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/source-coverage/boards') return route.fulfill({ status: failRefresh ? 503 : 200, json: failRefresh ? { detail: 'Refresh unavailable' } : payload });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: url.pathname === '/api/auth/me' ? { authenticated: false } : { total: 0, jobs: [] } });
    const relative = url.pathname === '/source-coverage/' ? 'source-coverage/index.html' : url.pathname.replace(/^\/static\//, '');
    const filename = path.resolve(root, relative);
    if (!filename.startsWith(root + path.sep) || !fs.existsSync(filename)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: filename });
  });
}
(async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/Los_Angeles', reducedMotion: 'reduce' });
    await serve(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install();
    await page.goto(`${origin}/source-coverage/`);
    await page.locator('.wall > .band[data-band] canvas').first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('.tail-toggle strong').evaluate(el => el.firstChild.textContent.trim()), 'Other');
    assert.equal(await page.locator('.provider-count').textContent(), '31');
    assert.equal(await page.locator('.tail-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('.provider-row').count(), 0);
    const charts = page.locator('.wall > .band[data-band]');
    assert.deepEqual(await charts.evaluateAll(items => items.map(item => item.dataset.band)), featured.map(item => item.source));
    const featuredPixels = await charts.locator('canvas').evaluateAll(items => items.map(item => item.toDataURL()));
    await page.locator('.tail-toggle').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.provider-row').count(), 6);
    assert(await page.getByRole('button', { name: 'Previous page', exact: true }).isDisabled());
    const visited = [];
    for (let index = 0; index < 6; index++) {
      await page.getByRole('button', { name: `Page ${index + 1}`, exact: true }).click();
      const visible = others.slice(index * 6, index * 6 + 6);
      const ids = await page.locator('.provider-row').evaluateAll(items => items.map(item => item.dataset.provider));
      assert.deepEqual(ids, visible.map(item => item.source));
      visited.push(...ids);
      assert.equal(await page.locator('.provider-page-range').textContent(), `${index * 6 + 1}–${Math.min(index * 6 + 6, 31)} of 31`);
      assert(await page.locator('.provider-page-button[aria-current="page"]').evaluate(el => el === document.activeElement));
      for (const item of visible) {
        const row = page.locator('.provider-row').filter({ has: page.getByText(item.source === 'lever' ? 'Lever' : item.source, { exact: true }) });
        const counts = {};
        for (const board of item.boards) counts[board.state] = (counts[board.state] || 0) + 1;
        const description = Object.keys(labels).filter(state => counts[state]).map(state => `${counts[state].toLocaleString('en-US')} ${labels[state]}`).join(' · ');
        assert.equal(await row.locator('.provider-counts').textContent(), description);
        const percent = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format((counts.ok || 0) / item.boards.length * 100);
        assert.equal(await row.locator('.health-percent').textContent(), `${percent}% healthy`);
      }
    }
    assert.equal(new Set(visited).size, 31);
    assert(await page.getByRole('button', { name: 'Next page', exact: true }).isDisabled());
    // Unknown provider identifiers remain safe to expand, including quotes.
    await page.locator('.provider-row').click();
    assert.equal(await page.locator('.provider-detail:not([hidden]) canvas').count(), 1);
    await page.getByRole('button', { name: 'Page 1', exact: true }).click();
    assert.equal(await page.locator('.provider-detail:not([hidden])').count(), 0);
    const lever = page.locator('[data-provider="lever"]');
    await lever.focus();
    await page.keyboard.press('Enter');
    assert.equal(await lever.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('.provider-detail:not([hidden])').innerText(), '');
    const box = await page.locator('.provider-detail:not([hidden]) canvas').boundingBox();
    await page.mouse.move(box.x + 2, box.y + 2);
    await page.locator('.board-tip.visible').waitFor();
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    assert.equal(await page.locator('.provider-detail:not([hidden])').count(), 0);
    assert.equal(await page.locator('.board-tip.visible').count(), 0);
    assert.deepEqual(await charts.locator('canvas').evaluateAll(items => items.map(item => item.toDataURL())), featuredPixels);
    const layouts = [];
    for (const width of [320, 390, 768, 1024, 1440, 2208]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForTimeout(150);
      for (const index of [1, 4, 6]) {
        await page.getByRole('button', { name: `Page ${index}`, exact: true }).click();
        const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, textFits: [...document.querySelectorAll('.provider-counts, .provider-name, .health-percent')].every(el => el.scrollWidth <= el.clientWidth) }));
        assert.equal(layout.scrollWidth, width, `Page ${index} fits at ${width}px`);
        assert(layout.textFits, `Page ${index} text fits at ${width}px`);
      }
      layouts.push(width);
    }
    // Refresh preserves the page, clamps it if the provider list shrinks,
    // and leaves existing data available when a later request fails.
    await page.clock.runFor(60000);
    assert.equal(await page.locator('.provider-page-button[aria-current="page"]').textContent(), '6');
    payload = snapshot(others.slice(0, 7));
    await page.clock.runFor(60000);
    await page.waitForFunction(() => document.querySelector('.provider-count')?.textContent === '7');
    assert.equal(await page.locator('.provider-page-button[aria-current="page"]').textContent(), '2');
    assert.equal(await page.locator('.provider-row').count(), 1);
    failRefresh = true;
    await page.clock.runFor(60000);
    await page.locator('#stale-note:not([hidden])').waitFor();
    assert.equal(await page.locator('.provider-row').count(), 1);
    failRefresh = false;
    payload = snapshot(others.slice(0, 1));
    await page.clock.runFor(60000);
    await page.waitForFunction(() => document.querySelector('.provider-count')?.textContent === '1');
    assert.equal(await page.locator('.provider-pagination').count(), 0);
    assert.equal(await page.locator('.provider-row').count(), 1);
    await page.locator('.tail-toggle').click();
    assert.equal(await page.locator('.provider-row').count(), 0);
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.provider-row').count(), 1);
    payload = snapshot([]);
    await page.clock.runFor(60000);
    await page.waitForFunction(() => !document.querySelector('.tail'));
    assert.equal(await charts.count(), 6);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'PASS', otherProviders: 31, pages: 6, layouts, checks: ['Other label', 'default collapsed', 'six per page', 'final partial page', 'health summaries', 'boxes only', 'tooltip', 'keyboard focus', 'no horizontal overflow', 'refresh retention and clamping', 'failed refresh fallback', 'single and empty Other', 'featured charts unchanged'] }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });

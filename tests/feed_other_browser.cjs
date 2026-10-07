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
    await page.locator('.provider-row').first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('.tail-toggle, .other-heading, .provider-pagination').count(), 0);
    assert.equal(await page.locator('h1:visible').count(), 0, 'There is no visible page title');
    const rows = page.locator('.provider-list > .provider-entry .provider-row');
    assert.equal(await rows.count(), 37, 'Every provider is visible without pagination');
    assert.deepEqual(await rows.evaluateAll(items => items.map(item => item.dataset.provider)), payload.providers.map(item => item.source));
    assert.equal(await page.locator('#coverage-content canvas').count(), 0, 'All providers start folded');
    for (const item of payload.providers) {
      const row = rows.filter({ has: page.getByText(({ workday: 'Workday', oracle: 'Oracle', greenhouse: 'Greenhouse', ukg: 'UKG', smartrecruiters: 'SmartRecruiters', eightfold: 'Eightfold', lever: 'Lever' }[item.source] || item.source), { exact: true }) });
      const counts = {};
      for (const board of item.boards) counts[board.state] = (counts[board.state] || 0) + 1;
      const description = ['ok', 'degraded', 'stale', 'failing', 'paused', 'never', 'unknown'].filter(state => ['ok', 'degraded', 'stale'].includes(state) || counts[state]).map(state => `${(counts[state] || 0).toLocaleString('en-US')} ${labels[state]}`).join(', ');
      assert.equal(await row.locator('[role="tooltip"]').textContent(), description);
      assert.match(await row.locator('.provider-counts').textContent(), /boards? \| .*jobs?/);
      const percent = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format((counts.ok || 0) / item.boards.length * 100);
      assert.equal(await row.locator('.health-percent').textContent(), `${percent}% healthy`);
    }
    const workday = page.locator('[data-provider="workday"]');
    await workday.locator('.health-percent').hover();
    await workday.locator('[role="tooltip"]').waitFor({state:'visible'});
    assert.equal(await workday.locator('[role="tooltip"]').innerText(), '12 healthy, 1 retrying, 2 overdue');
    await workday.locator('.provider-chevron').click();
    assert.equal(await workday.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('.provider-detail:not([hidden]) canvas').count(), 1);
    await workday.focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#coverage-content canvas').count(), 0);
    await rows.last().click();
    assert.equal(await rows.last().getAttribute('aria-expanded'), 'true', 'Quoted provider IDs expand safely');
    const lever = page.locator('[data-provider="lever"]');
    await lever.focus();
    await page.keyboard.press('Enter');
    assert.equal(await lever.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('.provider-detail:not([hidden])').innerText(), '');
    const box = await page.locator('.provider-detail:not([hidden]) canvas').boundingBox();
    await page.mouse.move(box.x + 2, box.y + 2);
    await page.locator('.board-tip.visible').waitFor();
    await lever.click();
    assert.equal(await page.locator('.board-tip.visible').count(), 0);
    const layouts = [];
    for (const width of [320, 390, 768, 1024, 1440, 2208, 3440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForTimeout(150);
      const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, textFits: [...document.querySelectorAll('.provider-board-count, .provider-job-count, .provider-name, .health-percent')].every(el => el.scrollWidth <= el.clientWidth) }));
      assert.equal(layout.scrollWidth, width, `List fits at ${width}px`);
      assert(layout.textFits, `Text fits at ${width}px`);
      const columns = await rows.evaluateAll(items => items.map(row => {
        const bounds = selector => row.querySelector(selector).getBoundingClientRect();
        const name = bounds('.provider-name'), bar = bounds('.health-track');
        const percent = bounds('.health-percent'), board = bounds('.provider-board-count');
        const jobs = bounds('.provider-job-count'), arrow = bounds('.provider-chevron');
        const separator = row.querySelector('.provider-count-separator');
        return { name: name.x, bar: bar.x, percent: percent.right, barWidth: bar.width,
          gap: bar.x - name.right, board: board.right, jobs: jobs.right, arrow: arrow.right,
          boardAlign: getComputedStyle(row.querySelector('.provider-board-count')).textAlign,
          jobAlign: getComputedStyle(row.querySelector('.provider-job-count')).textAlign,
          separator: separator.textContent, separatorOpacity: Number(getComputedStyle(separator).opacity),
          height: row.getBoundingClientRect().height };
      }));
      assert(columns.every(row => Math.abs(row.bar - columns[0].bar) < 1 && Math.abs(row.percent - columns[0].percent) < 1), `Health columns align at ${width}`);
      assert(columns.every(row => row.gap <= 25 && row.gap >= 0 && row.barWidth > 0), `Bars immediately follow names at ${width}`);
      assert(columns.every(row => Math.abs(row.board - columns[0].board) < 1 && Math.abs(row.jobs - columns[0].jobs) < 1), `Metric columns align at ${width}`);
      assert(columns.every(row => row.boardAlign === 'right' && row.jobAlign === 'right'), `Metrics are right aligned at ${width}`);
      assert(columns.every(row => row.arrow < row.name), `Expand arrow precedes provider name at ${width}`);
      assert(columns.every(row => row.separator === '|' && row.separatorOpacity < .5), `Separators stay faint at ${width}`);
      if (width >= 1440) {
        assert(columns.every(row => row.height === 32), 'Desktop rows are compact');
        const header = await page.evaluate(() => {
          const y = selector => document.querySelector(selector).getBoundingClientRect().top;
          return { totals: y('#fleet-stats'), clock: y('#clock') };
        });
        assert(Math.abs(header.totals - header.clock) < 3, 'Totals and clock share the desktop header line');
      }
      if (width <= 560) assert(columns.every(row => row.height >= 44), 'Mobile rows keep touch targets');
      await workday.locator('.health-percent').hover();
      const tip = await workday.locator('[role="tooltip"]').boundingBox();
      assert(tip.x >= 0 && tip.x + tip.width <= width, `Health tooltip fits at ${width}`);
      await workday.locator('.provider-chevron').click();
      const canvas = await page.locator('.provider-detail:not([hidden]) canvas').boundingBox();
      assert(canvas.width > 0 && canvas.x + canvas.width <= width, `Expanded board boxes fit at ${width}`);
      await workday.click();
      const workspace = await page.locator('.workspace').boundingBox();
      assert(workspace.width <= 1320, 'Workspace has a fixed maximum width');
      layouts.push(width);
    }
    await lever.click();
    await page.clock.runFor(60000);
    assert.equal(await lever.getAttribute('aria-expanded'), 'true', 'Refresh preserves the open provider');
    payload = snapshot(others.slice(1, 7));
    await page.clock.runFor(60000);
    await page.waitForFunction(() => document.querySelectorAll('.provider-row').length === 12);
    assert.equal(await page.locator('.provider-detail:not([hidden])').count(), 0, 'Removed providers close their details');
    failRefresh = true;
    await page.clock.runFor(60000);
    await page.locator('#stale-note:not([hidden])').waitFor();
    assert.equal(await rows.count(), 12, 'Failed refresh preserves the list');
    failRefresh = false;
    payload = { ...snapshot([]), providers: [featured[0]] };
    await page.clock.runFor(60000);
    await page.waitForFunction(() => document.querySelectorAll('.provider-row').length === 1);
    payload = { ...snapshot([]), providers: [] };
    await page.clock.runFor(60000);
    await page.getByText('No feed overview data yet', { exact: true }).waitFor();
    payload = snapshot(others);
    await page.clock.runFor(60000);
    await page.waitForFunction(() => document.querySelectorAll('.provider-row').length === 37);
    await page.setViewportSize({width:1440,height:1000});
    await page.screenshot({path:'/tmp/oneshot-feed-layout-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await workday.click();
    await page.screenshot({path:'/tmp/oneshot-feed-layout-mobile.png',fullPage:true});
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'PASS', providers: 37, layouts, checks: ['all ATS visible', 'compact desktop rows', 'mobile touch targets', 'right aligned metric columns', 'faint pipe separators', 'leading expand arrow', 'no horizontal overflow', 'health tooltip', 'board expansion', 'keyboard focus', 'refresh retention', 'failed refresh fallback', 'single and empty lists'] }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });

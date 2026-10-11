const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

// Exercise the real page with local assets and isolated guest data.
const ROOT = path.resolve(__dirname, '../..');
const ORIGIN = 'http://oneshot.test';
const names = ['Python', 'SQL', 'Matplotlib', 'NumPy', 'pandas', 'scikit-learn', 'statsmodels', 'XGBoost'];
const skills = labels => labels.map((name, i) => ({ id: name, name, label: name, category: i < 2 ? 'language' : 'library' }));
const jobs = Array.from({ length: 30 }, (_, i) => ({
  id: i + 1, company: 'cswg', title: i ? `Software Engineering Intern ${i}` : 'IS Internship - Data Analytics & Data Science',
  job_type: 'intern', location: 'Edison, NJ', posted_at: new Date().toISOString(),
  source: 'workday:cswg', apply_url: `https://example.test/jobs/${i}`, attributes: {},
  summary: 'Work in the Data Analytics function within the Enterprise Data & Innovation team, supporting reporting and insights innovation by applying statistics and data science to analytics modernization.',
  skills: skills(names),
}));
jobs[1].skills = skills(['Python', 'SQL', 'Matplotlib', 'NumPy']);
jobs[2].skills = skills(['AnUnusuallyLongSkillLabel'.repeat(8)]);
jobs[2].title = 'UnbrokenJobTitle'.repeat(20);
jobs[3].skills = [];
jobs[4].skills = skills(Array.from({ length: 18 }, (_, i) => `Tool ${i}`));
const tick = page => page.evaluate(() => document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/auth/me') return route.fulfill({ status: 401, json: {} });
      if (url.pathname === '/api/jobs') return route.fulfill({ json: { jobs, total: jobs.length, job_type_counts: { intern: jobs.length } } });
      const relative = url.pathname === '/' ? 'web/discover/index.html' : url.pathname.replace(/^\/static\//, 'web/');
      const file = path.resolve(ROOT, relative);
      return file.startsWith(ROOT + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()
        ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
    });
    let wideCard;
    for (const width of [760, 761, 1024, 1280, 1476, 1477, 1600, 1800, 2200]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(ORIGIN);
      await page.waitForSelector(width === 760 ? '.job-row' : '.detail-inner');
      await tick(page);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Overflow at ${width}`);
      if (width === 760) {
        assert.equal(await page.locator('#phone').count(), 1, 'Existing phone UI is selected');
        assert.equal(await page.locator('.opportunity').count(), 0);
        continue;
      }
      const metrics = await page.evaluate(() => {
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
        return {
          grid: rect('.discover-grid'), list: rect('.opportunity-list'), rail: rect('.sidebar'),
          search: rect('.topbar-search'), tools: rect('.list-tools'), card: rect('.detail-inner'),
          header: rect('.app-topbar'), shell: rect('.app-shell'), toolbar: rect('.discover-controls-pane'), facts: rect('.detail-facts'),
          backdrop: getComputedStyle(document.body).backgroundColor,
          ground: getComputedStyle(document.querySelector('.discover-page')).backgroundColor,
          balance: getComputedStyle(document.querySelector('.opportunity h3')).textWrap,
        };
      });
      assert.equal(metrics.grid.width, Math.min(width - 76, 1400));
      assert.equal(metrics.list.left, metrics.rail.right, 'Results stay attached to navigation');
      assert.equal(metrics.header.left, 0, 'Header stays attached to the left edge');
      assert.equal(metrics.header.right, Math.min(width, 1476));
      assert.equal(metrics.shell.right, metrics.header.right, 'Shell and header share an edge');
      assert.equal(metrics.toolbar.right, metrics.header.right, 'Toolbar and header share an edge');
      assert.equal(metrics.grid.right, metrics.header.right, 'Workspace and header share an edge');
      assert.equal(metrics.backdrop, 'rgb(230, 234, 227)');
      assert.equal(metrics.ground, 'rgb(245, 246, 243)');
      assert.ok(Math.abs(metrics.search.right - metrics.card.right) < 1, `Search/card alignment at ${width}`);
      assert.ok(Math.abs(metrics.tools.right - metrics.card.right) < 1, `Toolbar/card alignment at ${width}`);
      assert.ok(metrics.facts.width <= 960);
      assert.equal(metrics.balance, 'balance');
      if (width === 1800) wideCard = metrics.card;
      if (width === 2200) assert.deepEqual(metrics.card, wideCard, 'Card stops growing at the cap');
      const rows = await page.locator('.opportunity').evaluateAll(rows => rows.slice(0, 5).map(row => {
        const chips = [...row.querySelectorAll('.tag:not(.tag-more)')].filter(e => !e.hidden);
        const more = row.querySelector('.tag-more');
        const visible = [...chips, ...(more ? [more] : [])];
        const tags = row.querySelector('.tags');
        const title = row.querySelector('h3');
        return {
          shown: chips.length, more: Number(more?.textContent.slice(1) || 0), label: more?.getAttribute('aria-label'),
          lines: new Set(visible.map(e => e.getBoundingClientRect().top)).size,
          fits: !tags || visible.every(e => e.getBoundingClientRect().right <= tags.getBoundingClientRect().right + 1),
          titleLines: title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight),
        };
      }));
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        assert.equal(row.shown + row.more, jobs[i].skills.length, `Accurate count at ${width}, job ${i}`);
        assert.ok(row.shown <= 6 && row.lines <= 1 && row.fits && row.titleLines <= 2.01);
        if (row.more) assert.equal(row.label, `${row.more} more skill${row.more === 1 ? '' : 's'}`);
      }
    }
    // Refit the same DOM, including a row that initially has no overflow counter.
    const visibleCount = () => page.locator('[data-job="2"] .tag:not(.tag-more)').evaluateAll(chips => chips.filter(e => !e.hidden).length);
    const wideCount = await visibleCount();
    await page.setViewportSize({ width: 1024, height: 900 }); await tick(page);
    assert.ok(await visibleCount() < wideCount, 'Narrowing hides chips');
    await page.setViewportSize({ width: 2200, height: 900 }); await tick(page);
    assert.equal(await visibleCount(), wideCount, 'Widening restores chips');
    await page.locator('[data-job="1"]').click();
    await page.locator('.opportunity-list').evaluate(list => { list.scrollTop = 300; });
    const top = await page.locator('.opportunity-list').evaluate(list => list.scrollTop);
    await page.locator('.field-trigger').click();
    assert.equal(await page.locator('.opportunity-list').evaluate(list => list.scrollTop), top);
    assert.equal(await page.locator('.detail').getAttribute('data-selected'), '1');
    await page.keyboard.press('Escape');
    await page.locator('[data-job="1"]').focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('.detail').getAttribute('data-selected'), '2');
    await page.locator('.detail [data-action="skip"]').click();
    await page.keyboard.press('1');
    await page.waitForSelector('.skip-notice');
    await page.locator('.skip-notice [data-action="undo"]').click();
    await page.waitForSelector('[data-job="2"]');
    assert.deepEqual(errors, []);
    console.log('PASS: nine widths, subtle backdrop, shared edges, capped layout, mobile, title/skill edge cases, resize, scroll, menus and keyboard triage');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

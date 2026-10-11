const assert = require('node:assert/strict');
const { chromium, expect } = require(process.env.PLAYWRIGHT_MODULE || '@playwright/test');
const { ORIGIN, fixture, serve } = require('./browser/feed_fixture.cjs');
const origin = process.env.ONESHOT_TEST_ORIGIN || ORIGIN;
const fmt = n => new Intl.NumberFormat('en-US').format(n);
const keys = ['intern', 'coop', 'student', 'new_grad', 'research', 'unclassified'];

// Defaults to isolated fixtures; ONESHOT_TEST_ORIGIN enables read-only live API checks.
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    let payload;
    if (!process.env.ONESHOT_TEST_ORIGIN) {
      payload = fixture();
      await serve(context, route => route.fulfill({ json: payload }));
    } else {
      await context.route('**/api/source-coverage/boards', async route => {
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        payload = await response.json();
        await route.fulfill({ response });
      });
    }
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${origin}/source-coverage/`);
    await expect(page.locator('.classification-summary')).toBeVisible();
    assert.equal(payload.totals.active_postings, payload.classification.total);
    await expect(page.locator('#fleet-stats b').nth(2)).toHaveText(fmt(payload.classification.total));
    await expect(page.locator('.classification-total')).toHaveText(fmt(payload.classification.total));
    await expect(page.locator('.classification-students')).toHaveText(fmt(payload.classification.student_roles));
    const detail = payload.today_breakdown;
    await expect(page.locator('#today-line')).toHaveText(`${fmt(detail.total)} jobs posted, ${fmt(detail.disappeared.total)} jobs closed today`);
    for (const width of [768, 1024, 1440, 2208]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.locator('.ticker-toggle').click();
      await expect(page.locator('#ticker-card')).toBeVisible();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      const values = await page.locator('#ticker-card tr').evaluateAll(rows => rows.map(row => [...row.querySelectorAll('td')].slice(1).map(cell => cell.textContent)));
      assert.deepEqual(values, keys.map(key => [detail.types[key] == null ? '+—' : `+${fmt(detail.types[key])}`, detail.disappeared.types[key] == null ? '—' : `−${fmt(detail.disappeared.types[key])}`]));
      const box = await page.locator('#ticker-card').boundingBox();
      assert(box.x >= 0 && box.x + box.width <= width);
      await page.keyboard.press('Escape');
      await expect(page.locator('#ticker-card')).toBeHidden();
      await page.locator('.ticker-toggle').click();
      await page.locator('#clock').click();
      await expect(page.locator('#ticker-card')).toBeHidden();
    }
    assert.deepEqual(errors, []);
    await context.close();

    // Unknown closures stay unknown, while measured zeros remain visible.
    const phone = await browser.newContext({ viewport: { width: 320, height: 844 }, isMobile: true, hasTouch: true });
    const unknown = fixture();
    delete unknown.totals.disappeared_today;
    delete unknown.today_breakdown.disappeared;
    await serve(phone, route => route.fulfill({ json: unknown }));
    const p = await phone.newPage();
    await p.goto(`${ORIGIN}/source-coverage/`);
    await p.locator('[data-act="ticker"]').click();
    await expect(p.locator('.ticker-card')).toBeVisible();
    await expect(p.locator('.ticker-card tr').nth(2).locator('.pos')).toHaveText('0');
    assert((await p.locator('.ticker-card .neg').allTextContents()).every(value => value === '—'));
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth), 320);
    await phone.close();
    console.log('Feed overview checks passed: pipeline totals, classification, daily counts, desktop breakdown controls, phone unknown/zero counts, and responsive layout.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

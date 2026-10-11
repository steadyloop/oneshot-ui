const assert = require('node:assert/strict');
const { chromium, expect } = require(process.env.PLAYWRIGHT_MODULE || '@playwright/test');
const { ORIGIN, fixture, serve } = require('./browser/feed_fixture.cjs');

// The current desktop table and dedicated phone screens, with isolated API fixtures.
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/Los_Angeles' });
    let payload = fixture(), fail = false;
    await serve(context, route => route.fulfill({ status: fail ? 503 : 200, json: fail ? { detail: 'Refresh unavailable' } : payload }));
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install();
    await page.goto(`${ORIGIN}/source-coverage/`);
    const rows = page.locator('.p-row');
    await expect(rows).toHaveCount(37);
    assert.deepEqual(await rows.evaluateAll(items => items.map(row => row.dataset.provider)), payload.providers.map(p => p.source));
    assert.equal(await page.locator('canvas').count(), 0);
    const workday = page.locator('[data-provider="workday"]');
    await expect(workday.locator('.pct')).toHaveText('80%');
    await expect(workday.locator('.pct')).toHaveAttribute('title', '12 healthy, 1 retrying, 2 overdue, 0 failing');
    await workday.click();
    await expect(workday).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.p-detail canvas')).toBeVisible();
    const square = await page.locator('.p-detail canvas').boundingBox();
    await page.mouse.move(square.x + 2, square.y + 2);
    await expect(page.locator('.sq-tip')).toBeVisible();
    await expect(page.locator('.sq-tip')).toContainText('Retrying');
    await workday.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('canvas')).toHaveCount(0);
    await rows.last().click();
    await expect(rows.last()).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.p-detail canvas')).toBeVisible();
    for (const width of [768, 1024, 1440, 2208, 3440]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      await expect(rows).toHaveCount(37);
    }
    await page.clock.runFor(60000);
    await expect(rows.last()).toHaveAttribute('aria-expanded', 'true');
    fail = true; await page.clock.runFor(60000);
    await expect(page.locator('#stale-note')).toBeVisible();
    await expect(rows).toHaveCount(37);
    fail = false; payload = { ...fixture(), providers: [fixture().providers[0]] };
    await page.clock.runFor(60000);
    await expect(rows).toHaveCount(1);
    await expect(page.locator('.p-detail')).toHaveCount(0);
    payload.providers = []; await page.clock.runFor(60000);
    await expect(page.getByText('No feed overview data yet', { exact: true })).toBeVisible();
    assert.deepEqual(errors, []);
    await context.close();

    for (const width of [320, 390, 760]) {
      const phone = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
      await serve(phone, route => route.fulfill({ json: fixture() }));
      const p = await phone.newPage(), phoneErrors = [];
      p.on('pageerror', e => phoneErrors.push(e.message));
      await p.goto(`${ORIGIN}/source-coverage/`);
      await expect(p.locator('[data-prov]')).toHaveCount(37);
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth), width);
      await p.locator('[data-prov="workday"]').click();
      await expect(p.locator('canvas[data-squares="workday"]')).toBeVisible();
      await expect(p.locator('.hstat').first()).toContainText('healthy');
      const box = await p.locator('canvas[data-squares]').boundingBox();
      await p.locator('canvas[data-squares]').click({ position: { x: 2, y: 2 } });
      await expect(p.locator('.sq-info')).toContainText('Retrying');
      assert(box.x >= 0 && box.x + box.width <= width);
      await p.locator('[data-act="ticker"]').click();
      await expect(p.locator('.ticker-card')).toBeVisible();
      await p.locator('[data-act="ticker"]').click();
      await expect(p.locator('.ticker-card')).toHaveCount(0);
      assert.deepEqual(phoneErrors, []);
      await phone.close();
    }
    console.log('Feed provider checks passed: 37 providers, desktop/phone layouts, board details, keyboard, quoted IDs, refresh retention, failed refresh, and empty state.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

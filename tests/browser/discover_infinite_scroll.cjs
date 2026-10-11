const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

// Static files and API fixtures only; no server, database or account required.
const ROOT = path.resolve(__dirname, '../..');
const ORIGIN = 'http://oneshot.test';
const jobs = Array.from({ length: 250 }, (_, i) => ({
  id: i + 1, company: `Company ${i}`, title: `Software Intern ${i}`,
  job_type: 'intern', location: 'San Francisco, CA',
  posted_at: new Date(Date.now() - Math.floor(i / 75) * 86400000).toISOString(),
  apply_url: `https://example.test/jobs/${i}`, attributes: {},
}));
const tick = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const scrollNearEnd = page => page.locator('.opportunity-list').evaluate(list => {
  list.scrollTop = list.scrollHeight - list.clientHeight - 400;
  list.dispatchEvent(new Event('scroll'));
});
const waitForRows = (page, count) => page.waitForFunction(count => document.querySelectorAll('.opportunity').length === count, count);

(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [], requests = [];
    let failNext = false, emptyNext = false, deferNext = false, release;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/auth/me') return route.fulfill({ status: 401, json: {} });
      if (url.pathname === '/api/jobs') {
        const limit = Number(url.searchParams.get('limit'));
        const offset = Number(url.searchParams.get('offset'));
        const type = url.searchParams.get('job_type');
        if (limit === 100) requests.push({ offset, type });
        if (offset && deferNext) {
          deferNext = false;
          await new Promise(resolve => { release = resolve; });
        }
        if (offset && failNext) {
          failNext = false;
          return route.fulfill({ status: 503, json: { detail: 'Try again' } });
        }
        const empty = offset && emptyNext;
        emptyNext = false;
        const rows = type === 'coop' ? [{ ...jobs[0], id: 999, job_type: 'coop' }] : jobs;
        return route.fulfill({ json: { jobs: empty ? [] : rows.slice(offset, offset + limit), total: rows.length, job_type_counts: { intern: 250, coop: 1 } } });
      }
      const relative = url.pathname === '/' ? 'web/discover/index.html' : url.pathname.replace(/^\/static\//, 'web/');
      const file = path.resolve(ROOT, relative);
      return file.startsWith(ROOT + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()
        ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
    });
    await page.goto(ORIGIN);
    await waitForRows(page, 100);
    assert.equal(requests.length, 1, 'Initial page remains 100 jobs');
    await page.locator('.detail').evaluate(detail => detail.dispatchEvent(new Event('scroll')));
    await tick(page);
    assert.equal(requests.length, 1, 'Detail scrolling does not load the feed');
    const selected = await page.locator('.detail').getAttribute('data-selected');
    deferNext = true;
    await scrollNearEnd(page);
    await page.waitForFunction(() => document.querySelector('[data-action="load-more"]')?.disabled);
    const top = await page.locator('.opportunity-list').evaluate(list => list.scrollTop);
    for (let i = 0; i < 5; i++) await scrollNearEnd(page);
    await tick(page);
    assert.equal(requests.filter(r => r.offset === 100).length, 1, 'One request during rapid scrolling');
    release();
    await waitForRows(page, 200);
    assert.equal(await page.locator('.detail').getAttribute('data-selected'), selected);
    assert.equal(await page.locator('.opportunity-list').evaluate(list => list.scrollTop), top, 'Append preserves scroll position');
    await scrollNearEnd(page);
    await waitForRows(page, 250);
    assert.equal(await page.locator('[data-action="load-more"]').count(), 0);
    await scrollNearEnd(page);
    await tick(page);
    assert.deepEqual(requests.map(r => r.offset), [0, 100, 200], 'Stops at the end');

    await page.reload();
    await waitForRows(page, 100);
    failNext = true;
    await scrollNearEnd(page);
    await page.waitForFunction(() => document.querySelector('#flash')?.textContent.includes('Try again'));
    const failedRequests = requests.length;
    await scrollNearEnd(page);
    await tick(page);
    assert.equal(requests.length, failedRequests, 'Failure does not cause automatic retries');
    await page.locator('[data-action="load-more"]').click();
    await waitForRows(page, 200);

    await page.reload();
    await waitForRows(page, 100);
    emptyNext = true;
    await scrollNearEnd(page);
    await page.waitForFunction(() => !document.querySelector('[data-action="load-more"]')?.disabled);
    await tick(page);
    const emptyRequests = requests.length;
    await scrollNearEnd(page);
    await tick(page);
    assert.equal(requests.length, emptyRequests, 'Empty page does not loop');

    await page.reload();
    await waitForRows(page, 100);
    deferNext = true;
    await scrollNearEnd(page);
    await page.waitForFunction(() => document.querySelector('[data-action="load-more"]')?.disabled);
    await page.locator('[data-filter="coops"]').click();
    await waitForRows(page, 1);
    const oldResponse = page.waitForResponse(response => new URL(response.url()).searchParams.get('offset') === '100');
    release();
    await oldResponse;
    await tick(page);
    assert.equal(await page.locator('.opportunity').count(), 1, 'Old append cannot overwrite new filters');
    assert.equal(await page.locator('.opportunity').getAttribute('data-job'), '999');
    await page.locator('[data-action="toggle-hidden"]').click();
    const hiddenRequests = requests.length;
    await page.locator('.opportunity-list').evaluate(list => list.dispatchEvent(new Event('scroll')));
    await tick(page);
    assert.equal(requests.length, hiddenRequests, 'Hidden list does not load the feed');
    assert.deepEqual(errors, []);
    console.log('PASS: auto-load, batch size, concurrency, scroll/selection, exhaustion, retry, empty page, filter race and Hidden');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

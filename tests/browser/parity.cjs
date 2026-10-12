// Compare the complete app to a saved web/ directory, using isolated guest data.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '@playwright/test');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch').default;
const { createVisitorState, handle } = require('../../web/shared/guest.js');
const { fixture } = require('./feed_fixture.cjs');

const current = path.resolve(__dirname, '../../web');
const baseline = process.env.ONESHOT_BASELINE_WEB;
const artifacts = process.env.ONESHOT_PARITY_ARTIFACTS || '/private/tmp/oneshot-frontend-parity';
const origin = 'http://oneshot-parity.test';
const pages = { '/': 'discover', '/application/': 'applied', '/resume/': 'resume', '/source-coverage/': 'feeds', '/login/': 'login' };
const ready = { discover: '.job-row,.opportunity', applied: '#workspace[aria-busy="false"],.stage-empty', resume: '.profile-contact-name,.r-card', feeds: '.p-row,.prov-btn', login: '.signin' };
const jobs = Array.from({ length: 30 }, (_, i) => ({
  id: i + 1, company: 'Northstar Labs', title: `Software Engineering Intern ${i + 1}`,
  job_type: 'intern', location: 'Seattle, WA', posted_at: '2026-10-10T12:00:00Z',
  source: 'greenhouse:northstar', apply_url: `https://example.com/jobs/${i + 1}`,
  summary: 'Build reliable tools with a collaborative engineering team.', attributes: {},
  skills: [{ id: 'python', name: 'Python', label: 'Python', category: 'language' }],
}));
const sizes = [[390, 844, true], [760, 900, false], [761, 900, false], [1440, 900, false], [2560, 900, false], [844, 390, true]];

async function snapshot(browser, web, pathname, size, seed) {
  const [width, height, hasTouch] = size;
  const context = await browser.newContext({ viewport: { width, height }, hasTouch, reducedMotion: 'reduce', timezoneId: 'UTC' });
  const errors = [];
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.setFixedTime(new Date('2026-10-11T12:00:00Z'));
  await context.addInitScript(data => localStorage.setItem('oneshot.visitor-data.state.v1', JSON.stringify(data)), seed);
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.fulfill({ status: 404, body: '' });
    if (url.pathname === '/api/auth/me') return route.fulfill({ status: 401, json: {} });
    if (url.pathname === '/api/jobs') {
      const offset = Number(url.searchParams.get('offset')) || 0;
      return route.fulfill({ json: { jobs: jobs.slice(offset), total: jobs.length, job_type_counts: { intern: jobs.length } } });
    }
    if (url.pathname === '/api/source-coverage/boards') return route.fulfill({ json: fixture() });
    if (url.pathname.startsWith('/api/')) {
      errors.push(`Unexpected API request: ${url.pathname}`);
      return route.fulfill({ status: 404, json: {} });
    }
    const relative = pages[url.pathname] ? `${pages[url.pathname]}/index.html` : url.pathname.replace(/^\/static\//, '');
    const file = path.resolve(web, relative);
    try {
      assert.ok(file.startsWith(path.resolve(web) + path.sep));
      await fs.access(file);
      return await route.fulfill({ path: file });
    } catch {
      if (url.pathname !== '/favicon.ico') errors.push(`Missing asset: ${url.pathname}`);
      return route.fulfill({ status: 404, body: '' });
    }
  });
  try {
    await page.goto(origin + pathname);
    await page.waitForSelector(ready[pages[pathname]]);
    await page.evaluate(() => document.fonts.ready);
    // Wait for delayed view updates and transitions to settle.
    await page.waitForTimeout(400);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(errors, [], `${pathname} at ${width}x${height}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Overflow: ${pathname} at ${width}x${height}`);
    const styles = await page.locator('body *').evaluateAll(elements => elements.filter(element => element.getBoundingClientRect().width).map(element => {
      const css = getComputedStyle(element), rect = element.getBoundingClientRect();
      return [element.tagName, element.className?.baseVal ?? element.className, rect.x, rect.y, rect.width, rect.height,
        ...['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textTransform', 'color', 'backgroundColor',
          'display', 'position', 'padding', 'margin', 'gap', 'border', 'borderRadius', 'boxShadow', 'opacity', 'transform',
          'outline', 'fill', 'stroke'].map(key => css[key])];
    }));
    // Capture the viewport without resizing a page at the mobile breakpoint.
    return { image: await page.screenshot({ animations: 'disabled' }), styles };
  } finally { await context.close(); }
}

(async () => {
  await fs.mkdir(artifacts, { recursive: true });
  const seed = createVisitorState();
  seed.jobs = jobs;
  for (const job of jobs.slice(0, 3)) await handle(`/jobs/${job.id}/applications`, { method: 'POST', body: JSON.stringify({ submitted_at: '2026-10-10' }) }, seed);
  seed.resume.profile.full_name = 'Alex Morgan';
  seed.resume.profile.email = 'alex@example.com';
  await handle('/resume/entries', { method: 'POST', body: JSON.stringify({ kind: 'education', org: 'University of Washington', role: 'Computer Science', end_date: 'Jun 2027' }) }, seed);
  await handle('/resume/skills', { method: 'POST', body: JSON.stringify({ category: 'language', name: 'Python' }) }, seed);
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  try {
    for (const [pathname, name] of Object.entries(pages)) for (const size of sizes) {
      if (process.env.ONESHOT_PARITY_PAGES && !process.env.ONESHOT_PARITY_PAGES.split(',').includes(name)) continue;
      const label = `${name}-${size[0]}x${size[1]}`;
      const actual = await snapshot(browser, current, pathname, size, seed);
      await fs.writeFile(path.join(artifacts, `${label}.png`), actual.image);
      if (baseline) {
        const expected = await snapshot(browser, baseline, pathname, size, seed);
        await fs.writeFile(path.join(artifacts, `${label}-baseline.png`), expected.image);
        assert.deepEqual(actual.styles, expected.styles, `Computed styles changed: ${label}`);
        const actualPNG = PNG.sync.read(actual.image), expectedPNG = PNG.sync.read(expected.image);
        assert.equal(actualPNG.width, expectedPNG.width); assert.equal(actualPNG.height, expectedPNG.height);
        // Chromium occasionally varies edge antialiasing by one or two levels.
        assert.equal(pixelmatch(actualPNG.data, expectedPNG.data, null, actualPNG.width, actualPNG.height,
          { threshold: 0.02, includeAA: true }), 0, `Screenshot changed: ${label}`);
      }
      console.log(`PASS: ${label}${baseline ? ' matches baseline' : ''}`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

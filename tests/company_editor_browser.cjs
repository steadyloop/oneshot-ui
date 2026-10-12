const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createVisitorState, handle } = require('../web/shared/guest.js');
const ROOT = path.resolve(__dirname, '../web');
const pages = { '/': 'discover', '/application/': 'applied', '/resume/': 'resume', '/source-coverage/': 'feeds' };
const ORIGIN = 'http://oneshot-company-editor.test';
const OUT = process.env.COMPANY_EDITOR_ARTIFACTS || '/private/tmp/oneshot-company-editor-browser';
fs.mkdirSync(OUT, { recursive: true });

async function setup(browser, account) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const state = { companies: Array.from({ length: 57 }, (_, i) => ({ id: i + 1, name: `Company ${String(i).padStart(3, '0')}`, domain: `company${i}.example`, description: null, tags: {}, sync_pending: false, sync_error: null })), calls: [], patches: [], fail: null };
  state.companies[0].name = 'Acme <script>alert(1)</script>';
  Object.assign(state.companies[1], { name: 'Shared Website Subsidiary', domain: null,
    website: 'https://parent.example/collision-centers',
    tags: { company_resolution: { website: 'https://parent.example/collision-centers' } } });
  state.companies[2].website = 'javascript:alert(1)';
  state.companies[3].tags = { company_resolution: { website: 'https://company0.example',
    canonical_company_id: 100, canonical_serving_id: 1, canonical_name: state.companies[0].name } };
  const fixtures = createVisitorState();
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' });
    if (url.pathname === '/api/auth/me') return route.fulfill({ status: account ? 200 : 401, json: account || { detail: 'Not signed in' } });
    if (url.pathname.startsWith('/api/admin/companies')) {
      state.calls.push(url.pathname);
      if (state.fail) return route.fulfill({ status: state.fail, json: { detail: state.fail === 403 ? 'Company editing is restricted to the administrator' : 'That domain is already assigned to another company' } });
      if (request.method() === 'PATCH') {
        const changes = request.postDataJSON(), id = Number(url.pathname.split('/').at(-1));
        state.patches.push(changes);
        const row = state.companies.find(row => row.id === id);
        Object.assign(row, changes, { sync_pending: true });
        return route.fulfill({ json: row });
      }
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const filtered = state.companies.filter(row => `${row.name} ${row.domain}`.toLowerCase().includes(q) || String(row.id) === q);
      const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 50);
      return route.fulfill({ json: { companies: filtered.slice(offset, offset + limit), total: filtered.length } });
    }
    if (url.pathname === '/api/jobs') return route.fulfill({ json: { jobs: [], total: 0 } });
    if (url.pathname === '/api/source-coverage/boards') return route.fulfill({ json: { providers: [], totals: {} } });
    if (url.pathname.startsWith('/api/')) {
      const response = await handle(url.pathname.slice(4) + url.search, { method: request.method(), body: request.postData() }, fixtures);
      return route.fulfill({ status: response.status, json: await response.json().catch(() => ({})) });
    }
    const relative = url.pathname.startsWith('/static/') ? url.pathname.slice(8) : `${pages[url.pathname]}/index.html`;
    const file = path.resolve(ROOT, relative);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: file });
  });
  return { context, state };
}

async function open(page) {
  await page.getByRole('button', { name: 'Account menu', exact: true }).first().click();
  await page.getByRole('button', { name: 'Manage companies', exact: true }).click();
  await page.waitForSelector('.company-editor[open][aria-busy="false"]');
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  try {
    for (const account of [null, { name: 'Other', email: 'other@gmail.com', can_edit_companies: false }, { name: 'Missing capability', email: 'msg.shkim@gmail.com' }]) {
      const { context, state } = await setup(browser, account);
      const page = await context.newPage();
      await page.goto(ORIGIN + '/');
      await page.locator('.account').waitFor();
      if (account) await page.getByRole('button', { name: 'Account menu', exact: true }).first().click();
      assert.equal(await page.getByRole('button', { name: 'Manage companies', exact: true }).count(), 0);
      assert.equal(await page.locator('.company-editor').count(), 0);
      assert.equal(state.calls.length, 0);
      await context.close();
    }
    const account = { name: 'Admin', email: 'msg.shkim@gmail.com', can_edit_companies: true };
    const { context, state } = await setup(browser, account);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(ORIGIN + '/');
    await open(page);
    assert.equal(await page.locator('.company-editor tbody tr').count(), 50);
    assert.equal(await page.locator('.company-editor tbody script').count(), 0);
    const sharedRow = page.locator('.company-editor tbody tr[data-id="2"]');
    assert.equal(await sharedRow.getByRole('link').getAttribute('href'), 'https://parent.example/collision-centers');
    assert.equal(await page.locator('.company-editor tbody tr[data-id="3"] a').count(), 0);
    await page.getByRole('button', { name: 'Edit Shared Website Subsidiary', exact: true }).click();
    assert.equal(await page.getByLabel('Domain', { exact: true }).inputValue(), '');
    assert.equal(await page.locator('.company-editor-website a').getAttribute('href'), 'https://parent.example/collision-centers');
    assert.equal(state.patches.length, 0);
    await page.getByRole('button', { name: 'Edit Company 003', exact: true }).click();
    assert.equal(await page.locator('.company-editor-related script').count(), 0);
    assert.match(await page.locator('.company-editor-related').textContent(), /Same company as Acme/);
    await page.getByRole('button', { name: 'Open canonical profile', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.company-editor-form [name="name"]').value === 'Acme <script>alert(1)</script>'
      && document.querySelector('.company-editor').getAttribute('aria-busy') === 'false');
    await page.getByLabel('Find a company', { exact: true }).fill('');
    await page.locator('.company-editor-search button').click();
    await page.waitForFunction(() => document.querySelector('.company-editor-pager span').textContent === '1–50 of 57');
    await page.getByRole('button', { name: 'Edit Acme <script>alert(1)</script>', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Updated Acme');
    await page.getByLabel('Description', { exact: true }).fill('New company description');
    await page.getByLabel('Tags (JSON)', { exact: true }).fill('[]');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    assert.equal(state.patches.length, 0);
    await page.getByLabel('Tags (JSON)', { exact: true }).fill('{"startup": true}');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.company-editor-status').textContent.startsWith('Saved changes'));
    assert.deepEqual(state.patches[0], { name: 'Updated Acme', description: 'New company description', tags: { startup: true } });
    assert.match(await page.locator('.company-editor-record').textContent(), /Waiting to sync/);
    await page.getByLabel('Domain', { exact: true }).fill('taken.example');
    state.fail = 409;
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.waitForSelector('.company-editor-status.is-error');
    assert.equal(await page.getByLabel('Domain', { exact: true }).inputValue(), 'taken.example');
    state.fail = null;
    await page.getByRole('button', { name: 'Reset changes', exact: true }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.company-editor-pager span').textContent === '51–57 of 57');
    assert.equal(await page.locator('.company-editor tbody tr').count(), 7);
    await page.getByRole('button', { name: 'Previous', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.company-editor-pager span').textContent === '1–50 of 57');
    await page.getByLabel('Find a company', { exact: true }).fill('Updated Acme');
    await page.locator('.company-editor-search button').click();
    await page.waitForFunction(() => document.querySelector('.company-editor-pager span').textContent === '1–1 of 1');
    await page.getByRole('button', { name: 'Edit Updated Acme', exact: true }).click();
    await page.setViewportSize({ width: 768, height: 844 });
    assert(await page.locator('.company-editor').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    await page.screenshot({ path: path.join(OUT, 'narrow.png') });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: path.join(OUT, 'desktop.png') });
    await page.getByLabel('Name', { exact: true }).fill('Unsaved edit');
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: 'Close company editor', exact: true }).click();
    assert.equal(await page.locator('.company-editor[open]').count(), 1);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Close company editor', exact: true }).click();
    assert.equal(await page.locator('.company-editor[open]').count(), 0);
    await open(page);
    await page.getByRole('button', { name: 'Edit Updated Acme', exact: true }).click();
    await page.getByLabel('Description', { exact: true }).fill('Expired access');
    state.fail = 403;
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.waitForSelector('.company-editor-status.is-error');
    assert.equal(await page.locator('.company-editor tbody tr').count(), 0);
    assert.equal(await page.locator('.company-editor-form').isVisible(), false);
    assert.deepEqual(errors, []);
    await context.close();
    for (const route of ['/application/', '/resume/', '/source-coverage/']) {
      const { context } = await setup(browser, account);
      const page = await context.newPage();
      await page.goto(ORIGIN + route);
      await open(page);
      assert.equal(await page.locator('.company-editor tbody tr').count(), 50);
      await context.close();
    }
    console.log('Company editor browser checks passed: account visibility, all four shells, edits, validation, pagination, conflicts, expired access, and narrow desktop layout.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });

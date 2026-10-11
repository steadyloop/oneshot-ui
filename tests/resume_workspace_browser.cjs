/* Run with Node and @playwright/test installed. All writes use isolated test data. */
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFile, mkdir } = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium, expect } = require(process.env.PLAYWRIGHT_MODULE || '@playwright/test');
const { createVisitorState, handle } = require('../web/shared/guest.js');

const root = path.resolve(__dirname, '..');
const artifacts = process.env.ONESHOT_BROWSER_ARTIFACTS || '/private/tmp/oneshot-resume-browser';
const key = 'oneshot.visitor-data.state.v1';
const copy = value => JSON.parse(JSON.stringify(value));
const seed = createVisitorState();
Object.assign(seed.resume, {
  profile: { full_name: 'Alex Morgan', email: 'alex@example.com', phone: '(206) 555-0142', location: 'Seattle, WA',
    links: [{ label: 'Portfolio', url: 'https://example.com/' }] },
  entries: [
    { id: 1, kind: 'education', org: 'University of Washington', role: 'Computer Science', detail: '3.85 / 4.0',
      location: 'Seattle, WA', start_date: 'Sep 2023', end_date: 'Jun 2027', bullets: [] },
    { id: 2, kind: 'experience', org: 'Northstar Labs', role: 'Software Engineering Intern', location: 'Seattle, WA',
      start_date: 'Jun 2026', end_date: 'Sep 2026', url: 'https://example.com/role', bullets: [
        { id: 21, text: 'Built reusable React components.', audience: 'all' },
        { id: 22, text: 'Reduced dashboard load time.', audience: 'engineering' }] },
  ],
  skills: [{ id: 50, category: 'coursework', name: 'Algorithms', audience: 'all' },
    { id: 60, category: 'language', name: 'Python', audience: 'all' },
    { id: 61, category: 'data', name: 'DuckDB', audience: 'all' }],
  variants: [{ key: 'engineering', label: 'Software engineering' }],
  targetJobs: [{ id: 80, company: 'Test Co', title: 'Intern', url: 'https://example.com/job' }],
  resumes: [90, 91, 92].map((id, index) => ({ id, name: ['Software engineering', 'Frontend engineering', 'Research'][index],
    availability_line: 'Available June – September 2027', updated_at: '2026-10-06T18:30:00Z',
    selection: { entries: [{ entry_id: 2, bullets: [{ bullet_id: 21 }, { bullet_id: 22 }] }], skills: [50, 60] } })),
  nextEntryId: 100, nextBulletId: 200, nextSkillId: 300, nextResumeId: 400,
});
let accountState = copy(seed);
const requests = [];

function pdf(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ONESHOT_PYTHON || path.join(root, '.venv/bin/python'), ['-c',
      'import json,sys; from api.resume.render import build_typst_source,compile_pdf; p=json.load(sys.stdin); pdf,_,error=compile_pdf(build_typst_source(p["profile"],p["resume"],p["entries"],p["skills"])); assert pdf,error; sys.stdout.buffer.write(pdf)'], { cwd: root });
    const output = [], errors = [];
    child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => errors.push(chunk));
    child.on('error', reject); child.on('close', code => code ? reject(Error(Buffer.concat(errors).toString())) : resolve(Buffer.concat(output)));
    child.stdin.end(JSON.stringify(payload));
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://test');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({ path: url.pathname, method: req.method, body: body && JSON.parse(body) });
    const match = url.pathname.match(/^\/api\/resume\/resumes\/(\d+)\/pdf$/);
    if (url.pathname === '/api/resume/render/pdf' || match) {
      const payload = match ? { profile: accountState.resume.profile, resume: accountState.resume.resumes.find(r => r.id === Number(match[1])),
        entries: accountState.resume.entries, skills: accountState.resume.skills } : JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(await pdf(payload)); return;
    }
    if (url.pathname.startsWith('/api/resume/')) {
      const response = await handle(url.pathname.replace(/^\/api/, ''), { method: req.method, body: body || undefined }, accountState);
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(url.pathname === '/api/auth/me' ? 401 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jobs: [], total: 0 })); return;
    }
    const relative = url.pathname.replace(/^\/static/, '') + (url.pathname.endsWith('/') ? 'index.html' : '');
    const file = path.join(root, 'web', relative);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[path.extname(file)] || 'application/octet-stream' });
    res.end(content);
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});

async function saveField(page, label, value) {
  await page.getByRole('button', { name: `Edit ${label}`, exact: true }).click();
  const form = page.locator('.value-editor');
  await form.locator('input').fill(value);
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form).toHaveCount(0);
}

async function main() {
  await mkdir(artifacts, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/Los_Angeles' });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(String(error)));
    await page.goto(origin + '/resume/');
    await expect(page.locator('.profile-document')).toBeVisible();
    await expect(page.locator('.page-actions [data-action=new-resume]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit Name', exact: true })).toHaveText('Add name');
    await saveField(page, 'Name', 'Guest Person');
    await page.reload(); await expect(page.locator('.profile-contact-name')).toHaveText('Guest Person');
    await page.locator('#resumes-tab').click();
    await expect(page.locator('.resume-empty h2, .resume-empty > svg')).toHaveCount(0);
    await expect(page.locator('.resume-empty > p')).toHaveText('Create resume with customized profile');
    assert.equal(await page.locator('.resume-empty button').evaluate(button => getComputedStyle(button).backgroundColor), 'rgb(30, 92, 66)');
    for (const width of [1024, 1440, 2560]) {
      await page.setViewportSize({ width, height: 1000 });
      const centered = await page.locator('.resume-empty').evaluate(section => {
        const text = section.querySelector('p').getBoundingClientRect(), button = section.querySelector('button').getBoundingClientRect();
        const main = document.querySelector('.workspace').getBoundingClientRect();
        const top = document.querySelector('.page-tabs-row').getBoundingClientRect().bottom;
        return { below: text.top >= button.bottom, centerX: (button.left + button.right) / 2,
          centerY: (button.top + text.bottom) / 2, paneX: (main.left + main.right) / 2, paneY: (top + innerHeight) / 2 };
      });
      assert.ok(centered.below, 'Empty-state text is below the button');
      assert.ok(Math.abs(centered.centerX - centered.paneX) < 2, `Empty state centers horizontally at ${width}px`);
      assert.ok(Math.abs(centered.centerY - centered.paneY) < 2, `Empty state centers vertically at ${width}px`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: path.join(artifacts, 'empty-resumes.png') });
    await page.locator('.empty-state [data-action=new-resume]').click();
    await page.locator('#resume-form [name=name]').fill('First resume');
    await page.locator('#resume-form button[type=submit]').click();
    await expect(page.locator('.resume-picker-trigger')).toHaveText('First resume');
    await page.locator('.resume-picker-trigger').click();
    await page.locator('.resume-card').getByRole('button', { name: 'Resume actions' }).click();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('.resume-empty > button + p')).toBeVisible();

    await page.evaluate(([key, seed]) => localStorage.setItem(key, JSON.stringify(seed)), [key, seed]);
    await page.goto(origin + '/resume/'); await expect(page.locator('.profile-contact-name')).toHaveText('Alex Morgan');
    await expect(page.locator('.skill-row').filter({ hasText: 'DuckDB' })).toContainText('Data');
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(artifacts, 'profile.png') });
    await saveField(page, 'Name', 'Alex Updated');
    await page.getByRole('button', { name: 'Edit Python', exact: true }).click();
    await page.locator('.value-editor input').fill('TypeScript');
    await page.locator('.value-editor').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit TypeScript', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Add link', exact: true }).click();
    await page.getByRole('textbox', { name: 'Link label' }).fill('GitHub');
    await page.getByRole('textbox', { name: 'Link URL' }).fill('github.com/alex');
    await page.locator('[data-form=link]').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.profile-links a').filter({ hasText: 'GitHub' })).toHaveAttribute('href', 'https://github.com/alex');
    await page.getByRole('button', { name: 'Add section', exact: true }).click();
    await page.locator('[data-add-section-menu]').getByRole('button', { name: 'Projects', exact: true }).click();
    await page.locator('[data-form=entry] [name=primary]').fill('Trailhead');
    await page.locator('[data-form=entry] [name=secondary]').fill('A trail planner');
    await page.locator('[data-form=entry] button[type=submit]').click();
    await expect(page.locator('.entry-block').filter({ hasText: 'Trailhead' })).toBeVisible();

    await page.locator('#profile-tab').focus(); await page.keyboard.press('ArrowRight');
    await expect(page.locator('#resumes-tab')).toBeFocused();
    await expect(page.locator('.resume-content .contact-summary')).toContainText('Alex Updated');
    await expect(page.locator('.page-actions [data-action=new-resume], .resume-empty')).toHaveCount(0);
    assert.equal(await page.locator('[data-action=export-pdf]').evaluate(button => getComputedStyle(button).backgroundColor), 'rgb(255, 255, 255)');
    assert.equal(await page.locator('.autosave, [data-action=show-profile]').count(), 0);
    await saveField(page, 'Availability', 'Available Summer 2028');
    const gpa = page.locator('[data-action=toggle-detail]');
    await gpa.click(); await expect(gpa).toHaveAttribute('aria-pressed', 'false');
    const skill = page.locator('[data-action=toggle-skill][data-id="60"]');
    await skill.press('Enter'); await expect(skill).toHaveAttribute('aria-pressed', 'false');
    const bullet = page.locator('[data-action=toggle-bullet][data-id="21"]');
    await bullet.getByRole('button', { name: 'Edit bullet', exact: true }).click();
    await bullet.locator('textarea').fill('Tailored for this resume only.');
    await bullet.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(bullet.locator('p')).toHaveText('Tailored for this resume only.');
    const local = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).resume, key);
    assert.equal(local.entries.find(e => e.id === 2).bullets[0].text, 'Built reusable React components.');
    assert.equal(local.resumes.find(r => r.id === 91).availability_line, 'Available June – September 2027');
    // A navigation link inside the selectable header must not toggle the entry.
    const entry = page.locator('[data-action=toggle-entry][data-id="2"]');
    await entry.locator('a').evaluate(link => link.addEventListener('click', e => e.preventDefault()));
    await entry.locator('a').click(); await expect(entry).toHaveAttribute('aria-pressed', 'true');

    for (const width of [768, 900, 1024, 1440, 2560, 5940]) {
      await page.setViewportSize({ width, height: 1000 }); await page.evaluate(() => scrollTo(0, 0));
      const bounds = await page.evaluate(() => {
        const rect = s => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; };
        return { picker: rect('.resume-picker-trigger'), actions: rect('.document-actions'),
          content: rect('.workspace-content'), availability: rect('.resume-availability'), head: rect('.document-head'),
          right: rect('.contact-summary').right, scrollWidth: document.documentElement.scrollWidth, inner: innerWidth };
      });
      assert.equal(bounds.scrollWidth, width, `No horizontal overflow at ${width}px`);
      assert.ok(Math.abs(bounds.picker.y - bounds.actions.y) < 2, `Toolbar stays on one row at ${width}px`);
      assert.ok(bounds.actions.x >= bounds.picker.right, `Toolbar does not overlap at ${width}px`);
      assert.ok(Math.abs(bounds.actions.right - bounds.right) < 2, `Toolbar aligns right at ${width}px`);
      assert.ok(bounds.availability.y >= bounds.head.bottom, 'Availability is below the toolbar divider');
    }
    await page.setViewportSize({ width: 900, height: 1000 });
    await page.screenshot({ path: path.join(artifacts, 'resumes-900.png') });
    await page.locator('.resume-picker-trigger').click();
    const menu = await page.locator('.resume-list').boundingBox(); assert.ok(menu.width <= 280 && menu.height < 220);
    await expect(page.locator('.resume-list-create')).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'resume-picker.png') });
    await page.locator('.resume-card').last().getByRole('button', { name: 'Resume actions' }).click();
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await page.locator('[data-form=rename-resume] input').fill('Research updated');
    await page.locator('[data-form=rename-resume]').getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('.resume-picker-trigger').click();
    await expect(page.locator('.resume-list')).toContainText('Research updated');
    await page.keyboard.press('Escape'); await expect(page.locator('.resume-list')).toBeHidden();
    await page.locator('.resume-picker-trigger').click();
    await page.locator('.resume-card-main').filter({ hasText: 'Frontend engineering' }).click();
    await expect(page.locator('.resume-picker-trigger')).toHaveText('Frontend engineering');
    await page.locator('[data-action=show-pdf]').click();
    await expect(page.locator('.pdf-frame')).toBeVisible();
    await page.locator('[data-resume-template]').selectOption('barlow');
    await expect(page.locator('[data-resume-template]')).toHaveValue('barlow');
    await page.getByLabel('Spacing', { exact: true }).selectOption('compact');
    await expect(page.locator('[data-resume-density]')).toHaveValue('compact');
    await expect(page.locator('.pdf-frame')).toBeVisible();
    await page.reload(); await page.locator('[data-action=show-pdf]').click();
    // Reload selects the first resume; the second resume's design remains stored.
    const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).resume, key);
    assert.equal(stored.resumes.find(r => r.id === 91).selection.template, 'barlow');
    assert.equal(stored.resumes.find(r => r.id === 91).selection.density, 'compact');
    const download = page.waitForEvent('download'); await page.locator('[data-action=export-pdf]').click();
    const file = await download; await file.saveAs(path.join(artifacts, 'guest-export.pdf'));
    assert.ok((await readFile(path.join(artifacts, 'guest-export.pdf'))).subarray(0, 5).equals(Buffer.from('%PDF-')));
    await page.locator('[data-action=show-content]').click();
    await page.locator('.resume-picker-trigger').click();
    await page.locator('.resume-list-create').click();
    await expect(page.locator('.resume-list')).toBeHidden();
    await page.locator('#resume-form [name=name]').fill('All content');
    await page.locator('#resume-form [name=target_job_id]').selectOption('80');
    await page.locator('#resume-form [name=variant]').selectOption('');
    await page.locator('#resume-form button[type=submit]').click();
    await expect(page.locator('.target-line')).toContainText('Test Co');
    const created = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).resume.resumes[0], key);
    assert.ok(created.selection.entries.some(p => p.entry_id === 1));
    assert.ok(created.selection.entries.find(p => p.entry_id === 2).bullets.some(p => p.bullet_id === 22));
    await page.locator('.resume-picker-trigger').click();
    await page.locator('.resume-card').first().getByRole('button', { name: 'Resume actions' }).click();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('[data-resume-count]')).toHaveText('3');
    await page.goto('about:blank');
    await page.goto(origin + '/resume/#target=80');
    await expect(page.locator('.target-line')).toContainText('Test Co');
    await expect(page.locator('#resumes-tab')).toHaveAttribute('aria-selected', 'true');
    await context.close();

    // Signed-in UI requests must use the server API and leave guest data alone.
    const signed = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const accountPage = await signed.newPage(); accountPage.on('pageerror', e => errors.push(String(e)));
    await accountPage.route('**/api/auth/me', route => route.fulfill({ json: { full_name: 'Account Person', email: 'account@example.com' } }));
    await accountPage.addInitScript(([key, seed]) => localStorage.setItem(key, JSON.stringify(seed)), [key, seed]);
    await accountPage.goto(origin + '/resume/'); await expect(accountPage.locator('.profile-contact-name')).toHaveText('Alex Morgan');
    await saveField(accountPage, 'Name', 'Account Updated');
    assert.equal(accountState.resume.profile.full_name, 'Account Updated');
    assert.equal(await accountPage.evaluate(key => JSON.parse(localStorage.getItem(key)).resume.profile.full_name, key), 'Alex Morgan');
    await accountPage.locator('#resumes-tab').click(); await saveField(accountPage, 'Availability', 'Account availability');
    await accountPage.locator('[data-action=show-pdf]').click(); await expect(accountPage.locator('.pdf-frame')).toBeVisible();
    await accountPage.locator('[data-resume-template]').selectOption('barlow'); await expect(accountPage.locator('.pdf-frame')).toBeVisible();
    await accountPage.getByLabel('Spacing', { exact: true }).selectOption('compact');
    await expect(accountPage.locator('.pdf-frame')).toBeVisible();
    assert.equal(accountState.resume.resumes[0].selection.template, 'barlow');
    assert.equal(accountState.resume.resumes[0].selection.density, 'compact');
    await accountPage.setViewportSize({ width: 768, height: 700 });
    assert.ok(await accountPage.locator('.preview-tools').evaluate(el => el.scrollWidth <= el.clientWidth), 'Preview controls fit on narrow desktop');
    await accountPage.setViewportSize({ width: 1440, height: 1000 });
    assert.ok(requests.some(r => r.path === '/api/resume/resumes/90/pdf' && r.method === 'GET'));
    assert.ok(requests.some(r => r.path === '/api/resume/render/pdf' && r.method === 'POST'));
    accountState.resume.resumes.push(...Array.from({ length: 24 }, (_, i) => ({ ...copy(seed.resume.resumes[0]), id: 500 + i, name: `Additional resume ${i + 1}` })));
    await accountPage.reload();
    await accountPage.setViewportSize({ width: 768, height: 700 });
    await accountPage.locator('.resume-picker-trigger').click();
    const footerInBounds = async () => accountPage.locator('.resume-list-create').evaluate(button => {
      const b = button.getBoundingClientRect(), p = button.parentElement.getBoundingClientRect();
      return b.top >= p.top && b.bottom <= p.bottom && b.left >= 0 && b.right <= innerWidth;
    });
    assert.ok(await footerInBounds(), 'New resume stays visible in a long dropdown');
    await accountPage.locator('.resume-list').evaluate(list => { list.scrollTop = list.scrollHeight; });
    assert.ok(await footerInBounds(), 'New resume stays visible after scrolling');
    await accountPage.locator('.resume-list-create').click();
    await expect(accountPage.locator('#resume-dialog')).toBeVisible();
    assert.deepEqual(errors, []);
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await phone.addInitScript(([key, seed]) => localStorage.setItem(key, JSON.stringify(seed)), [key, seed]);
    const p = await phone.newPage();
    p.on('pageerror', e => errors.push(String(e)));
    await p.goto(origin + '/resume/');
    await p.locator('#phone [data-view="resumes"]').click();
    await expect(p.locator('.resume-row')).toHaveCount(3);
    await p.locator('.resume-row').first().click();
    await expect(p.locator('#push.open')).toBeVisible();
    await p.locator('.doc-tabs [data-mode="preview"]').click();
    await expect(p.locator('#pdf-slot .pdf-frame, #pdf-slot a[target="_blank"]')).toBeVisible();
    for (const width of [320, 390, 760]) {
      await p.setViewportSize({ width, height: 844 });
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth), width);
    }
    const phoneDownload = p.waitForEvent('download');
    await p.locator('[data-act="download"]').click();
    const exported = await phoneDownload;
    await exported.saveAs(path.join(artifacts, 'phone-export.pdf'));
    assert.ok((await readFile(path.join(artifacts, 'phone-export.pdf'))).subarray(0, 5).equals(Buffer.from('%PDF-')));
    await phone.close();
    assert.deepEqual(errors, []);
    console.log('PASS: guest and signed-in editing, isolated storage, selection scopes, menu actions, desktop/phone layouts, handoff, and real PDF preview/export.');
    console.log(`Screenshots and PDF: ${artifacts}`);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); server.close(); process.exitCode = 1; });

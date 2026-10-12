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

async function checkProfile(browser, origin, errors) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 700 }, reducedMotion: 'reduce' });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(String(error)));
  const data = copy(seed);
  data.resume.skills.push(
    { id: 51, category: 'coursework', name: 'Probability', audience: 'all' },
    { id: 52, category: 'coursework', name: 'Networked & Distributed Systems', audience: 'all' },
    { id: 62, category: 'data', name: 'BigQuery', audience: 'all' },
    { id: 63, category: 'tool', name: 'AWS', audience: 'all' });
  await page.goto(origin + '/resume/');
  await page.evaluate(([key, data]) => localStorage.setItem(key, JSON.stringify(data)), [key, data]);
  await page.reload(); await expect(page.locator('.profile-contact-name')).toHaveText('Alex Morgan');
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('.section-index a')).toHaveText(['Contact', 'Education', 'Skills', 'Experience']);
  await expect(page.locator('.profile-document .section-toggle, .profile-document .collapsed')).toHaveCount(0);
  await expect(page.locator('.page-actions [data-action=toggle-add-section]')).toHaveCount(0);
  await expect(page.locator('.page-actions [data-resume-import]')).toBeVisible();
  for (const width of [761, 768, 900, 1100, 1101, 1440, 2560]) {
    await page.setViewportSize({ width, height: 700 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `Profile fits at ${width}px`);
    const geometry = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect();
      const labels = [...document.querySelectorAll('.skill-label')];
      const chips = [...document.querySelectorAll('.profile-document .course-item, .profile-document .skill-item')];
      return { gutter: rect('#view').left - rect('.section-sidebar').right,
        labelGap: rect('.skill-list').left - rect('.skill-label').left,
        longLabelHeight: labels[1].getBoundingClientRect().height,
        labelLineHeight: parseFloat(getComputedStyle(labels[1]).lineHeight),
        tags: chips.map(chip => ({ name: chip.querySelector('.value-trigger > span').textContent,
          height: chip.getBoundingClientRect().height, width: chip.getBoundingClientRect().width,
          text: chip.querySelector('.value-trigger > span').getBoundingClientRect().width })) };
    });
    assert.equal(geometry.labelGap, 148);
    assert.ok(geometry.longLabelHeight <= geometry.labelLineHeight + 1, 'Longest category label stays on one line');
    for (const tag of geometry.tags) {
      assert.ok(Math.abs(tag.width - tag.text - 16) < 1, `${tag.name} retains compact width`);
      assert.ok(tag.height <= 26, `${tag.name} stays on one line`);
    }
    if (width > 1100) {
      await expect(page.locator('.section-index')).toBeVisible(); assert.equal(geometry.gutter, 16);
    } else {
      await expect(page.locator('.section-index')).toBeHidden();
      const below = await page.locator('.section-sidebar').evaluate(sidebar => sidebar.getBoundingClientRect().top >= document.querySelector('#view').getBoundingClientRect().bottom);
      assert.ok(below, 'Add section moves below the document');
    }
  }
  await page.setViewportSize({ width: 1440, height: 1600 }); await page.evaluate(() => scrollTo(0, 0));
  await expect(page.locator('.section-index [aria-current=location]')).toHaveText('Contact');
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.locator('.section-index a').filter({ hasText: 'Experience' }).click();
  await expect(page.locator('#section-experience h2')).toBeFocused();
  await expect(page.locator('.section-index [aria-current=location]')).toHaveText('Experience');
  await page.evaluate(() => scrollTo(0, 0));
  await expect(page.locator('.section-index [aria-current=location]')).toHaveText('Contact');

  const course = page.locator('.course-item').first();
  const before = await course.boundingBox(); await course.hover();
  assert.deepEqual(await course.boundingBox(), before, 'Hover toolbar does not move or widen tags');
  await expect(course.locator('.chip-actions button')).toHaveCount(2);
  await course.getByRole('button', { name: 'Rename Algorithms', exact: true }).click();
  await expect(course.locator('form button')).toHaveCount(2);
  await course.locator('input').fill('Discard this'); await course.locator('input').press('Escape');
  await expect(course.getByRole('button', { name: 'Edit Algorithms', exact: true })).toBeFocused();
  await course.getByRole('button', { name: 'Edit Algorithms', exact: true }).click();
  await course.locator('input').fill('Advanced Algorithms'); await course.getByRole('button', { name: 'Save', exact: true }).click();
  await page.reload(); await expect(page.getByRole('button', { name: 'Edit Advanced Algorithms', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit AWS', exact: true }).focus();
  await expect(page.getByRole('button', { name: 'Delete AWS', exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: 'Delete AWS', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit AWS', exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Delete AWS', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit AWS', exact: true })).toHaveCount(0);

  const bullet = page.locator('.profile-document .bullet-row').first();
  await expect(bullet.locator('button')).toHaveCount(2);
  await bullet.getByRole('button', { name: 'Edit bullet', exact: true }).click();
  await expect(bullet.locator('form button')).toHaveCount(2);
  await bullet.locator('textarea').fill('Discard this'); await bullet.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(bullet.getByRole('button', { name: 'Edit bullet', exact: true })).toBeFocused();
  await expect(bullet.locator('p')).toHaveText('Built reusable React components.');
  await bullet.getByRole('button', { name: 'Edit bullet', exact: true }).click();
  await bullet.locator('textarea').fill('Saved profile bullet.'); await bullet.getByRole('button', { name: 'Save', exact: true }).click();
  await page.reload(); await expect(bullet.locator('p')).toHaveText('Saved profile bullet.');
  await bullet.hover(); page.once('dialog', dialog => dialog.accept());
  await bullet.getByRole('button', { name: 'Delete bullet', exact: true }).click();
  await expect(page.locator('.profile-document .bullet-row')).toHaveCount(1);

  await page.getByRole('button', { name: 'Edit Portfolio', exact: true }).click();
  await expect(page.locator('[data-form=link] button')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Delete Portfolio', exact: true })).toBeHidden();
  await page.getByRole('textbox', { name: 'Link label' }).fill('Discard this');
  await page.getByRole('textbox', { name: 'Link label' }).press('Escape');
  await expect(page.getByRole('button', { name: 'Edit Portfolio', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Edit Portfolio', exact: true }).click();
  await page.getByRole('textbox', { name: 'Link label' }).fill('Updated portfolio');
  await page.locator('[data-form=link]').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.profile-links a')).toHaveText('Updated portfolio');
  await page.locator('.link-item').hover(); await page.getByRole('button', { name: 'Delete Updated portfolio', exact: true }).click();
  await expect(page.locator('.profile-links a')).toHaveCount(0);

  await page.getByRole('button', { name: 'Add section', exact: true }).click();
  await page.locator('[data-add-section-menu]').getByRole('button', { name: 'Research', exact: true }).click();
  await expect(page.locator('.section-index a')).toHaveCount(5);
  await page.locator('[data-form=entry]').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.section-index a')).toHaveCount(4);
  await page.getByRole('button', { name: 'Add section', exact: true }).click();
  await page.locator('[data-add-section-menu]').getByRole('button', { name: 'Research', exact: true }).click();
  await page.locator('[data-form=entry] [name=primary]').fill('Researcher');
  await page.locator('[data-form=entry] button[type=submit]').click();
  await expect(page.locator('.section-index a')).toHaveCount(5);
  await page.locator('#section-research [data-action=toggle-entry-menu]').click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#section-research').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.section-index a')).toHaveCount(4);
  await page.locator('#resumes-tab').click();
  await expect(page.locator('.section-sidebar')).toBeHidden();
  await page.getByRole('button', { name: 'Open Software engineering', exact: true }).click();
  await expect(page.locator('.resume-content .section-toggle')).toHaveCount(0);
  await page.locator('#profile-tab').click();
  await expect(page.locator('.profile-document .collapsed, .profile-document .section-toggle')).toHaveCount(0);
  await expect(page.locator('#section-experience .section-body')).toBeVisible();
  await page.locator('#resumes-tab').click();
  await expect(page.locator('.resume-library')).toBeVisible();
  await page.locator('#profile-tab').click(); await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: path.join(artifacts, 'profile-controls.png'), fullPage: true });
  await context.close();

  const touch = await browser.newContext({ viewport: { width: 1024, height: 1000 }, hasTouch: true });
  const tablet = await touch.newPage(); tablet.on('pageerror', error => errors.push(String(error)));
  await tablet.goto(origin + '/resume/');
  await tablet.evaluate(([key, data]) => localStorage.setItem(key, JSON.stringify(data)), [key, data]);
  await tablet.reload(); await tablet.getByRole('button', { name: 'Edit AWS', exact: true }).tap();
  await expect(tablet.locator('.chip-tools-open .chip-actions')).toBeVisible();
  await expect(tablet.locator('.value-editor')).toHaveCount(0);
  await tablet.getByRole('button', { name: 'Rename AWS', exact: true }).tap();
  await expect(tablet.locator('.value-editor button')).toHaveCount(2);
  await tablet.locator('.value-editor').getByRole('button', { name: 'Cancel', exact: true }).tap();
  await expect(tablet.getByRole('button', { name: 'Edit AWS', exact: true })).toBeFocused();
  await touch.close();
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
    await expect(page.locator('.resume-card')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New resume', exact: true })).toHaveCount(1);
    for (const width of [1024, 1440, 2560]) {
      await page.setViewportSize({ width, height: 1000 });
      const alignment = await page.locator('.resume-create-card').evaluate(card => ({
        left: card.getBoundingClientRect().left, expected: document.querySelector('.workspace-content').getBoundingClientRect().left + parseFloat(getComputedStyle(document.querySelector('.workspace-content')).paddingLeft),
        overflow: document.documentElement.scrollWidth > innerWidth }));
      assert.equal(alignment.left, alignment.expected, `Empty gallery is left aligned at ${width}px`);
      assert.equal(alignment.overflow, false);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: path.join(artifacts, 'empty-resumes.png') });
    await page.locator('[data-action=new-resume]').click();
    await page.locator('#resume-form [name=name]').fill('First resume');
    await page.locator('#resume-form button[type=submit]').click();
    await expect(page.getByRole('button', { name: 'Edit Resume name', exact: true })).toHaveText('First resume');
    await page.locator('[data-action=back-to-gallery]').click();
    await page.getByRole('button', { name: 'Actions for First resume', exact: true }).click();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('.resume-card')).toHaveCount(0);
    await expect(page.locator('[data-action=new-resume]')).toHaveCount(1);

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
    await expect(page.locator('.resume-card')).toHaveCount(3);
    await expect(page.locator('.resume-card-target')).toHaveText(['General-purpose resume', 'General-purpose resume', 'General-purpose resume']);
    await expect(page.getByRole('button', { name: 'New resume', exact: true })).toHaveCount(1);
    await page.screenshot({ path: path.join(artifacts, 'resume-gallery.png') });
    await page.getByRole('button', { name: 'Open Software engineering', exact: true }).click();
    await expect(page.locator('.resume-content .contact-summary')).toContainText('Alex Updated');
    await expect(page.locator('[data-action=export-pdf]')).toHaveText('PDF');
    await expect(page.locator('.target-line, .mode-switch, .resume-picker, [data-action=new-resume]')).toHaveCount(0);
    await expect(page.locator('.pdf-frame')).toBeVisible();
    assert.equal(await page.locator('.pdf-frame').evaluate(async frame => {
      const bytes = await (await fetch(frame.src)).arrayBuffer();
      return new TextDecoder().decode(bytes.slice(0,5));
    }), '%PDF-', 'The editor previews a real generated PDF');
    await expect(page.locator('.contact-section .editor-availability')).toContainText('Available June – September 2027');
    await page.getByRole('button', { name: 'Edit Availability', exact: true }).click();
    await page.locator('.value-editor input').fill('Cancelled availability');
    await page.locator('.value-editor').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('.editor-availability')).not.toContainText('Cancelled');
    await saveField(page, 'Availability', '');
    await expect(page.locator('.editor-availability')).toContainText('Add availability');
    await saveField(page, 'Availability', 'Available Summer 2028');
    const gpa = page.locator('[data-action=toggle-detail]');
    await gpa.click(); await expect(gpa).toHaveAttribute('aria-checked', 'false');
    const skill = page.locator('[data-action=toggle-skill][data-id="60"]');
    await skill.press('Enter'); await expect(skill).toHaveAttribute('aria-pressed', 'false');
    assert.equal(await skill.evaluate(el => getComputedStyle(el).opacity), '1', 'Unchecked skills remain readable');
    const bullet = page.locator('.editor-bullet').filter({ has: page.locator('[data-action=toggle-bullet][data-id="21"]') });
    await bullet.getByRole('button', { name: 'Reword for this resume', exact: true }).click();
    await bullet.getByRole('textbox', { name: 'Reword for this resume', exact: true }).fill('Cancelled rewording');
    await bullet.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(bullet.locator('p')).toHaveText('Built reusable React components.');
    await bullet.getByRole('button', { name: 'Reword for this resume', exact: true }).click();
    await bullet.locator('textarea').fill('Customized accomplishment for this resume.');
    await bullet.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(bullet.locator('p')).toHaveText('Customized accomplishment for this resume.');
    await expect(bullet.locator('.reword-status')).toContainText('Reworded');
    let local = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).resume, key);
    assert.equal(local.entries.find(e => e.id === 2).bullets[0].text, 'Built reusable React components.');
    assert.equal(local.resumes.find(r => r.id === 91).availability_line, 'Available June – September 2027');
    assert.equal(local.resumes.find(r => r.id === 91).selection.entries[0].bullets[0].text_override, undefined);
    await bullet.getByRole('button', { name: 'Use original', exact: true }).click();
    await expect(bullet.locator('p')).toHaveText('Built reusable React components.');
    await expect(bullet.locator('.reword-status')).toHaveCount(0);
    await bullet.getByRole('checkbox').press('Space');
    await expect(bullet.getByRole('checkbox')).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('[data-action=toggle-entry][data-id="2"]')).toHaveAttribute('aria-checked', 'mixed');
    assert.equal(await bullet.locator('p').evaluate(p => getComputedStyle(p).color), 'rgb(89, 100, 92)');
    await bullet.getByRole('checkbox').press('Enter');
    // A link beside an entry checkbox must not toggle the entry.
    const entryLink = page.locator('.editor-entry-head a').first();
    await entryLink.evaluate(link => link.addEventListener('click', e => e.preventDefault()));
    await entryLink.click();
    await expect(page.locator('[data-action=toggle-entry][data-id="2"]')).toHaveAttribute('aria-checked', 'true');

    for (const width of [761, 768, 900, 1024, 1440, 2560, 5940]) {
      await page.setViewportSize({ width, height: 1000 }); await page.evaluate(() => scrollTo(0, 0));
      const bounds = await page.evaluate(() => {
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x, y:r.y, right:r.right, bottom:r.bottom }; };
        return { left:rect('.resume-content'), right:rect('.resume-preview'), toolbar:rect('.editor-toolbar'), availability:rect('.editor-availability'), contact:rect('.contact-section'), scrollWidth:document.documentElement.scrollWidth };
      });
      assert.equal(bounds.scrollWidth, width, `No editor overflow at ${width}px`);
      assert.ok(bounds.right.x >= bounds.left.right, `PDF stays beside content at ${width}px`);
      assert.ok(bounds.availability.bottom <= bounds.contact.bottom, 'Availability belongs inside Contact');
    }
    await page.setViewportSize({ width:1440,height:1000 });
    await page.screenshot({ path:path.join(artifacts,'resume-editor.png') });
    await saveField(page, 'Resume name', 'Software engineering updated');
    await page.locator('[data-action=back-to-gallery]').click();
    await page.getByRole('button', { name:'Actions for Research',exact:true }).click();
    await page.getByRole('button', { name:'Rename',exact:true }).click();
    await page.locator('[data-form=rename-resume] input').fill('Research updated');
    await page.locator('[data-form=rename-resume]').getByRole('button', { name:'Save',exact:true }).click();
    await expect(page.locator('.resume-card-name').filter({ hasText:'Research updated' })).toBeVisible();
    await page.getByRole('button', { name:'Open Frontend engineering',exact:true }).click();
    await page.locator('[data-resume-template]').selectOption('barlow');
    await page.getByLabel('Spacing', { exact:true }).selectOption('compact');
    await expect(page.locator('.pdf-frame')).toBeVisible();
    const guestDownload = page.waitForEvent('download');
    await page.locator('[data-action=export-pdf]').click();
    await (await guestDownload).saveAs(path.join(artifacts,'guest-export.pdf'));
    assert.ok((await readFile(path.join(artifacts,'guest-export.pdf'))).subarray(0,5).equals(Buffer.from('%PDF-')));
    await page.locator('[data-action=back-to-gallery]').click();
    await page.getByRole('button', { name:'Actions for Frontend engineering',exact:true }).click();
    await page.getByRole('button', { name:'Duplicate',exact:true }).click();
    await expect(page.locator('.resume-card')).toHaveCount(4);
    local = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).resume,key);
    const copied = local.resumes.find(r=>r.name==='Frontend engineering copy');
    const original = local.resumes.find(r=>r.id===91);
    assert.deepEqual(copied.selection,original.selection);
    assert.equal(copied.availability_line,original.availability_line);
    await page.getByRole('button', { name:'Open Frontend engineering copy',exact:true }).click();
    await saveField(page,'Availability','Copy only');
    local = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).resume,key);
    assert.equal(local.resumes.find(r=>r.id===91).availability_line,original.availability_line);
    await page.reload();
    await expect(page.locator('.resume-library')).toBeVisible();
    await page.getByRole('button', { name:'Open Frontend engineering copy',exact:true }).click();
    await expect(page.locator('[data-resume-template]')).toHaveValue('barlow');
    await expect(page.locator('[data-resume-density]')).toHaveValue('compact');
    await expect(page.locator('.editor-availability')).toContainText('Copy only');
    await page.locator('[data-action=back-to-gallery]').click();
    await page.getByRole('button', { name:'Actions for Frontend engineering copy',exact:true }).click();
    page.once('dialog',dialog=>dialog.accept());
    await page.getByRole('button', { name:'Delete',exact:true }).click();
    await expect(page.locator('[data-resume-count]')).toHaveText('3');
    await page.locator('[data-action=new-resume]').click();
    await page.locator('#resume-form [name=name]').fill('All content');
    await page.locator('#resume-form [name=target_job_id]').selectOption('80');
    await page.locator('#resume-form [name=variant]').selectOption('');
    await page.locator('#resume-form button[type=submit]').click();
    await expect(page.locator('.resume-editor')).toBeVisible();
    await expect(page.locator('.target-line')).toHaveCount(0);
    const created = await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).resume.resumes[0],key);
    assert.equal(created.target_job_id,80);
    assert.ok(created.selection.entries.some(p=>p.entry_id===1));
    assert.ok(created.selection.entries.find(p=>p.entry_id===2).bullets.some(p=>p.bullet_id===22));
    await page.locator('[data-action=back-to-gallery]').click();
    await expect(page.locator('.resume-card').filter({ hasText:'All content' })).toContainText('Test Co · Intern');
    const galleryDownload = page.waitForEvent('download');
    await page.getByRole('button', { name:'Actions for All content',exact:true }).click();
    await page.getByRole('button', { name:'PDF',exact:true }).click();
    await (await galleryDownload).saveAs(path.join(artifacts,'gallery-export.pdf'));
    await page.goto('about:blank'); await page.goto(origin+'/resume/#target=80');
    await expect(page.locator('.resume-editor')).toBeVisible();
    await expect(page.getByRole('button', { name:'Edit Resume name',exact:true })).toHaveText('All content');
    await expect(page.locator('#resumes-tab')).toHaveAttribute('aria-selected','true');
    await page.locator('[data-action=show-profile]').click();
    await expect(page.locator('.profile-document')).toBeVisible();
    await context.close();

    // Signed-in UI requests must use the server API and leave guest data alone.
    const signed = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const accountPage = await signed.newPage(); accountPage.on('pageerror', e => errors.push(String(e)));
    await accountPage.route('**/api/auth/me', route => route.fulfill({ json: { full_name: 'Account Person', email: 'account@example.com' } }));
    await accountPage.addInitScript(([key, seed]) => { if (window === window.top) localStorage.setItem(key, JSON.stringify(seed)); }, [key, seed]);
    await accountPage.goto(origin + '/resume/'); await expect(accountPage.locator('.profile-contact-name')).toHaveText('Alex Morgan');
    await accountPage.route('**/api/resume/profile', route => route.fulfill({ status: 503, json: { detail: 'Save failed' } }));
    await accountPage.getByRole('button', { name: 'Edit Name', exact: true }).click();
    await accountPage.locator('.value-editor input').fill('Unsaved name');
    await accountPage.locator('.value-editor').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(accountPage.locator('#toast')).toContainText('Save failed');
    await expect(accountPage.getByRole('button', { name: 'Edit Name', exact: true })).toBeFocused();
    assert.equal(accountState.resume.profile.full_name, 'Alex Morgan');
    await accountPage.unroute('**/api/resume/profile');
    await saveField(accountPage, 'Name', 'Account Updated');
    assert.equal(accountState.resume.profile.full_name, 'Account Updated');
    assert.equal(await accountPage.evaluate(key => JSON.parse(localStorage.getItem(key)).resume.profile.full_name, key), 'Alex Morgan');
    await accountPage.locator('#resumes-tab').click();
    await accountPage.getByRole('button',{name:'Open Software engineering',exact:true}).click();
    await saveField(accountPage,'Availability','Account availability');
    await expect(accountPage.locator('.pdf-frame')).toBeVisible();
    let failSave;
    await accountPage.route('**/api/resume/resumes/90',async route=>{
      if(route.request().method()!=='PATCH')return route.continue();
      await new Promise(resolve=>{failSave=resolve;});
      await route.fulfill({status:503,json:{detail:'Resume save failed'}});
    });
    await accountPage.getByRole('button',{name:'Edit Availability',exact:true}).click();
    await accountPage.locator('.value-editor input').fill('Unsaved availability');
    await accountPage.locator('.value-editor').getByRole('button',{name:'Save',exact:true}).click();
    await expect(accountPage.locator('.save-indicator')).toHaveText('Saving…');
    await expect.poll(()=>Boolean(failSave)).toBe(true); failSave();
    await expect(accountPage.locator('.save-indicator')).toHaveText('Not saved');
    await expect(accountPage.locator('.editor-availability')).toContainText('Account availability');
    assert.equal(accountState.resume.resumes[0].availability_line,'Account availability');
    await accountPage.unroute('**/api/resume/resumes/90');
    await saveField(accountPage,'Availability','Account availability recovered');
    await expect(accountPage.locator('.save-indicator')).toHaveText('Saved');
    await accountPage.locator('[data-resume-template]').selectOption('barlow');
    await accountPage.getByLabel('Spacing',{exact:true}).selectOption('compact');
    await expect(accountPage.locator('.pdf-frame')).toBeVisible();
    assert.equal(accountState.resume.resumes[0].selection.template,'barlow');
    assert.equal(accountState.resume.resumes[0].selection.density,'compact');
    const accountBullet=accountPage.locator('.editor-bullet').first();
    await accountBullet.getByRole('button',{name:'Reword for this resume',exact:true}).click();
    await accountBullet.locator('textarea').fill('Account-only accomplishment.');
    await accountBullet.getByRole('button',{name:'Save',exact:true}).click();
    await expect(accountBullet.locator('p')).toHaveText('Account-only accomplishment.');
    assert.equal(accountState.resume.entries[1].bullets[0].text,'Built reusable React components.');
    assert.equal(accountState.resume.resumes[1].selection.entries[0].bullets[0].text_override,undefined);
    await accountBullet.getByRole('button',{name:'Use original',exact:true}).click();
    await expect(accountBullet.locator('p')).toHaveText('Built reusable React components.');
    await accountPage.route('**/api/resume/resumes/90/pdf',route=>route.fulfill({status:503,json:{detail:'Preview temporarily unavailable'}}));
    await accountPage.locator('[data-resume-template]').selectOption('main');
    await expect(accountPage.locator('.pdf-loading')).toContainText('Preview temporarily unavailable');
    await accountPage.unroute('**/api/resume/resumes/90/pdf');
    await accountPage.getByRole('button',{name:'Retry',exact:true}).click();
    await expect(accountPage.locator('.pdf-frame')).toBeVisible();
    let finishSave;
    await accountPage.route('**/api/resume/resumes/90',async route=>{
      if(route.request().method()!=='PATCH')return route.continue();
      await new Promise(resolve=>{finishSave=resolve;});
      await route.continue();
    });
    await accountPage.locator('[data-action=toggle-detail]').click();
    await expect(accountPage.locator('.save-indicator')).toHaveText('Saving…');
    await accountPage.locator('#profile-tab').click();
    await expect.poll(()=>Boolean(finishSave)).toBe(true); finishSave();
    await expect.poll(()=>accountState.resume.resumes[0].selection.entries.find(p=>p.entry_id===1)?.show_detail).toBe(false);
    await expect(accountPage.locator('.profile-document')).toBeVisible();
    await expect(accountPage.locator('.resume-editor')).toHaveCount(0);
    await accountPage.unroute('**/api/resume/resumes/90');
    await accountPage.locator('#resumes-tab').click();
    await accountPage.getByRole('button',{name:'Open Software engineering',exact:true}).click();
    assert.equal(await accountPage.evaluate(key=>JSON.parse(localStorage.getItem(key)).resume.resumes[0].availability_line,key),seed.resume.resumes[0].availability_line);
    const signedDownload=accountPage.waitForEvent('download');
    await accountPage.locator('[data-action=export-pdf]').click();
    await (await signedDownload).saveAs(path.join(artifacts,'account-export.pdf'));
    assert.ok((await readFile(path.join(artifacts,'account-export.pdf'))).subarray(0,5).equals(Buffer.from('%PDF-')));
    await accountPage.setViewportSize({width:768,height:700});
    assert.ok(await accountPage.locator('.preview-tools').evaluate(el=>el.scrollWidth<=el.clientWidth),'Preview controls fit narrow desktop');
    assert.ok(requests.some(r=>r.path==='/api/resume/resumes/90/pdf'&&r.method==='GET'));
    assert.ok(requests.some(r=>r.path==='/api/resume/render/pdf'&&r.method==='POST'));
    accountState.resume.resumes.push(...Array.from({length:24},(_,i)=>({...copy(seed.resume.resumes[0]),id:500+i,name:`Additional resume ${i+1}`})));
    await accountPage.reload();
    await expect(accountPage.locator('.resume-card')).toHaveCount(27);
    await expect(accountPage.locator('[data-action=new-resume]')).toHaveCount(1);
    await accountPage.locator('[data-action=new-resume]').click();
    await expect(accountPage.locator('#resume-dialog')).toBeVisible();
    assert.deepEqual(errors, []);
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await phone.addInitScript(([key, seed]) => { if (window === window.top) localStorage.setItem(key, JSON.stringify(seed)); }, [key, seed]);
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
    await checkProfile(browser, origin, errors);
    assert.deepEqual(errors, []);
    console.log('PASS: Profile cards/navigation, compact tags, idle/editing controls, touch actions, persistence/error recovery, guest/account isolation, resume gallery/editor, phone layouts, job handoff, and real PDF preview/export.');
    console.log(`Screenshots and PDF: ${artifacts}`);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); server.close(); process.exitCode = 1; });

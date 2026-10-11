/* Run with PLAYWRIGHT_MODULE pointing to @playwright/test if not installed locally. */
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFile, mkdir } = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { chromium, expect } = require(process.env.PLAYWRIGHT_MODULE || '@playwright/test');
const { createVisitorState, handle } = require('../web/shared/guest.js');
const root = path.resolve(__dirname, '..');
const artifacts = process.env.ONESHOT_BROWSER_ARTIFACTS || '/private/tmp/oneshot-import-browser';
let signedIn = false, state, failBullet = false;
const calls = [];
const sample = 'Alex Morgan\nalex@example.com\nExperience\nCompany: Example Co\nRole: Software Engineer\nJan 2024 - Present\n• Built useful tools.\n• Improved latency.\nSkills\nLanguages: Python\nAwards\nAward for service';
function parse(bytes, type) {
  return new Promise((resolve, reject) => {
    const p = spawn(path.join(root, '.venv/bin/python'), ['-c', 'import sys; from api.resume.parser import parse_text,parse_document; data=sys.stdin.buffer.read(); r=parse_text(data.decode()) if sys.argv[1]=="text" else parse_document(data,sys.argv[1]); print(r.model_dump_json())', type], { cwd: root });
    const output = [], errors = [];
    p.stdout.on('data', b => output.push(b)); p.stderr.on('data', b => errors.push(b));
    p.on('error', reject); p.on('close', code => code ? reject(Error(Buffer.concat(errors).toString())) : resolve(Buffer.concat(output)));
    p.stdin.end(bytes);
  });
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://test');
    const chunks = []; for await (const b of req) chunks.push(b); const body = Buffer.concat(chunks);
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/auth/me') { res.statusCode = signedIn ? 200 : 401; return json(signedIn ? { id: 'test', email: 'test@example.com', name: 'Test' } : {}); }
    if (url.pathname === '/api/resume/parse') {
      try { res.setHeader('Content-Type', 'application/json'); res.end(await parse(body, url.searchParams.get('file_type'))); }
      catch { res.statusCode = 422; json({ error: { code: 'malformed', message: 'The PDF could not be read. Try pasting its text.' } }); }
      return;
    }
    if (url.pathname.startsWith('/api/resume/')) {
      calls.push({ path: url.pathname, method: req.method });
      if (failBullet && url.pathname.endsWith('/bullets')) { failBullet = false; res.statusCode = 500; return json({ detail: 'Test interrupted save' }); }
      const response = await handle(url.pathname.replace(/^\/api/, ''), { method: req.method, body: body.length ? body.toString() : undefined }, state);
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    if (url.pathname.startsWith('/api/')) return json({ jobs: [], total: 0 });
    const relative = url.pathname.replace(/^\/static/, '') + (url.pathname.endsWith('/') ? 'index.html' : '');
    const file = path.resolve(root, 'web', '.' + relative);
    if (!file.startsWith(path.join(root, 'web') + path.sep)) { res.statusCode = 403; res.end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[path.extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch (e) { res.statusCode = 500; res.end(String(e)); }
});
async function main() {
  await mkdir(artifacts, { recursive: true });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const fixtures = JSON.parse(execFileSync(path.join(root, '.venv/bin/python'), ['-c',
    'import base64,json; from io import BytesIO; from docx import Document; from api.resume.render import compile_pdf; d=Document(); d.add_paragraph("Alex Morgan"); d.add_paragraph("alex@example.com"); b=BytesIO(); d.save(b); pdf,_,error=compile_pdf("Alex Morgan\\n\\nalex@example.com".replace("@",chr(92)+"@")); assert not error,error; print(json.dumps({"docx":base64.b64encode(b.getvalue()).decode(),"pdf":base64.b64encode(pdf).decode()}))'], { cwd: root }));
  const errors = [];
  try {
    for (const phone of [false, true]) for (const account of [false, true]) {
      signedIn = account; state = createVisitorState(); state.resume.profile.full_name = 'Existing Name';
      const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: phone, hasTouch: phone });
      if (!account) await context.addInitScript(seed => localStorage.setItem('oneshot.visitor-data.state.v1', JSON.stringify(seed)), state);
      const page = await context.newPage(); page.on('pageerror', e => errors.push(String(e)));
      await page.goto(`http://127.0.0.1:${server.address().port}/resume/`);
      const trigger = page.locator('[data-resume-import]'); await expect(trigger).toBeVisible();
      await trigger.click(); const dialog = page.locator('.resume-import-dialog'); await expect(dialog).toBeVisible();
      await expect(dialog.getByText('Your document is sent to the server', { exact: false })).toHaveCount(account ? 0 : 1);
      await page.screenshot({ path: path.join(artifacts, `${phone ? 'phone' : 'desktop'}-${account ? 'account' : 'guest'}-upload.png`) });
      await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
      await trigger.click();
      if (!phone && !account) {
        await dialog.locator('input[type=file]').setInputFiles({ name: 'resume.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(fixtures.docx, 'base64') });
        await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
        await expect(dialog.locator('[data-import-field="profile.email.value"]')).toHaveValue('alex@example.com');
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await trigger.click();
        const pdfDrop = await page.evaluateHandle(base64 => {
          const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0)); const data = new DataTransfer();
          data.items.add(new File([bytes], 'resume.pdf', { type: 'application/pdf' })); return data;
        }, fixtures.pdf);
        await dialog.locator('.ri-drop').dispatchEvent('drop', { dataTransfer: pdfDrop });
        await expect(dialog.locator('.ri-filename')).toHaveText('resume.pdf');
        await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
        await expect(dialog.locator('[data-import-field="profile.email.value"]')).toHaveValue('alex@example.com');
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await trigger.click();
      }
      await dialog.locator('input[type=file]').setInputFiles({ name: 'bad.pdf', mimeType: 'application/pdf', buffer: Buffer.from('bad') });
      await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(dialog.locator('.ri-status')).toContainText('could not be read');
      // Exercise drop and the same file selection path with an unsupported file.
      const transfer = await page.evaluateHandle(() => { const d = new DataTransfer(); d.items.add(new File(['x'], 'bad.txt', { type: 'text/plain' })); return d; });
      await dialog.locator('.ri-drop').dispatchEvent('drop', { dataTransfer: transfer });
      await expect(dialog.locator('.ri-status')).toContainText('Choose a PDF or DOCX');
      await dialog.getByRole('button', { name: 'Paste resume text instead' }).click();
      await dialog.locator('[data-pasted]').fill(sample);
      await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(dialog.getByRole('heading', { name: 'Review your resume' })).toBeVisible();
      await expect(dialog.locator('[data-import-field="entries.0.org"]')).toHaveValue('Example Co');
      await expect(dialog.locator('details').last()).toContainText('Award for service');
      const download = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'Download draft with original content' }).click();
      const draft = await download; await draft.saveAs(path.join(artifacts, 'draft.json'));
      assert.match(await readFile(path.join(artifacts, 'draft.json'), 'utf8'), /Award for service/);
      await dialog.locator('[data-import-field="entries.0.org"]').fill('');
      await dialog.getByRole('button', { name: 'Apply to profile' }).click();
      await expect(dialog.locator('.ri-status')).toContainText('needs an organization');
      await dialog.locator('[data-import-field="entries.0.org"]').fill('Example Co');
      await dialog.locator('[data-import-field="entries.0.bullets.1.selected"]').uncheck();
      await page.screenshot({ path: path.join(artifacts, `${phone ? 'phone' : 'desktop'}-review.png`) });
      if (account) failBullet = true;
      await dialog.getByRole('button', { name: 'Apply to profile' }).click();
      if (account) {
        await expect(dialog.locator('.ri-status')).toContainText('Test interrupted save');
        assert.equal(state.resume.entries.length, 1);
        await dialog.getByRole('button', { name: 'Apply to profile' }).click();
      }
      await expect(dialog).toHaveCount(0);
      const saved = account ? state : await page.evaluate(() => JSON.parse(localStorage.getItem('oneshot.visitor-data.state.v1')));
      assert.equal(saved.resume.profile.full_name, 'Existing Name');
      assert.equal(saved.resume.profile.email, 'alex@example.com');
      assert.equal(saved.resume.entries.length, 1); assert.equal(saved.resume.entries[0].bullets.length, 1);
      assert.equal(saved.resume.skills.length, 1);
      // Re-import the same document to check duplicate preservation through UI.
      await trigger.click(); await dialog.getByRole('button', { name: 'Paste resume text instead' }).click();
      await dialog.locator('[data-pasted]').fill(sample); await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(dialog.locator('[data-import-field="entries.0.org"]')).toBeVisible();
      await dialog.locator('[data-import-field="entries.0.bullets.1.selected"]').uncheck();
      await dialog.getByRole('button', { name: 'Apply to profile' }).click(); await expect(dialog).toHaveCount(0);
      const again = account ? state : await page.evaluate(() => JSON.parse(localStorage.getItem('oneshot.visitor-data.state.v1')));
      assert.equal(again.resume.entries.length, 1); assert.equal(again.resume.skills.length, 1);
      await context.close();
    }
    assert.deepEqual(errors, []);
    console.log('Desktop and phone, account and guest import flows passed.');
  } finally { await browser.close(); server.close(); }
}
main().catch(e => { console.error(e); server.close(); process.exitCode = 1; });

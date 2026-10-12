const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fromAPI, toAPI, age, validDay, viewFor, taskGroup, initialFilters, visibleApplications } = require('../../web/applied/core.js');

test('real API records round-trip without changing IDs, dates or discovered snapshots', () => {
  const app = fromAPI({ id: 42, external: false, job_id: 19, company: 'Halcyon', title: 'Intern', stage: 'applied', submitted_at: '2026-09-28T00:00:00+00:00', next_due_at: '2026-10-06T23:59:59+00:00', task_state: 'waiting', resume_variant: 'SWE.pdf', last_open_stage: 'applied' });
  assert.equal(app.id, '42'); assert.equal(app.stage, 'sent'); assert.equal(app.submittedAt, '2026-09-28');
  assert.equal(viewFor(app.stage), 'sent'); assert.equal(taskGroup(app), 'waiting');
  const body = toAPI(app);
  assert.equal(body.stage, 'applied'); assert.equal(body.submitted_at, '2026-09-28');
  assert.equal(body.next_due_at, '2026-10-06'); assert.equal(body.resume_variant, 'SWE.pdf');
  assert.equal(Object.hasOwn(body, 'company'), false); assert.equal(Object.hasOwn(body, 'title'), false);
});

test('company metadata is display-only and accepts only stored logo paths', () => {
  const app = fromAPI({ id: 42, job_id: 19, company: 'Acme', company_id: 9, logo: '/api/companies/9/logo' });
  assert.equal(app.companyId, 9); assert.equal(app.logo, '/api/companies/9/logo');
  assert.equal(Object.hasOwn(toAPI(app), 'company_id'), false);
  assert.equal(Object.hasOwn(toAPI(app), 'logo'), false);
  assert.equal(fromAPI({ id: 43, logo: 'https://example.com/logo.png' }).logo, '');
  assert.equal(fromAPI({ id: 44 }).companyId, null);
});

test('legacy unknown submission dates stay unknown and cannot match age filters', () => {
  const app = fromAPI({ id: 'legacy', external: true, company: 'Legacy', title: 'Intern', stage: 'considering', submitted_at: null });
  assert.equal(app.stage, 'sent'); assert.equal(age(app), null); assert.equal(toAPI(app).submitted_at, null);
  for (const band of ['7', '30']) {
    assert.equal(visibleApplications([app], 'sent', { age: band }).length, 0);
  }
  assert.equal(visibleApplications([app], 'sent', { age: 'all' }).length, 1);
});

test('search covers the task and company context without changing stored counts', () => {
  const applications = [
    fromAPI({ id: 1, stage: 'replied', company: 'Halcyon', title: 'Intern', next_action: 'Send availability' }),
    fromAPI({ id: 2, stage: 'interview', company: 'Arbor', title: 'Intern', waiting_for: 'Recruiter feedback', task_state: 'waiting' }),
    fromAPI({ id: 3, stage: 'applied', company: 'Arbor', title: 'Intern' }),
  ];
  const filters = initialFilters().pipeline;
  for (const [query, id] of [['availability', '1'], ['feedback', '2']]) {
    assert.deepEqual(visibleApplications(applications, 'pipeline', { ...filters, query }).map(a => a.id), [id]);
  }
  assert.equal(applications.length, 3);
});

test('the live tracker omits demo controls and retired stage labels', () => {
  const html = fs.readFileSync(require.resolve('../../web/applied/index.html'), 'utf8');
  assert.doesNotMatch(html, /reset-dialog|Demo profile|>Considering<|>Pipeline</);
});

test('date validation rejects rollover dates', () => {
  assert.equal(validDay('2026-02-30'), false); assert.equal(validDay('2028-02-29'), true);
});

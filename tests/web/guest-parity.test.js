const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createVisitorState, handle } = require('../../web/shared/guest.js');

const commands = [
  ['/jobs/1/applications', 'POST', { submitted_at: '2026-10-10' }], ['/jobs/1/applications', 'POST', {}],
  ['/applications/external', 'POST', { company: ' Test ', title: 'Intern', note: 'Referral', url: 'https://example.com' }],
  ['/applications/visitor-app-2', 'PATCH', { stage: 'closed', closed_reason: 'no_reply' }],
  ['/applications/visitor-app-1', 'PATCH', { company: 'Changed', note: 'Must not save' }],
  ['/resume/profile', 'PUT', { full_name: 'Alex Morgan', email: null, ignored: 'private' }],
  ['/resume/variants', 'PUT', { variants: [{ key: 'Engineering', label: 'Software' }] }],
  ['/resume/entries', 'POST', { kind: 'experience', org: 'Test Co', role: 'Intern' }],
  ['/resume/entries', 'POST', { kind: 'education', org: 'Test University' }],
  ['/resume/entries/1/bullets', 'POST', { text: 'Built software', audience: 'engineering' }],
  ['/resume/entries/2/bullets', 'POST', { text: 'Second entry' }],
  ['/resume/bullets/2', 'PATCH', { text: 'Edited', position: 0, tags: ['test'], ignored: 'private' }],
  ['/resume/entries/1', 'PATCH', { org: 'Updated', detail: null, position: 4, id: 99 }],
  ['/resume/skills', 'POST', { category: 'language', name: 'Python' }],
  ['/resume/skills', 'POST', { category: 'language', name: 'python' }],
  ['/resume/skills', 'POST', { category: 'language', name: 'SQL' }],
  ['/resume/skills/2', 'PATCH', { name: 'Python', audience: 'engineering' }],
  ['/resume/skills/2', 'PATCH', { name: 'TypeScript', audience: 'engineering' }],
  ['/resume/variants', 'PUT', { variants: [] }],
  ['/resume/resumes', 'POST', { name: 'Engineering', selection: { entries: [{ entry_id: 1, bullets: [{ bullet_id: 1, text_override: 'Custom' }] }], skills: [1] } }],
  ['/resume/resumes/1', 'PATCH', { name: 'Custom', availability_line: 'Summer', target_job_id: 7 }],
  ['/resume/resumes/1', 'GET'], ['/resume/entries', 'GET'], ['/applications', 'GET'],
  ['/resume/bullets/2', 'DELETE'], ['/resume/entries/2', 'DELETE'], ['/resume/skills/2', 'DELETE'], ['/resume/resumes/1', 'DELETE'],
  ...['entries', 'bullets', 'skills', 'resumes'].flatMap(resource => ['PATCH', 'DELETE'].map(method => [`/resume/${resource}/999`, method, {}])),
  ['/resume/resumes/1', 'GET'], ['/resume/entries/1', 'GET'],
];

test('guest resume editing preserves ownership, whitelists and rejection atomicity', async () => {
  const state = createVisitorState(); state.jobs = [{ id: 1, company: 'Example', title: 'Intern' }];
  for (const [url, method, data] of commands) {
    const before = structuredClone(state);
    const response = await handle(url, { method, body: data && JSON.stringify(data) }, state);
    if (response.status >= 400) assert.deepEqual(state, before, `${method} ${url} cannot partly mutate data`);
  }
  assert.deepEqual(state.resume.entries.map(entry => entry.id), [1]);
  assert.deepEqual(state.resume.entries[0].bullets.map(bullet => bullet.id), [1]);
  assert.equal(state.resume.entries[0].org, 'Updated'); assert.equal(state.resume.entries[0].detail, null);
  assert.equal(state.resume.entries[0].id, 1); assert.equal(state.resume.profile.ignored, undefined);
  assert.deepEqual(state.resume.skills.map(skill => skill.name), ['Python']); assert.deepEqual(state.resume.resumes, []);
});

test('guest responses and stored records match the saved implementation', { skip: !process.env.ONESHOT_BASELINE_WEB }, async () => {
  const old = require(path.join(process.env.ONESHOT_BASELINE_WEB, 'shared/guest.js'));
  const RealDate = Date;
  global.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2026-10-11T12:00:00Z'])); } static now() { return new RealDate('2026-10-11T12:00:00Z').getTime(); } };
  try {
    const state = createVisitorState(); state.jobs = [{ id: 1, company: 'Example', title: 'Intern' }];
    const previous = structuredClone(state);
    for (const [url, method, data] of commands) {
      const options = { method, body: data && JSON.stringify(data) };
      const [actual, expected] = await Promise.all([handle(url, options, state), old.handle(url, options, previous)]);
      assert.equal(actual.status, expected.status, `${method} ${url}`);
      assert.deepEqual(actual.status === 204 ? null : await actual.json(), expected.status === 204 ? null : await expected.json(), `${method} ${url}`);
      assert.deepEqual(state, previous, `Stored records after ${method} ${url}`);
    }
  } finally { global.Date = RealDate; }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyReview, duplicateEntry, possibleDuplicate, reviewDraft, validateReview } = require('../../web/resume/import-model.js');
const draft = () => ({ profile: { full_name: 'New Name', email: 'new@example.com', phone: '123', location: '', links: [{ label: 'Site', url: 'https://example.com' }] }, entries: [{ kind: 'experience', org: 'Example', role: 'Engineer', bullets: [{ text: 'First bullet' }, { text: 'Second bullet' }] }], skills: [{ category: 'language', name: 'Python' }] });
const workspace = () => ({ profile: { full_name: 'Existing Name', email: '', links: [{ label: 'Existing', url: 'https://example.com' }] }, entries: [], skills: [] });
test('validation preserves long content and requires organization and skill category', () => {
  const r = reviewDraft(draft()); r.entries[0].org = ''; r.entries[0].bullets[0].text = 'x'.repeat(601); r.skills[0].category = null;
  assert.equal(validateReview(r).length, 3);
  assert.equal(r.entries[0].bullets[0].text.length, 601);
  r.entries[0].selected = false; r.skills[0].selected = false;
  assert.deepEqual(validateReview(r), []);
});
test('fills blanks, keeps contact values and skips duplicate links and skills', async () => {
  const w = workspace(); w.skills = [{ category: 'language', name: 'Python' }];
  const calls = [];
  const api = { saveProfile: async p => calls.push(p), addEntry: async () => ({ id: 1 }), addBullet: async () => {}, addSkill: async () => assert.fail('duplicate skill') };
  await applyReview(reviewDraft(draft()), w, api);
  assert.deepEqual(calls, [{ email: 'new@example.com', phone: '123' }]);
  assert.equal(w.profile.full_name, 'Existing Name');
  assert.equal(w.profile.links.length, 1);
});
test('exact duplicate uses all header fields and selected bullet content', () => {
  const r = reviewDraft(draft()); const e = r.entries[0];
  assert.equal(duplicateEntry(e, draft().entries), true);
  e.role = 'Intern';
  assert.equal(duplicateEntry(e, draft().entries), false);
  assert.equal(possibleDuplicate(e, draft().entries), true);
});
test('retry after partial save creates no duplicate entry or confirmed bullet', async () => {
  const r = reviewDraft(draft()); const w = workspace(); let creates = 0, attempts = 0; const bullets = [];
  const api = { saveProfile: async () => {}, addEntry: async () => ({ id: ++creates }), addBullet: async (_, text) => {
    attempts++; if (attempts === 2) throw new Error('offline'); bullets.push(text);
  }, addSkill: async (category, name) => ({ category, name }) };
  await assert.rejects(applyReview(r, w, api), /offline/);
  assert.equal(r.entries[0].savedId, 1);
  await applyReview(r, w, api);
  assert.equal(creates, 1); assert.deepEqual(bullets, ['First bullet', 'Second bullet']);
  assert.equal(w.skills.length, 1);
});
test('unselected fields and bullets are excluded and duplicates in a draft are skipped', async () => {
  const d = draft(); d.entries.push(structuredClone(d.entries[0]));
  const r = reviewDraft(d); r.profile.email.selected = false;
  let created = 0; const api = { saveProfile: async p => assert.equal(p.email, undefined), addEntry: async () => ({ id: ++created }), addBullet: async () => {}, addSkill: async (category, name) => ({ category, name }) };
  await applyReview(r, workspace(), api); assert.equal(created, 1);
});

test('invalid entry section is rejected before any saves', async () => {
  const r = reviewDraft(draft()); r.entries[0].kind = '';
  await assert.rejects(applyReview(r, workspace(), { saveProfile: async () => assert.fail('must validate first') }), /Choose a section/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFeedLoader } = require('../../web/discover/core.js');
const { createApplicationActions, fromAPI, closeNoReply } = require('../../web/applied/core.js');
const { resolveHandoff } = require('../../web/resume/core.js');

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const payload = id => ({ jobs: [{ id }], total: 42, job_type_counts: { intern: 37, coop: 5 } });

test('Discover ignores stale filter responses and cannot unlock a newer request', async () => {
  const state = { jobs: null }, requests = [], settled = [];
  let query = 'old';
  const feed = createFeedLoader(state, () => ({ query }), { settled: () => settled.push(query) }, filters => {
    const request = deferred(); requests.push({ ...request, filters }); return request.promise;
  });
  const old = feed.load(); query = 'new'; const latest = feed.load();
  requests[0].resolve(payload(1)); await old;
  assert.equal(state.jobs, null); assert.equal(feed.loading, true); assert.deepEqual(settled, []);
  await feed.load({ append: true }); assert.equal(requests.length, 2);
  requests[1].resolve(payload(2)); await latest;
  assert.deepEqual(state.jobs, [{ id: 2 }]); assert.equal(feed.loading, false);
  assert.deepEqual(state.typeCounts, { intern: 37, coop: 5 }); assert.equal(state.total, 42);
  assert.deepEqual(requests.map(row => row.filters.query), ['old', 'new']);
});

test('Discover serializes pagination and marks failed or empty pages until reload', async () => {
  const state = { jobs: [{ id: 1 }] }, requests = [], errors = [];
  const feed = createFeedLoader(state, () => ({}), { error: error => errors.push(error.message) }, (_, offset) => {
    const request = deferred(); requests.push({ ...request, offset }); return request.promise;
  });
  const next = feed.load({ append: true }); await feed.load({ append: true });
  assert.equal(requests.length, 1); assert.equal(requests[0].offset, 1);
  requests[0].reject(Error('Offline')); await next;
  assert.deepEqual(state.jobs, [{ id: 1 }]); assert.equal(state.loadingMore, false);
  assert.equal(feed.autoLoadFailed, true); assert.deepEqual(errors, ['Offline']);
  const reload = feed.load(); assert.equal(feed.autoLoadFailed, false);
  requests[1].resolve(payload(2)); await reload;
  const empty = feed.load({ append: true }); requests[2].resolve({ ...payload(0), jobs: [] }); await empty;
  assert.equal(feed.autoLoadFailed, true); assert.deepEqual(state.jobs, [{ id: 2 }]);
});

test('tracker limits writes to six, retains failures, and only undoes successes', async () => {
  const records = Array.from({ length: 13 }, (_, id) => ({ id: String(id), company: 'Example', title: 'Intern', stage: 'applied', events: [] }));
  const state = { busy: false }, apps = records.map(fromAPI), busy = [], results = [];
  let active = 0, maximum = 0;
  const commit = createApplicationActions(state, () => apps, {
    busy: value => busy.push(value), saved: result => results.push(result), undone: message => results.push(message),
  }, async (id, body) => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 2)); active--;
    if (id === '4') throw Error('Save failed');
    return { ...records[Number(id)], ...body };
  });
  const save = commit([...apps.map(app => app.id), '0'], closeNoReply(13));
  assert.equal(await commit(['0'], closeNoReply(1)), false);
  assert.equal(await save, false); assert.equal(maximum, 6); assert.equal(state.busy, false);
  assert.equal(results[0].succeeded.length, 12); assert.equal(results[0].failed[0].old.id, '4');
  assert.equal(apps[4].stage, 'sent'); assert.equal(apps[0].stage, 'closed');
  await results[0].undo(); assert.ok(apps.every(app => app.stage === 'sent'));
  assert.equal(results[1], 'Change undone.'); assert.deepEqual(busy, [true, false, true, false]);
});

test('tracker treats invalid edits as failures and releases controls', async () => {
  const state = {}, app = fromAPI({ id: '1', stage: 'applied' }); let result;
  const commit = createApplicationActions(state, () => [app], {
    busy() {}, saved: value => { result = value; }, undone() {},
  }, () => { throw Error('must not write'); });
  assert.equal(await commit(['1'], { apply() { throw Error('invalid edit'); }, message: 'Saved' }), false);
  assert.equal(state.busy, false); assert.equal(result.undo, null); assert.equal(result.failed[0].error.message, 'invalid edit');
});

test('resume handoff reuses a target without writing or modifying its selection', async () => {
  const resume = { id: 8, target_job_id: 5, selection: { entries: [{ entry_id: 9, role: 'Custom title' }] } };
  const workspace = { jobs: [{ id: 5 }], resumes: [resume] };
  assert.deepEqual(await resolveHandoff(5, workspace, () => { throw Error('must not create'); }), { resume, created: false });
  assert.equal(await resolveHandoff(0, workspace), null); assert.equal(await resolveHandoff(99, workspace), null);
  assert.equal(resume.selection.entries[0].role, 'Custom title');
});

test('resume handoff creates variant selections from the supplied live workspace', async () => {
  const workspace = {
    jobs: [{ id: 5, company: 'Example', title: 'Intern' }], resumes: [], variants: [{ key: 'engineering' }],
    entries: [{ id: 9, bullets: [{ id: 1, audience: 'all' }, { id: 2, audience: 'engineering' }, { id: 3, audience: 'research' }] }],
    skills: [{ id: 7, audience: 'all' }, { id: 8, audience: 'research' }],
  };
  const result = await resolveHandoff(5, workspace, async data => ({ id: 11, ...data }));
  assert.equal(result.created, true); assert.equal(result.resume.name, 'Example · Intern');
  assert.deepEqual(result.resume.selection, { entries: [{ entry_id: 9, bullets: [{ bullet_id: 1, text_override: null }, { bullet_id: 2, text_override: null }] }], skills: [7] });
  assert.deepEqual(workspace.resumes, []);
  await assert.rejects(resolveHandoff(5, workspace, async () => { throw Error('Offline'); }), /Offline/);
});

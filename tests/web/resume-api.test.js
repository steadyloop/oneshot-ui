const test = require('node:test');
const assert = require('node:assert/strict');
const { api } = require('../../web/shared/api.js');

const requests = [];
let error = false;
global.fetch = async (url, options = {}) => {
  requests.push({ url, ...options });
  if (url === '/api/auth/me') return Response.json({ id: 'test-account' });
  if (url.includes('/parse?')) return Response.json(error ? { error: { message: 'Invalid document' } } : { profile: {}, entries: [] }, { status: error ? 422 : 200 });
  if (url.endsWith('/pdf')) return error ? Response.json({ detail: 'Render failed' }, { status: 500 }) : new Response('%PDF-test', { headers: { 'Content-Type': 'application/pdf' } });
  if (url.endsWith('/profile')) return Response.json({ full_name: 'Alex' });
  const key = url.split('/').pop();
  return Response.json({ [key]: [{ id: 1 }] });
};

test('resume load assembles the same six resources through the account transport', async () => {
  const workspace = await api.resumes.load();
  assert.deepEqual(workspace, { profile: { full_name: 'Alex' }, entries: [{ id: 1 }], skills: [{ id: 1 }], variants: [{ id: 1 }], jobs: [{ id: 1 }], resumes: [{ id: 1 }], local: false });
  assert.deepEqual(requests.filter(row => row.url !== '/api/auth/me').map(row => row.url).sort(),
    ['entries', 'jobs', 'profile', 'resumes', 'skills', 'variants'].map(key => `/api/resume/${key}`));
});

test('resume parsing preserves input bytes, media types, cancellation and errors', async () => {
  const controller = new AbortController();
  await api.resumes.parse('Resume text', 'text', controller.signal);
  assert.equal(requests.at(-1).body, 'Resume text'); assert.equal(requests.at(-1).signal, controller.signal);
  assert.equal(requests.at(-1).headers['Content-Type'], 'text/plain; charset=utf-8');
  const file = new Uint8Array([1, 2, 3]); await api.resumes.parse(file, 'pdf');
  assert.equal(requests.at(-1).body, file); assert.equal(requests.at(-1).headers['Content-Type'], 'application/octet-stream');
  error = true;
  try { await assert.rejects(api.resumes.parse('Bad', 'text'), /Invalid document/); }
  finally { error = false; }
});

test('PDF export preserves the guest payload and account URL and reports render errors', async () => {
  const document = { profile: { full_name: 'Alex' }, resume: { id: 42 }, entries: [], skills: [] };
  assert.equal(await (await api.resumes.pdf({ ...document, local: true })).text(), '%PDF-test');
  assert.equal(requests.at(-1).url, '/api/resume/render/pdf'); assert.equal(requests.at(-1).method, 'POST');
  assert.equal(requests.at(-1).headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(requests.at(-1).body), document);
  await api.resumes.pdf({ ...document, local: false });
  assert.equal(requests.at(-1).url, '/api/resume/resumes/42/pdf'); assert.equal(requests.at(-1).body, undefined);
  error = true;
  try { await assert.rejects(api.resumes.pdf({ ...document, local: true }), /Render failed/); }
  finally { error = false; }
});

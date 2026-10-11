const fs = require('node:fs');
const path = require('node:path');

const WEB = path.resolve(__dirname, '../../web');
const ORIGIN = 'http://oneshot-feeds.test';
const provider = (source, discover_jobs, counts) => ({
  source, discover_jobs,
  boards: Object.entries(counts).flatMap(([state, count]) => Array.from({ length: count }, (_, i) => ({
    key: `${source}-${state}-${i}`, company: `${source} company ${i}`, state, coverage: i + 1,
    last_poll_at: '2026-10-07T08:00:00Z',
  }))),
});

function fixture() {
  const providers = ['workday', 'oracle', 'greenhouse', 'ukg', 'smartrecruiters', 'eightfold']
    .map((source, i) => provider(source, 1000 - i, { ok: 12, degraded: 1, stale: 2 }));
  providers.push(provider('lever', 100, { ok: 1441, degraded: 73, stale: 397 }));
  for (let i = 0; i < 30; i++) {
    providers.push(provider(i === 29 ? 'custom"]provider' : `other-${i}`, 99 - i,
      { ok: 7, degraded: 2, failing: 1, stale: 3, paused: 1, never: 2, unknown: 1 }));
  }
  providers[0].boards[0].coverage = 588300;
  const types = { intern: 12, coop: 2, student: 0, new_grad: 3, research: 1, unclassified: 2 };
  const closed = { intern: 2, coop: 0, student: 0, new_grad: 1, research: 0, unclassified: 1 };
  return {
    providers,
    totals: { boards: providers.reduce((n, p) => n + p.boards.length, 0), providers: providers.length,
      active_postings: 1234567, added_today: 20, disappeared_today: 4 },
    classification: { total: 1234567, student_roles: 10000 },
    today_breakdown: { total: 20, types, disappeared: { total: 4, types: closed } },
  };
}

async function serve(context, response) {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.fulfill({ status: 404, body: '' });
    if (url.pathname === '/api/source-coverage/boards') return response(route);
    if (url.pathname === '/api/auth/me') return route.fulfill({ status: 401, json: {} });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { total: 0, jobs: [] } });
    const relative = url.pathname === '/source-coverage/' ? 'feeds/index.html' : url.pathname.replace(/^\/static\//, '');
    const file = path.resolve(WEB, relative);
    if (!file.startsWith(WEB + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({ path: file });
  });
}

module.exports = { ORIGIN, fixture, serve };

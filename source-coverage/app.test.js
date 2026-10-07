const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {
  relativeTime,
  withTimeout,
  stateKey,
  fleetTotals,
  todayLine,
  problemText,
  buildBands,
  STATE_LABEL,
} = require("./app.js");

test("every backend board state has a stable visual key", () => {
  assert.equal(stateKey("ok"), "ok");
  assert.equal(stateKey("degraded"), "degraded");
  assert.equal(stateKey("failing"), "failing");
  assert.equal(stateKey("stale"), "stale");
  assert.equal(stateKey("paused"), "paused");
  assert.equal(stateKey("never"), "never");
  assert.equal(stateKey("Unexpected"), "unknown");
});

test("fleet totals sum board coverage into roles", () => {
  const providers = [
    { source: "greenhouse", boards: [{ state: "ok", coverage: 100 }, { state: "degraded", coverage: 50 }, { state: "failing", coverage: 0 }] },
    { source: "lever", boards: [{ state: "stale", coverage: 25 }, { state: "paused", coverage: 30 }, { state: "never", coverage: 0 }] },
  ];
  const computed = fleetTotals({ providers });
  assert.equal(computed.boards, 6);
  assert.equal(computed.providers, 2);
  assert.equal(computed.roles, 205);
  assert.equal(computed.ok, 1);
  assert.equal(computed.erroring, 2);
});

test("the header uses the pipeline active total rather than the Discover subset or board sum", () => {
  const providers = [{ source: "greenhouse", boards: [{ state: "ok", coverage: 100 }] }];
  assert.equal(fleetTotals({ providers, totals: { boards: 1, active_postings: 90 }, classification: { total: 90, student_roles: 7 } }).roles, 90);
  assert.equal(fleetTotals({ providers, totals: { boards: 1, active_postings: 0 } }).roles, 0);
  assert.equal(fleetTotals({ providers, totals: { boards: 1 } }).roles, 100);
});

test("daily activity distinguishes a measured zero from an unknown closure count", () => {
  assert.equal(todayLine({ added_today: 4081, disappeared_today: 290 }), "4,081 jobs posted, 290 jobs closed today");
  assert.equal(todayLine({ added_today: 0, disappeared_today: 12 }), "0 jobs posted, 12 jobs closed today");
  assert.equal(todayLine({ added_today: 0, disappeared_today: 0 }), "0 jobs posted, 0 jobs closed today");
  assert.equal(todayLine({ added_today: 4081 }), "4,081 jobs posted today");
  assert.equal(todayLine(undefined), "");
});

test("people read retrying, failing and overdue, never the API's state keys", () => {
  assert.equal(STATE_LABEL.degraded, "retrying");
  assert.equal(STATE_LABEL.failing, "failing");
  assert.equal(STATE_LABEL.stale, "overdue");
  assert.equal(STATE_LABEL.never, "unpolled");
  assert.equal(problemText({ stale: 3, failing: 2, degraded: 1 }), "2 failing · 1 retrying · 3 overdue");
  assert.equal(problemText({}), "");
});

const board = (state, coverage = 0, extra = {}) => ({ key: `${state}-${coverage}`, state, coverage, ...extra });

test("providers rank by Discover contribution rather than board count or raw jobs", () => {
  const providers = ["a", "b", "c", "d"].map((source, index) => ({
    source,
    discover_jobs: [0, 10, 30, 20][index],
    boards: Array.from({ length: 4 - index }, () => board("ok", 10 * (index + 1))),
  }));
  const bands = buildBands({ providers });
  assert.deepEqual(bands.map(band => band.id), ["c", "d", "b", "a"]);
});

test("all Discover contributors share one ranked provider list", () => {
  const providers = Array.from({ length: 8 }, (_, index) => ({
    source: `p${index}`, discover_jobs: index * 10,
    boards: [board("ok", 1000 - index * 100)],
  }));
  const bands = buildBands({ providers });
  assert.deepEqual(bands.map(band => band.id), ["p7", "p6", "p5", "p4", "p3", "p2", "p1", "p0"]);
});

test("no board is dropped: every board lands in exactly one band", () => {
  const providers = Array.from({ length: 9 }, (_, index) => ({
    source: `p${index}`,
    boards: Array.from({ length: index + 1 }, () => board("ok", index)),
  }));
  const bands = buildBands({ providers });
  const drawn = bands.reduce((sum, band) => sum + band.boards.length, 0);
  assert.equal(drawn, 45);
  assert.equal(bands.length, providers.length);
});

test("each band pins trouble first, worst first, then healthy boards heaviest first", () => {
  const [band] = buildBands({ providers: [{ source: "workday", boards: [
    board("ok", 5), board("stale", 900), board("ok", 800), board("failing", 0), board("degraded", 50),
  ] }] });
  assert.deepEqual(band.boards.map(b => [b.state, b.jobs]), [
    ["failing", 0], ["degraded", 50], ["stale", 900], ["ok", 800], ["ok", 5],
  ]);
  assert.deepEqual(band.problems, { failing: 1, degraded: 1, stale: 1 });
});

test("bands skip empty providers and normalise unexpected states and missing companies", () => {
  const bands = buildBands({ providers: [
    { source: "taleo", boards: [] },
    { source: "icims", boards: [{ key: "acme", company: null, state: "Weird", coverage: null }] },
  ] });
  assert.deepEqual(bands.map(band => band.id), ["icims"]);
  assert.deepEqual(bands[0].boards[0], { company: "acme", state: "unknown", strikes: 0, jobs: 0, last_poll_at: null });
});

test("polling freshness has concise labels", () => {
  const now = new Date("2026-08-09T12:00:00Z");
  assert.equal(relativeTime("2026-08-09T11:56:00Z", now), "4m ago");
  assert.equal(relativeTime("2026-08-08T12:00:00Z", now), "1d ago");
  assert.equal(relativeTime(null, now), "Never polled");
});

test("feed status loading cannot remain pending indefinitely", async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 5), /request timed out/i);
});

test("feed status is the canonical read-only page and navigation label", () => {
  const page = fs.readFileSync(require.resolve("./index.html"), "utf8");
  const shells = ["../index.html", "../application/index.html", "../resume/index.html", "./index.html"]
    .map(path => fs.readFileSync(require.resolve(path), "utf8"));
  assert.match(page, /<title>Feed Overview · OneShot<\/title>/);
  assert.match(page, /id="coverage-content"/);
  assert.match(page, /id="fleet-stats"/);
  assert.match(page, /id="ticker-card"/);
  // The board tooltip names each state, so the page carries no legend.
  assert.doesNotMatch(page, /legend-row|data-state-count/);
  assert.doesNotMatch(page, /type="search"|<select|data-filter|data-sort/);
  for (const shell of shells) {
    assert.match(shell, /href="\/source-coverage\/"[^>]*title="Feed (?:Status|Overview)"[^>]*>[\s\S]*?<span>Feeds<\/span>/);
    assert.doesNotMatch(shell, /Source coverage|Feed Health/);
  }
  assert.match(page, /navigation\.css\?v=[\w-]+"/);
});

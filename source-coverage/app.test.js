const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {
  relativeTime,
  withTimeout,
  stateKey,
  fleetTotals,
  cellTitle,
  flattenFleet,
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

test("cell tooltips show the canonical company name, falling back to the board key", () => {
  assert.equal(
    cellTitle("greenhouse", { key: "openai", company: "OpenAI", coverage: 123 }),
    "OpenAI (123 roles)",
  );
  assert.equal(
    cellTitle("lever", { key: "acme", company: null, coverage: 0 }),
    "acme (0 roles)",
  );
});

test("cell tooltips append poll freshness when the board has been polled", () => {
  const minutesAgo = new Date(Date.now() - 4 * 60 * 1000).toISOString();
  assert.equal(
    cellTitle("greenhouse", { key: "openai", company: "OpenAI", coverage: 123, last_poll_at: minutesAgo }),
    "OpenAI (123 roles), 4m ago",
  );
});

test("flattening lays providers out as contiguous ranges over one cell list", () => {
  const { providers, boards } = flattenFleet({
    providers: [
      { source: "greenhouse", boards: [{ key: "a", state: "ok" }, { key: "b", state: "failing" }] },
      { source: "lever", boards: [{ key: "c", state: "degraded" }] },
    ],
  });
  assert.deepEqual(providers.map(range => [range.source, range.start, range.count]), [
    ["greenhouse", 0, 2],
    ["lever", 2, 1],
  ]);
  assert.deepEqual(boards.map(board => board.key), ["a", "b", "c"]);
  // Every cell knows its provider, so the tooltip needs no second lookup.
  assert.deepEqual(boards.map(board => board.source), ["greenhouse", "greenhouse", "lever"]);
});

test("flattening counts failing and degraded per provider, which totals only report combined", () => {
  const { providers } = flattenFleet({
    providers: [
      { source: "workday", boards: [{ state: "failing" }, { state: "degraded" }, { state: "degraded" }, { state: "ok" }] },
      { source: "ashby", boards: [{ state: "ok" }] },
    ],
  });
  assert.deepEqual(providers.map(range => [range.source, range.failing, range.degraded]), [
    ["workday", 1, 2],
    ["ashby", 0, 0],
  ]);
});

test("flattening skips providers with no boards so no range is empty", () => {
  const { providers, boards } = flattenFleet({
    providers: [{ source: "taleo", boards: [] }, { source: "gem", boards: [{ state: "ok" }] }],
  });
  assert.deepEqual(providers.map(range => range.source), ["gem"]);
  assert.equal(boards.length, 1);
});

test("flattening normalises unexpected states and missing companies", () => {
  const { boards } = flattenFleet({
    providers: [{ source: "icims", boards: [{ key: "acme", company: null, state: "Weird", coverage: null }] }],
  });
  assert.equal(boards[0].state, "unknown");
  assert.equal(boards[0].company, "acme");
  assert.equal(boards[0].coverage, 0);
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
  assert.match(page, /<title>Feed Status · OneShot<\/title>/);
  assert.match(page, /id="coverage-content"/);
  assert.match(page, /id="fleet-stats"/);
  assert.match(page, /data-state-count="failing"/);
  assert.doesNotMatch(page, /type="search"|<select|data-filter|data-sort/);
  for (const shell of shells) {
    assert.match(shell, /href="\/source-coverage\/"[^>]*>[\s\S]*?Feed Status<\/a>/);
    assert.doesNotMatch(shell, /Source coverage|Feed Health/);
  }
  assert.match(page, /navigation\.css\?v=[\w-]+"/);
});

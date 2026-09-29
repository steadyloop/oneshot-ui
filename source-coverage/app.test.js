const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {
  relativeTime,
  withTimeout,
  stateKey,
  fleetTotals,
  todayLine,
  shortDate,
  tickerCard,
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

test("the header's today line counts new jobs and the companies they came from", () => {
  assert.equal(todayLine({ added_today: 4081, companies_added_today: 290 }), "4,081 new today from 290 companies");
  assert.equal(todayLine({ added_today: 1, companies_added_today: 1 }), "1 new today from 1 company");
  assert.equal(todayLine({ added_today: 4081 }), "4,081 new today", "older snapshots have no company count");
  assert.equal(todayLine({ added_today: 0, companies_added_today: 0 }), "", "a quiet day shows nothing");
  assert.equal(todayLine(undefined), "");
});

test("the ticker card keeps three named examples of each kind", () => {
  const now = new Date("2026-09-29T17:43:00Z");
  const card = tickerCard({
    latest_jobs: [
      { company: "Epic Games", title: "Product Management Intern", first_seen_at: "2026-09-29T17:28:00Z" },
      { company: "WSP", title: "Civil Engineering Intern", first_seen_at: "2026-09-29T17:27:00Z" },
      { company: "Cisco", title: "Systems Quality Engineer", first_seen_at: "2026-09-29T17:18:00Z" },
      { company: "Clera", title: "Founder Associate Intern", first_seen_at: "2026-09-29T17:12:00Z" },
    ],
    new_feeds: { latest: [
      { company: "WSP", source: "oracle", added_on: "2026-09-09" },
      { company: "Northrop Grumman", source: "workday", added_on: "2026-09-09" },
      { company: "Prolific", source: "greenhouse", added_on: "2026-09-09" },
      { company: "Amentum", source: "workday", added_on: "2026-09-09" },
    ] },
  }, now);
  assert.deepEqual(card.jobs.map(job => [job.company, job.ago]), [["Epic Games", "15m ago"], ["WSP", "16m ago"], ["Cisco", "25m ago"]]);
  assert.deepEqual(card.feeds.map(feed => [feed.company, feed.source]), [["WSP", "oracle"], ["Northrop Grumman", "workday"], ["Prolific", "greenhouse"]]);
  assert.deepEqual(tickerCard({}), { jobs: [], feeds: [] }, "snapshots from before the card have nothing to list");
});

test("a discovery day reads as the same calendar day in every zone", () => {
  const expected = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(2026, 8, 9));
  assert.equal(shortDate("2026-09-09"), expected);
  assert.equal(shortDate("not a date"), "");
  assert.equal(shortDate(undefined), "");
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

test("the largest providers get a band each and the rest share one that keeps each provider", () => {
  const providers = ["a", "b", "c", "d"].map((source, index) => ({
    source,
    boards: Array.from({ length: 4 - index }, () => board("ok", 10 * (index + 1))),
  }));
  const bands = buildBands({ providers }, 2);
  assert.deepEqual(bands.map(band => band.id), ["b", "a", "__tail"], "named bands order by jobs, the tail comes last");
  const tail = bands.at(-1);
  assert.equal(tail.label, "+2 more providers");
  assert.deepEqual(tail.groups.map(group => group.id), ["c", "d"]);
  assert.equal(tail.boards.length, 3, "the shared band draws every tail board");
});

test("no board is dropped: every board lands in exactly one band", () => {
  const providers = Array.from({ length: 9 }, (_, index) => ({
    source: `p${index}`,
    boards: Array.from({ length: index + 1 }, () => board("ok", index)),
  }));
  const bands = buildBands({ providers });
  const drawn = bands.reduce((sum, band) => sum + band.boards.length, 0);
  assert.equal(drawn, 45);
  assert.equal(bands.at(-1).groups.reduce((sum, group) => sum + group.boards.length, 0), bands.at(-1).boards.length);
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
  assert.match(page, /<title>Feed Status · OneShot<\/title>/);
  assert.match(page, /id="coverage-content"/);
  assert.match(page, /id="fleet-stats"/);
  assert.match(page, /id="ticker-card"/);
  // The board tooltip names each state, so the page carries no legend.
  assert.doesNotMatch(page, /legend-row|data-state-count/);
  assert.doesNotMatch(page, /type="search"|<select|data-filter|data-sort/);
  for (const shell of shells) {
    assert.match(shell, /href="\/source-coverage\/"[^>]*>[\s\S]*?Feed Status<\/a>/);
    assert.doesNotMatch(shell, /Source coverage|Feed Health/);
  }
  assert.match(page, /navigation\.css\?v=[\w-]+"/);
});

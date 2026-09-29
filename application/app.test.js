const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { ACTIVE_GROUPS, STAGE_LABELS, CLOSED_REASON_LABELS, COLUMN_CAP, calendarDay, formatDay, todayLocal, groupForStage, applicationStageLabel, dueState, applicationCounts, filterApplications, sortApplications, stageMoment, withTimeout } = require("./app.js");

const now = new Date("2026-08-09T12:00:00Z");
const rows = [
  { id: "considering", company: "Beta", title: "Engineer", stage: "considering", next_action: "Review role", next_due_at: "2026-08-08T12:00:00Z" },
  { id: "interview", company: "Alpha", title: "Researcher", stage: "interview", next_action: "Prepare examples", next_due_at: "2026-08-10T12:00:00Z", submitted_at: "2026-08-01" },
  { id: "offer", company: "Delta", title: "Intern", stage: "offer", next_action: "Review offer", next_due_at: "2026-08-19T12:00:00Z" },
  { id: "closed", company: "Gamma", title: "Developer", stage: "closed", closed_reason: "rejected", next_action: null, next_due_at: null },
];

test("application stages exactly match the PostgreSQL schema", () => {
  assert.deepEqual(Object.keys(STAGE_LABELS), ["considering", "applied", "assessment", "interview", "offer", "closed"]);
  assert.deepEqual(ACTIVE_GROUPS.map(group => group.key), ["considering", "applied", "assessment", "interview", "offer"]);
  assert.deepEqual(Object.keys(CLOSED_REASON_LABELS), ["rejected", "withdrawn", "no_reply"]);
  assert.equal(groupForStage("considering"), "considering");
  assert.equal(groupForStage("assessment"), "assessment");
  assert.equal(groupForStage("interview"), "interview");
  assert.equal(groupForStage("closed"), "archive");
  assert.equal(applicationStageLabel(rows[3]), "Rejected");
});

test("active and archive counts derive only from existing stage values", () => {
  assert.deepEqual(applicationCounts(rows), { active: 3, archive: 1 });
});

test("search and quick filters use current application fields", () => {
  assert.deepEqual(filterApplications(rows, { statusView: "active", query: "alpha" }, now).map(row => row.id), ["interview"]);
  assert.deepEqual(filterApplications(rows, { statusView: "active", quickFilter: "attention" }, now).map(row => row.id), ["considering", "interview"]);
  assert.deepEqual(filterApplications(rows, { statusView: "archive" }, now).map(row => row.id), ["closed"]);
  assert.deepEqual(filterApplications(rows, { statusView: "archive", query: "rejected" }, now).map(row => row.id), ["closed"]);
});

test("application-specific sorting is deterministic and non-mutating", () => {
  assert.deepEqual(sortApplications(rows, "company").map(row => row.company), ["Alpha", "Beta", "Delta", "Gamma"]);
  assert.deepEqual(rows.map(row => row.id), ["considering", "interview", "offer", "closed"]);
  assert.equal(dueState(rows[0].next_due_at, now).key, "overdue");
});

test("application loading cannot remain pending indefinitely", async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 5), /request timed out/i);
  const source = fs.readFileSync(require.resolve("./app.js"), "utf8");
  assert.match(source, /withTimeout\(root\.OneShotAPI\.applications\.list/);
});

test("applications uses the primary workspace navigation structure", () => {
  const html = fs.readFileSync(require.resolve("./index.html"), "utf8");
  const styles = fs.readFileSync(require.resolve("./styles.css"), "utf8");
  assert.match(html, /class="active"[^>]*aria-current="page"/);
  // No fixture switch here: signed out the page opens on the sample data by
  // default, so there is nothing to flip.
  assert.doesNotMatch(html, /sample-toggle/);
  assert.match(styles, /grid-template-columns: 222px minmax\(0, 1fr\)/);
  assert.match(styles, /padding: 22px 12px/);
  assert.match(html, /navigation\.css\?v=[\w-]+"/);
});

test("moving to applied asks the API for nothing beyond the stage", () => {
  const source = fs.readFileSync(require.resolve("./app.js"), "utf8");
  assert.doesNotMatch(source, /confirmed/);
  assert.match(source, /body\.submitted_at = application\.submitted_at \|\| todayLocal\(\)/);
});

test("a closed application cannot be saved without a reason", () => {
  const source = fs.readFileSync(require.resolve("./app.js"), "utf8");
  // Required while showing, disabled while hidden: a hidden required select
  // would block submission with nothing on screen to explain it.
  assert.match(source, /<select name="closed_reason" required\$\{closed \? "" : " disabled"\}>/);
  assert.match(source, /select\.disabled = !closed/);
  assert.doesNotMatch(source, /<option value="">Not specified<\/option>/);
});

test("the drawer edits location and records which resume was sent", () => {
  const source = fs.readFileSync(require.resolve("./app.js"), "utf8");
  // Location is a posting snapshot, so it locks with company and title.
  assert.match(source, /<input name="location"[^`]*\$\{locked\}/);
  assert.match(source, /<input name="resume_variant" list="resume-options"/);
  assert.doesNotMatch(source, /<input name="resume_variant"[^>]*\$\{locked\}/);
  assert.match(source, /body\.resume_variant = String\(data\.get\("resume_variant"\)/);
});

test("a failed undo reports itself instead of dying in the console", () => {
  const source = fs.readFileSync(require.resolve("./app.js"), "utf8");
  assert.match(source, /try \{ await action\.run\(\); \} catch \(error\) \{ showToast\(/);
});

test("validation errors reach the toast as sentences, not [object Object]", () => {
  const { errorMessage } = require("../api-client.js");
  assert.equal(
    errorMessage({ detail: [{ loc: ["body"], msg: "closed_reason is required when stage is closed" }] }, 422),
    "closed_reason is required when stage is closed",
  );
  assert.equal(errorMessage({ detail: "Application not found" }, 404), "Application not found");
  assert.equal(errorMessage(null, 500), "Request failed (500)");
});

test("a picked date reads back as the day that was picked, in any timezone", () => {
  // The server stores a date-only submitted_at at UTC midnight and a next_due_at
  // at UTC end of day. Formatting either as a local instant used to show the day
  // before for every reader west of UTC, while the drawer's own date input --
  // which slices the string -- kept showing the right one.
  assert.equal(formatDay("2026-09-08T00:00:00+00:00"), "Sep 8, 2026");
  assert.equal(formatDay("2026-09-08T23:59:59.999999+00:00"), "Sep 8, 2026");
  assert.equal(formatDay("2026-09-08"), "Sep 8, 2026");
  assert.equal(formatDay(null), "Not set");
  // The drawer input and the list column now read the same field the same way.
  assert.equal(calendarDay("2026-09-08T00:00:00+00:00"), "2026-09-08");
});

test("due dates count whole calendar days, not elapsed hours", () => {
  // Built from local parts on purpose: "today" is the reader's Sep 8 whatever
  // their offset, so these assertions hold in every timezone rather than only
  // in the one this suite happens to run in.
  const midday = new Date(2026, 8, 8, 12, 0);
  const evening = new Date(2026, 8, 8, 21, 30);
  // The regression: at 21:30 local, west of UTC, the stored UTC end-of-day has
  // already passed and the card used to flip to overdue while it was still due.
  assert.equal(dueState("2026-09-08T23:59:59.999999+00:00", evening).label, "Due today");
  assert.equal(dueState("2026-09-08T23:59:59.999999+00:00", midday).label, "Due today");
  assert.equal(dueState("2026-09-09T23:59:59.999999+00:00", midday).label, "Due tomorrow");
  assert.equal(dueState("2026-09-07T23:59:59.999999+00:00", midday).label, "1d overdue");
  assert.equal(dueState("2026-09-01T23:59:59.999999+00:00", midday).label, "7d overdue");
  assert.equal(dueState("2026-09-30T23:59:59.999999+00:00", midday).key, "none");
  assert.equal(dueState(null, evening).key, "none");
});

test("today is the reader's calendar day, not the UTC one", () => {
  assert.equal(todayLocal(new Date(2026, 8, 8, 21, 30)), "2026-09-08");
  assert.equal(todayLocal(new Date(2026, 0, 1, 0, 5)), "2026-01-01");
});

test("undo returns the follow-up the move to Applied created", () => {
  const source = fs.readFileSync(require.resolve("./app.js"), "utf8");
  // Applied stamps submitted_at and fills next_action/next_due_at server-side,
  // so an undo that sends only the stage leaves that follow-up behind.
  assert.match(source, /const before = \{/);
  assert.match(source, /submitted_at: before\.submitted_at, next_action: before\.next_action, next_due_at: before\.next_due_at/);
});

test("the board orders by when the stage last changed, not when it was edited", () => {
  // stage_changed_at is an instant, so two cards moved in the same afternoon
  // still order against each other -- a calendar day would tie them.
  const moved = [
    { id: "first", company: "A", stage: "applied", stage_changed_at: "2026-09-10T14:31:07.100Z" },
    { id: "third", company: "C", stage: "applied", stage_changed_at: "2026-09-09T08:00:00.000Z" },
    { id: "second", company: "B", stage: "applied", stage_changed_at: "2026-09-10T14:31:07.099Z" },
  ];
  assert.deepEqual(sortApplications(moved, "moved").map(row => row.id), ["first", "second", "third"]);
  // Rows written before the event log fall back to updated_at rather than 0,
  // which would bury every one of them under everything else.
  assert.equal(stageMoment({ updated_at: "2026-09-01T00:00:00Z" }), Date.parse("2026-09-01T00:00:00Z"));
  assert.equal(stageMoment({}), 0);
});

test("a card just moved is not buried by cards that have no due date", () => {
  // The regression: every card without next_due_at ranks MAX_SAFE_INTEGER, so
  // they all tied and the tie resolved to payload order. Dragging a card into
  // Considering dropped it wherever the server happened to have listed it.
  const queue = [
    { id: "old", company: "A", stage: "considering", next_due_at: null, stage_changed_at: "2026-08-01T00:00:00Z" },
    { id: "just-dragged", company: "B", stage: "considering", next_due_at: null, stage_changed_at: "2026-09-10T15:00:00Z" },
    { id: "due-soon", company: "C", stage: "considering", next_due_at: "2026-09-11T23:59:59Z", stage_changed_at: "2026-07-01T00:00:00Z" },
  ];
  const order = sortApplications(queue, "next_due").map(row => row.id);
  assert.deepEqual(order, ["due-soon", "just-dragged", "old"]);
  assert.deepEqual(sortApplications(queue, "moved").map(row => row.id), ["just-dragged", "old", "due-soon"]);
});

test("the board is a fixed frame and each column scrolls inside it", () => {
  const styles = fs.readFileSync(require.resolve("./styles.css"), "utf8");
  // The tallest column used to set the height of the page.
  assert.match(styles, /\.board \{[^}]*height: clamp\(/);
  assert.match(styles, /\.column-stack \{[^}]*overflow-y: auto/);
  assert.match(styles, /\.column-stack \{[^}]*min-height: 0/);
  // The header sits outside the scrollport now, so sticky is not just
  // unnecessary -- with no scrolling ancestor it stuck to the viewport.
  assert.doesNotMatch(styles, /\.column-header \{[^}]*position: sticky/);
  // Stacking the columns on a narrow screen cannot work against a fixed height.
  assert.doesNotMatch(styles, /\.board \{ grid-template-columns: 1fr; overflow: visible; \}/);
});

test("a card renders no row it has nothing to put in", () => {
  const source = fs.readFileSync(require.resolve("./app.js"), "utf8");
  // Both rows were unconditional and cost ~80px of every card to print
  // "No next action" and hold an empty badge slot.
  assert.doesNotMatch(source, /No next action<\/p><\/span>/);
  assert.match(source, /const nextStep = application\.next_action \?/);
  assert.match(source, /const footer = application\.next_due_at \?/);
  // Still says it in the list view, where the column exists either way.
  assert.match(source, /class="row-next">\$\{esc\(application\.next_action \|\| "No next action"\)\}/);
});

test("a column renders a bounded number of cards", () => {
  const source = fs.readFileSync(require.resolve("./app.js"), "utf8");
  assert.equal(COLUMN_CAP, 50);
  assert.match(source, /state\.expanded\[group\.key\] \? items : items\.slice\(0, COLUMN_CAP\)/);
  assert.match(source, /data-expand="\$\{group\.key\}">Show \$\{hidden\} more/);
  // The header says so rather than silently under-reporting the column.
  assert.match(source, /\$\{hidden \? `\$\{shown\.length\} \/ \$\{items\.length\}` : items\.length\}/);
});

test("re-rendering does not throw every column back to the top", () => {
  const source = fs.readFileSync(require.resolve("./app.js"), "utf8");
  // Each column is its own scrollport, and render() replaces innerHTML.
  assert.match(source, /const offsets = columnOffsets\(\);/);
  assert.match(source, /restoreOffsets\(offsets\);/);
});

test("a drag can reach the part of a column that is scrolled out of sight", () => {
  const source = fs.readFileSync(require.resolve("./app.js"), "utf8");
  // HTML5 drag will not scroll a container, so without this every card past a
  // column's fold is an unreachable drop target.
  assert.match(source, /dragScroll\.dy = edgeSpeed\(event\.clientY, box\.top, box\.bottom, 64\)/);
  assert.match(source, /requestAnimationFrame\(stepScroll\)/);
  // The whole section stays the drop target: the stack no longer fills it.
  assert.match(source, /event\.target\.closest\("\[data-drop-group\]"\)/);
});

test("moving many at once restores stage and timestamp together on undo", () => {
  const source = fs.readFileSync(require.resolve("./app.js"), "utf8");
  // Leaving stage_changed_at alone would pin an undone card to the top of the
  // column it just came back to.
  assert.match(source, /Object\.assign\(entry\.application, body, restored \|\| \{\}, \{ stage_changed_at: entry\.stage_changed_at \}\)/);
  // Six at a time rather than one PATCH storm per selection.
  assert.match(source, /cursor \+= 6/);
  // A partial failure rolls back only what the server refused.
  assert.match(source, /\$\{failed\.length\} of \$\{moving\.length\} could not be moved/);
});

test("the sort control offers the board default first", () => {
  const html = fs.readFileSync(require.resolve("./index.html"), "utf8");
  const source = fs.readFileSync(require.resolve("./app.js"), "utf8");
  assert.match(html, /<select id="application-sort"><option value="moved">Recently moved<\/option>/);
  assert.match(source, /sort: "moved"/);
  assert.match(html, /data-bulk="move"/);
  assert.match(html, /id="bulk-stage"/);
});

test("the server derives stage_changed_at without a new column", () => {
  const repository = fs.readFileSync(require.resolve("../oneshot_ui/repository.py"), "utf8");
  // Every stage change already writes a stage_changed event, so the board can
  // order by it with a lateral instead of a migration.
  assert.match(repository, /SELECT max\(e\.occurred_at\) AS at/);
  assert.match(repository, /WHERE e\.job_application_id = a\.id AND e\.to_stage IS NOT NULL/);
  assert.match(repository, /"stage_changed_at": _iso\(row\.get\("stage_changed_at"\)\)/);
});

test("no column can be made to scroll sideways by its own cards", () => {
  const styles = fs.readFileSync(require.resolve("./styles.css"), "utf8");
  // A grid track defaults to `auto`, which sizes to the item's min-content --
  // and a card's min-content is its longest nowrap line (.card-location can be
  // "St. Louis, MO · Lake Saint Louis, MO · Mandan, ND"). Without a capped
  // track and a shrinkable item, that widened the column and put a horizontal
  // scrollbar inside it; the ellipsis never got a chance to apply.
  assert.match(styles, /\.column-stack \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(styles, /\.column-stack \{[^}]*overflow-x: hidden/);
  assert.match(styles, /\.application-card \{[^}]*min-width: 0/);
  assert.match(styles, /\.card-face \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(styles, /\.board-column \{[^}]*min-width: 0/);
  // Clamping cannot break a token that has no wrap opportunity.
  assert.match(styles, /\.application-card h3 \{[^}]*overflow-wrap: anywhere/);
  assert.match(styles, /\.next-step p \{[^}]*overflow-wrap: anywhere/);
  // The chevron must not be pushed out by a long due label.
  assert.match(styles, /\.card-open \{[^}]*flex: 0 0 auto/);
  assert.match(styles, /\.column-header h2 \{[^}]*text-overflow: ellipsis/);
});

test("neither delete asks for confirmation", () => {
  const source = fs.readFileSync(require.resolve("./app.js"), "utf8");
  const html = fs.readFileSync(require.resolve("./index.html"), "utf8");
  assert.match(html, /data-bulk="delete"/);
  // Both paths go straight to deleteMany, whose toast carries the undo.
  assert.match(source, /if \(bulk\.dataset\.bulk === "delete"\) return deleteMany\(selected\)/);
  assert.match(source, /if \(action === "delete"\) \{ const application = selectedApplication\(\); return application \? deleteMany\(\[application\]\)/);
  // The confirm dialog is gone entirely, not just bypassed.
  assert.doesNotMatch(html, /delete-dialog/);
  assert.doesNotMatch(source, /deleteDialog/);
});

test("an unconfirmed bulk delete is undoable", () => {
  const source = fs.readFileSync(require.resolve("./app.js"), "utf8");
  // DELETE is permanent server-side, so undo re-creates from the snapshot
  // taken before the request and replays the fields the board shows.
  assert.match(source, /const snapshots = removing\.map\(application => \(\{ \.\.\.application \}\)\)/);
  assert.match(source, /label: "Undo", run: async \(\) => \{\s*const restored = \[\]/);
  // External rows come back through createExternal, tracked rows through the
  // posting they were added from.
  assert.match(source, /snapshot\.external\s*\?\s*await root\.OneShotAPI\.applications\.createExternal/);
  assert.match(source, /await root\.OneShotAPI\.jobs\.addToApplications\(snapshot\.job_id/);
  // A partial restore says so rather than pretending it all came back.
  assert.match(source, /\$\{restored\.length\} of \$\{snapshots\.length\} could be restored/);
});

test("deleting a tracked application returns it to the opportunity count", () => {
  const source = fs.readFileSync(require.resolve("./app.js"), "utf8");
  // Same rule the single delete already follows: a job-linked application that
  // goes away is a posting that becomes visible in Discover again.
  assert.match(source, /const tracked = removing\.some\(application => !application\.external\)/);
  assert.match(source, /if \(tracked\) await root\.OneShotOpportunityCount\.refresh\(\)/);
  // A failed delete puts the row back so the board matches the server.
  assert.match(source, /state\.applications = state\.applications\.concat\(failed\)/);
});

test("ticking a checkbox does not rebuild the board underneath it", () => {
  const source = fs.readFileSync(require.resolve("./app.js"), "utf8");
  // render() replaces innerHTML, which destroys the checkbox mid-click and
  // takes keyboard focus with it. Selection changes nothing about which cards
  // are shown, so it repaints only the selection.
  assert.match(source, /state\.lastPicked = key;\s*return paintSelection\(\);/);
  assert.match(source, /function paintSelection\(\) \{/);
  assert.match(source, /card\.classList\.toggle\("picked", state\.picked\.has\(card\.dataset\.card\)\)/);
});

test("auto-apply is offered only for Considering cards on a Greenhouse hosted board", () => {
  const { autoApplyEligible } = require("./app.js");
  const base = { external: false, stage: "considering", apply_url_snapshot: "https://job-boards.greenhouse.io/testnisc/jobs/8191885" };
  assert.equal(autoApplyEligible(base), true);
  assert.equal(autoApplyEligible({ ...base, apply_url_snapshot: "https://job-boards.eu.greenhouse.io/oet/jobs/4905215101?gh_src=x" }), true);
  assert.equal(autoApplyEligible({ ...base, apply_url_snapshot: "https://boards.greenhouse.io/legacy/jobs/123/" }), true);
  assert.equal(autoApplyEligible({ ...base, stage: "applied" }), false);
  assert.equal(autoApplyEligible({ ...base, external: true }), false);
  assert.equal(autoApplyEligible({ ...base, apply_url_snapshot: "https://micron.wd1.myworkdayjobs.com/external/job/x" }), false);
  assert.equal(autoApplyEligible({ ...base, apply_url_snapshot: "https://www.janestreet.com/join-jane-street/position/123/" }), false);
  assert.equal(autoApplyEligible(null), false);
});

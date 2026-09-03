const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { ACTIVE_GROUPS, STAGE_LABELS, CLOSED_REASON_LABELS, groupForStage, applicationStageLabel, dueState, applicationCounts, filterApplications, sortApplications, withTimeout } = require("./app.js");

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
  assert.match(source, /body\.submitted_at = application\.submitted_at \|\| new Date\(\)/);
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

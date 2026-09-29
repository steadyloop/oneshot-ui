const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function browserContext(values = new Map(), { signedIn = false, pathname = "/application/" } = {}) {
  const fetches = [];
  const context = {
    console,
    Date,
    JSON,
    Map,
    Promise,
    RegExp,
    Response,
    Set,
    URL,
    URLSearchParams,
    location: { pathname, assign() {}, reload() {} },
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key),
    },
    document: {
      addEventListener() {},
      querySelector() { return null; },
    },
    fetch: async (url, options = {}) => {
      fetches.push({ url: String(url), options });
      if (url === "/api/auth/me") {
        return signedIn
          ? new Response(JSON.stringify({ email: "signed.in@example.test" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
          : new Response(JSON.stringify({ detail: "Not signed in" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
      }
      if (String(url).startsWith("/api/jobs")) {
        return new Response(JSON.stringify({ jobs: [], total: 0, limit: 100, offset: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ["sample-data.js", "api-client.js"]) {
    vm.runInContext(fs.readFileSync(require.resolve(`./${file}`), "utf8"), context, { filename: file });
  }
  return { context, fetches, values };
}

test("signed-out application CRUD stays in the browser and never calls the private API", async () => {
  const { context, fetches, values } = browserContext();

  const opening = (await context.OneShotAPI.applications.list()).applications;
  assert.deepEqual(opening, [], "a new guest starts with an empty board");

  const created = await context.OneShotAPI.applications.createExternal({
    company: "Browser Co",
    title: "Software Intern",
    url: "https://example.test/job",
    location: "Remote",
    note: "Local only",
  });
  const updated = await context.OneShotAPI.applications.update(created.id, {
    stage: "interview",
    next_action: "Prepare",
  });

  assert.equal(updated.stage, "interview");
  assert.equal((await context.OneShotAPI.applications.list()).applications.length, 1);
  assert.ok(values.has("oneshot.visitor-data.state.v1"));
  assert.equal(values.has("oneshot.sample-data.state.v7"), false);
  // The identity probe is the only thing that ever reaches the network.
  assert.deepEqual(fetches.map(call => call.url), ["/api/auth/me"]);

  await context.OneShotAPI.applications.remove(created.id);
  assert.deepEqual((await context.OneShotAPI.applications.list()).applications, []);
});

test("guest application writes never enter the sample fixture store", async () => {
  const { context, values } = browserContext();
  await context.OneShotAPI.applications.createExternal({
    company: "Guest Co", title: "Intern", url: "https://example.test/guest",
  });

  assert.match(values.get("oneshot.visitor-data.state.v1"), /Guest Co/);
  assert.equal(values.has("oneshot.sample-data.state.v7"), false);
});

test("a signed-out visitor with nothing stored opens an empty board", async () => {
  const { context } = browserContext();
  const rows = (await context.OneShotAPI.applications.list()).applications;
  assert.deepEqual(rows, []);
  assert.equal(context.OneShotSampleData.isEnabled(), false);
});

test("Applications restores a signed-out visitor's browser-local work", async () => {
  const values = new Map([["oneshot.visitor-data.state.v1", JSON.stringify({
    jobs: [], applications: [{ id: "v1", company: "Visitor Co", stage: "considering" }],
    nextApplicationId: 2, resume: {},
  })]]);
  const { context } = browserContext(values);
  const rows = (await context.OneShotAPI.applications.list()).applications;
  assert.equal(rows.some(row => row.company === "Visitor Co"), true);
  assert.equal(context.OneShotSampleData.isEnabled(), false);
});

test("a guest resume leaves an otherwise empty applications board empty", async () => {
  const values = new Map();
  values.set("oneshot.visitor-data.state.v1", JSON.stringify({
    jobs: [], applications: [], nextApplicationId: 1,
    resume: { profile: { full_name: "Local Person" }, entries: [{ id: 1 }], skills: [], targetJobs: [], resumes: [] },
  }));
  const { context } = browserContext(values);
  const rows = (await context.OneShotAPI.applications.list()).applications;
  assert.deepEqual(rows, []);
});

test("legacy fixture flags stay disabled", async () => {
  const values = new Map([["oneshot.sample-data.enabled.application", "1"]]);
  const { context } = browserContext(values, { signedIn: true });
  await context.OneShotSampleData.ready();
  assert.equal(context.OneShotSampleData.isEnabled(), false);
});

test("signed-out resume CRUD uses the browser-local workspace", async () => {
  const { context, fetches, values } = browserContext();
  assert.equal(await context.OneShotVisitorData.isLocal(), true);

  await context.OneShotVisitorData.request("/resume/profile", {
    method: "PUT",
    body: JSON.stringify({ full_name: "Local Person", email: "local@example.test" }),
  });
  const entry = await (await context.OneShotVisitorData.request("/resume/entries", {
    method: "POST",
    body: JSON.stringify({ kind: "project", org: "Local project" }),
  })).json();
  const bullet = await (await context.OneShotVisitorData.request(`/resume/entries/${entry.id}/bullets`, {
    method: "POST",
    body: JSON.stringify({ text: "Built 3 browser-local workflows" }),
  })).json();
  const resume = await (await context.OneShotVisitorData.request("/resume/resumes", {
    method: "POST",
    body: JSON.stringify({
      name: "Local resume",
      availability_line: "Available now",
      selection: { entries: [{ entry_id: entry.id, bullets: [{ bullet_id: bullet.id }] }], skills: [] },
    }),
  })).json();
  const stored = await (await context.OneShotVisitorData.request(`/resume/resumes/${resume.id}`)).json();

  assert.deepEqual(stored.selection.entries[0].bullets, [{ bullet_id: bullet.id }]);
  assert.ok(values.has("oneshot.visitor-data.state.v1"));
  assert.deepEqual(fetches.map(call => call.url), ["/api/auth/me"]);
});

test("a guest resume workspace starts blank and stays editable", async () => {
  const { context, values } = browserContext(new Map(), { pathname: "/resume/" });
  const blank = await (await context.OneShotVisitorData.request("/resume/entries")).json();
  assert.equal(blank.entries.length, 0);

  const created = await (await context.OneShotVisitorData.request("/resume/skills", {
    method: "POST",
    body: JSON.stringify({ category: "tool", name: "Playwright", audience: "all" }),
  })).json();
  assert.equal(created.name, "Playwright");
  const renamed = await (await context.OneShotVisitorData.request(`/resume/skills/${created.id}`, {
    method: "PATCH",
    body: JSON.stringify({ name: "Playwright Test" }),
  })).json();
  assert.equal(renamed.name, "Playwright Test");
  assert.match(values.get("oneshot.visitor-data.state.v1"), /Playwright Test/);
});

test("guest opportunity queries exclude locally tracked job ids", async () => {
  // Opportunities is not a fixture page -- its feed stays live -- but the job
  // it adds has to land in the store the tracker reads, and be hidden here.
  const { context, fetches } = browserContext(new Map(), { pathname: "/" });
  const job = {
    id: 41,
    company: "Example Labs",
    title: "SWE Intern",
    location: "Remote",
    apply_url: "https://example.test/apply",
  };
  const tracked = await context.OneShotAPI.jobs.addToApplications(job.id, job);
  assert.equal(tracked.company, "Example Labs");
  await context.OneShotAPI.jobs.list({ limit: 100, offset: 0 });

  assert.ok(fetches.at(-1).url.includes("exclude_job_id=41"));
});

test("a guest skip leaves the feed, keeps a Hidden entry, and Restore brings it back", async () => {
  const values = new Map();
  const { context, fetches } = browserContext(values, { pathname: "/" });
  const job = { id: 52, company: "Example Labs", title: "Data Intern", apply_url: "https://example.test/52" };

  const skipped = await context.OneShotAPI.jobs.setFeedback(job.id, { kind: "skip" }, job);
  assert.equal(skipped.kind, "skip");
  assert.equal(skipped.skip_reason, null);
  // The reason arrives later, as a replace that keeps when it was hidden.
  const reasoned = await context.OneShotAPI.jobs.setFeedback(job.id, { kind: "skip", skip_reason: "location" }, job);
  assert.equal(reasoned.skip_reason, "location");
  assert.equal(reasoned.created_at, skipped.created_at);

  await context.OneShotAPI.jobs.list({ limit: 100, offset: 0 });
  assert.ok(fetches.at(-1).url.includes("exclude_job_id=52"));
  assert.equal(fetches.some(call => call.url.includes("/feedback")), false, "guest feedback never reaches the server");

  // A second page load reads the same browser store.
  const reopened = browserContext(values, { pathname: "/" }).context;
  const hidden = await reopened.OneShotAPI.feedback.list({ limit: 100 });
  assert.equal(hidden.total, 1);
  assert.equal(hidden.hidden[0].job.title, "Data Intern");
  assert.equal(hidden.hidden[0].skip_reason, "location");

  assert.equal(await reopened.OneShotAPI.jobs.clearFeedback(job.id), null);
  assert.deepEqual(Array.from(reopened.OneShotVisitorData.hiddenJobIds()), []);
  await assert.rejects(reopened.OneShotAPI.jobs.clearFeedback(job.id), /not hidden/);
});

test("a guest mislabeled report is validated like the server's", async () => {
  const { context } = browserContext(new Map(), { pathname: "/" });
  const job = { id: 53, company: "hctz.fa.us2", title: "AI/ML Intern", apply_url: "https://example.test/53" };
  await assert.rejects(context.OneShotAPI.jobs.setFeedback(job.id, { kind: "mislabeled" }, job), /at least one correction/);
  await assert.rejects(context.OneShotAPI.jobs.setFeedback(job.id, { kind: "skip", skip_reason: "salary" }, job), /skip_reason/);
  const report = await context.OneShotAPI.jobs.setFeedback(job.id, {
    kind: "mislabeled",
    corrections: [{ field: "company", from: "hctz.fa.us2", to: "Hitachi" }],
  }, job);
  assert.equal(JSON.stringify(report.corrections), JSON.stringify([{ field: "company", from: "hctz.fa.us2", to: "Hitachi" }]));
});

test("sample fixture ids never enter the live opportunity query", async () => {
  const { context, fetches } = browserContext(new Map(), { pathname: "/resume/" });
  await context.OneShotAPI.jobs.list({ limit: 1, offset: 0 });
  const url = fetches.at(-1).url;
  assert.ok(url.startsWith("/api/jobs?"));
  assert.equal(url.includes("sample-quant"), false);
  assert.equal(url.includes("sample-research"), false);
});

test("a guest-tracked posting stays hidden from the live opportunity feed", async () => {
  const values = new Map();
  await browserContext(values, { pathname: "/" }).context.OneShotAPI.jobs.addToApplications(41, {
    id: 41, company: "Example Labs", title: "SWE Intern", apply_url: "https://example.test/apply",
  });

  const { context } = browserContext(values);
  const listing = await context.OneShotAPI.jobs.list({ limit: 100, offset: 0 });
  assert.ok(Array.isArray(listing.jobs));
  assert.equal(listing.jobs.some(job => String(job.id) === "41"), false, "a tracked job stays off the feed");
});

test("a guest's move to Applied opens the same follow-up a signed-in one does", async () => {
  // PostgresRepository.update_application stamps submitted_at and fills in
  // next_action/next_due_at on the way into Applied. The browser-local store
  // used to do none of it, so a guest's Applied cards carried no due date and
  // "Needs attention" could never match anything they produced.
  const { handle, createVisitorState } = require("./sample-data.js");
  const state = createVisitorState();
  const created = await (await handle("/api/applications/external", {
    method: "POST",
    body: JSON.stringify({ company: "juicebox", title: "Software Engineer Intern", url: "https://example.com/1" }),
  }, state)).json();

  const applied = await (await handle(`/api/applications/${created.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stage: "applied", closed_reason: null, submitted_at: "2026-09-08" }),
  }, state)).json();
  assert.equal(applied.submitted_at, "2026-09-08");
  assert.equal(applied.next_action, "Follow up if no response");
  assert.equal(applied.next_due_at, "2026-09-22");  // submitted + 14 days

  // An explicit value still wins, exactly as setdefault does server-side.
  const second = await (await handle("/api/applications/external", {
    method: "POST",
    body: JSON.stringify({ company: "acme", title: "Intern", url: "https://example.com/2" }),
  }, state)).json();
  const chosen = await (await handle(`/api/applications/${second.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stage: "applied", closed_reason: null, submitted_at: "2026-09-08", next_action: "Email the recruiter", next_due_at: "2026-09-10" }),
  }, state)).json();
  assert.equal(chosen.next_action, "Email the recruiter");
  assert.equal(chosen.next_due_at, "2026-09-10");

  // Leaving Applied again must not re-trigger the defaults.
  const moved = await (await handle(`/api/applications/${created.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stage: "interview", closed_reason: null }),
  }, state)).json();
  assert.equal(moved.next_action, "Follow up if no response");
});

test("the undo body clears the follow-up that entering Applied created", async () => {
  // app.js builds this body in updateStage; its own test pins the shape. This
  // one proves the shape actually undoes the write -- sending the stage alone
  // would leave submitted_at and the follow-up on a Considering card.
  const { handle, createVisitorState } = require("./sample-data.js");
  const state = createVisitorState();
  const created = await (await handle("/api/applications/external", {
    method: "POST",
    body: JSON.stringify({ company: "juicebox", title: "Software Engineer Intern", url: "https://example.com/1" }),
  }, state)).json();
  const before = { submitted_at: created.submitted_at || null, next_action: created.next_action || "", next_due_at: created.next_due_at || null };

  const applied = await (await handle(`/api/applications/${created.id}`, {
    method: "PATCH", body: JSON.stringify({ stage: "applied", closed_reason: null, submitted_at: "2026-09-08" }),
  }, state)).json();
  assert.equal(applied.next_due_at, "2026-09-22");

  const undone = await (await handle(`/api/applications/${created.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stage: "considering", closed_reason: null, ...before }),
  }, state)).json();
  assert.equal(undone.stage, "considering");
  assert.equal(undone.submitted_at, null);
  assert.equal(undone.next_action, "");
  assert.equal(undone.next_due_at, null);
});

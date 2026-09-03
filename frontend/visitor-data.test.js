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
  assert.ok(opening.length > 1, "signed out, the board opens on the fixtures");

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
  assert.equal((await context.OneShotAPI.applications.list()).applications.length, opening.length + 1);
  assert.ok(values.has("oneshot.sample-data.state.v7"));
  // The identity probe is the only thing that ever reaches the network.
  assert.deepEqual(fetches.map(call => call.url), ["/api/auth/me"]);

  await context.OneShotAPI.applications.remove(created.id);
  assert.equal((await context.OneShotAPI.applications.list()).applications.length, opening.length);
});

test("sample fixtures and visitor state remain independent", async () => {
  const { context, values } = browserContext();
  await context.OneShotAPI.applications.createExternal({
    company: "Fixture Co", title: "Intern", url: "https://example.test/fixture",
  });

  // Applications write to the fixture store; the visitor workspace is the
  // resume studio's and must not pick them up.
  assert.match(values.get("oneshot.sample-data.state.v7"), /Fixture Co/);
  assert.equal(/Fixture Co/.test(values.get("oneshot.visitor-data.state.v1") || ""), false);
});

test("a signed-out visitor with nothing stored opens in sample mode", async () => {
  const { context } = browserContext();
  const rows = (await context.OneShotAPI.applications.list()).applications;
  assert.ok(rows.length > 1, "fixtures should fill an untouched workspace");
  assert.equal(context.OneShotSampleData.isEnabled(), true);
});

test("Applications opens on the fixtures whenever you are signed out", async () => {
  // There is no switch on that page, so signed out has exactly one meaning --
  // even for a visitor carrying applications from the older browser-local mode.
  const values = new Map([["oneshot.visitor-data.state.v1", JSON.stringify({
    jobs: [], applications: [{ id: "v1", company: "Visitor Co", stage: "considering" }],
    nextApplicationId: 2, resume: {},
  })]]);
  const { context } = browserContext(values);
  const rows = (await context.OneShotAPI.applications.list()).applications;
  assert.equal(rows.some(row => row.company === "Visitor Co"), false);
  assert.equal(context.OneShotSampleData.isEnabled(), true);
});

test("a guest resume does not empty out the applications board", async () => {
  // Both pages share one visitor workspace, and Applications has no switch, so
  // resume work leaking into its default would strand a visitor on a blank
  // board with no way back.
  const values = new Map();
  values.set("oneshot.visitor-data.state.v1", JSON.stringify({
    jobs: [], applications: [], nextApplicationId: 1,
    resume: { profile: { full_name: "Local Person" }, entries: [{ id: 1 }], skills: [], targetJobs: [], resumes: [] },
  }));
  const { context } = browserContext(values);
  const rows = (await context.OneShotAPI.applications.list()).applications;
  assert.ok(rows.length > 1, "an untouched board still opens on the fixtures");
});

test("signing in turns the fixtures off even with the switch left on", async () => {
  const values = new Map([["oneshot.sample-data.enabled.application", "1"]]);
  const { context } = browserContext(values, { signedIn: true });
  await context.OneShotSampleData.ready();
  assert.equal(context.OneShotSampleData.isEnabled(), false);
});

test("signed-out resume CRUD and checks use the browser-local workspace", async () => {
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
  const check = await (await context.OneShotVisitorData.request(`/resume/resumes/${resume.id}/check`)).json();

  assert.equal(check.problems.some(problem => problem.level === "error"), false);
  assert.ok(values.has("oneshot.visitor-data.state.v1"));
  assert.deepEqual(fetches.map(call => call.url), ["/api/auth/me"]);
});

test("the resume mockup loads only when requested and remains fully editable", async () => {
  const { context, values } = browserContext(new Map(), { pathname: "/resume/" });
  const blank = await (await context.OneShotVisitorData.request("/resume/entries")).json();
  assert.equal(blank.entries.length, 0);

  context.OneShotVisitorData.loadResumeDemo();
  const populated = await (await context.OneShotVisitorData.request("/resume/entries")).json();
  const resumes = await (await context.OneShotVisitorData.request("/resume/resumes")).json();
  assert.ok(populated.entries.length >= 4);
  assert.ok(resumes.resumes.length >= 2);

  const created = await (await context.OneShotVisitorData.request("/resume/skills", {
    method: "POST",
    body: JSON.stringify({ category: "tool", name: "Playwright", audience: "all" }),
  })).json();
  assert.equal(created.name, "Playwright");
  assert.match(values.get("oneshot.visitor-data.state.v1"), /Playwright/);
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

test("fixture-only job ids do not break the live opportunity count", async () => {
  const { context, fetches } = browserContext(new Map(), { pathname: "/resume/" });
  await context.OneShotAPI.jobs.list({ limit: 1, offset: 0 });
  const url = fetches.at(-1).url;
  assert.ok(url.startsWith("/api/jobs?"));
  assert.equal(url.includes("sample-quant"), false);
  assert.equal(url.includes("sample-research"), false);
});

test("a remembered live posting does not break the fixture job feed", async () => {
  // Add from Opportunities, then land on Applications, where nav-count lists
  // jobs from the fixture store -- now holding a row the fixtures did not
  // author, with none of the fields their filter reads unguarded.
  const values = new Map();
  await browserContext(values, { pathname: "/" }).context.OneShotAPI.jobs.addToApplications(41, {
    id: 41, company: "Example Labs", title: "SWE Intern", apply_url: "https://example.test/apply",
  });

  const { context } = browserContext(values);
  const listing = await context.OneShotAPI.jobs.list({ limit: 100, offset: 0 });
  assert.ok(Array.isArray(listing.jobs));
  assert.equal(listing.jobs.some(job => String(job.id) === "41"), false, "a tracked job stays off the feed");
});

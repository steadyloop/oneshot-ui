const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const opportunities = require("./opportunities/app.js");
const sampleData = require("./sample-data.js");
const { ROUTES, query } = require("./api-client.js");
const { opportunityTotal } = require("./nav-count.js");

test("visible filters map to PostgreSQL job types", () => {
  const labels = ["Internships", "Co-ops", "Student jobs", "New grad", "Research"];
  const keys = ["internships", "coops", "students", "new_grads", "research"];
  const types = ["intern", "coop", "student", "new_grad", "research"];

  assert.deepEqual(opportunities.FILTERS.map(filter => filter.label), labels);
  assert.deepEqual(opportunities.jobTypes(keys), types);
  // Every tab names exactly one type, so no posting is reachable from two tabs or none.
  assert.deepEqual(opportunities.FILTERS.flatMap(filter => filter.types), types);
  assert.deepEqual(opportunities.jobTypes([]), [], "no tab active defers to the API's default scope");
});

test("opportunity tabs expose exclusive selection state", () => {
  const source = fs.readFileSync(require.resolve("./opportunities/app.js"), "utf8");
  assert.match(source, /role="tab" data-filter="\$\{filter\.key\}" aria-selected="\$\{active\}"/);
  assert.match(source, /state\.filters = \[filter\.dataset\.filter\];/);
  assert.doesNotMatch(source, /\.\.\.state\.filters/);
});

test("job freshness labels stay concise", () => {
  const now = new Date("2026-08-08T12:00:00Z");
  assert.equal(opportunities.postedPresentation("2026-08-08T02:00:00Z", now), "Posted today");
  assert.equal(opportunities.postedPresentation("2026-08-07T02:00:00Z", now), "Posted yesterday");
  assert.equal(opportunities.postedPresentation(null, now), "Date unavailable");
  assert.equal(opportunities.relativeTime("2026-08-08T11:56:00Z", now), "4m ago");
});

test("a browser-local resume renders through the public route, not a canned file", () => {
  const source = fs.readFileSync(require.resolve("./resume/app.js"), "utf8");
  // Export is real Typst in every mode now, so the pre-rendered sample files
  // are gone and nothing about export keys off where the resume is stored.
  assert.doesNotMatch(source, /SAMPLE_PDF_URL|SAMPLE_TYP_URL/);
  assert.match(source, /const localMode = \(\) => state\.browserLocal;/);
  assert.match(source, /fetch\("\/api\/resume\/render\/pdf"/);
});

test("Opportunities pages past the first hundred results instead of dropping them", () => {
  const source = fs.readFileSync(require.resolve("./opportunities/app.js"), "utf8");
  assert.match(source, /data-action="load-more"/);
  assert.match(source, /const offset = append \? \(state\.jobs \|\| \[\]\)\.length : 0;/);
  assert.match(source, /state\.total = payload\.total;/);
});

test("sample application mutations match the editor", async () => {
  const state = sampleData.createState();
  const external = await (await sampleData.handle("/applications/external", {
    method: "POST",
    body: JSON.stringify({ company: "Example Co", title: "Platform Intern", url: "https://example.com/apply", note: "Follow up" }),
  }, state)).json();
  assert.equal(external.external, true);

  const updated = await (await sampleData.handle(`/applications/${external.id}`, {
    method: "PATCH",
    body: JSON.stringify({ company: "Edited Co", stage: "interview", next_action: "Technical screen" }),
  }, state)).json();
  assert.equal(updated.company, "Edited Co");
  assert.equal(updated.stage, "interview");
  assert.equal(updated.events.at(-1).to_stage, "interview");

  const discovered = state.applications.find(application => !application.external);
  const protectedResponse = await sampleData.handle(`/applications/${discovered.id}`, {
    method: "PATCH", body: JSON.stringify({ company: "Wrong Company", next_action: "Review" }),
  }, state);
  assert.equal(protectedResponse.status, 422);
  assert.notEqual(discovered.company, 'Wrong Company');

  assert.equal((await sampleData.handle(`/applications/${external.id}`, { method: "DELETE" }, state)).status, 204);
});

test("visitor workspace starts blank and stays separate from sample fixtures", async () => {
  const visitor = sampleData.createVisitorState();
  const sample = sampleData.createState();

  assert.deepEqual(visitor.applications, []);
  assert.deepEqual(visitor.resume.entries, []);
  assert.ok(sample.applications.length > 0);
  // The fixture persona is gone: sample state ships no resume content either.
  assert.deepEqual(sample.resume.entries, []);
  assert.equal(sample.resume.profile.full_name, "");

  const application = await (await sampleData.handle("/applications/external", {
    method: "POST",
    body: JSON.stringify({ company: "Local Co", title: "Intern", url: "https://local.example/job" }),
  }, visitor)).json();
  assert.match(application.id, /^visitor-app-/);
  assert.equal((await (await sampleData.handle("/applications", {}, visitor)).json()).applications.length, 1);
  assert.equal(sample.applications.some(row => row.company === "Local Co"), false);

  await sampleData.handle("/resume/profile", {
    method: "PUT",
    body: JSON.stringify({ full_name: "Local Visitor", email: "local@example.test" }),
  }, visitor);
  const resume = await (await sampleData.handle("/resume/resumes", {
    method: "POST",
    body: JSON.stringify({ name: "Browser resume" }),
  }, visitor)).json();
  assert.equal((await (await sampleData.handle("/resume/profile", {}, visitor)).json()).full_name, "Local Visitor");
  assert.equal((await (await sampleData.handle(`/resume/resumes/${resume.id}`, {}, visitor)).json()).name, "Browser resume");
  assert.equal(sample.resume.profile.full_name, "");
  assert.equal(sample.resume.resumes.length, 0);
});

test("frontend client builds current API routes", () => {
  assert.equal(ROUTES.addToApplications("job 1"), "/jobs/job%201/applications");
  assert.equal(ROUTES.application("app 1"), "/applications/app%201");
  assert.equal(query({ q: "python", job_type: ["intern", "new_grad"] }), "?q=python&job_type=intern&job_type=new_grad");
  assert.equal(query({ exclude_job_id: [41, 42] }), "?exclude_job_id=41&exclude_job_id=42");
  assert.equal(query({ degree_field: ["cs", "mathematics"] }), "?degree_field=cs&degree_field=mathematics");
  const source = fs.readFileSync(require.resolve("./api-client.js"), "utf8");
  assert.match(source, /OneShotVisitorData\.isLocal\(\)/);
  assert.match(source, /applications:[\s\S]*privateData|applications:[\s\S]*, true\)/);
});

test("navigation count is the unfiltered total on every page", () => {
  assert.equal(opportunityTotal({ total: 428 }), 428);
  assert.equal(opportunityTotal({ total: null }), 0);
  const helper = fs.readFileSync(require.resolve("./nav-count.js"), "utf8");
  assert.match(helper, /jobs\.list\(\{ limit: 1, offset: 0 \}\)/);
  assert.doesNotMatch(helper, /ownsOpportunityCount/);
  const opportunitiesApp = fs.readFileSync(require.resolve("./opportunities/app.js"), "utf8");
  // A tab or filter total belongs on the tab, not the sidebar.
  assert.doesNotMatch(opportunitiesApp, /OneShotOpportunityCount\??\.set/);
  assert.doesNotMatch(opportunitiesApp, /OneShotAPI\.health\(\)/);
  for (const page of ["./index.html", "./application/index.html", "./source-coverage/index.html"]) {
    const html = fs.readFileSync(require.resolve(page), "utf8");
    if (page !== "./application/index.html") assert.match(html, /data-opportunity-count/);
    assert.match(html, /nav-count\.js/);
  }
});

test("Opportunities exposes live controls and canonical navigation", () => {
  const source = fs.readFileSync(require.resolve("./opportunities/app.js"), "utf8");
  const html = fs.readFileSync(require.resolve("./index.html"), "utf8");
  assert.match(source, /data-action="add-to-applications"/);
  assert.match(source, /class="discover-controls-pane"/);
  assert.match(source, /data-action="toggle-fields"/);
  assert.match(source, /class="discover-sort"/);
  assert.match(html, /id="opportunities-search" data-search/);
  assert.match(html, /<label class="topbar-search"[^>]*>[\s\S]*data-search/);
  assert.match(html, /href="\/application\/"/);
  assert.match(html, /href="\/source-coverage\/"/);
  assert.doesNotMatch(html, /href="\/static\/[a-z-]+\/index\.html"/);
  assert.match(html, /opportunities\/styles\.css\?v=white-layout-/);
  assert.match(html, /opportunities\/app\.js\?v=white-layout-/);
  assert.match(html, /navigation\.css\?v=[\w-]+"/);
});

test("production pages never enable fixture mode", () => {
  assert.deepEqual(sampleData.PAGES, {});

  const shellFor = page => fs.readFileSync(require.resolve(page), "utf8");

  // Resume serves guests from the browser-local workspace; it still loads
  // sample-data.js, but only for the OneShotVisitorData export.
  const resume = shellFor("./resume/index.html");
  assert.match(resume, /sample-data\.js/);
  assert.doesNotMatch(resume, /sample-toggle/);
  const resumeApp = fs.readFileSync(require.resolve("./resume/app.js"), "utf8");
  assert.doesNotMatch(resumeApp, /sample-toggle|sampleModeOn|OneShotSampleData/);

  // Applications uses the browser-local visitor workspace while signed out.
  const applications = shellFor("./application/index.html");
  assert.match(applications, /sample-data\.js/);
  assert.doesNotMatch(applications, /sample-toggle/);

  // Opportunities has no fixture mode: it always talks to the real API. It
  // still loads sample-data.js, but only for the OneShotVisitorData export
  // api-client.js and nav-count.js depend on — not for a switch.
  const opportunities = shellFor("./index.html");
  assert.match(opportunities, /sample-data\.js/);
  assert.doesNotMatch(opportunities, /sample-toggle/);
  const page = fs.readFileSync(require.resolve("./opportunities/app.js"), "utf8");
  assert.doesNotMatch(page, /sample-toggle|sampleToggle|OneShotSampleData/);

  // Feed Status is a read-only report on the harvest, so a demo mode there
  // would only hide what the page exists to show.
  assert.doesNotMatch(shellFor("./source-coverage/index.html"), /sample-toggle/);
  assert.doesNotMatch(shellFor("./source-coverage/index.html"), /sample-data\.js/);

  // With no switch anywhere, the guest-gating rules are gone too.
  const navigation = fs.readFileSync(require.resolve("./navigation.css"), "utf8");
  assert.doesNotMatch(navigation, /sample-toggle/);
  const helper = fs.readFileSync(require.resolve("./nav-count.js"), "utf8");
  assert.match(helper, /classList\.add\("is-guest"\)/);
  // A session still clears any legacy fixture flag.
  assert.match(helper, /OneShotSampleData\?\.disableAll\?\.\(\)/);
});

test("shared navigation preserves routes, active states and account access", () => {
  const helper = fs.readFileSync(require.resolve("./nav-count.js"), "utf8");
  assert.match(helper, /querySelector\("\[data-account-slot\]"\)/);
  assert.match(helper, /el\("button", "account-avatar"/);
  const pages = ["./index.html", "./application/index.html", "./resume/index.html", "./source-coverage/index.html"];
  const routes = ["/", "/application/", "/resume/", "/source-coverage/"];
  pages.forEach((page, index) => {
    const html = fs.readFileSync(require.resolve(page), "utf8");
    assert.match(html, /class="app-topbar"/);
    assert.match(html, /data-account-slot/);
    assert.match(html, /class="wordmark-name">OneShot<\/span><span class="wordmark-descriptor">Applications/);
    assert.ok(html.indexOf('navigation.css') > html.indexOf('/styles.css'), `${page} loads the shared shell after its inner-page styles`);
    assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
    assert.ok(html.includes(`class="active" href="${routes[index]}" aria-current="page"`));
    for (const route of routes) assert.ok(html.includes(`href="${route}"`));
    assert.doesNotMatch(html, /<img class="brand-mark"/);
  });
});

test("the application drawer can hand a queued job to the resume studio", () => {
  // The route the button calls, and the id-encoding that keeps a stray path
  // separator from escaping the path segment.
  assert.equal(
    ROUTES.targetFromApplication("app 1"),
    "/resume/jobs/from-application/app%201",
  );

  const client = fs.readFileSync(require.resolve("./api-client.js"), "utf8");
  // It must go through the private transport, or a signed-out visitor writes
  // this to the server instead of being sent to the login page.
  assert.match(client, /targetFromApplication: id => request\([\s\S]*?, true,?\s*\)/);

  const drawer = fs.readFileSync(require.resolve("./application/app.js"), "utf8");
  assert.match(drawer, /data-action="tailor-resume"/);
  assert.match(drawer, /resumes\.targetFromApplication\(app\.id\)/);
  // The studio reads this hash to preselect the target it was handed.
  assert.match(drawer, /\/resume\/#target=\$\{encodeURIComponent\(target\.id\)\}/);
});

test("resume variants are read from the account, never hardcoded", () => {
  const studio = fs.readFileSync(require.resolve("./resume/app.js"), "utf8");
  const shell = fs.readFileSync(require.resolve("./resume/index.html"), "utf8");
  const styles = fs.readFileSync(`${__dirname}/resume/styles.css`, "utf8");

  // The three places that used to spell the enum out.
  for (const source of [studio, shell, styles]) {
    assert.doesNotMatch(source, /"mlsys"|>ML Systems<|\.chip\.quant/);
  }
  assert.match(studio, /api\("\/variants"\)/);
  // Resume creation and initial selection use the same account-owned list.
  assert.match(studio, /function audienceOptions\(selected, \{ includeAll = true \} = \{\}\)/);
  assert.match(studio, /audienceOptions\(values\.variant[\s\S]*?\{ includeAll: false \}\)/);
  assert.match(studio, /function buildInitialSelection\(variant\)/);
  assert.match(shell, /<select name="variant" data-variant-select><\/select>/);
});

test("the guest fake answers the same resume routes as the server", () => {
  const fake = fs.readFileSync(require.resolve("./sample-data.js"), "utf8");
  // loadAll() fans out to all of these; a missing route throws and the studio
  // renders "Failed to load" for every signed-out visitor.
  assert.match(fake, /method === "GET" && path === "\/resume\/variants"/);
  assert.match(fake, /method === "PUT" && path === "\/resume\/variants"/);
  // And it mirrors the server's refusal to orphan a tag in use.
  assert.match(fake, /variant still in use/);
});

test("an entry with no bullets survives a save", () => {
  const studio = fs.readFileSync(require.resolve("./resume/app.js"), "utf8");
  // Bulletless reusable entries have an explicit entry-level selection path.
  assert.match(studio, /if \(!entry\.bullets\.length\)/);
  assert.match(studio, /\{ entry_id: entryId, bullets: \[\] \}/);
  // Education is intentionally fixed and is rendered independently of picks.
  assert.match(studio, /educationSection\(true, resume\)/);
});

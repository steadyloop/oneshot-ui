const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const opportunities = require("./opportunities/app.js");
const sampleData = require("./sample-data.js");
const { ROUTES, query } = require("./api-client.js");
const { opportunityTotal } = require("./nav-count.js");

test("visible filters map to PostgreSQL job types", () => {
  const labels = ["Internships", "Co-ops", "Student Jobs", "New Grad", "Research"];
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

test("sample jobs match the live list contract", async () => {
  const state = sampleData.createState();
  assert.deepEqual(
    [...new Set(state.jobs.flatMap(job => job.skills.map(skill => skill.category)).filter(Boolean))].sort(),
    ["concept", "datastore", "format", "framework", "hardware", "language", "library", "method", "platform", "protocol", "tool"],
  );
  const listing = await (await sampleData.handle("/jobs?limit=100", {}, state)).json();
  assert.equal(listing.total, 8);
  for (const job of listing.jobs) {
    assert.deepEqual(
      Object.keys(job).sort(),
      ["apply_url", "attributes", "company", "first_seen_at", "id", "job_type", "last_seen_at", "location", "locations", "other_sources", "posted_at", "remote", "skills", "source", "source_url", "status", "summary", "title"],
    );
    assert.ok(Array.isArray(job.locations));
    assert.ok(job.locations.every(location =>
      Object.keys(location).sort().join(",") === "city,country,state"));
    assert.ok(Array.isArray(job.skills));
    assert.equal(job.attributes.version, 1);
    // Parse-time columns, alongside attributes rather than inside it. job_type
    // is NULL when no vendor rule matched; remote always states a value.
    assert.ok(job.job_type === null || ["intern", "coop", "student", "new_grad", "research"].includes(job.job_type));
    assert.ok(["yes", "hybrid", "unknown"].includes(job.remote));
  }
});

test("sample job search uses title, company, and precomputed skills only", async () => {
  const state = sampleData.createState();
  const bySkill = await (await sampleData.handle("/jobs?q=Kubernetes&limit=100", {}, state)).json();
  assert.ok(bySkill.jobs.some(job => job.id === "sample-software"));

  const bySummary = await (await sampleData.handle("/jobs?q=reproducible%20experiments&limit=100", {}, state)).json();
  assert.equal(bySummary.total, 0);
  const byLocation = await (await sampleData.handle("/jobs?q=San%20Diego&limit=100", {}, state)).json();
  assert.equal(byLocation.total, 0);
});

test("sample seasonal views search titles and descriptions", async () => {
  const state = sampleData.createState();
  state.applications = [];
  const fall = state.jobs.find(job => job.id === "sample-software");
  const winter = state.jobs.find(job => job.id === "sample-platform");
  fall.title = "Software Engineering Intern";
  fall.summary = "Join the Fall 2027 internship cohort.";
  winter.title = "Winter 2027 Platform Intern";

  const listing = await (await sampleData.handle("/jobs?season=fall&limit=100", {}, state)).json();
  assert.equal(listing.jobs.some(job => job.id === fall.id), true);
  assert.equal(listing.jobs.some(job => job.id === winter.id), false);
});

test("sample fresh order is day first, then US location bucket", async () => {
  const state = sampleData.createState();
  state.applications = [];
  const copy = id => structuredClone(state.jobs.find(job => job.id === id));
  const norcalHub = copy("sample-new-grad");
  const socalHub = copy("sample-software");
  const seattleHub = {
    ...copy("sample-software"), id: "sample-seattle", location: "Seattle, WA",
    locations: [{ country: "US", state: "WA", city: "Seattle" }],
  };
  const otherHub = copy("sample-platform");
  const suburb = copy("sample-graduate-research");
  const rest = copy("sample-research");
  const foreign = copy("sample-working-student");
  const missing = { ...copy("sample-research"), id: "sample-no-location", locations: [], location: null };
  for (const job of [norcalHub, socalHub, seattleHub, otherHub, suburb, rest, foreign, missing]) {
    job.posted_at = "2026-08-21T12:00:00Z";
    job.first_seen_at = job.posted_at;
  }
  state.jobs = [missing, foreign, rest, suburb, otherHub, seattleHub, socalHub, norcalHub];

  const listing = await (await sampleData.handle("/jobs?sort=fresh&limit=100", {}, state)).json();
  assert.deepEqual(listing.jobs.map(job => job.id), [
    "sample-new-grad", "sample-software", "sample-seattle", "sample-platform",
    "sample-graduate-research", "sample-research", "sample-no-location",
  ]);
});

test("a browser-local resume renders through the public route, not a canned file", () => {
  const source = fs.readFileSync(require.resolve("./resume/app.js"), "utf8");
  // Export is real Typst in every mode now, so the pre-rendered sample files
  // are gone and nothing about export keys off where the resume is stored.
  assert.doesNotMatch(source, /SAMPLE_PDF_URL|SAMPLE_TYP_URL/);
  assert.match(source, /const localMode = \(\) => state\.browserLocal;/);
  assert.match(source, /fetch\("\/api\/resume\/render\/pdf"/);
});

test("sample jobs honor limit and offset like the live API", async () => {
  const state = sampleData.createState();
  const first = await (await sampleData.handle("/jobs?limit=2&offset=0", {}, state)).json();
  assert.equal(first.jobs.length, 2);
  assert.equal(first.limit, 2);
  assert.equal(first.offset, 0);
  const second = await (await sampleData.handle("/jobs?limit=2&offset=2", {}, state)).json();
  assert.equal(second.jobs.length, 2);
  assert.equal(second.total, first.total);
  assert.deepEqual(first.job_type_counts, {
    intern: 3, coop: 1, student: 2, new_grad: 1, research: 1,
  });
  assert.deepEqual(
    second.jobs.map(job => job.id).filter(id => first.jobs.some(job => job.id === id)),
    [],
  );
});

test("Opportunities pages past the first hundred results instead of dropping them", () => {
  const source = fs.readFileSync(require.resolve("./opportunities/app.js"), "utf8");
  assert.match(source, /data-action="load-more"/);
  assert.match(source, /const offset = append \? \(state\.jobs \|\| \[\]\)\.length : 0;/);
  assert.match(source, /state\.total = payload\.total;/);
});

test("sample Add to Applications creates one Considering record", async () => {
  const state = sampleData.createState();
  const firstResponse = await sampleData.handle("/jobs/sample-software/applications", { method: "POST" }, state);
  const first = await firstResponse.json();
  assert.equal(firstResponse.status, 201);
  assert.equal(first.stage, "considering");
  assert.equal(first.job_id, "sample-software");
  assert.equal((await (await sampleData.handle("/jobs", {}, state)).json()).total, 7);

  const duplicate = await (await sampleData.handle("/jobs/sample-software/applications", { method: "POST" }, state)).json();
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.already_exists, true);
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
  const protectedApplication = await (await sampleData.handle(`/applications/${discovered.id}`, {
    method: "PATCH",
    body: JSON.stringify({ company: "Wrong Company", next_action: "Review" }),
  }, state)).json();
  assert.notEqual(protectedApplication.company, "Wrong Company");
  assert.equal(protectedApplication.next_action, "Review");

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

test("navigation count reuses the Opportunities response on its main page", () => {
  assert.equal(opportunityTotal({ total: 428 }), 428);
  assert.equal(opportunityTotal({ total: null }), 0);
  const helper = fs.readFileSync(require.resolve("./nav-count.js"), "utf8");
  assert.match(helper, /jobs\.list\(\{ limit: 1, offset: 0 \}\)/);
  assert.match(helper, /ownsOpportunityCount/);
  const opportunitiesApp = fs.readFileSync(require.resolve("./opportunities/app.js"), "utf8");
  assert.match(opportunitiesApp, /OneShotOpportunityCount\?\.set\?\./);
  assert.doesNotMatch(opportunitiesApp, /OneShotAPI\.health\(\)/);
  for (const page of ["./index.html", "./application/index.html", "./source-coverage/index.html"]) {
    const html = fs.readFileSync(require.resolve(page), "utf8");
    assert.match(html, /data-opportunity-count/);
    assert.match(html, /nav-count\.js/);
  }
});

test("Opportunities exposes its action and workspace navigation", () => {
  const source = fs.readFileSync(require.resolve("./opportunities/app.js"), "utf8");
  const html = fs.readFileSync(require.resolve("./index.html"), "utf8");
  assert.match(source, /data-action=\"add-to-applications\"/);
  assert.match(source, /class=\"discover-controls-pane\".*\$\{searchMarkup\(\)\}.*class=\"discover-sort\"/);
  assert.match(source, /class="discover-search-surface"><button class="search-toggle"/);
  assert.doesNotMatch(source, /<span>Sort<\/span>/);
  // Canonical page URLs, not the /static/ mount path the shells also answer on.
  assert.match(html, /href=\"\/application\/\"/);
  assert.match(html, /href=\"\/source-coverage\/\"/);
  assert.doesNotMatch(html, /href=\"\/static\/[a-z-]+\/index\.html\"/);
  assert.match(html, /href=\"\/static\/opportunities\/styles\.css\?v=skill-bundles-/);
  assert.match(html, /src=\"\/static\/opportunities\/app\.js\?v=skill-bundles-/);
  // The versioned directories are gone; no shell may still point at them.
  assert.doesNotMatch(html, /opportunities-v[23]/);
  assert.match(html, /href="\/static\/navigation\.css\?v=[\w-]+"/);
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

test("shared navigation keeps active states from changing geometry", () => {
  const navigation = fs.readFileSync(require.resolve("./navigation.css"), "utf8");
  assert.match(navigation, /min-height: 38px/);
  assert.match(navigation, /font: 400 14px\/20px/);
  // min-width, so a four-digit count widens the pill instead of overflowing it.
  assert.match(navigation, /min-width: 24px/);
  assert.doesNotMatch(navigation, /\n  width: 24px;/);
  assert.match(navigation, /a\.active \{\s*font-weight: 650;/);
  assert.match(navigation, /a\.active \{[\s\S]*?order: initial/);
  assert.doesNotMatch(navigation, /a\.active \{\s*order: -1/);
  assert.match(navigation, /\.side-nav \.nav-icon \{[\s\S]*?fill: none;[\s\S]*?stroke: currentColor;/);
  assert.match(navigation, /\.side-nav p:first-child \{\s*margin-top: 0;/);

  for (const page of ["./index.html", "./application/index.html", "./resume/index.html", "./source-coverage/index.html"]) {
    const html = fs.readFileSync(require.resolve(page), "utf8");
    assert.match(html, /class="icon-sprite"/);
    assert.doesNotMatch(html, /icon-(?:compass|pipeline|radar)\b/);
    for (const icon of ["opportunities", "applications", "resume", "feed-status"]) {
      assert.match(html, new RegExp(`href="#icon-${icon}"`));
    }
    // Four hand-copied sidebars, so the section labels are asserted on each:
    // Discover over Opportunities, Track over Applications, System over Feed Status.
    assert.match(html, /<p>Discover<\/p>\s*<a[^>]*href="\/"/);
    assert.match(html, /<p>Track<\/p>\s*<a[^>]*href="\/application\/"/);
    assert.match(html, /<p>System<\/p>\s*<a[^>]*href="\/source-coverage\/"/);
  }
});

test("Opportunities exposes only its canonical layout", () => {
  const pages = [
    fs.readFileSync(require.resolve("./index.html"), "utf8"),
    fs.readFileSync(require.resolve("./application/index.html"), "utf8"),
    fs.readFileSync(require.resolve("./source-coverage/index.html"), "utf8"),
  ];
  const styles = fs.readFileSync(require.resolve("./opportunities/styles.css"), "utf8");

  for (const page of pages) {
    assert.doesNotMatch(page, /opportunities-(?:full|split|v2|v3)|Opportunities \((?:Left|Full|Split|v2|v3)\)/);
  }
  assert.doesNotMatch(styles, /data-opportunities-layout/);
  assert.match(styles, /\.discover-search-surface \{[^}]*display: flex/);
  assert.match(styles, /\.discover-search-surface \{[^}]*gap: 12px/);
  assert.match(styles, /\.filter\.active \{[^}]*background: transparent; color: var\(--ink\)/);
  // The selected tab is marked by contrast alone -- no underline bar.
  assert.doesNotMatch(styles, /\.filter\.active::after/);
  assert.match(styles, /\.filter \{[^}]*color: var\(--faint\)/);
  // Search and sort share the focus row, so the grid has no row of their own.
  assert.match(styles, /\.discover-sort select \{[^}]*width: 118px; height: 30px[^}]*font-size: 12px/);
  assert.match(styles, /grid-template-areas: "controls controls" "list detail"/);
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
  assert.match(drawer, /resumes\.targetFromApplication\(application\.id\)/);
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

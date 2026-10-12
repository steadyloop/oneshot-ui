// recencyBucket now buckets in the viewer's zone; pin one so the fixtures below
// mean the same thing on every machine. Must precede the core.js require.
process.env.TZ = "America/Los_Angeles";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {
  FILTERS,
  DEGREE_FILTERS,
  SORTS,
  defaultDegreeFields,
  seasonFilter,
  sortOrder,
  SKILL_CATEGORIES,
  SKILL_BUNDLES,
  degreeFields,
  tabCount,
  detailSkillsMarkup,
  safeHref,
  skillDetails,
  orderedSkillDetails,
  skillBundles,
  listTags,
  sourceLabel,
  linkChoices,
  placeList,
  commonTerms,
  openMarkup,
  detailPaneMarkup,
  detailFactsMarkup,
  reportRows,
  reportMarkup,
  hiddenReason,
  SKIP_REASONS,
  skipMenuMarkup,
  skipNoticeMarkup,
  workplaceLabel,
  cardMetaMarkup,
  initials,
  logoSrc,
  logoMarkup,
  recencyBucket,
} = require("../../web/discover/core.js");

test("job type tabs cover every student job type exactly once", () => {
  const counts = { intern: 42, coop: 7, student: 11, new_grad: 5, research: 3 };
  assert.deepEqual(FILTERS.map(filter => filter.label), ["Internships", "Co-ops", "Student jobs", "New grad", "Research"]);
  // One tab per type, so the counts partition the corpus and sum to the total.
  assert.deepEqual(FILTERS.map(filter => tabCount(counts, filter)), [42, 7, 11, 5, 3]);
  assert.equal(FILTERS.reduce((total, filter) => total + tabCount(counts, filter), 0), 68);
  const design = fs.readFileSync(require.resolve("../../web/discover/desktop.js"), "utf8");
  assert.match(design, /class="filter-count"/);
  assert.match(design, /payload\.job_type_counts/);
  assert.match(design, /filters: \["internships"\]/);
});

test("labels the outer recency buckets by calendar day", () => {
  const now = new Date("2026-08-21T18:00:00Z");
  assert.deepEqual(recencyBucket({ posted_at: "2026-08-21T16:00:00Z" }, now), {
    key: "2026-08-21", label: "Opened today",
  });
  assert.deepEqual(recencyBucket({ posted_at: "2026-08-20T16:00:00Z" }, now), {
    key: "2026-08-20", label: "Opened yesterday",
  });
  assert.equal(recencyBucket({ first_seen_at: "2026-08-19T16:00:00Z" }, now).label, "Opened Aug 19");
  assert.equal(recencyBucket({}, now).label, "Date unavailable");
  const design = fs.readFileSync(require.resolve("../../web/discover/desktop.js"), "utf8");
  assert.match(design, /class="recency-bucket"/);
});

test("offers oldest-first sorting while retaining date buckets", () => {
  assert.deepEqual(SORTS.find(([key]) => key === "oldest"), ["oldest", "Oldest first"]);
  // Every order keeps the day buckets: the feed groups by day whatever the sort.
  const design = fs.readFileSync(require.resolve("../../web/discover/desktop.js"), "utf8");
  assert.match(design, /const groups = dayGroups\(jobs\)/);
});

test("replaces alphabetical sorts with seasonal title/description filters", () => {
  assert.deepEqual(SORTS.map(([, label]) => label), ["Newest first", "Oldest first", "Fall Only", "Winter Only"]);
  assert.equal(seasonFilter("fall"), "fall");
  assert.equal(seasonFilter("winter"), "winter");
  assert.equal(seasonFilter("fresh"), "");
  assert.equal(sortOrder("fall"), "fresh");
  assert.equal(sortOrder("oldest"), "oldest");
  const rules = fs.readFileSync(require.resolve("../../web/discover/core.js"), "utf8");
  assert.match(rules, /season: seasonFilter\(sort\), sort: sortOrder\(sort\)/);
});

test("exposes the three bio-career focus filters", () => {
  // Keys are the API's degree_field values (VALID_DEGREE_FIELDS in
  // api/repository.py); anything else is rejected with 400.
  assert.deepEqual(DEGREE_FILTERS, [
    { key: "software", label: "Software" },
    { key: "finance", label: "Finance" },
    { key: "med_device", label: "MedTech" },
    { key: "biotech", label: "BioTech" },
    { key: "clinical_affairs", label: "Regulatory" },
    { key: "unlabeled", label: "Unlabeled" },
  ]);
  assert.deepEqual(degreeFields(["bioengineering", "software", "computer_science", "unknown", "med_device", "biotech", "clinical_affairs"]), [
    "software",
    "med_device",
    "biotech",
    "clinical_affairs",
  ]);
  // Defaults come from the account; unknown keys are dropped.
  assert.deepEqual(defaultDegreeFields({ discover_default_fields: ["software", "finance", "bogus"] }), ["software", "finance"]);
  assert.deepEqual(defaultDegreeFields(null), []);
  const design = fs.readFileSync(require.resolve("../../web/discover/desktop.js"), "utf8");
  assert.match(design, /aria-label="Fields"/);
  assert.match(design, /data-degree-filter/);
  const rules = fs.readFileSync(require.resolve("../../web/discover/core.js"), "utf8");
  assert.match(rules, /degree_field: degreeFields\(fields\)/);
});

test("renders canonical skill metadata and keeps legacy string compatibility", () => {
  assert.deepEqual(skillDetails({
    skills: [
      { id: "go", name: "Go", label: "Go", category: "language" },
      { id: "postgresql", name: "PostgreSQL", label: "Postgres", category: "datastore" },
      { id: "go", name: "Duplicate", category: "language" },
      { id: "broken" },
      null,
    ],
    attributes: { skills: ["Ignored fallback"] },
  }), [
    { id: "go", name: "Go", label: "Go", category: "language" },
    { id: "postgresql", name: "PostgreSQL", label: "Postgres", category: "datastore" },
  ]);
  assert.deepEqual(skillDetails({ attributes: { skills: ["Go", "Kubernetes"] } }), [
    { id: "Go", name: "Go", label: "Go", category: null },
    { id: "Kubernetes", name: "Kubernetes", label: "Kubernetes", category: null },
  ]);
});

test("skill section escapes labels and stays hidden when empty", () => {
  const markup = detailSkillsMarkup({
    skills: [{ id: 'unsafe"', name: '<Full & "name">', label: "<script>alert(1)</script>", category: "stack" }],
  });
  assert.match(markup, /<section class="detail-skill-section" data-skill-section="other"><div class="section-kicker">Other<\/div>/);
  assert.match(markup, /data-skill-id="unsafe&quot;"/);
  assert.match(markup, /data-skill-category="unknown"/);
  assert.match(markup, /title="&lt;Full &amp; &quot;name&quot;&gt; · Other"/);
  assert.match(markup, /aria-label="&lt;Full &amp; &quot;name&quot;&gt;, Other"/);
  assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(markup, /<script>/);
  assert.equal(detailSkillsMarkup({ skills: [] }), "");
  assert.equal(detailSkillsMarkup({ attributes: { skills: [] } }), "");
});

test("detail shows every skill while the card keeps only language and stack", () => {
  const job = { skills: [
    { id: "ai", name: "Artificial intelligence", label: "AI", category: "concept" },
    { id: "go", name: "Go", label: "Go", category: "language" },
    { id: "kubernetes", name: "Kubernetes", label: "Kubernetes", category: "platform" },
    { id: "postgresql", name: "PostgreSQL", label: "PostgreSQL", category: "datastore" },
  ] };
  assert.deepEqual(skillDetails(job).map(skill => skill.name), [
    "Artificial intelligence", "Go", "Kubernetes", "PostgreSQL",
  ]);
  const detail = detailSkillsMarkup(job);
  for (const label of ["AI", "Go", "Kubernetes", "PostgreSQL"]) assert.match(detail, new RegExp(`>${label}<`));
  const tags = listTags(job);
  assert.match(tags, />Go<.*>PostgreSQL</);
  assert.doesNotMatch(tags, />AI<|>Kubernetes</);
  assert.doesNotMatch(tags, />\+\d+</);
});

test("orders every skill by category then label within peer detail sections", () => {
  assert.deepEqual(SKILL_CATEGORIES.map(category => category.key), [
    "language", "framework", "library", "platform", "tool", "datastore",
    "protocol", "format", "hardware", "method", "concept",
  ]);
  const job = { skills: [
    { id: "ai", name: "Artificial intelligence", label: "AI", category: "concept" },
    { id: "postgresql", name: "PostgreSQL", label: "Postgres", category: "datastore" },
    { id: "python", name: "Python", label: "Python", category: "language" },
    { id: "cpp", name: "C++", label: "C++", category: "language" },
    { id: "legacy", name: "Legacy skill", label: "Legacy", category: "stack" },
    { id: "pytorch", name: "PyTorch", label: "PyTorch", category: "library" },
    { id: "distillation", name: "Knowledge distillation", label: "Knowledge distillation", category: "method" },
  ] };

  assert.deepEqual(orderedSkillDetails(job).map(skill => skill.id), [
    "cpp", "python", "pytorch", "postgresql", "distillation", "ai", "legacy",
  ]);
  const markup = detailSkillsMarkup(job);
  assert.match(markup, /data-skill-section="skills".*C\+\+.*Python.*PyTorch.*Postgres.*data-skill-section="expertise".*Knowledge distillation.*AI.*data-skill-section="other".*Legacy/);
  assert.doesNotMatch(markup, /class="(?:skill-group-title|section-kicker)">(?:Languages|Frameworks|Libraries|Datastores|Platforms|Tools|Protocols|Formats|Hardware|Methods|Concepts)</);
});

test("detail presents methods and concepts as one low-emphasis expertise flow", () => {
  const markup = detailSkillsMarkup({ skills: [
    { id: "python", name: "Python", label: "Python", category: "language" },
    { id: "distillation", name: "Knowledge distillation", label: "Knowledge distillation", category: "method" },
    { id: "distributed-systems", name: "Distributed systems", label: "Distributed systems", category: "concept" },
  ] });

  assert.match(markup, /class="skill"[^>]*>Python</);
  assert.match(markup, /<section class="detail-skill-section" data-skill-section="skills"><div class="section-kicker">Skills<\/div>/);
  assert.match(markup, /<section class="detail-skill-section" data-skill-section="expertise"><div class="section-kicker">Expertise<\/div>/);
  assert.match(markup, /class="expertise-list" role="group" aria-label="Methods and concepts"/);
  assert.match(markup, /class="expertise-term"[^>]*data-skill-category="method"[^>]*>Knowledge distillation</);
  assert.match(markup, /class="expertise-term"[^>]*data-skill-category="concept"[^>]*>Distributed systems</);
  assert.doesNotMatch(markup, /data-skill-(?:group|section)="(?:method|concept)"/);

  const styles = fs.readFileSync(require.resolve("../../web/discover/desktop.css"), "utf8");
  assert.match(styles, /\.skill-list \{[^}]*display: flex[^}]*flex-wrap: wrap/);
  assert.match(styles, /\.expertise-list \{[^}]*display: flex[^}]*flex-wrap: wrap[^}]*gap: 4px 6px/);
  // Outlined, so expertise reads quieter than the filled language and tool pills.
  assert.match(styles, /\.expertise-term \{[^}]*display: inline-flex[^}]*height: 22px[^}]*padding: 0 8px[^}]*border: 1px solid var\(--line-strong\)[^}]*border-radius: 6px[^}]*font-size: 12\.5px/);
  // Pills use the reading font, not the code font.
  assert.match(styles, /\.tag, \.skill \{[^}]*height: 20px[^}]*font: 500 12px\/1 var\(--sans\)/);
  assert.doesNotMatch(styles, /\.expertise-term[^}]*::(?:before|after)/);
  assert.doesNotMatch(styles, /\.expertise-term\[data-skill-category="method"\]/);
  assert.doesNotMatch(styles, /\.expertise-term(?:\[[^\]]+\])? \{[^}]*linear-gradient/);
});

test("expertise expands raw compact compounds into polished canonical labels", () => {
  const markup = detailSkillsMarkup({ skills: [
    { id: "model-deployment", name: "Model deployment", label: "ModelDeploy", category: "method" },
    { id: "data-science", name: "Data science", label: "DataScience", category: "concept" },
    { id: "generative-ai", name: "Generative AI", label: "GenAI", category: "concept" },
    { id: "neural-networks", name: "Neural networks", label: "NeuralNetworks", category: "concept" },
    { id: "artificial-intelligence", name: "Artificial intelligence (AI)", label: "AI", category: "concept" },
  ] });

  for (const label of ["Model deployment", "Data science", "Generative AI", "Neural networks", "AI"]) {
    assert.match(markup, new RegExp(`>${label}<`));
  }
  assert.doesNotMatch(markup, />(?:ModelDeploy|DataScience|GenAI|NeuralNetworks)</);
  assert.match(markup, /title="Model deployment · Methods" aria-label="Model deployment, Methods"/);
});

test("card skills retain complete bundles but render only languages and stack", () => {
  assert.deepEqual(SKILL_BUNDLES, [
    { key: "languages", label: "Languages", categories: ["language"] },
    { key: "stack", label: "Stack", categories: ["framework", "library", "datastore"] },
    { key: "systems", label: "Systems", categories: ["platform", "tool", "protocol", "format", "hardware"] },
    { key: "knowledge", label: "Knowledge", categories: ["method", "concept"] },
    { key: "other", label: "Other", categories: [] },
  ]);
  const job = { skills: [
    { id: "legacy", name: "Legacy", label: "Legacy", category: "retired" },
    { id: "postgresql", name: "PostgreSQL", label: "Postgres", category: "datastore" },
    { id: "pytorch", name: "PyTorch", label: "PyTorch", category: "library" },
    { id: "react", name: "React", label: "React", category: "framework" },
    { id: "cpp", name: "C++", label: "C++", category: "language" },
    { id: "python", name: "Python", label: "Python", category: "language" },
    { id: "git", name: "Git", label: "Git", category: "tool" },
    { id: "linux", name: "Linux", label: "Linux", category: "platform" },
    { id: "ai", name: "Artificial intelligence", label: "AI", category: "concept" },
  ] };

  assert.deepEqual(skillBundles(job).map(bundle => [bundle.key, bundle.skills.map(skill => skill.id)]), [
    ["languages", ["cpp", "python"]],
    ["stack", ["react", "pytorch", "postgresql"]],
    ["systems", ["linux", "git"]],
    ["knowledge", ["ai"]],
    ["other", ["legacy"]],
  ]);
  const markup = listTags(job);
  assert.match(markup, /class="tag tag-languages"[^>]*>C\+\+<.*class="tag tag-languages"[^>]*>Python<.*class="tag tag-stack"[^>]*>React<.*class="tag tag-stack"[^>]*>PyTorch<.*class="tag tag-stack"[^>]*>Postgres</);
  assert.doesNotMatch(markup, /tag-(?:systems|knowledge|other)|>Linux<|>Git<|>AI<|>Legacy</);
  assert.doesNotMatch(listTags({ skills: job.skills.filter(skill => ["language", "concept"].includes(skill.category)) }), /tag-(?:stack|knowledge)|>AI</);
});

test("card chips expose canonical identity, category, and accessible names", () => {
  const tags = listTags({ skills: [
    { id: "react", name: "React", label: "React", category: "framework" },
    { id: "python", name: "Python", label: "Python", category: "language" },
  ] });

  assert.match(tags, /^<span class="tag tag-languages" data-skill-id="python" data-skill-category="language"/);
  assert.match(tags, /title="Python · Languages" aria-label="Python, Languages">Python</);
  assert.match(tags, /class="tag tag-stack" data-skill-id="react" data-skill-category="framework"/);
  assert.match(tags, /title="React · Frameworks" aria-label="React, Frameworks">React</);
  assert.doesNotMatch(tags, /skill-bundle|skill-bundle-title/);
});

test("formats public job metadata into reader-facing labels", () => {
  assert.equal(sourceLabel("greenhouse:example"), "Greenhouse");
  assert.equal(sourceLabel("smartrecruiters:example"), "SmartRecruiters");
  assert.equal(sourceLabel("custom_board:example"), "Custom Board");
  assert.equal(workplaceLabel("hybrid"), "Hybrid");
  assert.equal(workplaceLabel("unknown"), "");
});

test("every distinct posting URL is a way in, vendor repeats included", () => {
  const choices = linkChoices({
    source: "oracle:eevd.fa.us6/cx_14001",
    apply_url: "https://eevd.example/cx_14001/job",
    posted_at: "2026-08-18T00:00:00Z",
    other_sources: [
      { source: "oracle:eevd.fa.us6/cx_1", url: "https://eevd.example/cx_1/job" },
      { source: "workday:acme", url: "https://workday.example/job" },
      { source: "lever:acme", url: "javascript:alert(1)" },
      { source: "workday:mirror", url: "https://workday.example/job" },
    ],
  });
  assert.deepEqual(choices.map(choice => choice.url), [
    "https://eevd.example/cx_14001/job",
    "https://eevd.example/cx_1/job",
    "https://workday.example/job",
  ]);
  // Two career sites of one tenant read the same by name, so the board says which.
  assert.deepEqual(choices.map(choice => choice.board), ["cx_14001", "cx_1", ""]);
});

test("the posting link is one click, and a chevron appears only when it is listed twice", () => {
  const now = new Date("2026-08-18T12:00:00Z");
  const single = openMarkup({ id: 1, source: "greenhouse:acme", apply_url: "https://greenhouse.example/job" }, {}, now);
  assert.match(single, /^<a class="button open-link" href="https:\/\/greenhouse\.example\/job" target="_blank" rel="noopener noreferrer"[^>]*><span>Apply<\/span>/);
  assert.doesNotMatch(single, /open-more|open-split/);

  const job = {
    id: 2,
    source: "greenhouse:acme",
    apply_url: "https://greenhouse.example/job",
    last_seen_at: "2026-08-18T07:00:00Z",
    other_sources: [{ source: "lever:acme", url: "https://lever.example/job", posted_at: "2026-08-17T00:00:00Z" }],
  };
  const split = openMarkup(job, {}, now);
  assert.match(split, /class="open-split"><a class="button open-link" href="https:\/\/greenhouse\.example\/job"/);
  assert.match(split, /class="button open-more"[^>]*aria-haspopup="menu" aria-expanded="false" aria-label="1 other link"/);
  // No count on the button itself: the chevron's presence says it all.
  assert.doesNotMatch(split, /\+1|link-menu/);

  const open = openMarkup(job, { links: true }, now);
  assert.match(open, /class="pop link-menu" role="menu"[^>]*><p>Listed 2 times<\/p>/);
  assert.match(open, /<b>Greenhouse<\/b><small>checked 5h ago<\/small>/);
  assert.match(open, /<b>Lever<\/b><small>Posted yesterday<\/small>/);
  assert.equal(openMarkup({ id: 3 }, {}, now), "");
});

test("the approved action order is Apply, Add to Applied, then Skip, with Report in the header", () => {
  const job = {
    id: 7,
    company: "Lyft",
    title: "Applied Scientist Intern",
    source: "greenhouse:lyft",
    apply_url: "https://greenhouse.example/7",
    locations: [{ country: "US", state: "CA", city: "San Francisco" }, { country: "US", state: "NY", city: "New York" }],
    summary: "Build rider agents.",
  };
  const pane = detailPaneMarkup(job);
  assert.match(pane, /<div class="detail-actions"><a class="button open-link"[^>]*>.*<span>Apply<\/span>.*<\/a><button class="button primary" type="button" data-action="add-to-applications" data-id="7"[^>]*>.*<span>Add to Applied<\/span><\/button><span class="action-divider" aria-hidden="true"><\/span><span class="skip-wrap"><button class="button skip" type="button" data-action="skip" data-id="7" aria-haspopup="menu" aria-expanded="false"/);
  assert.doesNotMatch(pane, /skip-menu|skip-notice/);
  assert.match(pane, /class="detail-flag" type="button" data-action="report" aria-expanded="false" aria-label="Mislabeled"/);
  assert.match(pane, /<div class="detail-company" title="Lyft">Lyft<\/div>/);
  assert.match(pane, /class="detail-place">.*<span>San Francisco, CA<\/span><button class="place-more"[^>]*aria-label="Show all 2 locations">\+1<\/button>/);
  assert.match(pane, /<h3>About the role<\/h3><p class="role-summary">Build rider agents\.<\/p>/);
  assert.doesNotMatch(pane, /data-key="[^"]*"[^>]*>[^<]*<kbd/, "key hints live in tooltips, never inside a button");

  const places = detailPaneMarkup(job, { ui: { places: true } });
  assert.match(places, /class="pop place-menu" role="dialog" aria-label="Locations"><p>2 locations<\/p>/);

  const report = reportMarkup(job, { rows: { focus: { on: true, to: "Finance" } } });
  assert.match(report, /<h2 id="report-title">Report details<\/h2>/);
  assert.match(report, /data-fix-select="focus"/);
  assert.match(report, /<option value="Finance" selected>Finance<\/option>/);
  assert.match(report, /data-action="report-submit">/);
  assert.match(reportMarkup(job, { rows: {} }), /data-action="report-submit" disabled>/);
  assert.doesNotMatch(detailPaneMarkup(job, { ui: { report: { rows: {} } } }), /id="report-form"/);

  const hidden = detailPaneMarkup(job, { hidden: { kind: "skip", skip_reason: "level" } });
  assert.match(hidden, /class="hidden-banner"><svg aria-hidden="true"><use href="#icon-eye-off"\/><\/svg><p>Skipped · Level<\/p><button class="button" type="button" data-action="restore" data-id="7"/);
  assert.doesNotMatch(hidden, /detail-actions|detail-flag/);
});

test("locations come from the full array, so every place can be listed", () => {
  assert.deepEqual(placeList({ locations: [
    { country: "US", state: "CA", city: "San Jose" },
    { country: "US", state: "IA", city: null },
    { country: "US", state: "CA", city: "San Jose" },
    { country: "GB", state: null, city: "London" },
    { country: "US", state: null, city: null },
  ] }), ["San Jose, CA", "Iowa", "London, GB", "United States"]);
  assert.deepEqual(placeList({ locations: [], location: "Remote" }), ["Remote"]);
  assert.deepEqual(placeList({}), ["Location not listed"]);
  const card = cardMetaMarkup({ locations: [
    { country: "US", state: "VA", city: "Chantilly" },
    { country: "US", state: "CA", city: "El Segundo" },
  ] });
  assert.match(card, /<span class="card-location">Chantilly, VA \+1<\/span>/);
});

test("expertise on a quarter of loaded postings folds behind +N common", () => {
  const ai = { id: "ai", name: "Artificial intelligence (AI)", label: "AI", category: "concept" };
  const causal = { id: "causal", name: "Causal inference", label: "CausalInference", category: "method" };
  const python = { id: "python", name: "Python", label: "Python", category: "language" };
  const jobs = Array.from({ length: 60 }, (_, index) => ({ skills: index < 20 ? [ai, python] : [python] }));
  jobs[0].skills.push(causal);
  const common = commonTerms(jobs);
  assert.deepEqual([...common.keys()], ["ai"], "python is a skill, not expertise, and causal inference is rare");
  assert.equal(Math.round(common.get("ai") * 100), 33);
  assert.equal(commonTerms(jobs.slice(0, 49)).size, 0, "too few postings to call anything common");

  const folded = detailSkillsMarkup(jobs[0], { common });
  assert.match(folded, />Causal inference<\/span><button class="more-link" type="button" data-action="toggle-common" aria-expanded="false">\+1 common<\/button>/);
  assert.doesNotMatch(folded, />AI</);
  const expanded = detailSkillsMarkup(jobs[0], { common, expanded: true });
  assert.match(expanded, /class="expertise-term common"[^>]*title="Artificial intelligence \(AI\) · on 33% of loaded postings"[^>]*>AI<\/span><button[^>]*>Hide common</);
  assert.match(detailSkillsMarkup({ skills: [ai] }, { common }), />Show 1 common term</);
});

test("the Hidden list names why each posting left the feed", () => {
  assert.deepEqual(SKIP_REASONS.map(reason => reason.key), ["level", "location", "field", "company"]);
  assert.equal(hiddenReason({ kind: "skip" }), "Skipped");
  assert.equal(hiddenReason({ kind: "skip", skip_reason: "location" }), "Skipped · Location");
  assert.equal(hiddenReason({ kind: "mislabeled", corrections: [{ field: "focus", from: "Software", to: "Finance" }] }), "Mislabeled · Focus: Software → Finance");
  assert.equal(hiddenReason({ kind: "mislabeled", corrections: [{ field: "company", from: "x", to: null }] }), "Mislabeled · Company");
  assert.equal(hiddenReason({ kind: "mislabeled", corrections: [{ field: "type", from: "a" }, { field: "skills", from: "b" }] }), "Mislabeled · Job type, Skills");

  const rows = reportRows({ job_type: "intern", job_domain: null, company: "Lyft", locations: [] , location: "Remote" });
  assert.deepEqual(rows.map(row => [row.field, row.value]), [
    ["type", "Internship"], ["focus", "Unlabeled"], ["company", "Lyft"], ["location", "Remote"], ["skills", "Skills and expertise list"],
  ]);
  assert.ok(!rows[0].options.includes("Internship"));

  // The server's `focus` wins over the stored domain, so a BioTech match is
  // reported as BioTech rather than the "Unlabeled" Gold domain.
  const bio = reportRows({ job_type: "coop", job_domain: "unlabeled", focus: "biotech", company: "sanofi", locations: [] });
  assert.equal(bio.find(row => row.field === "focus").value, "BioTech");
  assert.ok(!bio.find(row => row.field === "focus").options.includes("BioTech"));
  assert.equal(reportRows({ job_domain: "software", locations: [] }).find(row => row.field === "focus").value, "Software");
  // Stored bioengineering chips label as MedTech and Regulatory too.
  assert.equal(reportRows({ job_domain: "unlabeled", focus: "med_device", locations: [] }).find(row => row.field === "focus").value, "MedTech");
  assert.equal(reportRows({ job_domain: "unlabeled", focus: "clinical_affairs", locations: [] }).find(row => row.field === "focus").value, "Regulatory");
});

test("company initials handle short, multiword and missing names", () => {
  assert.equal(initials({ company: "SAP" }), "SA");
  assert.equal(initials({ company: "Jane Street" }), "JS");
  assert.equal(initials({}), "?");
});

test("the card mark prefers the harvested logo and falls back to a company icon", () => {
  const withLogo = logoMarkup({ company: "Blue Origin", logo: "/api/companies/42/logo" });
  assert.match(withLogo, /<img class="job-logo-mark" src="\/api\/companies\/42\/logo"/);
  // Decorative: the company name is already the line above it, so a screen
  // reader that announced the mark too would read the employer twice.
  assert.match(withLogo, /alt=""/);
  assert.match(withLogo, /loading="lazy"/);
  assert.doesNotMatch(withLogo, /BO/);

  // Missing logos share one decorative company icon, including missing names.
  const fallback = logoMarkup({ company: "Blue Origin", logo: null });
  assert.match(fallback, /<svg class="company-logo-fallback"[^>]*aria-hidden="true"/);
  assert.doesNotMatch(fallback, /<img|BO/);
  assert.equal(logoMarkup({ company: "Valon" }), fallback);
  assert.equal(logoMarkup({}), fallback);

  // A src the server did not issue never reaches the DOM, so a poisoned
  // payload cannot turn every card into a beacon to someone else's host.
  assert.equal(logoSrc("https://evil.example/pixel.png"), "");
  assert.equal(logoSrc("//evil.example/pixel.png"), "");
  assert.equal(logoSrc("/api/companies/7/logo"), "/api/companies/7/logo");
  assert.equal(logoMarkup({ company: "Valon", logo: "https://evil.example/x.png" }), fallback);
});

test("the company logo is contained in the original row tile rather than cropped", () => {
  const styles = fs.readFileSync(require.resolve("../../web/discover/desktop.css"), "utf8");
  assert.match(styles, /\.job-logo-mark \{[^}]*object-fit: contain/);
  assert.match(styles, /\.job-logo \{ width: 32px; height: 32px/);
  const design = fs.readFileSync(require.resolve("../../web/discover/desktop.js"), "utf8");
  assert.match(design, /<div class="job-logo">\$\{logoMarkup\(job\)\}<\/div>/);
});


test("the details table preserves all skills and Posted metadata lives in the card footer", () => {
  const job = {
    source: "ashby:acme", posted_at: "2026-10-05T12:00:00Z", first_seen_at: "2026-10-04T12:00:00Z",
    last_seen_at: "2026-10-06T12:00:00Z",
    attributes: { degree: ["cs", "mathematics"] },
    skills: [
      { id: "go", name: "Go", label: "Go", category: "language" },
      { id: "kubernetes", name: "Kubernetes", label: "Kubernetes", category: "platform" },
      { id: "ml", name: "Machine learning", label: "Machine learning", category: "concept" },
      { id: "custom", name: "A < B", label: "A < B", category: null },
    ],
  };
  const markup = detailFactsMarkup(job);
  assert.ok(markup.indexOf("Languages") < markup.indexOf("Tools"));
  for (const value of ["Go", "Kubernetes", "Machine learning", "A &lt; B"]) assert.ok(markup.includes(value), value);
  assert.doesNotMatch(markup, /A < B|<dt>Degree|<dt>First seen|<dt>Last checked|<dt>Posted/);
  const pane = detailPaneMarkup(job);
  assert.match(pane, /<footer class="detail-footer"><dl><div class="detail-fact"><dt>Posted<\/dt><dd>Oct 5, 2026 on Ashby<\/dd><\/div><\/dl><\/footer><\/div>$/);
});

test("missing posting fields never turn into invented facts or invalid dates", () => {
  const job = { source: "lever:acme", posted_at: "bad-date", attributes: {} };
  assert.equal(detailFactsMarkup(job), "");
  const markup = detailPaneMarkup(job);
  assert.match(markup, /<dt>Posted<\/dt><dd>On Lever<\/dd>/);
  assert.doesNotMatch(markup, /Invalid Date|First seen|Degree|Languages|Tools|Last checked/);
});

test("Skip asks why first: its menu lists the reasons, and each pick is the skip", () => {
  const job = { id: 7, company: "Lyft", title: "Intern", source: "greenhouse:lyft", apply_url: "https://greenhouse.example/7", locations: [] };
  const open = detailPaneMarkup(job, { skipMenu: { id: 7, where: "pane" } });
  assert.match(open, /data-action="skip" data-id="7" aria-haspopup="menu" aria-expanded="true">/);
  assert.match(open, /<div class="pop skip-menu at-pane" role="menu" aria-label="Skip reason"><p>Why skip it\?<\/p>/);
  const picks = [...open.matchAll(/class="opt" type="button" role="menuitem" data-why="([a-z]+)" data-id="7"><span>([A-Za-z]+)<\/span><kbd aria-hidden="true">(\d)<\/kbd>/g)].map(match => match.slice(1));
  assert.deepEqual(picks, [["level", "Level", "1"], ["location", "Location", "2"], ["field", "Field", "3"], ["company", "Company", "4"]]);
  // The open menu has no hover hint competing with it.
  assert.doesNotMatch(open, /data-action="skip"[^>]*data-tip/);
  assert.match(skipMenuMarkup(9, "row"), /^<div class="pop skip-menu at-row"/);
});

test("a skip's Undo sits in the button row, right after Skip", () => {
  const job = { id: 8, company: "Ramp", title: "Intern", source: "greenhouse:ramp", apply_url: "https://greenhouse.example/8", locations: [] };
  const notice = { job: { company: "Lyft & Co" }, label: "Skipped · Location" };
  const pane = detailPaneMarkup(job, { skipNotice: notice });
  assert.match(pane, /<\/span><span class="skip-notice" role="status" aria-label="Skipped · Location: Lyft &amp; Co"><span>Skipped · Location<\/span><button type="button" data-action="undo" aria-label="Undo skipping Lyft &amp; Co">Undo<\/button><\/span><\/div>/);
  assert.equal(skipNoticeMarkup(null), "");
});

test("a skip and its reason are one write, and the flash no longer offers reasons", () => {
  const design = fs.readFileSync(require.resolve("../../web/discover/desktop.js"), "utf8");
  assert.match(design, /hideJob\(job, \{ kind: "skip", skip_reason: reason\.key \}, `Skipped · \$\{reason\.label\}`\)/);
  assert.doesNotMatch(design, /flash-why|flash-reason|giveReason|kind: "skip" \}/);
  const styles = fs.readFileSync(require.resolve("../../web/discover/desktop.css"), "utf8");
  assert.doesNotMatch(styles, /flash-why|flash-reason|near-skip/);
});

test("a list row shows at most six skills, then +N", () => {
  const skill = (id, category) => ({ id, name: id, label: id, category });
  const many = { skills: ["Go", "Rust", "C", "Java", "Kotlin", "Swift"].map(id => skill(id, "language")).concat([skill("React", "framework"), skill("Redis", "datastore")]) };
  const tags = listTags(many);
  assert.equal((tags.match(/class="tag tag-(?:languages|stack)"/g) || []).length, 6);
  assert.match(tags, /<span class="tag tag-more" aria-label="2 more skills">\+2<\/span>$/);
  const few = listTags({ skills: [skill("Go", "language"), skill("React", "framework")] });
  assert.doesNotMatch(few, /tag-more/);
});

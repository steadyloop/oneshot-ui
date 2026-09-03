// recencyBucket now buckets in the viewer's zone; pin one so the fixtures below
// mean the same thing on every machine. Must precede the app.js require.
process.env.TZ = "America/Los_Angeles";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {
  FILTERS,
  DEGREE_FILTERS,
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
  sourceChoices,
  sourceDisclosureMarkup,
  relativeTime,
  workplaceLabel,
  listFacts,
  deadlineLabel,
  detailMetaMarkup,
  cardMetaMarkup,
  openPostingLabel,
  detailHeadMarkup,
  detailPostedMarkup,
  summaryMarkup,
  initials,
  logoSrc,
  logoMarkup,
  cardStatusLine,
  recencyBucket,
} = require("./app.js");

test("V2 job type tabs default to all student opportunities", () => {
  const counts = { intern: 42, coop: 7, student: 11, new_grad: 5, research: 3 };
  assert.deepEqual(FILTERS.map(filter => filter.label), ["All", "Internships", "Co-ops", "Student Jobs", "New Grad"]);
  assert.equal(tabCount(counts, FILTERS[0]), 68);
  assert.equal(tabCount(counts, FILTERS[1]), 42);
  assert.equal(tabCount(counts, FILTERS[2]), 7);
  assert.equal(tabCount(counts, FILTERS[3]), 11);
  assert.equal(tabCount(counts, FILTERS[4]), 5);
  const design = fs.readFileSync(require.resolve("./app.js"), "utf8");
  assert.match(design, /class="filter-count"/);
  assert.match(design, /payload\.job_type_counts/);
  assert.match(design, /filters: \["all"\]/);
});

test("V2 labels the outer recency buckets by calendar day", () => {
  const now = new Date("2026-08-21T18:00:00Z");
  assert.deepEqual(recencyBucket({ posted_at: "2026-08-21T16:00:00Z" }, now), {
    key: "2026-08-21", label: "Opened today",
  });
  assert.deepEqual(recencyBucket({ posted_at: "2026-08-20T16:00:00Z" }, now), {
    key: "2026-08-20", label: "Opened yesterday",
  });
  assert.equal(recencyBucket({ first_seen_at: "2026-08-19T16:00:00Z" }, now).label, "Opened Aug 19");
  assert.equal(recencyBucket({}, now).label, "Date unavailable");
  const design = fs.readFileSync(require.resolve("./app.js"), "utf8");
  assert.match(design, /class="recency-bucket"/);
});

test("V2 exposes the three bio-career focus filters", () => {
  // Keys are the API's degree_field values (VALID_DEGREE_FIELDS in
  // oneshot_ui/repository.py); anything else is rejected with 400.
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
  const design = fs.readFileSync(require.resolve("./app.js"), "utf8");
  assert.match(design, /degreeFilters: \["software"\]/);
  assert.match(design, /Focus area mentioned/);
  assert.match(design, /data-degree-filter/);
  assert.match(design, /degree_field: degreeFields\(state\.degreeFilters\)/);
});

test("V2 renders canonical skill metadata and keeps legacy string compatibility", () => {
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

test("V2 skill section escapes labels and stays hidden when empty", () => {
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

test("V2 detail shows every skill while the card keeps only language and stack", () => {
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

test("V2 orders every skill by category then label within peer detail sections", () => {
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

test("V2 detail presents methods and concepts as one low-emphasis expertise flow", () => {
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

  const styles = fs.readFileSync(require.resolve("./styles.css"), "utf8");
  assert.match(styles, /\.detail-skill-section \.skill-list \{[^}]*display: flex[^}]*flex-wrap: wrap[^}]*margin-top: 9px/);
  assert.match(styles, /\.expertise-list \{[^}]*display: flex[^}]*flex-wrap: wrap[^}]*gap: 5px[^}]*color: #667168[^}]*font: 500 10px\/1\.4 var\(--sans\)/);
  assert.match(styles, /\.expertise-term \{[^}]*max-width: 100%[^}]*display: inline-flex[^}]*border-radius: 4px[^}]*background: #f1f3ef[^}]*padding: 2px 6px[^}]*white-space: normal/);
  assert.doesNotMatch(styles, /\.expertise-term[^}]*::(?:before|after)/);
  assert.doesNotMatch(styles, /\.expertise-term\[data-skill-category="method"\]/);
  assert.doesNotMatch(styles, /\.expertise-term(?:\[[^\]]+\])? \{[^}]*linear-gradient/);
});

test("V2 expertise expands raw compact compounds into polished canonical labels", () => {
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

test("V2 detail skills reuse the green taxonomy tones", () => {
  const styles = fs.readFileSync(require.resolve("./styles.css"), "utf8");
  assert.match(styles, /\.detail-skill-section \.skill\[data-skill-category="language"\] \{[^}]*#e3f2e8[^}]*#d8eadf[^}]*color: #1f6848/);
  assert.match(styles, /\.detail-skill-section \.skill\[data-skill-category="library"\][\s\S]*#e8f2eb[^}]*#deebe3[^}]*color: #3b634d/);
  assert.match(styles, /\.detail-skill-section \.skill\[data-skill-category="platform"\][\s\S]*#f0f5f1[^}]*#e7eee9[^}]*color: #4f6658/);
});

test("V2 card skills retain complete bundles but render only languages and stack", () => {
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

test("V2 card chips expose canonical identity, category, and accessible names", () => {
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

test("V2 card skill bundles use two green tones without visible field labels", () => {
  const styles = fs.readFileSync(require.resolve("./styles.css"), "utf8");
  assert.match(styles, /\.tags \{[^}]*display: flex[^}]*flex-wrap: wrap/);
  assert.doesNotMatch(styles, /\.skill-bundle \{/);
  assert.doesNotMatch(styles, /\.skill-bundle-title/);
  assert.match(styles, /\.skill \{ background: #edeee8; color: var\(--muted\); \}/);
  assert.match(styles, /\.tag-languages \{[^}]*linear-gradient\([^}]*#e3f2e8[^}]*#d8eadf[^}]*color: #1f6848/);
  assert.match(styles, /\.tag-stack \{[^}]*linear-gradient\([^}]*#f0f5f1[^}]*#e7eee9[^}]*color: #4f6658/);
  assert.match(styles, /font: 600 10px\/1\.25 var\(--mono\)/);
  assert.doesNotMatch(styles, /(?:tag|skill):first-child/);
});

test("V2 formats public job metadata into reader-facing labels", () => {
  assert.equal(sourceLabel("greenhouse:example"), "Greenhouse");
  assert.equal(sourceLabel("smartrecruiters:example"), "SmartRecruiters");
  assert.equal(sourceLabel("custom_board:example"), "Custom Board");
  assert.equal(workplaceLabel("hybrid"), "Hybrid");
  assert.equal(workplaceLabel("unknown"), "");
});

test("V2 quietly reduces alternate postings to usable distinct providers", () => {
  const choices = sourceChoices({
    source: "greenhouse:acme",
    apply_url: "https://greenhouse.example/job",
    posted_at: "2026-08-18T00:00:00Z",
    other_sources: [
      { source: "greenhouse:mirror", url: "https://greenhouse.example/mirror" },
      { source: "workday:acme", url: "https://workday.example/job", posted_at: "2026-08-17T00:00:00Z" },
      { source: "lever:acme", url: "javascript:alert(1)" },
      { source: "custom_board:acme", url: "https://custom.example/job" },
      { source: "workday:older", url: "https://workday.example/older" },
    ],
  });
  assert.deepEqual(choices.map(choice => choice.label), ["Greenhouse", "Workday", "Custom Board"]);
  assert.deepEqual(choices.map(choice => choice.url), [
    "https://greenhouse.example/job",
    "https://workday.example/job",
    "https://custom.example/job",
  ]);
});

test("V2 source disclosure is absent for one provider and muted behind an accessible control", () => {
  assert.deepEqual(sourceDisclosureMarkup({
    id: 1,
    source: "greenhouse:acme",
    apply_url: "https://greenhouse.example/job",
    other_sources: [{ source: "greenhouse:mirror", url: "https://greenhouse.example/mirror" }],
  }), { inline: "", panel: "" });

  const now = new Date("2026-08-18T12:00:00Z");
  const markup = detailPostedMarkup({
    id: 'unsafe"id',
    source: "greenhouse:acme",
    apply_url: "https://greenhouse.example/job",
    posted_at: "2026-08-18T00:00:00Z",
    other_sources: [
      { source: "workday:acme", url: "https://workday.example/job", posted_at: "2026-08-17T00:00:00Z" },
    ],
  }, now);
  assert.match(markup, />2 sources<\/button>/);
  assert.match(markup, /data-action="toggle-sources"/);
  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, /aria-controls="job-sources-unsafe-id"/);
  assert.match(markup, /id="job-sources-unsafe-id"[^>]*hidden/);
  assert.match(markup, /Also available on/);
  assert.match(markup, /Workday ↗/);
  assert.match(markup, /Posted yesterday/);
  assert.doesNotMatch(markup, /duplicate|primary/i);
});

test("V2 omits the old type badge and fact-grid treatment", () => {
  const design = fs.readFileSync(require.resolve("./app.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("./styles.css"), "utf8");
  assert.doesNotMatch(design, /Summer internship|At a glance|badgesMarkup|factsMarkup/);
  assert.doesNotMatch(styles, /detail-badge|fact-grid/);
});

test("V2 renders only the deterministic role summary", () => {
  assert.equal(
    summaryMarkup({ summary: "Build <safe> services & ship them." }),
    '<p class="role-summary">Build &lt;safe&gt; services &amp; ship them.</p>',
  );
  assert.match(summaryMarkup({ summary: null }), /Summary unavailable/);

  const design = fs.readFileSync(require.resolve("./app.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("./styles.css"), "utf8");
  assert.match(design, /Role summary/);
  assert.doesNotMatch(design, /job\.description|Show full description|toggle-description|expandedDescriptions/);
  assert.match(styles, /\.role-summary/);
  assert.doesNotMatch(styles, /description-shell|description-toggle|description-body/);
});

test("V2 provenance protects links and handles verification failures", () => {
  assert.equal(safeHref("https://example.com/job"), "https://example.com/job");
  assert.equal(safeHref("javascript:alert(1)"), "");
  assert.equal(relativeTime("not-a-date"), "Verification unavailable");
});

test("V2 leads the detail with the posted date, not an always-true liveness chip", () => {
  const design = fs.readFileSync(require.resolve("./app.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("./styles.css"), "utf8");
  assert.doesNotMatch(design, /detail-freshness/);
  assert.doesNotMatch(styles, /detail-freshness/);
  assert.doesNotMatch(design, /class="provenance"/);

  // Polling makes every listing active, so the chip and its green are gone everywhere.
  assert.doesNotMatch(design, /status-chip/);
  assert.doesNotMatch(styles, /status-chip/);
  assert.doesNotMatch(design, /Active · confirmed/);
  assert.doesNotMatch(design, /live-dot/);
  assert.doesNotMatch(styles, /live-dot/);

  assert.match(styles, /\.posted-when \{[^}]*var\(--ink\)/);
  assert.match(styles, /\.posted-checked \{[^}]*var\(--faint\)/);
  assert.match(design, /detailHeadMarkup\(job\)\}<h2>/);
  assert.match(design, /detailMetaMarkup\(job\)\}\$\{detailPostedMarkup\(job\)\}<div class="detail-actions"/);
});

test("V2 action row ends where the role summary wraps instead of tracking the pane", () => {
  const styles = fs.readFileSync(require.resolve("./styles.css"), "utf8");
  // Both measures are 55ch at 11px, so the buttons and the summary share a right edge.
  assert.match(styles, /\.detail-actions \{[^}]*max-width: 55ch[^}]*font-size: 11px/);
  assert.match(styles, /\.role-summary \{[^}]*max-width: 55ch[^}]*font-size: 11px/);
  // Below 560px the row stacks and goes back to full width.
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*\.detail-actions \{ grid-template-columns: 1fr; max-width: none; \}/);
  // The pane column has a pixel ceiling and the canvas is sized to it, so neither
  // the sticky pane nor the cards stretch around empty space on wide screens.
  assert.match(styles, /\.view \{[^}]*max-width: 1320px[^}]*margin: 0;/);
  assert.match(styles, /\.discover-grid \{[^}]*grid-template-columns: minmax\(430px, 1fr\) minmax\(360px, 460px\)/);
});

test("V2 detail header carries the company and the location on one line, with no initials mark", () => {
  const markup = detailHeadMarkup({ company: "Manatal", location: "Bangkok, Thailand" });
  assert.match(markup, /class="detail-headline"/);
  assert.match(markup, /class="detail-company">Manatal</);
  assert.match(markup, /class="detail-fact detail-place">.*Bangkok, Thailand/);
  assert.match(markup, /#icon-pin/);
  assert.doesNotMatch(markup, /job-logo/);

  assert.match(detailHeadMarkup({ company: "Acme" }), /Location not listed/);

  const escaped = detailHeadMarkup({ company: "<b>", location: "<i>" });
  assert.match(escaped, /&lt;b&gt;/);
  assert.match(escaped, /&lt;i&gt;/);
  assert.doesNotMatch(escaped, /<b>|<i>/);
});

test("V2 detail meta row carries every fact the header does not, shown with scan icons, and formats the apply deadline", () => {
  assert.equal(deadlineLabel("2027-01-15"), "Apply by Jan 15, 2027");
  assert.equal(deadlineLabel(""), "");
  assert.equal(deadlineLabel("not-a-date"), "");

  const job = { location: "NYC", remote: "yes", attributes: { term: "Summer 2027", deadline_at: "2027-01-15" } };
  const markup = detailMetaMarkup(job);
  assert.match(markup, /class="detail-meta"/);
  ["Summer 2027", "Remote", "Apply by Jan 15, 2027"].forEach(label => assert.match(markup, new RegExp(label)));
  ["icon-calendar", "icon-globe", "icon-clock"].forEach(icon => assert.match(markup, new RegExp(`#${icon}`)));

  // Location moved up into the header, so it is the one fact the row must not repeat.
  assert.doesNotMatch(markup, /#icon-pin/);
  assert.doesNotMatch(markup, /NYC/);
  assert.match(detailHeadMarkup(job), /NYC/);
  listFacts(job).filter(fact => fact !== job.location).forEach(fact => assert.match(markup, new RegExp(fact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))));

  // With nothing but a location, the row disappears rather than rendering empty.
  assert.equal(detailMetaMarkup({ location: "NYC", attributes: {} }), "");
  assert.equal(detailMetaMarkup({}), "");

  const escaped = detailMetaMarkup({ attributes: { term: "<b>" } });
  assert.match(escaped, /&lt;b&gt;/);
  assert.doesNotMatch(escaped, /<b>/);
});

test("V2 card gives remote work a quiet cue distinct from skill chips", () => {
  const remote = cardMetaMarkup({
    location: "United States",
    remote: "yes",
    attributes: { term: "Summer 2027" },
  });
  assert.match(remote, /class="card-location">United States</);
  assert.match(remote, /class="workplace-cue" data-workplace="yes">/);
  assert.match(remote, /#icon-globe/);
  assert.match(remote, />Remote</);
  assert.match(remote, /class="card-term">Summer 2027</);
  assert.doesNotMatch(remote, /class="(?:tag|skill)"/);

  assert.match(cardMetaMarkup({ remote: "hybrid" }), /data-workplace="hybrid".*Hybrid/);
  assert.doesNotMatch(cardMetaMarkup({ remote: "unknown" }), /workplace-cue|icon-globe/);

  const escaped = cardMetaMarkup({ location: "<Anywhere>", remote: "yes" });
  assert.match(escaped, /&lt;Anywhere&gt;/);
  assert.doesNotMatch(escaped, /<Anywhere>/);
});

test("V2 opportunity metadata icons are defined in the shared icon sprite", () => {
  for (const page of ["../index.html"]) {
    const html = fs.readFileSync(require.resolve(page), "utf8");
    for (const icon of ["icon-pin", "icon-calendar", "icon-globe", "icon-clock"]) {
      assert.match(html, new RegExp(`id="${icon}"`));
    }
  }
});

test("V2 open-posting link states its source", () => {
  assert.equal(openPostingLabel({ source: "greenhouse:acme" }), "Open on Greenhouse");
  assert.equal(openPostingLabel({}), "Open posting");
  assert.equal(openPostingLabel({ source: "" }), "Open posting");
});

test("V2 posted row weights the date and trails the check only when last_seen_at is known", () => {
  const now = new Date("2026-08-18T12:00:00Z");
  const withCheck = detailPostedMarkup({ last_seen_at: "2026-08-18T07:00:00Z", posted_at: "2026-08-17T00:00:00Z" }, now);
  assert.match(withCheck, /class="posted-when">Posted yesterday</);
  assert.match(withCheck, /class="posted-checked">checked 5h ago</);

  // No check time means no trailing clause, and no dangling separator either.
  const withoutCheck = detailPostedMarkup({ posted_at: "2026-08-17T00:00:00Z" }, now);
  assert.match(withoutCheck, /class="posted-when">Posted yesterday</);
  assert.doesNotMatch(withoutCheck, /posted-checked|posted-sep/);

  // No posted_at falls back to when we first saw it.
  assert.match(detailPostedMarkup({ first_seen_at: "2026-08-17T00:00:00Z" }, now), /Added yesterday/);
});

test("V2 list card leads with company, drops the left accent, and states the posted date", () => {
  assert.equal(initials({ company: "SAP" }), "SA");
  assert.equal(initials({ company: "Jane Street" }), "JS");
  assert.equal(initials({ company: "" }), "?");
  assert.equal(initials({}), "?");

  const now = new Date("2026-08-18T12:00:00Z");
  assert.equal(
    cardStatusLine({ last_seen_at: "2026-08-18T07:00:00Z", posted_at: "2026-08-17T00:00:00Z" }, now),
    "Posted yesterday",
  );
  assert.equal(cardStatusLine({ posted_at: "2026-08-17T00:00:00Z" }, now), "Posted yesterday");
  assert.equal(cardStatusLine({}, now), "Date unavailable");

  const design = fs.readFileSync(require.resolve("./app.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("./styles.css"), "utf8");
  assert.match(design, /class="job-company-line"><div class="job-company">\$\{esc\(job\.company\)\}<\/div>.*<\/div><h3>\$\{esc\(job\.title\)\}<\/h3>/);
  assert.doesNotMatch(design, /class="job-title-line"/);
  assert.doesNotMatch(styles, /\.job-title-line/);
  assert.doesNotMatch(styles, /inset 3px 0 0/);
  assert.match(styles, /\.opportunity\.selected \{[^}]*border-color: var\(--green\)/);
});

test("V2 is the main Opportunities design and exposes accessible source disclosure", () => {
  const main = fs.readFileSync(require.resolve("../index.html"), "utf8");
  const design = fs.readFileSync(require.resolve("./app.js"), "utf8");
  assert.match(main, /\/static\/opportunities\/styles\.css\?v=skill-bundles-/);
  assert.match(main, /\/static\/opportunities\/app\.js\?v=skill-bundles-/);
  // The versioned directories are gone; no shell may still point at them.
  assert.doesNotMatch(main, /opportunities-v[23]|Opportunities \(v[23]\)/);
  assert.match(main, /class="active" href="\/" aria-current="page"/);
  assert.doesNotMatch(design, /Design preview|View current Opportunities/);
  assert.match(design, /aria-controls=/);
  assert.match(design, /aria-expanded=/);
  assert.match(design, /data-action="toggle-sources"/);
  assert.doesNotMatch(design, /Show full description|Show less/);
});

test("the card mark prefers the harvested logo and falls back to initials", () => {
  const withLogo = logoMarkup({ company: "Blue Origin", logo: "/api/companies/42/logo" });
  assert.match(withLogo, /<img class="job-logo-mark" src="\/api\/companies\/42\/logo"/);
  // Decorative: the company name is already the line above it, so a screen
  // reader that announced the mark too would read the employer twice.
  assert.match(withLogo, /alt=""/);
  assert.match(withLogo, /loading="lazy"/);
  assert.doesNotMatch(withLogo, /BO/);

  // No logo harvested is the common case, not an error state.
  assert.equal(logoMarkup({ company: "Blue Origin", logo: null }), "BO");
  assert.equal(logoMarkup({ company: "Valon" }), "VA");

  // A src the server did not issue never reaches the DOM, so a poisoned
  // payload cannot turn every card into a beacon to someone else's host.
  assert.equal(logoSrc("https://evil.example/pixel.png"), "");
  assert.equal(logoSrc("//evil.example/pixel.png"), "");
  assert.equal(logoSrc("/api/companies/7/logo"), "/api/companies/7/logo");
  assert.equal(logoMarkup({ company: "Valon", logo: "https://evil.example/x.png" }), "VA");
});

test("the logo mark is contained in the 40px box rather than cropped to it", () => {
  const styles = fs.readFileSync(require.resolve("./styles.css"), "utf8");
  assert.match(styles, /\.job-logo-mark \{[^}]*object-fit: contain/);
  assert.match(styles, /\.job-logo-mark \{[^}]*box-sizing: border-box/);
  const design = fs.readFileSync(require.resolve("./app.js"), "utf8");
  assert.match(design, /<div class="job-logo">\$\{logoMarkup\(job\)\}<\/div>/);
});

(function (root) {
  "use strict";

  const FILTERS = [
    { key: "internships", label: "Internships", types: ["intern"] },
    { key: "coops", label: "Co-ops", types: ["coop"] },
    { key: "students", label: "Student jobs", types: ["student"] },
    { key: "new_grads", label: "New grad", types: ["new_grad"] },
    { key: "research", label: "Research", types: ["research"] },
  ];
  const DEGREE_FILTERS = [
    { key: "software", label: "Software" },
    { key: "finance", label: "Finance" },
    { key: "med_device", label: "MedTech" },
    { key: "biotech", label: "BioTech" },
    { key: "clinical_affairs", label: "Regulatory" },
    { key: "unlabeled", label: "Unlabeled" },
  ];
  const SOURCE_LABELS = {
    adp: "ADP",
    ashby: "Ashby",
    greenhouse: "Greenhouse",
    icims: "iCIMS",
    lever: "Lever",
    smartrecruiters: "SmartRecruiters",
    workday: "Workday",
    "workday-list": "Workday (list)",
  };
  const SKILL_CATEGORIES = [
    { key: "language", label: "Languages" },
    { key: "framework", label: "Frameworks" },
    { key: "library", label: "Libraries" },
    { key: "platform", label: "Platforms" },
    { key: "tool", label: "Tools" },
    { key: "datastore", label: "Datastores" },
    { key: "protocol", label: "Protocols" },
    { key: "format", label: "Formats" },
    { key: "hardware", label: "Hardware" },
    { key: "method", label: "Methods" },
    { key: "concept", label: "Concepts" },
  ];
  const SKILL_BUNDLES = [
    { key: "languages", label: "Languages", categories: ["language"] },
    { key: "stack", label: "Stack", categories: ["framework", "library", "datastore"] },
    { key: "systems", label: "Systems", categories: ["platform", "tool", "protocol", "format", "hardware"] },
    { key: "knowledge", label: "Knowledge", categories: ["method", "concept"] },
    { key: "other", label: "Other", categories: [] },
  ];
  const SKILL_BUNDLE_BY_CATEGORY = new Map(
    SKILL_BUNDLES.flatMap(bundle => bundle.categories.map(category => [category, bundle.key])),
  );
  const SKILL_CATEGORY_BY_KEY = new Map(
    SKILL_CATEGORIES.map((category, index) => [category.key, { ...category, index }]),
  );
  const CONCRETE_SKILL_CATEGORIES = new Set([
    "language", "framework", "library", "datastore", "platform", "tool", "protocol", "format", "hardware",
  ]);
  const EXPERTISE_SKILL_CATEGORIES = new Set(["method", "concept"]);
  const UNKNOWN_SKILL_CATEGORY = { key: "unknown", label: "Other", index: SKILL_CATEGORIES.length };
  const PAGE_SIZE = 100;
  const seasonFilter = value => ["fall", "winter"].includes(value) ? value : "";
  const sortOrder = value => seasonFilter(value) ? "fresh" : value;
  const jobTypes = filters => filters.flatMap(key => FILTERS.find(filter => filter.key === key)?.types || []);
  const degreeFields = filters => filters.filter(key => DEGREE_FILTERS.some(filter => filter.key === key));
  const tabCount = (counts, filter) => filter.types.reduce(
    (total, type) => total + Math.max(0, Number(counts?.[type]) || 0), 0,
  );
  const esc = value => String(value == null ? "" : value).replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
  const safeHref = value => /^https?:\/\//i.test(String(value || "")) ? String(value) : "";
  const attributes = job => job?.attributes || {};
  function skillDetails(job) {
    const values = Array.isArray(job?.skills) ? job.skills : attributes(job).skills;
    if (!Array.isArray(values)) return [];
    const seen = new Set();
    return values.flatMap(value => {
      const structured = value && typeof value === "object" && !Array.isArray(value);
      const name = String(structured ? value.name || value.label || "" : typeof value === "string" ? value : "").trim();
      if (!name) return [];
      const id = String(structured ? value.id || name : name).trim();
      if (!id || seen.has(id)) return [];
      seen.add(id);
      const label = String(structured ? value.label || name : name).trim() || name;
      const category = structured && typeof value.category === "string" && value.category.trim()
        ? value.category.trim().toLowerCase()
        : null;
      return [{ id, name, label, category }];
    });
  }

  const skillCategory = skill => SKILL_CATEGORY_BY_KEY.get(skill.category) || UNKNOWN_SKILL_CATEGORY;

  function orderedSkillDetails(job) {
    return skillDetails(job).sort((left, right) => {
      const categoryDifference = skillCategory(left).index - skillCategory(right).index;
      return categoryDifference
        || left.label.localeCompare(right.label, "en-US", { sensitivity: "base" })
        || left.id.localeCompare(right.id);
    });
  }

  function skillBundles(job) {
    const groups = new Map(SKILL_BUNDLES.map(bundle => [bundle.key, { ...bundle, skills: [] }]));
    for (const skill of orderedSkillDetails(job)) {
      const bundleKey = SKILL_BUNDLE_BY_CATEGORY.get(skillCategory(skill).key) || "other";
      groups.get(bundleKey).skills.push(skill);
    }
    return SKILL_BUNDLES.map(bundle => groups.get(bundle.key)).filter(bundle => bundle.skills.length);
  }

  function skillTitleAttrs(skill) {
    const category = skillCategory(skill);
    return ` title="${esc(`${skill.name} · ${category.label}`)}" aria-label="${esc(`${skill.name}, ${category.label}`)}"`;
  }

  function skillDisplayLabel(skill) {
    const compactCompound = /[a-z][A-Z]|^(?:API|DB|GPU)-(?:Dev|Design)$/;
    return EXPERTISE_SKILL_CATEGORIES.has(skillCategory(skill).key) && compactCompound.test(skill.label)
      ? skill.name
      : skill.label;
  }

  function skillChipMarkup(skill, className) {
    const category = skillCategory(skill);
    return `<span class="${className}" data-skill-id="${esc(skill.id)}" data-skill-category="${category.key}"${skillTitleAttrs(skill)}>${esc(skillDisplayLabel(skill))}</span>`;
  }

  // Expertise terms on a quarter or more of the loaded postings (AI sits on half
  // of Software internships) say little about any one posting, so the pane folds
  // them behind "+N common". Below 50 loaded postings the share is noise, and
  // nothing folds.
  const COMMON_TERM_SHARE = 0.25;
  const COMMON_TERM_MIN_JOBS = 50;
  function commonTerms(jobs) {
    const loaded = Array.isArray(jobs) ? jobs : [];
    if (loaded.length < COMMON_TERM_MIN_JOBS) return new Map();
    const counts = new Map();
    for (const job of loaded) {
      for (const skill of skillDetails(job)) {
        if (EXPERTISE_SKILL_CATEGORIES.has(skillCategory(skill).key)) counts.set(skill.id, (counts.get(skill.id) || 0) + 1);
      }
    }
    return new Map([...counts]
      .map(([id, count]) => [id, count / loaded.length])
      .filter(([, share]) => share >= COMMON_TERM_SHARE));
  }

  function commonChipMarkup(skill, share) {
    const label = skillDisplayLabel(skill);
    const note = `${skill.name} · on ${Math.round(share * 100)}% of loaded postings`;
    return `<span class="expertise-term common" data-skill-id="${esc(skill.id)}" data-skill-category="${skillCategory(skill).key}" title="${esc(note)}" aria-label="${esc(note)}">${esc(label)}</span>`;
  }

  function detailSkillsMarkup(job, { common = new Map(), expanded = false } = {}) {
    const values = orderedSkillDetails(job);
    if (!values.length) return "";
    const concrete = [];
    const expertise = [];
    const other = [];
    for (const skill of values) {
      const category = skillCategory(skill);
      if (CONCRETE_SKILL_CATEGORIES.has(category.key)) concrete.push(skill);
      else if (EXPERTISE_SKILL_CATEGORIES.has(category.key)) expertise.push(skill);
      else other.push(skill);
    }
    const specific = expertise.filter(skill => !common.has(skill.id));
    const folded = expertise.filter(skill => common.has(skill.id));
    const foldLabel = expanded ? "Hide common" : specific.length ? `+${folded.length} common` : `Show ${folded.length} common term${folded.length > 1 ? "s" : ""}`;
    const fold = folded.length
      ? `${expanded ? folded.map(skill => commonChipMarkup(skill, common.get(skill.id))).join("") : ""}<button class="more-link" type="button" data-action="toggle-common" aria-expanded="${expanded}">${foldLabel}</button>`
      : "";
    const concreteMarkup = concrete.length
      ? `<section class="detail-skill-section" data-skill-section="skills"><div class="section-kicker">Skills</div><div class="skill-list">${concrete.map(skill => skillChipMarkup(skill, "skill")).join("")}</div></section>`
      : "";
    const expertiseMarkup = expertise.length
      ? `<section class="detail-skill-section" data-skill-section="expertise"><div class="section-kicker">Expertise</div><div class="expertise-list" role="group" aria-label="Methods and concepts">${specific.map(skill => skillChipMarkup(skill, "expertise-term")).join("")}${fold}</div></section>`
      : "";
    const otherMarkup = other.length
      ? `<section class="detail-skill-section" data-skill-section="other"><div class="section-kicker">Other</div><div class="skill-list">${other.map(skill => skillChipMarkup(skill, "skill")).join("")}</div></section>`
      : "";
    return `${concreteMarkup}${expertiseMarkup}${otherMarkup}`;
  }
  function initials(job) {
    const words = String(job?.company || "").split(/\s+/).filter(Boolean);
    if (!words.length) return "?";
    return (words.length > 1 ? words.slice(0, 2).map(word => word[0]).join("") : words[0].slice(0, 2)).toUpperCase();
  }
  // Same-origin path only. The mark is server-issued, so a value that does not
  // look like the logo route is dropped rather than rendered as a remote src.
  const logoSrc = value => /^\/api\/companies\/\d+\/logo$/.test(String(value || "")) ? String(value) : "";
  // The logo or the initials, never both: a transparent PNG layered over the
  // letters it replaces reads as a smudge.
  function logoMarkup(job) {
    const src = logoSrc(job?.logo);
    if (!src) return esc(initials(job));
    return `<img class="job-logo-mark" src="${esc(src)}" alt="" loading="lazy" decoding="async">`;
  }
  const workplaceLabel = value => ({ yes: "Remote", hybrid: "Hybrid" })[value] || "";

  function sourceLabel(value) {
    const provider = String(value || "").split(":", 1)[0].trim().toLowerCase();
    if (!provider) return "Source unavailable";
    if (SOURCE_LABELS[provider]) return SOURCE_LABELS[provider];
    return provider.replace(/[-_]+/g, " ").replace(/\b\w/g, character => character.toUpperCase());
  }

  const sourceProvider = value => String(value || "").split(":", 1)[0].trim().toLowerCase();

  // Every distinct link to this posting, primary first. Distinct by URL, not by
  // vendor: two career sites of one Oracle tenant are two ways in.
  function linkChoices(job) {
    const candidates = [
      { source: job?.source, url: job?.apply_url, posted_at: job?.posted_at, first_seen_at: job?.first_seen_at },
      ...(Array.isArray(job?.other_sources) ? job.other_sources : []),
    ];
    const seen = new Set();
    const choices = candidates.flatMap(candidate => {
      const url = safeHref(candidate?.url);
      if (!sourceProvider(candidate?.source) || !url || seen.has(url)) return [];
      seen.add(url);
      return [{
        source: candidate.source,
        label: sourceLabel(candidate.source),
        url,
        posted_at: candidate.posted_at,
        first_seen_at: candidate.first_seen_at,
      }];
    });
    // Same-vendor links read identically by name, so the board key after the
    // colon tells them apart.
    return choices.map(choice => ({
      ...choice,
      board: choices.filter(other => other.label === choice.label).length > 1
        ? String(choice.source).split(":").slice(1).join(":").split("/").pop()
        : "",
    }));
  }

  const US_STATES = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "Washington, DC", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming" };

  // Built from the full locations array: the API's `location` label stops at
  // three places and says "+N more", so it cannot feed the expanded list.
  function placeList(job) {
    const places = (Array.isArray(job?.locations) ? job.locations : []).map(place => {
      const city = String(place?.city || "").trim();
      const region = String(place?.state || "").trim();
      const country = String(place?.country || "").trim();
      if (city) return [city, region || (country !== "US" ? country : "")].filter(Boolean).join(", ");
      if (region) return US_STATES[region] || region;
      return country === "US" ? "United States" : country;
    }).filter(Boolean);
    const unique = [...new Set(places)];
    return unique.length ? unique : [job?.location || "Location not listed"];
  }

  const placeSummary = job => {
    const places = placeList(job);
    return places.length > 1 ? `${places[0]} +${places.length - 1}` : places[0];
  };

  function relativeTime(value, now = new Date()) {
    if (!value) return "Verification unavailable";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Verification unavailable";
    const seconds = Math.max(0, Math.floor((now - date) / 1000));
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  function postedPresentation(value, now = new Date(), firstSeen = null) {
    const days = input => {
      const date = new Date(input);
      return !input || Number.isNaN(date.getTime()) ? null : Math.max(0, Math.floor((now - date) / 86400000));
    };
    const phrase = (verb, count) => count === 0 ? `${verb} today` : count === 1 ? `${verb} yesterday` : `${verb} ${count}d ago`;
    const posted = days(value);
    if (posted !== null) return phrase("Posted", posted);
    const added = days(firstSeen);
    return added === null ? "Date unavailable" : phrase("Added", added);
  }

  const freshness = (job, now = new Date()) => postedPresentation(job.posted_at, now, job.first_seen_at);
  const RECENCY_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const recencyDayKey = value => {
    const date = new Date(value || "");
    if (Number.isNaN(date.getTime())) return "";
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: RECENCY_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(date).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };

  function recencyBucket(job, now = new Date()) {
    const value = job?.posted_at || job?.first_seen_at;
    const date = new Date(value || "");
    const key = recencyDayKey(value);
    if (!key || Number.isNaN(date.getTime())) return { key: "unknown", label: "Date unavailable" };
    if (key === recencyDayKey(now)) return { key, label: "Opened today" };
    if (key === recencyDayKey(new Date(now.getTime() - 86400000))) return { key, label: "Opened yesterday" };
    return {
      key,
      label: `Opened ${date.toLocaleDateString("en-US", {
        timeZone: RECENCY_TIME_ZONE, month: "short", day: "numeric",
        ...(key.slice(0, 4) === recencyDayKey(now).slice(0, 4) ? {} : { year: "numeric" }),
      })}`,
    };
  }

  function deadlineLabel(value) {
    const date = new Date(value || "");
    return Number.isNaN(date.getTime()) ? "" : `Apply by ${date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
  }

  function cardMetaMarkup(job) {
    const attrs = attributes(job);
    const workplace = workplaceLabel(job.remote);
    const items = [
      `<span class="card-location">${esc(placeSummary(job))}</span>`,
      workplace ? `<span class="workplace-cue" data-workplace="${esc(job.remote)}"><svg aria-hidden="true"><use href="#icon-globe"/></svg>${esc(workplace)}</span>` : "",
      attrs.term ? `<span class="card-term">${esc(attrs.term)}</span>` : "",
    ].filter(Boolean);
    return `<div class="card-meta">${items.join("")}</div>`;
  }

  // Term and deadline ride on the posted line: almost no posting has either, and
  // a row of its own rendered empty on nearly every job.
  function detailPostedMarkup(job, now = new Date()) {
    const attrs = attributes(job);
    const facts = [attrs.term, deadlineLabel(attrs.deadline_at)].filter(Boolean);
    return `<div class="detail-posted"><span class="posted-when">${esc(freshness(job, now))}</span>${job.last_seen_at ? `<span class="posted-sep" aria-hidden="true">·</span><span class="posted-checked">checked ${esc(relativeTime(job.last_seen_at, now))}</span>` : ""}${facts.map(fact => `<span class="posted-fact">${esc(fact)}</span>`).join("")}</div>`;
  }

  function summaryMarkup(job) {
    const text = String(job?.summary || "").trim();
    if (!text) return '<p class="summary-missing">Summary unavailable. View the original posting for complete details.</p>';
    return `<p class="role-summary">${esc(text)}</p>`;
  }

  const icon = id => `<svg aria-hidden="true"><use href="#${id}"/></svg>`;

  const SKIP_REASONS = [
    { key: "level", label: "Level" },
    { key: "location", label: "Location" },
    { key: "field", label: "Field" },
    { key: "company", label: "Company" },
  ];
  const TYPE_LABELS = { intern: "Internship", coop: "Co-op", student: "Student job", new_grad: "New grad", research: "Research" };
  const DOMAIN_LABELS = { software: "Software", finance: "Finance", med_device: "MedTech", clinical_affairs: "Regulatory", biotech: "BioTech", unlabeled: "Unlabeled" };
  const CORRECTION_LABELS = { type: "Job type", focus: "Focus", company: "Company", location: "Location", skills: "Skills" };

  // The labels a Mislabeled report can dispute, each with the value shown now.
  function reportRows(job) {
    const type = TYPE_LABELS[job.job_type] || "Unlabeled";
    const focus = DOMAIN_LABELS[job.focus ?? job.job_domain] || "Unlabeled";
    return [
      { field: "type", value: type, options: [...Object.values(TYPE_LABELS), "Not early-career"].filter(option => option !== type) },
      { field: "focus", value: focus, options: ["Software", "Finance", "MedTech", "BioTech", "Regulatory", "None of these"].filter(option => option !== focus) },
      { field: "company", value: String(job.company || ""), input: true },
      { field: "location", value: placeList(job).join(" · "), input: true },
      { field: "skills", value: "Skills and expertise list" },
    ].map(row => ({ ...row, label: CORRECTION_LABELS[row.field] }));
  }

  function hiddenReason(entry) {
    if (!entry) return "";
    if (entry.kind === "skip") {
      const reason = SKIP_REASONS.find(item => item.key === entry.skip_reason);
      return reason ? `Skipped · ${reason.label}` : "Skipped";
    }
    const fields = Array.isArray(entry.corrections) ? entry.corrections : [];
    if (fields.length === 1) {
      const [only] = fields;
      const label = CORRECTION_LABELS[only.field] || only.field;
      return only.to ? `Mislabeled · ${label}: ${only.from} → ${only.to}` : `Mislabeled · ${label}`;
    }
    return fields.length ? `Mislabeled · ${fields.map(item => CORRECTION_LABELS[item.field] || item.field).join(", ")}` : "Mislabeled";
  }

  // The main half always opens the primary posting; the chevron half exists only
  // when the posting is listed more than once, and lists every link.
  function openMarkup(job, ui = {}, now = new Date()) {
    const choices = linkChoices(job);
    if (!choices.length) return "";
    const [primary, ...others] = choices;
    const main = `<a class="button open-link" href="${esc(primary.url)}" target="_blank" rel="noopener noreferrer" data-tip="Open the original posting" data-key="D"><span>Apply</span>${icon("icon-out")}</a>`;
    if (!others.length) return main;
    const count = `${others.length} other link${others.length > 1 ? "s" : ""}`;
    const menu = ui.links
      ? `<div class="pop link-menu" role="menu" aria-label="Posting links"><p>Listed ${choices.length} times</p>${choices.map((choice, index) => {
        const when = index === 0 && job.last_seen_at ? `checked ${relativeTime(job.last_seen_at, now)}` : freshness(choice, now);
        return `<a class="link-item" role="menuitem" href="${esc(choice.url)}" target="_blank" rel="noopener noreferrer"><span><b>${esc(choice.label)}</b><small>${esc([choice.board && `board ${choice.board}`, when].filter(Boolean).join(" · "))}</small></span>${icon("icon-out")}</a>`;
      }).join("")}</div>`
      : "";
    return `<div class="open-split">${main}<button class="button open-more" type="button" data-action="toggle-links" aria-haspopup="menu" aria-expanded="${Boolean(ui.links)}" aria-label="${count}" data-tip="${count}" data-key="⇧D">${icon("icon-chevron")}</button>${menu}</div>`;
  }

  function reportMarkup(job, report) {
    const rows = reportRows(job).map(row => {
      const entry = report.rows[row.field] || {};
      const on = Boolean(entry.on);
      let fix = "";
      if (on && row.options) fix = `<div class="report-fix"><label class="sr-only" for="report-fix-${row.field}">Correct ${row.label.toLowerCase()} (optional)</label><select id="report-fix-${row.field}" data-fix-select="${row.field}"><option value="">Correction (optional)</option>${row.options.map(option => `<option value="${esc(option)}"${entry.to === option ? " selected" : ""}>${esc(option)}</option>`).join("")}</select></div>`;
      if (on && row.input) fix = `<div class="report-fix"><label class="sr-only" for="report-fix-${row.field}">Correct ${row.label.toLowerCase()} (optional)</label><input id="report-fix-${row.field}" data-fix-input="${row.field}" value="${esc(entry.to || "")}" placeholder="Correct ${row.label.toLowerCase()} (optional)" maxlength="300" autocomplete="off"></div>`;
      if (on && row.field === "skills") fix = '<div class="report-fix"><p>Flagged for review.</p></div>';
      return `<div class="report-row${on ? " on" : ""}"><label class="report-check"><input type="checkbox" id="report-${row.field}" data-report="${row.field}"${on ? " checked" : ""}${report.submitting ? " disabled" : ""}><span class="report-key">${row.label}</span><span class="report-value">${esc(row.value)}</span></label>${fix}</div>`;
    }).join("");
    const ready = Object.values(report.rows).some(entry => entry.on);
    return `<form id="report-form" aria-busy="${Boolean(report.submitting)}"><header class="report-head"><div><h2 id="report-title">Report details</h2><p class="report-context">${esc(job.company)} · ${esc(job.title)}</p><p id="report-description" class="sr-only">Select incorrect details. Corrections are optional.</p></div><button class="report-close" type="button" data-action="report-cancel" aria-label="Close report"${report.submitting ? " disabled" : ""}>${icon("icon-x")}</button></header><div class="report-body"><fieldset${report.submitting ? " disabled" : ""}><legend class="sr-only">Incorrect details</legend>${rows}</fieldset>${report.error ? `<p class="report-error" role="alert">${esc(report.error)}</p>` : ""}</div><footer class="report-foot"><p>Moves this job to Hidden. You can undo.</p><div><button class="button report-cancel" type="button" data-action="report-cancel"${report.submitting ? " disabled" : ""}>Cancel</button><button class="button primary" type="submit" data-action="report-submit"${ready && !report.submitting ? "" : " disabled"}>${report.submitting ? "Reporting…" : "Report"}</button></div></footer></form>`;
  }

  function detailFactsMarkup(job, { common = new Map(), expanded = false } = {}) {
    const skills = orderedSkillDetails(job);
    const languages = skills.filter(skill => skill.category === "language");
    const tools = skills.filter(skill => CONCRETE_SKILL_CATEGORIES.has(skill.category) && skill.category !== "language");
    const remaining = skills.filter(skill => !CONCRETE_SKILL_CATEGORIES.has(skill.category));
    const row = (label, value) => `<div class="detail-fact"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
    const pills = values => `<div class="skill-list">${values.map(skill => skillChipMarkup(skill, "skill")).join("")}</div>`;
    const date = value => {
      const parsed = new Date(value || "");
      return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    };
    const posted = date(job.posted_at);
    return `<section class="detail-facts"><h3>Details</h3><dl>`
      + (languages.length ? row("Languages", pills(languages)) : "")
      + (tools.length ? row("Tools", pills(tools)) : "")
      + (remaining.length ? row("Other skills", detailSkillsMarkup({ ...job, skills: remaining }, { common, expanded })) : "")
      + row("Posted", esc(posted ? `${posted} on ${sourceLabel(job.source)}` : `On ${sourceLabel(job.source)}`))
      + `</dl></section>`;
  }

  function appliedNoticeMarkup(notice) {
    if (!notice) return "";
    return `<span class="applied-notice" role="status" aria-label="${esc(`Added ${notice.job.company} to Applied`)}"><span>Added to Applied</span><span aria-hidden="true">·</span><button type="button" data-action="undo" aria-label="${esc(`Undo adding ${notice.job.company} to Applied`)}">Undo</button></span>`;
  }

  // The approved visual layout, backed by the existing API and triage handlers.
  function detailPaneMarkup(job, { ui = {}, hidden = null, common = new Map(), now = new Date(), appliedNotice = null } = {}) {
    const places = placeList(job);
    const attrs = attributes(job);
    const more = places.length > 1 ? `<button class="place-more" type="button" data-action="toggle-places" aria-expanded="${Boolean(ui.places)}" aria-label="Show all ${places.length} locations">+${places.length - 1}</button>` : "";
    const placeMenu = ui.places && places.length > 1
      ? `<div class="pop place-menu" role="dialog" aria-label="Locations"><p>${places.length} locations</p><ul>${places.map(place => `<li>${icon("icon-pin")}${esc(place)}</li>`).join("")}</ul></div>`
      : "";
    const workplace = workplaceLabel(job.remote);
    const flag = hidden ? "" : `<button class="detail-flag" type="button" data-action="report" aria-expanded="${Boolean(ui.report)}" aria-label="Mislabeled" data-tip="Mislabeled" data-key="R" data-tip-below>${icon("icon-flag")}<span>Report</span></button>`;
    const actions = hidden
      ? `<div class="hidden-banner${hidden.kind === "mislabeled" ? " flagged" : ""}"><p>${esc(hiddenReason(hidden))}</p><button class="button" type="button" data-action="restore" data-id="${esc(job.id)}">${icon("icon-undo")}<span>Restore to feed</span></button></div>`
      : `<div class="detail-actions">${openMarkup(job, ui, now)}<button class="button primary" type="button" data-action="add-to-applications" data-id="${esc(job.id)}" data-tip="Add to Applications" data-key="A">${icon("icon-plus")}<span>Applied</span></button>${appliedNoticeMarkup(appliedNotice)}<button class="button skip" type="button" data-action="skip" data-id="${esc(job.id)}" data-tip="Skip" data-key="F">${icon("icon-eye-off")}<span>Skip</span></button></div>`;
    return `<div class="detail-inner"><header class="detail-head"><div class="detail-logo">${logoMarkup(job)}</div><div class="detail-line"><div class="detail-company-row"><div class="detail-company" title="${esc(job.company)}">${esc(job.company)}</div>${flag}</div>`
      + `<h2>${esc(job.title)}</h2><div class="detail-metadata"><div class="detail-place">${icon("icon-pin")}<span>${esc(places[0])}</span>${more}${placeMenu}</div>${workplace ? `<span>${icon("icon-briefcase")}${esc(workplace)}</span>` : ""}${attrs.term ? `<span>${icon("icon-calendar")}${esc(attrs.term)}</span>` : ""}${attrs.deadline_at && deadlineLabel(attrs.deadline_at) ? `<span>${esc(deadlineLabel(attrs.deadline_at))}</span>` : ""}</div></div></header>`
      + actions
      + `<div class="detail-body"><section><h3>About the role</h3>${summaryMarkup(job)}</section>${detailFactsMarkup(job, { common, expanded: Boolean(ui.common) })}</div></div>`;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { FILTERS, DEGREE_FILTERS, SKILL_CATEGORIES, SKILL_BUNDLES, SKIP_REASONS, jobTypes, degreeFields, tabCount, seasonFilter, sortOrder, safeHref, sourceLabel, linkChoices, placeList, placeSummary, commonTerms, relativeTime, postedPresentation, recencyBucket, detailSkillsMarkup, skillDetails, orderedSkillDetails, skillBundles, listTags, workplaceLabel, freshness, deadlineLabel, cardMetaMarkup, detailPostedMarkup, summaryMarkup, reportRows, reportMarkup, hiddenReason, openMarkup, detailFactsMarkup, detailPaneMarkup, initials, logoSrc, logoMarkup };
  }
  if (!root.document) return;

  const $ = selector => root.document.querySelector(selector);
  const $$ = selector => [...root.document.querySelectorAll(selector)];
  const view = $("#view"), flash = $("#flash");
  function freshUi() {
    return { report: null, links: false, places: false, common: false };
  }
  const state = {
    jobs: null, total: 0, typeCounts: {}, loadingMore: false, selected: null, filters: ["internships"], degreeFilters: ["software", "finance"], sort: "fresh", query: "",
    // Triage: which list shows, the Hidden list once fetched, what the pane has
    // open, the skip awaiting a reason, and the one action Undo reverses.
    view: "feed", hidden: null, hiddenTotal: 0, stale: false, ui: freshUi(), prompt: null, undo: null, appliedNotice: null, sheet: false, fieldOpen: false,
  };

  // Measure at the original size each time, so a title can grow back when
  // more space becomes available. Character counts cannot predict wrapping.
  function sizeDetailTitle() {
    const title = view.querySelector(".detail-head h2");
    if (!title || !title.clientWidth) return;
    title.classList.remove("is-multiline");
    const lineHeight = parseFloat(root.getComputedStyle(title).lineHeight);
    title.classList.toggle("is-multiline", title.getBoundingClientRect().height > lineHeight * 1.5);
  }

  let titleWidth = 0;
  const titleObserver = typeof root.ResizeObserver === "function" ? new root.ResizeObserver(entries => {
    const width = entries[0].contentRect.width;
    // Ignore height changes caused by reducing the title itself.
    if (Math.abs(width - titleWidth) < 0.5) return;
    titleWidth = width;
    sizeDetailTitle();
  }) : null;

  function syncDetailTitle() {
    titleObserver?.disconnect();
    sizeDetailTitle();
    const title = view.querySelector(".detail-head h2");
    if (title) {
      titleWidth = title.getBoundingClientRect().width;
      titleObserver?.observe(title);
    }
  }

  if (!titleObserver) root.addEventListener("resize", sizeDetailTitle);
  root.document.fonts?.ready.then(sizeDetailTitle);
  root.document.fonts?.addEventListener("loadingdone", sizeDetailTitle);

  const paint = html => {
    const filtersLeft = view.querySelector(".discover-filterbar")?.scrollLeft || 0;
    const list = view.querySelector(".opportunity-list");
    const detail = view.querySelector(".detail");
    const listTop = list?.scrollTop || 0;
    const detailTop = detail?.scrollTop || 0;
    const previousId = detail?.dataset.selected;
    view.innerHTML = html;
    syncDetailTitle();
    const nextFilters = view.querySelector(".discover-filterbar");
    if (nextFilters) nextFilters.scrollLeft = filtersLeft;
    const nextList = view.querySelector(".opportunity-list");
    const nextDetail = view.querySelector(".detail");
    if (nextList) nextList.scrollTop = listTop;
    if (nextDetail && nextDetail.dataset.selected === previousId) nextDetail.scrollTop = detailTop;
  };

  // One hint per action, once per browser, and only after a mouse click: a
  // keyboard user already knows the key.
  const TIPS = { add: { key: "A", verb: "add" }, skip: { key: "F", verb: "skip" }, open: { key: "D", verb: "open the posting" } };
  const tipsSeen = new Set();
  function tipOnce(name) {
    const storageKey = `oneshot.triage.tip.${name}`;
    try {
      if (root.localStorage.getItem(storageKey)) return null;
      root.localStorage.setItem(storageKey, "1");
    } catch (_) {
      if (tipsSeen.has(name)) return null;
      tipsSeen.add(name);
    }
    return TIPS[name];
  }

  function announce(message, { undo = false, reasons = false, hint = null, besideApplied = false, skipAnchor = null } = {}) {
    const hadAppliedNotice = Boolean(state.appliedNotice);
    state.appliedNotice = null;
    clearTimeout(announce.appliedTimer);
    if (besideApplied && undo) {
      clearTimeout(announce.timer);
      announce.notice = null;
      flash.inert = true;
      flash.classList.remove("show", "has-action");
      flash.replaceChildren();
      state.appliedNotice = state.undo;
      render();
      announce.appliedTimer = setTimeout(() => {
        state.appliedNotice = null;
        render();
      }, 8000);
      return;
    }
    if (hadAppliedNotice) render();
    const make = (tag, text, className) => {
      const node = root.document.createElement(tag);
      if (text) node.textContent = text;
      if (className) node.className = className;
      return node;
    };
    flash.replaceChildren();
    const copy = make("span", message, "flash-copy");
    const notice = { prompt: reasons ? state.prompt : null, undo: undo ? state.undo : null, pending: false, skipAnchor };
    announce.notice = notice;
    const job = notice.prompt || notice.undo?.job;
    if (job) {
      copy.title = `${job.company} · ${job.title}`;
      copy.setAttribute("aria-label", `${message}. ${job.company}, ${job.title}`);
    }
    if (hint) {
      const small = make("small");
      small.append("Tip: press ", make("b", hint.key), ` to ${hint.verb}. `, make("b", "?"), " shows every shortcut.");
      copy.append(small);
    }
    flash.append(copy);
    if (reasons) {
      const trigger = make("button", "", "flash-reason");
      trigger.type = "button";
      trigger.dataset.action = "skip-reason";
      trigger.setAttribute("aria-expanded", "false");
      trigger.setAttribute("aria-controls", "flash-reasons");
      trigger.innerHTML = `Reason${icon("icon-chevron")}`;
      flash.append(trigger);
      const group = make("div", "", "flash-why");
      group.id = "flash-reasons";
      group.hidden = true;
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", "Skip reason (optional)");
      for (const [index, reason] of SKIP_REASONS.entries()) {
        const button = make("button");
        button.type = "button";
        button.dataset.why = reason.key;
        const key = make("kbd", String(index + 1));
        key.setAttribute("aria-hidden", "true");
        button.append(make("span", reason.label), key);
        group.append(button);
      }
      flash.append(group);
    }
    if (undo) {
      const button = make("button", "Undo", "flash-undo");
      button.type = "button";
      button.dataset.action = "undo";
      flash.append(button);
    }
    flash.classList.toggle("has-action", undo || reasons);
    flash.classList.toggle("near-skip", Boolean(skipAnchor));
    flash.classList.add("show");
    positionSkipNotice();
    flash.inert = false;
    announce.remaining = undo || reasons ? 12000 : 3200;
    announce.deadline = null;
    resumeFlash();
  }

  function positionSkipNotice() {
    const fallback = announce.notice?.skipAnchor;
    if (!fallback || !flash.classList.contains("show")) return;
    const anchor = state.view === "feed" ? $(".detail [data-action='skip']")?.getBoundingClientRect() : null;
    const bounds = anchor || fallback;
    const width = flash.offsetWidth, height = flash.offsetHeight;
    const left = Math.max(12, Math.min(bounds.right - width, root.innerWidth - width - 12));
    const below = bounds.bottom + 8;
    const top = Math.max(12, Math.min(below + height <= root.innerHeight - 12 ? below : bounds.top - height - 8, root.innerHeight - height - 12));
    flash.style.setProperty("--flash-left", `${left}px`);
    flash.style.setProperty("--flash-top", `${top}px`);
    const menu = $(".flash-why");
    const menuHeight = menu && !menu.hidden ? menu.offsetHeight : 144;
    flash.classList.toggle("reasons-above", top + height + menuHeight + 8 > root.innerHeight - 12);
  }

  function pauseFlash() {
    clearTimeout(announce.timer);
    if (announce.deadline != null) announce.remaining = Math.max(0, announce.deadline - Date.now());
    announce.deadline = null;
  }

  function resumeFlash() {
    if (!flash.classList.contains("show") || flash.matches(":hover") || flash.contains(root.document.activeElement)
      || $(".flash-why:not([hidden])") || announce.notice?.pending) return;
    if (announce.deadline != null) return;
    clearTimeout(announce.timer);
    announce.deadline = Date.now() + announce.remaining;
    const notice = announce.notice;
    announce.timer = setTimeout(() => {
      if (announce.notice !== notice) return;
      flash.classList.remove("show", "has-action");
      flash.inert = true;
      if (state.prompt === notice?.prompt) state.prompt = null;
      announce.deadline = null;
    }, announce.remaining);
  }

  function toggleSkipReason(open = $(".flash-why")?.hidden, { focus = true } = {}) {
    const menu = $(".flash-why"), trigger = $(".flash-reason");
    if (!menu || !trigger) return;
    if (menu.hidden === !open) return;
    menu.hidden = !open;
    trigger.setAttribute("aria-expanded", String(Boolean(open)));
    positionSkipNotice();
    if (open) {
      pauseFlash();
      if (focus) menu.querySelector("button")?.focus();
    } else {
      if (focus) trigger.focus();
      resumeFlash();
    }
  }

  flash.inert = true;
  flash.addEventListener("pointerenter", pauseFlash);
  flash.addEventListener("pointerleave", resumeFlash);
  flash.addEventListener("focusin", pauseFlash);
  flash.addEventListener("focusout", () => root.setTimeout(resumeFlash, 0));
  root.addEventListener("resize", positionSkipNotice);
  root.document.addEventListener("scroll", positionSkipNotice, { capture: true, passive: true });

  const errorState = (title, error) => `<div class="state"><h1>${esc(title)}</h1><p>${esc(error.message || error)}</p><button class="button primary" data-action="retry">Try again</button></div>`;
  const loading = () => paint('<div class="state loading"><i></i><h1>Loading Opportunities</h1><p>Reading the latest API data.</p></div>');
  function listTags(job) {
    return skillBundles(job)
      .filter(bundle => bundle.key === "languages" || bundle.key === "stack")
      .map(bundle => bundle.skills.map(skill => skillChipMarkup(skill, `tag tag-${bundle.key}`)).join(""))
      .join("");
  }

  const hiddenRows = () => state.hidden?.rows || [];
  const hiddenEntry = id => hiddenRows().find(row => String(row.job_id) === String(id)) || null;
  const visibleJobs = () => (state.view === "hidden" ? hiddenRows().map(row => row.job).filter(Boolean) : state.jobs || []);
  const selectedJob = () => visibleJobs().find(job => String(job.id) === String(state.selected)) || null;

  let commonCache = { jobs: undefined, terms: new Map() };
  function loadedCommonTerms() {
    if (commonCache.jobs !== state.jobs) commonCache = { jobs: state.jobs, terms: commonTerms(state.jobs || []) };
    return commonCache.terms;
  }

  function filtersMarkup() {
    return FILTERS.map(filter => {
      const active = state.filters.includes(filter.key);
      const count = tabCount(state.typeCounts, filter).toLocaleString();
      return `<button class="filter ${active ? "active" : ""}" type="button" role="tab" data-filter="${filter.key}" aria-selected="${active}" tabindex="${active ? "0" : "-1"}"><span>${filter.label}</span><span class="filter-count" aria-label="${count} opportunities">${count}</span></button>`;
    }).join("");
  }

  function degreeFiltersMarkup() {
    return DEGREE_FILTERS.map(filter => {
      const active = state.degreeFilters.includes(filter.key);
      return `<button class="degree-filter ${active ? "active" : ""}" type="button" data-degree-filter="${filter.key}" aria-pressed="${active}">${filter.label}</button>`;
    }).join("");
  }

  // Search lives in the persistent shared header, outside the re-rendered view.
  function openSearch() {
    const input = $("#opportunities-search");
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }

  function hiddenToggleMarkup() {
    const on = state.view === "hidden";
    return `<button class="hidden-toggle" type="button" data-action="toggle-hidden" aria-pressed="${on}">${icon("icon-eye-off")}Hidden<span class="hidden-count">${state.hiddenTotal.toLocaleString()}</span></button>`;
  }

  function opportunity(job) {
    const selected = String(job.id) === String(state.selected);
    const entry = state.view === "hidden" ? hiddenEntry(job.id) : null;
    const tags = entry ? "" : listTags(job);
    const reason = entry ? `<span class="hidden-reason${entry.kind === "mislabeled" ? " flagged" : ""}">${esc(hiddenReason(entry))}</span>` : "";
    const action = entry
      ? `<button class="card-restore" type="button" data-action="restore" data-id="${esc(job.id)}">Restore</button>`
      : `<div class="row-actions"><button class="card-add" type="button" data-action="add-to-applications" data-id="${esc(job.id)}" aria-label="Add ${esc(job.title)} to Applications">${icon("icon-plus")}</button><button class="card-skip" type="button" data-action="skip" data-id="${esc(job.id)}" aria-label="Skip ${esc(job.title)}" data-tip="Skip" data-key="F">${icon("icon-x")}</button></div>`;
    const ago = relativeTime(job.posted_at || job.first_seen_at).replace(/ ago$/, "");
    const due = deadlineLabel(attributes(job).deadline_at);
    return `<article class="opportunity ${selected ? "selected" : ""}" data-job="${esc(job.id)}" tabindex="0" role="button" aria-selected="${selected}"><div class="job-logo">${logoMarkup(job)}</div><div class="opportunity-main"><h3>${esc(job.title)}</h3><div class="job-subline"><span class="job-company">${esc(job.company)}</span>${cardMetaMarkup(job)}</div>${tags ? `<div class="tags">${tags}</div>` : ""}${reason}</div><div class="row-meta"><span>${esc(ago)}</span>${due ? `<span class="row-deadline">${esc(due.replace(/^Apply by /, "Due "))}</span>` : ""}</div>${action}</article>`;
  }

  function opportunitiesMarkup(jobs) {
    if (!["fresh", "oldest"].includes(sortOrder(state.sort))) return jobs.map(opportunity).join("");
    const counts = new Map();
    jobs.forEach(job => { const key = recencyBucket(job).key; counts.set(key, (counts.get(key) || 0) + 1); });
    let previous = null;
    return jobs.map(job => {
      const bucket = recencyBucket(job);
      const label = bucket.label === "Opened today" ? "Today" : bucket.label === "Opened yesterday" ? "Yesterday" : bucket.label.replace(/^Opened /, "");
      const count = counts.get(bucket.key);
      const heading = bucket.key === previous ? "" : `<div class="recency-bucket"><span>${esc(label)}</span><span class="group-count" aria-label="${count} loaded jobs">${count}</span></div>`;
      previous = bucket.key;
      return `${heading}${opportunity(job)}`;
    }).join("");
  }

  function hiddenListMarkup() {
    if (state.hidden === null) return '<div class="state loading"><i></i><p>Loading hidden postings.</p></div>';
    const jobs = visibleJobs();
    if (!jobs.length) return '<div class="empty"><h2>Nothing hidden</h2><p>Skipped and mislabeled postings land here, each with Restore.</p></div>';
    return `<p class="hidden-intro">Skipped and mislabeled postings, newest first. Restore puts one back in the feed.</p>${jobs.map(opportunity).join("")}`;
  }

  function detail(job) {
    if (!job) {
      return state.view === "hidden"
        ? '<aside class="detail"><div class="section-kicker">Hidden</div><h2>Nothing selected</h2><p>Pick a hidden posting to see why it left the feed.</p></aside>'
        : `<aside class="detail"><div class="section-kicker">Selection</div><h2>Choose a job</h2><p>Select a role to review its details and add it to Applications.</p>${state.appliedNotice ? `<div class="empty-detail-feedback">${appliedNoticeMarkup(state.appliedNotice)}</div>` : ""}</aside>`;
    }
    const pane = detailPaneMarkup(job, {
      ui: state.ui,
      hidden: state.view === "hidden" ? hiddenEntry(job.id) : null,
      common: loadedCommonTerms(),
      appliedNotice: state.appliedNotice,
    });
    return `<aside class="detail" data-selected="${esc(job.id)}" aria-label="Selected opportunity">${pane}</aside>`;
  }

  function pagerMarkup(jobs) {
    if (!jobs.length) return "";
    const hasMore = jobs.length < state.total;
    return `<div class="list-pager"><span>Showing ${jobs.length.toLocaleString()} of ${state.total.toLocaleString()}</span>${hasMore ? `<button class="button" type="button" data-action="load-more" ${state.loadingMore ? "disabled" : ""}>${state.loadingMore ? "Loading…" : "Load more"}</button>` : ""}</div>`;
  }



  function render() {
    const search = $("#opportunities-search"), restoreFocus = search && root.document.activeElement === search, selectionStart = restoreFocus ? search.selectionStart : null;
    const active = root.document.activeElement;
    const focusSelector = active?.matches("[data-filter]") ? `[data-filter="${CSS.escape(active.dataset.filter)}"]`
      : active?.matches("[data-degree-filter]") ? `[data-degree-filter="${CSS.escape(active.dataset.degreeFilter)}"]`
      : active?.matches(".field-trigger") ? ".field-trigger" : active?.matches("[data-sort]") ? "[data-sort]"
      : active?.matches("[data-job]") ? `[data-job="${CSS.escape(active.dataset.job)}"]`
      : active?.matches(".applied-notice [data-action='undo']") ? ".applied-notice [data-action='undo']" : null;
    const jobs = state.jobs || [];
    const list = state.view === "hidden"
      ? hiddenListMarkup()
      : `${jobs.length ? opportunitiesMarkup(jobs) : '<div class="empty"><h2>No matching jobs yet</h2><p>Try another search.</p></div>'}${pagerMarkup(jobs)}`;
    const fieldNames = DEGREE_FILTERS.filter(filter => state.degreeFilters.includes(filter.key)).map(filter => filter.label);
    const fieldLabel = fieldNames.length === 1 ? fieldNames[0] : fieldNames.length ? `${fieldNames.length} fields` : "All fields";
    paint(`<section class="discover-page"><h1 class="sr-only">Opportunities</h1><div class="discover-controls-pane"><div class="discover-filterbar" role="tablist" aria-label="Job types">${filtersMarkup()}</div><div class="list-tools"><div class="focus-menu"><button type="button" class="field-trigger" data-action="toggle-fields" aria-expanded="${state.fieldOpen}" aria-controls="field-options">${esc(fieldLabel)}${icon("icon-chevron")}</button>${state.fieldOpen ? `<div id="field-options" class="field-options" role="group" aria-label="Fields">${degreeFiltersMarkup()}<button class="field-clear" type="button" data-action="clear-fields">Show all fields</button></div>` : ""}</div><label class="discover-sort"><select data-sort aria-label="Opportunity order or season"><option value="fresh" ${state.sort === "fresh" ? "selected" : ""}>Newest first</option><option value="oldest" ${state.sort === "oldest" ? "selected" : ""}>Oldest first</option><option value="fall" ${state.sort === "fall" ? "selected" : ""}>Fall Only</option><option value="winter" ${state.sort === "winter" ? "selected" : ""}>Winter Only</option></select></label>${hiddenToggleMarkup()}</div></div><div class="discover-grid"><div class="opportunity-list" role="tabpanel" aria-label="${state.view === "hidden" ? "Hidden postings" : "Opportunity results"}">${list}</div>${detail(selectedJob())}</div></section>`);
    const headerSearch = $("#opportunities-search");
    if (headerSearch && headerSearch.value !== state.query) headerSearch.value = state.query;
    if (restoreFocus) {
      const next = $("#opportunities-search");
      next?.focus();
      if (next && selectionStart != null) next.setSelectionRange(selectionStart, selectionStart);
    } else if (focusSelector) ($(focusSelector) || (active?.closest(".applied-notice") ? $(".detail-actions .primary") : null))?.focus({ preventScroll: true });
    syncReport();
    positionSkipNotice();
  }

  function select(id, { focus = false } = {}) {
    if (String(id) !== String(state.selected)) {
      state.selected = id;
      state.ui = freshUi();
    }
    render();
    if (focus) {
      const card = $(`[data-job="${CSS.escape(String(id))}"]`);
      card?.focus();
      card?.scrollIntoView({ block: "nearest" });
    }
  }

  async function loadJobs({ append = false } = {}) {
    if (append) { state.loadingMore = true; render(); }
    else if (state.jobs === null) loading();
    try {
      const offset = append ? (state.jobs || []).length : 0;
      const payload = await root.OneShotAPI.jobs.list({ q: state.query, season: seasonFilter(state.sort), sort: sortOrder(state.sort), job_type: jobTypes(state.filters), degree_field: degreeFields(state.degreeFilters), limit: PAGE_SIZE, offset });
      state.total = payload.total;
      state.typeCounts = payload.job_type_counts || {};
      state.jobs = append ? [...(state.jobs || []), ...payload.jobs] : payload.jobs;
      state.loadingMore = false;
      if (!append) state.stale = false;
      if (!append && state.view === "feed" && !state.jobs.some(job => String(job.id) === String(state.selected))) {
        state.selected = state.jobs[0]?.id || null;
        state.ui = freshUi();
      }
      render();
      if (!append) { const list = $(".opportunity-list"); if (list) list.scrollTop = 0; }
    } catch (error) {
      state.loadingMore = false;
      if (append) { render(); announce(error.message || "Couldn’t load more opportunities."); }
      else paint(errorState("Opportunities couldn’t load", error));
    }
  }

  async function loadHidden() {
    const payload = await root.OneShotAPI.feedback.list({ limit: 200 });
    state.hidden = { total: payload.total, rows: (payload.hidden || []).filter(row => row.job) };
    state.hiddenTotal = payload.total;
    if (state.view === "hidden" && !hiddenEntry(state.selected)) {
      state.selected = state.hidden.rows[0]?.job.id ?? null;
      state.ui = freshUi();
    }
    render();
  }

  // The count beside "Hidden" on first paint. It is a convenience, so a failure
  // leaves it at zero rather than interrupting the feed.
  async function loadHiddenCount() {
    try {
      const payload = await root.OneShotAPI.feedback.list({ limit: 1 });
      state.hiddenTotal = payload.total;
      render();
    } catch (_) { /* The toggle still opens the list, which reports its own error. */ }
  }

  async function showView(next) {
    if (next === state.view) return;
    state.view = next;
    state.selected = null;
    state.ui = freshUi();
    state.prompt = null;
    if (next === "hidden") {
      render();
      return loadHidden();
    }
    if (state.jobs === null) return loadJobs();
    state.selected = state.jobs[0]?.id ?? null;
    render();
    if (state.stale) return loadJobs();
  }

  function adjustCounts(job, delta) {
    state.total = Math.max(0, state.total + delta);
    if (job.job_type && job.job_type in state.typeCounts) state.typeCounts[job.job_type] = Math.max(0, state.typeCounts[job.job_type] + delta);
  }

  // Below this many loaded cards, the next page loads in the background so
  // triaging never runs the list dry.
  const REFILL_AT = 10;

  // Add, Skip and Mislabeled leave the feed at once and select the next
  // posting; the write follows, and a failed write puts the posting back where
  // it was. The feed is never reloaded, so no action waits on the job list.
  async function leaveFeed(job, write) {
    const listed = state.jobs || [];
    const position = listed.findIndex(row => String(row.id) === String(job.id));
    const successor = listed[position + 1] || listed[position - 1] || null;
    state.jobs = listed.filter(row => String(row.id) !== String(job.id));
    adjustCounts(job, -1);
    if (String(state.selected) === String(job.id)) {
      state.selected = successor?.id ?? null;
      state.ui = freshUi();
    }
    state.prompt = null;
    render();
    let result;
    try {
      result = await write();
    } catch (error) {
      returnToFeed(job, position);
      throw error;
    }
    root.OneShotOpportunityCount.refresh();
    if (state.jobs.length < REFILL_AT && state.jobs.length < state.total && !state.loadingMore) loadJobs({ append: true });
    return { result, position };
  }

  // Puts a posting back where it left the feed: a failed write, or an Undo.
  function returnToFeed(job, position) {
    if (state.jobs && !state.jobs.some(row => String(row.id) === String(job.id))) {
      state.jobs.splice(Math.min(Math.max(0, position), state.jobs.length), 0, job);
      adjustCounts(job, 1);
      if (state.view === "feed") {
        state.selected = job.id;
        state.ui = freshUi();
      }
    }
    render();
    root.OneShotOpportunityCount.refresh();
  }

  async function addToApplications(id, mouse = false) {
    const job = state.view === "feed" ? (state.jobs || []).find(row => String(row.id) === String(id)) : null;
    if (!job) return;
    const { result: application, position } = await leaveFeed(job, () => root.OneShotAPI.jobs.addToApplications(job.id, job));
    if (application.already_exists) return announce("This job is already in Applications.");
    state.undo = { kind: "add", id: application.id, job, position };
    announce("Added to Applied", { undo: true, besideApplied: true });
  }

  async function hideJob(job, body, message, { reasons = false, hint = null, skipAnchor = null } = {}) {
    const write = () => root.OneShotAPI.jobs.setFeedback(job.id, body, job);
    // Keep the report draft and dialog intact until the server accepts it.
    if (body.kind === "mislabeled") await write();
    const { position } = await leaveFeed(job, body.kind === "mislabeled" ? () => Promise.resolve() : write);
    state.hiddenTotal += 1;
    state.hidden = null;
    state.undo = { kind: "hide", job, position };
    state.prompt = reasons ? job : null;
    render();
    announce(message, { undo: true, reasons, hint, skipAnchor });
  }

  function skip(id) {
    const job = state.view === "feed" ? (state.jobs || []).find(row => String(row.id) === String(id)) : null;
    if (!job) return;
    const bounds = $(".detail [data-action='skip']")?.getBoundingClientRect();
    const skipAnchor = bounds ? { right: bounds.right, top: bounds.top, bottom: bounds.bottom } : null;
    return hideJob(job, { kind: "skip" }, "Skipped", { reasons: true, skipAnchor });
  }

  async function giveReason(key) {
    const notice = announce.notice;
    const job = notice?.prompt;
    const reason = SKIP_REASONS.find(item => item.key === key);
    if (!job || !reason || notice.pending) return;
    notice.pending = true;
    pauseFlash();
    flash.querySelectorAll("button").forEach(button => { button.disabled = true; });
    $(".flash-reason-error")?.remove();
    try {
      await root.OneShotAPI.jobs.setFeedback(job.id, { kind: "skip", skip_reason: reason.key }, job);
      state.hidden = null;
      if (announce.notice !== notice) return;
      state.prompt = null;
      announce(`Skipped · ${reason.label}`, { undo: true, skipAnchor: notice.skipAnchor });
      $(".flash-undo")?.focus();
    } catch (error) {
      if (announce.notice !== notice) return;
      notice.pending = false;
      flash.querySelectorAll("button").forEach(button => { button.disabled = false; });
      const message = root.document.createElement("p");
      message.className = "flash-reason-error";
      message.setAttribute("role", "alert");
      message.textContent = error.message || "Reason could not be saved. Try again.";
      $(".flash-why")?.append(message);
      toggleSkipReason(true);
    }
  }

  let reportOpener = null;
  function syncReport() {
    const report = state.ui.report;
    let dialog = $("#report-dialog");
    if (!report) {
      if (dialog?.open) {
        dialog.close();
        dialog.replaceChildren();
        root.setTimeout(() => {
          if (!state.ui.report) (reportOpener?.isConnected ? reportOpener : $(".detail-flag"))?.focus({ preventScroll: true });
        }, 0);
      }
      return;
    }
    if (!dialog) {
      dialog = root.document.createElement("dialog");
      dialog.id = "report-dialog";
      dialog.className = "report-dialog";
      dialog.setAttribute("aria-labelledby", "report-title");
      dialog.setAttribute("aria-describedby", "report-description");
      dialog.addEventListener("cancel", event => { event.preventDefault(); closeReport(); });
      let startedOutside = false;
      const outside = event => {
        const bounds = dialog.getBoundingClientRect();
        return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
      };
      dialog.addEventListener("pointerdown", event => { startedOutside = event.target === dialog && outside(event); });
      dialog.addEventListener("click", event => {
        if (startedOutside && event.target === dialog && outside(event)) closeReport();
        startedOutside = false;
      });
      root.document.body.append(dialog);
    }
    const activeId = dialog.contains(root.document.activeElement) ? root.document.activeElement.id : null;
    const scrollTop = dialog.querySelector(".report-body")?.scrollTop || 0;
    dialog.innerHTML = reportMarkup(report.job, report);
    if (!dialog.open) dialog.showModal();
    if (activeId) $("#" + CSS.escape(activeId))?.focus({ preventScroll: true });
    dialog.querySelector(".report-body").scrollTop = scrollTop;
  }

  function closeReport() {
    if (state.ui.report?.submitting) return;
    state.ui.report = null;
    $(".detail-flag")?.setAttribute("aria-expanded", "false");
    syncReport();
  }

  function toggleReport() {
    if (state.ui.report) return closeReport();
    if (state.view !== "feed" || !selectedJob()) return;
    reportOpener = root.document.activeElement;
    toggleSkipReason(false, { focus: false });
    pauseFlash();
    flash.classList.remove("show", "has-action");
    flash.inert = true;
    state.prompt = null;
    announce.notice = null;
    state.ui.links = state.ui.places = false;
    state.ui.report = { job: selectedJob(), rows: {}, submitting: false, error: null };
    render();
  }

  async function submitReport() {
    const report = state.ui.report;
    const job = report?.job;
    if (!job || report.submitting) return;
    const corrections = reportRows(job)
      .filter(row => report.rows[row.field]?.on)
      .map(row => ({ field: row.field, from: row.value.slice(0, 300), to: String(report.rows[row.field].to || "").trim().slice(0, 300) || null }));
    if (!corrections.length) return;
    report.submitting = true;
    report.error = null;
    syncReport();
    try {
      await hideJob(job, { kind: "mislabeled", corrections }, "Reported");
    } catch (error) {
      report.submitting = false;
      report.error = error.message || "Report could not be saved. Try again.";
      state.ui.report = report;
      syncReport();
    }
  }

  async function restore(id) {
    const entry = hiddenEntry(id);
    if (!entry) return;
    const rows = hiddenRows();
    const position = rows.indexOf(entry);
    const successor = rows[position + 1] || rows[position - 1] || null;
    await root.OneShotAPI.jobs.clearFeedback(entry.job_id);
    state.hidden.rows = rows.filter(row => row !== entry);
    state.hidden.total = Math.max(0, state.hidden.total - 1);
    state.hiddenTotal = Math.max(0, state.hiddenTotal - 1);
    if (String(state.selected) === String(id)) {
      state.selected = successor?.job.id ?? null;
      state.ui = freshUi();
    }
    // The feed refreshes quietly the next time it shows, with the posting back
    // in place; until then the old list stays on screen, not a spinner.
    state.stale = true;
    state.undo = { kind: "restore", entry };
    render();
    announce("Restored", { undo: true });
    root.OneShotOpportunityCount.refresh();
  }

  async function undo(last = state.undo) {
    if (!last) return;
    if (announce.notice?.pending && last === announce.notice.undo) return;
    if (state.undo === last) state.undo = null;
    state.prompt = null;
    if (state.appliedNotice) {
      state.appliedNotice = null;
      clearTimeout(announce.appliedTimer);
      render();
    }
    if (last.kind === "add") {
      await root.OneShotAPI.applications.remove(last.id);
      returnToFeed(last.job, last.position);
      return announce("Addition undone.");
    }
    if (last.kind === "hide") {
      await root.OneShotAPI.jobs.clearFeedback(last.job.id);
      state.hiddenTotal = Math.max(0, state.hiddenTotal - 1);
      state.hidden = null;
      returnToFeed(last.job, last.position);
      return announce("Undone.");
    }
    if (last.kind === "restore") {
      const { entry } = last;
      const body = entry.kind === "skip"
        ? { kind: "skip", skip_reason: entry.skip_reason ?? null }
        : { kind: "mislabeled", corrections: entry.corrections };
      await root.OneShotAPI.jobs.setFeedback(entry.job_id, body, entry.job);
      state.hiddenTotal += 1;
      state.stale = true;
      if (state.view === "hidden") await loadHidden();
      root.OneShotOpportunityCount.refresh();
      return announce("Hidden again.");
    }
  }

  function toggleLinks() {
    if (!$(".open-more")) return;
    state.ui.links = !state.ui.links;
    state.ui.places = false;
    render();
    if (state.ui.links) $(".link-item")?.focus();
  }

  const SHORTCUTS = [
    ["A", "Add to Applications"],
    ["D", "Open the posting"],
    ["⇧ D", "Other links, when it is listed twice"],
    ["F", "Skip"],
    ["1 2 3 4", "Choose a reason while the reason menu is open"],
    ["↓ S", "Next job"],
    ["↑ W", "Previous job"],
    ["R", "Mislabeled"],
    ["Z", "Undo"],
    ["⌘ K", "Search"],
    ["?", "Show this list"],
  ];
  function toggleSheet(open = !state.sheet) {
    state.sheet = open;
    let host = $("#shortcut-sheet");
    if (!host) {
      host = root.document.createElement("div");
      host.id = "shortcut-sheet";
      root.document.body.append(host);
    }
    host.innerHTML = open
      ? `<div class="sheet-scrim" data-sheet-scrim><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title"><div class="sheet-head"><strong id="sheet-title">Keyboard shortcuts</strong><button class="text-button" type="button" data-sheet-close>Close</button></div><dl>${SHORTCUTS.map(([keys, label]) => `<dt>${keys.split(" ").map(key => `<kbd>${esc(key)}</kbd>`).join("")}</dt><dd>${esc(label)}</dd>`).join("")}</dl></div></div>`
      : "";
    (open ? host.querySelector("[data-sheet-close]") : $(".keys-button"))?.focus();
  }

  const run = async task => {
    try { await task(); }
    catch (error) { announce(error.message || "That action could not be completed."); }
  };

  function move(step) {
    const cards = $$("[data-job]");
    if (!cards.length) return;
    const current = cards.findIndex(card => card.dataset.job === String(state.selected));
    const next = cards[current < 0 ? 0 : current + step];
    if (next) select(next.dataset.job, { focus: true });
  }

  root.document.addEventListener("click", event => {
    const target = event.target;
    if (!target.closest(".flash-why, .flash-reason")) toggleSkipReason(false, { focus: false });
    if (state.fieldOpen && !target.closest(".focus-menu")) { state.fieldOpen = false; render(); }
    if ((state.ui.links && !target.closest(".link-menu, [data-action='toggle-links']"))
      || (state.ui.places && !target.closest(".place-menu, [data-action='toggle-places']"))) {
      state.ui.links = false;
      state.ui.places = false;
      render();
    }
    if (target.closest("[data-sheet-close]") || target.matches("[data-sheet-scrim]")) return toggleSheet(false);
    const why = target.closest("[data-why]");
    if (why) return run(() => giveReason(why.dataset.why));
    if (event.detail > 0 && target.closest(".open-link, .open-more")) {
      const hint = tipOnce("open");
      if (hint) announce("", { hint });
    }
    if (target.closest(".link-item")) {
      state.ui.links = false;
      root.setTimeout(render, 0);
      return;
    }
    const control = target.closest("[data-action]");
    // The form owns submission, including Enter from a correction field.
    if (control?.dataset.action === "report-submit") return;
    const id = control?.dataset.id ?? state.selected;
    const mouse = event.detail > 0;
    const actions = {
      retry: () => start(),
      "load-more": () => (state.loadingMore ? undefined : loadJobs({ append: true })),
      "add-to-applications": () => addToApplications(id, mouse),
      skip: () => skip(id, mouse),
      restore: () => restore(id),
      undo: () => undo(control?.closest("#flash") ? announce.notice?.undo : state.undo),
      "skip-reason": () => toggleSkipReason(),
      report: () => toggleReport(),
      "report-cancel": () => closeReport(),
      "toggle-links": () => toggleLinks(),
      "toggle-places": () => { state.ui.places = !state.ui.places; state.ui.links = false; render(); },
      "toggle-common": () => { state.ui.common = !state.ui.common; render(); },
      "toggle-hidden": () => showView(state.view === "hidden" ? "feed" : "hidden"),
      shortcuts: () => toggleSheet(true),
      "open-search": () => openSearch(),
      "toggle-fields": () => { state.fieldOpen = !state.fieldOpen; render(); },
      "clear-fields": () => { state.degreeFilters = []; state.fieldOpen = false; state.view = "feed"; return loadJobs(); },
      "clear-search": () => {
        clearTimeout(state.searchTimer);
        state.query = "";
        const input = $("#opportunities-search");
        if (input) input.value = "";
        openSearch();
        return loadJobs();
      },
    };
    if (control && actions[control.dataset.action]) return run(actions[control.dataset.action]);
    const card = target.closest("[data-job]");
    if (card) select(card.dataset.job);
  });

  root.document.addEventListener("click", event => {
    const filter = event.target.closest("[data-filter]");
    if (!filter) return;
    state.filters = [filter.dataset.filter];
    state.view = "feed";
    loadJobs();
  });
  root.document.addEventListener("click", event => {
    const filter = event.target.closest("[data-degree-filter]");
    if (!filter) return;
    const key = filter.dataset.degreeFilter;
    state.degreeFilters = state.degreeFilters.includes(key)
      ? state.degreeFilters.filter(value => value !== key)
      : [...state.degreeFilters, key];
    state.view = "feed";
    loadJobs();
  });
  root.document.addEventListener("keydown", event => {
    const tab = event.target.closest('[role="tab"][data-filter]');
    if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...tab.parentElement.querySelectorAll('[role="tab"][data-filter]')];
    const at = tabs.indexOf(tab);
    const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1) : tabs[(at + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    event.preventDefault();
    next.click();
  });
  root.document.addEventListener("change", event => {
    const box = event.target.closest?.("[data-report]");
    if (box && state.ui.report) {
      const field = box.dataset.report;
      state.ui.report.rows[field] = { ...(state.ui.report.rows[field] || {}), on: box.checked };
      syncReport();
      return $(`#report-${field}`)?.focus();
    }
    if (event.target.matches("[data-fix-select]") && state.ui.report && !state.ui.report.submitting) {
      const field = event.target.dataset.fixSelect;
      state.ui.report.rows[field] = { ...(state.ui.report.rows[field] || {}), to: event.target.value };
      return;
    }
    if (!event.target.matches("[data-sort]")) return;
    state.sort = event.target.value;
    state.view = "feed";
    loadJobs();
  });
  root.document.addEventListener("input", event => {
    if (event.target.matches("[data-fix-input]") && state.ui.report) {
      const field = event.target.dataset.fixInput;
      state.ui.report.rows[field] = { ...(state.ui.report.rows[field] || {}), to: event.target.value };
      return;
    }
    if (!event.target.matches("[data-search]")) return;
    state.query = event.target.value;
    state.view = "feed";
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(loadJobs, 250);
  });

  root.document.addEventListener("submit", event => {
    if (event.target.id !== "report-form") return;
    event.preventDefault();
    run(submitReport);
  });

  // Preserve existing shortcuts: A adds, D opens, F skips; arrows and S/W move,
  // R reports a wrong label, and Z undoes.
  root.document.addEventListener("keydown", event => {
    const active = root.document.activeElement;
    const typing = active?.isContentEditable || (/^(input|textarea|select)$/i.test(active?.tagName || "") && active.type !== "checkbox");
    if (state.sheet) {
      if (event.key === "Escape" || event.key === "?") { event.preventDefault(); toggleSheet(false); }
      return;
    }
    if (state.ui.report) {
      if (event.key === "Escape" || (!typing && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "r")) {
        event.preventDefault();
        closeReport();
      }
      return;
    }
    const reasonMenu = $(".flash-why:not([hidden])");
    if (reasonMenu && event.key === "Escape") {
      event.preventDefault();
      return toggleSkipReason(false);
    }
    if (reasonMenu && !typing && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const choices = [...reasonMenu.querySelectorAll("button")];
      const at = choices.indexOf(active);
      const next = event.key === "Home" ? choices[0] : event.key === "End" ? choices.at(-1) : choices[(at + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length];
      return next?.focus();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      return openSearch();
    }
    if (event.key === "Escape" && event.target.matches?.("[data-search]")) {
      clearTimeout(state.searchTimer);
      state.query = "";
      event.target.value = "";
      event.target.blur();
      return loadJobs();
    }
    if (event.key === "Escape" && state.fieldOpen) {
      state.fieldOpen = false;
      render();
      return $(".field-trigger")?.focus();
    }
    if (event.key === "Escape" && (state.ui.links || state.ui.places)) {
      const opener = state.ui.links ? ".open-more" : ".place-more";
      state.ui.links = false;
      state.ui.places = false;
      render();
      return $(opener)?.focus();
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    const focused = event.target.closest?.("[data-job]");
    if (focused && event.target === focused && ["Enter", " "].includes(event.key)) {
      event.preventDefault();
      return select(focused.dataset.job);
    }
    if (event.key === "?") { event.preventDefault(); return toggleSheet(true); }
    if (state.ui.links && /^[1-9]$/.test(event.key)) {
      const item = $$(".link-item")[Number(event.key) - 1];
      if (item) { event.preventDefault(); item.click(); }
      return;
    }
    if (state.prompt && reasonMenu && /^[1-4]$/.test(event.key)) {
      event.preventDefault();
      return run(() => giveReason(SKIP_REASONS[Number(event.key) - 1].key));
    }
    const key = event.key.toLowerCase();
    if (key === "d" && event.shiftKey) { event.preventDefault(); return toggleLinks(); }
    if (event.shiftKey) return;
    // Leave arrows with open menus and their controls.
    if (["arrowdown", "arrowup"].includes(key)
      && (state.fieldOpen || state.ui.links || state.ui.places || active?.closest(".account"))) return;
    const keys = {
      arrowdown: () => move(1),
      arrowup: () => move(-1),
      s: () => move(1),
      w: () => move(-1),
      a: () => addToApplications(state.selected),
      d: () => $(".open-link")?.click(),
      f: () => skip(state.selected),
      r: () => toggleReport(),
      z: () => undo(),
    };
    if (!keys[key]) return;
    event.preventDefault();
    run(keys[key]);
  });

  async function start() {
    await loadJobs();
    loadHiddenCount();
  }
  start();
})(typeof window !== "undefined" ? window : globalThis);

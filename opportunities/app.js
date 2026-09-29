(function (root) {
  "use strict";

  const FILTERS = [
    { key: "internships", label: "Internships", types: ["intern"] },
    { key: "coops", label: "Co-ops", types: ["coop"] },
    { key: "students", label: "Student Jobs", types: ["student"] },
    { key: "new_grads", label: "New Grad", types: ["new_grad"] },
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
  const DOMAIN_LABELS = { software: "Software", finance: "Finance", unlabeled: "Unlabeled" };
  const CORRECTION_LABELS = { type: "Job type", focus: "Focus", company: "Company", location: "Location", skills: "Skills" };

  // The labels a Mislabeled report can dispute, each with the value shown now.
  function reportRows(job) {
    const type = TYPE_LABELS[job.job_type] || "Unlabeled";
    const focus = DOMAIN_LABELS[job.job_domain] || "Unlabeled";
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
    const main = `<a class="button open-link" href="${esc(primary.url)}" target="_blank" rel="noopener noreferrer" data-tip="Open the original posting" data-key="D"><span>${esc(primary.label)}</span>${icon("icon-out")}</a>`;
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
      if (on && row.options) fix = `<div class="report-fix"><span>Should be</span>${row.options.map(option => `<button class="report-option" type="button" data-fix="${row.field}" data-value="${esc(option)}" aria-pressed="${entry.to === option}">${esc(option)}</button>`).join("")}</div>`;
      if (on && row.input) fix = `<div class="report-fix"><label for="report-fix-${row.field}">Should be</label><input id="report-fix-${row.field}" data-fix-input="${row.field}" value="${esc(entry.to || "")}" placeholder="Optional" maxlength="300" autocomplete="off"></div>`;
      return `<div class="report-row${on ? " on" : ""}"><label class="report-check"><input type="checkbox" id="report-${row.field}" data-report="${row.field}"${on ? " checked" : ""}><span class="report-key">${row.label}</span><span class="report-value">${esc(row.value)}</span></label>${fix}</div>`;
    }).join("");
    const ready = Object.values(report.rows).some(entry => entry.on);
    return `<div class="report" role="group" aria-labelledby="report-title"><div class="report-head"><strong id="report-title">What's wrong?</strong><button class="text-button" type="button" data-action="report-cancel">Cancel</button></div><div class="report-rows">${rows}</div><div class="report-foot"><button class="button primary" type="button" data-action="report-submit"${ready ? "" : " disabled"}>${icon("icon-tag-off")}<span>Report</span></button></div></div>`;
  }

  // The whole selected-posting pane. `hidden` is the posting's feedback row when
  // the Hidden list is showing, which swaps the actions for a Restore banner.
  function detailPaneMarkup(job, { ui = {}, hidden = null, common = new Map(), now = new Date() } = {}) {
    const places = placeList(job);
    const more = places.length > 1 ? `<button class="place-more" type="button" data-action="toggle-places" aria-expanded="${Boolean(ui.places)}" aria-label="Show all ${places.length} locations">+${places.length - 1}</button>` : "";
    const placeMenu = ui.places && places.length > 1
      ? `<div class="pop place-menu" role="dialog" aria-label="Locations"><p>${places.length} locations</p><ul>${places.map(place => `<li>${icon("icon-pin")}${esc(place)}</li>`).join("")}</ul></div>`
      : "";
    const workplace = workplaceLabel(job.remote);
    const flag = hidden ? "" : `<button class="detail-flag" type="button" data-action="report" aria-expanded="${Boolean(ui.report)}" aria-label="Mislabeled" data-tip="Mislabeled" data-key="R" data-tip-below>${icon("icon-tag-off")}</button>`;
    const actions = hidden
      ? `<div class="hidden-banner${hidden.kind === "mislabeled" ? " flagged" : ""}"><p>${esc(hiddenReason(hidden))}</p><button class="button" type="button" data-action="restore" data-id="${esc(job.id)}">${icon("icon-undo")}<span>Restore to feed</span></button></div>`
      : `<div class="detail-actions"><button class="button primary" type="button" data-action="add-to-applications" data-id="${esc(job.id)}" data-tip="Add to Applications" data-key="A">${icon("icon-plus")}<span>Add to Applications</span></button>${openMarkup(job, ui, now)}<button class="button skip" type="button" data-action="skip" data-id="${esc(job.id)}" data-tip="Skip" data-key="F">${icon("icon-x")}<span>Skip</span></button></div>`;
    return `<header class="detail-head"><div class="detail-logo">${logoMarkup(job)}</div><div class="detail-line"><div class="detail-company" title="${esc(job.company)}">${esc(job.company)}</div><div class="detail-place"><span>${esc(places[0])}</span>${more}${workplace ? `<span class="place-sep" aria-hidden="true">·</span><span class="detail-workplace">${esc(workplace)}</span>` : ""}${placeMenu}</div></div>${flag}</header>`
      + `<h2>${esc(job.title)}</h2>${detailPostedMarkup(job, now)}`
      + `${!hidden && ui.report ? reportMarkup(job, ui.report) : ""}${actions}`
      + `<div class="detail-body"><section><div class="section-kicker">Role summary</div>${summaryMarkup(job)}</section>${detailSkillsMarkup(job, { common, expanded: Boolean(ui.common) })}</div>`;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { FILTERS, DEGREE_FILTERS, SKILL_CATEGORIES, SKILL_BUNDLES, SKIP_REASONS, jobTypes, degreeFields, tabCount, seasonFilter, sortOrder, safeHref, sourceLabel, linkChoices, placeList, placeSummary, commonTerms, relativeTime, postedPresentation, recencyBucket, detailSkillsMarkup, skillDetails, orderedSkillDetails, skillBundles, listTags, workplaceLabel, freshness, deadlineLabel, cardMetaMarkup, detailPostedMarkup, summaryMarkup, reportRows, hiddenReason, openMarkup, detailPaneMarkup, initials, logoSrc, logoMarkup };
  }
  if (!root.document) return;

  const $ = selector => root.document.querySelector(selector);
  const $$ = selector => [...root.document.querySelectorAll(selector)];
  const view = $("#view"), flash = $("#flash");
  function freshUi() {
    return { report: null, links: false, places: false, common: false };
  }
  const state = {
    jobs: null, total: 0, typeCounts: {}, loadingMore: false, selected: null, filters: ["internships"], degreeFilters: ["software"], sort: "fresh", query: "",
    // Triage: which list shows, the Hidden list once fetched, what the pane has
    // open, the skip awaiting a reason, and the one action Undo reverses.
    view: "feed", hidden: null, hiddenTotal: 0, ui: freshUi(), prompt: null, undo: null, sheet: false, searchOpen: false,
  };

  const paint = html => {
    view.innerHTML = html;
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

  function announce(message, { undo = false, reasons = false, hint = null } = {}) {
    const make = (tag, text, className) => {
      const node = root.document.createElement(tag);
      if (text) node.textContent = text;
      if (className) node.className = className;
      return node;
    };
    flash.replaceChildren();
    const copy = make("span", message, "flash-copy");
    if (hint) {
      const small = make("small");
      small.append("Tip: press ", make("b", hint.key), ` to ${hint.verb}. `, make("b", "?"), " shows every shortcut.");
      copy.append(small);
    }
    flash.append(copy);
    if (reasons) {
      const group = make("div", "", "flash-why");
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", "Why skip?");
      group.append(make("span", "Why?"));
      for (const reason of SKIP_REASONS) {
        const button = make("button", reason.label);
        button.type = "button";
        button.dataset.why = reason.key;
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
    flash.classList.add("show");
    clearTimeout(announce.timer);
    announce.timer = setTimeout(() => {
      flash.classList.remove("show", "has-action");
      state.prompt = null;
    }, reasons ? 8000 : undo ? 6000 : 3200);
  }

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

  // Search folds to an icon at the head of the focus row. It stays open while it
  // holds a query, so a filtered list never hides the filter doing it.
  function searchMarkup() {
    if (!state.searchOpen && !state.query) {
      return `<div class="discover-search-surface"><button class="search-toggle" type="button" data-action="open-search" aria-label="Search opportunities" data-tip="Search" data-key="⌘K">${icon("icon-search")}</button></div>`;
    }
    const clear = state.query ? `<button class="search-clear" type="button" data-action="clear-search" aria-label="Clear search">${icon("icon-x")}</button>` : "";
    return `<div class="discover-search-surface open"><label class="discover-search"><svg aria-hidden="true"><use href="#icon-search"/></svg><span class="sr-only">Search opportunities</span><input id="opportunities-search" data-search placeholder="Roles, companies, skills, or ATS" autocomplete="off" value="${esc(state.query)}"></label>${clear}</div>`;
  }

  function openSearch() {
    state.searchOpen = true;
    render();
    const input = $("#opportunities-search");
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }

  function closeSearchIfEmpty() {
    if (!state.searchOpen || state.query) return;
    state.searchOpen = false;
    render();
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
      : `<button class="card-skip" type="button" data-action="skip" data-id="${esc(job.id)}" aria-label="Skip ${esc(job.title)}" data-tip="Skip" data-key="F">${icon("icon-x")}</button>`;
    return `<article class="opportunity ${selected ? "selected" : ""}" data-job="${esc(job.id)}" tabindex="0" role="button" aria-selected="${selected}"><div class="job-logo">${logoMarkup(job)}</div><div class="opportunity-main"><div class="job-company">${esc(job.company)}</div><h3>${esc(job.title)}</h3>${cardMetaMarkup(job)}${tags ? `<div class="tags">${tags}</div>` : ""}${reason}</div>${action}</article>`;
  }

  function opportunitiesMarkup(jobs) {
    if (!["fresh", "oldest"].includes(sortOrder(state.sort))) return jobs.map(opportunity).join("");
    let previous = null;
    return jobs.map(job => {
      const bucket = recencyBucket(job);
      const heading = bucket.key === previous ? "" : `<div class="recency-bucket">${esc(bucket.label)}</div>`;
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
        : '<aside class="detail"><div class="section-kicker">Selection</div><h2>Choose a job</h2><p>Select a role to review its details and add it to Applications.</p></aside>';
    }
    const pane = detailPaneMarkup(job, {
      ui: state.ui,
      hidden: state.view === "hidden" ? hiddenEntry(job.id) : null,
      common: loadedCommonTerms(),
    });
    return `<aside class="detail" aria-label="Selected opportunity">${pane}</aside>`;
  }

  function pagerMarkup(jobs) {
    if (!jobs.length) return "";
    const hasMore = jobs.length < state.total;
    return `<div class="list-pager"><span>Showing ${jobs.length.toLocaleString()} of ${state.total.toLocaleString()}</span>${hasMore ? `<button class="button" type="button" data-action="load-more" ${state.loadingMore ? "disabled" : ""}>${state.loadingMore ? "Loading…" : "Load more"}</button>` : ""}</div>`;
  }

  // The leading "·" only belongs while the location shares the company's line.
  function markWrap() {
    const place = $(".detail-place"), company = $(".detail-company");
    if (place && company) place.classList.toggle("wrapped", place.offsetTop > company.offsetTop + 4);
  }
  root.addEventListener("resize", markWrap);

  function render() {
    const search = $("#opportunities-search"), restoreFocus = search && root.document.activeElement === search, selectionStart = restoreFocus ? search.selectionStart : null;
    const jobs = state.jobs || [];
    const list = state.view === "hidden"
      ? hiddenListMarkup()
      : `${jobs.length ? opportunitiesMarkup(jobs) : '<div class="empty"><h2>No matching jobs yet</h2><p>Try another search.</p></div>'}${pagerMarkup(jobs)}`;
    paint(`<section class="discover-page"><header class="discover-page-head"><div><div class="section-kicker">Discover</div><h1>Opportunities</h1></div><button class="keys-button" type="button" data-action="shortcuts" aria-label="Keyboard shortcuts" data-tip="Shortcuts" data-key="?" data-tip-below>${icon("icon-keys")}</button></header><div class="discover-grid"><section class="discover-controls-pane" aria-label="Opportunity controls"><div class="discover-filterbar" role="tablist" aria-label="Job types">${filtersMarkup()}</div><div class="focus-row">${searchMarkup()}<div class="degree-filterbar" role="group" aria-label="Focus area mentioned"><span class="degree-filter-label">Focus area mentioned</span>${degreeFiltersMarkup()}</div><div class="list-tools"><label class="discover-sort"><select data-sort aria-label="Opportunity order or season"><option value="fresh" ${state.sort === "fresh" ? "selected" : ""}>Newest first</option><option value="oldest" ${state.sort === "oldest" ? "selected" : ""}>Oldest first</option><option value="fall" ${state.sort === "fall" ? "selected" : ""}>Fall Only</option><option value="winter" ${state.sort === "winter" ? "selected" : ""}>Winter Only</option></select></label>${hiddenToggleMarkup()}</div></div></section><div class="opportunity-list" role="tabpanel" aria-label="${state.view === "hidden" ? "Hidden postings" : "Opportunity results"}">${list}</div>${detail(selectedJob())}</div></section>`);
    markWrap();
    if (restoreFocus) {
      const next = $("#opportunities-search");
      next?.focus();
      if (next && selectionStart != null) next.setSelectionRange(selectionStart, selectionStart);
    }
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
      root.OneShotOpportunityCount?.set?.(state.total);
      state.typeCounts = payload.job_type_counts || {};
      state.jobs = append ? [...(state.jobs || []), ...payload.jobs] : payload.jobs;
      state.loadingMore = false;
      if (!append && state.view === "feed" && !state.jobs.some(job => String(job.id) === String(state.selected))) {
        state.selected = state.jobs[0]?.id || null;
        state.ui = freshUi();
      }
      render();
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
  }

  function adjustCounts(job, delta) {
    state.total = Math.max(0, state.total + delta);
    if (job.job_type && job.job_type in state.typeCounts) state.typeCounts[job.job_type] = Math.max(0, state.typeCounts[job.job_type] + delta);
  }

  async function addToApplications(id, mouse = false) {
    if (state.view !== "feed") return;
    const listed = state.jobs || [];
    const position = listed.findIndex(job => String(job.id) === String(id));
    const selectedJob = position < 0 ? null : listed[position];
    const successor = position < 0 ? null : listed[position + 1];
    const application = await root.OneShotAPI.jobs.addToApplications(id, selectedJob);
    state.jobs = null;
    state.selected = successor?.id || null;
    state.ui = freshUi();
    state.prompt = null;
    await loadJobs();
    await root.OneShotOpportunityCount.refresh();
    if (application.already_exists) return announce("This job is already in Applications.");
    state.undo = { kind: "add", id: application.id };
    announce("Added to Applications", { undo: true, hint: mouse ? tipOnce("add") : null });
  }

  // Skip and Mislabeled leave the feed at once and select the next posting; the
  // write follows, and a failed write puts the posting back where it was.
  async function hideJob(job, body, message, { reasons = false, hint = null } = {}) {
    const listed = state.jobs || [];
    const position = listed.findIndex(row => String(row.id) === String(job.id));
    const successor = listed[position + 1] || listed[position - 1] || null;
    state.jobs = listed.filter(row => String(row.id) !== String(job.id));
    adjustCounts(job, -1);
    if (String(state.selected) === String(job.id)) {
      state.selected = successor?.id ?? null;
      state.ui = freshUi();
    }
    render();
    try {
      await root.OneShotAPI.jobs.setFeedback(job.id, body, job);
    } catch (error) {
      state.jobs.splice(Math.max(0, position), 0, job);
      adjustCounts(job, 1);
      state.selected = job.id;
      render();
      throw error;
    }
    state.hiddenTotal += 1;
    state.hidden = null;
    state.undo = { kind: "hide", job, position };
    state.prompt = reasons ? job : null;
    render();
    announce(message, { undo: true, reasons, hint });
    root.OneShotOpportunityCount.refresh();
  }

  function skip(id, mouse = false) {
    const job = state.view === "feed" ? (state.jobs || []).find(row => String(row.id) === String(id)) : null;
    if (!job) return;
    return hideJob(job, { kind: "skip" }, "Skipped", { reasons: true, hint: mouse ? tipOnce("skip") : null });
  }

  async function giveReason(key) {
    const job = state.prompt;
    const reason = SKIP_REASONS.find(item => item.key === key);
    if (!job || !reason) return;
    state.prompt = null;
    await root.OneShotAPI.jobs.setFeedback(job.id, { kind: "skip", skip_reason: reason.key }, job);
    state.hidden = null;
    announce(`Skipped · ${reason.label}`, { undo: true });
  }

  function toggleReport() {
    if (state.view !== "feed" || !selectedJob()) return;
    state.ui.report = state.ui.report ? null : { rows: {} };
    render();
    if (state.ui.report) $("#report-type")?.focus();
  }

  function submitReport() {
    const job = selectedJob();
    const report = state.ui.report;
    if (!job || !report) return;
    const corrections = reportRows(job)
      .filter(row => report.rows[row.field]?.on)
      .map(row => ({ field: row.field, from: row.value.slice(0, 300), to: String(report.rows[row.field].to || "").trim().slice(0, 300) || null }));
    if (!corrections.length) return;
    return hideJob(job, { kind: "mislabeled", corrections }, "Reported");
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
    // The feed reloads the next time it shows, with the posting back in place.
    state.jobs = null;
    state.undo = { kind: "restore", entry };
    render();
    announce("Restored", { undo: true });
    root.OneShotOpportunityCount.refresh();
  }

  async function undo() {
    const last = state.undo;
    if (!last) return;
    state.undo = null;
    state.prompt = null;
    if (last.kind === "add") {
      await root.OneShotAPI.applications.remove(last.id);
      state.jobs = null;
      await loadJobs();
      await root.OneShotOpportunityCount.refresh();
      return announce("Addition undone.");
    }
    if (last.kind === "hide") {
      await root.OneShotAPI.jobs.clearFeedback(last.job.id);
      state.hiddenTotal = Math.max(0, state.hiddenTotal - 1);
      state.hidden = null;
      if (state.view === "feed" && state.jobs && !state.jobs.some(row => String(row.id) === String(last.job.id))) {
        state.jobs.splice(Math.min(Math.max(0, last.position), state.jobs.length), 0, last.job);
        adjustCounts(last.job, 1);
        state.selected = last.job.id;
        state.ui = freshUi();
      }
      render();
      root.OneShotOpportunityCount.refresh();
      return announce("Undone.");
    }
    if (last.kind === "restore") {
      const { entry } = last;
      const body = entry.kind === "skip"
        ? { kind: "skip", skip_reason: entry.skip_reason ?? null }
        : { kind: "mislabeled", corrections: entry.corrections };
      await root.OneShotAPI.jobs.setFeedback(entry.job_id, body, entry.job);
      state.hiddenTotal += 1;
      state.jobs = null;
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
    ["1 2 3 4", "Why you skipped, while the toast shows"],
    ["S W", "Next and previous job"],
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
    const fix = target.closest("[data-fix]");
    if (fix && state.ui.report) {
      const row = state.ui.report.rows[fix.dataset.fix];
      row.to = row.to === fix.dataset.value ? "" : fix.dataset.value;
      return render();
    }
    const control = target.closest("[data-action]");
    const id = control?.dataset.id ?? state.selected;
    const mouse = event.detail > 0;
    const actions = {
      retry: () => start(),
      "load-more": () => (state.loadingMore ? undefined : loadJobs({ append: true })),
      "add-to-applications": () => addToApplications(id, mouse),
      skip: () => skip(id, mouse),
      restore: () => restore(id),
      undo: () => undo(),
      report: () => toggleReport(),
      "report-cancel": () => { state.ui.report = null; render(); },
      "report-submit": () => submitReport(),
      "toggle-links": () => toggleLinks(),
      "toggle-places": () => { state.ui.places = !state.ui.places; state.ui.links = false; render(); },
      "toggle-common": () => { state.ui.common = !state.ui.common; render(); },
      "toggle-hidden": () => showView(state.view === "hidden" ? "feed" : "hidden"),
      shortcuts: () => toggleSheet(true),
      "open-search": () => openSearch(),
      "clear-search": () => {
        clearTimeout(state.searchTimer);
        state.query = "";
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
      render();
      return $(`#report-${field}`)?.focus();
    }
    if (!event.target.matches("[data-sort]")) return;
    state.sort = event.target.value;
    state.view = "feed";
    loadJobs();
  });
  // Leaving an empty search folds it back to the icon. Deferred, because a
  // re-render swaps the input and focus lands on its replacement.
  root.document.addEventListener("focusout", event => {
    if (!event.target.matches?.("[data-search]")) return;
    root.setTimeout(() => {
      if (!root.document.activeElement?.closest?.(".discover-search-surface")) closeSearchIfEmpty();
    }, 0);
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

  // Left hand only: A, D and F mirror the buttons left to right (Add, Open,
  // Skip), S and W move, R reports a wrong label, Z undoes.
  root.document.addEventListener("keydown", event => {
    const active = root.document.activeElement;
    const typing = /^(input|textarea|select)$/i.test(active?.tagName || "") && active.type !== "checkbox";
    if (state.sheet) {
      if (event.key === "Escape" || event.key === "?") { event.preventDefault(); toggleSheet(false); }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      return openSearch();
    }
    if (event.key === "Escape" && event.target.matches?.("[data-search]")) {
      event.target.blur();
      return closeSearchIfEmpty();
    }
    if (event.key === "Escape" && (state.ui.links || state.ui.places)) {
      const opener = state.ui.links ? ".open-more" : ".place-more";
      state.ui.links = false;
      state.ui.places = false;
      render();
      return $(opener)?.focus();
    }
    if (event.key === "Escape" && state.ui.report) {
      state.ui.report = null;
      render();
      return $(".detail-flag")?.focus();
    }
    if (event.key === "Enter" && state.ui.report && !/^(BUTTON|A)$/.test(active?.tagName || "")) {
      event.preventDefault();
      return run(submitReport);
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
    if (state.prompt && /^[1-4]$/.test(event.key)) {
      event.preventDefault();
      return run(() => giveReason(SKIP_REASONS[Number(event.key) - 1].key));
    }
    const key = event.key.toLowerCase();
    if (key === "d" && event.shiftKey) { event.preventDefault(); return toggleLinks(); }
    if (event.shiftKey) return;
    // With the report panel open, letters belong to it; only R closes it.
    if (state.ui.report && key !== "r") return;
    const keys = {
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

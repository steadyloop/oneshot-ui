(function (root) {
  "use strict";

  const STUDENT_JOB_TYPES = ["intern", "coop", "student", "new_grad", "research"];
  const FILTERS = [
    { key: "all", label: "All", types: [] },
    { key: "internships", label: "Internships", types: ["intern"] },
    { key: "coops", label: "Co-ops", types: ["coop"] },
    { key: "students", label: "Student Jobs", types: ["student"] },
    { key: "new_grads", label: "New Grad", types: ["new_grad"] },
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
  const jobTypes = filters => filters.flatMap(key => FILTERS.find(filter => filter.key === key)?.types || []);
  const degreeFields = filters => filters.filter(key => DEGREE_FILTERS.some(filter => filter.key === key));
  const tabCount = (counts, filter) => (filter.types.length ? filter.types : STUDENT_JOB_TYPES).reduce(
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

  function detailSkillsMarkup(job) {
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
    const concreteMarkup = concrete.length
      ? `<section class="detail-skill-section" data-skill-section="skills"><div class="section-kicker">Skills</div><div class="skill-list">${concrete.map(skill => skillChipMarkup(skill, "skill")).join("")}</div></section>`
      : "";
    const expertiseMarkup = expertise.length
      ? `<section class="detail-skill-section" data-skill-section="expertise"><div class="section-kicker">Expertise</div><div class="expertise-list" role="group" aria-label="Methods and concepts">${expertise.map(skill => skillChipMarkup(skill, "expertise-term")).join("")}</div></section>`
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

  function sourceChoices(job) {
    const candidates = [
      { source: job?.source, url: job?.apply_url, posted_at: job?.posted_at, first_seen_at: job?.first_seen_at },
      ...(Array.isArray(job?.other_sources) ? job.other_sources : []),
    ];
    const seen = new Set();
    return candidates.flatMap(candidate => {
      const provider = sourceProvider(candidate?.source);
      const url = safeHref(candidate?.url);
      if (!provider || !url || seen.has(provider)) return [];
      seen.add(provider);
      return [{
        provider,
        source: candidate.source,
        label: sourceLabel(candidate.source),
        url,
        posted_at: candidate.posted_at,
        first_seen_at: candidate.first_seen_at,
      }];
    });
  }

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

  function metaFacts(job) {
    const attrs = attributes(job);
    return [
      { icon: "icon-pin", label: job.location || "Location not listed" },
      { icon: "icon-calendar", label: attrs.term },
      { icon: "icon-globe", label: workplaceLabel(job.remote) },
      { icon: "icon-clock", label: deadlineLabel(attrs.deadline_at) },
    ].filter(fact => fact.label);
  }

  const listFacts = job => metaFacts(job).filter(fact => fact.icon !== "icon-clock").map(fact => fact.label);

  const factMarkup = (fact, className = "detail-fact") => `<span class="${className}"><svg aria-hidden="true"><use href="#${fact.icon}"/></svg>${esc(fact.label)}</span>`;

  // Location leads the detail header, so the meta row below carries what is left:
  // term, workplace, deadline. Most jobs have none of those and it renders nothing.
  const detailPlace = job => metaFacts(job).find(fact => fact.icon === "icon-pin");

  function detailMetaMarkup(job) {
    const facts = metaFacts(job).filter(fact => fact.icon !== "icon-pin");
    if (!facts.length) return "";
    return `<div class="detail-meta">${facts.map(fact => factMarkup(fact)).join("")}</div>`;
  }

  function cardMetaMarkup(job) {
    const attrs = attributes(job);
    const workplace = workplaceLabel(job.remote);
    const items = [
      `<span class="card-location">${esc(job.location || "Location not listed")}</span>`,
      workplace ? `<span class="workplace-cue" data-workplace="${esc(job.remote)}"><svg aria-hidden="true"><use href="#icon-globe"/></svg>${esc(workplace)}</span>` : "",
      attrs.term ? `<span class="card-term">${esc(attrs.term)}</span>` : "",
    ].filter(Boolean);
    return `<div class="card-meta">${items.join("")}</div>`;
  }

  // Polling keeps every listing live, so liveness is a constant and says nothing.
  // The card footline states the one date that separates one job from another.
  const cardStatusLine = (job, now = new Date()) => freshness(job, now);

  const openPostingLabel = job => String(job?.source || "").trim() ? `Open on ${sourceLabel(job.source)}` : "Open posting";
  const detailHeadMarkup = job => `<div class="detail-headline"><span class="detail-company">${esc(job.company)}</span><span class="detail-headline-sep" aria-hidden="true">·</span>${factMarkup(detailPlace(job), "detail-fact detail-place")}</div>`;

  function sourceDisclosureMarkup(job, now = new Date()) {
    const choices = sourceChoices(job);
    if (choices.length < 2) return { inline: "", panel: "" };
    const panelId = `job-sources-${String(job.id).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const inline = `<span class="posted-sep" aria-hidden="true">·</span><button class="source-toggle" type="button" data-action="toggle-sources" data-source-count="${choices.length}" aria-expanded="false" aria-controls="${esc(panelId)}" aria-label="Show ${choices.length} posting sources">${choices.length} sources</button>`;
    const links = choices.slice(1).map(choice => `<a class="source-option" href="${esc(choice.url)}" target="_blank" rel="noopener noreferrer"><span>${esc(choice.label)} ↗</span><small>${esc(freshness(choice, now))}</small></a>`).join("");
    return {
      inline,
      panel: `<div class="source-options" id="${esc(panelId)}" aria-label="Other posting sources" hidden><span class="source-options-label">Also available on</span>${links}</div>`,
    };
  }

  function detailPostedMarkup(job, now = new Date()) {
    const disclosure = sourceDisclosureMarkup(job, now);
    return `<div class="detail-posted"><span class="posted-when">${esc(freshness(job, now))}</span>${job.last_seen_at ? `<span class="posted-sep" aria-hidden="true">·</span><span class="posted-checked">checked ${esc(relativeTime(job.last_seen_at, now))}</span>` : ""}${disclosure.inline}</div>${disclosure.panel}`;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { FILTERS, DEGREE_FILTERS, SKILL_CATEGORIES, SKILL_BUNDLES, jobTypes, degreeFields, tabCount, safeHref, sourceLabel, sourceChoices, sourceDisclosureMarkup, relativeTime, postedPresentation, recencyBucket, detailSkillsMarkup, skillDetails, orderedSkillDetails, skillBundles, listTags, workplaceLabel, freshness, listFacts, deadlineLabel, metaFacts, detailMetaMarkup, cardMetaMarkup, openPostingLabel, detailHeadMarkup, detailPostedMarkup, summaryMarkup, initials, logoSrc, logoMarkup, cardStatusLine };
  }
  if (!root.document) return;

  const $ = selector => root.document.querySelector(selector);
  const view = $("#view"), flash = $("#flash");
  const state = { jobs: null, total: 0, typeCounts: {}, loadingMore: false, selected: null, filters: ["all"], degreeFilters: ["software"], sort: "fresh", query: "" };

  const paint = html => {
    view.innerHTML = html;
  };

  function announce(message, action) {
    flash.replaceChildren();
    const copy = root.document.createElement("span");
    copy.textContent = message;
    flash.append(copy);
    if (action) {
      const button = root.document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      button.dataset.action = action.name;
      button.dataset.id = action.id;
      flash.append(button);
    }
    flash.classList.toggle("has-action", Boolean(action));
    flash.classList.add("show");
    clearTimeout(announce.timer);
    announce.timer = setTimeout(() => flash.classList.remove("show", "has-action"), action ? 6000 : 3200);
  }

  const errorState = (title, error) => `<div class="state"><h1>${esc(title)}</h1><p>${esc(error.message || error)}</p><button class="button primary" data-action="retry">Try again</button></div>`;
  const loading = () => paint('<div class="state loading"><i></i><h1>Loading Opportunities</h1><p>Reading the latest API data.</p></div>');
  function listTags(job) {
    return skillBundles(job)
      .filter(bundle => bundle.key === "languages" || bundle.key === "stack")
      .map(bundle => bundle.skills.map(skill => skillChipMarkup(skill, `tag tag-${bundle.key}`)).join(""))
      .join("");
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

  function opportunity(job) {
    const recent = new Date(job.posted_at || job.first_seen_at).getTime() > Date.now() - 3 * 86400000;
    const selected = String(job.id) === String(state.selected);
    const tags = listTags(job);
    return `<article class="opportunity ${selected ? "selected" : ""}" data-job="${esc(job.id)}" tabindex="0" role="button" aria-selected="${selected}"><div class="job-logo">${logoMarkup(job)}</div><div class="opportunity-main"><div class="job-company-line"><div class="job-company">${esc(job.company)}</div>${recent ? '<span class="new-badge">New</span>' : ""}</div><h3>${esc(job.title)}</h3>${cardMetaMarkup(job)}${tags ? `<div class="tags">${tags}</div>` : ""}<div class="job-footline">${esc(cardStatusLine(job))}</div></div></article>`;
  }

  function opportunitiesMarkup(jobs) {
    if (state.sort !== "fresh") return jobs.map(opportunity).join("");
    let previous = null;
    return jobs.map(job => {
      const bucket = recencyBucket(job);
      const heading = bucket.key === previous ? "" : `<div class="recency-bucket">${esc(bucket.label)}</div>`;
      previous = bucket.key;
      return `${heading}${opportunity(job)}`;
    }).join("");
  }

  function summaryMarkup(job) {
    const text = String(job?.summary || "").trim();
    if (!text) return '<p class="summary-missing">Summary unavailable. View the original posting for complete details.</p>';
    return `<p class="role-summary">${esc(text)}</p>`;
  }

  function detail(job) {
    if (!job) return '<aside class="detail"><div class="section-kicker">Selection</div><h2>Choose a job</h2><p>Select a role to review its details and add it to Applications.</p></aside>';
    const postingSource = sourceChoices(job)[0];
    return `<aside class="detail">${detailHeadMarkup(job)}<h2>${esc(job.title)}</h2>${detailMetaMarkup(job)}${detailPostedMarkup(job)}<div class="detail-actions"><button class="button primary" data-action="add-to-applications" data-id="${esc(job.id)}">Add to Applications</button>${postingSource ? `<a class="button" href="${esc(postingSource.url)}" target="_blank" rel="noopener noreferrer">${esc(openPostingLabel(postingSource))} ↗</a>` : ""}</div>${detailSkillsMarkup(job)}<section><div class="section-kicker">Role summary</div>${summaryMarkup(job)}</section></aside>`;
  }

  function pagerMarkup(jobs) {
    if (!jobs.length) return "";
    const hasMore = jobs.length < state.total;
    return `<div class="list-pager"><span>Showing ${jobs.length.toLocaleString()} of ${state.total.toLocaleString()}</span>${hasMore ? `<button class="button" type="button" data-action="load-more" ${state.loadingMore ? "disabled" : ""}>${state.loadingMore ? "Loading…" : "Load more"}</button>` : ""}</div>`;
  }

  function render() {
    const search = $("#opportunities-search"), restoreFocus = search && root.document.activeElement === search, selectionStart = restoreFocus ? search.selectionStart : null;
    const jobs = state.jobs || [], selected = jobs.find(job => String(job.id) === String(state.selected));
    paint(`<section class="discover-page"><header class="discover-page-head"><div><div class="section-kicker">Discover</div><h1>Opportunities</h1></div></header><div class="discover-grid"><section class="discover-controls-pane" aria-label="Opportunity controls"><div class="discover-filterbar" role="tablist" aria-label="Job types">${filtersMarkup()}</div><div class="degree-filterbar" role="group" aria-label="Focus area mentioned"><span class="degree-filter-label">Focus area mentioned</span>${degreeFiltersMarkup()}</div></section><div class="discover-search-surface"><label class="discover-search"><svg aria-hidden="true"><use href="#icon-search"/></svg><span class="sr-only">Search opportunities</span><input id="opportunities-search" data-search placeholder="Search roles, companies, or skills" autocomplete="off" value="${esc(state.query)}"><kbd>⌘ K</kbd></label><label class="discover-sort"><select data-sort aria-label="Sort opportunities"><option value="fresh" ${state.sort === "fresh" ? "selected" : ""}>Newest first</option><option value="company" ${state.sort === "company" ? "selected" : ""}>Company A–Z</option><option value="title" ${state.sort === "title" ? "selected" : ""}>Role title A–Z</option></select></label></div><div class="opportunity-list" role="tabpanel" aria-label="Opportunity results">${jobs.length ? opportunitiesMarkup(jobs) : '<div class="empty"><h2>No matching jobs yet</h2><p>Try another search.</p></div>'}${pagerMarkup(jobs)}</div>${detail(selected)}</div></section>`);
    if (restoreFocus) {
      const next = $("#opportunities-search");
      next?.focus();
      if (next && selectionStart != null) next.setSelectionRange(selectionStart, selectionStart);
    }
  }

  async function loadJobs({ append = false } = {}) {
    if (append) { state.loadingMore = true; render(); }
    else if (state.jobs === null) loading();
    try {
      const offset = append ? (state.jobs || []).length : 0;
      const payload = await root.OneShotAPI.jobs.list({ q: state.query, sort: state.sort, job_type: jobTypes(state.filters), degree_field: degreeFields(state.degreeFilters), limit: PAGE_SIZE, offset });
      state.total = payload.total;
      state.typeCounts = payload.job_type_counts || {};
      state.jobs = append ? [...(state.jobs || []), ...payload.jobs] : payload.jobs;
      state.loadingMore = false;
      if (!append && !state.jobs.some(job => String(job.id) === String(state.selected))) state.selected = state.jobs[0]?.id || null;
      render();
    } catch (error) {
      state.loadingMore = false;
      if (append) { render(); announce(error.message || "Couldn’t load more opportunities."); }
      else paint(errorState("Opportunities couldn’t load", error));
    }
  }

  async function addToApplications(id) {
    const listed = state.jobs || [];
    const position = listed.findIndex(job => String(job.id) === String(id));
    const selectedJob = position < 0 ? null : listed[position];
    const successor = position < 0 ? null : listed[position + 1];
    const application = await root.OneShotAPI.jobs.addToApplications(id, selectedJob);
    state.jobs = null;
    state.selected = successor?.id || null;
    await loadJobs();
    await root.OneShotOpportunityCount.refresh();
    announce(application.already_exists ? "This job is already in Applications." : "Added to Applications.", application.already_exists ? null : { label: "Undo", name: "undo-add", id: application.id });
  }

  root.document.addEventListener("click", async event => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    try {
      if (action === "retry") return start();
      if (action === "load-more") return state.loadingMore ? undefined : loadJobs({ append: true });
      if (action === "add-to-applications") return addToApplications(event.target.closest("[data-id]").dataset.id);
      if (action === "undo-add") {
        await root.OneShotAPI.applications.remove(event.target.closest("[data-id]").dataset.id);
        state.jobs = null;
        await loadJobs();
        await root.OneShotOpportunityCount.refresh();
        return announce("Addition undone.");
      }
      if (action === "toggle-sources") {
        const button = event.target.closest("[aria-controls]");
        const panel = root.document.getElementById(button.getAttribute("aria-controls"));
        if (!panel) return;
        const expanded = button.getAttribute("aria-expanded") !== "true";
        button.setAttribute("aria-expanded", String(expanded));
        button.setAttribute("aria-label", `${expanded ? "Hide" : "Show"} ${button.dataset.sourceCount} posting sources`);
        panel.hidden = !expanded;
        return;
      }
      const job = event.target.closest("[data-job]");
      if (job) { state.selected = job.dataset.job; render(); }
    } catch (error) {
      announce(error.message || "That action could not be completed.");
    }
  });

  root.document.addEventListener("click", event => {
    const filter = event.target.closest("[data-filter]");
    if (!filter) return;
    state.filters = [filter.dataset.filter];
    loadJobs();
  });
  root.document.addEventListener("click", event => {
    const filter = event.target.closest("[data-degree-filter]");
    if (!filter) return;
    const key = filter.dataset.degreeFilter;
    state.degreeFilters = state.degreeFilters.includes(key)
      ? state.degreeFilters.filter(value => value !== key)
      : [...state.degreeFilters, key];
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
    if (!event.target.matches("[data-sort]")) return;
    state.sort = event.target.value;
    loadJobs();
  });
  root.document.addEventListener("input", event => {
    if (!event.target.matches("[data-search]")) return;
    state.query = event.target.value;
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(loadJobs, 250);
  });
  root.document.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      return $("#opportunities-search")?.focus();
    }
    const focused = event.target.closest?.("[data-job]");
    if (focused && ["Enter", " "].includes(event.key)) {
      event.preventDefault();
      state.selected = focused.dataset.job;
      return render();
    }
    if (/input|textarea|select/i.test(root.document.activeElement.tagName) || !["j", "k"].includes(event.key.toLowerCase())) return;
    const rows = [...root.document.querySelectorAll("[data-job]")];
    const current = Math.max(0, rows.findIndex(row => row.dataset.job === String(state.selected)));
    const next = rows[current + (event.key.toLowerCase() === "j" ? 1 : -1)];
    if (next) {
      state.selected = next.dataset.job;
      render();
      root.document.querySelector(`[data-job="${CSS.escape(String(state.selected))}"]`)?.focus();
    }
  });

  async function start() {
    try { await root.OneShotAPI.health(); await loadJobs(); }
    catch (error) { paint(errorState("OneShot is unavailable", error)); }
  }
  start();
})(typeof window !== "undefined" ? window : globalThis);

/* OneShot Resume Studio: reusable proof -> target role -> tailored document. */
(() => {
  "use strict";

  const state = {
    profile: null,
    entries: [],
    skills: [],
    variants: [],
    vocabulary: [],
    jobs: [],
    resumes: [],
    typstAvailable: false,
    browserLocal: false,
    tab: "bank",
    resumeId: null,
    bankKind: "all",
    bankQuery: "",
    coverage: null,
    check: null,
  };

  const KIND_TITLES = {
    education: "Education",
    experience: "Experience",
    research: "Research",
    project: "Projects",
    leadership: "Leadership",
  };
  const KIND_SINGULAR = {
    education: "Education",
    experience: "Experience",
    research: "Research",
    project: "Project",
    leadership: "Leadership",
  };
  const SKILL_TITLES = {
    language: "Languages",
    framework: "Frameworks & Libraries",
    tool: "Tools",
    math: "Methods",
  };
  const PREVIEW_KIND_ORDER = ["education", "experience", "research", "project", "leadership"];

  const view = document.getElementById("view");
  const toast = document.getElementById("toast");
  let toastTimer = null;

  const esc = value => String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]));

  function say(message) {
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
  }

  const icon = name => `<svg aria-hidden="true"><use href="#icon-${name}"/></svg>`;
  const localMode = () => state.browserLocal;
  const renderPayload = resume => ({
    profile: state.profile,
    resume,
    entries: state.entries,
    skills: state.skills,
  });

  async function renderLocally(kind, resume, asJson = false) {
    const response = await fetch(`/api/resume/render/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(renderPayload(resume)),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(typeof payload?.detail === "string" ? payload.detail : `Export failed (${response.status})`);
    }
    return asJson ? response.json() : response.blob();
  }

  async function openRendered(kind, resume) {
    const url = URL.createObjectURL(await renderLocally(kind, resume));
    if (!window.open(url, "_blank")) say("Allow pop-ups to open the export.");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function api(path, options = {}) {
    const init = {
      headers: options.body ? { "Content-Type": "application/json" } : {},
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    };
    const response = window.OneShotVisitorData && await window.OneShotVisitorData.isLocal()
      ? await window.OneShotVisitorData.request(`/resume${path}`, init)
      : await fetch(`/api/resume${path}`, init);
    if (response.status === 401) {
      if (window.location.pathname !== "/login/") window.location.assign("/login/");
      return new Promise(() => {});
    }
    if (response.status === 204) return null;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(typeof payload.detail === "string" ? payload.detail : "Request failed");
    }
    return payload;
  }

  async function loadAll() {
    const [profile, entries, skills, variants, vocabulary, jobs, resumes] = await Promise.all([
      api("/profile"), api("/entries"), api("/skills"), api("/variants"),
      api("/vocabulary"), api("/jobs"), api("/resumes"),
    ]);
    state.profile = profile;
    state.entries = entries.entries;
    state.skills = skills.skills;
    state.variants = variants.variants || [];
    state.vocabulary = vocabulary.terms || [];
    state.jobs = jobs.jobs;
    state.resumes = resumes.resumes;
    state.typstAvailable = resumes.typst_available;
    if (state.resumeId === null && state.resumes.length) state.resumeId = state.resumes[0].id;

    state.browserLocal = Boolean(
      window.OneShotVisitorData && await window.OneShotVisitorData.isLocal()
    );
    if (localMode()) {
      state.typstAvailable = await fetch("/api/resume/render/status")
        .then(response => response.ok ? response.json() : { typst_available: false })
        .then(payload => Boolean(payload.typst_available))
        .catch(() => false);
    }
    const badge = document.getElementById("typst-badge");
    badge.hidden = state.typstAvailable;
    badge.textContent = "Typst not installed · PDF export unavailable";
  }

  const currentResume = () => state.resumes.find(resume => resume.id === state.resumeId) || null;
  const bulletCount = () => state.entries.reduce((total, entry) => total + entry.bullets.length, 0);
  const workspaceIsEmpty = () => !state.profile?.full_name && !state.entries.length
    && !state.skills.length && !state.jobs.length && !state.resumes.length;

  function profileCompletion() {
    const profile = state.profile || {};
    const values = [profile.full_name, profile.email, profile.phone, profile.location, profile.links?.length];
    return Math.round(values.filter(Boolean).length / values.length * 100);
  }

  function updateChrome() {
    const counts = {
      bank: bulletCount() + state.skills.length,
      targets: state.jobs.length,
      builder: state.resumes.length,
    };
    document.querySelectorAll("[data-tab]").forEach(button => {
      const active = button.dataset.tab === state.tab;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll("[data-tab-count]").forEach(node => {
      node.textContent = counts[node.dataset.tabCount];
    });
    const selected = document.querySelector(`[data-tab="${state.tab}"]`);
    view.setAttribute("aria-labelledby", selected?.id || "tab-bank");
  }

  function render() {
    updateChrome();
    if (state.tab === "bank") renderBank();
    else if (state.tab === "targets") renderTargets();
    else renderBuilder();
  }

  function selectTab(tab) {
    state.tab = tab;
    render();
  }

  function demoCallout() {
    if (!state.browserLocal || !workspaceIsEmpty()) return "";
    return `
      <section class="demo-callout">
        <div class="demo-icon">${icon("spark")}</div>
        <div><p class="eyebrow">Interactive mockup</p><h2>See the full workflow with sample data</h2>
          <p>Load a fictional profile, proof points, target roles, and two tailored resumes. Everything remains editable and stays in this browser.</p></div>
        <button class="button primary" data-action="load-demo">Load sample workspace</button>
      </section>`;
  }

  function overviewStrip() {
    const cards = [
      ["Profile", `${profileCompletion()}%`, "complete"],
      ["Proof points", bulletCount(), `across ${state.entries.length} entries`],
      ["Skills", state.skills.length, `${state.variants.length} variants`],
      ["Tailored resumes", state.resumes.length, `${state.jobs.length} target roles`],
    ];
    return `<section class="overview-strip" aria-label="Resume workspace summary">${cards.map(([label, value, note]) => `
      <div class="overview-stat"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></div>`).join("")}</section>`;
  }

  /* ---------- content library ---------- */

  function renderBank() {
    const profile = state.profile || {};
    const links = (profile.links || []).map(link => `${link.label || ""} ${link.url}`.trim()).join("\n");
    const variantRows = state.variants.map(variantEditorRow).join("");
    const groups = Object.keys(KIND_TITLES).map(kind => {
      const siblings = state.entries.filter(entry => entry.kind === kind);
      const cards = siblings.map((entry, index) => entryCard(entry, index, siblings)).join("");
      return `
        <section class="story-group" data-story-group="${kind}">
          <header class="story-group-head">
            <div><p class="eyebrow">${KIND_TITLES[kind]}</p><span>${siblings.length} ${siblings.length === 1 ? "entry" : "entries"}</span></div>
            <button class="button small" data-action="add-entry" data-kind="${kind}">${icon("plus")}Add ${KIND_SINGULAR[kind]}</button>
          </header>
          <div class="story-list">${cards || `<div class="group-empty">No ${KIND_TITLES[kind].toLowerCase()} yet.</div>`}</div>
        </section>`;
    }).join("");

    const skillGroups = Object.keys(SKILL_TITLES).map(category => {
      const skills = state.skills.filter(skill => skill.category === category);
      return `<div class="skill-group"><div class="skill-group-title"><h3>${SKILL_TITLES[category]}</h3><span>${skills.length}</span></div>
        <div class="skill-chips">${skills.map(skill => `
          <span class="skill" title="${esc(audienceLabel(skill.audience))}">${esc(skill.name)}
            <button type="button" data-action="delete-skill" data-id="${skill.id}" aria-label="Remove ${esc(skill.name)}">×</button>
          </span>`).join("") || '<p class="empty-inline">None yet</p>'}</div></div>`;
    }).join("");

    view.innerHTML = `${demoCallout()}${overviewStrip()}
      <div class="bank-layout">
        <div class="bank-main">
          <section class="panel profile-panel">
            <header class="panel-head">
              <div><p class="eyebrow">Identity</p><h2>Contact profile</h2><p>Shared by every tailored resume.</p></div>
              <span class="completion-badge">${profileCompletion()}% complete</span>
            </header>
            <form id="profile-form" class="profile-grid">
              <label>Full name<input name="full_name" autocomplete="name" value="${esc(profile.full_name)}" placeholder="Your name"></label>
              <label>Email<input name="email" type="email" autocomplete="email" value="${esc(profile.email)}" placeholder="you@example.com"></label>
              <label>Phone<input name="phone" autocomplete="tel" value="${esc(profile.phone)}" placeholder="+1 555 555 5555"></label>
              <label>Location<input name="location" autocomplete="address-level2" value="${esc(profile.location)}" placeholder="City, State"></label>
              <label class="full">Links <span>one per line · label then URL</span><textarea name="links" rows="3" placeholder="Portfolio https://you.example\nGitHub https://github.com/you">${esc(links)}</textarea></label>
              <footer class="form-footer full"><span>Used in the document header.</span><button class="button primary" type="submit">Save profile</button></footer>
            </form>
          </section>

          <section class="panel library-panel">
            <header class="panel-head library-heading">
              <div><p class="eyebrow">Reusable proof</p><h2>Story library</h2><p>Keep the strongest version of each accomplishment, then reuse it across applications.</p></div>
              <button class="button primary" data-action="add-entry" data-kind="experience">${icon("plus")}Add entry</button>
            </header>
            <div class="library-toolbar">
              <label class="search-field">${icon("search")}<input id="bank-search" value="${esc(state.bankQuery)}" placeholder="Search roles, bullets, or tags" aria-label="Search story library"></label>
              <div class="kind-filters" role="group" aria-label="Filter story type">
                ${[{ key: "all", label: "All" }, ...Object.entries(KIND_TITLES).map(([key, label]) => ({ key, label }))]
                  .map(item => `<button class="filter-pill ${state.bankKind === item.key ? "active" : ""}" data-action="filter-kind" data-kind="${item.key}" aria-pressed="${state.bankKind === item.key}">${item.label}</button>`).join("")}
              </div>
              <span id="library-result-count" class="result-count"></span>
            </div>
            <div class="story-groups">${groups}</div>
          </section>
        </div>

        <aside class="bank-sidebar">
          <section class="panel variant-panel">
            <header class="panel-head"><div><p class="eyebrow">Focus</p><h2>Resume variants</h2><p>Tag proof for the roles you pursue.</p></div></header>
            <form id="variants-form">
              <div id="variant-rows" class="variant-rows">${variantRows || '<p class="empty-inline" data-empty-variants>No variants yet.</p>'}</div>
              <button class="text-button" type="button" data-action="add-variant-row">${icon("plus")}Add variant</button>
              <button class="button full-button" type="submit">Save variants</button>
            </form>
          </section>

          <section class="panel skill-panel">
            <header class="panel-head"><div><p class="eyebrow">Capabilities</p><h2>Skill bank</h2><p>Only list what you can defend in an interview.</p></div><span class="panel-count">${state.skills.length}</span></header>
            ${skillGroups}
            <form id="skill-form" class="skill-add">
              <div class="row">
                <select name="category" aria-label="Skill category">${Object.entries(SKILL_TITLES).map(([value, title]) => `<option value="${value}">${title}</option>`).join("")}</select>
                <select name="audience">${audienceOptions("all")}</select>
              </div>
              <div class="row"><input name="name" required maxlength="120" placeholder="Add a skill">
                <button class="button primary" type="submit" aria-label="Add skill">${icon("plus")}</button></div>
            </form>
          </section>

          <details class="panel advanced-panel">
            <summary><span>${icon("target")}</span><span><strong>Coverage dictionary</strong><small>${state.vocabulary.length} terms watched in job descriptions</small></span></summary>
            <form id="vocabulary-form">
              <p>Comma-separated terms OneShot should flag when a job description mentions them but your bank does not.</p>
              <textarea name="terms" rows="7">${esc(state.vocabulary.join(", "))}</textarea>
              <button class="button full-button" type="submit">Save dictionary</button>
            </form>
          </details>
        </aside>
      </div>`;
    applyBankFilters();
  }

  function variantEditorRow(variant = { key: "", label: "" }) {
    return `<div class="variant-row">
      <label><span>Key</span><input data-variant-key maxlength="40" value="${esc(variant.key)}" placeholder="platform"></label>
      <label><span>Label</span><input data-variant-label maxlength="80" value="${esc(variant.label)}" placeholder="Platform engineering"></label>
      <button class="icon-button mini" type="button" data-action="remove-variant-row" aria-label="Remove variant">${icon("close")}</button>
    </div>`;
  }

  function audienceOptions(selected, { includeAll = true } = {}) {
    const options = includeAll
      ? [{ key: "all", label: "All variants" }]
      : [{ key: "", label: "— No variant —" }];
    return options.concat(state.variants).map(({ key, label }) =>
      `<option value="${esc(key)}" ${key === (selected ?? "") ? "selected" : ""}>${esc(label || key)}</option>`
    ).join("");
  }

  function audienceLabel(key) {
    if (!key || key === "all") return "All variants";
    return state.variants.find(variant => variant.key === key)?.label || key;
  }

  function audienceChip(key) {
    return `<span class="chip" title="Audience: ${esc(audienceLabel(key))}">${esc(audienceLabel(key))}</span>`;
  }

  function moveButtons(what, id, index, total, extra = "") {
    const arrow = (delta, label, name) => `<button class="icon-button mini" data-action="move-${what}" data-id="${id}" data-delta="${delta}" ${extra} aria-label="Move ${what} ${label}">${icon(name)}</button>`;
    return [
      index > 0 ? arrow(-1, "up", "arrow-up") : "",
      index < total - 1 ? arrow(1, "down", "arrow-down") : "",
    ].join("");
  }

  function entryCard(entry, index, siblings) {
    const dates = [entry.start_date, entry.end_date].filter(Boolean).join(" – ");
    const searchable = [entry.org, entry.role, entry.location, entry.detail]
      .concat(entry.bullets.flatMap(bullet => [bullet.text, ...(bullet.tags || [])])).join(" ").toLowerCase();
    const bullets = entry.bullets.map((bullet, bulletIndex) => `
      <li class="bullet-row">
        <span class="bullet-dot" aria-hidden="true"></span>
        <div class="bullet-copy"><p>${esc(bullet.text)}</p>
          <div class="bullet-meta">${audienceChip(bullet.audience)}
            ${(bullet.tags || []).slice(0, 4).map(tag => `<span class="tag">${esc(tag)}</span>`).join("")}
            ${bullet.defense_notes ? '<span class="defense-ready">Interview note ready</span>' : ""}
          </div></div>
        <span class="entry-tools">
          ${moveButtons("bullet", bullet.id, bulletIndex, entry.bullets.length, `data-entry="${entry.id}"`)}
          <button class="icon-button mini" data-action="edit-bullet" data-id="${bullet.id}" data-entry="${entry.id}" aria-label="Edit bullet">${icon("edit")}</button>
          <button class="icon-button mini danger-icon" data-action="delete-bullet" data-id="${bullet.id}" aria-label="Delete bullet">${icon("trash")}</button>
        </span>
      </li>`).join("");
    return `
      <article class="entry-card" data-entry-id="${entry.id}" data-kind="${entry.kind}" data-search="${esc(searchable)}">
        <header class="entry-card-head">
          <div class="entry-mark">${String(KIND_TITLES[entry.kind] || "E").slice(0, 1)}</div>
          <div class="entry-title"><h3>${esc(entry.org)}</h3><p>${esc(entry.role || KIND_SINGULAR[entry.kind])}</p></div>
          <div class="entry-dates"><strong>${esc(dates || "Dates not set")}</strong><span>${esc(entry.location)}</span></div>
          <div class="entry-tools">
            ${moveButtons("entry", entry.id, index, siblings.length)}
            <button class="icon-button mini" data-action="edit-entry" data-id="${entry.id}" aria-label="Edit entry">${icon("edit")}</button>
            <button class="icon-button mini danger-icon" data-action="delete-entry" data-id="${entry.id}" aria-label="Delete entry">${icon("trash")}</button>
          </div>
        </header>
        ${entry.detail || entry.url ? `<div class="entry-detail">${entry.detail ? `<span>${esc(entry.detail)}</span>` : ""}${entry.url ? `<a href="${esc(entry.url)}" target="_blank" rel="noopener">View project ${icon("external")}</a>` : ""}</div>` : ""}
        ${bullets ? `<ul class="bullet-list">${bullets}</ul>` : '<p class="entry-empty">No proof points yet. Add one if this entry needs supporting detail.</p>'}
        <footer class="entry-card-foot"><span>${entry.bullets.length} proof point${entry.bullets.length === 1 ? "" : "s"}</span>
          <button class="text-button" data-action="add-bullet" data-entry="${entry.id}">${icon("plus")}Add proof point</button></footer>
      </article>`;
  }

  function applyBankFilters() {
    const query = state.bankQuery.trim().toLowerCase();
    let visible = 0;
    view.querySelectorAll(".entry-card").forEach(card => {
      const kindMatch = state.bankKind === "all" || card.dataset.kind === state.bankKind;
      const queryMatch = !query || card.dataset.search.includes(query);
      card.hidden = !(kindMatch && queryMatch);
      if (!card.hidden) visible += 1;
    });
    view.querySelectorAll("[data-story-group]").forEach(group => {
      const kindMatch = state.bankKind === "all" || group.dataset.storyGroup === state.bankKind;
      const hasVisibleCard = [...group.querySelectorAll(".entry-card")].some(card => !card.hidden);
      group.hidden = !kindMatch || (Boolean(query) && !hasVisibleCard);
    });
    const result = document.getElementById("library-result-count");
    if (result) result.textContent = `${visible} of ${state.entries.length} entries`;
  }

  /* ---------- target roles ---------- */

  function ageBadge(job) {
    if (!job.date_posted) return '<span class="age-badge unknown">Date unknown</span>';
    const days = Math.max(0, Math.floor((Date.now() - new Date(`${job.date_posted}T00:00:00`)) / 86400000));
    if (Number.isNaN(days)) return '<span class="age-badge unknown">Date unknown</span>';
    const bucket = days <= 7 ? "fresh" : days <= 21 ? "warm" : "stale";
    const label = days === 0 ? "Posted today" : `Posted ${days}d ago`;
    return `<span class="age-badge ${bucket}">${label}</span>`;
  }

  function targetOverlap(job) {
    const jd = (job.jd_text || "").toLowerCase();
    return state.skills.filter(skill => jd.includes(skill.name.toLowerCase()));
  }

  function renderTargets() {
    const ready = state.jobs.filter(job => job.jd_text).length;
    const linked = new Set(state.resumes.map(resume => resume.target_job_id).filter(Boolean));
    const cards = state.jobs.map(job => {
      const overlap = targetOverlap(job);
      const linkedResume = state.resumes.find(resume => resume.target_job_id === job.id);
      return `
        <article class="target-card">
          <header>
            <div class="company-mark">${esc(job.company.slice(0, 2).toUpperCase())}</div>
            <div class="target-title"><p>${esc(job.company)}</p><h3>${esc(job.title)}</h3></div>
            <div class="tools">
              <button class="icon-button mini" data-action="edit-job" data-id="${job.id}" aria-label="Edit target">${icon("edit")}</button>
              <button class="icon-button mini danger-icon" data-action="delete-job" data-id="${job.id}" aria-label="Delete target">${icon("trash")}</button>
            </div>
          </header>
          <div class="target-status-row">${ageBadge(job)}
            <span class="readiness ${job.jd_text ? "ready" : "needs-work"}">${job.jd_text ? "JD ready" : "Add job description"}</span>
            ${linkedResume ? '<span class="readiness linked">Resume linked</span>' : ""}
          </div>
          <div class="target-metrics">
            <div><strong>${overlap.length}</strong><span>bank skills found</span></div>
            <div><strong>${job.jd_text ? job.jd_text.split(/\s+/).filter(Boolean).length : 0}</strong><span>JD words</span></div>
            <div><strong>${linkedResume ? selectedBulletCount(linkedResume.selection) : 0}</strong><span>proof points used</span></div>
          </div>
          ${overlap.length ? `<div class="overlap-skills">${overlap.slice(0, 6).map(skill => `<span>${esc(skill.name)}</span>`).join("")}</div>` : '<p class="target-empty-note">Paste the full job description to see overlap with your bank.</p>'}
          ${job.note ? `<p class="target-note"><strong>Note</strong>${esc(job.note)}</p>` : ""}
          <footer>
            ${job.url ? `<a class="text-link" href="${esc(job.url)}" target="_blank" rel="noopener">Open posting ${icon("external")}</a>` : '<span></span>'}
            <button class="button primary" data-action="tailor-job" data-id="${job.id}">${linkedResume ? icon("edit") + "Continue tailoring" : icon("spark") + "Tailor resume"}</button>
          </footer>
        </article>`;
    }).join("");

    view.innerHTML = `${demoCallout()}
      <section class="section-intro">
        <div><p class="eyebrow">Role intelligence</p><h2>Target roles</h2><p>Keep the job description beside the proof you will use to answer it.</p></div>
        <button class="button primary" data-action="add-job">${icon("plus")}Add target role</button>
      </section>
      <section class="target-summary" aria-label="Target role summary">
        <div><strong>${state.jobs.length}</strong><span>saved roles</span></div>
        <div><strong>${ready}</strong><span>descriptions ready</span></div>
        <div><strong>${linked.size}</strong><span>resumes linked</span></div>
        <p><span class="pulse-dot"></span>Best practice: tailor and apply during the first 2–3 weeks.</p>
      </section>
      ${cards ? `<div class="target-grid">${cards}</div>` : `
        <section class="empty-state"><div>${icon("target")}</div><p class="eyebrow">No targets yet</p><h2>Bring the role into the room</h2>
          <p>Paste a job description to compare its language with your proof and skills.</p>
          <button class="button primary" data-action="add-job">${icon("plus")}Add your first target</button></section>`}`;
  }

  /* ---------- builder and live preview ---------- */

  function selectedBulletCount(selection) {
    return (selection?.entries || []).reduce((total, entry) => total + (entry.bullets || []).length, 0);
  }

  function renderBuilder() {
    const resume = currentResume();
    if (!resume) {
      view.innerHTML = `${demoCallout()}
        <section class="empty-state builder-empty"><div>${icon("doc")}</div><p class="eyebrow">Tailor &amp; preview</p><h2>Create your first tailored resume</h2>
          <p>Choose a target and a variant, then assemble the most relevant proof from your library.</p>
          <button class="button primary" data-action="new-resume">${icon("plus")}Create resume</button></section>`;
      return;
    }

    const selection = resume.selection || { entries: [], skills: [] };
    const pickedBullets = new Set((selection.entries || []).flatMap(pick => (pick.bullets || []).map(bullet => bullet.bullet_id)));
    const pickedSkills = new Set(selection.skills || []);
    const pickedEntries = new Set((selection.entries || []).map(pick => pick.entry_id));
    const resumeOptions = state.resumes.map(item => `<option value="${item.id}" ${item.id === state.resumeId ? "selected" : ""}>${esc(item.name)}</option>`).join("");
    const jobOptions = ['<option value="">No target role</option>'].concat(state.jobs.map(job =>
      `<option value="${job.id}" ${job.id === resume.target_job_id ? "selected" : ""}>${esc(job.company)} · ${esc(job.title)}</option>`
    )).join("");

    const entryPicks = state.entries.map(entry => {
      const rows = entry.bullets.map(bullet => {
        const offAudience = bullet.audience !== "all" && bullet.audience !== resume.variant;
        return `<li class="pick-bullet ${offAudience ? "off-audience" : ""}" data-audience="${esc(bullet.audience)}">
          <label><input type="checkbox" data-pick-bullet="${bullet.id}" data-pick-entry="${entry.id}" ${pickedBullets.has(bullet.id) ? "checked" : ""}>
            <span class="custom-check">${icon("check")}</span><span class="pick-copy">${esc(bullet.text)}<span>${audienceChip(bullet.audience)} ${(bullet.tags || []).slice(0, 3).map(tag => `<em>${esc(tag)}</em>`).join("")}</span></span>
          </label></li>`;
      }).join("");
      const dates = [entry.start_date, entry.end_date].filter(Boolean).join(" – ");
      const bulletless = entry.bullets.length === 0;
      const toggle = bulletless
        ? `<input type="checkbox" data-pick-entry-only="${entry.id}" ${pickedEntries.has(entry.id) ? "checked" : ""}>`
        : `<input type="checkbox" data-pick-entry-toggle="${entry.id}" ${entry.bullets.length && entry.bullets.every(bullet => pickedBullets.has(bullet.id)) ? "checked" : ""}>`;
      return `<article class="pick-entry" data-kind="${entry.kind}" data-entry="${entry.id}">
        <header><label>${toggle}<span class="custom-check">${icon("check")}</span></label>
          <div><p>${esc(entry.org)}</p><span>${esc(entry.role || KIND_SINGULAR[entry.kind])}</span></div>
          <span class="pick-kind">${KIND_SINGULAR[entry.kind]}</span><time>${esc(dates)}</time></header>
        ${bulletless ? '<p class="bulletless-note">Include this entry as a single résumé line.</p>' : `<ul>${rows}</ul>`}
      </article>`;
    }).join("");

    const skillPicks = Object.keys(SKILL_TITLES).map(category => {
      const skills = state.skills.filter(skill => skill.category === category);
      if (!skills.length) return "";
      return `<div class="skill-pick-group"><h4>${SKILL_TITLES[category]}</h4><div>${skills.map(skill => `
        <label class="skill-pick ${pickedSkills.has(skill.id) ? "selected" : ""}"><input type="checkbox" data-pick-skill="${skill.id}" ${pickedSkills.has(skill.id) ? "checked" : ""}>
          <span class="custom-check">${icon("check")}</span>${esc(skill.name)}</label>`).join("")}</div></div>`;
    }).join("");
    const canSource = true;
    const canPdf = state.typstAvailable;

    view.innerHTML = `
      <section class="builder-bar">
        <div class="resume-switcher"><label for="resume-select">Working resume</label><select id="resume-select">${resumeOptions}</select></div>
        <div class="builder-bar-actions">
          <button class="button" data-action="new-resume">${icon("plus")}New</button>
          <button class="button danger" data-action="delete-resume">${icon("trash")}Delete</button>
          <span class="bar-divider"></span>
          <button class="button" data-action="check-resume">Run checks</button>
          <button class="button" data-action="download-typ" ${canSource ? "" : "disabled"}>${icon("download")}.typ</button>
          <button class="button" data-action="open-pdf" ${canPdf ? "" : "disabled title='Install Typst to export PDF'"}>${icon("eye")}Open PDF</button>
          <button class="button primary" data-action="save-resume">${icon("check")}Save resume</button>
        </div>
      </section>

      <div class="builder-workbench">
        <div class="builder-editor">
          <section class="panel builder-setup">
            <header class="panel-head"><div><p class="eyebrow">Document setup</p><h2>Tailoring brief</h2><p>Name this version and keep its role context attached.</p></div></header>
            <div class="builder-settings">
              <label>Resume name<input id="rs-name" value="${esc(resume.name)}"></label>
              <label>Variant<select id="rs-variant">${audienceOptions(resume.variant, { includeAll: false })}</select></label>
              <label class="full">Target role<select id="rs-job">${jobOptions}</select></label>
              <label>Availability<input id="rs-availability" value="${esc(resume.availability_line)}" placeholder="Available June–September 2027"></label>
              <label>Education note<input id="rs-eduemph" value="${esc(resume.education_note)}" placeholder="GPA: 3.8 / 4.0"></label>
            </div>
          </section>

          <section class="panel proof-picker">
            <header class="panel-head"><div><p class="eyebrow">Evidence</p><h2>Choose proof points</h2><p>Start with relevance. Keep only the evidence that earns its space.</p></div>
              <div class="selection-tally"><strong id="selected-bullet-count">${selectedBulletCount(selection)}</strong><span>proof points</span></div></header>
            <div class="pick-list">${entryPicks || '<p class="empty">Your content library is empty. Add entries before building.</p>'}</div>
          </section>

          <section class="panel skills-picker-panel">
            <header class="panel-head"><div><p class="eyebrow">Keywords</p><h2>Choose skills</h2><p>Prioritize the target’s language without claiming anything you cannot defend.</p></div>
              <div class="selection-tally"><strong id="selected-skill-count">${pickedSkills.size}</strong><span>skills</span></div></header>
            <div class="skills-pick">${skillPicks || '<p class="empty">No skills in the bank.</p>'}</div>
          </section>
        </div>

        <aside class="preview-column">
          <div class="preview-label"><span>${icon("eye")}Live document preview</span><small>Content preview · final typesetting may differ</small></div>
          <article id="resume-preview" class="resume-preview">${previewDocument(resume, selection)}</article>
          <section class="panel fit-panel">
            <header class="panel-head"><div><p class="eyebrow">Quality control</p><h2>Fit &amp; checks</h2></div>
              <button class="button small" data-action="check-resume">Run checks</button></header>
            <div id="coverage" class="coverage">${coverageHtml()}</div>
            <div id="lint" class="lint">${lintHtml()}</div>
          </section>
        </aside>
      </div>`;
    syncParentCheckboxes();
  }

  function previewDocument(resume, selection, live = {}) {
    const picks = new Map((selection.entries || []).map(pick => [pick.entry_id, pick]));
    const bulletById = new Map(state.entries.flatMap(entry => entry.bullets).map(bullet => [bullet.id, bullet]));
    const chosenSkills = new Set(selection.skills || []);
    const groups = PREVIEW_KIND_ORDER.map(kind => {
      const rows = state.entries.filter(entry => entry.kind === kind && picks.has(entry.id)).map(entry => {
        const pick = picks.get(entry.id);
        const bulletRows = (pick.bullets || []).map(item => {
          const bullet = bulletById.get(item.bullet_id);
          const text = item.text_override || bullet?.text;
          return text ? `<li>${esc(text)}</li>` : "";
        }).join("");
        const dates = [entry.start_date, entry.end_date].filter(Boolean).join(" – ");
        return `<div class="preview-entry">
          <div class="preview-entry-head"><strong>${esc(entry.org)}</strong><span>${esc(dates)}</span></div>
          <div class="preview-entry-sub"><em>${esc(entry.role)}</em><span>${esc(entry.location)}</span></div>
          ${entry.detail ? `<p class="preview-detail">${esc(entry.detail)}</p>` : ""}
          ${bulletRows ? `<ul>${bulletRows}</ul>` : ""}
        </div>`;
      }).join("");
      return rows ? `<section class="preview-section"><h3>${KIND_TITLES[kind]}</h3>${rows}</section>` : "";
    }).join("");

    const skillGroups = Object.keys(SKILL_TITLES).map(category => {
      const names = state.skills.filter(skill => skill.category === category && chosenSkills.has(skill.id)).map(skill => skill.name);
      return names.length ? `<p><strong>${SKILL_TITLES[category]}:</strong> ${esc(names.join(", "))}</p>` : "";
    }).join("");
    const profile = state.profile || {};
    const contacts = [profile.email, profile.phone, profile.location]
      .concat((profile.links || []).map(link => link.label || link.url)).filter(Boolean);
    const availability = live.availability ?? resume.availability_line;
    const educationNote = live.educationNote ?? resume.education_note;
    const hasContent = Boolean(groups || skillGroups);
    return `
      <header class="preview-header"><h2>${esc(profile.full_name || "Your Name")}</h2>
        <p>${contacts.map(esc).join("  ·  ") || "email · phone · location · portfolio"}</p>
        ${availability ? `<span>${esc(availability)}</span>` : ""}</header>
      ${hasContent ? groups : '<div class="preview-empty"><span>Start selecting proof points</span><p>Your tailored resume will take shape here.</p></div>'}
      ${skillGroups ? `<section class="preview-section preview-skills"><h3>Skills</h3>${skillGroups}</section>` : ""}
      ${educationNote ? `<p class="preview-footnote">${esc(educationNote)}</p>` : ""}`;
  }

  function coverageHtml() {
    const resume = currentResume();
    if (!resume?.target_job_id) {
      return '<div class="check-placeholder"><span class="check-icon neutral">—</span><p><strong>No target linked</strong><small>Choose a role above to compare its language.</small></p></div>';
    }
    if (!state.coverage || state.coverage.job_id !== resume.target_job_id) {
      return '<div class="check-placeholder"><span class="check-icon pending">?</span><p><strong>Coverage not checked</strong><small>Save and run checks to analyze the job description.</small></p></div>';
    }
    const { matched, have_not_shown, missing } = state.coverage;
    const bucket = (title, tone, values, note) => values.length ? `
      <div class="coverage-bucket ${tone}"><header><span></span><strong>${title}</strong><b>${values.length}</b></header>
        <div>${values.map(value => `<span title="${esc(note)}">${esc(value.name || value)}</span>`).join("")}</div></div>` : "";
    return `<div class="coverage-results">
      ${bucket("On resume", "matched", matched, "Found in the target and selected resume")}
      ${bucket("In bank, not used", "gap", have_not_shown, "Consider adding if relevant")}
      ${bucket("Missing from bank", "missing", missing, "Never claim it unless it is true")}
    </div>`;
  }

  function lintHtml() {
    if (!state.check) return "";
    const { problems, page_count: pageCount } = state.check;
    const pageBadge = pageCount
      ? `<span class="page-count ${pageCount > 1 ? "bad" : "good"}">${pageCount} page${pageCount > 1 ? "s" : ""}</span>`
      : "";
    return `<div class="lint-results"><header><h3>Document checks</h3>${pageBadge}</header><ul>
      ${problems.map(problem => `<li class="${esc(problem.level)}"><span>${problem.level === "error" ? "!" : problem.level === "warn" ? "△" : "i"}</span>${esc(problem.message)}</li>`).join("") || '<li class="success"><span>✓</span>All checks pass.</li>'}
    </ul></div>`;
  }

  function collectSelection() {
    const stored = (currentResume()?.selection || {}).entries || [];
    const overrides = new Map(stored.flatMap(pick =>
      (pick.bullets || []).map(bullet => [bullet.bullet_id, bullet.text_override ?? null])));
    const picks = new Map();
    view.querySelectorAll("[data-pick-bullet]:checked").forEach(box => {
      const entryId = Number(box.dataset.pickEntry);
      const bulletId = Number(box.dataset.pickBullet);
      if (!picks.has(entryId)) picks.set(entryId, []);
      picks.get(entryId).push({ bullet_id: bulletId, text_override: overrides.get(bulletId) ?? null });
    });
    view.querySelectorAll("[data-pick-entry-only]:checked").forEach(box => {
      const entryId = Number(box.dataset.pickEntryOnly);
      if (!picks.has(entryId)) picks.set(entryId, []);
    });
    const skills = [...view.querySelectorAll("[data-pick-skill]:checked")].map(box => Number(box.dataset.pickSkill));
    return {
      entries: [...picks.entries()].map(([entry_id, bullets]) => ({ entry_id, bullets })),
      skills,
    };
  }

  function updateLiveBuilder() {
    const resume = currentResume();
    if (!resume || !document.getElementById("resume-preview")) return;
    const selection = collectSelection();
    document.getElementById("resume-preview").innerHTML = previewDocument(resume, selection, {
      availability: document.getElementById("rs-availability")?.value || "",
      educationNote: document.getElementById("rs-eduemph")?.value || "",
    });
    document.getElementById("selected-bullet-count").textContent = selectedBulletCount(selection);
    document.getElementById("selected-skill-count").textContent = selection.skills.length;
    view.querySelectorAll(".skill-pick").forEach(label => label.classList.toggle("selected", label.querySelector("input").checked));
    syncParentCheckboxes();
  }

  function syncParentCheckboxes() {
    view.querySelectorAll("[data-pick-entry-toggle]").forEach(parent => {
      const children = [...parent.closest(".pick-entry").querySelectorAll("[data-pick-bullet]")];
      const checked = children.filter(child => child.checked).length;
      parent.checked = Boolean(children.length) && checked === children.length;
      parent.indeterminate = checked > 0 && checked < children.length;
    });
  }

  async function saveResume() {
    const resume = currentResume();
    if (!resume) return null;
    const jobValue = document.getElementById("rs-job").value;
    const updated = await api(`/resumes/${resume.id}`, {
      method: "PATCH",
      body: {
        name: document.getElementById("rs-name").value || resume.name,
        variant: document.getElementById("rs-variant").value,
        target_job_id: jobValue ? Number(jobValue) : null,
        availability_line: document.getElementById("rs-availability").value,
        education_note: document.getElementById("rs-eduemph").value,
        selection: collectSelection(),
      },
    });
    state.resumes[state.resumes.findIndex(item => item.id === resume.id)] = updated;
    say("Resume saved");
    updateChrome();
    return updated;
  }

  async function checkResume() {
    const resume = await saveResume();
    if (!resume) return;
    state.check = localMode()
      ? await renderLocally("check", resume, true)
      : await api(`/resumes/${resume.id}/check`);
    state.coverage = resume.target_job_id
      ? await api(`/jobs/${resume.target_job_id}/coverage?resume_id=${resume.id}`)
      : null;
    renderBuilder();
  }

  /* ---------- dialogs and mutations ---------- */

  function openDialog(id, values = {}, onSubmit) {
    const dialog = document.getElementById(id);
    const form = dialog.querySelector("form");
    form.reset();
    dialog.querySelectorAll("[data-audience-select]").forEach(select => {
      select.innerHTML = audienceOptions(values.audience ?? "all");
    });
    dialog.querySelectorAll("[data-variant-select]").forEach(select => {
      select.innerHTML = audienceOptions(values.variant ?? state.variants[0]?.key ?? "", { includeAll: false });
    });
    dialog.querySelectorAll("[data-target-select]").forEach(select => {
      select.innerHTML = ['<option value="">No target role</option>'].concat(state.jobs.map(job =>
        `<option value="${job.id}">${esc(job.company)} · ${esc(job.title)}</option>`)).join("");
    });
    Object.entries(values).forEach(([key, value]) => {
      if (form.elements[key] !== undefined) form.elements[key].value = value ?? "";
    });
    form.onsubmit = async event => {
      event.preventDefault();
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        await onSubmit(Object.fromEntries(new FormData(form).entries()));
        dialog.close();
        await refresh();
      } catch (error) {
        say(error.message);
      } finally {
        submit.disabled = false;
      }
    };
    dialog.querySelectorAll("[data-action=close]").forEach(button => {
      button.onclick = () => dialog.close();
    });
    dialog.showModal();
  }

  function openResumeDialog(values = {}) {
    openDialog("resume-dialog", {
      name: values.name || "",
      target_job_id: values.target_job_id || "",
      variant: values.variant ?? state.variants[0]?.key ?? "",
    }, async data => {
      const created = await api("/resumes", {
        method: "POST",
        body: {
          name: data.name,
          target_job_id: data.target_job_id ? Number(data.target_job_id) : null,
          variant: data.variant,
        },
      });
      state.resumeId = created.id;
      state.tab = "builder";
      state.check = null;
      state.coverage = null;
    });
  }

  const parseTags = raw => raw.split(",").map(tag => tag.trim()).filter(Boolean);

  async function swapWithNeighbour(peers, id, delta, patchPosition) {
    const ordered = [...peers].sort((a, b) => a.position - b.position || a.id - b.id);
    const index = ordered.findIndex(item => item.id === id);
    const neighbour = ordered[index + delta];
    if (index < 0 || !neighbour) return;
    await patchPosition(id, neighbour.position);
    await patchPosition(neighbour.id, ordered[index].position);
    await refresh();
  }

  async function refresh() {
    await loadAll();
    render();
  }

  async function handleAction(button) {
    const { action, id, kind, entry, delta } = button.dataset;
    const numericId = Number(id);
    if (action === "load-demo") {
      if (!localMode() || !window.OneShotVisitorData?.loadResumeDemo) throw new Error("Sample workspace is available while signed out.");
      window.OneShotVisitorData.loadResumeDemo();
      state.resumeId = null;
      state.tab = "builder";
      await refresh();
      say("Sample workspace loaded");
    } else if (action === "filter-kind") {
      state.bankKind = kind;
      renderBank();
    } else if (action === "add-variant-row") {
      document.querySelector("[data-empty-variants]")?.remove();
      document.getElementById("variant-rows").insertAdjacentHTML("beforeend", variantEditorRow());
      document.querySelector("#variant-rows .variant-row:last-child [data-variant-key]").focus();
    } else if (action === "remove-variant-row") {
      button.closest(".variant-row").remove();
    } else if (action === "add-entry") {
      openDialog("entry-dialog", { kind }, data => api("/entries", { method: "POST", body: data }));
    } else if (action === "edit-entry") {
      const record = state.entries.find(item => item.id === numericId);
      openDialog("entry-dialog", record, data => api(`/entries/${numericId}`, { method: "PATCH", body: data }));
    } else if (action === "delete-entry") {
      if (confirm("Delete this entry and all of its proof points?")) {
        await api(`/entries/${numericId}`, { method: "DELETE" });
        await refresh();
      }
    } else if (action === "add-bullet") {
      const entryId = Number(entry);
      openDialog("bullet-dialog", {}, data => api(`/entries/${entryId}/bullets`, {
        method: "POST", body: { ...data, tags: parseTags(data.tags || "") },
      }));
    } else if (action === "edit-bullet") {
      const parent = state.entries.find(item => item.id === Number(entry));
      const record = parent.bullets.find(bullet => bullet.id === numericId);
      openDialog("bullet-dialog", { ...record, tags: record.tags.join(", ") }, data => api(`/bullets/${numericId}`, {
        method: "PATCH", body: { ...data, tags: parseTags(data.tags || "") },
      }));
    } else if (action === "move-entry") {
      const record = state.entries.find(item => item.id === numericId);
      await swapWithNeighbour(state.entries.filter(item => item.kind === record.kind), numericId, Number(delta),
        (target, position) => api(`/entries/${target}`, { method: "PATCH", body: { position } }));
    } else if (action === "move-bullet") {
      const parent = state.entries.find(item => item.id === Number(entry));
      await swapWithNeighbour(parent.bullets, numericId, Number(delta),
        (target, position) => api(`/bullets/${target}`, { method: "PATCH", body: { position } }));
    } else if (action === "delete-bullet") {
      await api(`/bullets/${numericId}`, { method: "DELETE" });
      await refresh();
    } else if (action === "delete-skill") {
      await api(`/skills/${numericId}`, { method: "DELETE" });
      await refresh();
    } else if (action === "add-job") {
      openDialog("job-dialog", {}, data => api("/jobs", { method: "POST", body: data }));
    } else if (action === "edit-job") {
      const record = state.jobs.find(job => job.id === numericId);
      openDialog("job-dialog", record, data => api(`/jobs/${numericId}`, { method: "PATCH", body: data }));
    } else if (action === "delete-job") {
      if (confirm("Delete this target role? Linked resumes will keep their content.")) {
        await api(`/jobs/${numericId}`, { method: "DELETE" });
        await refresh();
      }
    } else if (action === "tailor-job") {
      const existing = state.resumes.find(resume => resume.target_job_id === numericId);
      if (existing) {
        state.resumeId = existing.id;
        state.tab = "builder";
        state.check = null;
        state.coverage = null;
        render();
      } else {
        const job = state.jobs.find(item => item.id === numericId);
        openResumeDialog({ name: `${job.company} · ${job.title}`, target_job_id: job.id });
      }
    } else if (action === "new-resume") {
      openResumeDialog();
    } else if (action === "delete-resume") {
      if (confirm("Delete this tailored resume? Your content library will stay intact.")) {
        await api(`/resumes/${state.resumeId}`, { method: "DELETE" });
        state.resumeId = null;
        state.check = null;
        state.coverage = null;
        await refresh();
      }
    } else if (action === "save-resume") {
      await saveResume();
    } else if (action === "check-resume") {
      await checkResume();
    } else if (action === "download-typ" || action === "open-pdf") {
      const exportKind = action === "open-pdf" ? "pdf" : "source";
      const resume = await saveResume();
      if (resume && localMode()) await openRendered(exportKind, resume);
      else if (resume) window.open(`/api/resume/resumes/${resume.id}/${exportKind}`, "_blank");
    }
  }

  document.querySelector(".view-tabs").addEventListener("click", event => {
    const button = event.target.closest("[data-tab]");
    if (button) selectTab(button.dataset.tab);
  });

  document.querySelector(".view-tabs").addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...document.querySelectorAll("[data-tab]")];
    const index = tabs.indexOf(document.activeElement);
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    selectTab(tabs[nextIndex].dataset.tab);
    tabs[nextIndex].focus();
  });

  document.querySelector("[data-global-action=new-resume]").addEventListener("click", () => openResumeDialog());

  view.addEventListener("submit", async event => {
    const form = event.target;
    event.preventDefault();
    try {
      if (form.id === "profile-form") {
        const data = Object.fromEntries(new FormData(form).entries());
        const links = data.links.split("\n").map(line => line.trim()).filter(Boolean).map(line => {
          const match = line.match(/^(.*?)\s*(\S+)$/);
          return { label: (match?.[1] || "").trim(), url: match?.[2] || line };
        });
        state.profile = await api("/profile", {
          method: "PUT",
          body: { full_name: data.full_name, email: data.email, phone: data.phone, location: data.location, links },
        });
        say("Profile saved");
        renderBank();
      } else if (form.id === "variants-form") {
        const variants = [...form.querySelectorAll(".variant-row")].map(row => ({
          key: row.querySelector("[data-variant-key]").value,
          label: row.querySelector("[data-variant-label]").value,
        })).filter(variant => variant.key.trim());
        const saved = await api("/variants", { method: "PUT", body: { variants } });
        state.variants = saved.variants;
        say("Variants saved");
        await refresh();
      } else if (form.id === "vocabulary-form") {
        const raw = Object.fromEntries(new FormData(form).entries()).terms || "";
        const saved = await api("/vocabulary", { method: "PUT", body: { terms: parseTags(raw) } });
        state.vocabulary = saved.terms;
        say(`Coverage dictionary saved · ${saved.terms.length} terms`);
        renderBank();
      } else if (form.id === "skill-form") {
        const data = Object.fromEntries(new FormData(form).entries());
        await api("/skills", { method: "POST", body: data });
        await refresh();
      }
    } catch (error) {
      say(error.message);
    }
  });

  view.addEventListener("click", async event => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    try {
      await handleAction(button);
    } catch (error) {
      say(error.message);
    }
  });

  view.addEventListener("input", event => {
    if (event.target.id === "bank-search") {
      state.bankQuery = event.target.value;
      applyBankFilters();
    } else if (["rs-name", "rs-availability", "rs-eduemph"].includes(event.target.id)) {
      updateLiveBuilder();
    }
  });

  view.addEventListener("change", event => {
    if (event.target.id === "resume-select") {
      state.resumeId = Number(event.target.value);
      state.check = null;
      state.coverage = null;
      renderBuilder();
      return;
    }
    if (event.target.matches("[data-pick-entry-toggle]")) {
      event.target.closest(".pick-entry").querySelectorAll("[data-pick-bullet]").forEach(box => {
        box.checked = event.target.checked;
      });
    }
    if (event.target.id === "rs-variant") {
      const variant = event.target.value;
      view.querySelectorAll("[data-audience]").forEach(row => {
        row.classList.toggle("off-audience", row.dataset.audience !== "all" && row.dataset.audience !== variant);
      });
    }
    if (event.target.matches("[data-pick-bullet], [data-pick-entry-only], [data-pick-entry-toggle], [data-pick-skill], #rs-variant, #rs-job")) {
      updateLiveBuilder();
    }
  });

  // Applications hands off with `#target=<resume_target id>`. Reuse an existing
  // linked resume or create one, then land directly in the builder.
  async function openHandoffTarget() {
    const requested = Number(new URLSearchParams(location.hash.replace(/^#/, "")).get("target"));
    if (!requested || !state.jobs.some(job => job.id === requested)) return;
    const existing = state.resumes.find(resume => resume.target_job_id === requested);
    if (existing) {
      state.resumeId = existing.id;
    } else {
      const job = state.jobs.find(item => item.id === requested);
      const created = await api("/resumes", {
        method: "POST",
        body: {
          name: `${job.company} — ${job.title}`.slice(0, 300),
          target_job_id: requested,
          variant: state.variants[0]?.key || "",
        },
      });
      state.resumes.unshift(created);
      state.resumeId = created.id;
    }
    state.tab = "builder";
    history.replaceState(null, "", location.pathname + location.search);
  }

  (async () => {
    await refresh();
    const demoRequested = new URLSearchParams(location.search).get("demo") === "1";
    if (demoRequested && state.browserLocal && workspaceIsEmpty() && window.OneShotVisitorData?.loadResumeDemo) {
      window.OneShotVisitorData.loadResumeDemo();
      state.resumeId = null;
      state.tab = "builder";
      await refresh();
    }
    await openHandoffTarget();
    render();
  })().catch(error => {
    view.innerHTML = `<section class="empty-state"><div>!</div><h2>Resume studio could not load</h2><p>${esc(error.message)}</p></section>`;
  });
})();

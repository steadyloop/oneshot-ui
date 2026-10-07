/* OneShot resumes: one master profile, many tailored documents. */
(() => {
  "use strict";

  const state = {
    profile: null,
    entries: [],
    skills: [],
    variants: [],
    jobs: [],
    resumes: [],
    resumeId: null,
    browserLocal: false,
    tab: location.hash === "#resumes" ? "resumes" : "profile",
    mode: "content",
    addingKind: null,
    addingSkill: false,
    addingCourse: false,
    addingBulletEntry: null,
    renamingResumeId: null,
    openSections: new Set(["skills", "experience", "project", "research", "leadership"]),
    pdfUrl: null,
  };

  const view = document.getElementById("view");
  const tabAction = document.getElementById("tab-action");
  const toast = document.getElementById("toast");
  let toastTimer = null;

  const KIND = {
    education: { title: "Education", add: "Add education" },
    experience: { title: "Experience", add: "Add experience" },
    project: { title: "Projects", add: "Add project" },
    research: { title: "Research", add: "Add research" },
    leadership: { title: "Leadership", add: "Add leadership" },
  };
  const SECTION_ORDER = ["education", "skills", "experience", "project", "research", "leadership"];
  const COLLAPSIBLE = new Set(["skills", "experience", "project", "research", "leadership"]);
  const SKILL_GROUPS = [
    { key: "language", title: "Languages", categories: ["language"] },
    { key: "framework", title: "Frameworks & Libraries", categories: ["framework"] },
    { key: "tool", title: "Tools & Systems", categories: ["tool", "math"] },
  ];

  const esc = value => String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]));
  // People paste "github.com/name" far more often than they type a scheme, so a
  // missing one is filled in rather than rejected. Parsing with no base keeps a
  // schemeless value from resolving against this origin as a same-site path.
  const webUrl = value => {
    const raw = String(value || "").trim();
    if (!raw) return null;
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
      return ["http:", "https:"].includes(url.protocol) && url.hostname.includes(".") ? url : null;
    } catch (_) {
      return null;
    }
  };
  const href = value => {
    const url = webUrl(value);
    return url ? esc(url.href) : "#";
  };
  const icon = name => `<svg aria-hidden="true"><use href="#icon-${name}"/></svg>`;
  const localMode = () => state.browserLocal;

  function say(message) {
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
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
      if (location.pathname !== "/login/") location.assign("/login/");
      return new Promise(() => {});
    }
    if (response.status === 204) return null;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : "Request failed");
    return payload;
  }

  async function loadAll() {
    const [profile, entries, skills, variants, jobs, resumes] = await Promise.all([
      api("/profile"), api("/entries"), api("/skills"), api("/variants"),
      api("/jobs"), api("/resumes"),
    ]);
    state.profile = profile;
    state.entries = entries.entries || [];
    state.skills = skills.skills || [];
    state.variants = variants.variants || [];
    state.jobs = jobs.jobs || [];
    state.resumes = resumes.resumes || [];
    state.browserLocal = Boolean(window.OneShotVisitorData && await window.OneShotVisitorData.isLocal());
    if (!state.resumes.some(resume => resume.id === state.resumeId)) state.resumeId = state.resumes[0]?.id ?? null;
  }

  const currentResume = () => state.resumes.find(resume => resume.id === state.resumeId) || null;
  const templateFor = resume => resume.selection?.template || resume.template || "main";
  const entriesOf = kind => state.entries.filter(entry => entry.kind === kind);
  const dates = entry => [entry.start_date, entry.end_date].filter(Boolean).join(" – ");
  const targetFor = resume => state.jobs.find(job => job.id === resume?.target_job_id) || null;
  const selectedEntry = (resume, entryId) => (resume.selection?.entries || []).find(pick => pick.entry_id === entryId);
  const selectedBullet = (resume, bulletId) => (resume.selection?.entries || []).some(pick =>
    (pick.bullets || []).some(bullet => bullet.bullet_id === bulletId));
  const selectedSkill = (resume, skillId) => (resume.selection?.skills || []).includes(skillId);
  const showsDetail = (resume, entryId) => (resume.selection?.entries || []).find(item => item.entry_id === entryId)?.show_detail !== false;

  function audienceOptions(selected, { includeAll = true } = {}) {
    const options = includeAll ? [{ key: "all", label: "All resumes" }] : [{ key: "", label: "All profile content" }];
    return options.concat(state.variants).map(({ key, label }) =>
      `<option value="${esc(key)}" ${key === (selected ?? "") ? "selected" : ""}>${esc(label || key)}</option>`
    ).join("");
  }

  function updateChrome() {
    document.querySelectorAll("[data-tab]").forEach(button => {
      const selected = button.dataset.tab === state.tab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    document.querySelector("[data-resume-count]").textContent = state.resumes.length;
    view.setAttribute("aria-labelledby", state.tab === "profile" ? "profile-tab" : "resumes-tab");
    tabAction.hidden = state.tab !== "profile";
    view.classList.toggle("tailoring-view", state.tab === "resumes");
    renderTabAction();
  }

  function missingSections() {
    const missing = [];
    if (!state.addingSkill && !state.skills.some(skill => skill.category !== "coursework")) missing.push({ key: "skills", label: "Skills" });
    ["experience", "project", "research", "leadership"].forEach(kind => {
      if (state.addingKind !== kind && !entriesOf(kind).length) missing.push({ key: kind, label: KIND[kind].title });
    });
    return missing;
  }

  function renderTabAction() {
    if (state.tab !== "profile") {
      tabAction.innerHTML = "";
      return;
    }
    const missing = missingSections();
    tabAction.hidden = !missing.length;
    tabAction.innerHTML = missing.length ? `<div class="add-section">
      <button type="button" data-action="toggle-add-section" aria-expanded="false">${icon("plus")}Add section</button>
      <div class="popover" data-add-section-menu hidden>${missing.map(item =>
        `<button type="button" data-action="add-section" data-section="${item.key}">${esc(item.label)}</button>`).join("")}</div>
    </div>` : "";
  }

  function render() {
    updateChrome();
    if (state.tab === "profile") renderProfile();
    else renderResumes();
  }

  function sectionBar(key, title, addLabel = "", fixed = false) {
    const open = fixed || state.openSections.has(key);
    return `<header class="section-bar">
      ${fixed ? "" : `<button class="section-toggle" type="button" data-action="toggle-section" data-section="${key}" aria-expanded="${open}" aria-label="${open ? "Collapse" : "Expand"} ${esc(title)}">${icon("down")}</button>`}
      <h2>${esc(title)}</h2>
      ${addLabel ? `<button class="section-add" type="button" data-action="section-add" data-section="${key}">${icon("plus")}${esc(addLabel)}</button>` : ""}
    </header>`;
  }

  function editableValue(label, value, type, id = "", empty = "Add") {
    const attrs = type === "profile"
      ? `data-action="edit-profile-field" data-field="${esc(id)}"`
      : type === "entry" ? `data-action="edit-entry-field" data-entry="${esc(id.split(":")[0])}" data-field="${esc(id.split(":")[1])}"`
        : type === "resume" ? `data-action="edit-resume-field" data-field="${esc(id)}"`
          : "";
    return `<div class="field-value ${value ? "" : "is-empty"}"><strong><button class="value-trigger" type="button" ${attrs} aria-label="Edit ${esc(label)}"><span>${esc(value || empty)}</span><svg class="edit-cue" aria-hidden="true"><use href="#icon-edit"/></svg></button></strong></div>`;
  }

  function contactSection(readOnly = false, resume = null) {
    const profile = state.profile || {};
    if (readOnly) {
      const details = [profile.email, profile.phone, profile.location].filter(Boolean);
      const links = (profile.links || []).map(link => `<a href="${href(link.url)}" target="_blank" rel="noreferrer">${esc(link.label || link.url)}</a>`).join("");
      return `<article class="resume-section contact-section">
        <header class="section-bar"><h2>Contact</h2></header>
        <div class="section-body compact-contact">
          <div class="contact-summary"><strong>${esc(profile.full_name || "Add your name in Profile")}</strong>
            <div class="contact-details">${details.map(detail => `<span>${esc(detail)}</span>`).join("") || `<span>No contact details added.</span>`}</div>
            ${links ? `<div class="profile-links">${links}</div>` : ""}</div>
        </div></article>`;
    }
    const field = (label, key, empty) => editableValue(label, profile[key], "profile", key, empty);
    const links = (profile.links || []).map((link, index) => `<span class="link-item"><a href="${href(link.url)}" target="_blank" rel="noreferrer">${esc(link.label || link.url)}</a><button class="field-pencil" type="button" data-action="edit-link" data-index="${index}" aria-label="Edit ${esc(link.label || "link")}">${icon("edit")}</button></span>`).join("");
    return `<article class="resume-section contact-section">
      ${sectionBar("contact", "Contact", "", true)}
      <div class="section-body compact-contact profile-contact">
        <div class="contact-summary">
          <div class="profile-contact-name">${field("Name", "full_name", "Add name")}</div>
          <div class="contact-details">${field("Email", "email", "Add email")}${field("Phone", "phone", "Add phone")}${field("Location", "location", "Add location")}</div>
          <div class="profile-links">${links}<button class="link-add" type="button" data-action="add-link" aria-label="Add link">${icon("plus")}Add link</button></div>
        </div>
      </div>
    </article>`;
  }

  function educationSection(readOnly = false, resume = null) {
    const education = entriesOf("education");
    const courses = state.skills.filter(skill => skill.category === "coursework");
    const entries = education.map(entry => educationEntry(entry, readOnly, resume)).join("");
    const courseItems = courses.map(course => {
      const picked = !resume || selectedSkill(resume, course.id);
      return `<span class="course-item ${resume && !picked ? "not-selected" : ""} ${resume ? "selectable" : ""}" ${resume ? `role="button" tabindex="0" aria-pressed="${picked}" aria-label="Include ${esc(course.name)}" data-action="toggle-skill" data-id="${course.id}"` : ""}>
        ${readOnly ? `<span>${esc(course.name)}</span>` : `<button class="value-trigger" type="button" data-action="edit-skill" data-id="${course.id}" aria-label="Edit ${esc(course.name)}"><span>${esc(course.name)}</span><svg class="edit-cue" aria-hidden="true"><use href="#icon-edit"/></svg></button>`}</span>`;
    }).join("");
    const addForm = state.addingKind === "education" && !readOnly ? newEntryForm("education") : "";
    const courseForm = state.addingCourse && !readOnly ? skillForm(true) : "";
    return `<article class="resume-section education-section">
      ${sectionBar("education", "Education", readOnly ? "" : KIND.education.add, true)}
      <div class="section-body">${addForm}${entries || `<p class="readonly-note">No education added.</p>`}
        <div class="coursework"><div class="coursework-head"><span class="coursework-label">Coursework</span>${readOnly ? "" : `<button class="section-add" type="button" data-action="add-course">${icon("plus")}Add course</button>`}</div>
          ${courseForm}<div class="course-list">${courseItems || `<span class="readonly-note">No coursework added.</span>`}</div></div>
      </div>
    </article>`;
  }

  function educationEntry(entry, readOnly, resume = null) {
    const gpaShown = !resume || showsDetail(resume, entry.id);
    const gpaAttrs = resume ? `class="education-detail selectable ${gpaShown ? "" : "not-selected"}" role="button" tabindex="0" data-action="toggle-detail" data-id="${entry.id}" aria-pressed="${gpaShown}" aria-label="Include GPA" title="${gpaShown ? "Hide GPA on this resume" : "Show GPA on this resume"}"` : `class="education-detail"`;
    const value = (label, field, shown, empty) => readOnly
      ? `<div class="field-value ${shown ? "" : "is-empty"}"><strong>${esc(shown || "—")}</strong></div>`
      : editableValue(label, shown, "entry", `${entry.id}:${field}`, empty);
    return `<div class="entry-block education-entry" data-entry-id="${entry.id}">
      <div class="entry-head"><div class="entry-heading"><div class="entry-title-line">${value("School", "org", entry.org, "Add school")}</div>
        <div class="education-degree">${value("Degree", "role", entry.role, "Add degree")}</div></div>
        ${readOnly ? "" : entryActions(entry)}</div>
      <div class="education-meta">
        ${value("Dates", "dates", dates(entry), "Add dates")}<span class="separator" aria-hidden="true">·</span>
        ${value("Location", "location", entry.location, "Add location")}<span class="separator" aria-hidden="true">·</span>
        <div ${gpaAttrs}><span>GPA</span>${value("GPA", "detail", String(entry.detail || "").replace(/^GPA\s*:\s*/i, ""), "Add GPA")}</div>
      </div>
    </div>`;
  }

  function skillsSection(readOnly = false, resume = null) {
    const open = state.openSections.has("skills");
    const rows = SKILL_GROUPS.map(group => {
      const skills = state.skills.filter(skill => group.categories.includes(skill.category));
      return `<div class="skill-row"><span class="skill-label">${esc(group.title)}</span><div class="skill-list">${skills.map(skill => {
        const picked = !resume || selectedSkill(resume, skill.id);
        return `<span class="skill-item ${resume && !picked ? "not-selected" : ""} ${resume ? "selectable" : ""}" ${resume ? `role="button" tabindex="0" aria-pressed="${picked}" aria-label="Include ${esc(skill.name)}" data-action="toggle-skill" data-id="${skill.id}"` : ""}>
          ${readOnly ? `<span>${esc(skill.name)}</span>` : `<button class="value-trigger" type="button" data-action="edit-skill" data-id="${skill.id}" aria-label="Edit ${esc(skill.name)}"><span>${esc(skill.name)}</span><svg class="edit-cue" aria-hidden="true"><use href="#icon-edit"/></svg></button>`}</span>`;
      }).join("") || `<span class="readonly-note">—</span>`}</div></div>`;
    }).join("");
    return `<article class="resume-section ${open ? "" : "collapsed"}">${sectionBar("skills", "Skills", readOnly ? "" : "Add skill")}
      <div class="section-body">${state.addingSkill && !readOnly ? skillForm(false) : ""}<div class="skill-rows">${rows}</div></div></article>`;
  }

  function profileEntrySection(kind) {
    const open = state.openSections.has(kind);
    const records = entriesOf(kind);
    return `<article class="resume-section ${open ? "" : "collapsed"}">${sectionBar(kind, KIND[kind].title, KIND[kind].add)}
      <div class="section-body">${state.addingKind === kind ? newEntryForm(kind) : ""}${records.map(entry => entryBlock(entry, false, null)).join("")}</div></article>`;
  }

  function entryActions(entry) {
    return `<div class="entry-actions"><button class="entry-more" type="button" data-action="toggle-entry-menu" aria-label="Entry actions" aria-expanded="false">${icon("more")}</button>
      <div class="popover entry-menu" hidden><button class="danger" type="button" data-action="delete-entry" data-id="${entry.id}">Delete</button></div></div>`;
  }

  // Header fields a resume may reword for itself (resume_models.EntryPick).
  const ENTRY_OVERRIDES = ["org", "role", "location", "start_date", "end_date", "detail"];
  const shownEntry = (entry, resume) => {
    const pick = resume && selectedEntry(resume, entry.id);
    if (!pick) return entry;
    const shown = { ...entry };
    ENTRY_OVERRIDES.forEach(field => { if (pick[field] != null) shown[field] = pick[field]; });
    return shown;
  };

  function entryBlock(entry, readOnly, resume) {
    entry = shownEntry(entry, resume);
    const picked = !resume || Boolean(selectedEntry(resume, entry.id));
    const titleFields = entry.kind === "project" ? ["org", "role"] : ["role", "org"];
    const labels = entry.kind === "project" ? ["Project", "Description"] : ["Role", entry.kind === "experience" ? "Company" : "Organization"];
    const title = titleFields.map((field, index) => {
      const value = entry[field];
      const display = readOnly ? `<div class="field-value"><strong>${esc(value || "—")}</strong></div>` : editableValue(labels[index], value, "entry", `${entry.id}:${field}`, `Add ${labels[index].toLowerCase()}`);
      return `${index ? '<span class="separator">·</span>' : ""}${display}`;
    }).join("");
    const meta = [
      ["Location", "location", entry.location],
      ["Dates", "dates", dates(entry)],
      ["Link", "url", entry.url ? "View link" : "Add link"],
    ].filter(([, field, value]) => !readOnly || (field === "url" ? Boolean(entry.url) : Boolean(value))).map(([label, field, value], index) => {
      const shown = field === "url" && entry.url ? `<a href="${href(entry.url)}" target="_blank" rel="noreferrer">${esc(value)}</a>` : esc(value || `Add ${label.toLowerCase()}`);
      const display = readOnly ? `<span>${shown}</span>` : field === "url" && entry.url
        ? `<span class="field-value"><strong>${shown}</strong><button class="field-pencil" type="button" data-action="edit-entry-field" data-entry="${entry.id}" data-field="${field}" aria-label="Edit ${label}">${icon("edit")}</button></span>`
        : editableValue(label, field === "url" ? entry.url : value, "entry", `${entry.id}:${field}`, `Add ${label.toLowerCase()}`);
      return `${index ? '<span class="separator">·</span>' : ""}${display}`;
    }).join("");
    const pickedCount = resume ? entry.bullets.filter(bullet => selectedBullet(resume, bullet.id)).length : 0;
    const partial = resume && pickedCount > 0 && pickedCount < entry.bullets.length;
    const headAttrs = resume ? `role="button" tabindex="0" aria-pressed="${partial ? "mixed" : picked}" aria-label="Include ${esc(entry.role || entry.org)}" data-action="toggle-entry" data-id="${entry.id}"` : "";
    return `<div class="entry-block ${resume && !picked ? "not-selected" : ""}" data-entry-id="${entry.id}">
      <div class="entry-head ${resume ? "selectable" : ""}" ${headAttrs}><div class="entry-heading"><div class="entry-title-line">${title}</div><div class="entry-meta">${meta}${resume ? `<span class="entry-pick-count">${pickedCount} of ${entry.bullets.length} bullets</span>` : ""}</div></div>
        ${resume ? "" : entryActions(entry)}</div>
      <div class="bullet-list">${entry.bullets.map(bullet => bulletRow(entry, bullet, readOnly, resume)).join("")}</div>
      ${readOnly ? "" : state.addingBulletEntry === entry.id ? bulletForm(entry.id) : `<button class="bullet-add-tail" type="button" data-action="add-bullet" data-entry="${entry.id}" aria-label="Add bullet">${icon("plus")}Add bullet</button>`}
    </div>`;
  }

  function bulletRow(entry, bullet, readOnly, resume) {
    const pick = resume ? selectedEntry(resume, entry.id)?.bullets?.find(item => item.bullet_id === bullet.id) : null;
    const selected = !resume || Boolean(pick);
    const text = pick?.text_override || bullet.text;
    return `<div class="bullet-row ${resume && !selected ? "not-selected" : ""} ${resume ? "selectable" : ""}" ${resume ? `role="button" tabindex="0" aria-pressed="${selected}" aria-label="Include bullet: ${esc(text)}" data-action="toggle-bullet" data-entry="${entry.id}" data-id="${bullet.id}"` : ""}>
      <span class="bullet-mark" aria-hidden="true">•</span><div class="bullet-value"><p>${esc(text)}</p>
      <button class="field-pencil" type="button" data-action="${resume ? "edit-resume-bullet" : "edit-bullet"}" data-entry="${entry.id}" data-id="${bullet.id}" aria-label="Edit bullet">${icon("edit")}</button></div></div>`;
  }

  function newEntryForm(kind) {
    const project = kind === "project";
    const education = kind === "education";
    const first = project ? "Project name" : education ? "School" : "Role";
    const second = project ? "Description" : education ? "Degree" : kind === "experience" ? "Company" : "Organization";
    return `<form class="inline-add" data-form="entry" data-kind="${kind}"><div class="inline-add-grid">
      <label>${first}<input name="primary" required autofocus></label><label>${second}<input name="secondary"></label>
      <label>Location<input name="location" placeholder="City, State"></label><label>Dates<input name="dates" placeholder="Start – end"></label>
      ${education ? `<label>GPA<input name="detail"></label>` : `<label>Link<input name="url" placeholder="https://"></label>`}
      </div><div class="inline-add-actions"><button type="submit">Add</button><button class="cancel" type="button" data-action="cancel-add">Cancel</button></div></form>`;
  }

  function skillForm(coursework) {
    return `<form class="inline-skill-form" data-form="skill" data-coursework="${coursework}">
      ${coursework ? "" : `<select name="category" aria-label="Skill category"><option value="language">Languages</option><option value="framework">Frameworks & Libraries</option><option value="tool">Tools & Systems</option></select>`}
      <input name="name" required placeholder="${coursework ? "Course name" : "Skill"}" autofocus>
      <div class="inline-add-actions"><button type="submit">Add</button><button class="cancel" type="button" data-action="cancel-add">Cancel</button></div></form>`;
  }

  function bulletForm(entryId) {
    return `<form class="inline-add" data-form="bullet" data-entry="${entryId}"><div class="inline-editor"><textarea name="text" required autofocus placeholder="Add a bullet point"></textarea></div>
      <div class="inline-add-actions"><button type="submit">Add</button><button class="cancel" type="button" data-action="cancel-add">Cancel</button></div></form>`;
  }

  function renderProfile() {
    const visible = new Set(["education", ...state.entries.map(entry => entry.kind)]);
    if (state.skills.some(skill => skill.category !== "coursework") || state.addingSkill) visible.add("skills");
    if (state.addingKind) visible.add(state.addingKind);
    const sections = [contactSection(false)];
    SECTION_ORDER.forEach(key => {
      if (!visible.has(key)) return;
      if (key === "education") sections.push(educationSection(false));
      else if (key === "skills") sections.push(skillsSection(false));
      else sections.push(profileEntrySection(key));
    });
    view.innerHTML = `<article class="profile-document"><div class="section-list">${sections.join("")}</div></article>`;
    queueMicrotask(() => { growAll(); view.querySelector("[autofocus]")?.focus(); });
  }

  function resumeEntrySection(kind, resume) {
    const records = entriesOf(kind);
    if (!records.length) return "";
    const open = state.openSections.has(kind);
    return `<article class="resume-section ${open ? "" : "collapsed"}">${sectionBar(kind, KIND[kind].title)}
      <div class="section-body">${records.map(entry => entryBlock(entry, true, resume)).join("")}</div></article>`;
  }

  function resumePicker(resume) {
    const cards = state.resumes.map(item => {
      const date = item.updated_at ? new Date(item.updated_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
      if (state.renamingResumeId === item.id) return `<div class="resume-card ${item.id === resume.id ? "selected" : ""}"><form data-form="rename-resume" data-id="${item.id}" class="inline-editor"><input name="name" value="${esc(item.name)}" required autofocus><button class="inline-icon" type="submit" aria-label="Save">${icon("check")}</button><button class="inline-icon cancel" type="button" data-action="cancel-rename" aria-label="Cancel">${icon("close")}</button></form></div>`;
      return `<div class="resume-card ${item.id === resume.id ? "selected" : ""}"><button class="resume-card-main" type="button" data-action="choose-resume" data-id="${item.id}"><strong>${esc(item.name)}</strong>${date ? `<span>Edited ${date}</span>` : ""}</button>
        <span class="card-menu"><button class="entry-more" type="button" data-action="toggle-resume-menu" aria-label="Resume actions" aria-expanded="false">${icon("more")}</button><span class="popover" hidden><button type="button" data-action="rename-resume" data-id="${item.id}">Rename</button><button class="danger" type="button" data-action="delete-resume" data-id="${item.id}">Delete</button></span></span></div>`;
    }).join("");
    return `<div class="resume-picker"><button class="resume-picker-trigger" type="button" data-action="toggle-resume-picker" aria-label="Choose resume" aria-expanded="false" title="Choose resume"><span>${esc(resume.name)}</span>${icon("down")}</button><div class="popover resume-list" hidden>${cards}<button class="resume-list-create" type="button" data-action="new-resume">${icon("plus")}New resume</button></div></div>`;
  }

  function renderResumes() {
    const resume = currentResume();
    if (!resume) {
      view.innerHTML = `<section class="empty-state resume-empty"><button class="button primary" type="button" data-action="new-resume">${icon("plus")}New resume</button><p>Create resume with customized profile</p></section>`;
      return;
    }
    const target = targetFor(resume);
    const content = [contactSection(true, resume), educationSection(true, resume)];
    if (state.skills.some(skill => skill.category !== "coursework")) content.push(skillsSection(true, resume));
    ["experience", "project", "research", "leadership"].forEach(kind => content.push(resumeEntrySection(kind, resume)));
    view.innerHTML = `<article class="resume-document">
      <header class="document-head"><div class="document-identity"><div class="document-title">${resumePicker(resume)}</div></div>
        <div class="document-actions"><div class="mode-switch" aria-label="Resume display"><button type="button" data-action="show-content" aria-pressed="${state.mode === "content"}">${icon("edit")}Content</button><button type="button" data-action="show-pdf" aria-pressed="${state.mode === "pdf"}">${icon("eye")}Preview</button></div><button class="button small" type="button" data-action="export-pdf">${icon("download")}Export PDF</button></div>
      </header>
      <div class="resume-availability resume-field"><span class="field-label">Availability</span>${editableValue("Availability", resume.availability_line, "resume", "availability_line", "Add availability")}</div>
      ${target ? `<div class="target-line"><span>Target</span><strong>${esc(target.company)} · ${esc(target.title)}</strong>${target.url ? `<a href="${href(target.url)}" target="_blank" rel="noreferrer">View role ${icon("external")}</a>` : ""}</div>` : ""}
      ${state.mode === "content" ? `<div class="resume-content section-list">${content.join("")}</div>` : `<div class="resume-preview"><div class="preview-tools"><label for="resume-design">Design</label><select id="resume-design" class="design-select" data-resume-template>${[["main", "Main"], ["barlow", "Barlow"]].map(([value, label]) => `<option value="${value}" ${templateFor(resume) === value ? "selected" : ""}>${label}</option>`).join("")}</select></div><div class="pdf-stage"><p class="pdf-loading">Building preview…</p><iframe class="pdf-frame" title="Resume PDF preview" hidden></iframe></div></div>`}
    </article>`;
    queueMicrotask(() => {
      growAll();
      view.querySelector("[autofocus]")?.focus();
      if (state.mode === "pdf") loadPdfPreview();
    });
  }

  function closeMenus(except = null) {
    document.querySelectorAll(".popover").forEach(menu => {
      // Skip ancestors too: the resume card menu lives inside the picker popover.
      if (menu !== except && !menu.contains(except)) {
        menu.hidden = true;
        menu.previousElementSibling?.setAttribute("aria-expanded", "false");
      }
    });
  }

  function cloneSelection(resume) {
    return JSON.parse(JSON.stringify(resume.selection || { entries: [], skills: [] }));
  }

  async function patchResume(resume, fields, message = "Saved automatically") {
    const updated = await api(`/resumes/${resume.id}`, { method: "PATCH", body: fields });
    state.resumes[state.resumes.findIndex(item => item.id === resume.id)] = updated;
    if (message) say(message);
    return updated;
  }

  async function toggleSkill(skillId) {
    const resume = currentResume();
    const selection = cloneSelection(resume);
    const set = new Set(selection.skills || []);
    if (set.has(skillId)) set.delete(skillId); else set.add(skillId);
    selection.skills = [...set];
    await patchResume(resume, { selection }, "");
    renderResumes();
  }

  async function toggleBullet(entryId, bulletId) {
    const resume = currentResume();
    const selection = cloneSelection(resume);
    let pick = selection.entries.find(item => item.entry_id === entryId);
    if (!pick) { pick = { entry_id: entryId, bullets: [] }; selection.entries.push(pick); }
    const index = pick.bullets.findIndex(item => item.bullet_id === bulletId);
    if (index >= 0) pick.bullets.splice(index, 1); else pick.bullets.push({ bullet_id: bulletId, text_override: null });
    if (!pick.bullets.length) selection.entries = selection.entries.filter(item => item.entry_id !== entryId);
    await patchResume(resume, { selection }, "");
    renderResumes();
  }

  async function toggleDetail(entryId) {
    const resume = currentResume();
    const selection = cloneSelection(resume);
    const pick = selection.entries.find(item => item.entry_id === entryId);
    if (pick) pick.show_detail = pick.show_detail === false;
    else selection.entries.push({ entry_id: entryId, bullets: [], show_detail: false });
    await patchResume(resume, { selection }, "");
    renderResumes();
  }

  function startResumeField(button) {
    const resume = currentResume();
    const field = button.dataset.field;
    startInlineEditor(button, {
      scope: ".field-value", value: resume[field] || "", label: field,
      save: async value => { await patchResume(resume, { [field]: value }); renderResumes(); },
    });
  }

  async function toggleEntry(entryId) {
    const resume = currentResume();
    const entry = state.entries.find(item => item.id === entryId);
    const selection = cloneSelection(resume);
    const existing = selection.entries.find(item => item.entry_id === entryId);
    if (!entry.bullets.length) {
      selection.entries = existing ? selection.entries.filter(item => item.entry_id !== entryId) : selection.entries.concat({ entry_id: entryId, bullets: [] });
    } else {
      const all = existing && existing.bullets.length === entry.bullets.length;
      if (all) selection.entries = selection.entries.filter(item => item.entry_id !== entryId);
      else {
        const overrides = new Map((existing?.bullets || []).map(item => [item.bullet_id, item.text_override ?? null]));
        // Spread the old pick so its header overrides and show_detail survive.
        const replacement = { ...existing, entry_id: entryId, bullets: entry.bullets.map(bullet => ({ bullet_id: bullet.id, text_override: overrides.get(bullet.id) ?? null })) };
        selection.entries = selection.entries.filter(item => item.entry_id !== entryId).concat(replacement);
      }
    }
    await patchResume(resume, { selection }, "");
    renderResumes();
  }

  function parseDateRange(raw) {
    const parts = raw.split(/\s+[–—-]\s+/).map(value => value.trim());
    return parts.length > 1 ? { start_date: parts[0], end_date: parts.slice(1).join(" – ") } : { start_date: "", end_date: raw.trim() };
  }

  function startInlineEditor(button, config) {
    const scope = button.closest(config.scope);
    if (!scope || scope.querySelector(".inline-editor")) return;
    const original = scope.innerHTML;
    const text = scope.querySelector(".value-trigger > span") || scope.querySelector("strong") || scope;
    const textStyle = getComputedStyle(text);
    const font = textStyle.font;
    const measure = document.createElement("canvas").getContext("2d");
    measure.font = `${textStyle.fontWeight} ${textStyle.fontSize} ${textStyle.fontFamily}`;
    const chip = scope.matches(".skill-item, .course-item");
    if (chip) {
      const bounds = scope.getBoundingClientRect();
      scope.style.width = `${bounds.width}px`;
      scope.style.height = `${bounds.height}px`;
      scope.classList.add("editing-chip");
    }
    scope.innerHTML = `<form class="inline-editor value-editor"><input name="value" value="${esc(config.value)}" aria-label="${esc(config.label)}" autofocus><button class="inline-icon" type="submit" aria-label="Save">${icon("check")}</button><button class="inline-icon cancel" type="button" aria-label="Cancel">${icon("close")}</button>${config.remove ? `<button class="inline-icon cancel remove" type="button" aria-label="Delete">${icon("trash")}</button>` : ""}</form>`;
    const form = scope.querySelector("form");
    form.style.font = font;
    const restore = () => {
      scope.innerHTML = original;
      if (chip) { scope.classList.remove("editing-chip"); scope.style.removeProperty("width"); scope.style.removeProperty("height"); }
      scope.querySelector(".value-trigger, .field-pencil")?.focus({ preventScroll: true });
    };
    form.querySelector(".cancel").onclick = restore;
    form.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); restore(); }
    });
    if (config.remove) form.querySelector(".remove").onclick = config.remove;
    form.onsubmit = async event => {
      event.preventDefault();
      const value = form.elements.value.value.trim();
      try { await config.save(value); } catch (error) { say(error.message); restore(); }
    };
    const input = form.elements.value;
    const fit = () => {
      form.style.setProperty("--edit-input-width", `${Math.ceil(Math.max(chip ? 40 : 64, measure.measureText(input.value || " ").width + 10))}px`);
      if (chip) {
        form.style.left = "-1px";
        const overflow = form.getBoundingClientRect().right - (innerWidth - 20);
        if (overflow > 0) form.style.left = `${-1 - overflow}px`;
      }
    };
    fit();
    input.addEventListener("input", fit);
    input.focus();
    input.select();
  }

  function startProfileField(button) {
    const field = button.dataset.field;
    startInlineEditor(button, {
      scope: ".field-value", value: state.profile[field] || "", label: field,
      save: async value => { state.profile = await api("/profile", { method: "PUT", body: { [field]: value } }); renderProfile(); say("Saved automatically"); },
    });
  }

  function startEntryField(button) {
    const entry = state.entries.find(item => item.id === Number(button.dataset.entry));
    const field = button.dataset.field;
    if (!entry) return;
    const value = field === "dates" ? dates(entry) : entry[field] || "";
    startInlineEditor(button, {
      scope: ".field-value", value, label: field,
      save: async next => {
        const body = field === "dates" ? parseDateRange(next) : { [field]: next };
        await api(`/entries/${entry.id}`, { method: "PATCH", body });
        await refresh(); say("Saved automatically");
      },
    });
  }

  function startBulletEditor(button, resumeOverride) {
    const entry = state.entries.find(item => item.id === Number(button.dataset.entry));
    const bullet = entry?.bullets.find(item => item.id === Number(button.dataset.id));
    const row = button.closest(".bullet-row");
    if (!bullet || !row) return;
    const resume = currentResume();
    const pick = resumeOverride ? selectedEntry(resume, entry.id)?.bullets?.find(item => item.bullet_id === bullet.id) : null;
    const value = pick?.text_override || bullet.text;
    const textFont = getComputedStyle(row.querySelector(".bullet-value p")).font;
    const original = row.innerHTML;
    row.innerHTML = `<span class="bullet-mark">•</span><form class="inline-editor"><textarea name="text" autofocus>${esc(value)}</textarea><button class="inline-icon" type="submit" aria-label="Save">${icon("check")}</button><button class="inline-icon cancel" type="button" aria-label="Cancel">${icon("close")}</button>${resumeOverride ? "" : `<button class="inline-icon cancel remove" type="button" aria-label="Delete bullet">${icon("trash")}</button>`}</form>`;
    const form = row.querySelector("form");
    form.style.font = textFont;
    growAll(row);
    const restore = () => { row.innerHTML = original; row.querySelector(".field-pencil")?.focus({ preventScroll: true }); };
    form.querySelector(".cancel").onclick = restore;
    form.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); restore(); }
    });
    if (!resumeOverride) form.querySelector(".remove").onclick = async () => {
      if (!confirm("Delete this bullet?")) return;
      await api(`/bullets/${bullet.id}`, { method: "DELETE" });
      await refresh();
    };
    form.onsubmit = async event => {
      event.preventDefault();
      const text = form.elements.text.value.trim();
      if (!text) return;
      try {
        if (!resumeOverride) await api(`/bullets/${bullet.id}`, { method: "PATCH", body: { text } });
        else {
          const selection = cloneSelection(resume);
          let entryPick = selection.entries.find(item => item.entry_id === entry.id);
          if (!entryPick) { entryPick = { entry_id: entry.id, bullets: [] }; selection.entries.push(entryPick); }
          let bulletPick = entryPick.bullets.find(item => item.bullet_id === bullet.id);
          if (!bulletPick) { bulletPick = { bullet_id: bullet.id, text_override: null }; entryPick.bullets.push(bulletPick); }
          bulletPick.text_override = text === bullet.text ? null : text;
          await patchResume(resume, { selection }, "");
        }
        await refresh(); say("Saved automatically");
      } catch (error) { say(error.message); row.innerHTML = original; }
    };
    form.elements.text.focus();
  }

  function startLinkEditor(index = null) {
    renderProfile();
    const links = state.profile.links || [];
    const link = index === null ? { label: "", url: "" } : links[index];
    const region = view.querySelector(".profile-links");
    region.insertAdjacentHTML("beforeend", `<form class="inline-link-form" data-form="link" data-index="${index ?? ""}"><input name="label" value="${esc(link.label)}" placeholder="Label" aria-label="Link label" autofocus><input name="url" value="${esc(link.url)}" placeholder="github.com/you" type="text" inputmode="url" required aria-label="Link URL"><button class="inline-icon" type="submit" aria-label="Save">${icon("check")}</button><button class="inline-icon cancel" type="button" data-action="cancel-add" aria-label="Cancel">${icon("close")}</button>${index === null ? "" : `<button class="inline-icon cancel" type="button" data-action="delete-link" data-index="${index}" aria-label="Delete link">${icon("trash")}</button>`}</form>`);
    region.querySelector("[autofocus]").focus();
  }

  function startSkillEditor(button) {
    const skill = state.skills.find(item => item.id === Number(button.dataset.id));
    if (!skill) return;
    startInlineEditor(button, {
      scope: ".skill-item, .course-item", value: skill.name, label: "skill",
      save: async name => { await api(`/skills/${skill.id}`, { method: "PATCH", body: { name } }); await refresh(); say("Saved automatically"); },
      remove: async () => {
        if (!confirm(`Delete ${skill.name}?`)) return;
        await api(`/skills/${skill.id}`, { method: "DELETE" });
        await refresh();
      },
    });
  }

  async function refresh() {
    await loadAll();
    render();
  }

  async function loadPdfBlob(resume) {
    // Signed out there is no stored resume to render, so the document travels
    // with the request instead.
    const response = localMode()
      ? await fetch("/api/resume/render/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: state.profile, resume, entries: state.entries, skills: state.skills }),
      })
      : await fetch(`/api/resume/resumes/${resume.id}/pdf`);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.detail || "Could not build PDF");
    }
    return response.blob();
  }

  async function loadPdfPreview() {
    const frame = view.querySelector(".pdf-frame");
    const loading = view.querySelector(".pdf-loading");
    if (!frame) return;
    const resume = currentResume();
    try {
      const blob = await loadPdfBlob(resume);
      if (!frame.isConnected || state.mode !== "pdf") return;
      if (state.pdfUrl) URL.revokeObjectURL(state.pdfUrl);
      state.pdfUrl = URL.createObjectURL(blob);
      frame.src = state.pdfUrl;
      frame.hidden = false;
      loading.hidden = true;
    } catch (error) {
      if (loading.isConnected) loading.textContent = error.message;
    }
  }

  async function exportPdf() {
    const resume = currentResume();
    const blob = await loadPdfBlob(resume);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(resume.name || "resume").replace(/[^a-z0-9]+/gi, "_")}.pdf`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function buildInitialSelection(variant) {
    const matches = audience => !variant || !audience || audience === "all" || audience === variant;
    return {
      entries: state.entries.map(entry => ({
        entry_id: entry.id,
        bullets: entry.bullets.filter(bullet => matches(bullet.audience)).map(bullet => ({ bullet_id: bullet.id, text_override: null })),
      })).filter(pick => pick.bullets.length || !state.entries.find(entry => entry.id === pick.entry_id)?.bullets.length),
      skills: state.skills.filter(skill => matches(skill.audience)).map(skill => skill.id),
    };
  }

  function openResumeDialog(values = {}) {
    const dialog = document.getElementById("resume-dialog");
    const form = dialog.querySelector("form");
    form.reset();
    form.elements.name.value = values.name || "";
    form.elements.target_job_id.innerHTML = `<option value="">No target role</option>${state.jobs.map(job => `<option value="${job.id}">${esc(job.company)} · ${esc(job.title)}</option>`).join("")}`;
    form.elements.variant.innerHTML = audienceOptions(values.variant ?? state.variants[0]?.key ?? "", { includeAll: false });
    form.elements.target_job_id.value = values.target_job_id || "";
    dialog.showModal();
    form.elements.name.focus();
  }

  async function handleAction(button) {
    const action = button.dataset.action;
    if (action === "new-resume") { closeMenus(); return openResumeDialog(); }
    if (action === "toggle-add-section") {
      const menu = button.nextElementSibling; const opening = menu.hidden; closeMenus(menu); menu.hidden = !opening; button.setAttribute("aria-expanded", String(opening)); return;
    }
    if (action === "add-section") {
      closeMenus();
      if (button.dataset.section === "skills") state.addingSkill = true; else state.addingKind = button.dataset.section;
      state.openSections.add(button.dataset.section); render(); return;
    }
    if (action === "toggle-section") {
      const key = button.dataset.section; state.openSections.has(key) ? state.openSections.delete(key) : state.openSections.add(key); render(); return;
    }
    if (action === "section-add") {
      const key = button.dataset.section;
      if (key === "skills") state.addingSkill = true; else state.addingKind = key;
      state.openSections.add(key); renderProfile(); return;
    }
    if (action === "add-course") { state.addingCourse = true; renderProfile(); return; }
    if (action === "add-bullet") { state.addingBulletEntry = Number(button.dataset.entry); renderProfile(); return; }
    if (action === "cancel-add") { state.addingKind = null; state.addingSkill = false; state.addingCourse = false; state.addingBulletEntry = null; render(); return; }
    if (action === "edit-profile-field") return startProfileField(button);
    if (action === "edit-entry-field") return startEntryField(button);
    if (action === "edit-resume-field") return startResumeField(button);
    if (action === "edit-bullet") return startBulletEditor(button, false);
    if (action === "edit-resume-bullet") return startBulletEditor(button, true);
    if (action === "edit-link") return startLinkEditor(Number(button.dataset.index));
    if (action === "add-link") return startLinkEditor();
    if (action === "delete-link") {
      const links = [...(state.profile.links || [])];
      links.splice(Number(button.dataset.index), 1);
      state.profile = await api("/profile", { method: "PUT", body: { links } });
      renderProfile(); say("Link deleted"); return;
    }
    if (action === "edit-skill") return startSkillEditor(button);
    if (action === "toggle-entry-menu" || action === "toggle-resume-menu") {
      const menu = button.nextElementSibling; const opening = menu.hidden; closeMenus(menu); menu.hidden = !opening; button.setAttribute("aria-expanded", String(opening));
      if (opening && action === "toggle-resume-menu") {
        // Keep actions outside the picker's scroll clipping, including its last row.
        menu.style.position = "fixed";
        menu.style.right = "auto";
        const anchor = button.getBoundingClientRect();
        const popup = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(8, Math.min(anchor.right - popup.width, innerWidth - popup.width - 8))}px`;
        menu.style.top = `${Math.max(8, anchor.bottom + popup.height + 4 <= innerHeight ? anchor.bottom + 4 : anchor.top - popup.height - 4)}px`;
      }
      return;
    }
    if (action === "delete-entry") {
      if (confirm("Delete this entry and its bullets?")) { await api(`/entries/${Number(button.dataset.id)}`, { method: "DELETE" }); await refresh(); }
      return;
    }
    if (action === "toggle-resume-picker") {
      const menu = button.nextElementSibling; const opening = menu.hidden; closeMenus(menu); menu.hidden = !opening; button.setAttribute("aria-expanded", String(opening)); return;
    }
    if (action === "choose-resume") { state.resumeId = Number(button.dataset.id); state.mode = "content"; state.renamingResumeId = null; renderResumes(); return; }
    if (action === "rename-resume") { state.renamingResumeId = Number(button.dataset.id); renderResumes(); view.querySelector("[data-action=toggle-resume-picker]").click(); return; }
    if (action === "cancel-rename") { state.renamingResumeId = null; renderResumes(); view.querySelector("[data-action=toggle-resume-picker]").click(); return; }
    if (action === "delete-resume") {
      const id = Number(button.dataset.id);
      if (confirm("Delete this resume? Your Profile content will stay intact.")) { await api(`/resumes/${id}`, { method: "DELETE" }); if (state.resumeId === id) state.resumeId = null; await refresh(); }
      return;
    }
    if (action === "toggle-skill") return toggleSkill(Number(button.dataset.id));
    if (action === "toggle-bullet") return toggleBullet(Number(button.dataset.entry), Number(button.dataset.id));
    if (action === "toggle-entry") return toggleEntry(Number(button.dataset.id));
    if (action === "toggle-detail") return toggleDetail(Number(button.dataset.id));
    if (action === "show-content") { state.mode = "content"; renderResumes(); return; }
    if (action === "show-pdf") { state.mode = "pdf"; renderResumes(); return; }
    if (action === "export-pdf") return exportPdf();
  }

  // A bullet is one or two lines far more often than four, so the box opens at a
  // single row and follows the text rather than reserving height for it.
  function grow(area) {
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight}px`;
  }
  function growAll(root) { (root || view).querySelectorAll("textarea").forEach(grow); }

  view.addEventListener("input", event => {
    if (event.target instanceof HTMLTextAreaElement) grow(event.target);
  });

  view.addEventListener("change", async event => {
    if (!event.target.matches("[data-resume-template]")) return;
    try {
      const resume = currentResume();
      const selection = cloneSelection(resume);
      selection.template = event.target.value;
      await patchResume(resume, { selection });
      renderResumes();
      view.querySelector("[data-resume-template]")?.focus({ preventScroll: true });
    } catch (error) { say(error.message); }
  });

  view.addEventListener("click", async event => {
    // Links inside a selectable entry remain ordinary navigation links.
    if (event.target.closest("a[href]")) return;
    const button = event.target.closest("[data-action]");
    if (!button) return;
    // Saving an inline editor must not activate its selectable parent row.
    const editingForm = event.target.closest("form");
    if (editingForm && !editingForm.contains(button)) return;
    event.preventDefault();
    event.stopPropagation();
    try { await handleAction(button); } catch (error) { say(error.message); }
  });

  tabAction.addEventListener("click", async event => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    try { await handleAction(button); } catch (error) { say(error.message); }
  });

  view.addEventListener("keydown", event => {
    if (!["Enter", " "].includes(event.key) || !event.target.matches('[role="button"][data-action]')) return;
    event.preventDefault(); event.target.click();
  });

  view.addEventListener("submit", async event => {
    const form = event.target;
    event.preventDefault();
    try {
      if (form.dataset.form === "entry") {
        const data = Object.fromEntries(new FormData(form).entries());
        const kind = form.dataset.kind;
        const project = kind === "project";
        const education = kind === "education";
        const range = parseDateRange(data.dates || "");
        await api("/entries", { method: "POST", body: {
          kind, org: project || education ? data.primary : data.secondary,
          role: project || education ? data.secondary : data.primary,
          location: data.location || "", ...range, url: education ? "" : data.url || "", detail: data.detail || "",
        } });
        state.addingKind = null; await refresh(); say(`${KIND[kind].title} added`);
      } else if (form.dataset.form === "bullet") {
        const text = new FormData(form).get("text").trim();
        await api(`/entries/${Number(form.dataset.entry)}/bullets`, { method: "POST", body: { text, audience: "all", tags: [], defense_notes: "" } });
        state.addingBulletEntry = null; await refresh(); say("Bullet added");
      } else if (form.dataset.form === "skill") {
        const data = Object.fromEntries(new FormData(form).entries());
        const coursework = form.dataset.coursework === "true";
        await api("/skills", { method: "POST", body: { category: coursework ? "coursework" : data.category, name: data.name.trim(), audience: "all" } });
        state.addingCourse = false; state.addingSkill = false; await refresh(); say(coursework ? "Course added" : "Skill added");
      } else if (form.dataset.form === "link") {
        const data = Object.fromEntries(new FormData(form).entries());
        const links = [...(state.profile.links || [])];
        const index = form.dataset.index === "" ? null : Number(form.dataset.index);
        const url = webUrl(data.url);
        if (!url) { say("Enter a link like github.com/you"); return; }
        const value = { label: data.label.trim(), url: url.href };
        if (index === null) links.push(value); else links[index] = value;
        state.profile = await api("/profile", { method: "PUT", body: { links } }); renderProfile(); say("Saved automatically");
      } else if (form.dataset.form === "rename-resume") {
        const resume = state.resumes.find(item => item.id === Number(form.dataset.id));
        await patchResume(resume, { name: new FormData(form).get("name").trim() });
        state.renamingResumeId = null; renderResumes();
      }
    } catch (error) { say(error.message); }
  });

  document.querySelector(".page-tabs").addEventListener("click", event => {
    const button = event.target.closest("[data-tab]");
    if (!button) return;
    state.tab = button.dataset.tab; state.mode = "content";
    history.replaceState(null, "", state.tab === "resumes" ? "#resumes" : location.pathname + location.search);
    render();
  });

  document.querySelector(".page-tabs").addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll("[data-tab]")];
    const index = tabs.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].click(); tabs[next].focus();
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    closeMenus();
    document.querySelectorAll("details[open]").forEach(item => item.open = false);
  });

  document.querySelectorAll("[data-close-dialog]").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
  document.getElementById("resume-form").addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      const created = await api("/resumes", { method: "POST", body: {
        name: data.name.trim(), target_job_id: data.target_job_id ? Number(data.target_job_id) : null,
        variant: data.variant, selection: buildInitialSelection(data.variant),
      } });
      state.resumes.unshift(created); state.resumeId = created.id; state.tab = "resumes"; state.mode = "content";
      document.getElementById("resume-dialog").close(); render(); say("Resume created");
    } catch (error) { say(error.message); }
  });

  document.addEventListener("click", event => {
    if (!event.target.closest(".add-section, .resume-picker, .entry-actions, .card-menu")) closeMenus();
  });

  async function openHandoffTarget() {
    const requested = Number(new URLSearchParams(location.hash.replace(/^#/, "")).get("target"));
    if (!requested || !state.jobs.some(job => job.id === requested)) return;
    const existing = state.resumes.find(resume => resume.target_job_id === requested);
    if (existing) state.resumeId = existing.id;
    else {
      const job = state.jobs.find(item => item.id === requested);
      const created = await api("/resumes", { method: "POST", body: {
        name: `${job.company} · ${job.title}`.slice(0, 300), target_job_id: requested,
        variant: state.variants[0]?.key || "", selection: buildInitialSelection(state.variants[0]?.key || ""),
      } });
      state.resumes.unshift(created); state.resumeId = created.id;
    }
    state.tab = "resumes";
    history.replaceState(null, "", location.pathname + location.search);
  }

  (async () => {
    await loadAll();
    await openHandoffTarget();
    render();
  })().catch(error => {
    view.innerHTML = `<section class="empty-state"><h2>Resumes could not load</h2><p>${esc(error.message)}</p></section>`;
  });
})();

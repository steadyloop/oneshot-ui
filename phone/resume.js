/* Resume on phones. The profile is the bank: every resume picks from it, so
   each thing is written once. Entries open as full pages that save as you go;
   bullets, skills, courses and contact details edit in sheets; each resume has
   Content (switches, ticks, per-resume rewording) and Preview pages. The same
   /api/resume endpoints and browser-local guest workspace as the desktop page. */
(function (root) {
  "use strict";
  const P = root.OneShotPhoneShell;
  const { esc, icon, S } = P;

  const KIND = {
    education: { title: "Education", one: "education", fields: [["org", "School", "e.g. University of Washington"], ["role", "Degree", "e.g. B.S. Computer Science"]] },
    experience: { title: "Experience", one: "experience", fields: [["role", "Role", "e.g. Software Engineering Intern"], ["org", "Company", "e.g. Stripe"]] },
    project: { title: "Projects", one: "project", fields: [["org", "Project", "e.g. Trailhead"], ["role", "Description", "e.g. Hiking route planner"]] },
    research: { title: "Research", one: "research", fields: [["role", "Role", "e.g. Undergraduate Researcher"], ["org", "Organization", "e.g. UW Data Lab"]] },
    leadership: { title: "Leadership", one: "leadership role", fields: [["role", "Role", "e.g. President"], ["org", "Organization", "e.g. ACM chapter"]] },
  };
  const SECTION_ORDER = ["education", "skills", "experience", "project", "research", "leadership"];
  const SKILL_GROUPS = [
    { key: "language", title: "Languages", categories: ["language"] },
    { key: "framework", title: "Frameworks & Libraries", categories: ["framework"] },
    { key: "data", title: "Data", categories: ["data"] },
    { key: "tool", title: "Tools & Systems", categories: ["tool", "math"] },
  ];
  const groupOf = category => SKILL_GROUPS.find(group => group.categories.includes(category))?.key || "tool";
  const orgLabel = kind => KIND[kind].fields.find(([key]) => key === "org")[1];

  const state = {
    profile: null, entries: [], skills: [], variants: [], jobs: [], resumes: [], local: false,
    loading: true, error: "", view: root.location.hash === "#resumes" ? "resumes" : "profile",
    added: new Set(), gone: new Set(), v: 0, pdf: { url: null, id: null, key: null, loading: false, error: "" },
  };
  const bump = () => { state.v += 1; };

  /* ───────────── API ───────────── */
  const isLocal = async () => Boolean(root.OneShotVisitorData && await root.OneShotVisitorData.isLocal());
  async function api(path, options = {}) {
    const init = { headers: options.body ? { "Content-Type": "application/json" } : {}, ...options, body: options.body ? JSON.stringify(options.body) : undefined };
    const response = await isLocal() ? await root.OneShotVisitorData.request(`/resume${path}`, init) : await root.fetch(`/api/resume${path}`, init);
    if (response.status === 401) { if (root.location.pathname !== "/login/") root.location.assign("/login/"); return new Promise(() => {}); }
    if (response.status === 204) return null;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(typeof payload.detail === "string" ? payload.detail : Array.isArray(payload.detail) ? payload.detail.map(item => item?.msg).filter(Boolean).join(". ") || "Request failed" : "Request failed");
      error.status = response.status;
      throw error;
    }
    return payload;
  }
  // Leaving the page sends a pending delete; a keepalive fetch outlives it.
  const remove = (path, leaving) => leaving && !state.local
    ? root.fetch(`/api/resume${path}`, { method: "DELETE", keepalive: true })
    : api(path, { method: "DELETE" });

  async function loadAll() {
    const [profile, entries, skills, variants, jobs, resumes] = await Promise.all([
      api("/profile"), api("/entries"), api("/skills"), api("/variants"), api("/jobs"), api("/resumes"),
    ]);
    state.profile = profile || {};
    state.entries = entries?.entries || [];
    state.skills = skills?.skills || [];
    state.variants = variants?.variants || [];
    state.jobs = jobs?.jobs || [];
    state.resumes = resumes?.resumes || [];
    state.local = await isLocal();
  }
  async function refresh() {
    try { await loadAll(); state.error = ""; }
    catch (error) { if (!state.profile) state.error = error.message || "Request failed"; else P.toast(error.message); }
    state.loading = false; bump(); P.render();
  }

  /* ───────────── Reading the bank ───────────── */
  // Deletes wait for their Undo window; until then the item just looks gone.
  const live = (kind, list) => list.filter(item => !state.gone.has(`${kind}:${item.id}`));
  const entries = () => live("entry", state.entries).map(entry => ({ ...entry, bullets: live("bullet", entry.bullets || []) }));
  const skills = () => live("skill", state.skills);
  const resumes = () => live("resume", state.resumes);
  const entryById = id => entries().find(entry => entry.id === Number(id));
  const docById = id => resumes().find(resume => resume.id === Number(id));
  const ofKind = kind => entries().filter(entry => entry.kind === kind);
  const courses = () => skills().filter(skill => skill.category === "coursework");
  const realSkills = () => skills().filter(skill => skill.category !== "coursework");
  const titleOf = entry => (entry.kind === "education" || entry.kind === "project" ? entry.org : entry.role) || entry.org || entry.role || `New ${KIND[entry.kind].one}`;
  const secondOf = entry => entry.kind === "education" || entry.kind === "project" ? entry.role : entry.org;
  const dates = entry => [entry.start_date, entry.end_date].filter(Boolean).join(" – ");
  const bulletWord = n => `${n} bullet${n === 1 ? "" : "s"}`;
  const visibleSections = () => SECTION_ORDER.filter(key => key === "education" || state.added.has(key)
    || (key === "skills" ? realSkills().length > 0 : ofKind(key).length > 0));
  const missingSections = () => SECTION_ORDER.filter(key => !visibleSections().includes(key));
  const webUrl = value => {
    const raw = String(value || "").trim();
    if (!raw) return null;
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
      return ["http:", "https:"].includes(url.protocol) && url.hostname.includes(".") ? url : null;
    } catch (_) { return null; }
  };
  const updated = resume => resume.updated_at ? new Date(resume.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
  const targetOf = resume => state.jobs.find(job => job.id === resume?.target_job_id) || null;

  // Selections, as the desktop page reads and writes them.
  const pickOf = (resume, entryId) => (resume.selection?.entries || []).find(pick => pick.entry_id === entryId) || null;
  const bulletPick = (resume, entryId, bulletId) => pickOf(resume, entryId)?.bullets?.find(item => item.bullet_id === bulletId) || null;
  const skillOn = (resume, skillId) => (resume.selection?.skills || []).includes(skillId);
  const cloneSelection = resume => JSON.parse(JSON.stringify(resume.selection || { entries: [], skills: [] }));
  function buildSelection(variant) {
    const matches = audience => !variant || !audience || audience === "all" || audience === variant;
    return {
      entries: entries().map(entry => ({ entry_id: entry.id, bullets: entry.bullets.filter(bullet => matches(bullet.audience)).map(bullet => ({ bullet_id: bullet.id, text_override: null })) }))
        .filter(pick => pick.bullets.length || !entryById(pick.entry_id)?.bullets.length),
      skills: skills().filter(skill => matches(skill.audience)).map(skill => skill.id),
    };
  }

  /* ───────────── Profile ───────────── */
  const pills = (names, max = 8) => names.length ? `<div class="pills">${names.slice(0, max).map(name => `<span class="pill">${esc(name)}</span>`).join("")}${names.length > max ? `<span class="pill more">+${names.length - max}</span>` : ""}</div>` : "";
  function contactCard() {
    const c = state.profile || {};
    const kv = (label, value) => `<div class="kv"><dt>${label}</dt><dd${value ? "" : ' class="missing"'}>${value ? esc(value) : "Not added"}</dd></div>`;
    const links = (c.links || []).map(link => link.label || link.url).join(", ");
    return `<div class="r-card"><div class="r-card-h"><h2>Contact</h2><button class="edit-btn" type="button" data-act="edit-contact">${icon("pencil")}Edit</button></div><div class="r-card-b"><dl style="margin:0">
      ${kv("Name", c.full_name)}${kv("Email", c.email)}${kv("Phone", c.phone)}${kv("Location", c.location)}${kv("Links", links)}</dl>
      ${c.location ? "" : `<button class="add-line" type="button" data-act="edit-contact">${icon("plus")}Add location</button>`}</div></div>`;
  }
  function entryCard(kind) {
    const list = ofKind(kind);
    const rows = list.map(entry => `<button class="entry-row" type="button" data-entry="${entry.id}"><span class="entry-text"><b>${esc(titleOf(entry))}</b><span class="sub">${esc([secondOf(entry), dates(entry)].filter(Boolean).join(" · "))}</span>${kind === "education" ? (entry.detail ? `<span class="sub">GPA ${esc(String(entry.detail).replace(/^GPA\s*:\s*/i, ""))}</span>` : "") : `<span class="sub faint">${bulletWord(entry.bullets.length)}</span>`}</span>${icon("chev")}</button>`).join("");
    const courseBlock = kind === "education"
      ? `<div class="course-block"><div class="mini-label">Coursework</div><div class="tchips">${courses().map(course => `<button class="tchip plain" type="button" data-course="${course.id}">${esc(course.name)}</button>`).join("")}<button class="tchip add" type="button" data-act="add-course">${icon("plus")}Add course</button></div></div>`
      : "";
    return `<div class="r-card"><div class="r-card-h"><h2>${KIND[kind].title}</h2>${list.length ? `<small class="r-count">${list.length}</small>` : ""}</div><div class="r-card-b">
      ${rows}${courseBlock}<button class="add-line" type="button" data-new-entry="${kind}">${icon("plus")}Add ${KIND[kind].one}</button></div></div>`;
  }
  function skillsCard() {
    const groups = SKILL_GROUPS.map(group => [group.title, realSkills().filter(skill => group.categories.includes(skill.category)).map(skill => skill.name)]).filter(([, names]) => names.length);
    return `<div class="r-card"><div class="r-card-h"><h2>Skills</h2><button class="edit-btn" type="button" data-act="edit-skills">${icon("pencil")}Edit</button></div><div class="r-card-b">
      ${groups.length ? `<dl style="margin:0">${groups.map(([title, names]) => `<div class="skill-group"><dt>${title}</dt><dd>${pills(names)}</dd></div>`).join("")}</dl>` : `<button class="add-line" type="button" data-act="edit-skills">${icon("plus")}Add skills</button>`}</div></div>`;
  }
  function profileMarkup() {
    const missing = missingSections();
    return contactCard() + visibleSections().map(key => key === "skills" ? skillsCard() : entryCard(key)).join("")
      + (missing.length ? `<div style="padding:0 16px 24px"><button class="add-line center" type="button" data-act="add-section">${icon("plus")}Add section</button></div>` : '<div style="height:24px"></div>');
  }
  function resumesMarkup() {
    const list = resumes();
    return `${list.length ? `<div class="card-list" style="margin-top:6px">${list.map(resume => {
      const target = targetOf(resume);
      return `<button class="resume-row" type="button" data-doc="${resume.id}"><span class="doc-ico">${icon("file")}</span><span style="min-width:0"><b>${esc(resume.name)}</b><span>${esc([updated(resume) && `Updated ${updated(resume)}`, target?.company].filter(Boolean).join(" · "))}</span></span><span class="end">${icon("chev")}</span></button>`;
    }).join("")}</div>` : '<div class="empty"><strong>No resumes yet</strong>Each resume picks from your profile, so you only write things once.</div>'}
      <div style="padding:12px 16px 24px"><button class="add-line center" type="button" data-act="new-resume">${icon("plus")}New resume</button></div>`;
  }
  function renderPage() {
    const tabs = [["profile", "Profile", ""], ["resumes", "My resumes", resumes().length]];
    const body = state.loading ? P.stateBlock("loading", { title: "Loading resumes…" })
      : state.error ? P.stateBlock("error", { title: "Resumes could not load", detail: state.error })
      : state.view === "profile" ? profileMarkup() : resumesMarkup();
    return `${P.head("Resume")}<div class="sticky"><div class="segmented" role="tablist" aria-label="Resume pages">${tabs.map(([key, label, n]) => `<button type="button" role="tab" data-view="${key}" aria-selected="${state.view === key}">${label}${n ? `<small>${n}</small>` : ""}</button>`).join("")}</div></div>${body}`;
  }

  /* ───────────── Entry page ───────────── */
  // The entry page draws once; saving updates its status line in place, so
  // the field you moved to keeps focus and the keyboard stays up.
  const entryUi = { status: "", error: "", warned: false, token: 0 };
  const footText = push => push.entryId
    ? `Changes save as you type and show up in every resume that uses this ${KIND[push.entryKind].one}.`
    : `It saves once it has ${{ School: "a school", Project: "a project name", Company: "a company", Organization: "an organization" }[orgLabel(push.entryKind)]}.`;
  function statusMarkup() {
    return entryUi.status === "error" ? `${icon("x")}Not saved` : entryUi.status === "saving" ? "Saving…" : entryUi.status ? `${icon("check")}Saved` : "";
  }
  function showEntryUi() {
    const push = S.push;
    if (push?.kind !== "entry") return;
    const saved = P.$("#saved");
    if (saved) { saved.innerHTML = statusMarkup(); saved.classList.toggle("error", entryUi.status === "error"); saved.classList.toggle("flash", entryUi.status === "flash"); }
    const error = P.$("#entry-error");
    if (error) { error.hidden = !entryUi.error; error.textContent = entryUi.error; }
    const remove = P.$("#entry-delete");
    if (remove) remove.hidden = !push.entryId;
    const foot = P.$("#entry-foot");
    if (foot) foot.textContent = footText(push);
  }
  function setEntryUi(changes) { Object.assign(entryUi, changes); showEntryUi(); }
  function entryPage(push) {
    const saved = push.entryId ? entryById(push.entryId) : null;
    if (push.entryId && !saved) return `<header class="push-bar scrolled"><button class="back" type="button" data-act="back">${icon("back")}Resume</button><span class="push-title"></span><span class="bar-spacer"></span></header><div class="push-scroll"><div class="empty"><strong>This entry is gone</strong>Go back to Resume.</div></div>`;
    const e = { ...(saved || {}), ...push.draft };
    const k = KIND[push.entryKind];
    const input = (key, label, placeholder = "", type = "text") => `<label class="field"><span>${label}</span><input type="text" data-ef="${key}" value="${esc(e[key] || "")}" placeholder="${esc(placeholder)}"${type === "url" ? ' inputmode="url" autocapitalize="off" autocorrect="off"' : ""}${key === "org" ? ' maxlength="300" required' : key === "detail" ? ' maxlength="500"' : key === "url" ? ' maxlength="2000"' : key.endsWith("_date") ? ' maxlength="40"' : ' maxlength="300"'}></label>`;
    return `<header class="push-bar scrolled"><button class="back" type="button" data-act="back">${icon("back")}Resume</button><span class="push-title">${k.title}</span><span class="saved${entryUi.status === "error" ? " error" : ""}" id="saved" role="status">${statusMarkup()}</span></header>
      <div class="push-scroll" id="push-scroll"><div class="form-wrap">
        ${k.fields.map(([key, label, placeholder]) => input(key, label, placeholder)).join("")}
        <p class="status-line error" id="entry-error" role="alert"${entryUi.error ? "" : " hidden"}>${esc(entryUi.error)}</p>
        ${input("location", "Location", "e.g. Seattle, WA")}
        <div class="field-row">${input("start_date", "Start", "e.g. Jun 2026")}${input("end_date", "End", "e.g. Present")}</div>
        ${push.entryKind === "education" ? input("detail", "GPA (optional)", "e.g. 3.85 / 4.0") : input("url", "Link (optional)", "https://", "url")}
        ${push.entryKind === "education" ? "" : `<div class="form-section"><div class="form-section-h"><h3>Bullets</h3>${saved?.bullets.length ? "<small>Tap to edit</small>" : ""}</div>
          ${(saved?.bullets || []).map(bullet => `<button class="bullet-card" type="button" data-bullet="${bullet.id}"><p>${esc(bullet.text)}</p></button>`).join("") || '<p class="form-empty">No bullets yet. Start with what you built and what changed because of it.</p>'}
          <button class="add-line" type="button" data-act="add-bullet">${icon("plus")}Add bullet</button></div>`}
        <button class="btn danger-ghost block" type="button" id="entry-delete" data-act="delete-entry"${saved ? "" : " hidden"}>${icon("trash")}Delete ${k.one}</button>
        <p class="form-foot" id="entry-foot">${esc(footText(push))}</p>
      </div></div>`;
  }
  function skillsPage() {
    return `<header class="push-bar scrolled"><button class="back" type="button" data-act="back">${icon("back")}Resume</button><span class="push-title">Skills</span><span class="bar-spacer"></span></header>
      <div class="push-scroll" id="push-scroll"><div class="form-wrap"><p class="form-lede">Tap a skill to rename it, move it to another group or delete it.</p>
      ${SKILL_GROUPS.map(group => `<div class="form-section"><div class="form-section-h"><h3>${group.title}</h3></div><div class="tchips">
        ${realSkills().filter(skill => group.categories.includes(skill.category)).map(skill => `<button class="tchip plain" type="button" data-skill="${skill.id}">${esc(skill.name)}</button>`).join("")}
        <button class="tchip add" type="button" data-add-skill="${group.key}">${icon("plus")}Add</button></div></div>`).join("")}
      </div></div>`;
  }

  /* ───────────── One resume: Content and Preview ───────────── */
  const switchButton = (on, attrs, label) => `<button class="switch" type="button" role="switch" aria-checked="${on}" aria-label="${esc(label)}" ${attrs}></button>`;
  function docPage(push) {
    const resume = docById(push.id);
    if (!resume) return `<header class="push-bar scrolled"><button class="back" type="button" data-act="back">${icon("back")}Resume</button><span class="push-title"></span><span class="bar-spacer"></span></header><div class="push-scroll"><div class="empty"><strong>This resume is gone</strong>Go back to My resumes.</div></div>`;
    const preview = push.mode === "preview";
    const chip = skill => { const on = skillOn(resume, skill.id); return `<button class="tchip${on ? " on" : ""}" type="button" data-pick-skill="${skill.id}" aria-pressed="${on}">${icon("check")}${esc(skill.name)}</button>`; };
    const entryBlock = entry => {
      const pick = pickOf(resume, entry.id);
      const on = Boolean(pick);
      const head = `<div class="pick-head"><span><b>${esc(titleOf(entry))}</b><span class="sub">${esc([secondOf(entry), dates(entry)].filter(Boolean).join(" · "))}</span></span>${switchButton(on, `data-pick-entry="${entry.id}"`, `Include ${titleOf(entry)}`)}</div>`;
      if (!on) return `<div class="pick-card off">${head}</div>`;
      if (entry.kind === "education") {
        const list = courses();
        return `<div class="pick-card">${head}${entry.detail ? `<div class="pick-row"><span>Show GPA <span class="faint">${esc(String(entry.detail).replace(/^GPA\s*:\s*/i, ""))}</span></span>${switchButton(pick.show_detail !== false, `data-pick-gpa="${entry.id}"`, "Show GPA")}</div>` : ""}
          ${list.length ? `<div class="pick-sub">Coursework</div><div class="tchips pad">${list.map(chip).join("")}</div>` : ""}</div>`;
      }
      return `<div class="pick-card">${head}${entry.bullets.map(bullet => {
        const chosen = bulletPick(resume, entry.id, bullet.id);
        const text = chosen?.text_override || bullet.text;
        return `<div class="pick-bullet${chosen ? "" : " off"}"><button class="pick-box" type="button" role="checkbox" aria-checked="${Boolean(chosen)}" data-pick-bullet="${bullet.id}" data-of="${entry.id}" aria-label="Include bullet"><span class="box">${icon("check")}</span></button>
          <button class="pick-text" type="button" data-tailor="${bullet.id}" data-of="${entry.id}"><span>${esc(text)}</span>${chosen?.text_override ? "<em>Reworded for this resume</em>" : ""}</button></div>`;
      }).join("") || '<p class="form-empty" style="padding:0 14px 12px">No bullets in your profile yet.</p>'}</div>`;
    };
    const template = resume.selection?.template || resume.template || "main";
    const density = resume.selection?.density || "standard";
    const target = targetOf(resume);
    const body = preview
      ? `<div class="design-bar"><div class="design-row"><span>Design</span><div class="mini-seg">${[["main", "Main"], ["barlow", "Barlow"]].map(([key, label]) => `<button type="button" data-template="${key}" aria-pressed="${template === key}">${label}</button>`).join("")}</div></div>
          ${template === "barlow" ? `<div class="design-row"><span>Spacing</span><div class="mini-seg">${[["standard", "Standard"], ["compact", "Compact"]].map(([key, label]) => `<button type="button" data-density="${key}" aria-pressed="${density === key}">${label}</button>`).join("")}</div></div>` : ""}</div>
          <div id="pdf-slot">${pdfMarkup(resume)}</div>`
      : `<div class="doc-meta"><button class="meta-row" type="button" data-act="edit-availability"><span class="meta-label">Availability</span><span class="meta-value${resume.availability_line ? "" : " missing"}">${esc(resume.availability_line || "Add availability")}</span>${icon("chev")}</button>
          <button class="meta-row" type="button" data-act="edit-target"><span class="meta-label">Target role</span><span class="meta-value${target ? "" : " missing"}">${esc(target ? `${target.company} · ${target.title}` : "None")}</span>${icon("chev")}</button></div>
          <p class="doc-hint">Switch on what goes in this resume. Tap a bullet's text to reword it for this resume only.</p>
          ${visibleSections().map(key => {
            if (key === "skills") {
              const groups = SKILL_GROUPS.map(group => [group.title, realSkills().filter(skill => group.categories.includes(skill.category))]).filter(([, list]) => list.length);
              return groups.length ? `<div class="pick-section">Skills</div><div class="pick-card">${groups.map(([title, list]) => `<div class="pick-sub">${title}</div><div class="tchips pad">${list.map(chip).join("")}</div>`).join("")}<div style="height:6px"></div></div>` : "";
            }
            const list = ofKind(key);
            return list.length ? `<div class="pick-section">${KIND[key].title}</div>${list.map(entryBlock).join("")}` : "";
          }).join("")}<div style="height:12px"></div>`;
    return `<header class="push-bar scrolled"><button class="back" type="button" data-act="back">${icon("back")}Resume</button><span class="push-title">${esc(resume.name)}</span><button class="icon-btn" type="button" data-act="doc-menu" aria-label="Resume actions">${icon("more")}</button></header>
      <div class="doc-tabs"><div class="segmented" role="tablist">${[["content", "Content"], ["preview", "Preview"]].map(([key, label]) => `<button type="button" role="tab" data-mode="${key}" aria-selected="${(push.mode || "content") === key}">${label}</button>`).join("")}</div></div>
      <div class="push-scroll${preview ? " ground" : ""}" id="push-scroll">${body}</div>
      <footer class="action-bar">${preview ? "" : `<button class="btn" type="button" data-mode="preview">${icon("eye")}Preview</button>`}<button class="btn primary grow" type="button" data-act="download"${push.downloading ? " disabled" : ""}>${icon("dl")}${push.downloading ? "Preparing…" : "Download PDF"}</button></footer>`;
  }

  /* The real PDF, as desktop shows it. Phones that cannot show a PDF inside a
     page (Android) get a button that opens it in their own viewer. */
  const pdfKey = resume => JSON.stringify([resume.id, resume.updated_at, resume.selection, state.v]);
  function pdfMarkup(resume) {
    const pdf = state.pdf;
    if (pdf.error && pdf.id === resume.id) return `<div class="pdf-note"><strong>Preview could not load</strong>${esc(pdf.error)}<br><button class="btn" type="button" data-act="retry-pdf">${icon("refresh")}Try again</button></div>`;
    if (!pdf.url || pdf.key !== pdfKey(resume)) return '<div class="state-box" role="status" style="background:var(--paper)"><span class="spinner"></span><span>Building preview…</span></div>';
    if (root.navigator.pdfViewerEnabled === false) return `<div class="pdf-note"><strong>Your PDF is ready</strong>This browser opens PDFs in its own viewer.<br><a class="btn primary" href="${esc(pdf.url)}" target="_blank" rel="noopener">${icon("eye")}Open preview</a></div>`;
    return `<div class="pdf-stage"><iframe class="pdf-frame" title="Resume PDF preview" src="${esc(pdf.url)}#view=FitH"></iframe></div>`;
  }
  async function pdfBlob(resume) {
    // Signed out there is no stored resume to render, so the document travels with the request.
    const response = state.local
      ? await root.fetch("/api/resume/render/pdf", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile: state.profile, resume, entries: entries(), skills: skills() }) })
      : await root.fetch(`/api/resume/resumes/${resume.id}/pdf`);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.detail || "Could not build PDF");
    }
    return response.blob();
  }
  async function loadPreview() {
    const resume = docById(S.push?.id);
    if (!resume || S.push.mode !== "preview") return;
    const key = pdfKey(resume);
    if (state.pdf.key === key && (state.pdf.url || state.pdf.loading)) return;
    state.pdf = { ...state.pdf, id: resume.id, key, loading: true, error: "" };
    try {
      const blob = await pdfBlob(resume);
      if (state.pdf.key !== key) return;
      if (state.pdf.url) URL.revokeObjectURL(state.pdf.url);
      state.pdf = { url: URL.createObjectURL(blob), id: resume.id, key, loading: false, error: "" };
    } catch (error) {
      if (state.pdf.key !== key) return;
      state.pdf = { ...state.pdf, loading: false, error: error.message || "Could not build PDF" };
    }
    const slot = P.$("#pdf-slot");
    if (slot && docById(S.push?.id)) slot.innerHTML = pdfMarkup(docById(S.push.id));
  }
  async function download() {
    const resume = docById(S.push?.id);
    if (!resume) return;
    S.sheet = null;
    S.push = { ...S.push, downloading: true }; P.render();
    try {
      const blob = await pdfBlob(resume);
      const url = URL.createObjectURL(blob);
      const link = root.document.createElement("a");
      link.href = url;
      link.download = `${(resume.name || "resume").replace(/[^a-z0-9]+/gi, "_")}.pdf`;
      root.document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (error) { P.toast(error.message || "Could not build PDF"); }
    if (S.push) { S.push = { ...S.push, downloading: false }; P.render(); }
  }

  /* ───────────── Sheets ───────────── */
  const closeButton = `<button class="icon-btn" type="button" data-act="close-sheet" aria-label="Close">${icon("x")}</button>`;
  const errorLine = sheet => sheet.error ? `<p class="status-line error" role="alert">${esc(sheet.error)}</p>` : "";
  const busy = sheet => sheet.busy ? " disabled" : "";
  function sheetMarkup(sheet) {
    if (sheet.kind === "contact") {
      const c = sheet.draft;
      return `<div class="grabber"></div><div class="sheet-head"><h2>Contact</h2>${closeButton}</div><div class="sheet-body">
        ${[["full_name", "Full name", "", "name"], ["email", "Email", "", "email"], ["phone", "Phone", "", "tel"], ["location", "Location", "e.g. Seattle, WA", "address-level2"]].map(([key, label, placeholder, auto], index) => `<label class="field${index ? "" : " first"}"><span>${label}</span><input data-contact="${key}" value="${esc(c[key] || "")}" placeholder="${placeholder}" autocomplete="${auto}"${key === "email" ? ' type="email" autocapitalize="off"' : key === "phone" ? ' type="tel"' : ""}></label>`).join("")}
        <div class="sheet-label">Links</div>
        ${c.links.map((link, index) => `<div class="link-row"><input data-link-label="${index}" value="${esc(link.label)}" placeholder="Label" aria-label="Link label"><input data-link-url="${index}" value="${esc(link.url)}" placeholder="github.com/you" inputmode="url" autocapitalize="off" autocorrect="off" aria-label="Link URL"><button class="icon-btn" type="button" data-link-del="${index}" aria-label="Remove link">${icon("x")}</button></div>`).join("")}
        <button class="add-line" type="button" data-act="add-link">${icon("plus")}Add link</button>${errorLine(sheet)}</div>
        <div class="sheet-foot"><button class="btn" type="button" data-act="close-sheet">Cancel</button><button class="btn primary grow" type="button" data-act="save-contact"${busy(sheet)}>Save</button></div>`;
    }
    if (sheet.kind === "bullet") {
      const n = (sheet.text || "").length;
      return `<div class="grabber"></div><div class="sheet-head"><h2>${sheet.id ? "Edit bullet" : "New bullet"}</h2>${closeButton}</div><div class="sheet-body">
        <label class="field first"><span>Bullet</span><textarea data-sheet-text rows="4" maxlength="600" placeholder="Start with a verb: Built, Led, Cut…">${esc(sheet.text || "")}</textarea></label>
        <p class="char-count${n > 160 ? " long" : ""}" id="char-count">${n} characters${n > 160 ? " · may wrap to three lines" : ""}</p>${errorLine(sheet)}</div>
        <div class="sheet-foot">${sheet.id ? '<button class="btn danger" type="button" data-act="delete-bullet">Delete</button>' : ""}<button class="btn primary grow" type="button" data-act="save-bullet"${busy(sheet)}>Save</button></div>`;
    }
    if (sheet.kind === "skill") {
      return `<div class="grabber"></div><div class="sheet-head"><h2>${sheet.id ? "Edit skill" : "Add skill"}</h2>${closeButton}</div><div class="sheet-body">
        <label class="field first"><span>Skill</span><input data-sheet-text maxlength="120" value="${esc(sheet.text || "")}" placeholder="e.g. PostgreSQL"></label>
        <div class="sheet-label">Group</div>${SKILL_GROUPS.map(group => `<button class="opt radio" type="button" role="radio" data-group="${group.key}" aria-checked="${sheet.group === group.key}"><span class="box"></span>${group.title}</button>`).join("")}${errorLine(sheet)}</div>
        <div class="sheet-foot">${sheet.id ? '<button class="btn danger" type="button" data-act="delete-skill">Delete</button>' : ""}<button class="btn primary grow" type="button" data-act="save-skill"${busy(sheet)}>${sheet.id ? "Save" : "Add skill"}</button></div>`;
    }
    if (sheet.kind === "course") {
      return `<div class="grabber"></div><div class="sheet-head"><h2>${sheet.id ? "Edit course" : "Add course"}</h2>${closeButton}</div><div class="sheet-body">
        <label class="field first"><span>Course</span><input data-sheet-text maxlength="120" value="${esc(sheet.text || "")}" placeholder="e.g. Machine Learning"></label>${errorLine(sheet)}</div>
        <div class="sheet-foot">${sheet.id ? '<button class="btn danger" type="button" data-act="delete-course">Delete</button>' : ""}<button class="btn primary grow" type="button" data-act="save-course"${busy(sheet)}>${sheet.id ? "Save" : "Add course"}</button></div>`;
    }
    if (sheet.kind === "add-section") {
      return `<div class="grabber"></div><div class="sheet-head"><h2>Add section</h2>${closeButton}</div><div class="sheet-body end">
        ${missingSections().map(key => `<button class="opt" type="button" data-add-section="${key}">${key === "skills" ? "Skills" : KIND[key].title}<span class="opt-end">${icon("chev")}</span></button>`).join("")}</div>`;
    }
    if (sheet.kind === "new-resume") {
      return `<div class="grabber"></div><div class="sheet-head"><h2>New resume</h2>${closeButton}</div><div class="sheet-body">
        <label class="field first"><span>Resume name</span><input data-sheet-field="name" maxlength="300" placeholder="e.g. Software engineering" value="${esc(sheet.name || "")}"></label>
        <label class="field"><span>Target role (optional)</span><select data-sheet-field="target"><option value="">No target role</option>${state.jobs.map(job => `<option value="${job.id}"${String(sheet.target) === String(job.id) ? " selected" : ""}>${esc(job.company)} · ${esc(job.title)}</option>`).join("")}</select></label>
        <label class="field"><span>Start with</span><select data-sheet-field="variant">${state.variants.map(variant => `<option value="${esc(variant.key)}"${sheet.variant === variant.key ? " selected" : ""}>${esc(variant.label || variant.key)} content</option>`).join("")}<option value=""${sheet.variant === "" ? " selected" : ""}>Everything in my profile</option></select></label>
        <p class="sheet-note">You can switch anything on or off afterwards.</p>${errorLine(sheet)}</div>
        <div class="sheet-foot"><button class="btn primary block" type="button" data-act="create-resume"${busy(sheet)}>Create resume</button></div>`;
    }
    if (sheet.kind === "doc-menu") {
      const resume = docById(sheet.id);
      return `<div class="grabber"></div><div class="sheet-head"><h2>${esc(resume?.name || "Resume")}</h2>${closeButton}</div><div class="sheet-body end">
        <button class="opt" type="button" data-act="rename-resume">${icon("pencil")}Rename</button>
        <button class="opt" type="button" data-act="download">${icon("dl")}Download PDF</button>
        <button class="opt danger-opt" type="button" data-act="ask-delete-resume">${icon("trash")}Delete resume</button></div>`;
    }
    if (sheet.kind === "rename") {
      return `<div class="grabber"></div><div class="sheet-head"><h2>Rename resume</h2>${closeButton}</div><div class="sheet-body">
        <label class="field first"><span>Name</span><input data-sheet-text maxlength="300" value="${esc(sheet.text)}"></label>${errorLine(sheet)}</div>
        <div class="sheet-foot"><button class="btn" type="button" data-act="close-sheet">Cancel</button><button class="btn primary grow" type="button" data-act="save-rename"${busy(sheet)}>Save</button></div>`;
    }
    if (sheet.kind === "delete-resume") {
      const resume = docById(sheet.id);
      return `<div class="grabber"></div><div class="sheet-head"><h2>Delete “${esc(resume?.name || "")}”?</h2>${closeButton}</div><div class="sheet-body"><p style="margin:4px 0 0;color:var(--muted);font-size:14.5px">Your profile keeps every entry and bullet. Only this resume's choices and rewording go away.</p></div>
        <div class="sheet-foot"><button class="btn" type="button" data-act="close-sheet">Cancel</button><button class="btn danger-solid grow" type="button" data-act="delete-resume">Delete resume</button></div>`;
    }
    if (sheet.kind === "tailor") {
      const resume = docById(S.push?.id), bullet = entryById(sheet.entry)?.bullets.find(item => item.id === sheet.id);
      if (!resume || !bullet) return "";
      return `<div class="grabber"></div><div class="sheet-head"><div><h2>Reword for this resume</h2><p>${esc(resume.name)}</p></div>${closeButton}</div><div class="sheet-body">
        <label class="field first"><span>Text on this resume</span><textarea data-sheet-text rows="4" maxlength="600">${esc(sheet.text)}</textarea></label>
        <div class="profile-text"><span>Profile text</span>${esc(bullet.text)}</div>
        <p class="sheet-note" style="margin-top:10px">Only this resume changes. Your profile and other resumes keep the original.</p>${errorLine(sheet)}</div>
        <div class="sheet-foot">${bulletPick(resume, sheet.entry, bullet.id)?.text_override ? `<button class="btn" type="button" data-act="reset-tailor">${icon("undo")}Use profile text</button>` : ""}<button class="btn primary grow" type="button" data-act="save-tailor"${busy(sheet)}>Save</button></div>`;
    }
    if (sheet.kind === "availability") {
      return `<div class="grabber"></div><div class="sheet-head"><h2>Availability</h2>${closeButton}</div><div class="sheet-body">
        <label class="field first"><span>Shown under your name</span><input data-sheet-text maxlength="300" value="${esc(sheet.text)}" placeholder="e.g. Available June – September 2027"></label>${errorLine(sheet)}</div>
        <div class="sheet-foot"><button class="btn" type="button" data-act="close-sheet">Cancel</button><button class="btn primary grow" type="button" data-act="save-availability"${busy(sheet)}>Save</button></div>`;
    }
    if (sheet.kind === "target") {
      const resume = docById(S.push?.id);
      return `<div class="grabber"></div><div class="sheet-head"><div><h2>Target role</h2><p>The job this resume is written for.</p></div>${closeButton}</div><div class="sheet-body end">
        ${[{ id: "", company: "", title: "" }, ...state.jobs].map(job => `<button class="opt radio" type="button" role="radio" data-target-role="${job.id}" aria-checked="${String(resume?.target_job_id ?? "") === String(job.id)}"><span class="box"></span><span>${job.id ? `${esc(job.company)} · ${esc(job.title)}` : "No target role"}</span></button>`).join("")}
        ${state.jobs.length ? "" : '<p class="field-hint">Jobs you send to Resume from Applied (Tailor resume) show up here.</p>'}</div>`;
    }
    return "";
  }

  /* ───────────── Writes ───────────── */
  const fail = error => P.toast(error?.message || "Could not save.");
  async function patchResume(resume, fields) {
    const next = await api(`/resumes/${resume.id}`, { method: "PATCH", body: fields });
    const index = state.resumes.findIndex(item => item.id === resume.id);
    if (index >= 0) state.resumes[index] = next;
    bump(); P.render();
    return next;
  }
  async function editSelection(change) {
    const resume = docById(S.push?.id);
    if (!resume) return;
    const selection = cloneSelection(resume);
    change(selection);
    // Show the change at once; the server's copy replaces it when it answers.
    const index = state.resumes.findIndex(item => item.id === resume.id);
    state.resumes[index] = { ...resume, selection };
    bump(); P.render();
    try { await patchResume(resume, { selection }); }
    catch (error) { state.resumes[index] = resume; bump(); P.render(); fail(error); }
  }
  function toggleEntry(entryId) {
    const entry = entryById(entryId);
    if (!entry) return;
    editSelection(selection => {
      if (selection.entries.some(pick => pick.entry_id === entry.id)) selection.entries = selection.entries.filter(pick => pick.entry_id !== entry.id);
      else selection.entries.push({ entry_id: entry.id, bullets: entry.bullets.map(bullet => ({ bullet_id: bullet.id, text_override: null })) });
    });
  }
  function toggleBullet(entryId, bulletId) {
    editSelection(selection => {
      let pick = selection.entries.find(item => item.entry_id === entryId);
      if (!pick) { pick = { entry_id: entryId, bullets: [] }; selection.entries.push(pick); }
      const index = pick.bullets.findIndex(item => item.bullet_id === bulletId);
      if (index >= 0) pick.bullets.splice(index, 1); else pick.bullets.push({ bullet_id: bulletId, text_override: null });
      // As on desktop: an entry with no bullets left leaves the resume.
      if (!pick.bullets.length) selection.entries = selection.entries.filter(item => item.entry_id !== entryId);
    });
  }
  function toggleGpa(entryId) {
    editSelection(selection => {
      const pick = selection.entries.find(item => item.entry_id === entryId);
      if (pick) pick.show_detail = pick.show_detail === false;
    });
  }
  function toggleSkill(skillId) {
    editSelection(selection => {
      const set = new Set(selection.skills || []);
      set.has(skillId) ? set.delete(skillId) : set.add(skillId);
      selection.skills = [...set];
    });
  }

  // Entry pages save each field when you leave it. A new entry is created the
  // moment it has the one field the server requires.
  let entryWrite = Promise.resolve();
  let flashTimer = null;
  const savedFlash = () => {
    setEntryUi({ status: "flash" });
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { if (entryUi.status === "flash") setEntryUi({ status: "saved" }); }, 900);
  };
  const trimmed = draft => Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value).trim()]));
  function saveEntryField(key, value) {
    const token = S.push?.token;
    entryWrite = entryWrite.then(async () => {
      const push = S.push;
      if (push?.kind !== "entry" || push.token !== token) return;
      const label = orgLabel(push.entryKind);
      if (!push.entryId) {
        if (!String(push.draft.org || "").trim()) return;
        setEntryUi({ status: "saving", error: "" });
        try {
          const created = await api("/entries", { method: "POST", body: { kind: push.entryKind, role: "", location: "", start_date: "", end_date: "", url: "", detail: "", ...trimmed(push.draft) } });
          state.entries.push({ ...created, bullets: created.bullets || [] });
          state.added.add(push.entryKind);
          push.entryId = created.id;
          for (const field of Object.keys(push.draft)) if ((created[field] || "") === String(push.draft[field]).trim()) delete push.draft[field];
          bump(); P.render(); savedFlash();
        } catch (error) { setEntryUi({ status: "error", error: error.message }); }
        return;
      }
      const entry = entryById(push.entryId);
      if (!entry) return;
      if ((entry[key] || "") === value) { delete push.draft[key]; return; }
      if (key === "org" && !value) { setEntryUi({ status: "error", error: `${label} can't be empty.` }); return; }
      setEntryUi({ status: "saving", error: "" });
      try {
        const next = await api(`/entries/${entry.id}`, { method: "PATCH", body: { [key]: value } });
        const index = state.entries.findIndex(item => item.id === entry.id);
        if (index >= 0) state.entries[index] = { ...state.entries[index], ...next, bullets: state.entries[index].bullets };
        if (push.draft[key] !== undefined && String(push.draft[key]).trim() === value) delete push.draft[key];
        bump(); P.render(); savedFlash();
      } catch (error) { setEntryUi({ status: "error", error: error.message }); }
    });
    return entryWrite;
  }

  async function saveContact() {
    const sheet = S.sheet;
    syncContact();
    const draft = sheet.draft;
    const links = [];
    for (const link of draft.links) {
      if (!link.label.trim() && !link.url.trim()) continue;
      const url = webUrl(link.url);
      if (!url) { S.sheet = { ...sheet, error: "Enter each link like github.com/you" }; return P.render(); }
      links.push({ label: link.label.trim(), url: url.href });
    }
    S.sheet = { ...sheet, busy: true, error: "" }; P.render();
    try {
      state.profile = await api("/profile", { method: "PUT", body: { full_name: draft.full_name.trim(), email: draft.email.trim(), phone: draft.phone.trim(), location: draft.location.trim(), links } });
      S.sheet = null; bump(); P.render(); P.toast("Contact saved");
    } catch (error) { S.sheet = { ...sheet, busy: false, error: error.message }; P.render(); }
  }
  function syncContact() {
    const draft = S.sheet?.draft;
    if (!draft) return;
    P.$$("#sheet [data-contact]").forEach(input => { draft[input.dataset.contact] = input.value; });
    P.$$("#sheet [data-link-label]").forEach(input => { draft.links[Number(input.dataset.linkLabel)].label = input.value; });
    P.$$("#sheet [data-link-url]").forEach(input => { draft.links[Number(input.dataset.linkUrl)].url = input.value; });
  }

  async function saveBullet() {
    const sheet = S.sheet, entryId = S.push?.entryId;
    const text = String(sheet.text || "").trim();
    if (!text) { S.sheet = { ...sheet, error: "Write the bullet first." }; return P.render(); }
    S.sheet = { ...sheet, busy: true, error: "" }; P.render();
    try {
      const entry = state.entries.find(item => item.id === entryId);
      if (sheet.id) {
        const next = await api(`/bullets/${sheet.id}`, { method: "PATCH", body: { text } });
        entry.bullets = entry.bullets.map(bullet => bullet.id === sheet.id ? { ...bullet, ...next } : bullet);
      } else {
        const created = await api(`/entries/${entryId}/bullets`, { method: "POST", body: { text, audience: "all", tags: [], defense_notes: "" } });
        entry.bullets = [...entry.bullets, created];
      }
      S.sheet = null; bump(); P.render(); P.toast(sheet.id ? "Bullet saved" : "Bullet added");
    } catch (error) { S.sheet = { ...sheet, busy: false, error: error.message }; P.render(); }
  }
  // Deletes hide at once and reach the server when the Undo window closes.
  function deferredDelete(key, path, message, after = () => {}) {
    state.gone.add(key);
    bump(); P.render();
    const cancel = P.deferDelete(async leaving => {
      try { await remove(path, leaving); }
      finally { state.gone.delete(key); if (!leaving) { await refresh(); } }
    });
    after();
    P.toast(message, [{ label: "Undo", run: () => { if (cancel()) { state.gone.delete(key); bump(); P.render(); } } }]);
  }
  function deleteBullet() {
    const sheet = S.sheet;
    S.sheet = null;
    deferredDelete(`bullet:${sheet.id}`, `/bullets/${sheet.id}`, "Bullet deleted");
  }
  function deleteEntry() {
    const entry = entryById(S.push?.entryId);
    if (!entry) return;
    S.push = null;
    deferredDelete(`entry:${entry.id}`, `/entries/${entry.id}`, `Deleted ${titleOf(entry)}`);
  }

  async function saveSkill(course) {
    const sheet = S.sheet;
    const name = String(sheet.text || "").trim();
    if (!name) { S.sheet = { ...sheet, error: course ? "Name the course first." : "Name the skill first." }; return P.render(); }
    S.sheet = { ...sheet, busy: true, error: "" }; P.render();
    try {
      if (!sheet.id) {
        const created = await api("/skills", { method: "POST", body: { category: course ? "coursework" : sheet.group, name, audience: "all" } });
        state.skills.push(created);
        // A new skill joins every resume, as the variant rules would have it.
        for (const resume of resumes()) {
          const selection = cloneSelection(resume);
          if (!selection.skills.includes(created.id)) { selection.skills.push(created.id); patchResume(resume, { selection }).catch(() => {}); }
        }
      } else {
        const skill = state.skills.find(item => item.id === sheet.id);
        const category = course ? "coursework" : groupOf(skill.category) === sheet.group ? skill.category : sheet.group;
        if (skill.name !== name || skill.category !== category) await renameSkill(skill, name, category);
      }
      S.sheet = null; bump(); P.render();
    } catch (error) { S.sheet = { ...sheet, busy: false, error: error.status === 409 || error.status === 422 ? "You already have that one." : error.message }; P.render(); }
  }
  // The server has no edit for a skill, so a renamed or moved skill is added
  // anew, takes the old one's place in each resume, and the old one goes.
  async function renameSkill(skill, name, category) {
    if (state.local) {
      const next = await api(`/skills/${skill.id}`, { method: "PATCH", body: { name, category } });
      Object.assign(skill, next);
      return;
    }
    const created = await api("/skills", { method: "POST", body: { category, name, audience: skill.audience || "all" } });
    state.skills.push(created);
    for (const resume of resumes().filter(item => (item.selection?.skills || []).includes(skill.id))) {
      const selection = cloneSelection(resume);
      selection.skills = selection.skills.map(id => id === skill.id ? created.id : id);
      await patchResume(resume, { selection });
    }
    await api(`/skills/${skill.id}`, { method: "DELETE" });
    state.skills = state.skills.filter(item => item.id !== skill.id);
  }
  function deleteSkill() {
    const sheet = S.sheet, skill = state.skills.find(item => item.id === sheet.id);
    S.sheet = null;
    deferredDelete(`skill:${sheet.id}`, `/skills/${sheet.id}`, `Removed ${skill?.name || "skill"}`);
  }

  async function createResume() {
    const sheet = S.sheet;
    const variant = sheet.variant ?? "";
    const name = String(sheet.name || "").trim() || state.variants.find(item => item.key === variant)?.label || "New resume";
    S.sheet = { ...sheet, busy: true, error: "" }; P.render();
    try {
      const created = await api("/resumes", { method: "POST", body: { name, target_job_id: sheet.target ? Number(sheet.target) : null, variant, selection: buildSelection(variant) } });
      state.resumes.unshift(created);
      S.sheet = null; state.view = "resumes"; S.push = { kind: "doc", id: created.id, mode: "content" };
      bump(); P.render(); P.toast(`Created ${created.name}`);
    } catch (error) { S.sheet = { ...sheet, busy: false, error: error.message }; P.render(); }
  }
  async function saveField(field, value, done = "") {
    const sheet = S.sheet, resume = docById(S.push?.id);
    if (!resume) return;
    S.sheet = { ...sheet, busy: true, error: "" }; P.render();
    try { await patchResume(resume, { [field]: value }); S.sheet = null; P.render(); if (done) P.toast(done); }
    catch (error) { S.sheet = { ...sheet, busy: false, error: error.message }; P.render(); }
  }
  async function saveTailor(reset) {
    const sheet = S.sheet;
    const bullet = entryById(sheet.entry)?.bullets.find(item => item.id === sheet.id);
    if (!bullet) return;
    const text = String(sheet.text || "").trim();
    const override = reset || !text || text === bullet.text ? null : text;
    S.sheet = null;
    editSelection(selection => {
      let pick = selection.entries.find(item => item.entry_id === sheet.entry);
      if (!pick) { pick = { entry_id: sheet.entry, bullets: [] }; selection.entries.push(pick); }
      let chosen = pick.bullets.find(item => item.bullet_id === bullet.id);
      if (!chosen) { chosen = { bullet_id: bullet.id, text_override: null }; pick.bullets.push(chosen); }
      chosen.text_override = override;
    });
  }
  function deleteResume() {
    const resume = docById(S.sheet?.id);
    if (!resume) return;
    S.sheet = null; S.push = null;
    deferredDelete(`resume:${resume.id}`, `/resumes/${resume.id}`, `Deleted ${resume.name}`);
  }

  /* Tailor resume, from Applied: open the resume for that job, or start one. */
  async function openHandoff() {
    const requested = Number(new URLSearchParams(root.location.hash.replace(/^#/, "")).get("target"));
    if (!requested) return;
    root.history.replaceState(null, "", root.location.pathname + root.location.search);
    const job = state.jobs.find(item => item.id === requested);
    if (!job) return;
    state.view = "resumes";
    let resume = resumes().find(item => item.target_job_id === requested);
    if (!resume) {
      const variant = state.variants[0]?.key || "";
      try {
        resume = await api("/resumes", { method: "POST", body: { name: `${job.company} · ${job.title}`.slice(0, 300), target_job_id: requested, variant, selection: buildSelection(variant) } });
        state.resumes.unshift(resume);
        P.toast(`Created ${resume.name}`);
      } catch (error) { return fail(error); }
    }
    S.push = { kind: "doc", id: resume.id, mode: "content" };
    bump(); P.render();
  }

  /* ───────────── Events ───────────── */
  let token = 0;
  const openEntryPage = (entryKind, entryId) => {
    Object.assign(entryUi, { status: entryId ? "saved" : "", error: "", warned: false });
    S.push = { kind: "entry", entryKind, entryId, draft: {}, token: ++token };
  };
  function onClick(target, d) {
    if (d.view) { if (d.view !== state.view) { state.view = d.view; root.history.replaceState(null, "", d.view === "resumes" ? "#resumes" : root.location.pathname); P.render(); P.els.page.scrollTop = 0; } return; }
    if (d.entry) { const entry = entryById(d.entry); openEntryPage(entry.kind, entry.id); return P.render(); }
    if (d.newEntry) { openEntryPage(d.newEntry, null); P.render(); return setTimeout(() => P.$("#push [data-ef]")?.focus(), 320); }
    if (d.bullet) { const bullet = entryById(S.push.entryId)?.bullets.find(item => item.id === Number(d.bullet)); if (!bullet) return; S.sheet = { kind: "bullet", id: bullet.id, text: bullet.text }; return P.render(); }
    if (d.course) { const course = skills().find(item => item.id === Number(d.course)); S.sheet = { kind: "course", id: course.id, text: course.name }; return P.render(); }
    if (d.skill) { const skill = skills().find(item => item.id === Number(d.skill)); S.sheet = { kind: "skill", id: skill.id, text: skill.name, group: groupOf(skill.category) }; return P.render(); }
    if (d.addSkill) { S.sheet = { kind: "skill", text: "", group: d.addSkill }; P.render(); return setTimeout(() => P.$("#sheet [data-sheet-text]")?.focus(), 320); }
    if (d.group) { S.sheet = { ...S.sheet, group: d.group }; return P.render(); }
    if (d.addSection) {
      const key = d.addSection;
      state.added.add(key); S.sheet = null;
      if (key === "skills") S.push = { kind: "skills" };
      else openEntryPage(key, null);
      bump(); return P.render();
    }
    if (d.linkDel) { syncContact(); S.sheet.draft.links.splice(Number(d.linkDel), 1); S.sheet = { ...S.sheet }; return P.render(); }
    if (d.doc) { S.push = { kind: "doc", id: Number(d.doc), mode: "content" }; return P.render(); }
    if (d.mode) { S.push = { ...S.push, mode: d.mode }; P.render(); const scroller = P.$("#push-scroll"); if (scroller) scroller.scrollTop = 0; if (d.mode === "preview") loadPreview(); return; }
    if (d.pickEntry) return toggleEntry(Number(d.pickEntry));
    if (d.pickBullet) return toggleBullet(Number(d.of), Number(d.pickBullet));
    if (d.pickGpa) return toggleGpa(Number(d.pickGpa));
    if (d.pickSkill) return toggleSkill(Number(d.pickSkill));
    if (d.tailor) {
      const resume = docById(S.push.id), bullet = entryById(d.of)?.bullets.find(item => item.id === Number(d.tailor));
      if (!bullet) return;
      S.sheet = { kind: "tailor", id: bullet.id, entry: Number(d.of), text: bulletPick(resume, Number(d.of), bullet.id)?.text_override || bullet.text };
      return P.render();
    }
    if (d.template || d.density) {
      return editSelection(selection => { if (d.template) selection.template = d.template; else selection.density = d.density; }).then(loadPreview);
    }
    if (d.targetRole !== undefined) { S.sheet = null; P.render(); const resume = docById(S.push.id); return patchResume(resume, { target_job_id: d.targetRole ? Number(d.targetRole) : null }).catch(fail); }
    switch (d.act) {
      case "retry": state.loading = true; state.error = ""; P.render(); return refresh();
      case "edit-contact": { const c = state.profile || {}; S.sheet = { kind: "contact", draft: { full_name: c.full_name || "", email: c.email || "", phone: c.phone || "", location: c.location || "", links: (c.links || []).map(link => ({ label: link.label || "", url: link.url || "" })) } }; return P.render(); }
      case "add-link": syncContact(); S.sheet.draft.links.push({ label: "", url: "" }); S.sheet = { ...S.sheet }; P.render(); return P.$(`#sheet [data-link-label="${S.sheet.draft.links.length - 1}"]`)?.focus();
      case "save-contact": return saveContact();
      case "edit-skills": S.push = { kind: "skills" }; return P.render();
      case "add-section": S.sheet = { kind: "add-section" }; return P.render();
      case "add-course": S.sheet = { kind: "course", text: "" }; P.render(); return setTimeout(() => P.$("#sheet [data-sheet-text]")?.focus(), 320);
      case "add-bullet":
        if (!S.push.entryId) return setEntryUi({ error: `Add the ${orgLabel(S.push.entryKind).toLowerCase()} first, then its bullets.` });
        S.sheet = { kind: "bullet", text: "" }; P.render(); return setTimeout(() => P.$("#sheet [data-sheet-text]")?.focus(), 320);
      case "save-bullet": return saveBullet();
      case "delete-bullet": return deleteBullet();
      case "delete-entry": return deleteEntry();
      case "save-skill": return saveSkill(false);
      case "save-course": return saveSkill(true);
      case "delete-skill": case "delete-course": return deleteSkill();
      case "new-resume": S.sheet = { kind: "new-resume", name: "", target: "", variant: state.variants[0]?.key ?? "" }; P.render(); return setTimeout(() => P.$("#sheet [data-sheet-field=name]")?.focus(), 320);
      case "create-resume": return createResume();
      case "doc-menu": S.sheet = { kind: "doc-menu", id: S.push.id }; return P.render();
      case "rename-resume": S.sheet = { kind: "rename", id: S.push.id, text: docById(S.push.id)?.name || "" }; P.render(); return setTimeout(() => P.$("#sheet [data-sheet-text]")?.select(), 320);
      case "save-rename": { const name = String(S.sheet.text || "").trim(); if (!name) { S.sheet = { ...S.sheet, error: "Name the resume." }; return P.render(); } return saveField("name", name); }
      case "ask-delete-resume": S.sheet = { kind: "delete-resume", id: S.push.id }; return P.render();
      case "delete-resume": return deleteResume();
      case "save-tailor": return saveTailor(false);
      case "reset-tailor": return saveTailor(true);
      case "edit-availability": S.sheet = { kind: "availability", text: docById(S.push.id)?.availability_line || "" }; return P.render();
      case "save-availability": return saveField("availability_line", String(S.sheet.text || "").trim());
      case "edit-target": S.sheet = { kind: "target" }; return P.render();
      case "download": return download();
      case "retry-pdf": state.pdf = { url: null, id: null, key: null, loading: false, error: "" }; P.$("#pdf-slot") && (P.$("#pdf-slot").innerHTML = pdfMarkup(docById(S.push.id))); return loadPreview();
    }
  }

  function wire() {
    const host = P.els.app;
    host.addEventListener("input", event => {
      const el = event.target;
      if (el.matches("[data-sheet-text]") && S.sheet) {
        S.sheet.text = el.value;
        if (S.sheet.kind === "bullet") {
          const count = P.$("#char-count"), n = el.value.length;
          if (count) { count.textContent = `${n} characters${n > 160 ? " · may wrap to three lines" : ""}`; count.classList.toggle("long", n > 160); }
        }
      }
      if (el.dataset.sheetField && S.sheet) S.sheet[el.dataset.sheetField] = el.value;
      if (el.dataset.ef && S.push?.kind === "entry") S.push.draft[el.dataset.ef] = el.value;
    });
    host.addEventListener("change", event => {
      const el = event.target;
      if (el.dataset.sheetField && S.sheet) S.sheet[el.dataset.sheetField] = el.value;
      if (el.dataset.ef && S.push?.kind === "entry") saveEntryField(el.dataset.ef, el.value.trim());
    });
    root.addEventListener("storage", async event => {
      if (event.key === "oneshot.visitor-data.state.v1" && state.local) refresh();
    });
  }

  P.start({
    tab: "resume",
    renderPage,
    renderPush: push => push.kind === "entry" ? entryPage(push) : push.kind === "skills" ? skillsPage() : docPage(push),
    renderSheet: sheetMarkup,
    version: () => state.v,
    // An entry page redraws only when its bullets change; typed fields never.
    pushSig: push => push.kind === "entry"
      ? JSON.stringify(["entry", push.token, push.entryKind, Boolean(push.entryId && !entryById(push.entryId)), (entryById(push.entryId)?.bullets || []).map(bullet => [bullet.id, bullet.text])])
      : JSON.stringify([push, state.v, state.pdf.key]),
    sheetSig: sheet => ["contact", "bullet", "skill", "course", "new-resume", "rename", "tailor", "availability"].includes(sheet.kind)
      ? JSON.stringify([sheet.kind, sheet.id, sheet.group, sheet.error, sheet.busy, sheet.draft?.links.length])
      : JSON.stringify([sheet, state.v]),
    afterPush: () => { if (S.push?.kind === "doc" && S.push.mode === "preview") loadPreview(); },
    // Leaving a new entry that never got its required field discards it, but
    // only after saying so once.
    back: () => {
      const push = S.push;
      if (push?.kind === "entry" && !push.entryId) {
        const typed = Object.values(push.draft).some(value => String(value || "").trim());
        if (typed && !entryUi.warned) {
          setEntryUi({ warned: true, error: `Add the ${orgLabel(push.entryKind).toLowerCase()} to save this entry, or go back again to discard it.` });
          return true;
        }
      }
      return false;
    },
    onClick,
    start: async () => {
      wire();
      await refresh();
      await openHandoff();
    },
  });
})(window);

/* Resume on phones. The profile is the bank: every resume picks from it, so
   each thing is written once. Entries open as full pages that save as you go;
   bullets, skills, courses and contact details edit in sheets; each resume has
   Content (switches, ticks, per-resume rewording) and Preview pages. */
import P from "../phone/shell.js";
import {
  DENSITIES, KIND, SECTION_ORDER, SKILL_GROUPS, TEMPLATES, bulletPick, cloneSelection, dates, densityOf, gpa, groupOf,
  handoffTarget, linkOf, newResume, orgLabel, pdfBlob, pdfName, pickOf, resumeApi, resumeForJob, rewordBullet, shortDay,
  skillOn, targetOf, templateOf, toggleBullet, toggleDetail, toggleEntry, toggleSkill,
} from "./core.js";

const { esc, icon, S } = P;

const state = {
  profile: null, entries: [], skills: [], variants: [], jobs: [], resumes: [], local: false,
  loading: true, error: "", view: location.hash === "#resumes" ? "resumes" : "profile",
  added: new Set(), gone: new Set(), v: 0, pdf: { url: null, id: null, key: null, loading: false, error: "" },
};
const bump = () => { state.v += 1; };

// Leaving the page sends a pending delete; a keepalive fetch outlives it.
const remove = (path, leaving) => leaving && !state.local
  ? fetch(`/api/resume${path}`, { method: "DELETE", keepalive: true })
  : resumeApi.remove(path);

async function refresh() {
  try { Object.assign(state, await resumeApi.load()); state.error = ""; }
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
const bulletWord = n => `${n} bullet${n === 1 ? "" : "s"}`;
const visibleSections = () => SECTION_ORDER.filter(key => key === "education" || state.added.has(key)
  || (key === "skills" ? realSkills().length > 0 : ofKind(key).length > 0));
const missingSections = () => SECTION_ORDER.filter(key => !visibleSections().includes(key));
const pdfInput = resume => ({ local: state.local, profile: state.profile, resume, entries: entries(), skills: skills() });

/* ───────────── Profile ───────────── */
const pills = (names, max = 8) => names.length ? `<div class="pills">${names.slice(0, max).map(name => `<span class="pill">${esc(name)}</span>`).join("")}${
  names.length > max ? `<span class="pill more">+${names.length - max}</span>` : ""}</div>` : "";
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
  const rows = list.map(entry => `<button class="entry-row" type="button" data-entry="${entry.id}"><span class="entry-text"><b>${esc(titleOf(entry))}</b><span class="sub">${
    esc([secondOf(entry), dates(entry)].filter(Boolean).join(" · "))}</span>${kind === "education"
    ? (entry.detail ? `<span class="sub">GPA ${esc(gpa(entry))}</span>` : "")
    : `<span class="sub faint">${bulletWord(entry.bullets.length)}</span>`}</span>${icon("chev")}</button>`).join("");
  const courseBlock = kind === "education"
    ? `<div class="course-block"><div class="mini-label">Coursework</div><div class="tchips">${
      courses().map(course => `<button class="tchip plain" type="button" data-course="${course.id}">${esc(course.name)}</button>`).join("")
    }<button class="tchip add" type="button" data-act="add-course">${icon("plus")}Add course</button></div></div>`
    : "";
  return `<div class="r-card"><div class="r-card-h"><h2>${KIND[kind].title}</h2>${list.length ? `<small class="r-count">${list.length}</small>` : ""}</div><div class="r-card-b">
      ${rows}${courseBlock}<button class="add-line" type="button" data-new-entry="${kind}">${icon("plus")}Add ${KIND[kind].one}</button></div></div>`;
}
function skillsCard() {
  const groups = SKILL_GROUPS.map(group => [group.title, realSkills().filter(skill => group.categories.includes(skill.category)).map(skill => skill.name)])
    .filter(([, names]) => names.length);
  return `<div class="r-card"><div class="r-card-h"><h2>Skills</h2><button class="edit-btn" type="button" data-act="edit-skills">${icon("pencil")}Edit</button></div><div class="r-card-b">
      ${groups.length
    ? `<dl style="margin:0">${groups.map(([title, names]) => `<div class="skill-group"><dt>${title}</dt><dd>${pills(names)}</dd></div>`).join("")}</dl>`
    : `<button class="add-line" type="button" data-act="edit-skills">${icon("plus")}Add skills</button>`}</div></div>`;
}
function profileMarkup() {
  return contactCard() + visibleSections().map(key => key === "skills" ? skillsCard() : entryCard(key)).join("")
    + (missingSections().length
      ? `<div style="padding:0 16px 24px"><button class="add-line center" type="button" data-act="add-section">${icon("plus")}Add section</button></div>`
      : '<div style="height:24px"></div>');
}
function resumeRow(resume) {
  const updated = shortDay(resume.updated_at, "en-US");
  const detail = [updated && `Updated ${updated}`, targetOf(state.jobs, resume)?.company].filter(Boolean).join(" · ");
  return `<button class="resume-row" type="button" data-doc="${resume.id}"><span class="doc-ico">${icon("file")}</span><span style="min-width:0"><b>${esc(resume.name)}</b>`
    + `<span>${esc(detail)}</span></span><span class="end">${icon("chev")}</span></button>`;
}
function resumesMarkup() {
  const list = resumes();
  return `${list.length ? `<div class="card-list" style="margin-top:6px">${list.map(resumeRow).join("")}</div>`
    : '<div class="empty"><strong>No resumes yet</strong>Each resume picks from your profile, so you only write things once.</div>'}
      <div style="padding:12px 16px 24px"><button class="add-line center" type="button" data-act="new-resume">${icon("plus")}New resume</button></div>`;
}
function renderPage() {
  const tabs = [["profile", "Profile", ""], ["resumes", "My resumes", resumes().length]];
  const body = state.loading ? P.stateBlock("loading", { title: "Loading resumes…" })
    : state.error ? P.stateBlock("error", { title: "Resumes could not load", detail: state.error })
    : state.view === "profile" ? profileMarkup() : resumesMarkup();
  const segments = tabs.map(([key, label, n]) =>
    `<button type="button" role="tab" data-view="${key}" aria-selected="${state.view === key}">${label}${n ? `<small>${n}</small>` : ""}</button>`).join("");
  return `${P.head("Resume")}<div class="sticky"><div class="segmented" role="tablist" aria-label="Resume pages">${segments}</div></div>${body}`;
}

/* ───────────── Entry page ───────────── */
const backBar = title => `<header class="push-bar scrolled"><button class="back" type="button" data-act="back">${icon("back")}Resume</button><span class="push-title">${title}</span>`;
const gonePage = (what, where) => `${backBar("")}<span class="bar-spacer"></span></header><div class="push-scroll"><div class="empty"><strong>This ${what} is gone</strong>Go back to ${where}.</div></div>`;

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
  if (saved) {
    saved.innerHTML = statusMarkup();
    saved.classList.toggle("error", entryUi.status === "error");
    saved.classList.toggle("flash", entryUi.status === "flash");
  }
  const error = P.$("#entry-error");
  if (error) { error.hidden = !entryUi.error; error.textContent = entryUi.error; }
  const deleteButton = P.$("#entry-delete");
  if (deleteButton) deleteButton.hidden = !push.entryId;
  const foot = P.$("#entry-foot");
  if (foot) foot.textContent = footText(push);
}
function setEntryUi(changes) { Object.assign(entryUi, changes); showEntryUi(); }

const MAX_LENGTH = { org: 300, detail: 500, url: 2000, start_date: 40, end_date: 40 };
function entryPage(push) {
  const saved = push.entryId ? entryById(push.entryId) : null;
  if (push.entryId && !saved) return gonePage("entry", "Resume");
  const e = { ...(saved || {}), ...push.draft };
  const k = KIND[push.entryKind];
  const input = (key, label, placeholder = "", type = "text") => `<label class="field"><span>${label}</span><input type="text" data-ef="${key}" value="${esc(e[key] || "")}" `
    + `placeholder="${esc(placeholder)}"${type === "url" ? ' inputmode="url" autocapitalize="off" autocorrect="off"' : ""} maxlength="${MAX_LENGTH[key] || 300}"${key === "org" ? " required" : ""}></label>`;
  const bullets = (saved?.bullets || []).map(bullet => `<button class="bullet-card" type="button" data-bullet="${bullet.id}"><p>${esc(bullet.text)}</p></button>`).join("")
    || '<p class="form-empty">No bullets yet. Start with what you built and what changed because of it.</p>';
  return `${backBar(k.title)}<span class="saved${entryUi.status === "error" ? " error" : ""}" id="saved" role="status">${statusMarkup()}</span></header>
      <div class="push-scroll" id="push-scroll"><div class="form-wrap">
        ${k.fields.map(([key, label, placeholder]) => input(key, label, placeholder)).join("")}
        <p class="status-line error" id="entry-error" role="alert"${entryUi.error ? "" : " hidden"}>${esc(entryUi.error)}</p>
        ${input("location", "Location", "e.g. Seattle, WA")}
        <div class="field-row">${input("start_date", "Start", "e.g. Jun 2026")}${input("end_date", "End", "e.g. Present")}</div>
        ${push.entryKind === "education" ? input("detail", "GPA (optional)", "e.g. 3.85 / 4.0") : input("url", "Link (optional)", "https://", "url")}
        ${push.entryKind === "education" ? "" : `<div class="form-section"><div class="form-section-h"><h3>Bullets</h3>${saved?.bullets.length ? "<small>Tap to edit</small>" : ""}</div>
          ${bullets}
          <button class="add-line" type="button" data-act="add-bullet">${icon("plus")}Add bullet</button></div>`}
        <button class="btn danger-ghost block" type="button" id="entry-delete" data-act="delete-entry"${saved ? "" : " hidden"}>${icon("trash")}Delete ${k.one}</button>
        <p class="form-foot" id="entry-foot">${esc(footText(push))}</p>
      </div></div>`;
}
function skillsPage() {
  const group = ({ key, title, categories }) => `<div class="form-section"><div class="form-section-h"><h3>${title}</h3></div><div class="tchips">
        ${realSkills().filter(skill => categories.includes(skill.category)).map(skill => `<button class="tchip plain" type="button" data-skill="${skill.id}">${esc(skill.name)}</button>`).join("")}
        <button class="tchip add" type="button" data-add-skill="${key}">${icon("plus")}Add</button></div></div>`;
  return `${backBar("Skills")}<span class="bar-spacer"></span></header>
      <div class="push-scroll" id="push-scroll"><div class="form-wrap"><p class="form-lede">Tap a skill to rename it, move it to another group or delete it.</p>
      ${SKILL_GROUPS.map(group).join("")}
      </div></div>`;
}

/* ───────────── One resume: Content and Preview ───────────── */
const switchButton = (on, attrs, label) => `<button class="switch" type="button" role="switch" aria-checked="${on}" aria-label="${esc(label)}" ${attrs}></button>`;
const segmentButtons = (options, attr, value) =>
  options.map(([key, label]) => `<button type="button" ${attr}="${key}" aria-pressed="${value === key}">${label}</button>`).join("");

const pickChip = (resume, skill) => {
  const on = skillOn(resume, skill.id);
  return `<button class="tchip${on ? " on" : ""}" type="button" data-pick-skill="${skill.id}" aria-pressed="${on}">${icon("check")}${esc(skill.name)}</button>`;
};
function pickCard(resume, entry) {
  const pick = pickOf(resume, entry.id);
  const head = `<div class="pick-head"><span><b>${esc(titleOf(entry))}</b><span class="sub">${esc([secondOf(entry), dates(entry)].filter(Boolean).join(" · "))}</span></span>`
    + `${switchButton(Boolean(pick), `data-pick-entry="${entry.id}"`, `Include ${titleOf(entry)}`)}</div>`;
  if (!pick) return `<div class="pick-card off">${head}</div>`;
  if (entry.kind === "education") {
    const list = courses();
    const gpaRow = entry.detail ? `<div class="pick-row"><span>Show GPA <span class="faint">${esc(gpa(entry))}</span></span>`
      + `${switchButton(pick.show_detail !== false, `data-pick-gpa="${entry.id}"`, "Show GPA")}</div>` : "";
    return `<div class="pick-card">${head}${gpaRow}
          ${list.length ? `<div class="pick-sub">Coursework</div><div class="tchips pad">${list.map(skill => pickChip(resume, skill)).join("")}</div>` : ""}</div>`;
  }
  return `<div class="pick-card">${head}${entry.bullets.map(bullet => {
    const chosen = bulletPick(resume, entry.id, bullet.id);
    const text = chosen?.text_override || bullet.text;
    return `<div class="pick-bullet${chosen ? "" : " off"}"><button class="pick-box" type="button" role="checkbox" aria-checked="${Boolean(chosen)}" data-pick-bullet="${bullet.id}" `
      + `data-of="${entry.id}" aria-label="Include bullet"><span class="box">${icon("check")}</span></button>
          <button class="pick-text" type="button" data-tailor="${bullet.id}" data-of="${entry.id}"><span>${esc(text)}</span>${chosen?.text_override ? "<em>Reworded for this resume</em>" : ""}</button></div>`;
  }).join("") || '<p class="form-empty" style="padding:0 14px 12px">No bullets in your profile yet.</p>'}</div>`;
}
function docContent(resume) {
  const target = targetOf(state.jobs, resume);
  const sections = visibleSections().map(key => {
    if (key === "skills") {
      const groups = SKILL_GROUPS.map(group => [group.title, realSkills().filter(skill => group.categories.includes(skill.category))]).filter(([, list]) => list.length);
      return groups.length ? `<div class="pick-section">Skills</div><div class="pick-card">${
        groups.map(([title, list]) => `<div class="pick-sub">${title}</div><div class="tchips pad">${list.map(skill => pickChip(resume, skill)).join("")}</div>`).join("")}<div style="height:6px"></div></div>` : "";
    }
    const list = ofKind(key);
    return list.length ? `<div class="pick-section">${KIND[key].title}</div>${list.map(entry => pickCard(resume, entry)).join("")}` : "";
  }).join("");
  return `<div class="doc-meta"><button class="meta-row" type="button" data-act="edit-availability"><span class="meta-label">Availability</span>`
    + `<span class="meta-value${resume.availability_line ? "" : " missing"}">${esc(resume.availability_line || "Add availability")}</span>${icon("chev")}</button>
          <button class="meta-row" type="button" data-act="edit-target"><span class="meta-label">Target role</span>`
    + `<span class="meta-value${target ? "" : " missing"}">${esc(target ? `${target.company} · ${target.title}` : "None")}</span>${icon("chev")}</button></div>
          <p class="doc-hint">Switch on what goes in this resume. Tap a bullet's text to reword it for this resume only.</p>
          ${sections}<div style="height:12px"></div>`;
}
function docPage(push) {
  const resume = docById(push.id);
  if (!resume) return gonePage("resume", "My resumes");
  const preview = push.mode === "preview";
  const template = templateOf(resume);
  const body = preview
    ? `<div class="design-bar"><div class="design-row"><span>Design</span><div class="mini-seg">${segmentButtons(TEMPLATES, "data-template", template)}</div></div>
          ${template === "barlow" ? `<div class="design-row"><span>Spacing</span><div class="mini-seg">${segmentButtons(DENSITIES, "data-density", densityOf(resume))}</div></div>` : ""}</div>
          <div id="pdf-slot">${pdfMarkup(resume)}</div>`
    : docContent(resume);
  const tabs = [["content", "Content"], ["preview", "Preview"]]
    .map(([key, label]) => `<button type="button" role="tab" data-mode="${key}" aria-selected="${(push.mode || "content") === key}">${label}</button>`).join("");
  const download = `<button class="btn primary grow" type="button" data-act="download"${push.downloading ? " disabled" : ""}>${icon("dl")}${push.downloading ? "Preparing…" : "Download PDF"}</button>`;
  return `${backBar(esc(resume.name))}<button class="icon-btn" type="button" data-act="doc-menu" aria-label="Resume actions">${icon("more")}</button></header>
      <div class="doc-tabs"><div class="segmented" role="tablist">${tabs}</div></div>
      <div class="push-scroll${preview ? " ground" : ""}" id="push-scroll">${body}</div>
      <footer class="action-bar">${preview ? "" : `<button class="btn" type="button" data-mode="preview">${icon("eye")}Preview</button>`}${download}</footer>`;
}

/* The real PDF, as desktop shows it. Phones that cannot show a PDF inside a
   page (Android) get a button that opens it in their own viewer. */
const pdfKey = resume => JSON.stringify([resume.id, resume.updated_at, resume.selection, state.v]);
function pdfMarkup(resume) {
  const pdf = state.pdf;
  if (pdf.error && pdf.id === resume.id) {
    return `<div class="pdf-note"><strong>Preview could not load</strong>${esc(pdf.error)}<br><button class="btn" type="button" data-act="retry-pdf">${icon("refresh")}Try again</button></div>`;
  }
  if (!pdf.url || pdf.key !== pdfKey(resume)) return '<div class="state-box" role="status" style="background:var(--paper)"><span class="spinner"></span><span>Building preview…</span></div>';
  if (navigator.pdfViewerEnabled === false) {
    return `<div class="pdf-note"><strong>Your PDF is ready</strong>This browser opens PDFs in its own viewer.<br>`
      + `<a class="btn primary" href="${esc(pdf.url)}" target="_blank" rel="noopener">${icon("eye")}Open preview</a></div>`;
  }
  return `<div class="pdf-stage"><iframe class="pdf-frame" title="Resume PDF preview" src="${esc(pdf.url)}#view=FitH"></iframe></div>`;
}
async function loadPreview() {
  const resume = docById(S.push?.id);
  if (!resume || S.push.mode !== "preview") return;
  const key = pdfKey(resume);
  if (state.pdf.key === key && (state.pdf.url || state.pdf.loading)) return;
  state.pdf = { ...state.pdf, id: resume.id, key, loading: true, error: "" };
  try {
    const blob = await pdfBlob(pdfInput(resume));
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
    const url = URL.createObjectURL(await pdfBlob(pdfInput(resume)));
    const link = document.createElement("a");
    link.href = url;
    link.download = pdfName(resume);
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (error) { P.toast(error.message || "Could not build PDF"); }
  if (S.push) { S.push = { ...S.push, downloading: false }; P.render(); }
}

/* ───────────── Sheets ───────────── */
const closeButton = `<button class="icon-btn" type="button" data-act="close-sheet" aria-label="Close">${icon("x")}</button>`;
const errorLine = sheet => sheet.error ? `<p class="status-line error" role="alert">${esc(sheet.error)}</p>` : "";
const busy = sheet => sheet.busy ? " disabled" : "";
const sheetHead = title => `<div class="grabber"></div><div class="sheet-head">${title}${closeButton}</div>`;
const cancelButton = '<button class="btn" type="button" data-act="close-sheet">Cancel</button>';
const deleteButton = (sheet, act) => sheet.id ? `<button class="btn danger" type="button" data-act="${act}">Delete</button>` : "";
// Fields, their error line, and a footer: an optional first button, then Save.
const formSheet = (head, body, sheet, first, act, label = "Save") => `${sheetHead(head)}<div class="sheet-body">
        ${body}${errorLine(sheet)}</div>
        <div class="sheet-foot">${first}<button class="btn primary grow" type="button" data-act="${act}"${busy(sheet)}>${label}</button></div>`;
const charCount = n => `${n} characters${n > 160 ? " · may wrap to three lines" : ""}`;

const CONTACT_FIELDS = [["full_name", "Full name", "", "name"], ["email", "Email", "", "email"], ["phone", "Phone", "", "tel"], ["location", "Location", "e.g. Seattle, WA", "address-level2"]];
function contactSheet(sheet) {
  const c = sheet.draft;
  const fields = CONTACT_FIELDS.map(([key, label, placeholder, auto], index) => `<label class="field${index ? "" : " first"}"><span>${label}</span>`
    + `<input data-contact="${key}" value="${esc(c[key] || "")}" placeholder="${placeholder}" autocomplete="${auto}"`
    + `${key === "email" ? ' type="email" autocapitalize="off"' : key === "phone" ? ' type="tel"' : ""}></label>`).join("");
  const links = c.links.map((link, index) => `<div class="link-row"><input data-link-label="${index}" value="${esc(link.label)}" placeholder="Label" aria-label="Link label">`
    + `<input data-link-url="${index}" value="${esc(link.url)}" placeholder="github.com/you" inputmode="url" autocapitalize="off" autocorrect="off" aria-label="Link URL">`
    + `<button class="icon-btn" type="button" data-link-del="${index}" aria-label="Remove link">${icon("x")}</button></div>`).join("");
  return formSheet("<h2>Contact</h2>", `${fields}
        <div class="sheet-label">Links</div>
        ${links}
        <button class="add-line" type="button" data-act="add-link">${icon("plus")}Add link</button>`, sheet, cancelButton, "save-contact");
}
function bulletSheet(sheet) {
  const n = (sheet.text || "").length;
  return formSheet(`<h2>${sheet.id ? "Edit bullet" : "New bullet"}</h2>`, `<label class="field first"><span>Bullet</span>`
    + `<textarea data-sheet-text rows="4" maxlength="600" placeholder="Start with a verb: Built, Led, Cut…">${esc(sheet.text || "")}</textarea></label>
        <p class="char-count${n > 160 ? " long" : ""}" id="char-count">${charCount(n)}</p>`, sheet, deleteButton(sheet, "delete-bullet"), "save-bullet");
}
function skillSheet(sheet, course) {
  const field = course
    ? `<label class="field first"><span>Course</span><input data-sheet-text maxlength="120" value="${esc(sheet.text || "")}" placeholder="e.g. Machine Learning"></label>`
    : `<label class="field first"><span>Skill</span><input data-sheet-text maxlength="120" value="${esc(sheet.text || "")}" placeholder="e.g. PostgreSQL"></label>
        <div class="sheet-label">Group</div>${SKILL_GROUPS.map(group => `<button class="opt radio" type="button" role="radio" data-group="${group.key}" `
      + `aria-checked="${sheet.group === group.key}"><span class="box"></span>${group.title}</button>`).join("")}`;
  const noun = course ? "course" : "skill";
  return formSheet(`<h2>${sheet.id ? `Edit ${noun}` : `Add ${noun}`}</h2>`, field, sheet, deleteButton(sheet, `delete-${noun}`), `save-${noun}`,
    sheet.id ? "Save" : `Add ${noun}`);
}
function newResumeSheet(sheet) {
  const jobs = state.jobs.map(job => `<option value="${job.id}"${String(sheet.target) === String(job.id) ? " selected" : ""}>${esc(job.company)} · ${esc(job.title)}</option>`).join("");
  const variants = state.variants.map(variant => `<option value="${esc(variant.key)}"${sheet.variant === variant.key ? " selected" : ""}>`
    + `${esc(variant.label || variant.key)} content</option>`).join("");
  return `${sheetHead("<h2>New resume</h2>")}<div class="sheet-body">
        <label class="field first"><span>Resume name</span><input data-sheet-field="name" maxlength="300" placeholder="e.g. Software engineering" value="${esc(sheet.name || "")}"></label>
        <label class="field"><span>Target role (optional)</span><select data-sheet-field="target"><option value="">No target role</option>${jobs}</select></label>
        <label class="field"><span>Start with</span><select data-sheet-field="variant">${variants}<option value=""${sheet.variant === "" ? " selected" : ""}>Everything in my profile</option></select></label>
        <p class="sheet-note">You can switch anything on or off afterwards.</p>${errorLine(sheet)}</div>
        <div class="sheet-foot"><button class="btn primary block" type="button" data-act="create-resume"${busy(sheet)}>Create resume</button></div>`;
}
function tailorSheet(sheet) {
  const resume = docById(S.push?.id), bullet = entryById(sheet.entry)?.bullets.find(item => item.id === sheet.id);
  if (!resume || !bullet) return "";
  const reset = bulletPick(resume, sheet.entry, bullet.id)?.text_override ? `<button class="btn" type="button" data-act="reset-tailor">${icon("undo")}Use profile text</button>` : "";
  return formSheet(`<div><h2>Reword for this resume</h2><p>${esc(resume.name)}</p></div>`, `<label class="field first"><span>Text on this resume</span>`
    + `<textarea data-sheet-text rows="4" maxlength="600">${esc(sheet.text)}</textarea></label>
        <div class="profile-text"><span>Profile text</span>${esc(bullet.text)}</div>
        <p class="sheet-note" style="margin-top:10px">Only this resume changes. Your profile and other resumes keep the original.</p>`, sheet, reset, "save-tailor");
}
function targetSheet() {
  const resume = docById(S.push?.id);
  const options = [{ id: "", company: "", title: "" }, ...state.jobs].map(job => `<button class="opt radio" type="button" role="radio" data-target-role="${job.id}" `
    + `aria-checked="${String(resume?.target_job_id ?? "") === String(job.id)}"><span class="box"></span><span>${job.id ? `${esc(job.company)} · ${esc(job.title)}` : "No target role"}</span></button>`).join("");
  return `${sheetHead("<div><h2>Target role</h2><p>The job this resume is written for.</p></div>")}<div class="sheet-body end">
        ${options}
        ${state.jobs.length ? "" : '<p class="field-hint">Jobs you send to Resume from Applied (Tailor resume) show up here.</p>'}</div>`;
}
function sheetMarkup(sheet) {
  switch (sheet.kind) {
    case "contact": return contactSheet(sheet);
    case "bullet": return bulletSheet(sheet);
    case "skill": return skillSheet(sheet, false);
    case "course": return skillSheet(sheet, true);
    case "add-section":
      return `${sheetHead("<h2>Add section</h2>")}<div class="sheet-body end">
        ${missingSections().map(key => `<button class="opt" type="button" data-add-section="${key}">${key === "skills" ? "Skills" : KIND[key].title}`
    + `<span class="opt-end">${icon("chev")}</span></button>`).join("")}</div>`;
    case "new-resume": return newResumeSheet(sheet);
    case "doc-menu":
      return `${sheetHead(`<h2>${esc(docById(sheet.id)?.name || "Resume")}</h2>`)}<div class="sheet-body end">
        <button class="opt" type="button" data-act="rename-resume">${icon("pencil")}Rename</button>
        <button class="opt" type="button" data-act="download">${icon("dl")}Download PDF</button>
        <button class="opt danger-opt" type="button" data-act="ask-delete-resume">${icon("trash")}Delete resume</button></div>`;
    case "rename":
      return formSheet("<h2>Rename resume</h2>", `<label class="field first"><span>Name</span><input data-sheet-text maxlength="300" value="${esc(sheet.text)}"></label>`,
        sheet, cancelButton, "save-rename");
    case "delete-resume":
      return `${sheetHead(`<h2>Delete “${esc(docById(sheet.id)?.name || "")}”?</h2>`)}<div class="sheet-body">`
        + `<p style="margin:4px 0 0;color:var(--muted);font-size:14.5px">Your profile keeps every entry and bullet. Only this resume's choices and rewording go away.</p></div>
        <div class="sheet-foot">${cancelButton}<button class="btn danger-solid grow" type="button" data-act="delete-resume">Delete resume</button></div>`;
    case "tailor": return tailorSheet(sheet);
    case "availability":
      return formSheet("<h2>Availability</h2>", `<label class="field first"><span>Shown under your name</span><input data-sheet-text maxlength="300" value="${esc(sheet.text)}" `
        + `placeholder="e.g. Available June – September 2027"></label>`, sheet, cancelButton, "save-availability");
    case "target": return targetSheet();
  }
  return "";
}

/* ───────────── Writes ───────────── */
const fail = error => P.toast(error?.message || "Could not save.");
async function patchResume(resume, fields) {
  const next = await resumeApi.updateResume(resume.id, fields);
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
async function createEntry(push) {
  if (!String(push.draft.org || "").trim()) return;
  setEntryUi({ status: "saving", error: "" });
  try {
    const created = await resumeApi.addEntry({ kind: push.entryKind, role: "", location: "", start_date: "", end_date: "", url: "", detail: "", ...trimmed(push.draft) });
    state.entries.push({ ...created, bullets: created.bullets || [] });
    state.added.add(push.entryKind);
    push.entryId = created.id;
    for (const field of Object.keys(push.draft)) if ((created[field] || "") === String(push.draft[field]).trim()) delete push.draft[field];
    bump(); P.render(); savedFlash();
  } catch (error) { setEntryUi({ status: "error", error: error.message }); }
}
async function patchEntry(push, key, value) {
  const entry = entryById(push.entryId);
  if (!entry) return;
  if ((entry[key] || "") === value) { delete push.draft[key]; return; }
  if (key === "org" && !value) { setEntryUi({ status: "error", error: `${orgLabel(push.entryKind)} can't be empty.` }); return; }
  setEntryUi({ status: "saving", error: "" });
  try {
    const next = await resumeApi.updateEntry(entry.id, { [key]: value });
    const index = state.entries.findIndex(item => item.id === entry.id);
    if (index >= 0) state.entries[index] = { ...state.entries[index], ...next, bullets: state.entries[index].bullets };
    if (push.draft[key] !== undefined && String(push.draft[key]).trim() === value) delete push.draft[key];
    bump(); P.render(); savedFlash();
  } catch (error) { setEntryUi({ status: "error", error: error.message }); }
}
function saveEntryField(key, value) {
  const token = S.push?.token;
  entryWrite = entryWrite.then(() => {
    const push = S.push;
    if (push?.kind !== "entry" || push.token !== token) return;
    return push.entryId ? patchEntry(push, key, value) : createEntry(push);
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
    const clean = linkOf(link.label, link.url);
    if (!clean) { S.sheet = { ...sheet, error: "Enter each link like github.com/you" }; return P.render(); }
    links.push(clean);
  }
  S.sheet = { ...sheet, busy: true, error: "" }; P.render();
  try {
    state.profile = await resumeApi.saveProfile({
      full_name: draft.full_name.trim(), email: draft.email.trim(), phone: draft.phone.trim(), location: draft.location.trim(), links,
    });
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
      const next = await resumeApi.updateBullet(sheet.id, text);
      entry.bullets = entry.bullets.map(bullet => bullet.id === sheet.id ? { ...bullet, ...next } : bullet);
    } else {
      entry.bullets = [...entry.bullets, await resumeApi.addBullet(entryId, text)];
    }
    S.sheet = null; bump(); P.render(); P.toast(sheet.id ? "Bullet saved" : "Bullet added");
  } catch (error) { S.sheet = { ...sheet, busy: false, error: error.message }; P.render(); }
}
// Deletes hide at once and reach the server when the Undo window closes.
function deferredDelete(key, path, message) {
  state.gone.add(key);
  bump(); P.render();
  const cancel = P.deferDelete(async leaving => {
    try { await remove(path, leaving); }
    finally { state.gone.delete(key); if (!leaving) { await refresh(); } }
  });
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
      const created = await resumeApi.addSkill(course ? "coursework" : sheet.group, name);
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
  } catch (error) {
    S.sheet = { ...sheet, busy: false, error: error.status === 409 || error.status === 422 ? "You already have that one." : error.message };
    P.render();
  }
}
// The server has no edit for a skill, so a renamed or moved skill is added
// anew, takes the old one's place in each resume, and the old one goes.
async function renameSkill(skill, name, category) {
  if (state.local) {
    Object.assign(skill, await resumeApi.updateSkill(skill.id, { name, category }));
    return;
  }
  const created = await resumeApi.addSkill(category, name, skill.audience || "all");
  state.skills.push(created);
  for (const resume of resumes().filter(item => (item.selection?.skills || []).includes(skill.id))) {
    const selection = cloneSelection(resume);
    selection.skills = selection.skills.map(id => id === skill.id ? created.id : id);
    await patchResume(resume, { selection });
  }
  await resumeApi.remove(`/skills/${skill.id}`);
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
    const created = await resumeApi.addResume(newResume({ name, target: sheet.target, variant }, entries(), skills()));
    state.resumes.unshift(created);
    S.sheet = null; state.view = "resumes"; S.push = { kind: "doc", id: created.id, mode: "content" };
    bump(); P.render(); P.toast(`Created ${created.name}`);
  } catch (error) { S.sheet = { ...sheet, busy: false, error: error.message }; P.render(); }
}
async function saveField(field, value) {
  const sheet = S.sheet, resume = docById(S.push?.id);
  if (!resume) return;
  S.sheet = { ...sheet, busy: true, error: "" }; P.render();
  try { await patchResume(resume, { [field]: value }); S.sheet = null; P.render(); }
  catch (error) { S.sheet = { ...sheet, busy: false, error: error.message }; P.render(); }
}
function saveTailor(reset) {
  const sheet = S.sheet;
  const bullet = entryById(sheet.entry)?.bullets.find(item => item.id === sheet.id);
  if (!bullet) return;
  const text = reset ? "" : String(sheet.text || "").trim();
  S.sheet = null;
  editSelection(selection => rewordBullet(selection, sheet.entry, bullet, text));
}
function deleteResume() {
  const resume = docById(S.sheet?.id);
  if (!resume) return;
  S.sheet = null; S.push = null;
  deferredDelete(`resume:${resume.id}`, `/resumes/${resume.id}`, `Deleted ${resume.name}`);
}

/* Tailor resume, from Applied: open the resume for that job, or start one. */
async function openHandoff() {
  const requested = handoffTarget(location.hash);
  if (!requested) return;
  history.replaceState(null, "", location.pathname + location.search);
  const job = state.jobs.find(item => item.id === requested);
  if (!job) return;
  state.view = "resumes";
  let resume = resumes().find(item => item.target_job_id === requested);
  if (!resume) {
    try {
      resume = await resumeApi.addResume(resumeForJob(job, state.variants, entries(), skills()));
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
// Sheets with a text field focus it once they have slid up.
const focusSoon = (selector, method = "focus") => setTimeout(() => P.$(selector)?.[method](), 320);
const openSheet = (sheet, focus) => { S.sheet = sheet; P.render(); if (focus) focusSoon(focus); };

function onClick(target, d) {
  if (d.view) {
    if (d.view !== state.view) {
      state.view = d.view;
      history.replaceState(null, "", d.view === "resumes" ? "#resumes" : location.pathname);
      P.render(); P.els.page.scrollTop = 0;
    }
    return;
  }
  if (d.entry) { const entry = entryById(d.entry); openEntryPage(entry.kind, entry.id); return P.render(); }
  if (d.newEntry) { openEntryPage(d.newEntry, null); P.render(); return focusSoon("#push [data-ef]"); }
  if (d.bullet) {
    const bullet = entryById(S.push.entryId)?.bullets.find(item => item.id === Number(d.bullet));
    return bullet && openSheet({ kind: "bullet", id: bullet.id, text: bullet.text });
  }
  if (d.course) { const course = skills().find(item => item.id === Number(d.course)); return openSheet({ kind: "course", id: course.id, text: course.name }); }
  if (d.skill) { const skill = skills().find(item => item.id === Number(d.skill)); return openSheet({ kind: "skill", id: skill.id, text: skill.name, group: groupOf(skill.category) }); }
  if (d.addSkill) return openSheet({ kind: "skill", text: "", group: d.addSkill }, "#sheet [data-sheet-text]");
  if (d.group) return openSheet({ ...S.sheet, group: d.group });
  if (d.addSection) {
    const key = d.addSection;
    state.added.add(key); S.sheet = null;
    if (key === "skills") S.push = { kind: "skills" };
    else openEntryPage(key, null);
    bump(); return P.render();
  }
  if (d.linkDel) { syncContact(); S.sheet.draft.links.splice(Number(d.linkDel), 1); return openSheet({ ...S.sheet }); }
  if (d.doc) { S.push = { kind: "doc", id: Number(d.doc), mode: "content" }; return P.render(); }
  if (d.mode) {
    S.push = { ...S.push, mode: d.mode }; P.render();
    const scroller = P.$("#push-scroll");
    if (scroller) scroller.scrollTop = 0;
    if (d.mode === "preview") loadPreview();
    return;
  }
  if (d.pickEntry) {
    const entry = entryById(d.pickEntry);
    return entry && editSelection(selection => toggleEntry(selection, entry));
  }
  if (d.pickBullet) return editSelection(selection => toggleBullet(selection, Number(d.of), Number(d.pickBullet)));
  // The GPA switch only shows on an entry the resume includes.
  if (d.pickGpa) return editSelection(selection => toggleDetail(selection, Number(d.pickGpa)));
  if (d.pickSkill) return editSelection(selection => toggleSkill(selection, Number(d.pickSkill)));
  if (d.tailor) {
    const resume = docById(S.push.id), bullet = entryById(d.of)?.bullets.find(item => item.id === Number(d.tailor));
    if (!bullet) return;
    return openSheet({ kind: "tailor", id: bullet.id, entry: Number(d.of), text: bulletPick(resume, Number(d.of), bullet.id)?.text_override || bullet.text });
  }
  if (d.template || d.density) {
    return editSelection(selection => { if (d.template) selection.template = d.template; else selection.density = d.density; }).then(loadPreview);
  }
  if (d.targetRole !== undefined) {
    S.sheet = null; P.render();
    return patchResume(docById(S.push.id), { target_job_id: d.targetRole ? Number(d.targetRole) : null }).catch(fail);
  }
  switch (d.act) {
    case "retry": state.loading = true; state.error = ""; P.render(); return refresh();
    case "edit-contact": {
      const c = state.profile || {};
      const links = (c.links || []).map(link => ({ label: link.label || "", url: link.url || "" }));
      return openSheet({ kind: "contact", draft: { full_name: c.full_name || "", email: c.email || "", phone: c.phone || "", location: c.location || "", links } });
    }
    case "add-link":
      syncContact(); S.sheet.draft.links.push({ label: "", url: "" });
      openSheet({ ...S.sheet });
      return P.$(`#sheet [data-link-label="${S.sheet.draft.links.length - 1}"]`)?.focus();
    case "save-contact": return saveContact();
    case "edit-skills": S.push = { kind: "skills" }; return P.render();
    case "add-section": return openSheet({ kind: "add-section" });
    case "add-course": return openSheet({ kind: "course", text: "" }, "#sheet [data-sheet-text]");
    case "add-bullet":
      if (!S.push.entryId) return setEntryUi({ error: `Add the ${orgLabel(S.push.entryKind).toLowerCase()} first, then its bullets.` });
      return openSheet({ kind: "bullet", text: "" }, "#sheet [data-sheet-text]");
    case "save-bullet": return saveBullet();
    case "delete-bullet": return deleteBullet();
    case "delete-entry": return deleteEntry();
    case "save-skill": return saveSkill(false);
    case "save-course": return saveSkill(true);
    case "delete-skill": case "delete-course": return deleteSkill();
    case "new-resume": return openSheet({ kind: "new-resume", name: "", target: "", variant: state.variants[0]?.key ?? "" }, "#sheet [data-sheet-field=name]");
    case "create-resume": return createResume();
    case "doc-menu": return openSheet({ kind: "doc-menu", id: S.push.id });
    case "rename-resume":
      openSheet({ kind: "rename", id: S.push.id, text: docById(S.push.id)?.name || "" });
      return focusSoon("#sheet [data-sheet-text]", "select");
    case "save-rename": {
      const name = String(S.sheet.text || "").trim();
      return name ? saveField("name", name) : openSheet({ ...S.sheet, error: "Name the resume." });
    }
    case "ask-delete-resume": return openSheet({ kind: "delete-resume", id: S.push.id });
    case "delete-resume": return deleteResume();
    case "save-tailor": return saveTailor(false);
    case "reset-tailor": return saveTailor(true);
    case "edit-availability": return openSheet({ kind: "availability", text: docById(S.push.id)?.availability_line || "" });
    case "save-availability": return saveField("availability_line", String(S.sheet.text || "").trim());
    case "edit-target": return openSheet({ kind: "target" });
    case "download": return download();
    case "retry-pdf": {
      state.pdf = { url: null, id: null, key: null, loading: false, error: "" };
      const slot = P.$("#pdf-slot");
      if (slot) slot.innerHTML = pdfMarkup(docById(S.push.id));
      return loadPreview();
    }
  }
}

function wire() {
  const host = P.els.app;
  host.addEventListener("input", event => {
    const el = event.target;
    if (el.matches("[data-sheet-text]") && S.sheet) {
      S.sheet.text = el.value;
      const count = S.sheet.kind === "bullet" && P.$("#char-count");
      if (count) { count.textContent = charCount(el.value.length); count.classList.toggle("long", el.value.length > 160); }
    }
    if (el.dataset.sheetField && S.sheet) S.sheet[el.dataset.sheetField] = el.value;
    if (el.dataset.ef && S.push?.kind === "entry") S.push.draft[el.dataset.ef] = el.value;
  });
  host.addEventListener("change", event => {
    const el = event.target;
    if (el.dataset.sheetField && S.sheet) S.sheet[el.dataset.sheetField] = el.value;
    if (el.dataset.ef && S.push?.kind === "entry") saveEntryField(el.dataset.ef, el.value.trim());
  });
  // Another tab changed the guest workspace.
  addEventListener("storage", event => {
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

// Resumes on desktop: one master profile, many tailored documents.
import { startAccount } from "../shared/account.js";
import { esc } from "../shared/util.js";
import {
  BULLET_KINDS, DENSITIES, KIND, SECTION_ORDER, SKILL_GROUPS, TEMPLATES, bulletPick, cloneSelection, dates, densityOf, gpa,
  handoffTarget, linkOf, newResume, parseDates, pdfBlob, pdfName, pickOf, resumeApi, resumeForJob, rewordBullet, shortDay,
  showsDetail, shownEntry, skillOn, targetOf, templateOf, toggleBullet, toggleDetail, toggleEntry, toggleSkill, webUrl,
} from "./core.js";

startAccount();

const state = {
  profile: null,
  entries: [],
  skills: [],
  variants: [],
  jobs: [],
  resumes: [],
  resumeId: null,
  local: false,
  tab: location.hash === "#resumes" ? "resumes" : "profile",
  mode: "content",
  addingKind: null,
  addingSkill: false,
  addingCourse: false,
  addingBulletEntry: null,
  renamingResumeId: null,
  openSections: new Set(["skills", ...BULLET_KINDS]),
  pdfUrl: null,
};

const view = document.getElementById("view");
const tabAction = document.getElementById("tab-action");
const toast = document.getElementById("toast");
let toastTimer = null;

const href = value => {
  const url = webUrl(value);
  return url ? esc(url.href) : "#";
};
const icon = name => `<svg aria-hidden="true"><use href="#icon-${name}"/></svg>`;
const editCue = '<svg class="edit-cue" aria-hidden="true"><use href="#icon-edit"/></svg>';
const addLabel = kind => `Add ${kind}`;

function say(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}

async function loadAll() {
  Object.assign(state, await resumeApi.load());
  if (!state.resumes.some(resume => resume.id === state.resumeId)) state.resumeId = state.resumes[0]?.id ?? null;
}

async function refresh() {
  await loadAll();
  render();
}

const currentResume = () => state.resumes.find(resume => resume.id === state.resumeId) || null;
const entriesOf = kind => state.entries.filter(entry => entry.kind === kind);
const hasSkills = () => state.skills.some(skill => skill.category !== "coursework");
const buildPdf = resume => pdfBlob({ local: state.local, profile: state.profile, resume, entries: state.entries, skills: state.skills });

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
  if (!state.addingSkill && !hasSkills()) missing.push({ key: "skills", label: "Skills" });
  BULLET_KINDS.forEach(kind => {
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

function sectionBar(key, title, add = "", fixed = false) {
  const open = fixed || state.openSections.has(key);
  const toggle = `<button class="section-toggle" type="button" data-action="toggle-section" data-section="${key}" aria-expanded="${open}" `
    + `aria-label="${open ? "Collapse" : "Expand"} ${esc(title)}">${icon("down")}</button>`;
  return `<header class="section-bar">
      ${fixed ? "" : toggle}
      <h2>${esc(title)}</h2>
      ${add ? `<button class="section-add" type="button" data-action="section-add" data-section="${key}">${icon("plus")}${esc(add)}</button>` : ""}
    </header>`;
}

// A value that turns into an inline editor when clicked.
const editableValue = (label, value, attrs, empty) => `<div class="field-value ${value ? "" : "is-empty"}"><strong>`
  + `<button class="value-trigger" type="button" ${attrs} aria-label="Edit ${esc(label)}"><span>${esc(value || empty)}</span>${editCue}</button></strong></div>`;
const profileValue = (label, field, empty) =>
  editableValue(label, state.profile[field], `data-action="edit-profile-field" data-field="${field}"`, empty);
const entryValue = (entry, label, field, value, empty) =>
  editableValue(label, value, `data-action="edit-entry-field" data-entry="${entry.id}" data-field="${field}"`, empty);

const linkAnchor = link => `<a href="${href(link.url)}" target="_blank" rel="noreferrer">${esc(link.label || link.url)}</a>`;

// Sections take the resume being tailored, or nothing on the editable Profile.
function contactSection(resume = null) {
  const profile = state.profile;
  if (resume) {
    const details = [profile.email, profile.phone, profile.location].filter(Boolean);
    const links = (profile.links || []).map(linkAnchor).join("");
    return `<article class="resume-section contact-section">
        <header class="section-bar"><h2>Contact</h2></header>
        <div class="section-body compact-contact">
          <div class="contact-summary"><strong>${esc(profile.full_name || "Add your name in Profile")}</strong>
            <div class="contact-details">${details.map(detail => `<span>${esc(detail)}</span>`).join("") || `<span>No contact details added.</span>`}</div>
            ${links ? `<div class="profile-links">${links}</div>` : ""}</div>
        </div></article>`;
  }
  const links = (profile.links || []).map((link, index) => `<span class="link-item">${linkAnchor(link)}<button class="field-pencil" type="button" `
    + `data-action="edit-link" data-index="${index}" aria-label="Edit ${esc(link.label || "link")}">${icon("edit")}</button></span>`).join("");
  const details = profileValue("Email", "email", "Add email") + profileValue("Phone", "phone", "Add phone") + profileValue("Location", "location", "Add location");
  return `<article class="resume-section contact-section">
      ${sectionBar("contact", "Contact", "", true)}
      <div class="section-body compact-contact profile-contact">
        <div class="contact-summary">
          <div class="profile-contact-name">${profileValue("Name", "full_name", "Add name")}</div>
          <div class="contact-details">${details}</div>
          <div class="profile-links">${links}<button class="link-add" type="button" data-action="add-link" aria-label="Add link">${icon("plus")}Add link</button></div>
        </div>
      </div>
    </article>`;
}

// A skill or course: editable on the Profile, a switch on a resume.
function chip(skill, resume, kind) {
  const picked = !resume || skillOn(resume, skill.id);
  const toggle = `role="button" tabindex="0" aria-pressed="${picked}" aria-label="Include ${esc(skill.name)}" data-action="toggle-skill" data-id="${skill.id}"`;
  const name = resume ? `<span>${esc(skill.name)}</span>`
    : `<button class="value-trigger" type="button" data-action="edit-skill" data-id="${skill.id}" aria-label="Edit ${esc(skill.name)}"><span>${esc(skill.name)}</span>${editCue}</button>`;
  return `<span class="${kind} ${resume && !picked ? "not-selected" : ""} ${resume ? "selectable" : ""}" ${resume ? toggle : ""}>
        ${name}</span>`;
}

function educationSection(resume = null) {
  const entries = entriesOf("education").map(entry => educationEntry(entry, resume)).join("");
  const courses = state.skills.filter(skill => skill.category === "coursework").map(course => chip(course, resume, "course-item")).join("");
  const addForm = state.addingKind === "education" && !resume ? newEntryForm("education") : "";
  const courseForm = state.addingCourse && !resume ? skillForm(true) : "";
  const addCourse = resume ? "" : `<button class="section-add" type="button" data-action="add-course">${icon("plus")}Add course</button>`;
  return `<article class="resume-section education-section">
      ${sectionBar("education", "Education", resume ? "" : addLabel("education"), true)}
      <div class="section-body">${addForm}${entries || `<p class="readonly-note">No education added.</p>`}
        <div class="coursework"><div class="coursework-head"><span class="coursework-label">Coursework</span>${addCourse}</div>
          ${courseForm}<div class="course-list">${courses || `<span class="readonly-note">No coursework added.</span>`}</div></div>
      </div>
    </article>`;
}

function educationEntry(entry, resume) {
  const gpaShown = !resume || showsDetail(resume, entry.id);
  const gpaAttrs = resume
    ? `class="education-detail selectable ${gpaShown ? "" : "not-selected"}" role="button" tabindex="0" data-action="toggle-detail" data-id="${entry.id}" `
      + `aria-pressed="${gpaShown}" aria-label="Include GPA" title="${gpaShown ? "Hide GPA on this resume" : "Show GPA on this resume"}"`
    : `class="education-detail"`;
  const value = (label, field, shown, empty) => resume
    ? `<div class="field-value ${shown ? "" : "is-empty"}"><strong>${esc(shown || "—")}</strong></div>`
    : entryValue(entry, label, field, shown, empty);
  return `<div class="entry-block education-entry" data-entry-id="${entry.id}">
      <div class="entry-head"><div class="entry-heading"><div class="entry-title-line">${value("School", "org", entry.org, "Add school")}</div>
        <div class="education-degree">${value("Degree", "role", entry.role, "Add degree")}</div></div>
        ${resume ? "" : entryActions(entry)}</div>
      <div class="education-meta">
        ${value("Dates", "dates", dates(entry), "Add dates")}<span class="separator" aria-hidden="true">·</span>
        ${value("Location", "location", entry.location, "Add location")}<span class="separator" aria-hidden="true">·</span>
        <div ${gpaAttrs}><span>GPA</span>${value("GPA", "detail", gpa(entry), "Add GPA")}</div>
      </div>
    </div>`;
}

function skillsSection(resume = null) {
  const open = state.openSections.has("skills");
  const rows = SKILL_GROUPS.map(group => {
    const skills = state.skills.filter(skill => group.categories.includes(skill.category)).map(skill => chip(skill, resume, "skill-item")).join("");
    return `<div class="skill-row"><span class="skill-label">${esc(group.title)}</span><div class="skill-list">${skills || `<span class="readonly-note">—</span>`}</div></div>`;
  }).join("");
  return `<article class="resume-section ${open ? "" : "collapsed"}">${sectionBar("skills", "Skills", resume ? "" : "Add skill")}
      <div class="section-body">${state.addingSkill && !resume ? skillForm(false) : ""}<div class="skill-rows">${rows}</div></div></article>`;
}

function entrySection(kind, resume = null) {
  const records = entriesOf(kind);
  if (resume && !records.length) return "";
  const open = state.openSections.has(kind);
  const adding = !resume && state.addingKind === kind ? newEntryForm(kind) : "";
  return `<article class="resume-section ${open ? "" : "collapsed"}">${sectionBar(kind, KIND[kind].title, resume ? "" : addLabel(kind))}
      <div class="section-body">${adding}${records.map(entry => entryBlock(entry, resume)).join("")}</div></article>`;
}

function entryActions(entry) {
  return `<div class="entry-actions"><button class="entry-more" type="button" data-action="toggle-entry-menu" aria-label="Entry actions" aria-expanded="false">${icon("more")}</button>
      <div class="popover entry-menu" hidden><button class="danger" type="button" data-action="delete-entry" data-id="${entry.id}">Delete</button></div></div>`;
}

const separated = (html, index) => `${index ? '<span class="separator">·</span>' : ""}${html}`;

function entryBlock(entry, resume) {
  entry = shownEntry(entry, resume);
  const picked = !resume || Boolean(pickOf(resume, entry.id));
  const title = KIND[entry.kind].fields.map(([field, label], index) => separated(resume
    ? `<div class="field-value"><strong>${esc(entry[field] || "—")}</strong></div>`
    : entryValue(entry, label, field, entry[field], `Add ${label.toLowerCase()}`), index)).join("");
  const link = `<a href="${href(entry.url)}" target="_blank" rel="noreferrer">View link</a>`;
  const linkValue = `<span class="field-value"><strong>${link}</strong><button class="field-pencil" type="button" data-action="edit-entry-field" `
    + `data-entry="${entry.id}" data-field="url" aria-label="Edit Link">${icon("edit")}</button></span>`;
  const meta = [["Location", "location", entry.location], ["Dates", "dates", dates(entry)], ["Link", "url", entry.url]]
    .filter(([, , value]) => !resume || value)
    .map(([label, field, value], index) => separated(resume ? `<span>${field === "url" ? link : esc(value)}</span>`
      : field === "url" && value ? linkValue : entryValue(entry, label, field, value, `Add ${label.toLowerCase()}`), index)).join("");
  const pickedCount = resume ? entry.bullets.filter(bullet => bulletPick(resume, entry.id, bullet.id)).length : 0;
  const partial = resume && pickedCount > 0 && pickedCount < entry.bullets.length;
  const headAttrs = resume
    ? `role="button" tabindex="0" aria-pressed="${partial ? "mixed" : picked}" aria-label="Include ${esc(entry.role || entry.org)}" data-action="toggle-entry" data-id="${entry.id}"`
    : "";
  const count = resume ? `<span class="entry-pick-count">${pickedCount} of ${entry.bullets.length} bullets</span>` : "";
  const tail = resume ? "" : state.addingBulletEntry === entry.id ? bulletForm(entry.id)
    : `<button class="bullet-add-tail" type="button" data-action="add-bullet" data-entry="${entry.id}" aria-label="Add bullet">${icon("plus")}Add bullet</button>`;
  return `<div class="entry-block ${resume && !picked ? "not-selected" : ""}" data-entry-id="${entry.id}">
      <div class="entry-head ${resume ? "selectable" : ""}" ${headAttrs}><div class="entry-heading"><div class="entry-title-line">${title}</div><div class="entry-meta">${meta}${count}</div></div>
        ${resume ? "" : entryActions(entry)}</div>
      <div class="bullet-list">${entry.bullets.map(bullet => bulletRow(entry, bullet, resume)).join("")}</div>
      ${tail}
    </div>`;
}

function bulletRow(entry, bullet, resume) {
  const pick = resume ? bulletPick(resume, entry.id, bullet.id) : null;
  const selected = !resume || Boolean(pick);
  const text = pick?.text_override || bullet.text;
  const toggle = `role="button" tabindex="0" aria-pressed="${selected}" aria-label="Include bullet: ${esc(text)}" data-action="toggle-bullet" data-entry="${entry.id}" data-id="${bullet.id}"`;
  return `<div class="bullet-row ${resume && !selected ? "not-selected" : ""} ${resume ? "selectable" : ""}" ${resume ? toggle : ""}>
      <span class="bullet-mark" aria-hidden="true">•</span><div class="bullet-value"><p>${esc(text)}</p>
      <button class="field-pencil" type="button" data-action="${resume ? "edit-resume-bullet" : "edit-bullet"}" data-entry="${entry.id}" data-id="${bullet.id}" `
    + `aria-label="Edit bullet">${icon("edit")}</button></div></div>`;
}

const formActions = '<div class="inline-add-actions"><button type="submit">Add</button><button class="cancel" type="button" data-action="cancel-add">Cancel</button></div>';

function newEntryForm(kind) {
  const [[, first], [, second]] = KIND[kind].fields;
  const education = kind === "education";
  return `<form class="inline-add" data-form="entry" data-kind="${kind}"><div class="inline-add-grid">
      <label>${kind === "project" ? "Project name" : first}<input name="primary" required autofocus></label><label>${second}<input name="secondary"></label>
      <label>Location<input name="location" placeholder="City, State"></label><label>Dates<input name="dates" placeholder="Start – end"></label>
      ${education ? `<label>GPA<input name="detail"></label>` : `<label>Link<input name="url" placeholder="https://"></label>`}
      </div>${formActions}</form>`;
}

function skillForm(coursework) {
  const categories = SKILL_GROUPS.map(group => `<option value="${group.key}">${esc(group.title)}</option>`).join("");
  return `<form class="inline-skill-form" data-form="skill" data-coursework="${coursework}">
      ${coursework ? "" : `<select name="category" aria-label="Skill category">${categories}</select>`}
      <input name="name" required placeholder="${coursework ? "Course name" : "Skill"}" autofocus>
      ${formActions}</form>`;
}

function bulletForm(entryId) {
  return `<form class="inline-add" data-form="bullet" data-entry="${entryId}"><div class="inline-editor"><textarea name="text" required autofocus placeholder="Add a bullet point"></textarea></div>
      ${formActions}</form>`;
}

function renderProfile() {
  const visible = new Set(["education", ...state.entries.map(entry => entry.kind)]);
  if (hasSkills() || state.addingSkill) visible.add("skills");
  if (state.addingKind) visible.add(state.addingKind);
  const sections = SECTION_ORDER.filter(key => visible.has(key))
    .map(key => key === "education" ? educationSection() : key === "skills" ? skillsSection() : entrySection(key));
  view.innerHTML = `<article class="profile-document"><div class="section-list">${contactSection()}${sections.join("")}</div></article>`;
  queueMicrotask(() => { growAll(); view.querySelector("[autofocus]")?.focus(); });
}

function resumeCard(item, resume) {
  const selected = item.id === resume.id ? "selected" : "";
  if (state.renamingResumeId === item.id) {
    return `<div class="resume-card ${selected}"><form data-form="rename-resume" data-id="${item.id}" class="inline-editor"><input name="name" value="${esc(item.name)}" required autofocus>`
      + `<button class="inline-icon" type="submit" aria-label="Save">${icon("check")}</button>`
      + `<button class="inline-icon cancel" type="button" data-action="cancel-rename" aria-label="Cancel">${icon("close")}</button></form></div>`;
  }
  const date = shortDay(item.updated_at);
  return `<div class="resume-card ${selected}"><button class="resume-card-main" type="button" data-action="choose-resume" data-id="${item.id}"><strong>${esc(item.name)}</strong>${date ? `<span>Edited ${date}</span>` : ""}</button>
        <span class="card-menu"><button class="entry-more" type="button" data-action="toggle-resume-menu" aria-label="Resume actions" aria-expanded="false">${icon("more")}</button>`
    + `<span class="popover" hidden><button type="button" data-action="rename-resume" data-id="${item.id}">Rename</button>`
    + `<button class="danger" type="button" data-action="delete-resume" data-id="${item.id}">Delete</button></span></span></div>`;
}

function resumePicker(resume) {
  return `<div class="resume-picker"><button class="resume-picker-trigger" type="button" data-action="toggle-resume-picker" aria-label="Choose resume" aria-expanded="false" title="Choose resume">`
    + `<span>${esc(resume.name)}</span>${icon("down")}</button><div class="popover resume-list" hidden>${state.resumes.map(item => resumeCard(item, resume)).join("")}`
    + `<button class="resume-list-create" type="button" data-action="new-resume">${icon("plus")}New resume</button></div></div>`;
}

const designSelect = (id, attr, label, options, value) => `<label for="${id}">${label}</label><select id="${id}" class="design-select" ${attr}>`
  + `${options.map(([key, text]) => `<option value="${key}" ${value === key ? "selected" : ""}>${text}</option>`).join("")}</select>`;

function renderResumes() {
  const resume = currentResume();
  if (!resume) {
    view.innerHTML = `<section class="empty-state resume-empty"><button class="button primary" type="button" data-action="new-resume">${icon("plus")}New resume</button>`
      + "<p>Create resume with customized profile</p></section>";
    return;
  }
  const target = targetOf(state.jobs, resume);
  const content = [contactSection(resume), educationSection(resume)];
  if (hasSkills()) content.push(skillsSection(resume));
  BULLET_KINDS.forEach(kind => content.push(entrySection(kind, resume)));
  const modes = `<div class="mode-switch" aria-label="Resume display"><button type="button" data-action="show-content" aria-pressed="${state.mode === "content"}">${icon("edit")}Content</button>`
    + `<button type="button" data-action="show-pdf" aria-pressed="${state.mode === "pdf"}">${icon("eye")}Preview</button></div>`;
  const targetLine = target ? `<div class="target-line"><span>Target</span><strong>${esc(target.company)} · ${esc(target.title)}</strong>`
    + `${target.url ? `<a href="${href(target.url)}" target="_blank" rel="noreferrer">View role ${icon("external")}</a>` : ""}</div>` : "";
  const template = templateOf(resume);
  const preview = `<div class="resume-preview"><div class="preview-tools">${designSelect("resume-design", "data-resume-template", "Design", TEMPLATES, template)}`
    + `${template === "barlow" ? designSelect("resume-density", "data-resume-density", "Spacing", DENSITIES, densityOf(resume)) : ""}</div>`
    + `<div class="pdf-stage"><p class="pdf-loading">Building preview…</p><iframe class="pdf-frame" title="Resume PDF preview" hidden></iframe></div></div>`;
  view.innerHTML = `<article class="resume-document">
      <header class="document-head"><div class="document-identity"><div class="document-title">${resumePicker(resume)}</div></div>
        <div class="document-actions">${modes}<button class="button small" type="button" data-action="export-pdf">${icon("download")}Export PDF</button></div>
      </header>
      <div class="resume-availability resume-field"><span class="field-label">Availability</span>${editableValue("Availability", resume.availability_line, `data-action="edit-resume-field" data-field="availability_line"`, "Add availability")}</div>
      ${targetLine}
      ${state.mode === "content" ? `<div class="resume-content section-list">${content.join("")}</div>` : preview}
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

function toggleMenu(button) {
  const menu = button.nextElementSibling;
  const opening = menu.hidden;
  closeMenus(menu);
  menu.hidden = !opening;
  button.setAttribute("aria-expanded", String(opening));
  return opening;
}

// Keeps the resume card menu outside the picker's scroll clipping, including its last row.
function placeResumeMenu(button) {
  const menu = button.nextElementSibling;
  menu.style.position = "fixed";
  menu.style.right = "auto";
  const anchor = button.getBoundingClientRect();
  const popup = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(anchor.right - popup.width, innerWidth - popup.width - 8))}px`;
  menu.style.top = `${Math.max(8, anchor.bottom + popup.height + 4 <= innerHeight ? anchor.bottom + 4 : anchor.top - popup.height - 4)}px`;
}

async function patchResume(resume, fields, message = "Saved automatically") {
  const updated = await resumeApi.updateResume(resume.id, fields);
  state.resumes[state.resumes.findIndex(item => item.id === resume.id)] = updated;
  if (message) say(message);
}

async function editSelection(change) {
  const resume = currentResume();
  const selection = cloneSelection(resume);
  change(selection);
  await patchResume(resume, { selection }, "");
  renderResumes();
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
  scope.innerHTML = `<form class="inline-editor value-editor"><input name="value" value="${esc(config.value)}" aria-label="${esc(config.label)}" autofocus>`
    + `<button class="inline-icon" type="submit" aria-label="Save">${icon("check")}</button><button class="inline-icon cancel" type="button" aria-label="Cancel">${icon("close")}</button>`
    + `${config.remove ? `<button class="inline-icon cancel remove" type="button" aria-label="Delete">${icon("trash")}</button>` : ""}</form>`;
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

function startResumeField(button) {
  const resume = currentResume();
  const field = button.dataset.field;
  startInlineEditor(button, {
    scope: ".field-value", value: resume[field] || "", label: field,
    save: async value => { await patchResume(resume, { [field]: value }); renderResumes(); },
  });
}

function startProfileField(button) {
  const field = button.dataset.field;
  startInlineEditor(button, {
    scope: ".field-value", value: state.profile[field] || "", label: field,
    save: async value => { state.profile = await resumeApi.saveProfile({ [field]: value }); renderProfile(); say("Saved automatically"); },
  });
}

function startEntryField(button) {
  const entry = state.entries.find(item => item.id === Number(button.dataset.entry));
  const field = button.dataset.field;
  if (!entry) return;
  startInlineEditor(button, {
    scope: ".field-value", value: field === "dates" ? dates(entry) : entry[field] || "", label: field,
    save: async next => {
      await resumeApi.updateEntry(entry.id, field === "dates" ? parseDates(next) : { [field]: next });
      await refresh(); say("Saved automatically");
    },
  });
}

// On a resume (reword) the bullet changes there only; on the Profile, everywhere.
function startBulletEditor(button, reword) {
  const entry = state.entries.find(item => item.id === Number(button.dataset.entry));
  const bullet = entry?.bullets.find(item => item.id === Number(button.dataset.id));
  const row = button.closest(".bullet-row");
  if (!bullet || !row) return;
  const resume = currentResume();
  const value = (reword && bulletPick(resume, entry.id, bullet.id)?.text_override) || bullet.text;
  const textFont = getComputedStyle(row.querySelector(".bullet-value p")).font;
  const original = row.innerHTML;
  row.innerHTML = `<span class="bullet-mark">•</span><form class="inline-editor"><textarea name="text" autofocus>${esc(value)}</textarea>`
    + `<button class="inline-icon" type="submit" aria-label="Save">${icon("check")}</button><button class="inline-icon cancel" type="button" aria-label="Cancel">${icon("close")}</button>`
    + `${reword ? "" : `<button class="inline-icon cancel remove" type="button" aria-label="Delete bullet">${icon("trash")}</button>`}</form>`;
  const form = row.querySelector("form");
  form.style.font = textFont;
  growAll(row);
  const restore = () => { row.innerHTML = original; row.querySelector(".field-pencil")?.focus({ preventScroll: true }); };
  form.querySelector(".cancel").onclick = restore;
  form.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); restore(); }
  });
  if (!reword) form.querySelector(".remove").onclick = async () => {
    if (!confirm("Delete this bullet?")) return;
    await resumeApi.remove(`/bullets/${bullet.id}`);
    await refresh();
  };
  form.onsubmit = async event => {
    event.preventDefault();
    const text = form.elements.text.value.trim();
    if (!text) return;
    try {
      if (!reword) await resumeApi.updateBullet(bullet.id, text);
      else {
        const selection = cloneSelection(resume);
        rewordBullet(selection, entry.id, bullet, text);
        await patchResume(resume, { selection }, "");
      }
      await refresh(); say("Saved automatically");
    } catch (error) { say(error.message); row.innerHTML = original; }
  };
  form.elements.text.focus();
}

function startLinkEditor(index = null) {
  renderProfile();
  const link = index === null ? { label: "", url: "" } : state.profile.links[index];
  const region = view.querySelector(".profile-links");
  const remove = index === null ? ""
    : `<button class="inline-icon cancel" type="button" data-action="delete-link" data-index="${index}" aria-label="Delete link">${icon("trash")}</button>`;
  region.insertAdjacentHTML("beforeend", `<form class="inline-link-form" data-form="link" data-index="${index ?? ""}">`
    + `<input name="label" value="${esc(link.label)}" placeholder="Label" aria-label="Link label" autofocus>`
    + `<input name="url" value="${esc(link.url)}" placeholder="github.com/you" type="text" inputmode="url" required aria-label="Link URL">`
    + `<button class="inline-icon" type="submit" aria-label="Save">${icon("check")}</button>`
    + `<button class="inline-icon cancel" type="button" data-action="cancel-add" aria-label="Cancel">${icon("close")}</button>${remove}</form>`);
  region.querySelector("[autofocus]").focus();
}

function startSkillEditor(button) {
  const skill = state.skills.find(item => item.id === Number(button.dataset.id));
  if (!skill) return;
  startInlineEditor(button, {
    scope: ".skill-item, .course-item", value: skill.name, label: "skill",
    save: async name => { await resumeApi.updateSkill(skill.id, { name }); await refresh(); say("Saved automatically"); },
    remove: async () => {
      if (!confirm(`Delete ${skill.name}?`)) return;
      await resumeApi.remove(`/skills/${skill.id}`);
      await refresh();
    },
  });
}

async function loadPdfPreview() {
  const frame = view.querySelector(".pdf-frame");
  const loading = view.querySelector(".pdf-loading");
  if (!frame) return;
  try {
    const blob = await buildPdf(currentResume());
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
  const url = URL.createObjectURL(await buildPdf(resume));
  const link = document.createElement("a");
  link.href = url;
  link.download = pdfName(resume);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function openResumeDialog() {
  const dialog = document.getElementById("resume-dialog");
  const form = dialog.querySelector("form");
  const variant = state.variants[0]?.key ?? "";
  form.reset();
  form.elements.target_job_id.innerHTML = `<option value="">No target role</option>`
    + state.jobs.map(job => `<option value="${job.id}">${esc(job.company)} · ${esc(job.title)}</option>`).join("");
  form.elements.variant.innerHTML = [{ key: "", label: "All profile content" }, ...state.variants].map(({ key, label }) =>
    `<option value="${esc(key)}" ${key === variant ? "selected" : ""}>${esc(label || key)}</option>`).join("");
  dialog.showModal();
  form.elements.name.focus();
}

function startAdding(key) {
  if (key === "skills") state.addingSkill = true; else state.addingKind = key;
  state.openSections.add(key);
}

async function handleAction(button) {
  const { action, section } = button.dataset;
  const id = Number(button.dataset.id);
  switch (action) {
    case "new-resume": closeMenus(); return openResumeDialog();
    case "toggle-add-section": case "toggle-entry-menu": case "toggle-resume-picker": toggleMenu(button); return;
    case "toggle-resume-menu": if (toggleMenu(button)) placeResumeMenu(button); return;
    case "add-section": closeMenus(); startAdding(section); return render();
    case "section-add": startAdding(section); return renderProfile();
    case "toggle-section":
      if (state.openSections.has(section)) state.openSections.delete(section); else state.openSections.add(section);
      return render();
    case "add-course": state.addingCourse = true; return renderProfile();
    case "add-bullet": state.addingBulletEntry = Number(button.dataset.entry); return renderProfile();
    case "cancel-add":
      Object.assign(state, { addingKind: null, addingSkill: false, addingCourse: false, addingBulletEntry: null });
      return render();
    case "edit-profile-field": return startProfileField(button);
    case "edit-entry-field": return startEntryField(button);
    case "edit-resume-field": return startResumeField(button);
    case "edit-bullet": return startBulletEditor(button, false);
    case "edit-resume-bullet": return startBulletEditor(button, true);
    case "edit-link": return startLinkEditor(Number(button.dataset.index));
    case "add-link": return startLinkEditor();
    case "delete-link": {
      const links = [...(state.profile.links || [])];
      links.splice(Number(button.dataset.index), 1);
      state.profile = await resumeApi.saveProfile({ links });
      renderProfile(); say("Link deleted"); return;
    }
    case "edit-skill": return startSkillEditor(button);
    case "delete-entry":
      if (confirm("Delete this entry and its bullets?")) { await resumeApi.remove(`/entries/${id}`); await refresh(); }
      return;
    case "choose-resume": state.resumeId = id; state.mode = "content"; state.renamingResumeId = null; return renderResumes();
    case "rename-resume": case "cancel-rename":
      state.renamingResumeId = action === "rename-resume" ? id : null;
      renderResumes();
      view.querySelector("[data-action=toggle-resume-picker]").click();
      return;
    case "delete-resume":
      if (confirm("Delete this resume? Your Profile content will stay intact.")) {
        await resumeApi.remove(`/resumes/${id}`);
        if (state.resumeId === id) state.resumeId = null;
        await refresh();
      }
      return;
    case "toggle-skill": return editSelection(selection => toggleSkill(selection, id));
    case "toggle-bullet": return editSelection(selection => toggleBullet(selection, Number(button.dataset.entry), id));
    case "toggle-entry": {
      const entry = state.entries.find(item => item.id === id);
      return editSelection(selection => toggleEntry(selection, entry, { complete: true }));
    }
    case "toggle-detail": return editSelection(selection => toggleDetail(selection, id));
    case "show-content": state.mode = "content"; return renderResumes();
    case "show-pdf": state.mode = "pdf"; return renderResumes();
    case "export-pdf": return exportPdf();
  }
}

// A bullet is one or two lines far more often than four, so the box opens at a
// single row and follows the text rather than reserving height for it.
function grow(area) {
  area.style.height = "auto";
  area.style.height = `${area.scrollHeight}px`;
}
const growAll = (root = view) => root.querySelectorAll("textarea").forEach(grow);

view.addEventListener("input", event => {
  if (event.target instanceof HTMLTextAreaElement) grow(event.target);
});

view.addEventListener("change", async event => {
  if (!event.target.matches("[data-resume-template], [data-resume-density]")) return;
  const density = event.target.matches("[data-resume-density]");
  try {
    const resume = currentResume();
    const selection = cloneSelection(resume);
    selection[density ? "density" : "template"] = event.target.value;
    await patchResume(resume, { selection });
    renderResumes();
    view.querySelector(density ? "[data-resume-density]" : "[data-resume-template]")?.focus({ preventScroll: true });
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

async function submitEntry(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const kind = form.dataset.kind;
  const orgFirst = kind === "project" || kind === "education";
  await resumeApi.addEntry({
    kind, org: orgFirst ? data.primary : data.secondary, role: orgFirst ? data.secondary : data.primary,
    location: data.location || "", ...parseDates(data.dates || ""), url: kind === "education" ? "" : data.url || "", detail: data.detail || "",
  });
  state.addingKind = null; await refresh(); say(`${KIND[kind].title} added`);
}

async function submitLink(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const link = linkOf(data.label, data.url);
  if (!link) { say("Enter a link like github.com/you"); return; }
  const links = [...(state.profile.links || [])];
  if (form.dataset.index === "") links.push(link); else links[Number(form.dataset.index)] = link;
  state.profile = await resumeApi.saveProfile({ links }); renderProfile(); say("Saved automatically");
}

view.addEventListener("submit", async event => {
  const form = event.target;
  event.preventDefault();
  try {
    if (form.dataset.form === "entry") await submitEntry(form);
    else if (form.dataset.form === "bullet") {
      await resumeApi.addBullet(Number(form.dataset.entry), new FormData(form).get("text").trim());
      state.addingBulletEntry = null; await refresh(); say("Bullet added");
    } else if (form.dataset.form === "skill") {
      const data = Object.fromEntries(new FormData(form).entries());
      const coursework = form.dataset.coursework === "true";
      await resumeApi.addSkill(coursework ? "coursework" : data.category, data.name.trim());
      state.addingCourse = false; state.addingSkill = false; await refresh(); say(coursework ? "Course added" : "Skill added");
    } else if (form.dataset.form === "link") await submitLink(form);
    else if (form.dataset.form === "rename-resume") {
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
  if (event.key === "Escape") closeMenus();
});

document.querySelectorAll("[data-close-dialog]").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
document.getElementById("resume-form").addEventListener("submit", async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    const created = await resumeApi.addResume(newResume({ name: data.name.trim(), target: data.target_job_id, variant: data.variant }, state.entries, state.skills));
    state.resumes.unshift(created); state.resumeId = created.id; state.tab = "resumes"; state.mode = "content";
    document.getElementById("resume-dialog").close(); render(); say("Resume created");
  } catch (error) { say(error.message); }
});

document.addEventListener("click", event => {
  if (!event.target.closest(".add-section, .resume-picker, .entry-actions, .card-menu")) closeMenus();
});

// Applied's "Tailor resume": open the resume for that job, or start one.
async function openHandoff() {
  const requested = handoffTarget(location.hash);
  const job = requested ? state.jobs.find(item => item.id === requested) : null;
  if (!job) return;
  const existing = state.resumes.find(resume => resume.target_job_id === requested);
  if (existing) state.resumeId = existing.id;
  else {
    const created = await resumeApi.addResume(resumeForJob(job, state.variants, state.entries, state.skills));
    state.resumes.unshift(created); state.resumeId = created.id;
  }
  state.tab = "resumes";
  history.replaceState(null, "", location.pathname + location.search);
}

try {
  await loadAll();
  await openHandoff();
  render();
} catch (error) {
  view.innerHTML = `<section class="empty-state"><h2>Resumes could not load</h2><p>${esc(error.message)}</p></section>`;
}

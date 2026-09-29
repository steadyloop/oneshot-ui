(function (root) {
  "use strict";

  const ACTIVE_GROUPS = Object.freeze([
    { key: "considering", label: "Considering", stages: ["considering"], color: "#6f7971" },
    { key: "applied", label: "Applied", stages: ["applied"], color: "#386f9f" },
    { key: "assessment", label: "Assessment", stages: ["assessment"], color: "#9a641d" },
    { key: "interview", label: "Interview", stages: ["interview"], color: "#75529a" },
    { key: "offer", label: "Offer", stages: ["offer"], color: "#347552" },
  ]);
  const STAGE_LABELS = Object.freeze({ considering: "Considering", applied: "Applied", assessment: "Assessment", interview: "Interview", offer: "Offer", closed: "Closed" });
  const CLOSED_REASON_LABELS = Object.freeze({ rejected: "Rejected", withdrawn: "Withdrawn", no_reply: "No reply" });

  const DAY = 86400000;
  // submitted_at and next_due_at hold a calendar date, but the column is
  // timestamptz and the server stores the picked day at UTC midnight (or UTC
  // end of day). Reading one back as an instant and rendering it locally moves
  // it a day west of UTC -- pick Sep 8, the list says Sep 7 while the drawer's
  // own date input still says Sep 8. The leading YYYY-MM-DD is the day that was
  // meant, so every date-only field is compared and formatted from that and
  // never from a local-time conversion. Event timestamps are real instants and
  // are deliberately left alone.
  const calendarDay = value => String(value || "").match(/^\d{4}-\d{2}-\d{2}/)?.[0] || "";
  const dayIndex = day => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY);
  const todayLocal = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const safeDate = value => { const date = new Date(String(value)); return value && !Number.isNaN(date.getTime()) ? date : null; };
  const dueState = (value, now = new Date()) => {
    const day = calendarDay(value), rank = day ? dayIndex(day) : NaN;
    if (!day || Number.isNaN(rank)) return { key: "none", label: "No due date", rank: Number.MAX_SAFE_INTEGER };
    // Whole days between calendar dates, so "due today" lasts the reader's
    // whole day rather than expiring when UTC end-of-day passes locally.
    const days = rank - dayIndex(todayLocal(now));
    if (days < 0) return { key: "overdue", label: `${-days}d overdue`, rank };
    if (days === 0) return { key: "soon", label: "Due today", rank };
    if (days === 1) return { key: "soon", label: "Due tomorrow", rank };
    return { key: days <= 7 ? "upcoming" : "none", label: `Due in ${days}d`, rank };
  };
  const DATE_FORMAT = Object.freeze({ month: "short", day: "numeric", year: "numeric" });
  const formatDay = value => { const day = calendarDay(value); return day ? new Intl.DateTimeFormat(undefined, { ...DATE_FORMAT, timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`)) : "Not set"; };
  const formatMoment = value => { const date = safeDate(value); return date ? new Intl.DateTimeFormat(undefined, DATE_FORMAT).format(date) : "Not set"; };
  const groupForStage = stage => String(stage || "").toLowerCase() === "closed" ? "archive" : ACTIVE_GROUPS.find(group => group.stages.includes(String(stage || "").toLowerCase()))?.key || "considering";
  const applicationStageLabel = application => String(application.stage || "").toLowerCase() === "closed" ? CLOSED_REASON_LABELS[application.closed_reason] || STAGE_LABELS.closed : STAGE_LABELS[application.stage] || application.stage;
  const applicationCounts = applications => ({ active: applications.filter(item => String(item.stage).toLowerCase() !== "closed").length, archive: applications.filter(item => String(item.stage).toLowerCase() === "closed").length });
  const filterApplications = (applications, options = {}, now = new Date()) => applications.filter(application => {
    const stage = String(application.stage || "considering").toLowerCase(), archived = stage === "closed";
    if ((options.statusView === "archive") !== archived) return false;
    const query = String(options.query || "").trim().toLowerCase(), text = `${application.company || ""} ${application.title || ""} ${application.location || ""} ${application.next_action || ""} ${application.closed_reason || ""}`.toLowerCase();
    if (query && !text.includes(query)) return false;
    if (options.quickFilter === "attention" && !["overdue", "soon"].includes(dueState(application.next_due_at, now).key)) return false;
    if (options.quickFilter === "interviews" && stage !== "interview") return false;
    if (options.quickFilter === "offers" && stage !== "offer") return false;
    return true;
  });
  // The server derives stage_changed_at from the last stage_changed event, so
  // it is an instant and not a calendar day -- two cards dragged in the same
  // afternoon still order against each other. updated_at is the fallback for
  // rows written before the event log existed.
  const stageMoment = application => Date.parse(application.stage_changed_at || application.updated_at || "") || 0;
  const sortApplications = (applications, sort = "moved") => [...applications].sort((a, b) => {
    if (sort === "company") return String(a.company || "").localeCompare(String(b.company || ""));
    if (sort === "applied") return String(b.submitted_at || "").localeCompare(String(a.submitted_at || ""));
    if (sort === "updated") return String(b.updated_at || b.events?.[0]?.occurred_at || "").localeCompare(String(a.updated_at || a.events?.[0]?.occurred_at || ""));
    if (sort === "moved") return stageMoment(b) - stageMoment(a);
    // Every card without a due date ranks MAX_SAFE_INTEGER and ties. Left there
    // the tie resolved to whatever order the payload arrived in, which is how a
    // card you just dragged ended up at the bottom of its new column.
    return (dueState(a.next_due_at).rank - dueState(b.next_due_at).rank) || (stageMoment(b) - stageMoment(a));
  });
  // Auto-apply is rolled out for Greenhouse hosted boards only: the one form
  // the server knows how to drive. Embedded company-site forms stay manual.
  const GREENHOUSE_HOSTED = /^https:\/\/(?:job-boards(?:\.eu)?|boards)\.greenhouse\.io\/[^/]+\/jobs\/\d+\/?(?:[?#].*)?$/i;
  const autoApplyEligible = application => Boolean(application) && !application.external
    && String(application.stage || "").toLowerCase() === "considering"
    && GREENHOUSE_HOSTED.test(String(application.apply_url_snapshot || ""));
  const withTimeout = (promise, milliseconds = 8000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The applications request timed out.")), milliseconds);
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });

  // A column renders at most this many cards; the rest sit behind "Show more".
  // The DOM cost of the board is per column, so the cap is too.
  const COLUMN_CAP = 50;
  const exported = { ACTIVE_GROUPS, STAGE_LABELS, CLOSED_REASON_LABELS, COLUMN_CAP, calendarDay, formatDay, todayLocal, dueState, groupForStage, applicationStageLabel, applicationCounts, filterApplications, sortApplications, stageMoment, withTimeout, autoApplyEligible };
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  if (!root.document) return;

  const $ = selector => document.querySelector(selector), $$ = selector => [...document.querySelectorAll(selector)];
  const content = $("#application-content"), drawer = $("#application-drawer"), drawerContent = $("#drawer-content"), addDialog = $("#add-dialog"), addForm = $("#add-form"), applyDialog = $("#apply-dialog"), applyForm = $("#apply-form"), toast = $("#toast");
  const state = { applications: [], resumes: null, query: "", quickFilter: "", statusView: "active", display: "board", sort: "moved", selectedId: null, dragId: null, picked: new Set(), lastPicked: null, flash: new Set(), expanded: {} };
  const esc = value => String(value == null ? "" : value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const safeHref = value => /^https?:\/\//i.test(String(value || "")) ? String(value) : "";
  const initials = value => String(value || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase();
  const markColor = value => { const colors = ["#244a3a", "#3e5e82", "#74533e", "#5f4a78", "#47636a", "#7a4c55"], sum = [...String(value || "")].reduce((total, character) => total + character.charCodeAt(0), 0); return colors[sum % colors.length]; };
  const dateInputValue = calendarDay;
  const stageMutation = (application, stage, closedReason = null) => {
    const body = { stage, closed_reason: stage === "closed" ? closedReason : null };
    if (stage === "applied" && application.stage !== "applied") {
      body.submitted_at = application.submitted_at || todayLocal();
    }
    return body;
  };
  const selectedApplication = () => state.applications.find(application => String(application.id) === String(state.selectedId));
  const showToast = (message, action) => { toast.replaceChildren(); const copy = document.createElement("span"); copy.textContent = message; toast.append(copy); if (action) { const button = document.createElement("button"); button.type = "button"; button.textContent = action.label; button.addEventListener("click", async () => { toast.classList.remove("show"); try { await action.run(); } catch (error) { showToast(error.message || "That could not be undone."); } }, { once: true }); toast.append(button); } toast.classList.add("show"); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove("show"), action ? 6500 : 3400); };

  function dueBadge(application) { if (!application.next_due_at) return ""; const due = dueState(application.next_due_at); return `<span class="due-badge ${due.key}"><svg aria-hidden="true"><use href="#icon-calendar"/></svg>${esc(due.label)}</span>`; }
  // Both trailing rows are conditional. Rendered unconditionally they cost
  // ~80px of every card to print "No next action" and hold an empty badge, and
  // a Considering column after a mass-apply run is almost entirely those.
  function applicationCard(application) {
    const key = String(application.id), picked = state.picked.has(key);
    const nextStep = application.next_action ? `<span class="next-step"><span>Next action</span><p>${esc(application.next_action)}</p></span>` : "";
    const footer = application.next_due_at ? `<span class="card-footer">${dueBadge(application)}<i class="card-open"><svg aria-hidden="true"><use href="#icon-chevron"/></svg></i></span>` : "";
    return `<article class="application-card${picked ? " picked" : ""}${state.flash.has(key) ? " just-moved" : ""}" data-card="${esc(key)}"><input class="card-pick" type="checkbox" data-pick="${esc(key)}"${picked ? " checked" : ""} aria-label="Select ${esc(application.title)} at ${esc(application.company)}"><button class="card-face" type="button" draggable="true" data-application-id="${esc(key)}" aria-label="Open ${esc(application.title)} at ${esc(application.company)}"><span class="card-company-row"><i class="company-mark" style="--mark-color:${markColor(application.company)}">${esc(initials(application.company))}</i><strong>${esc(application.company || "Unknown company")}</strong></span><h3>${esc(application.title || "Untitled role")}</h3><p class="card-location">${esc(application.location || "Location not set")}</p>${nextStep}${footer}</button></article>`;
  }
  function boardMarkup(applications) {
    if (state.statusView === "archive") return listMarkup(applications);
    return `<div class="board${state.picked.size ? " selecting" : ""}" aria-label="Active application pipeline">${ACTIVE_GROUPS.map(group => {
      const items = applications.filter(application => groupForStage(application.stage) === group.key);
      const shown = state.expanded[group.key] ? items : items.slice(0, COLUMN_CAP), hidden = items.length - shown.length;
      const body = items.length
        ? shown.map(applicationCard).join("") + (hidden ? `<button class="show-more" type="button" data-expand="${group.key}">Show ${hidden} more</button>` : "")
        : '<div class="empty-column">No applications here</div>';
      return `<section class="board-column" data-drop-group="${group.key}" style="--column-color:${group.color}"><header class="column-header"><span></span><h2>${group.label}</h2><b>${hidden ? `${shown.length} / ${items.length}` : items.length}</b></header><div class="column-stack">${body}</div></section>`;
    }).join("")}</div>`;
  }
  function listMarkup(applications) {
    return `<div class="application-list"><div class="list-head"><span>Application</span><span>Stage</span><span>Applied</span><span>Next action</span><span>Due</span><span></span></div>${applications.map(application => { const due = dueState(application.next_due_at); return `<button class="application-row" type="button" data-application-id="${esc(application.id)}"><span class="row-role"><i class="company-mark" style="--mark-color:${markColor(application.company)}">${esc(initials(application.company))}</i><div><strong>${esc(application.title || "Untitled role")}</strong><span>${esc(application.company || "Unknown company")}${application.location ? ` · ${esc(application.location)}` : ""}</span></div></span><span class="stage-pill archive-stage">${esc(applicationStageLabel(application))}</span><span class="row-date">${esc(application.submitted_at ? formatDay(application.submitted_at) : "Not applied")}</span><span class="row-next">${esc(application.next_action || "No next action")}</span><span class="${application.next_due_at ? `due-badge ${due.key}` : "row-date"}">${esc(application.next_due_at ? due.label : "—")}</span><svg class="row-chevron" aria-hidden="true"><use href="#icon-chevron"/></svg></button>`; }).join("")}</div>`;
  }
  function emptyMarkup() {
    const filtered = Boolean(state.query || state.quickFilter);
    return `<div class="empty-state"><i class="empty-icon"><svg aria-hidden="true"><use href="#${filtered ? "icon-search" : "icon-briefcase"}"/></svg></i><h2>${filtered ? "No matching applications" : state.statusView === "archive" ? "Your archive is empty" : "No applications yet"}</h2><p>${filtered ? "Try a broader search or clear the quick filter." : state.statusView === "archive" ? "Closed applications will appear here." : "Add an application to begin tracking it."}</p>${filtered ? '<button class="button" type="button" data-action="clear-filters">Clear filters</button>' : state.statusView === "active" ? '<button class="button primary" type="button" data-action="open-add">Add application</button>' : ""}</div>`;
  }
  // Each column is its own scrollport now, so replacing innerHTML would drop
  // every reader back to the top of every column on any state change.
  const columnOffsets = () => Object.fromEntries($$(".board-column").map(column => [column.dataset.dropGroup, column.querySelector(".column-stack")?.scrollTop || 0]));
  const restoreOffsets = offsets => $$(".board-column").forEach(column => {
    const stack = column.querySelector(".column-stack"), at = offsets[column.dataset.dropGroup];
    if (stack && at) stack.scrollTop = at;
  });
  function render() {
    const offsets = columnOffsets();
    const counts = applicationCounts(state.applications), visible = sortApplications(filterApplications(state.applications, state), state.sort);
    $("#active-count").textContent = counts.active; $("#archive-count").textContent = counts.archive;
    $("#active-tab").setAttribute("aria-selected", String(state.statusView === "active")); $("#archive-tab").setAttribute("aria-selected", String(state.statusView === "archive"));
    content.setAttribute("aria-labelledby", state.statusView === "active" ? "active-tab" : "archive-tab"); $(".display-switch").hidden = state.statusView === "archive";
    $$('[data-display]').forEach(button => button.setAttribute("aria-pressed", String(button.dataset.display === state.display)));
    content.innerHTML = visible.length ? (state.display === "board" ? boardMarkup(visible) : listMarkup(visible)) : emptyMarkup();
    restoreOffsets(offsets);
    paintSelection();
  }
  // Extends the selection from the last box you ticked to `key`, in the order
  // the cards are on screen -- the only order a reader can see.
  function pickRange(key) {
    const keys = $$("[data-pick]").map(input => input.dataset.pick);
    const from = keys.indexOf(state.lastPicked), to = keys.indexOf(key);
    if (from > -1 && to > -1) keys.slice(Math.min(from, to), Math.max(from, to) + 1).forEach(each => state.picked.add(each));
  }
  function paintSelection() {
    $$(".application-card").forEach(card => card.classList.toggle("picked", state.picked.has(card.dataset.card)));
    $$("[data-pick]").forEach(input => { input.checked = state.picked.has(input.dataset.pick); });
    $(".board")?.classList.toggle("selecting", state.picked.size > 0);
    $("#bulk-count").textContent = `${state.picked.size} selected`;
    $("#bulk-bar").classList.toggle("show", state.picked.size > 0);
  }
  // The card lands at the top of its new column under the default sort, but a
  // reader on another sort needs to be shown where it went.
  function revealMoved(group) {
    const stack = $(`[data-drop-group="${group}"] .column-stack`); if (!stack) return;
    const landed = stack.querySelector(".just-moved");
    stack.scrollTop = landed ? Math.max(0, landed.offsetTop - stack.offsetTop - 8) : 0;
  }
  function flashMoved(ids, group) {
    state.flash = new Set(ids.map(String));
    render();
    revealMoved(group);
    clearTimeout(flashMoved.timer);
    flashMoved.timer = setTimeout(() => { state.flash.clear(); render(); }, 2400);
  }
  function stageOptions(application) { return Object.entries(STAGE_LABELS).map(([value, label]) => `<option value="${value}" ${application.stage === value ? "selected" : ""}>${label}</option>`).join(""); }
  function closedReasonOptions(application) { return `<option value="" disabled ${application.closed_reason ? "" : "selected"}>Choose a reason</option>${Object.entries(CLOSED_REASON_LABELS).map(([value, label]) => `<option value="${value}" ${application.closed_reason === value ? "selected" : ""}>${label}</option>`).join("")}`; }
  function resumeOptions() { return (state.resumes || []).map(name => `<option value="${esc(name)}"></option>`).join(""); }
  function historyMarkup(events) {
    const stageEvents = events.filter(event => event.to_stage);
    if (!stageEvents.length) return '<div class="empty-column">No stage history yet</div>';
    return stageEvents.map(event => `<div class="editor-history-row"><time datetime="${esc(event.occurred_at || "")}">${esc(formatMoment(event.occurred_at))}</time><div><strong>${esc(STAGE_LABELS[event.to_stage] || event.to_stage)}</strong></div></div>`).join("");
  }
  function renderDrawer() {
    const application = selectedApplication(); if (!application) return;
    const locked = application.external ? "" : " disabled", source = safeHref(application.apply_url_snapshot), events = application.events || [];
    const closed = application.stage === "closed";
    drawerContent.innerHTML = `<form id="editor-form" class="drawer-form"><header class="drawer-head"><i class="company-mark" style="--mark-color:${markColor(application.company)}">${esc(initials(application.company))}</i><div class="drawer-title"><h2 id="drawer-title">${esc(application.title || "Untitled role")}</h2><p>${esc(application.company || "Unknown company")}${application.location ? ` · ${esc(application.location)}` : ""}</p></div><button class="icon-button" type="button" data-action="close-drawer" aria-label="Close application details"><svg aria-hidden="true"><use href="#icon-close"/></svg></button></header><div class="drawer-body"><div class="form-grid"><label>Company<input name="company" required value="${esc(application.company || "")}"${locked}></label><label>Role<input name="title" required value="${esc(application.title || "")}"${locked}></label><label>Stage<select name="stage">${stageOptions(application)}</select></label><label data-closed-reason ${closed ? "" : "hidden"}>Closed reason<select name="closed_reason" required${closed ? "" : " disabled"}>${closedReasonOptions(application)}</select></label><label>Date applied<input name="submitted_at" type="date" value="${esc(dateInputValue(application.submitted_at))}"></label><label>Location<input name="location" value="${esc(application.location || "")}" placeholder="Optional"${locked}></label><label>Resume sent<input name="resume_variant" list="resume-options" value="${esc(application.resume_variant || "")}" placeholder="Optional" autocomplete="off"><datalist id="resume-options">${resumeOptions()}</datalist></label><label class="full">Posting URL<input name="url" type="url" value="${esc(application.apply_url_snapshot || "")}"${locked}></label><label>Next action<input name="next_action" value="${esc(application.next_action || "")}" placeholder="Optional"></label><label>Next-action date<input name="next_due_at" type="date" value="${esc(dateInputValue(application.next_due_at))}"></label><label class="full">Notes<textarea name="note" rows="5" placeholder="Optional">${esc(application.note || "")}</textarea></label></div><section class="editor-history"><h3>History</h3><div class="editor-history-list">${historyMarkup(events)}</div></section></div><footer class="drawer-footer"><button class="button danger" type="button" data-action="delete">Delete</button><div>${source ? `<a class="button" href="${esc(source)}" target="_blank" rel="noopener noreferrer">Open posting <svg aria-hidden="true"><use href="#icon-external"/></svg></a>` : ""}${autoApplyEligible(application) ? '<button class="button primary" type="button" data-action="auto-apply">Apply via Greenhouse</button>' : ""}<button class="button" type="button" data-action="tailor-resume">Tailor resume</button><button class="button" type="button" data-action="close-drawer">Cancel</button><button class="button primary" type="submit">Save</button></div></footer></form>`;
  }
  async function loadResumeNames() {
    if (state.resumes) return;
    state.resumes = [];
    try { const payload = await root.OneShotAPI.resumes.list(); state.resumes = (payload?.resumes || []).map(resume => resume.name).filter(Boolean); } catch (_) { /* Suggestions are optional; the field is free text. */ }
  }
  // Build a resume target from this application and hand off to the studio,
  // which reads the #target= hash and preselects it. The server is idempotent,
  // so a second press reopens the same target instead of forking it.
  async function tailorResume(button) {
    const application = selectedApplication(); if (!application) return;
    button.disabled = true;
    try {
      const target = await root.OneShotAPI.resumes.targetFromApplication(application.id);
      location.assign(`/resume/#target=${encodeURIComponent(target.id)}`);
    } catch (error) {
      showToast(error.message || "Resume target could not be created.");
      button.disabled = false;
    }
  }
  // -- auto-apply -----------------------------------------------------
  // The server pairs every question on the Greenhouse form with a value from
  // the profile or the saved answer bank; the dialog shows that pairing so the
  // reader confirms exactly what will be typed. Nothing is sent until they do.
  const SOURCE_LABELS = Object.freeze({ profile: "From your profile", saved: "Saved answer", resume: "Rendered PDF", missing: "Required", skipped: "Optional" });
  function applyFieldMarkup(field) {
    const name = esc(field.name), label = esc(field.label), source = `<small class="apply-source">${esc(SOURCE_LABELS[field.source] || "")}</small>`;
    const requiredAttr = field.required ? " required" : "", wide = field.type === "textarea" || field.type === "multiselect" ? " full" : "";
    if (field.type === "file") {
      // The resume row is a picker over the account's resumes rather than a
      // fixed note, so the attached document is visible and changeable.
      const preview = state.applyPreview || {}, chosen = preview.resume?.id, options = preview.resumes || [];
      if (!options.length) return `<label class="full apply-missing">${label}${source}<input type="text" value="No resume yet — build one in the Resume studio first" disabled></label>`;
      return `<label class="full">${label}<small class="apply-source">Attached as a PDF</small><select name="__resume" required>${options.map(resume => `<option value="${esc(resume.id)}"${String(resume.id) === String(chosen) ? " selected" : ""}>${esc(resume.name || `Resume ${resume.id}`)}</option>`).join("")}</select></label>`;
    }
    if (field.type === "select") return `<label class="${wide.trim()}${field.source === "missing" ? " apply-missing" : ""}">${label}${source}<select name="${name}"${requiredAttr}><option value="">Choose…</option>${field.options.map(option => `<option value="${esc(option)}"${option === field.value ? " selected" : ""}>${esc(option)}</option>`).join("")}</select></label>`;
    if (field.type === "multiselect") { const chosen = new Set(field.value || []); return `<fieldset class="full apply-choices${field.source === "missing" ? " apply-missing" : ""}"><legend>${label}${source}</legend>${field.options.map(option => `<label><input type="checkbox" name="${name}" value="${esc(option)}"${chosen.has(option) ? " checked" : ""}>${esc(option)}</label>`).join("")}</fieldset>`; }
    if (field.type === "textarea") return `<label class="full${field.source === "missing" ? " apply-missing" : ""}">${label}${source}<textarea name="${name}" rows="4"${requiredAttr}>${esc(field.value || "")}</textarea></label>`;
    return `<label class="${wide.trim()}${field.source === "missing" ? " apply-missing" : ""}">${label}${source}<input name="${name}" value="${esc(field.value || "")}"${requiredAttr}></label>`;
  }
  function renderApplyDialog(preview) {
    state.applyPreview = preview;
    $("#apply-subtitle").textContent = `${preview.title || ""} · ${preview.company || ""}`;
    $("#apply-fields").innerHTML = preview.fields.map(applyFieldMarkup).join("");
    const status = $("#apply-status"); status.hidden = !preview.missing.length; status.classList.remove("error");
    status.textContent = preview.missing.length ? `${preview.missing.length} required question${preview.missing.length === 1 ? "" : "s"} still need an answer.` : "";
    $("#apply-submit").disabled = !preview.resume;
  }
  async function openAutoApply(button) {
    const application = selectedApplication(); if (!application) return;
    button.disabled = true;
    try {
      const preview = await root.OneShotAPI.applications.autoApplyPreview(application.id);
      renderApplyDialog(preview);
      if (!applyDialog.open) applyDialog.showModal();
    } catch (error) {
      showToast(error.message || "The Greenhouse form could not be read.");
    } finally { button.disabled = false; }
  }
  function collectApplyAnswers() {
    const answers = {}, multi = {};
    for (const [name, value] of new FormData(applyForm).entries()) {
      if (name === "__resume") continue;
      const field = (state.applyPreview?.fields || []).find(item => item.name === name);
      if (field?.type === "multiselect") { (multi[name] ||= []).push(String(value)); continue; }
      if (String(value).trim() !== "") answers[name] = String(value).trim();
    }
    return { ...answers, ...multi };
  }
  async function submitAutoApply() {
    const application = selectedApplication(), preview = state.applyPreview; if (!application || !preview) return;
    const submit = $("#apply-submit"), status = $("#apply-status");
    submit.disabled = true; status.hidden = false; status.classList.remove("error"); status.textContent = "Submitting through Greenhouse… this can take up to a minute.";
    try {
      const pickedResume = Number(new FormData(applyForm).get("__resume")) || preview.resume?.id || null;
      const outcome = await root.OneShotAPI.applications.autoApply(application.id, { answers: collectApplyAnswers(), confirm: true, resume_id: pickedResume });
      Object.assign(application, outcome?.application || { stage: "applied" });
      applyDialog.close(); closeDrawer();
      flashMoved([application.id], "applied");
      showToast(`Applied to ${application.company}.`);
    } catch (error) {
      status.classList.add("error"); status.textContent = error.message || "The submission failed.";
      showToast(error.message || "The submission failed.");
    } finally { submit.disabled = false; }
  }
  async function openApplication(id) {
    state.selectedId = id;
    try { const detail = await root.OneShotAPI.applications.get(id); state.applications = state.applications.map(item => String(item.id) === String(id) ? { ...item, ...detail } : item); } catch (_) { /* Keep the list record editable if history is unavailable. */ }
    renderDrawer(); if (!drawer.open) drawer.showModal(); history.replaceState(null, "", `#app=${encodeURIComponent(id)}`);
  }
  function closeDrawer() { if (drawer.open) drawer.close(); state.selectedId = null; history.replaceState(null, "", location.pathname + location.search); }
  // The move to Applied is not only a stage change: the server stamps
  // submitted_at and fills in a follow-up (next_action, next_due_at) when the
  // request left them out. Undo therefore has to restore those three fields
  // explicitly -- sending the stage alone leaves the follow-up it created
  // sitting on a Considering card that never had one.
  async function updateStage(application, stage) {
    const previous = application.stage; if (!stage || stage === previous) return;
    const before = {
      closed_reason: application.closed_reason || null,
      submitted_at: application.submitted_at || null,
      next_action: application.next_action || "",
      next_due_at: application.next_due_at || null,
    };
    const body = stageMutation(application, stage);
    const updated = await root.OneShotAPI.applications.update(application.id, body); Object.assign(application, body, updated || {}); render(); renderDrawer(); showToast(`Moved to ${STAGE_LABELS[stage]}.`, { label: "Undo", run: async () => { const undoBody = { ...stageMutation(application, previous, before.closed_reason), submitted_at: before.submitted_at, next_action: before.next_action, next_due_at: before.next_due_at }; const restored = await root.OneShotAPI.applications.update(application.id, undoBody); Object.assign(application, undoBody, restored || {}); render(); renderDrawer(); } });
  }
  // The tracker has no bulk endpoint, so this PATCHes each record six at a
  // time -- enough to keep a fifty-card move quick without opening fifty
  // sockets. The board moves first and rolls back only what the server refused.
  const inBatches = async (items, run) => {
    for (let cursor = 0; cursor < items.length; cursor += 6) {
      await Promise.all(items.slice(cursor, cursor + 6).map(run));
    }
  };
  async function moveMany(moving, stage) {
    if (!moving.length) return;
    const before = moving.map(application => ({
      application, stage: application.stage, stage_changed_at: application.stage_changed_at,
      closed_reason: application.closed_reason || null, submitted_at: application.submitted_at || null,
      next_action: application.next_action || "", next_due_at: application.next_due_at || null,
    }));
    // One instant per card, descending, so a batch keeps the order it had
    // rather than shuffling on a shared timestamp. The server's own value
    // replaces these as each response lands.
    const at = Date.now();
    moving.forEach((application, index) => { application.stage = stage; application.stage_changed_at = new Date(at - index).toISOString(); });
    state.picked.clear();
    flashMoved(moving.map(application => application.id), groupForStage(stage));
    const failed = [];
    await inBatches(moving, async application => {
      const body = stageMutation(application, stage);
      try { const updated = await root.OneShotAPI.applications.update(application.id, body); Object.assign(application, body, updated || {}); }
      catch (_) { failed.push(application); }
    });
    if (failed.length) {
      before.filter(entry => failed.includes(entry.application)).forEach(entry => Object.assign(entry.application, { stage: entry.stage, stage_changed_at: entry.stage_changed_at }));
      render();
      showToast(failed.length === moving.length ? "Nothing could be moved. Check your connection." : `${failed.length} of ${moving.length} could not be moved.`);
      return;
    }
    render();
    showToast(`Moved ${moving.length} application${moving.length === 1 ? "" : "s"} to ${STAGE_LABELS[stage]}.`, { label: "Undo", run: async () => {
      // Undo restores the timestamp with the stage: leave it and the card stays
      // pinned to the top of the column it just came back to.
      await inBatches(before, async entry => {
        const body = { ...stageMutation(entry.application, entry.stage, entry.closed_reason), submitted_at: entry.submitted_at, next_action: entry.next_action, next_due_at: entry.next_due_at };
        const restored = await root.OneShotAPI.applications.update(entry.application.id, body);
        Object.assign(entry.application, body, restored || {}, { stage_changed_at: entry.stage_changed_at });
      });
      state.flash.clear();
      render();
    } });
  }

  // Deleting is immediate and skips the confirm dialog by request, so the
  // toast carries the whole safety net. DELETE is permanent server-side -- there is no restore
  // endpoint -- so undo re-creates each record from the snapshot taken here and
  // replays its fields. The rows come back with new ids and without their event
  // history; everything the board shows is restored.
  const recreate = async snapshot => {
    const created = snapshot.external
      ? await root.OneShotAPI.applications.createExternal({
          company: snapshot.company || "", title: snapshot.title || "",
          url: snapshot.apply_url_snapshot || "", location: snapshot.location || "", note: snapshot.note || "",
        })
      : await root.OneShotAPI.jobs.addToApplications(snapshot.job_id, {
          id: snapshot.job_id, title: snapshot.title, company: snapshot.company,
          location: snapshot.location, apply_url: snapshot.apply_url_snapshot,
        });
    if (!created) return null;
    const body = {
      stage: snapshot.stage, closed_reason: snapshot.closed_reason || null,
      submitted_at: snapshot.submitted_at || null, next_action: snapshot.next_action || "",
      next_due_at: snapshot.next_due_at || null, note: snapshot.note || "",
      resume_variant: snapshot.resume_variant || "",
    };
    const updated = await root.OneShotAPI.applications.update(created.id, body).catch(() => null);
    return { ...created, ...body, ...(updated || {}) };
  };
  async function deleteMany(removing) {
    if (!removing.length) return;
    const snapshots = removing.map(application => ({ ...application }));
    const ids = new Set(removing.map(application => String(application.id)));
    const tracked = removing.some(application => !application.external);
    state.applications = state.applications.filter(application => !ids.has(String(application.id)));
    state.picked.clear();
    if (state.selectedId && ids.has(String(state.selectedId))) closeDrawer();
    render();
    const failed = [];
    await inBatches(removing, async application => {
      try { await root.OneShotAPI.applications.remove(application.id); }
      catch (_) { failed.push(application); }
    });
    if (failed.length) {
      // Put back the ones the server kept, so the board matches the server.
      state.applications = state.applications.concat(failed);
      render();
      showToast(failed.length === removing.length ? "Nothing could be deleted. Check your connection." : `${failed.length} of ${removing.length} could not be deleted.`);
      return;
    }
    if (tracked) await root.OneShotOpportunityCount.refresh().catch(() => {});
    showToast(`Deleted ${removing.length} application${removing.length === 1 ? "" : "s"}.`, { label: "Undo", run: async () => {
      const restored = [];
      await inBatches(snapshots, async snapshot => {
        const application = await recreate(snapshot).catch(() => null);
        if (application) restored.push(application);
      });
      state.applications = state.applications.concat(restored);
      if (tracked) await root.OneShotOpportunityCount.refresh().catch(() => {});
      render();
      if (restored.length < snapshots.length) showToast(`${restored.length} of ${snapshots.length} could be restored.`);
    } });
  }

  async function loadApplications() {
    content.innerHTML = '<div class="loading-state"><span></span><p>Loading applications…</p></div>';
    loadResumeNames();
    try { const payload = await withTimeout(root.OneShotAPI.applications.list()); state.applications = payload.applications; render(); const requested = new URLSearchParams(location.hash.replace(/^#/, "")).get("app"); if (requested && state.applications.some(item => String(item.id) === requested)) openApplication(requested); }
    catch (error) { content.innerHTML = `<div class="error-state"><h2>Applications could not load</h2><p>${esc(error.message || error)}</p><button class="button primary" type="button" data-action="retry">Try again</button></div>`; }
  }

  document.addEventListener("click", event => {
    const applicationTrigger = event.target.closest("[data-application-id]"); if (applicationTrigger) return openApplication(applicationTrigger.dataset.applicationId);
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "open-add") { addForm.reset(); return addDialog.showModal(); }
    if (action === "close-add") return addDialog.close();
    if (action === "close-drawer") return closeDrawer();
    if (action === "delete") { const application = selectedApplication(); return application ? deleteMany([application]) : undefined; }
    if (action === "clear-filters") { state.query = ""; state.quickFilter = ""; $("#application-search").value = ""; $$('[data-quick-filter]').forEach(button => button.setAttribute("aria-pressed", "false")); return render(); }
    if (action === "retry") return loadApplications();
    if (action === "tailor-resume") return tailorResume(event.target.closest("[data-action]"));
    if (action === "auto-apply") return openAutoApply(event.target.closest("[data-action]"));
    if (action === "close-apply") return applyDialog.close();
  });
  document.addEventListener("click", event => {
    const expand = event.target.closest("[data-expand]");
    if (expand) { state.expanded[expand.dataset.expand] = true; return render(); }
    const pick = event.target.closest("[data-pick]");
    if (pick) {
      const key = pick.dataset.pick;
      // Shift extends from the last box you ticked, in the order the cards are
      // on screen -- the only order a reader can see.
      if (event.shiftKey && state.lastPicked) pickRange(key);
      else if (pick.checked) state.picked.add(key);
      else state.picked.delete(key);
      state.lastPicked = key;
      return paintSelection();
    }
    const bulk = event.target.closest("[data-bulk]");
    if (bulk) {
      if (bulk.dataset.bulk === "clear") { state.picked.clear(); return paintSelection(); }
      const selected = state.applications.filter(application => state.picked.has(String(application.id)));
      // No confirmation by request; the toast's undo is the way back.
      if (bulk.dataset.bulk === "delete") return deleteMany(selected);
      const stage = $("#bulk-stage").value;
      return moveMany(selected.filter(application => application.stage !== stage), stage);
    }
    const status = event.target.closest("[data-status-view]"); if (status) { state.statusView = status.dataset.statusView; state.quickFilter = ""; state.picked.clear(); $$('[data-quick-filter]').forEach(button => button.setAttribute("aria-pressed", "false")); render(); }
    const filter = event.target.closest("[data-quick-filter]"); if (filter) { const clearing = state.quickFilter === filter.dataset.quickFilter; state.quickFilter = clearing ? "" : filter.dataset.quickFilter; $$('[data-quick-filter]').forEach(button => button.setAttribute("aria-pressed", String(!clearing && button === filter))); render(); }
    const display = event.target.closest("[data-display]"); if (display) { state.display = display.dataset.display; state.picked.clear(); render(); }
  });
  // Rendering on every keystroke rebuilt every card in the board. At a few
  // hundred applications that is the whole DOM per keypress.
  let searchTimer;
  document.addEventListener("input", event => {
    if (event.target.id !== "application-search") return;
    const value = event.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = value; render(); }, 120);
  });
  document.addEventListener("change", event => { if (event.target.id === "application-sort") { state.sort = event.target.value; render(); } if (event.target.name === "stage" && event.target.form?.id === "editor-form") { const reason = event.target.form.querySelector("[data-closed-reason]"), select = reason?.querySelector("select"), closed = event.target.value === "closed"; if (reason) reason.hidden = !closed; if (select) select.disabled = !closed; } });
  document.addEventListener("submit", async event => {
    if (event.target === applyForm) { event.preventDefault(); return submitAutoApply(); }
    if (event.target === addForm) { event.preventDefault(); const submit = addForm.querySelector('[type="submit"]'), data = new FormData(addForm); submit.disabled = true; try { const application = await root.OneShotAPI.applications.createExternal({ company: String(data.get("company") || "").trim(), title: String(data.get("title") || "").trim(), url: String(data.get("url") || "").trim(), location: String(data.get("location") || "").trim(), note: String(data.get("note") || "").trim() }); state.applications.unshift(application); addDialog.close(); render(); showToast("Application added."); openApplication(application.id); } catch (error) { showToast(error.message || "Application could not be added."); } finally { submit.disabled = false; } return; }
    if (event.target.id === "editor-form") { event.preventDefault(); const application = selectedApplication(), data = new FormData(event.target), stage = String(data.get("stage")), body = { ...stageMutation(application, stage, String(data.get("closed_reason") || "") || null), submitted_at: String(data.get("submitted_at") || "") || null, next_action: String(data.get("next_action") || "").trim(), next_due_at: String(data.get("next_due_at") || "") || null, note: String(data.get("note") || "").trim() }; body.resume_variant = String(data.get("resume_variant") || "").trim(); if (application.external) { body.company = String(data.get("company") || "").trim(); body.title = String(data.get("title") || "").trim(); body.location = String(data.get("location") || "").trim(); body.apply_url_snapshot = String(data.get("url") || "").trim(); } try { const updated = await root.OneShotAPI.applications.update(application.id, body); Object.assign(application, body, updated || {}); closeDrawer(); render(); showToast("Application updated."); } catch (error) { showToast(error.message || "Application could not be updated."); } return; }
  });
  // Arrow keys walk the checkboxes in on-screen order; Shift+arrow extends
  // the selection the same way Shift+click does.
  document.addEventListener("keydown", event => {
    if (!event.target.matches("[data-pick]") || !["ArrowDown", "ArrowUp"].includes(event.key)) return;
    const boxes = $$("[data-pick]"), next = boxes[boxes.indexOf(event.target) + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
    if (!event.shiftKey) return;
    if (!state.lastPicked || !state.picked.has(event.target.dataset.pick)) { state.picked.add(event.target.dataset.pick); state.lastPicked = event.target.dataset.pick; }
    pickRange(next.dataset.pick);
    paintSelection();
  });
  document.addEventListener("keydown", event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); $("#application-search").focus(); } if (event.key === "Escape" && state.picked.size && !drawer.open && !addDialog.open) { event.preventDefault(); state.picked.clear(); paintSelection(); } if (event.target.matches('[role="tab"]') && ["ArrowLeft", "ArrowRight"].includes(event.key)) { const tabs = [...event.target.parentElement.querySelectorAll('[role="tab"]')], at = tabs.indexOf(event.target), next = tabs[(at + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length]; next.focus(); next.click(); } });
  // Columns scroll on their own now, so a drag has to be able to scroll them:
  // without this every card past a column's fold is an unreachable target.
  const dragScroll = { stack: null, dy: 0, dx: 0, frame: null };
  const edgeSpeed = (position, min, max, zone) => position < min + zone ? -Math.ceil((min + zone - position) / 4)
    : position > max - zone ? Math.ceil((position - (max - zone)) / 4) : 0;
  const stepScroll = () => {
    if (!dragScroll.dy && !dragScroll.dx) { dragScroll.frame = null; return; }
    if (dragScroll.stack) dragScroll.stack.scrollTop += dragScroll.dy;
    const board = $(".board"); if (board && dragScroll.dx) board.scrollLeft += dragScroll.dx;
    dragScroll.frame = requestAnimationFrame(stepScroll);
  };
  const endDrag = () => {
    dragScroll.stack = null; dragScroll.dy = 0; dragScroll.dx = 0;
    if (dragScroll.frame) { cancelAnimationFrame(dragScroll.frame); dragScroll.frame = null; }
    $$(".dragging").forEach(card => card.classList.remove("dragging"));
    $$(".drag-over").forEach(column => column.classList.remove("drag-over"));
    state.dragId = null;
  };
  // Dragging one card of a selection drags the selection.
  const draggedKeys = () => state.picked.has(String(state.dragId)) ? [...state.picked] : [String(state.dragId)];
  document.addEventListener("dragstart", event => {
    const face = event.target.closest("[data-application-id]");
    if (!face || !face.closest(".application-card")) return;
    state.dragId = face.dataset.applicationId;
    draggedKeys().forEach(key => $(`[data-card="${key}"]`)?.classList.add("dragging"));
    event.dataTransfer.effectAllowed = "move";
  });
  document.addEventListener("dragend", endDrag);
  document.addEventListener("dragover", event => {
    const column = event.target.closest("[data-drop-group]"); if (!column || !state.dragId) return;
    event.preventDefault();
    $$(".drag-over").forEach(each => { if (each !== column) each.classList.remove("drag-over"); });
    column.classList.add("drag-over");
    const stack = column.querySelector(".column-stack"), board = $(".board");
    const box = stack.getBoundingClientRect(), rail = board.getBoundingClientRect();
    dragScroll.stack = stack;
    dragScroll.dy = edgeSpeed(event.clientY, box.top, box.bottom, 64);
    dragScroll.dx = board.scrollWidth > board.clientWidth ? edgeSpeed(event.clientX, rail.left, rail.right, 90) : 0;
    if (!dragScroll.frame && (dragScroll.dy || dragScroll.dx)) dragScroll.frame = requestAnimationFrame(stepScroll);
  });
  document.addEventListener("dragleave", event => {
    const column = event.target.closest("[data-drop-group]");
    if (column && !column.contains(event.relatedTarget)) { column.classList.remove("drag-over"); dragScroll.dy = 0; dragScroll.dx = 0; }
  });
  document.addEventListener("drop", async event => {
    const column = event.target.closest("[data-drop-group]"); if (!column || !state.dragId) return;
    event.preventDefault();
    const group = ACTIVE_GROUPS.find(item => item.key === column.dataset.dropGroup), keys = draggedKeys();
    endDrag();
    if (!group) return;
    const moving = state.applications.filter(item => keys.includes(String(item.id)) && item.stage !== group.stages[0]);
    try { await moveMany(moving, group.stages[0]); }
    catch (error) { showToast(error.message || "Application could not be moved."); render(); }
  });
  [drawer, addDialog].forEach(dialog => dialog.addEventListener("click", event => { if (event.target !== dialog) return; if (dialog === drawer) closeDrawer(); else dialog.close(); }));
  drawer.addEventListener("close", () => { if (state.selectedId) { state.selectedId = null; history.replaceState(null, "", location.pathname + location.search); } });
  loadApplications();
})(typeof window !== "undefined" ? window : globalThis);

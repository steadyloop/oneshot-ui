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

  const safeDate = value => {
    if (!value) return null;
    const raw = String(value), normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59` : raw;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const dueState = (value, now = new Date()) => {
    const date = safeDate(value);
    if (!date) return { key: "none", label: "No due date", rank: Number.MAX_SAFE_INTEGER };
    const difference = date - now, days = Math.max(1, Math.ceil(Math.abs(difference) / 86400000));
    if (difference < 0) return { key: "overdue", label: `${days}d overdue`, rank: date.getTime() };
    if (difference <= 86400000) return { key: "soon", label: "Due today", rank: date.getTime() };
    if (difference <= 172800000) return { key: "soon", label: "Due tomorrow", rank: date.getTime() };
    return { key: difference <= 604800000 ? "upcoming" : "none", label: `Due in ${Math.ceil(difference / 86400000)}d`, rank: date.getTime() };
  };
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
  const sortApplications = (applications, sort = "next_due") => [...applications].sort((a, b) => {
    if (sort === "company") return String(a.company || "").localeCompare(String(b.company || ""));
    if (sort === "applied") return String(b.submitted_at || "").localeCompare(String(a.submitted_at || ""));
    if (sort === "updated") return String(b.updated_at || b.events?.[0]?.occurred_at || "").localeCompare(String(a.updated_at || a.events?.[0]?.occurred_at || ""));
    return dueState(a.next_due_at).rank - dueState(b.next_due_at).rank;
  });
  const withTimeout = (promise, milliseconds = 8000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The applications request timed out.")), milliseconds);
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });

  const exported = { ACTIVE_GROUPS, STAGE_LABELS, CLOSED_REASON_LABELS, dueState, groupForStage, applicationStageLabel, applicationCounts, filterApplications, sortApplications, withTimeout };
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  if (!root.document) return;

  const $ = selector => document.querySelector(selector), $$ = selector => [...document.querySelectorAll(selector)];
  const content = $("#application-content"), drawer = $("#application-drawer"), drawerContent = $("#drawer-content"), addDialog = $("#add-dialog"), addForm = $("#add-form"), deleteDialog = $("#delete-dialog"), toast = $("#toast");
  const state = { applications: [], resumes: null, query: "", quickFilter: "", statusView: "active", display: "board", sort: "next_due", selectedId: null, dragId: null };
  const esc = value => String(value == null ? "" : value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const safeHref = value => /^https?:\/\//i.test(String(value || "")) ? String(value) : "";
  const initials = value => String(value || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase();
  const markColor = value => { const colors = ["#244a3a", "#3e5e82", "#74533e", "#5f4a78", "#47636a", "#7a4c55"], sum = [...String(value || "")].reduce((total, character) => total + character.charCodeAt(0), 0); return colors[sum % colors.length]; };
  const formatDate = value => { const date = safeDate(value); return date ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date) : "Not set"; };
  const dateInputValue = value => String(value || "").match(/^\d{4}-\d{2}-\d{2}/)?.[0] || "";
  const stageMutation = (application, stage, closedReason = null) => {
    const body = { stage, closed_reason: stage === "closed" ? closedReason : null };
    if (stage === "applied" && application.stage !== "applied") {
      body.submitted_at = application.submitted_at || new Date().toISOString().slice(0, 10);
    }
    return body;
  };
  const selectedApplication = () => state.applications.find(application => String(application.id) === String(state.selectedId));
  const showToast = (message, action) => { toast.replaceChildren(); const copy = document.createElement("span"); copy.textContent = message; toast.append(copy); if (action) { const button = document.createElement("button"); button.type = "button"; button.textContent = action.label; button.addEventListener("click", async () => { toast.classList.remove("show"); try { await action.run(); } catch (error) { showToast(error.message || "That could not be undone."); } }, { once: true }); toast.append(button); } toast.classList.add("show"); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove("show"), action ? 6500 : 3400); };

  function dueBadge(application) { if (!application.next_due_at) return ""; const due = dueState(application.next_due_at); return `<span class="due-badge ${due.key}"><svg aria-hidden="true"><use href="#icon-calendar"/></svg>${esc(due.label)}</span>`; }
  function applicationCard(application) {
    return `<button class="application-card" type="button" draggable="true" data-application-id="${esc(application.id)}" aria-label="Open ${esc(application.title)} at ${esc(application.company)}"><span class="card-company-row"><i class="company-mark" style="--mark-color:${markColor(application.company)}">${esc(initials(application.company))}</i><strong>${esc(application.company || "Unknown company")}</strong></span><h3>${esc(application.title || "Untitled role")}</h3><p class="card-location">${esc(application.location || "Location not set")}</p><span class="next-step"><span>Next action</span><p>${esc(application.next_action || "No next action")}</p></span><span class="card-footer">${dueBadge(application)}<i class="card-open"><svg aria-hidden="true"><use href="#icon-chevron"/></svg></i></span></button>`;
  }
  function boardMarkup(applications) {
    if (state.statusView === "archive") return listMarkup(applications);
    return `<div class="board" aria-label="Active application pipeline">${ACTIVE_GROUPS.map(group => { const items = applications.filter(application => groupForStage(application.stage) === group.key); return `<section class="board-column" data-drop-group="${group.key}" style="--column-color:${group.color}"><header class="column-header"><span></span><h2>${group.label}</h2><b>${items.length}</b></header><div class="column-stack">${items.length ? items.map(applicationCard).join("") : '<div class="empty-column">No applications here</div>'}</div></section>`; }).join("")}</div>`;
  }
  function listMarkup(applications) {
    return `<div class="application-list"><div class="list-head"><span>Application</span><span>Stage</span><span>Applied</span><span>Next action</span><span>Due</span><span></span></div>${applications.map(application => { const due = dueState(application.next_due_at); return `<button class="application-row" type="button" data-application-id="${esc(application.id)}"><span class="row-role"><i class="company-mark" style="--mark-color:${markColor(application.company)}">${esc(initials(application.company))}</i><div><strong>${esc(application.title || "Untitled role")}</strong><span>${esc(application.company || "Unknown company")}${application.location ? ` · ${esc(application.location)}` : ""}</span></div></span><span class="stage-pill archive-stage">${esc(applicationStageLabel(application))}</span><span class="row-date">${esc(application.submitted_at ? formatDate(application.submitted_at) : "Not applied")}</span><span class="row-next">${esc(application.next_action || "No next action")}</span><span class="${application.next_due_at ? `due-badge ${due.key}` : "row-date"}">${esc(application.next_due_at ? due.label : "—")}</span><svg class="row-chevron" aria-hidden="true"><use href="#icon-chevron"/></svg></button>`; }).join("")}</div>`;
  }
  function emptyMarkup() {
    const filtered = Boolean(state.query || state.quickFilter);
    return `<div class="empty-state"><i class="empty-icon"><svg aria-hidden="true"><use href="#${filtered ? "icon-search" : "icon-briefcase"}"/></svg></i><h2>${filtered ? "No matching applications" : state.statusView === "archive" ? "Your archive is empty" : "No applications yet"}</h2><p>${filtered ? "Try a broader search or clear the quick filter." : state.statusView === "archive" ? "Closed applications will appear here." : "Add an application to begin tracking it."}</p>${filtered ? '<button class="button" type="button" data-action="clear-filters">Clear filters</button>' : state.statusView === "active" ? '<button class="button primary" type="button" data-action="open-add">Add application</button>' : ""}</div>`;
  }
  function render() {
    const counts = applicationCounts(state.applications), visible = sortApplications(filterApplications(state.applications, state), state.sort);
    $("#active-count").textContent = counts.active; $("#archive-count").textContent = counts.archive;
    $("#active-tab").setAttribute("aria-selected", String(state.statusView === "active")); $("#archive-tab").setAttribute("aria-selected", String(state.statusView === "archive"));
    content.setAttribute("aria-labelledby", state.statusView === "active" ? "active-tab" : "archive-tab"); $(".display-switch").hidden = state.statusView === "archive";
    $$('[data-display]').forEach(button => button.setAttribute("aria-pressed", String(button.dataset.display === state.display)));
    content.innerHTML = visible.length ? (state.display === "board" ? boardMarkup(visible) : listMarkup(visible)) : emptyMarkup();
  }
  function stageOptions(application) { return Object.entries(STAGE_LABELS).map(([value, label]) => `<option value="${value}" ${application.stage === value ? "selected" : ""}>${label}</option>`).join(""); }
  function closedReasonOptions(application) { return `<option value="" disabled ${application.closed_reason ? "" : "selected"}>Choose a reason</option>${Object.entries(CLOSED_REASON_LABELS).map(([value, label]) => `<option value="${value}" ${application.closed_reason === value ? "selected" : ""}>${label}</option>`).join("")}`; }
  function resumeOptions() { return (state.resumes || []).map(name => `<option value="${esc(name)}"></option>`).join(""); }
  function historyMarkup(events) {
    const stageEvents = events.filter(event => event.to_stage);
    if (!stageEvents.length) return '<div class="empty-column">No stage history yet</div>';
    return stageEvents.map(event => `<div class="editor-history-row"><time datetime="${esc(event.occurred_at || "")}">${esc(formatDate(event.occurred_at))}</time><div><strong>${esc(STAGE_LABELS[event.to_stage] || event.to_stage)}</strong></div></div>`).join("");
  }
  function renderDrawer() {
    const application = selectedApplication(); if (!application) return;
    const locked = application.external ? "" : " disabled", source = safeHref(application.apply_url_snapshot), events = application.events || [];
    const closed = application.stage === "closed";
    drawerContent.innerHTML = `<form id="editor-form" class="drawer-form"><header class="drawer-head"><i class="company-mark" style="--mark-color:${markColor(application.company)}">${esc(initials(application.company))}</i><div class="drawer-title"><h2 id="drawer-title">${esc(application.title || "Untitled role")}</h2><p>${esc(application.company || "Unknown company")}${application.location ? ` · ${esc(application.location)}` : ""}</p></div><button class="icon-button" type="button" data-action="close-drawer" aria-label="Close application details"><svg aria-hidden="true"><use href="#icon-close"/></svg></button></header><div class="drawer-body"><div class="form-grid"><label>Company<input name="company" required value="${esc(application.company || "")}"${locked}></label><label>Role<input name="title" required value="${esc(application.title || "")}"${locked}></label><label>Stage<select name="stage">${stageOptions(application)}</select></label><label data-closed-reason ${closed ? "" : "hidden"}>Closed reason<select name="closed_reason" required${closed ? "" : " disabled"}>${closedReasonOptions(application)}</select></label><label>Date applied<input name="submitted_at" type="date" value="${esc(dateInputValue(application.submitted_at))}"></label><label>Location<input name="location" value="${esc(application.location || "")}" placeholder="Optional"${locked}></label><label>Resume sent<input name="resume_variant" list="resume-options" value="${esc(application.resume_variant || "")}" placeholder="Optional" autocomplete="off"><datalist id="resume-options">${resumeOptions()}</datalist></label><label class="full">Posting URL<input name="url" type="url" value="${esc(application.apply_url_snapshot || "")}"${locked}></label><label>Next action<input name="next_action" value="${esc(application.next_action || "")}" placeholder="Optional"></label><label>Next-action date<input name="next_due_at" type="date" value="${esc(dateInputValue(application.next_due_at))}"></label><label class="full">Notes<textarea name="note" rows="5" placeholder="Optional">${esc(application.note || "")}</textarea></label></div><section class="editor-history"><h3>History</h3><div class="editor-history-list">${historyMarkup(events)}</div></section></div><footer class="drawer-footer"><button class="button danger" type="button" data-action="open-delete">Delete</button><div>${source ? `<a class="button" href="${esc(source)}" target="_blank" rel="noopener noreferrer">Open posting <svg aria-hidden="true"><use href="#icon-external"/></svg></a>` : ""}<button class="button" type="button" data-action="tailor-resume">Tailor resume</button><button class="button" type="button" data-action="close-drawer">Cancel</button><button class="button primary" type="submit">Save</button></div></footer></form>`;
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
  async function openApplication(id) {
    state.selectedId = id;
    try { const detail = await root.OneShotAPI.applications.get(id); state.applications = state.applications.map(item => String(item.id) === String(id) ? { ...item, ...detail } : item); } catch (_) { /* Keep the list record editable if history is unavailable. */ }
    renderDrawer(); if (!drawer.open) drawer.showModal(); history.replaceState(null, "", `#app=${encodeURIComponent(id)}`);
  }
  function closeDrawer() { if (drawer.open) drawer.close(); state.selectedId = null; history.replaceState(null, "", location.pathname + location.search); }
  async function updateStage(application, stage) {
    const previous = application.stage; if (!stage || stage === previous) return;
    const previousReason = application.closed_reason || null, body = stageMutation(application, stage);
    const updated = await root.OneShotAPI.applications.update(application.id, body); Object.assign(application, body, updated || {}); render(); renderDrawer(); showToast(`Moved to ${STAGE_LABELS[stage]}.`, { label: "Undo", run: async () => { const undoBody = stageMutation(application, previous, previousReason); const restored = await root.OneShotAPI.applications.update(application.id, undoBody); Object.assign(application, undoBody, restored || {}); render(); renderDrawer(); } });
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
    if (action === "open-delete") return deleteDialog.showModal();
    if (action === "close-delete") return deleteDialog.close();
    if (action === "clear-filters") { state.query = ""; state.quickFilter = ""; $("#application-search").value = ""; $$('[data-quick-filter]').forEach(button => button.setAttribute("aria-pressed", "false")); return render(); }
    if (action === "retry") return loadApplications();
    if (action === "tailor-resume") return tailorResume(event.target.closest("[data-action]"));
  });
  document.addEventListener("click", event => {
    const status = event.target.closest("[data-status-view]"); if (status) { state.statusView = status.dataset.statusView; state.quickFilter = ""; $$('[data-quick-filter]').forEach(button => button.setAttribute("aria-pressed", "false")); render(); }
    const filter = event.target.closest("[data-quick-filter]"); if (filter) { const clearing = state.quickFilter === filter.dataset.quickFilter; state.quickFilter = clearing ? "" : filter.dataset.quickFilter; $$('[data-quick-filter]').forEach(button => button.setAttribute("aria-pressed", String(!clearing && button === filter))); render(); }
    const display = event.target.closest("[data-display]"); if (display) { state.display = display.dataset.display; render(); }
  });
  document.addEventListener("input", event => { if (event.target.id === "application-search") { state.query = event.target.value; render(); } });
  document.addEventListener("change", event => { if (event.target.id === "application-sort") { state.sort = event.target.value; render(); } if (event.target.name === "stage" && event.target.form?.id === "editor-form") { const reason = event.target.form.querySelector("[data-closed-reason]"), select = reason?.querySelector("select"), closed = event.target.value === "closed"; if (reason) reason.hidden = !closed; if (select) select.disabled = !closed; } });
  document.addEventListener("submit", async event => {
    if (event.target === addForm) { event.preventDefault(); const submit = addForm.querySelector('[type="submit"]'), data = new FormData(addForm); submit.disabled = true; try { const application = await root.OneShotAPI.applications.createExternal({ company: String(data.get("company") || "").trim(), title: String(data.get("title") || "").trim(), url: String(data.get("url") || "").trim(), location: String(data.get("location") || "").trim(), note: String(data.get("note") || "").trim() }); state.applications.unshift(application); addDialog.close(); render(); showToast("Application added."); openApplication(application.id); } catch (error) { showToast(error.message || "Application could not be added."); } finally { submit.disabled = false; } return; }
    if (event.target.id === "editor-form") { event.preventDefault(); const application = selectedApplication(), data = new FormData(event.target), stage = String(data.get("stage")), body = { ...stageMutation(application, stage, String(data.get("closed_reason") || "") || null), submitted_at: String(data.get("submitted_at") || "") || null, next_action: String(data.get("next_action") || "").trim(), next_due_at: String(data.get("next_due_at") || "") || null, note: String(data.get("note") || "").trim() }; body.resume_variant = String(data.get("resume_variant") || "").trim(); if (application.external) { body.company = String(data.get("company") || "").trim(); body.title = String(data.get("title") || "").trim(); body.location = String(data.get("location") || "").trim(); body.apply_url_snapshot = String(data.get("url") || "").trim(); } try { const updated = await root.OneShotAPI.applications.update(application.id, body); Object.assign(application, body, updated || {}); closeDrawer(); render(); showToast("Application updated."); } catch (error) { showToast(error.message || "Application could not be updated."); } return; }
    if (event.target.id === "delete-form") { event.preventDefault(); const application = selectedApplication(); if (!application) return deleteDialog.close(); try { await root.OneShotAPI.applications.remove(application.id); state.applications = state.applications.filter(item => item.id !== application.id); if (!application.external) await root.OneShotOpportunityCount.refresh(); deleteDialog.close(); closeDrawer(); render(); showToast("Application deleted."); } catch (error) { showToast(error.message || "Application could not be deleted."); } }
  });
  document.addEventListener("keydown", event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); $("#application-search").focus(); } if (event.target.matches('[role="tab"]') && ["ArrowLeft", "ArrowRight"].includes(event.key)) { const tabs = [...event.target.parentElement.querySelectorAll('[role="tab"]')], at = tabs.indexOf(event.target), next = tabs[(at + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length]; next.focus(); next.click(); } });
  document.addEventListener("dragstart", event => { const card = event.target.closest("[data-application-id]"); if (!card) return; state.dragId = card.dataset.applicationId; card.classList.add("dragging"); event.dataTransfer.effectAllowed = "move"; });
  document.addEventListener("dragend", event => { event.target.closest("[data-application-id]")?.classList.remove("dragging"); $$(".drag-over").forEach(column => column.classList.remove("drag-over")); state.dragId = null; });
  document.addEventListener("dragover", event => { const column = event.target.closest("[data-drop-group]"); if (column && state.dragId) { event.preventDefault(); column.classList.add("drag-over"); } });
  document.addEventListener("dragleave", event => { const column = event.target.closest("[data-drop-group]"); if (column && !column.contains(event.relatedTarget)) column.classList.remove("drag-over"); });
  document.addEventListener("drop", async event => { const column = event.target.closest("[data-drop-group]"); if (!column || !state.dragId) return; event.preventDefault(); column.classList.remove("drag-over"); const application = state.applications.find(item => String(item.id) === String(state.dragId)), group = ACTIVE_GROUPS.find(item => item.key === column.dataset.dropGroup); if (!application || !group) return; try { await updateStage(application, group.stages[0]); } catch (error) { showToast(error.message || "Application could not be moved."); render(); } });
  [drawer, addDialog, deleteDialog].forEach(dialog => dialog.addEventListener("click", event => { if (event.target !== dialog) return; if (dialog === drawer) closeDrawer(); else dialog.close(); }));
  drawer.addEventListener("close", () => { if (state.selectedId) { state.selectedId = null; history.replaceState(null, "", location.pathname + location.search); } });
  loadApplications();
})(typeof window !== "undefined" ? window : globalThis);

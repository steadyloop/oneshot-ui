// Applied on desktop: the In progress board beside its agenda, the Submitted
// and Closed tables, the details drawer and the dialogs in index.html.
import { api } from "../shared/api.js";
import { startAccount } from "../shared/account.js";
import { guest } from "../shared/guest.js";
import { companyLogoContent, startCompanyLogoFallbacks } from "../shared/company-logo.js";
import { $, $$, esc, localDay as today } from "../shared/util.js";
import {
  LABELS, OPEN, PLACEHOLDERS, REASONS, STAGES, age, agendaIdentity, agendaWeek, closeAs, closeNoReply, completeTask, counts,
  detailFields, dueDays, dueLabel, editDetails, externalPayload, formatDay, fromAPI, fromList, hasChanges, inPipeline,
  initialFilters, moveTo, openTasks, paginate, replaceApp, respond, restore, resumeLink, safeUrl, createApplicationActions,
  taskGroup, validDay, viewFor, visibleApplications, waitLabel, waitingOnCompany, zoneName,
} from "./core.js";

const state = {
  applications: [], loading: true, error: "", busy: false, view: "pipeline", filters: initialFilters(), page: 1,
  selected: new Set(), selectedId: null, responseId: null, completionId: null, closureId: null,
  agendaWeek: 0, agendaOverdueOpen: false, dragId: null,
};
const currentFilters = () => state.filters[state.view];
const byId = id => state.applications.find(app => app.id === id);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const PALETTES = [["#eaf0eb", "#4d6f56"], ["#eeeaf2", "#6c5c7d"], ["#eaf0f3", "#526c7a"], ["#f2ece6", "#8a6e52"], ["#f1e9e7", "#8a625c"]];
startCompanyLogoFallbacks();
function companyMark(app) {
  const company = app.company;
  const [bg, color] = PALETTES[[...company].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % PALETTES.length];
  const initial = company.trim().charAt(0).toUpperCase() || "?";
  return `<i class="company-mark company-logo-tile" aria-hidden="true" style="--mark-bg:${bg};--mark-color:${color}">${companyLogoContent(app, initial)}</i>`;
}

async function loadApplications() {
  if (state.busy || $$("dialog").some(dialog => dialog.open)) return;
  setBusy(true);
  try {
    state.applications = fromList(await api.applications.list());
    state.error = "";
  } catch (error) { state.error = error.message || "Could not load applications."; }
  setBusy(false);
  state.loading = false;
  state.selected.clear();
  render();
}
function setBusy(value) {
  state.busy = value;
  $("#workspace").setAttribute("aria-busy", String(value));
  $$("button, .agenda input[type=checkbox]").forEach(button => {
    if (value) {
      button.dataset.wasDisabled = String(button.disabled);
      button.disabled = true;
    } else if (button.dataset.wasDisabled !== undefined) {
      button.disabled = button.dataset.wasDisabled === "true";
      delete button.dataset.wasDisabled;
    }
  });
}

/* ───────────── Render ───────────── */
function renderHeader() {
  const total = counts(state.applications);
  for (const view of ["pipeline", "sent", "closed"]) $(`#count-${view}`).textContent = total[view];
  $$("[data-view]").forEach(button => {
    const selected = button.dataset.view === state.view;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  $("#panel").setAttribute("aria-labelledby", `tab-${state.view}`);
  $("#workspace").classList.toggle("records-view", state.view !== "pipeline");
  $("#records-toolbar").hidden = state.view === "pipeline";
  $("#sort-control").hidden = state.view === "pipeline";
  $("#outcome-control").hidden = state.view !== "closed";
  $("#age-filter").value = state.filters.sent.age;
  $("#outcome-filter").value = state.filters.closed.outcome;
  $("#sort").value = currentFilters().sort;
  $("#search").placeholder = PLACEHOLDERS[state.view];
}

function deadlineMarkup(app) {
  if (waitingOnCompany(app)) return '<span class="card-deadline">Waiting</span>';
  const days = dueDays(app), urgency = days < 0 ? "overdue" : days === 0 ? "today" : "";
  const title = validDay(app.nextDue) ? ` title="${esc(formatDay(app.nextDue, true))}"` : "";
  return `<span class="card-deadline ${urgency}"${title}>${esc(dueLabel(app))}</span>`;
}
function cardMarkup(app) {
  const waiting = waitingOnCompany(app), id = esc(app.id);
  const task = waiting ? app.waitingFor || "Waiting on company" : app.nextAction || "Set a next step";
  return `<button class="card card-open ${taskGroup(app)}" type="button" draggable="true" data-open="${id}" data-drag="${id}" aria-label="${esc(`${app.company}, ${app.role}, ${task}`)}">
    <span class="card-identity" title="${esc(`${app.company} · ${app.role}`)}"><strong>${esc(app.company)}</strong> · ${esc(app.role)}</span>
    <span class="card-drag" aria-hidden="true">${icon("drag")}</span>
    <span class="card-task${waiting ? " waiting" : ""}">${esc(task)}</span>${deadlineMarkup(app)}
  </button>`;
}
function boardMarkup(apps) {
  return `<div class="board">${OPEN.map(stage => {
    const items = apps.filter(app => app.stage === stage);
    return `<section class="column" data-drop="${stage}" aria-label="${LABELS[stage]}">
      <header class="column-head"><h2>${LABELS[stage]}</h2><span class="count">${items.length}</span></header>
      <div class="column-stack">${items.map(cardMarkup).join("")}</div>
    </section>`;
  }).join("")}</div>`;
}

function agendaRow(app, identity) {
  const days = dueDays(app), id = esc(app.id);
  return `<div class="agenda-row ${days < 0 ? "overdue" : days === 0 ? "today" : "later"}" data-agenda-app="${id}">
    <label class="agenda-check"><input class="complete-task" type="checkbox" data-agenda-complete="${id}" aria-label="Complete task: ${esc(app.nextAction)} at ${esc(app.company)}" title="Complete task" ${state.busy ? "disabled" : ""}></label>
    <button class="agenda-open" type="button" data-agenda-open="${id}" aria-label="${esc(`${app.nextAction}, ${app.company}, ${app.role}, ${formatDay(app.nextDue, true)}`)}">
      <span class="agenda-title" title="${esc(app.nextAction)}">${esc(app.nextAction)}</span>
      <span class="agenda-identity" title="${esc(`${app.company} · ${app.role}`)}">${esc(identity(app))}</span>
      ${days < 0 ? `<span class="agenda-time overdue">${-days}d overdue</span>` : ""}
    </button>
  </div>`;
}
function agendaMarkup() {
  const query = state.filters.pipeline.query;
  const week = agendaWeek(state.applications, state.agendaWeek, query);
  const identity = agendaIdentity(openTasks(state.applications));
  const rows = apps => apps.map(app => agendaRow(app, identity)).join("");
  const overdue = week.overdue.length > 1
    ? `<details class="agenda-fold" data-agenda-overdue ${state.agendaOverdueOpen ? "open" : ""}><summary>${week.overdue.length} overdue</summary>${rows(week.overdue)}</details>`
    : rows(week.overdue);
  const schedule = week.days.map(({ day, isToday, label, items }) => {
    const title = isToday ? `Today · ${label}` : label;
    return `<section class="agenda-group" aria-label="${esc(title)}" data-agenda-day="${day}"><h3>${esc(title)}</h3>${isToday ? overdue : ""}${rows(items)}</section>`;
  }).join("");
  const clear = schedule ? "" : `<p class="agenda-clear">${query.trim() ? "No matching items this week." : "Nothing scheduled this week."}</p>`;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const span = `${formatDay(week.first, true)} – ${formatDay(week.last, true)}. ${zone}`;
  return `<aside class="agenda" aria-label="Agenda">
    <header class="agenda-head"><h2>Agenda</h2><div class="agenda-week">
      <button type="button" data-agenda-week="-1" aria-label="Previous week">‹</button>
      <time datetime="${week.first}" title="${esc(span)}">${esc(week.range)} · ${esc(zoneName() || zone)}</time>
      <button type="button" data-agenda-week="1" aria-label="Next week">›</button>
    </div></header>
    <div class="agenda-scroll">${schedule}${clear}</div>
  </aside>`;
}

function recordsCompanyMark(app) {
  return `<span class="records-company-mark company-logo-tile" aria-hidden="true">${companyLogoContent(app)}</span>`;
}
function tableRow(app, sent) {
  const id = esc(app.id), identity = esc(`${app.company}, ${app.role}`), selected = state.selected.has(app.id), days = age(app);
  const date = validDay(app.submittedAt) ? ` datetime="${esc(app.submittedAt)}" title="${esc(formatDay(app.submittedAt, true))}"` : "";
  return `<tr data-row-open="${id}"${selected ? ' class="selected"' : ""}>
    ${sent ? `<td class="check-cell"><input type="checkbox" data-select="${id}" aria-label="Select ${identity}" ${selected ? "checked" : ""}></td>` : ""}
    <td class="company-cell"><span class="company-row">${recordsCompanyMark(app)}<button class="text-button records-company-name" type="button" data-open="${id}" title="${esc(app.company)}">${esc(app.company)}</button></span></td>
    <td class="role-cell"><button class="text-button role-title" type="button" data-open="${id}" aria-label="Open ${identity}" title="${esc(app.role)}">${esc(app.role)}</button></td>
    <td class="date-cell"><time class="table-date"${date}>${esc(formatDay(app.submittedAt))}</time></td>
    ${sent
      ? `<td class="waiting-cell"><span class="waiting${days >= 30 ? " quiet" : ""}">${waitLabel(days)}</span></td>
        <td class="action-cell"><button class="button small records-row-action" type="button" data-response="${id}" aria-label="Record response for ${identity}">${icon("mail")}Record response</button></td>`
      : `<td class="waiting-cell"><span class="outcome ${esc(app.closedReason)}">${REASONS[app.closedReason] || "Closed"}</span></td>
        <td class="last-stage-cell"><span class="waiting">${LABELS[app.lastOpenStage] || "Submitted"}</span></td>
        <td class="action-cell"><button class="button small records-row-action" type="button" data-restore="${id}" aria-label="Restore ${identity}">${icon("reset")}Restore</button></td>`}
  </tr>`;
}
function tableMarkup(apps, filtered) {
  const sent = state.view === "sent";
  const { page, pages, start, end, items } = paginate(apps, state.page);
  state.page = page;
  const allPageSelected = items.length && items.every(app => state.selected.has(app.id));
  const empty = filtered ? "No matching applications." : sent ? "No submitted applications yet." : "No closed applications.";
  const summary = apps.length ? `${(start + 1).toLocaleString()}–${end.toLocaleString()} of ${apps.length.toLocaleString()} applications` : "0 applications";
  return `<div class="table-scroll"><table class="${sent ? "sent" : "closed"}-table">
    <caption class="sr-only">${sent ? "Applications awaiting a response" : "Closed applications"}</caption>
    <thead><tr>
      ${sent ? `<th class="check-cell"><input id="select-page" type="checkbox" aria-label="Select all applications on this page" ${allPageSelected ? "checked" : ""}></th>` : ""}
      <th class="company-cell" scope="col">Company</th><th class="role-cell" scope="col">Role</th><th class="date-cell" scope="col">Submitted</th>
      <th class="waiting-cell" scope="col">${sent ? "Waiting" : "Outcome"}</th>${sent ? "" : '<th class="last-stage-cell" scope="col">Last stage</th>'}
      <th class="action-cell" scope="col"><span class="sr-only">Actions</span></th>
    </tr></thead>
    <tbody>${items.map(app => tableRow(app, sent)).join("") || `<tr class="table-empty"><td colspan="6">${empty}</td></tr>`}</tbody>
  </table></div>
  <div class="pagination"><span>${summary}</span><div class="pagination-controls">
    <button class="button small" type="button" data-page="previous" ${page === 1 ? "disabled" : ""}>Previous</button><span class="mono">${page} / ${pages}</span><button class="button small" type="button" data-page="next" ${page >= pages ? "disabled" : ""}>Next</button>
  </div></div>`;
}

function panelMarkup(apps, filtered) {
  if (state.loading) return '<div class="empty-state" role="status">Loading applications…</div>';
  if (state.error) {
    return `<div class="empty-state"><h2>Could not load applications</h2><p>${esc(state.error)}</p><button class="button" type="button" data-action="retry">Try again</button></div>`;
  }
  if (state.view === "pipeline") return `<div class="progress-layout">${agendaMarkup()}<div class="board-pane">${boardMarkup(apps)}</div></div>`;
  return tableMarkup(apps, filtered);
}
function render() {
  const fold = $("[data-agenda-overdue]");
  if (fold) state.agendaOverdueOpen = fold.open;
  // Redrawing keeps every scroll position.
  const stacks = Object.fromEntries($$(".column").map(column => [column.dataset.drop, $(".column-stack", column).scrollTop]));
  const agendaTop = $(".agenda-scroll")?.scrollTop || 0;
  const boardLeft = $(".board-pane")?.scrollLeft || 0;
  const tableTop = $(".table-scroll")?.scrollTop || 0;
  const tableLeft = $(".table-scroll")?.scrollLeft || 0;
  renderHeader();
  const filters = currentFilters();
  const apps = visibleApplications(state.applications, state.view, filters);
  const filtered = Boolean(filters.query.trim() || (filters.age && filters.age !== "all") || (filters.outcome && filters.outcome !== "all"));
  const selectedCount = state.view === "sent" ? [...state.selected].filter(id => byId(id)?.stage === "sent").length : 0;
  $("#records-bulk").hidden = !selectedCount;
  $("#selected-count").textContent = selectedCount ? `${selectedCount.toLocaleString()} selected` : "";
  $("#age-control").hidden = state.view !== "sent" || Boolean(selectedCount);
  const total = state.applications.filter(app => viewFor(app.stage) === state.view).length;
  $("#result-count").hidden = !filtered || Boolean(selectedCount);
  $("#result-count").textContent = filtered ? `${apps.length.toLocaleString()} of ${total.toLocaleString()}` : "";
  $("#panel").innerHTML = panelMarkup(apps, filtered);
  $$(".column").forEach(column => { $(".column-stack", column).scrollTop = stacks[column.dataset.drop] || 0; });
  const table = $(".table-scroll");
  if (table) { table.scrollTop = tableTop; table.scrollLeft = tableLeft; }
  if ($(".agenda-scroll")) $(".agenda-scroll").scrollTop = agendaTop;
  if ($(".board-pane")) $(".board-pane").scrollLeft = boardLeft;
  updatePageCheckbox();
}
function updatePageCheckbox() {
  const box = $("#select-page");
  if (!box) return;
  const boxes = $$("[data-select]");
  box.disabled = state.busy || boxes.length === 0;
  box.indeterminate = boxes.some(b => b.checked) && !boxes.every(b => b.checked);
}

function switchView(view, focus = false) {
  state.view = view;
  state.page = 1;
  state.selected.clear();
  $("#search").value = currentFilters().query;
  render();
  if (focus) $(`#tab-${view}`).focus();
}

/* ───────────── Feedback and saving ───────────── */
let toastTimer, dialogOrder = 0;
function showToast(message, undo) {
  clearTimeout(toastTimer);
  const toast = $("#toast");
  const text = document.createElement("span");
  text.textContent = message;
  toast.replaceChildren(text);
  if (undo) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Undo";
    button.addEventListener("click", async () => {
      if (state.busy) return;
      toast.classList.remove("visible");
      clearTimeout(toastTimer);
      await undo();
      $("#panel").focus({ preventScroll: true });
    }, { once: true });
    toast.append(button);
  }
  toast.classList.add("visible");
  toastTimer = setTimeout(() => { if (!toast.contains(document.activeElement)) toast.classList.remove("visible"); }, undo ? 12000 : 6000);
}
function showSaveError(message) {
  const dialog = $$("dialog[open]").sort((a, b) => (a.openedOrder || 0) - (b.openedOrder || 0)).at(-1);
  if (dialog) {
    let alert = $("[data-save-error]", dialog);
    if (!alert) {
      alert = document.createElement("p");
      alert.dataset.saveError = "";
      alert.setAttribute("role", "alert");
      alert.className = "save-error";
      ($(".form-body, .drawer-body", dialog) || dialog).append(alert);
    }
    alert.textContent = message;
    alert.scrollIntoView({ block: "nearest" });
  }
  showToast(message);
}

// Saves a recipe from core.js; resolves true when every record saved.
const commit = createApplicationActions(state, () => state.applications, {
  busy: setBusy,
  saved({ succeeded, failed, message, undo }) {
    state.selected = new Set(failed.map(failure => failure.old.id));
    render();
    if ($("#drawer").open && succeeded.some(app => app.id === state.selectedId)) renderDrawer();
    if (failed.length && !succeeded.length) showSaveError(message);
    else showToast(message, undo);
  },
  undone(message) {
    state.selected.clear();
    render();
    if ($("#drawer").open) renderDrawer();
    showToast(message);
  },
}, api.applications.update);

/* ───────────── Dialogs and the drawer ───────────── */
function openDialog(id) {
  const dialog = $(`#${id}`);
  if (dialog.open) return;
  dialog.opener = document.activeElement;
  dialog.openedOrder = ++dialogOrder;
  dialog.showModal();
}
function closeDialog(id) { if ($(`#${id}`).open) $(`#${id}`).close(); }

function renderDrawer() {
  const app = byId(state.selectedId);
  if (!app) return;
  const closed = app.stage === "closed", waiting = waitingOnCompany(app), url = safeUrl(app.url);
  const lock = app.external ? "" : "disabled";
  const options = (entries, value) => entries.map(([key, label]) => `<option value="${key}" ${value === key ? "selected" : ""}>${label}</option>`).join("");
  const stages = STAGES.map(stage => [stage, `${LABELS[stage]}${stage === "sent" ? " · awaiting a response" : ""}`]);
  const next = app.stage === "sent" ? `<button class="button" type="button" data-response="${esc(app.id)}">Record response</button>`
    : inPipeline(app) && !waiting && app.nextAction ? `<button class="button" type="button" data-complete="${esc(app.id)}">Complete task</button>` : "";
  $("#drawer-content").innerHTML = `<form id="detail-form" class="drawer-form">
    <header class="drawer-head">${companyMark(app)}<div class="drawer-title"><h2 id="drawer-title">${esc(app.role)}</h2><p>${esc(app.company)}</p></div><button class="icon-button" type="button" data-close="drawer" aria-label="Close application details" autofocus>${icon("close")}</button></header>
    <div class="drawer-body"><div class="form-grid">
      <label class="field ${closed ? "" : "full"}">Stage<select name="stage" id="detail-stage">${options(stages, app.stage)}</select></label>
      <label class="field" id="detail-reason-field" ${closed ? "" : "hidden"}>Outcome<select name="closedReason" ${closed ? "required" : "disabled"}><option value="">Choose an outcome</option>${options(Object.entries(REASONS), app.closedReason)}</select></label>
      <label class="field">Company<input ${lock} name="company" required maxlength="200" value="${esc(app.company)}"></label>
      <label class="field">Role<input ${lock} name="role" required maxlength="500" value="${esc(app.role)}"></label>
      <label class="field">Date submitted<input name="submittedAt" type="date" max="${today()}" value="${esc(app.submittedAt)}"></label>
      <label class="field">Location<input ${lock} name="location" maxlength="200" value="${esc(app.location)}" placeholder="Optional"></label>
      <label class="field full">Posting URL<input ${lock} name="url" type="url" maxlength="2000" value="${esc(app.url)}" placeholder="https://… (optional)"></label>
      <label class="field full">Whose move?<select name="taskState" id="detail-task-state">${options([["action", "Mine · I have a task to do"], ["waiting", "Company · waiting for a response"]], waiting ? "waiting" : "action")}</select></label>
      <label class="field full" id="detail-waiting-field" ${waiting ? "" : "hidden"}>Waiting for<input name="waitingFor" maxlength="500" value="${esc(app.waitingFor)}" placeholder="Optional context" ${waiting ? "" : "disabled"}></label>
      <label class="field" id="detail-next-action-field" ${waiting ? "hidden" : ""}>Next task<input name="nextAction" maxlength="500" value="${esc(app.nextAction)}" placeholder="What happens next?" ${waiting ? "disabled" : ""}></label>
      <label class="field" id="detail-next-due-field" ${waiting ? "hidden" : ""}>Due date<input name="nextDue" type="date" value="${esc(app.nextDue)}" ${waiting ? "disabled" : ""}></label>
      <label class="field full">Resume sent<input name="resumeVariant" maxlength="200" value="${esc(app.resumeVariant)}" placeholder="Optional"></label>
      <label class="field full">Notes<textarea name="notes" maxlength="8000" rows="4" placeholder="People, prep, resume version, or anything to remember…">${esc(app.notes)}</textarea></label>
    </div>
    <h3 class="section-heading">Activity</h3>
    <ol class="history">${app.events.map(event => `<li><strong>${esc(String(event.text).replace(/\bSent\b/g, "Submitted"))}</strong><time datetime="${esc(event.at)}">${esc(formatDay(String(event.at).slice(0, 10), true))}</time></li>`).join("")}</ol></div>
    <footer class="dialog-foot drawer-foot">
      ${closed ? `<button class="button ghost" type="button" data-restore="${esc(app.id)}">${icon("reset")}Restore</button>` : '<button class="button ghost danger" type="button" data-action="close-application">Close application</button>'}
      ${url ? `<a class="button ghost" href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="Open posting in a new tab">${icon("external")}Posting</a>` : ""}
      ${next}<button class="button" type="button" data-action="tailor-resume">Tailor resume</button><button class="button primary" type="submit">Save changes</button>
    </footer>
  </form>`;
}
function updateDetailReason() {
  const closed = $("#detail-stage").value === "closed";
  const field = $("#detail-reason-field"), select = $("select", field);
  field.hidden = !closed;
  select.disabled = !closed;
  select.required = closed;
  $("#detail-stage").closest("label").classList.toggle("full", !closed);
}
function updateTaskFields() {
  const waiting = $("#detail-task-state").value === "waiting";
  for (const id of ["detail-next-action-field", "detail-next-due-field"]) {
    $(`#${id}`).hidden = waiting;
    $(`#${id} input`).disabled = waiting;
  }
  $("#detail-waiting-field").hidden = !waiting;
  $("#detail-waiting-field input").disabled = !waiting;
}

async function openApplication(id) {
  if (!byId(id) || state.busy) return;
  setBusy(true);
  try {
    replaceApp(state.applications, fromAPI(await api.applications.get(id)));
    state.selectedId = id;
    renderDrawer();
    openDialog("drawer");
  } catch (error) { showToast(`Could not open application. ${error.message}`); }
  finally { setBusy(false); }
}
function openResponse(id) {
  const app = byId(id);
  if (!app) return;
  state.responseId = id;
  const form = $("#response-form");
  form.reset();
  $("#response-context").innerHTML = `${companyMark(app)}<div><strong>${esc(app.company)}</strong><span>${esc(app.role)}</span></div>`;
  form.elements.nextAction.value = app.nextAction || "";
  form.elements.nextDue.value = app.nextDue || "";
  updateResponseFields();
  openDialog("response-dialog");
}
function updateResponseFields() {
  const form = $("#response-form"), stage = form.elements.response.value, rejected = stage === "rejected";
  $("#response-next-fields").hidden = rejected;
  form.elements.nextAction.disabled = rejected;
  form.elements.nextDue.disabled = rejected;
  $("#response-submit").innerHTML = `${rejected ? "Close as rejected" : `Move to ${LABELS[stage]}`} ${icon(rejected ? "archive" : "arrow")}`;
}
function openCompletion(id) {
  const app = byId(id);
  if (!app || !inPipeline(app) || waitingOnCompany(app) || !app.nextAction) return;
  state.completionId = id;
  const form = $("#complete-form");
  form.reset();
  form.elements.nextAction.setCustomValidity("");
  $("#complete-context").textContent = `${app.nextAction} · ${app.company}`;
  updateCompletionFields();
  openDialog("complete-dialog");
}
function updateCompletionFields() {
  const form = $("#complete-form"), anotherTask = form.elements.after.value === "action";
  $("#complete-next-fields").hidden = !anotherTask;
  $("#complete-waiting-field").hidden = anotherTask;
  form.elements.nextAction.disabled = !anotherTask;
  form.elements.nextAction.required = anotherTask;
  form.elements.nextDue.disabled = !anotherTask;
  form.elements.waitingFor.disabled = anotherTask;
}
function openClosure(id) {
  const app = byId(id);
  if (!app || app.stage === "closed") return;
  state.closureId = id;
  $("#close-form").reset();
  $("#close-form [data-save-error]")?.remove();
  $("#close-context").textContent = `${app.company} · ${app.role}`;
  openDialog("close-dialog");
}

/* ───────────── Actions ───────────── */
async function restoreApplication(id) {
  const app = byId(id);
  if (!app || app.stage !== "closed") return;
  const change = restore(app);
  if (!await commit([id], change)) return;
  closeDialog("drawer");
  switchView(viewFor(change.stage));
}
async function tailorResume() {
  const app = byId(state.selectedId);
  if (!app) return;
  setBusy(true);
  try { location.assign(resumeLink(await api.resumes.targetFromApplication(app.id))); }
  catch (error) { showToast(error.message); }
  finally { setBusy(false); }
}
async function bulkClose() {
  const ids = [...state.selected].filter(id => byId(id)?.stage === "sent");
  if (!ids.length) return;
  await commit(ids, closeNoReply(`${ids.length} application${ids.length === 1 ? "" : "s"}`));
  $("#panel").focus();
}
function restoreCheckboxFocus(id) {
  render();
  const checkbox = $$("[data-select]").find(box => box.dataset.select === id);
  (checkbox || $("#select-page") || $("#panel")).focus({ preventScroll: true });
}

document.addEventListener("click", async event => {
  if (state.busy) return;
  const target = event.target.closest("button, a");
  if (!target) {
    const row = event.target.closest("[data-row-open]");
    if (row && !event.target.closest("input, select, textarea, label") && !getSelection()?.toString()) {
      // The role button remains the keyboard and return-focus target.
      $(".role-title", row).focus({ preventScroll: true });
      return openApplication(row.dataset.rowOpen);
    }
    return;
  }
  const data = target.dataset;
  if (data.agendaWeek) {
    state.agendaWeek += Number(data.agendaWeek);
    render();
    $(".agenda-scroll").scrollTop = 0;
    $(`[data-agenda-week="${data.agendaWeek}"]`).focus({ preventScroll: true });
    return;
  }
  if (data.close) return closeDialog(data.close);
  if (data.view) return switchView(data.view, true);
  if (data.agendaOpen) return openApplication(data.agendaOpen);
  if (data.complete) return openCompletion(data.complete);
  if (data.open) return openApplication(data.open);
  if (data.response) return openResponse(data.response);
  if (data.restore) return restoreApplication(data.restore);
  if (data.page) {
    state.page += data.page === "next" ? 1 : -1;
    render();
    if ($(".table-scroll")) $(".table-scroll").scrollTop = 0;
    $("#panel").focus({ preventScroll: true });
    return;
  }
  switch (data.action) {
    case "log": {
      const form = $("#log-form");
      form.reset();
      form.elements.submittedAt.value = today();
      form.elements.submittedAt.max = today();
      openDialog("log-dialog");
      break;
    }
    case "retry":
      state.loading = true;
      state.error = "";
      render();
      await loadApplications();
      break;
    case "tailor-resume": return tailorResume();
    case "clear-selection":
      state.selected.clear();
      render();
      $("#select-page")?.focus();
      break;
    case "bulk-close": return bulkClose();
    case "close-application": return openClosure(state.selectedId);
  }
});

document.addEventListener("change", event => {
  const el = event.target;
  if (el.dataset.agendaComplete) {
    el.checked = false;
    if (!state.busy) openCompletion(el.dataset.agendaComplete);
    return;
  }
  if (el.id === "sort") { currentFilters().sort = el.value; state.page = 1; render(); }
  if (el.id === "age-filter") { state.filters.sent.age = el.value; state.selected.clear(); state.page = 1; render(); }
  if (el.id === "outcome-filter") { state.filters.closed.outcome = el.value; state.page = 1; render(); }
  if (el.id === "detail-stage") updateDetailReason();
  if (el.name === "response") updateResponseFields();
  if (el.name === "after") updateCompletionFields();
  if (el.id === "detail-task-state") updateTaskFields();
  if (el.dataset.select) {
    if (el.checked) state.selected.add(el.dataset.select);
    else state.selected.delete(el.dataset.select);
    restoreCheckboxFocus(el.dataset.select);
  }
  if (el.id === "select-page") {
    for (const box of $$("[data-select]")) {
      if (el.checked) state.selected.add(box.dataset.select);
      else state.selected.delete(box.dataset.select);
    }
    render();
    $("#select-page").focus({ preventScroll: true });
  }
});

// Pointing at an agenda task highlights its card on the board.
const highlightCard = id => $$(".card").forEach(card => card.classList.toggle("agenda-hover", card.dataset.drag === id));
for (const name of ["mouseover", "focusin"]) {
  document.addEventListener(name, event => {
    const row = event.target.closest(".agenda-row");
    if (row) highlightCard(row.dataset.agendaApp);
  });
}
for (const name of ["mouseout", "focusout"]) {
  document.addEventListener(name, event => {
    const row = event.target.closest(".agenda-row");
    if (row && !row.contains(event.relatedTarget)) highlightCard(null);
  });
}
document.addEventListener("toggle", event => {
  if (event.target.isConnected && event.target.matches("[data-agenda-overdue]")) state.agendaOverdueOpen = event.target.open;
}, true);

$("#search").addEventListener("input", event => {
  currentFilters().query = event.target.value;
  state.page = 1;
  state.selected.clear();
  render();
});
// Trim required text before native validation so whitespace-only names are
// rejected without adding a second, conflicting validation system.
document.addEventListener("input", event => {
  if (["company", "role"].includes(event.target.name)) event.target.setCustomValidity(event.target.value.trim() ? "" : "Enter a name.");
});
$('#complete-form [name="nextAction"]').addEventListener("input", event => {
  event.target.setCustomValidity(event.target.value.trim() ? "" : "Enter the next task.");
});

/* ───────────── Form submissions ───────────── */
async function addApplication(text) {
  setBusy(true);
  try {
    const app = fromAPI(await api.applications.createExternal(externalPayload(text)));
    state.applications.unshift(app);
    closeDialog("log-dialog");
    state.filters.sent.query = "";
    state.filters.sent.age = "all";
    switchView("sent", true);
    showToast(`${app.company} added to Submitted.`);
  } catch (error) { showSaveError(`Could not add application. ${error.message}`); }
  finally { setBusy(false); }
}
async function closeApplication(text) {
  const app = byId(state.closureId), reason = text("closedReason");
  if (!app || app.stage === "closed" || !Object.hasOwn(REASONS, reason)) return;
  if (!await commit([app.id], closeAs(app, reason))) return;
  closeDialog("close-dialog");
  closeDialog("drawer");
}
async function completeApplicationTask(text) {
  const app = byId(state.completionId);
  if (!app || !inPipeline(app) || waitingOnCompany(app) || !app.nextAction) return;
  const change = completeTask(app, text("after"), { nextAction: text("nextAction"), nextDue: text("nextDue"), waitingFor: text("waitingFor") });
  if (!await commit([app.id], change)) return;
  closeDialog("complete-dialog");
  closeDialog("drawer");
  $("#panel").focus({ preventScroll: true });
}
async function recordResponse(text) {
  const app = byId(state.responseId);
  if (!app) return;
  const response = text("response");
  if (!await commit([app.id], respond(app, response, text("nextAction"), text("nextDue")))) return;
  closeDialog("response-dialog");
  closeDialog("drawer");
  if (response === "rejected") {
    render();
    $("#panel").focus({ preventScroll: true });
  } else {
    state.filters.pipeline.query = "";
    switchView("pipeline", true);
  }
}
async function saveDetails(text) {
  const app = byId(state.selectedId);
  if (!app) return;
  const stage = text("stage"), reason = stage === "closed" ? text("closedReason") : null;
  const changes = Object.fromEntries(detailFields(app).map(key => [key, text(key)]));
  if (!hasChanges(app, changes) && stage === app.stage && reason === app.closedReason) return closeDialog("drawer");
  if (!await commit([app.id], editDetails(app, changes, stage, reason))) return;
  closeDialog("drawer");
  if (stage !== app.stage) switchView(viewFor(stage), true);
}
const SUBMIT = {
  "log-form": addApplication,
  "close-form": closeApplication,
  "complete-form": completeApplicationTask,
  "response-form": recordResponse,
  "detail-form": saveDetails,
};
document.addEventListener("submit", async event => {
  const form = event.target, submit = SUBMIT[form.id];
  if (!submit) return;
  event.preventDefault();
  if (state.busy) return;
  $("[data-save-error]", form)?.remove();
  const data = new FormData(form);
  await submit(key => String(data.get(key) || "").trim());
});

document.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !$$("dialog").some(dialog => dialog.open)) {
    event.preventDefault();
    $("#search").focus();
    $("#search").select();
  }
  const tab = event.target.closest('[role="tab"]');
  if (tab && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const views = ["pipeline", "sent", "closed"], index = views.indexOf(tab.dataset.view);
    const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : (index + (event.key === "ArrowRight" ? 1 : 2)) % 3;
    switchView(views[next], true);
  }
  const card = event.target.closest(".card-open");
  if (card && ["ArrowDown", "ArrowUp"].includes(event.key)) {
    const cards = [...card.closest(".column-stack").querySelectorAll(".card-open")];
    const next = cards[cards.indexOf(card) + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) { event.preventDefault(); next.focus(); }
  }
});

/* ───────────── Dragging cards between stages ───────────── */
document.addEventListener("dragstart", event => {
  if (state.busy || event.target.closest("[data-complete]")) { event.preventDefault(); return; }
  const card = event.target.closest("[data-drag]");
  if (!card) return;
  state.dragId = card.dataset.drag;
  card.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", state.dragId);
});
document.addEventListener("dragover", event => {
  const column = event.target.closest("[data-drop]");
  if (!column || !state.dragId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  column.classList.add("drag-over");
});
document.addEventListener("dragleave", event => {
  const column = event.target.closest("[data-drop]");
  if (column && !column.contains(event.relatedTarget)) column.classList.remove("drag-over");
});
document.addEventListener("drop", async event => {
  const column = event.target.closest("[data-drop]"), app = byId(state.dragId);
  if (!column || !app) return;
  event.preventDefault();
  const stage = column.dataset.drop;
  state.dragId = null;
  if (app.stage === stage) { column.classList.remove("drag-over"); return; }
  await commit([app.id], moveTo(app, stage));
});
document.addEventListener("dragend", () => {
  state.dragId = null;
  $$(".dragging, .drag-over").forEach(el => el.classList.remove("dragging", "drag-over"));
});

$$("dialog").forEach(dialog => {
  dialog.addEventListener("cancel", event => { if (state.busy) event.preventDefault(); });
  // Backdrop clicks close only when both pointer endpoints are outside the
  // dialog, avoiding lost edits from a text-selection drag that ends outside.
  let startedOutside = false;
  const outside = event => {
    const r = dialog.getBoundingClientRect();
    return event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
  };
  dialog.addEventListener("pointerdown", event => { startedOutside = event.target === dialog && outside(event); });
  dialog.addEventListener("click", event => {
    if (!state.busy && startedOutside && event.target === dialog && outside(event)) dialog.close();
    startedOutside = false;
  });
  // A record may leave its view after a move; focus then returns to the active tab.
  dialog.addEventListener("close", () => {
    if ($$("dialog").some(d => d.open)) return;
    if (dialog.opener?.isConnected) dialog.opener.focus({ preventScroll: true });
    else $(`#tab-${state.view}`).focus({ preventScroll: true });
  });
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) loadApplications(); });
addEventListener("storage", async event => {
  if (event.key === "oneshot.visitor-data.state.v1" && await guest.isLocal()) location.reload();
});

startAccount();
render();
loadApplications();

/* Applied on phones: the desktop tracker's tabs, agenda, stages, lists and
   details, laid out for a narrow screen. */
import P from "../phone/shell.js";
import { api } from "../shared/api.js";
import { guest } from "../shared/guest.js";
import { $, esc } from "../shared/util.js";
import {
  LABELS, OPEN, PLACEHOLDERS, REASONS, age, agendaIdentity, agendaItems, agendaWeek, closeAs, closeNoReply,
  completeTask, counts, detailFields, dueDays, dueLabel, editDetails, externalPayload, formatDay, fromAPI, fromList,
  hasChanges, inPipeline, initialFilters, moveTo, paginate, replaceApp, respond, restore, resumeLink, safeUrl, saveChanges,
  savedMessage, tasksDue, undoChanges, undoneMessage, validDay, viewFor, visibleApplications, waitLabel, waitingOnCompany,
  zoneName,
} from "./core.js";

const { icon, S, plural, today } = P;
const LOCALE = "en-US";
const dayText = (day, year = false) => formatDay(day, year, LOCALE);
const TRACK = ["sent", ...OPEN];
const STAGE_COLORS = { replied: "#859584", assessment: "#C49A3A", interview: "#4F7FA8", offer: "#1E5C42" };
const RESPONSES = [["replied", "Recruiter reply"], ["assessment", "Assessment invitation"], ["interview", "Interview invitation"], ["offer", "Offer"], ["rejected", "Rejection"]];
const SORTS = [["next", "Next action first"], ["recent", "Recently updated"], ["newest", "Newest submitted"], ["oldest", "Oldest submitted"], ["company", "Company A–Z"]];
const AGES = [["all", "All wait times"], ["7", "Submitted in the last 7 days"], ["30", "30+ days waiting"]];
const VIEWS = [["pipeline", "In progress"], ["sent", "Submitted"], ["closed", "Closed"]];
const STORE = "oneshot.phone.applied";

const saved = (() => { try { return JSON.parse(sessionStorage.getItem(STORE)) || {}; } catch (_) { return {}; } })();
const state = {
  apps: [], loading: true, error: "", busy: false,
  view: VIEWS.some(([key]) => key === saved.view) ? saved.view : "pipeline",
  filters: initialFilters(), page: { sent: 1, closed: 1 },
  week: 0, overdueOpen: false, selecting: false, selected: new Set(), v: 0,
};
// `v` counts data changes, so the shell redraws an open page or sheet only when needed.
const bump = () => { state.v += 1; };
const remember = () => { try { sessionStorage.setItem(STORE, JSON.stringify({ view: state.view })); } catch (_) { /* private mode */ } };
const byId = id => state.apps.find(app => app.id === String(id));
const logo = company => `<div class="logo sm">${esc(P.initials(company))}</div>`;
const refresh = () => { bump(); P.setBadge(tasksDue(state.apps)); P.render(); };

/* ───────────── Data ───────────── */
async function load({ quiet = false } = {}) {
  if (state.busy || (quiet && (S.sheet || S.push))) return;
  if (!quiet) { state.loading = !state.apps.length; state.error = ""; P.render(); }
  try {
    state.apps = fromList(await api.applications.list());
    state.error = "";
  } catch (error) { if (!quiet || !state.apps.length) state.error = error.message || "Could not load applications."; }
  state.loading = false;
  refresh();
}
// Saves a recipe from core.js; resolves true when every record saved.
async function commit(ids, { apply, message }) {
  if (state.busy) return false;
  state.busy = true; P.render();
  const { succeeded, failed } = await saveChanges(state.apps, ids, apply, api.applications.update);
  state.busy = false; refresh();
  if (failed.length && !succeeded.length) { P.toast(failed[0].error.message || "Could not save."); return false; }
  P.toast(savedMessage(message, succeeded, failed), succeeded.length ? [{ label: "Undo", run: () => undo(succeeded) }] : []);
  return !failed.length;
}
async function undo(succeeded) {
  if (state.busy) return;
  state.busy = true; P.render();
  const errors = await undoChanges(state.apps, succeeded, api.applications.update);
  state.busy = false; refresh();
  P.toast(undoneMessage(errors));
}

/* ───────────── In progress ───────────── */
function dueTag(app) {
  if (waitingOnCompany(app)) return '<span class="due-tag waiting">Waiting</span>';
  const days = dueDays(app);
  const title = validDay(app.nextDue) ? ` title="${esc(dayText(app.nextDue, true))}"` : "";
  return `<span class="due-tag ${days < 0 ? "overdue" : days <= 1 ? "soon" : ""}"${title}>${esc(dueLabel(app, LOCALE))}</span>`;
}
function agendaMarkup(query) {
  const week = agendaWeek(state.apps, state.week, query, LOCALE);
  const identity = agendaIdentity(agendaItems(state.apps));
  const zone = zoneName(LOCALE) || "";
  const row = app => {
    const late = -dueDays(app);
    return `<div class="task"><button class="tick" type="button" data-complete="${esc(app.id)}" aria-label="${esc(`Complete task: ${app.nextAction} at ${app.company}`)}"><i>${icon("check")}</i></button>`
      + `<button type="button" class="task-main" data-app="${esc(app.id)}"><b>${esc(app.nextAction)}</b><span>${esc(identity(app))}${late > 0 ? ` · <em class="od">${late}d overdue</em>` : ""}</span></button></div>`;
  };
  const { overdue } = week;
  const html = week.days.map(({ isToday, label, items }) => {
    const fold = !isToday || !overdue.length ? ""
      : overdue.length === 1 ? row(overdue[0])
      : `<button class="od-toggle" type="button" data-act="toggle-overdue" aria-expanded="${state.overdueOpen}">${icon("chev")}${overdue.length} overdue</button>${state.overdueOpen ? overdue.map(row).join("") : ""}`;
    return `<div class="day-label">${isToday ? "Today · " : ""}${esc(label)}</div>${fold}${items.map(row).join("")}`;
  }).join("");
  const nav = `<button class="icon-btn sm" type="button" data-act="week-prev" aria-label="Previous week">${icon("back")}</button>`
    + `<span>${esc(week.range)}${zone ? ` · ${esc(zone)}` : ""}</span>`
    + `<button class="icon-btn sm" type="button" data-act="week-next" aria-label="Next week">${icon("chev")}</button>`;
  return `<div class="section-h agenda-h"><h2>Agenda</h2><span class="week-nav">${nav}</span></div>
      ${html || `<p class="agenda-empty">${query.trim() ? "No matching items this week." : "Nothing scheduled this week."}</p>`}`;
}
const stageCard = app => `<button class="app-row stage-card" type="button" data-app="${esc(app.id)}"><span style="min-width:0"><b>${esc(app.company)} · ${esc(app.role)}</b>`
  + `<span class="task-line${waitingOnCompany(app) ? " waiting" : ""}">${esc(waitingOnCompany(app) ? app.waitingFor || "Waiting on company" : app.nextAction || "Set a next step")}</span></span>`
  + `<span class="end">${dueTag(app)}${icon("chev")}</span></button>`;
function progressMarkup() {
  const list = visibleApplications(state.apps, "pipeline", state.filters.pipeline);
  return agendaMarkup(state.filters.pipeline.query) + OPEN.map(stage => {
    const items = list.filter(app => app.stage === stage);
    const head = `<div class="section-h"><h2><span class="stage-dot" style="background:${STAGE_COLORS[stage]}"></span>${LABELS[stage]}</h2><small>${items.length}</small></div>`;
    return head + (items.length ? `<div class="card-list">${items.map(stageCard).join("")}</div>` : `<p class="stage-empty">Nothing in ${LABELS[stage]}.</p>`);
  }).join("") + '<div style="height:24px"></div>';
}

/* ───────────── Submitted and Closed ───────────── */
const selectChip = (key, label, value, options) => `<label class="select-chip"><select data-select="${key}" aria-label="${esc(label)}">`
  + `${options.map(([v, l]) => `<option value="${v}"${v === value ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>${icon("down")}</label>`;
function listRow(app, end, sub) {
  const text = `<span style="min-width:0"><b>${esc(app.role)}</b><span class="sub">${esc(app.company)} · ${esc(sub)}</span></span>`;
  if (state.selecting) {
    const on = state.selected.has(app.id);
    return `<button class="app-row selectable${on ? " is-selected" : ""}" type="button" data-pick="${esc(app.id)}" aria-pressed="${on}"><span class="row-pick"><i>${icon("check")}</i></span>${text}<span class="end">${end}</span></button>`;
  }
  return `<button class="app-row" type="button" data-app="${esc(app.id)}">${logo(app.company)}${text}<span class="end">${end}${icon("chev")}</span></button>`;
}
function pageOf(list, view) {
  const { page, pages, start, end, items } = paginate(list, state.page[view]);
  state.page[view] = page;
  const range = list.length ? `${(start + 1).toLocaleString()}–${end.toLocaleString()} of ${plural(list.length, "application")}` : "0 applications";
  const pager = `<div class="pager"><span>${range}</span><span class="pager-btns">`
    + `<button class="btn small" type="button" data-page="-1"${page === 1 ? " disabled" : ""}>Previous</button><span>${page} / ${pages}</span>`
    + `<button class="btn small" type="button" data-page="1"${page >= pages ? " disabled" : ""}>Next</button></span></div>`;
  return { items, pager };
}
// A page of `list`, one of `total` records; `row` draws each, `empty` explains an empty tab.
function listMarkup(list, total, items, row, empty) {
  const filtered = list.length !== total;
  return (filtered ? `<div class="result-count">${list.length.toLocaleString()} of ${total.toLocaleString()}</div>` : "")
    + (items.length ? `<div class="list-flat">${items.map(row).join("")}</div>` : `<div class="empty">${filtered ? "No matching applications." : empty}</div>`);
}
function submittedMarkup() {
  const filters = state.filters.sent, total = counts(state.apps).sent;
  const list = visibleApplications(state.apps, "sent", filters);
  const { items, pager } = pageOf(list, "sent");
  const tools = state.selecting
    ? `<div class="tool-row select-tools"><b>${state.selected.size.toLocaleString()} selected</b><button class="link-btn" type="button" data-act="select-page">Select page</button>`
      + '<button class="link-btn" type="button" data-act="select-clear">Clear</button><button class="link-btn end" type="button" data-act="select-done">Done</button></div>'
    : `<div class="tool-row">${selectChip("age", "Filter by time waiting", filters.age, AGES)}${selectChip("sort", "Sort applications", filters.sort, SORTS)}`
      + `<button class="link-btn end" type="button" data-act="select-start"${total ? "" : " disabled"}>${icon("select")}Select</button></div>`;
  const wait = app => { const days = age(app); return `<span class="wait${days >= 30 ? " quiet" : ""}">${waitLabel(days)}</span>`; };
  return tools + listMarkup(list, total, items, app => listRow(app, wait(app), dayText(app.submittedAt)), "No submitted applications yet.")
    + pager + (state.selecting ? '<div class="select-gap"></div>' : "");
}
function closedMarkup() {
  const filters = state.filters.closed, total = counts(state.apps).closed;
  const list = visibleApplications(state.apps, "closed", filters);
  const { items, pager } = pageOf(list, "closed");
  const outcome = app => `<span class="outcome ${esc(app.closedReason)}">${esc(REASONS[app.closedReason] || "Closed")}</span>`;
  return `<div class="tool-row">${selectChip("outcome", "Filter by outcome", filters.outcome, [["all", "All outcomes"], ...Object.entries(REASONS)])}${selectChip("sort", "Sort applications", filters.sort, SORTS)}</div>`
    + listMarkup(list, total, items, app => listRow(app, outcome(app), `last stage ${LABELS[app.lastOpenStage] || "Submitted"}`), "No closed applications.")
    + pager;
}

// The search box is drawn once, so typing never loses the keyboard; the rest are regions.
let built = false, shownView = null;
function paint(page) {
  if (!built) {
    page.innerHTML = `${P.head("Applied", `<button class="icon-btn" type="button" data-act="add-app" aria-label="Add application">${icon("plus")}</button>`)}
        <div class="sticky" id="applied-sticky"><div class="segmented" role="tablist" aria-label="Applications" id="applied-tabs"></div>
        <div class="search-row slim"><form class="search" role="search" data-search-form><svg aria-hidden="true"><use href="#ph-search"/></svg><input id="aq" type="search" enterkeyhint="search" autocomplete="off" autocorrect="off" spellcheck="false"></form></div></div><div id="applied-body"></div>`;
    built = true;
  }
  const total = counts(state.apps);
  P.region($("#applied-tabs", page), VIEWS.map(([key, label]) => `<button type="button" role="tab" data-view="${key}" aria-selected="${state.view === key}">${label}<small>${total[key]}</small></button>`).join(""));
  const input = $("#aq", page);
  if (shownView !== state.view) {
    input.placeholder = PLACEHOLDERS[state.view];
    input.setAttribute("aria-label", PLACEHOLDERS[state.view]);
    input.value = state.filters[state.view].query;
    shownView = state.view;
  }
  const body = $("#applied-body", page);
  body.setAttribute("aria-busy", String(state.busy));
  P.region(body, state.loading ? P.stateBlock("loading", { title: "Loading applications…" })
    : state.error ? P.stateBlock("error", { title: "Could not load applications", detail: state.error })
    : state.view === "pipeline" ? progressMarkup()
    : state.view === "sent" ? submittedMarkup() : closedMarkup());
}
function selectBar() {
  if (!state.selecting || state.view !== "sent" || S.push) return "";
  const n = state.selected.size;
  return `<button class="btn primary block" type="button" data-act="bulk-close"${n && !state.busy ? "" : " disabled"}>Close as no reply${n ? ` (${n.toLocaleString()})` : ""}</button>`;
}

/* ───────────── Application page ───────────── */
const backBar = title => `<header class="push-bar scrolled"><button class="back" type="button" data-act="back">${icon("back")}Applied</button><span class="push-title">${title}</span><span class="bar-spacer"></span></header>`;
function appPage(push) {
  const app = byId(push.id);
  if (!app) return `${backBar("")}<div class="push-scroll"><div class="empty"><strong>This application is gone</strong>Go back to Applied.</div></div>`;
  const d = { ...app, ...push.draft };
  const closed = app.stage === "closed", index = TRACK.indexOf(app.stage), lock = app.external ? "" : " disabled";
  const mine = d.taskState !== "waiting", url = safeUrl(app.url), id = esc(app.id), last = LABELS[app.lastOpenStage] || "Submitted";
  const field = (key, label, extra = "") => `<label class="field"><span>${label}</span><input data-draft="${key}" value="${esc(d[key] || "")}"${extra}></label>`;
  const quick = [
    app.stage === "sent" ? `<button class="btn" type="button" data-act="response" data-id="${id}">${icon("mail")}Record response</button>` : "",
    inPipeline(app) && !waitingOnCompany(app) && app.nextAction ? `<button class="btn" type="button" data-complete="${id}">${icon("check")}Complete task</button>` : "",
    `<button class="btn" type="button" data-act="tailor" data-id="${id}">${icon("file")}Tailor resume</button>`,
    url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Posting${icon("out")}</a>` : "",
  ].join("");
  const task = mine
    ? `<div class="field-row"><label class="field"><span>Next task</span><input data-draft="nextAction" maxlength="500" value="${esc(d.nextAction)}" placeholder="What happens next?"></label>`
      + `<label class="field"><span>Due date</span><input type="date" data-draft="nextDue" value="${esc(d.nextDue)}"></label></div>`
    : `<label class="field"><span>Waiting for</span><input data-draft="waitingFor" maxlength="500" value="${esc(d.waitingFor)}" placeholder="Optional context"></label>`;
  const steps = TRACK.map((stage, i) => `<button type="button" data-move="${stage}" class="${i < index ? "past" : i === index ? "current" : ""}" aria-pressed="${i === index}"${state.busy ? " disabled" : ""}>${LABELS[stage]}</button>`);
  const owners = [["action", "Mine · I have a task"], ["waiting", "Company · waiting"]]
    .map(([value, label]) => `<button type="button" role="radio" data-task-state="${value}" aria-selected="${(mine ? "action" : "waiting") === value}">${label}</button>`);
  const move = closed
    ? `<div class="sheet-label">Stage</div><p style="margin:0"><span class="outcome ${esc(app.closedReason)}">${esc(REASONS[app.closedReason] || "Closed")}</span> <span class="muted">· last stage ${last}</span></p>`
    : `<div class="sheet-label">Stage</div><div class="stage-track">${steps.join("")}</div>
        <div class="sheet-label">Whose move?</div><div class="segmented inline" role="radiogroup">${owners.join("")}</div>
        ${task}`;
  const history = app.events.map(event => `<li>${esc(String(event.text).replace(/\bSent\b/g, "Submitted"))}<time>${esc(dayText(String(event.at).slice(0, 10), true))}</time></li>`).join("");
  return `${backBar(esc(app.company))}
      <div class="push-scroll" id="push-scroll"><div class="d-wrap">
        <div class="d-company"><div class="logo lg">${esc(P.initials(app.company))}</div><div><b class="app-title">${esc(app.role)}</b><span>${esc(app.company)}${app.external ? " · added by you" : ""}</span></div></div>
        <div class="quick-row">${quick}</div>
        ${move}
        <div class="sheet-label">Details</div>
        ${field("company", "Company", `${lock} maxlength="200"`)}${field("role", "Role", `${lock} maxlength="500"`)}${field("location", "Location", `${lock} maxlength="200" placeholder="Optional"`)}${field("url", "Posting URL", `${lock} type="url" inputmode="url" autocapitalize="off" maxlength="2000" placeholder="https://… (optional)"`)}
        ${app.external ? "" : '<p class="field-hint">Added from Discover, so company, role, location and link stay as posted.</p>'}
        <label class="field"><span>Date submitted</span><input type="date" data-draft="submittedAt" value="${esc(d.submittedAt)}" max="${today()}"></label>
        ${field("resumeVariant", "Resume sent", ' maxlength="200" placeholder="Optional"')}
        <label class="field"><span>Notes</span><textarea data-draft="notes" maxlength="8000" placeholder="People, prep, resume version, or anything to remember…">${esc(d.notes)}</textarea></label>
        ${push.error ? `<p class="status-line error" role="alert">${esc(push.error)}</p>` : ""}
        <div class="sheet-label">Activity</div><ul class="history">${history || "<li>No activity yet.<time></time></li>"}</ul>
        <div class="danger-zone">${closed ? `<button class="btn block" type="button" data-act="restore-app" data-id="${id}">${icon("undo")}Restore to ${last}</button>` : `<button class="btn block danger" type="button" data-act="close-app" data-id="${id}">Close application</button>`}</div>
      </div></div>
      <footer class="action-bar"><button class="btn primary block" type="button" data-act="save-app" data-id="${id}"${state.busy ? " disabled" : ""}>Save changes</button></footer>`;
}

/* ───────────── Sheets ───────────── */
const closeButton = `<button class="icon-btn" type="button" data-act="close-sheet" aria-label="Close">${icon("x")}</button>`;
const radio = (attr, key, label, on) => `<button class="opt radio" type="button" role="radio" ${attr}="${key}" aria-checked="${on}"><span class="box"></span>${label}</button>`;
const sheetHead = (title, sub, eyebrow = "") => `<div class="grabber"></div><div class="sheet-head"><div>${eyebrow ? `<span class="eyebrow">${eyebrow}</span>` : ""}<h2>${title}</h2><p>${sub}</p></div>${closeButton}</div>`;
const nextFields = (label, placeholder, sheet) => `<div class="field-row"><label class="field"><span>${label}</span><input data-sheet="nextAction" maxlength="500" placeholder="${placeholder}" value="${esc(sheet.nextAction)}"></label>`
  + `<label class="field"><span>Due date</span><input type="date" data-sheet="nextDue" value="${esc(sheet.nextDue)}"></label></div>`;
function sheetMarkup(sheet) {
  const app = byId(sheet.id);
  const busy = state.busy ? " disabled" : "";
  const error = sheet.error ? `<p class="status-line error" role="alert">${esc(sheet.error)}</p>` : "";
  if (sheet.kind === "response" && app) {
    const rejected = sheet.stage === "rejected";
    return `${sheetHead("Record a response", `${esc(app.company)} · ${esc(app.role)}`, "An update from them")}<div class="sheet-body">
        <div class="sheet-label first">What did you hear?</div>${RESPONSES.map(([key, label]) => radio("data-resp", key, label, sheet.stage === key)).join("")}
        ${rejected ? "" : nextFields("Next action", "Optional", sheet)}
        <p class="field-hint">A submission confirmation? No update needed — keep it in Submitted.</p>${error}</div>
        <div class="sheet-foot"><button class="btn primary block" type="button" data-act="commit-response"${busy}>${rejected ? "Close as rejected" : `Move to ${LABELS[sheet.stage]}`}</button></div>`;
  }
  if (sheet.kind === "complete" && app) {
    const waiting = `<label class="field"><span>Waiting for</span><input data-sheet="waitingFor" maxlength="500" placeholder="e.g. Assessment results (optional)" value="${esc(sheet.waitingFor)}"></label>`;
    return `${sheetHead("What happens next?", `${esc(app.nextAction)} · ${esc(app.company)}`, "One thing done")}<div class="sheet-body">
        ${[["waiting", "Waiting on company"], ["action", "I have another task"]].map(([mode, label]) => radio("data-complete-mode", mode, label, sheet.mode === mode)).join("")}
        ${sheet.mode === "waiting" ? waiting : nextFields("Next task", "What happens next?", sheet)}${error}</div>
        <div class="sheet-foot"><button class="btn primary block" type="button" data-act="commit-complete"${busy}>Complete task</button></div>`;
  }
  if (sheet.kind === "close" && app) {
    return `${sheetHead("Close application", `${esc(app.company)} · ${esc(app.role)}`)}<div class="sheet-body"><div class="sheet-label first">Outcome</div>
        ${Object.entries(REASONS).map(([key, label]) => radio("data-close-reason", key, label, sheet.reason === key)).join("")}${error}</div>
        <div class="sheet-foot"><button class="btn primary block" type="button" data-act="commit-close"${sheet.reason && !state.busy ? "" : " disabled"}>Close application</button></div>`;
  }
  if (sheet.kind === "add") {
    const value = key => esc(sheet[key] || "");
    return `<div class="grabber"></div><div class="sheet-head"><h2>Add application</h2>${closeButton}</div><div class="sheet-body">
        <label class="field first"><span>Company</span><input data-sheet="company" maxlength="200" autocomplete="organization" value="${value("company")}"></label><label class="field"><span>Role</span><input data-sheet="role" maxlength="500" value="${value("role")}"></label>
        <label class="field"><span>Date submitted</span><input type="date" data-sheet="submittedAt" value="${value("submittedAt")}" max="${today()}"></label><label class="field"><span>Location</span><input data-sheet="location" maxlength="200" placeholder="Optional" value="${value("location")}"></label>
        <label class="field"><span>Posting URL</span><input data-sheet="url" type="url" maxlength="2000" placeholder="https://" inputmode="url" autocapitalize="off" value="${value("url")}"></label><label class="field"><span>Notes</span><textarea data-sheet="notes" placeholder="Optional" maxlength="8000">${value("notes")}</textarea></label>${error}</div>
        <div class="sheet-foot"><button class="btn" type="button" data-act="close-sheet">Cancel</button><button class="btn primary grow" type="button" data-act="commit-add"${busy}>Add application</button></div>`;
  }
  return "";
}

/* ───────────── Actions ───────────── */
function switchView(view) {
  state.view = view; state.selecting = false; state.selected = new Set();
  remember(); bump(); P.render();
  P.els.page.scrollTop = 0;
}
function openApp(id) {
  S.push = { kind: "app", id: String(id), draft: {} };
  P.render();
  // The page opens on the latest record, events included, as on desktop.
  api.applications.get(id).then(raw => {
    const fresh = fromAPI(raw);
    if (state.busy || JSON.stringify(fresh) === JSON.stringify(byId(id))) return;
    replaceApp(state.apps, fresh); bump(); P.render();
  }).catch(() => {});
}
// After a sheet saves, the page under it shows the saved record.
function sheetSaved() {
  S.sheet = null;
  if (S.push?.kind === "app") S.push = { ...S.push, draft: {} };
}
async function move(stage) {
  const app = byId(S.push.id);
  if (!app || app.stage === stage || state.busy) return;
  await commit([app.id], moveTo(app, stage));
}
async function saveApp() {
  const push = S.push, app = byId(push.id);
  if (!app) return;
  const changes = Object.fromEntries(detailFields(app).map(key => [key, String(push.draft[key] ?? app[key] ?? "").trim()]));
  if (changes.taskState === "waiting") { changes.nextAction = ""; changes.nextDue = ""; }
  else changes.waitingFor = "";
  if (app.external && (!changes.company || !changes.role)) { S.push = { ...push, error: "Enter a name." }; return P.render(); }
  if (changes.url && !safeUrl(changes.url)) { S.push = { ...push, error: "Enter a full posting URL, starting with https://" }; return P.render(); }
  if (!hasChanges(app, changes)) { S.push = null; return P.render(); }
  if (await commit([app.id], editDetails(app, changes))) { S.push = null; P.render(); }
}
async function commitResponse() {
  const sheet = S.sheet, app = byId(sheet.id);
  if (!app) return;
  if (!await commit([app.id], respond(app, sheet.stage, String(sheet.nextAction || "").trim(), sheet.nextDue || ""))) return;
  sheetSaved();
  if (sheet.stage === "rejected") return P.render();
  state.filters.pipeline.query = "";
  switchView("pipeline");
}
async function commitComplete() {
  const sheet = S.sheet, app = byId(sheet.id);
  if (!app || !inPipeline(app) || waitingOnCompany(app) || !app.nextAction) return;
  const nextAction = String(sheet.nextAction || "").trim();
  if (sheet.mode === "action" && !nextAction) { S.sheet = { ...sheet, error: "Enter the next task." }; return P.render(); }
  const change = completeTask(app, sheet.mode, { nextAction, nextDue: sheet.nextDue || "", waitingFor: String(sheet.waitingFor || "").trim() });
  if (!await commit([app.id], change)) return;
  sheetSaved();
  P.render();
}
async function commitClose() {
  const sheet = S.sheet, app = byId(sheet.id);
  if (!app || app.stage === "closed" || !REASONS[sheet.reason]) return;
  if (!await commit([app.id], closeAs(app, sheet.reason))) return;
  sheetSaved();
  P.render();
}
async function restoreApp(id) {
  const app = byId(id);
  if (!app || app.stage !== "closed") return;
  const change = restore(app);
  if (!await commit([app.id], change)) return;
  S.push = null;
  switchView(viewFor(change.stage));
}
async function commitAdd() {
  const sheet = S.sheet;
  const text = key => String(sheet[key] || "").trim();
  const invalid = !text("company") || !text("role") ? "Enter a name."
    : !validDay(text("submittedAt")) ? "Choose the date you submitted it."
    : text("url") && !safeUrl(text("url")) ? "Enter a full posting URL, starting with https://" : "";
  if (invalid) { S.sheet = { ...sheet, error: invalid }; return P.render(); }
  state.busy = true; P.render();
  try {
    const app = fromAPI(await api.applications.createExternal(externalPayload(text)));
    state.apps.unshift(app);
    state.busy = false;
    S.sheet = null; state.filters.sent.query = ""; state.filters.sent.age = "all"; shownView = null;
    switchView("sent");
    P.toast(`${app.company} added to Submitted.`);
  } catch (error) {
    state.busy = false;
    S.sheet = { ...sheet, error: `Could not add application. ${error.message}` }; P.render();
  }
}
async function bulkClose() {
  const ids = [...state.selected].filter(id => byId(id)?.stage === "sent");
  if (!ids.length) return;
  if (await commit(ids, closeNoReply(plural(ids.length, "application")))) { state.selecting = false; state.selected = new Set(); bump(); P.render(); }
}
async function tailor(id) {
  const app = byId(id);
  if (!app || state.busy) return;
  state.busy = true; P.render();
  try { location.assign(resumeLink(await api.resumes.targetFromApplication(app.id))); }
  catch (error) { P.toast(error.message || "Could not open a resume for this application."); }
  finally { state.busy = false; P.render(); }
}

function onClick(target, d) {
  if (state.busy && !d.act?.startsWith("close")) return;
  if (d.view) { if (d.view !== state.view) switchView(d.view); return; }
  if (d.app) return openApp(d.app);
  if (d.complete) { S.sheet = { kind: "complete", id: byId(d.complete).id, mode: "action", nextAction: "", nextDue: "", waitingFor: "" }; return P.render(); }
  if (d.completeMode) { S.sheet = { ...S.sheet, mode: d.completeMode, error: null }; return P.render(); }
  if (d.pick) { state.selected.has(d.pick) ? state.selected.delete(d.pick) : state.selected.add(d.pick); bump(); return P.render(); }
  if (d.page) { state.page[state.view] += Number(d.page); bump(); P.render(); P.els.page.scrollTop = 0; return; }
  if (d.move) return move(d.move);
  if (d.taskState) { S.push = { ...S.push, draft: { ...S.push.draft, taskState: d.taskState } }; return P.render(); }
  if (d.resp) { S.sheet = { ...S.sheet, stage: d.resp }; return P.render(); }
  if (d.closeReason) { S.sheet = { ...S.sheet, reason: d.closeReason }; return P.render(); }
  switch (d.act) {
    case "retry": state.error = ""; state.loading = true; P.render(); return load();
    case "week-prev": state.week -= 1; bump(); return P.render();
    case "week-next": state.week += 1; bump(); return P.render();
    case "toggle-overdue": state.overdueOpen = !state.overdueOpen; bump(); return P.render();
    case "select-start": state.selecting = true; bump(); return P.render();
    case "select-done": state.selecting = false; state.selected = new Set(); bump(); return P.render();
    case "select-clear": state.selected = new Set(); bump(); return P.render();
    case "select-page":
      paginate(visibleApplications(state.apps, "sent", state.filters.sent), state.page.sent).items.forEach(app => state.selected.add(app.id));
      bump(); return P.render();
    case "bulk-close": return bulkClose();
    case "add-app": S.sheet = { kind: "add", submittedAt: today() }; return P.render();
    case "commit-add": return commitAdd();
    case "response": {
      const app = byId(d.id);
      S.sheet = { kind: "response", id: app.id, stage: "replied", nextAction: app.nextAction || "", nextDue: app.nextDue || "" };
      return P.render();
    }
    case "commit-response": return commitResponse();
    case "commit-complete": return commitComplete();
    case "close-app": S.sheet = { kind: "close", id: String(d.id) }; return P.render();
    case "commit-close": return commitClose();
    case "restore-app": return restoreApp(d.id);
    case "save-app": return saveApp();
    case "tailor": return tailor(d.id);
  }
}

function wire() {
  const host = P.els.app;
  host.addEventListener("input", event => {
    const el = event.target;
    if (el.id === "aq") {
      state.filters[state.view].query = el.value; state.page[state.view] = 1; state.selected = new Set();
      bump(); return P.render();
    }
    if (el.dataset.draft && S.push?.kind === "app") S.push.draft[el.dataset.draft] = el.value;
    if (el.dataset.sheet && S.sheet) S.sheet[el.dataset.sheet] = el.value;
  });
  host.addEventListener("change", event => {
    const el = event.target;
    if (!el.dataset.select) return;
    state.filters[state.view][el.dataset.select] = el.value; state.page[state.view] = 1; state.selected = new Set();
    bump(); P.render();
  });
  host.addEventListener("submit", event => {
    if (!event.target.matches("[data-search-form]")) return;
    event.preventDefault();
    $("#aq").blur();
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load({ quiet: true }); });
  addEventListener("storage", async event => {
    if (event.key === "oneshot.visitor-data.state.v1" && await guest.isLocal()) load({ quiet: true });
  });
}

P.start({
  tab: "applied",
  paint,
  selectBar,
  renderPush: appPage,
  renderSheet: sheetMarkup,
  version: () => state.v + (state.busy ? 0.5 : 0),
  // Typed values stay out of these signatures; only structure redraws.
  pushSig: push => JSON.stringify([push.kind, push.id, push.draft.taskState, push.error, state.v, state.busy]),
  sheetSig: sheet => JSON.stringify([sheet.kind, sheet.id, sheet.stage, sheet.mode, sheet.reason, sheet.error, state.busy, state.v]),
  onClick,
  start: () => { wire(); load(); },
});

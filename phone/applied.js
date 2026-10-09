/* Applied on phones: the desktop tracker's tabs, agenda, board, tables and
   drawer, laid out for a narrow screen. Records map to and from the API with
   the desktop tracker's own fromAPI/toAPI (application/app.js). */
(function (root) {
  "use strict";
  const P = root.OneShotPhoneShell;
  const K = root.OneShotAppliedKit;
  const { esc, icon, S, plural, today } = P;
  const api = () => root.OneShotAPI;

  const PAGE_SIZE = 50;
  const DAY = 86400000;
  const OPEN = ["replied", "assessment", "interview", "offer"];
  const TRACK = ["sent", ...OPEN];
  const LABELS = K.LABELS;
  const REASONS = K.REASONS;
  const STAGE_COLORS = { replied: "#859584", assessment: "#C49A3A", interview: "#4F7FA8", offer: "#1E5C42" };
  const RESPONSES = [["replied", "Recruiter reply"], ["assessment", "Assessment invitation"], ["interview", "Interview invitation"], ["offer", "Offer"], ["rejected", "Rejection"]];
  const SORTS = [["next", "Next action first"], ["recent", "Recently updated"], ["newest", "Newest submitted"], ["oldest", "Oldest submitted"], ["company", "Company A–Z"]];
  const VIEWS = [["progress", "In progress"], ["submitted", "Submitted"], ["closed", "Closed"]];
  const PLACEHOLDER = { progress: "Search tasks, companies, or roles…", submitted: "Find a submitted application…", closed: "Search closed applications…" };
  const STORE = "oneshot.phone.applied";

  const saved = (() => { try { return JSON.parse(root.sessionStorage.getItem(STORE)) || {}; } catch (_) { return {}; } })();
  const state = {
    apps: [], loading: true, error: "", busy: false,
    view: VIEWS.some(([key]) => key === saved.view) ? saved.view : "progress",
    q: { progress: "", submitted: "", closed: "" },
    age: "all", sentSort: "newest", outcome: "all", closedSort: "recent",
    page: { submitted: 1, closed: 1 },
    week: 0, overdueOpen: false, selecting: false, selected: new Set(), v: 0,
  };
  const bump = () => { state.v += 1; };
  const remember = () => { try { root.sessionStorage.setItem(STORE, JSON.stringify({ view: state.view })); } catch (_) { /* private mode */ } };
  const clone = value => JSON.parse(JSON.stringify(value));
  const byId = id => state.apps.find(app => app.id === String(id));

  /* ───────────── Dates, as the desktop tracker counts them ───────────── */
  const dayIndex = day => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY);
  const validDay = K.validDay;
  const dueDays = app => validDay(app.nextDue) ? dayIndex(app.nextDue) - dayIndex(today()) : Infinity;
  const waitDays = app => validDay(app.submittedAt) ? Math.max(0, dayIndex(today()) - dayIndex(app.submittedAt)) : null;
  const formatDay = (day, year = false) => validDay(day) ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" }).format(new Date(dayIndex(day) * DAY)) : "—";
  const inPipeline = app => OPEN.includes(app.stage);
  const waiting = app => app.taskState === "waiting";
  const viewOf = app => app.stage === "sent" ? "submitted" : app.stage === "closed" ? "closed" : "progress";
  const matches = (app, query) => !query.trim() || `${app.company} ${app.role} ${app.location || ""} ${app.nextAction || ""} ${app.waitingFor || ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const agendaItems = () => state.apps.filter(app => inPipeline(app) && !waiting(app) && app.nextAction.trim() && validDay(app.nextDue));
  const openTasks = () => agendaItems().filter(app => dueDays(app) <= 0).length;
  const safeUrl = value => { try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : ""; } catch (_) { return ""; } };
  const logo = company => `<div class="logo sm">${esc(P.initials(company))}</div>`;

  function sortApps(list, key) {
    return list.slice().sort((a, b) => {
      if (key === "company") return a.company.localeCompare(b.company) || a.role.localeCompare(b.role) || a.id.localeCompare(b.id);
      if (key === "oldest") return a.submittedAt.localeCompare(b.submittedAt) || a.id.localeCompare(b.id);
      if (key === "newest") return b.submittedAt.localeCompare(a.submittedAt) || a.id.localeCompare(b.id);
      const recent = String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.id.localeCompare(b.id);
      return key === "next" ? (dueDays(a) - dueDays(b) || recent) : recent;
    });
  }

  /* ───────────── Data ───────────── */
  async function load({ quiet = false } = {}) {
    if (state.busy || (quiet && (S.sheet || S.push))) return;
    if (!quiet) { state.loading = !state.apps.length; state.error = ""; P.render(); }
    try {
      const result = await api().applications.list();
      state.apps = (result.applications || []).map(K.fromAPI);
      state.error = "";
    } catch (error) { if (!quiet || !state.apps.length) state.error = error.message || "Could not load applications."; }
    state.loading = false;
    bump(); P.setBadge(openTasks()); P.render();
  }
  function replace(app) {
    const index = state.apps.findIndex(item => item.id === app.id);
    if (index >= 0) state.apps[index] = app;
  }
  function addEvent(app, text) {
    app.updatedAt = new Date().toISOString();
    app.events.unshift({ at: app.updatedAt, text });
  }
  function setStage(app, stage, reason = null) {
    if (stage === "closed") { if (app.stage !== "closed") app.lastOpenStage = app.stage; app.closedReason = reason; }
    else { app.closedReason = null; app.lastOpenStage = stage; }
    app.stage = stage;
    addEvent(app, stage === "closed" ? `Closed · ${REASONS[reason]}` : `Moved to ${LABELS[stage]}`);
  }
  // Every change goes through here, as on desktop: saved per record, six at a
  // time, then a toast whose Undo writes the old records back.
  async function commit(ids, apply, message, undoable = true) {
    if (state.busy) return false;
    const before = [...new Set(ids)].map(byId).filter(Boolean).map(clone);
    state.busy = true; P.render();
    const succeeded = [], failed = [];
    for (let cursor = 0; cursor < before.length; cursor += 6) {
      await Promise.all(before.slice(cursor, cursor + 6).map(async old => {
        const desired = clone(old); apply(desired);
        try { replace(K.fromAPI(await api().applications.update(old.id, K.toAPI(desired, desired.events[0]?.text)))); succeeded.push(old); }
        catch (error) { failed.push({ old, error }); }
      }));
    }
    state.busy = false; bump(); P.setBadge(openTasks()); P.render();
    if (failed.length && !succeeded.length) { P.toast(failed[0].error.message || "Could not save."); return false; }
    const feedback = failed.length ? `${succeeded.length} updated; ${failed.length} could not be saved. ${failed[0].error.message}` : message;
    P.toast(feedback, undoable && succeeded.length ? [{ label: "Undo", run: async () => {
      if (state.busy) return;
      state.busy = true; P.render();
      const undoFailed = [];
      for (const old of succeeded) {
        try { replace(K.fromAPI(await api().applications.update(old.id, K.toAPI(old, "Change undone")))); }
        catch (error) { undoFailed.push(error); }
      }
      state.busy = false; bump(); P.setBadge(openTasks()); P.render();
      P.toast(undoFailed.length ? `${undoFailed.length} changes could not be undone. ${undoFailed[0].message}` : "Change undone.");
    } }] : []);
    return !failed.length;
  }

  /* ───────────── In progress ───────────── */
  function dueTag(app) {
    if (waiting(app)) return '<span class="due-tag waiting">Waiting</span>';
    const days = dueDays(app);
    const text = days === Infinity ? "No deadline" : days < 0 ? `${-days}d overdue` : days === 0 ? "Due today" : days === 1 ? "Tomorrow" : formatDay(app.nextDue);
    const cls = days === Infinity ? "" : days < 0 ? "overdue" : days <= 1 ? "soon" : "";
    return `<span class="due-tag ${cls}"${validDay(app.nextDue) ? ` title="${esc(formatDay(app.nextDue, true))}"` : ""}>${esc(text)}</span>`;
  }
  function agendaMarkup(query) {
    const todayKey = today(), todayIndex = dayIndex(todayKey);
    const weekday = new Date(todayIndex * DAY).getUTCDay();
    const start = todayIndex - (weekday + 6) % 7 + state.week * 7;
    const dayAt = offset => new Date((start + offset) * DAY).toISOString().slice(0, 10);
    const first = dayAt(0), last = dayAt(6);
    const range = first.slice(0, 7) === last.slice(0, 7) ? `${formatDay(first)}–${Number(last.slice(8))}` : `${formatDay(first)}–${formatDay(last)}`;
    const zone = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(new Date()).find(part => part.type === "timeZoneName")?.value || "";
    const items = agendaItems().filter(app => matches(app, query)).sort((a, b) => a.nextDue.localeCompare(b.nextDue) || a.nextAction.localeCompare(b.nextAction));
    const overdue = state.week === 0 ? items.filter(app => dueDays(app) < 0) : [];
    const dated = items.filter(app => dayIndex(app.nextDue) >= Math.max(start, todayIndex) && dayIndex(app.nextDue) < start + 7);
    const companies = new Map();
    agendaItems().forEach(app => { const key = app.company.trim().toLocaleLowerCase(); companies.set(key, (companies.get(key) || 0) + 1); });
    const row = app => {
      const late = -dueDays(app);
      const identity = companies.get(app.company.trim().toLocaleLowerCase()) > 1 ? `${app.company} · ${app.role}` : app.company;
      return `<div class="task"><button class="tick" type="button" data-complete="${esc(app.id)}" aria-label="${esc(`Complete task: ${app.nextAction} at ${app.company}`)}"><i>${icon("check")}</i></button><button type="button" class="task-main" data-app="${esc(app.id)}"><b>${esc(app.nextAction)}</b><span>${esc(identity)}${late > 0 ? ` · <em class="od">${late}d overdue</em>` : ""}</span></button></div>`;
    };
    const days = [...new Set([...dated.map(app => app.nextDue), ...(overdue.length ? [todayKey] : [])])].sort();
    const html = days.map(day => {
      const label = `${new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(dayIndex(day) * DAY))} ${Number(day.slice(8))}`;
      const fold = day === todayKey && overdue.length
        ? overdue.length === 1 ? row(overdue[0]) : `<button class="od-toggle" type="button" data-act="toggle-overdue" aria-expanded="${state.overdueOpen}">${icon("chev")}${overdue.length} overdue</button>${state.overdueOpen ? overdue.map(row).join("") : ""}`
        : "";
      return `<div class="day-label">${day === todayKey ? "Today · " : ""}${esc(label)}</div>${fold}${dated.filter(app => app.nextDue === day).map(row).join("")}`;
    }).join("");
    return `<div class="section-h agenda-h"><h2>Agenda</h2><span class="week-nav"><button class="icon-btn sm" type="button" data-act="week-prev" aria-label="Previous week">${icon("back")}</button><span>${esc(range)}${zone ? ` · ${esc(zone)}` : ""}</span><button class="icon-btn sm" type="button" data-act="week-next" aria-label="Next week">${icon("chev")}</button></span></div>
      ${html || `<p class="agenda-empty">${query.trim() ? "No matching items this week." : "Nothing scheduled this week."}</p>`}`;
  }
  const stageCard = app => `<button class="app-row stage-card" type="button" data-app="${esc(app.id)}"><span style="min-width:0"><b>${esc(app.company)} · ${esc(app.role)}</b><span class="task-line${waiting(app) ? " waiting" : ""}">${esc(waiting(app) ? app.waitingFor || "Waiting on company" : app.nextAction || "Set a next step")}</span></span><span class="end">${dueTag(app)}${icon("chev")}</span></button>`;
  function progressMarkup(query) {
    const list = sortApps(state.apps.filter(app => inPipeline(app) && matches(app, query)), "next");
    return agendaMarkup(query) + OPEN.map(stage => {
      const items = list.filter(app => app.stage === stage);
      return `<div class="section-h"><h2><span class="stage-dot" style="background:${STAGE_COLORS[stage]}"></span>${LABELS[stage]}</h2><small>${items.length}</small></div>${items.length ? `<div class="card-list">${items.map(stageCard).join("")}</div>` : `<p class="stage-empty">Nothing in ${LABELS[stage]}.</p>`}`;
    }).join("") + '<div style="height:24px"></div>';
  }

  /* ───────────── Submitted and Closed ───────────── */
  const selectChip = (key, label, value, options) => `<label class="select-chip"><select data-select="${key}" aria-label="${esc(label)}">${options.map(([v, l]) => `<option value="${v}"${v === value ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>${icon("down")}</label>`;
  function listRow(app, end, sub) {
    if (state.selecting) {
      const on = state.selected.has(app.id);
      return `<button class="app-row selectable${on ? " is-selected" : ""}" type="button" data-pick="${esc(app.id)}" aria-pressed="${on}"><span class="row-pick"><i>${icon("check")}</i></span><span style="min-width:0"><b>${esc(app.role)}</b><span class="sub">${esc(app.company)} · ${esc(sub)}</span></span><span class="end">${end}</span></button>`;
    }
    return `<button class="app-row" type="button" data-app="${esc(app.id)}">${logo(app.company)}<span style="min-width:0"><b>${esc(app.role)}</b><span class="sub">${esc(app.company)} · ${esc(sub)}</span></span><span class="end">${end}${icon("chev")}</span></button>`;
  }
  function pageOf(list, view) {
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    state.page[view] = Math.min(Math.max(1, state.page[view]), pages);
    const start = (state.page[view] - 1) * PAGE_SIZE;
    const items = list.slice(start, start + PAGE_SIZE);
    const pager = `<div class="pager"><span>${list.length ? `${(start + 1).toLocaleString()}–${Math.min(start + PAGE_SIZE, list.length).toLocaleString()} of ${plural(list.length, "application")}` : "0 applications"}</span><span class="pager-btns"><button class="btn small" type="button" data-page="-1"${state.page[view] === 1 ? " disabled" : ""}>Previous</button><span>${state.page[view]} / ${pages}</span><button class="btn small" type="button" data-page="1"${state.page[view] >= pages ? " disabled" : ""}>Next</button></span></div>`;
    return { items, pager };
  }
  function submittedList() {
    const band = { all: () => true, 7: days => days !== null && days < 7, 30: days => days !== null && days >= 30 }[state.age];
    return sortApps(state.apps.filter(app => app.stage === "sent" && band(waitDays(app)) && matches(app, state.q.submitted)), state.sentSort);
  }
  function submittedMarkup() {
    const all = state.apps.filter(app => app.stage === "sent");
    const list = submittedList();
    const { items, pager } = pageOf(list, "submitted");
    const tools = state.selecting
      ? `<div class="tool-row select-tools"><b>${state.selected.size.toLocaleString()} selected</b><button class="link-btn" type="button" data-act="select-page">Select page</button><button class="link-btn" type="button" data-act="select-clear">Clear</button><button class="link-btn end" type="button" data-act="select-done">Done</button></div>`
      : `<div class="tool-row">${selectChip("age", "Filter by time waiting", state.age, [["all", "All wait times"], ["7", "Submitted in the last 7 days"], ["30", "30+ days waiting"]])}${selectChip("sentSort", "Sort applications", state.sentSort, SORTS)}<button class="link-btn end" type="button" data-act="select-start"${all.length ? "" : " disabled"}>${icon("select")}Select</button></div>`;
    const filtered = list.length !== all.length;
    const wait = app => { const days = waitDays(app); return `<span class="wait${days >= 30 ? " quiet" : ""}">${days === null ? "—" : days === 0 ? "Today" : days === 1 ? "1 day" : `${days} days`}</span>`; };
    return tools + (filtered ? `<div class="result-count">${list.length.toLocaleString()} of ${all.length.toLocaleString()}</div>` : "")
      + (items.length ? `<div class="list-flat">${items.map(app => listRow(app, wait(app), formatDay(app.submittedAt))).join("")}</div>` : `<div class="empty">${filtered ? "No matching applications." : "No submitted applications yet."}</div>`)
      + pager + (state.selecting ? '<div class="select-gap"></div>' : "");
  }
  function closedMarkup() {
    const all = state.apps.filter(app => app.stage === "closed");
    const list = sortApps(all.filter(app => (state.outcome === "all" || app.closedReason === state.outcome) && matches(app, state.q.closed)), state.closedSort);
    const { items, pager } = pageOf(list, "closed");
    const filtered = list.length !== all.length;
    return `<div class="tool-row">${selectChip("outcome", "Filter by outcome", state.outcome, [["all", "All outcomes"], ...Object.entries(REASONS)])}${selectChip("closedSort", "Sort applications", state.closedSort, SORTS)}</div>`
      + (filtered ? `<div class="result-count">${list.length.toLocaleString()} of ${all.length.toLocaleString()}</div>` : "")
      + (items.length ? `<div class="list-flat">${items.map(app => listRow(app, `<span class="outcome ${esc(app.closedReason)}">${esc(REASONS[app.closedReason] || "Closed")}</span>`, `last stage ${LABELS[app.lastOpenStage] || "Submitted"}`)).join("")}</div>` : `<div class="empty">${filtered ? "No matching applications." : "No closed applications."}</div>`)
      + pager;
  }

  let built = false, shownView = null;
  function paint(page) {
    if (!built) {
      page.innerHTML = `${P.head("Applied", `<button class="icon-btn" type="button" data-act="add-app" aria-label="Add application">${icon("plus")}</button>`)}
        <div class="sticky" id="applied-sticky"><div class="segmented" role="tablist" aria-label="Applications" id="applied-tabs"></div>
        <div class="search-row slim"><form class="search" role="search" data-search-form><svg aria-hidden="true"><use href="#ph-search"/></svg><input id="aq" type="search" enterkeyhint="search" autocomplete="off" autocorrect="off" spellcheck="false"></form></div></div><div id="applied-body"></div>`;
      built = true;
    }
    const counts = { progress: state.apps.filter(inPipeline).length, submitted: state.apps.filter(app => app.stage === "sent").length, closed: state.apps.filter(app => app.stage === "closed").length };
    P.region(page.querySelector("#applied-tabs"), VIEWS.map(([key, label]) => `<button type="button" role="tab" data-view="${key}" aria-selected="${state.view === key}">${label}<small>${counts[key]}</small></button>`).join(""));
    const input = page.querySelector("#aq");
    if (shownView !== state.view) {
      input.placeholder = PLACEHOLDER[state.view];
      input.setAttribute("aria-label", PLACEHOLDER[state.view]);
      input.value = state.q[state.view];
      shownView = state.view;
    }
    const body = page.querySelector("#applied-body");
    body.setAttribute("aria-busy", String(state.busy));
    P.region(body, state.loading ? P.stateBlock("loading", { title: "Loading applications…" })
      : state.error ? P.stateBlock("error", { title: "Could not load applications", detail: state.error })
      : state.view === "progress" ? progressMarkup(state.q.progress)
      : state.view === "submitted" ? submittedMarkup() : closedMarkup());
  }
  function selectBar() {
    if (!state.selecting || state.view !== "submitted" || S.push) return "";
    const n = state.selected.size;
    return `<button class="btn primary block" type="button" data-act="bulk-close"${n && !state.busy ? "" : " disabled"}>Close as no reply${n ? ` (${n.toLocaleString()})` : ""}</button>`;
  }

  /* ───────────── Application page ───────────── */
  function appPage(push) {
    const app = byId(push.id);
    if (!app) return `<header class="push-bar scrolled"><button class="back" type="button" data-act="back">${icon("back")}Applied</button><span class="push-title"></span><span class="bar-spacer"></span></header><div class="push-scroll"><div class="empty"><strong>This application is gone</strong>Go back to Applied.</div></div>`;
    const d = { ...app, ...push.draft };
    const closed = app.stage === "closed", index = TRACK.indexOf(app.stage), lock = app.external ? "" : " disabled";
    const mine = d.taskState !== "waiting";
    const url = safeUrl(app.url);
    const field = (key, label, extra = "") => `<label class="field"><span>${label}</span><input data-draft="${key}" value="${esc(d[key] || "")}"${extra}></label>`;
    const quick = [
      app.stage === "sent" ? `<button class="btn" type="button" data-act="response" data-id="${esc(app.id)}">${icon("mail")}Record response</button>` : "",
      inPipeline(app) && !waiting(app) && app.nextAction ? `<button class="btn" type="button" data-complete="${esc(app.id)}">${icon("check")}Complete task</button>` : "",
      `<button class="btn" type="button" data-act="tailor" data-id="${esc(app.id)}">${icon("file")}Tailor resume</button>`,
      url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Posting${icon("out")}</a>` : "",
    ].join("");
    const move = closed
      ? `<div class="sheet-label">Stage</div><p style="margin:0"><span class="outcome ${esc(app.closedReason)}">${esc(REASONS[app.closedReason] || "Closed")}</span> <span class="muted">· last stage ${LABELS[app.lastOpenStage] || "Submitted"}</span></p>`
      : `<div class="sheet-label">Stage</div><div class="stage-track">${TRACK.map((stage, i) => `<button type="button" data-move="${stage}" class="${i < index ? "past" : i === index ? "current" : ""}" aria-pressed="${i === index}"${state.busy ? " disabled" : ""}>${LABELS[stage]}</button>`).join("")}</div>
        <div class="sheet-label">Whose move?</div><div class="segmented inline" role="radiogroup">${[["action", "Mine · I have a task"], ["waiting", "Company · waiting"]].map(([value, label]) => `<button type="button" role="radio" data-task-state="${value}" aria-selected="${(mine ? "action" : "waiting") === value}">${label}</button>`).join("")}</div>
        ${mine ? `<div class="field-row"><label class="field"><span>Next task</span><input data-draft="nextAction" maxlength="500" value="${esc(d.nextAction)}" placeholder="What happens next?"></label><label class="field"><span>Due date</span><input type="date" data-draft="nextDue" value="${esc(d.nextDue)}"></label></div>`
          : `<label class="field"><span>Waiting for</span><input data-draft="waitingFor" maxlength="500" value="${esc(d.waitingFor)}" placeholder="Optional context"></label>`}`;
    return `<header class="push-bar scrolled"><button class="back" type="button" data-act="back">${icon("back")}Applied</button><span class="push-title">${esc(app.company)}</span><span class="bar-spacer"></span></header>
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
        <div class="sheet-label">Activity</div><ul class="history">${app.events.map(event => `<li>${esc(String(event.text).replace(/\bSent\b/g, "Submitted"))}<time>${esc(formatDay(String(event.at).slice(0, 10), true))}</time></li>`).join("") || '<li>No activity yet.<time></time></li>'}</ul>
        <div class="danger-zone">${closed ? `<button class="btn block" type="button" data-act="restore-app" data-id="${esc(app.id)}">${icon("undo")}Restore to ${LABELS[app.lastOpenStage] || "Submitted"}</button>` : `<button class="btn block danger" type="button" data-act="close-app" data-id="${esc(app.id)}">Close application</button>`}</div>
      </div></div>
      <footer class="action-bar"><button class="btn primary block" type="button" data-act="save-app" data-id="${esc(app.id)}"${state.busy ? " disabled" : ""}>Save changes</button></footer>`;
  }

  /* ───────────── Sheets ───────────── */
  const closeButton = `<button class="icon-btn" type="button" data-act="close-sheet" aria-label="Close">${icon("x")}</button>`;
  function sheetMarkup(sheet) {
    const app = byId(sheet.id);
    const busy = state.busy ? " disabled" : "";
    const error = sheet.error ? `<p class="status-line error" role="alert">${esc(sheet.error)}</p>` : "";
    if (sheet.kind === "response" && app) {
      const rejected = sheet.stage === "rejected";
      return `<div class="grabber"></div><div class="sheet-head"><div><span class="eyebrow">An update from them</span><h2>Record a response</h2><p>${esc(app.company)} · ${esc(app.role)}</p></div>${closeButton}</div><div class="sheet-body">
        <div class="sheet-label first">What did you hear?</div>${RESPONSES.map(([key, label]) => `<button class="opt radio" type="button" role="radio" data-resp="${key}" aria-checked="${sheet.stage === key}"><span class="box"></span>${label}</button>`).join("")}
        ${rejected ? "" : `<div class="field-row"><label class="field"><span>Next action</span><input data-sheet="nextAction" maxlength="500" placeholder="Optional" value="${esc(sheet.nextAction)}"></label><label class="field"><span>Due date</span><input type="date" data-sheet="nextDue" value="${esc(sheet.nextDue)}"></label></div>`}
        <p class="field-hint">A submission confirmation? No update needed — keep it in Submitted.</p>${error}</div>
        <div class="sheet-foot"><button class="btn primary block" type="button" data-act="commit-response"${busy}>${rejected ? "Close as rejected" : `Move to ${LABELS[sheet.stage]}`}</button></div>`;
    }
    if (sheet.kind === "complete" && app) {
      return `<div class="grabber"></div><div class="sheet-head"><div><span class="eyebrow">One thing done</span><h2>What happens next?</h2><p>${esc(app.nextAction)} · ${esc(app.company)}</p></div>${closeButton}</div><div class="sheet-body">
        ${[["waiting", "Waiting on company"], ["action", "I have another task"]].map(([mode, label]) => `<button class="opt radio" type="button" role="radio" data-complete-mode="${mode}" aria-checked="${sheet.mode === mode}"><span class="box"></span>${label}</button>`).join("")}
        ${sheet.mode === "waiting" ? `<label class="field"><span>Waiting for</span><input data-sheet="waitingFor" maxlength="500" placeholder="e.g. Assessment results (optional)" value="${esc(sheet.waitingFor)}"></label>`
          : `<div class="field-row"><label class="field"><span>Next task</span><input data-sheet="nextAction" maxlength="500" placeholder="What happens next?" value="${esc(sheet.nextAction)}"></label><label class="field"><span>Due date</span><input type="date" data-sheet="nextDue" value="${esc(sheet.nextDue)}"></label></div>`}${error}</div>
        <div class="sheet-foot"><button class="btn primary block" type="button" data-act="commit-complete"${busy}>Complete task</button></div>`;
    }
    if (sheet.kind === "close" && app) {
      return `<div class="grabber"></div><div class="sheet-head"><div><h2>Close application</h2><p>${esc(app.company)} · ${esc(app.role)}</p></div>${closeButton}</div><div class="sheet-body"><div class="sheet-label first">Outcome</div>
        ${Object.entries(REASONS).map(([key, label]) => `<button class="opt radio" type="button" role="radio" data-close-reason="${key}" aria-checked="${sheet.reason === key}"><span class="box"></span>${label}</button>`).join("")}${error}</div>
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
    // The drawer opens on the latest record, events included, as on desktop.
    api().applications.get(id).then(raw => {
      const fresh = K.fromAPI(raw);
      if (state.busy || JSON.stringify(fresh) === JSON.stringify(byId(id))) return;
      replace(fresh); bump(); P.render();
    }).catch(() => {});
  }
  async function moveTo(stage) {
    const app = byId(S.push.id);
    if (!app || app.stage === stage || state.busy) return;
    await commit([app.id], a => {
      if (OPEN.includes(stage) && a.stage === "sent") a.taskState = "action";
      setStage(a, stage);
    }, `${app.company} moved to ${LABELS[stage]}.`);
  }
  async function saveApp() {
    const push = S.push, app = byId(push.id);
    if (!app) return;
    const fields = ["notes", "resumeVariant", "nextAction", "submittedAt", "nextDue", "taskState", "waitingFor", ...(app.external ? ["company", "role", "location", "url"] : [])];
    const changes = Object.fromEntries(fields.map(key => [key, String(push.draft[key] ?? app[key] ?? "").trim()]));
    if (changes.taskState === "waiting") { changes.nextAction = ""; changes.nextDue = ""; }
    else changes.waitingFor = "";
    if (app.external && (!changes.company || !changes.role)) { S.push = { ...push, error: "Enter a name." }; return P.render(); }
    if (changes.url && !safeUrl(changes.url)) { S.push = { ...push, error: "Enter a full posting URL, starting with https://" }; return P.render(); }
    const changed = fields.some(key => changes[key] !== (app[key] || ""));
    if (!changed) { S.push = null; return P.render(); }
    const saved = await commit([app.id], a => { Object.assign(a, changes); addEvent(a, "Application details updated"); }, "Application updated.");
    if (saved) { S.push = null; P.render(); }
  }
  async function commitResponse() {
    const sheet = S.sheet, app = byId(sheet.id);
    if (!app) return;
    const rejected = sheet.stage === "rejected";
    const saved = await commit([app.id], a => {
      if (!rejected) { a.nextAction = String(sheet.nextAction || "").trim(); a.nextDue = sheet.nextDue || ""; a.taskState = "action"; a.waitingFor = ""; }
      setStage(a, rejected ? "closed" : sheet.stage, rejected ? "rejected" : null);
    }, `${app.company} ${rejected ? "closed as rejected" : `moved to ${LABELS[sheet.stage]}`}.`);
    if (!saved) return;
    S.sheet = null;
    if (S.push?.kind === "app") S.push = { ...S.push, draft: {} };
    if (!rejected) { state.q.progress = ""; switchView("progress"); }
    else P.render();
  }
  async function commitComplete() {
    const sheet = S.sheet, app = byId(sheet.id);
    if (!app || !inPipeline(app) || waiting(app) || !app.nextAction) return;
    const another = sheet.mode === "action";
    const next = String(sheet.nextAction || "").trim();
    if (another && !next) { S.sheet = { ...sheet, error: "Enter the next task." }; return P.render(); }
    const done = app.nextAction;
    const saved = await commit([app.id], a => {
      a.taskState = sheet.mode;
      a.nextAction = another ? next : "";
      a.nextDue = another ? sheet.nextDue || "" : "";
      a.waitingFor = another ? "" : String(sheet.waitingFor || "").trim();
      addEvent(a, `Completed: ${done}`);
    }, another ? `${app.company}: task done. Next step added.` : `${app.company}: task done. Waiting on company.`);
    if (!saved) return;
    S.sheet = null;
    if (S.push?.kind === "app") S.push = { ...S.push, draft: {} };
    P.render();
  }
  async function commitClose() {
    const sheet = S.sheet, app = byId(sheet.id);
    if (!app || app.stage === "closed" || !REASONS[sheet.reason]) return;
    const saved = await commit([app.id], a => setStage(a, "closed", sheet.reason), `${app.company} closed as ${REASONS[sheet.reason].toLowerCase()}.`);
    if (!saved) return;
    S.sheet = null;
    if (S.push?.kind === "app") S.push = { ...S.push, draft: {} };
    P.render();
  }
  async function restoreApp(id) {
    const app = byId(id);
    if (!app || app.stage !== "closed") return;
    const stage = app.lastOpenStage || "sent";
    const saved = await commit([app.id], a => { setStage(a, stage); a.events[0].text = `Restored to ${LABELS[stage]}`; }, `${app.company} restored to ${LABELS[stage]}.`);
    if (!saved) return;
    S.push = null;
    switchView(stage === "sent" ? "submitted" : "progress");
  }
  async function commitAdd() {
    const sheet = S.sheet;
    const text = key => String(sheet[key] || "").trim();
    if (!text("company") || !text("role")) { S.sheet = { ...sheet, error: "Enter a name." }; return P.render(); }
    if (!validDay(text("submittedAt"))) { S.sheet = { ...sheet, error: "Choose the date you submitted it." }; return P.render(); }
    if (text("url") && !safeUrl(text("url"))) { S.sheet = { ...sheet, error: "Enter a full posting URL, starting with https://" }; return P.render(); }
    state.busy = true; P.render();
    try {
      const app = K.fromAPI(await api().applications.createExternal({ company: text("company"), title: text("role"), submitted_at: text("submittedAt"), location: text("location"), url: text("url"), note: text("notes") }));
      state.apps.unshift(app);
      state.busy = false;
      S.sheet = null; state.q.submitted = ""; state.age = "all"; shownView = null;
      switchView("submitted");
      P.toast(`${app.company} added to Submitted.`);
    } catch (error) {
      state.busy = false;
      S.sheet = { ...sheet, error: `Could not add application. ${error.message}` }; P.render();
    }
  }
  async function bulkClose() {
    const ids = [...state.selected].filter(id => byId(id)?.stage === "sent");
    if (!ids.length) return;
    const saved = await commit(ids, a => setStage(a, "closed", "no_reply"), `${plural(ids.length, "application")} closed as no reply.`);
    if (saved) { state.selecting = false; state.selected = new Set(); bump(); P.render(); }
  }
  async function tailor(id) {
    const app = byId(id);
    if (!app || state.busy) return;
    state.busy = true; P.render();
    try {
      const target = await api().resumes.targetFromApplication(app.id);
      root.location.assign(`/resume/#target=${encodeURIComponent(target.id)}`);
    } catch (error) { P.toast(error.message || "Could not open a resume for this application."); }
    finally { state.busy = false; P.render(); }
  }

  function onClick(target, d) {
    if (state.busy && !d.act?.startsWith("close")) return;
    if (d.view) { if (d.view !== state.view) switchView(d.view); return; }
    if (d.app) return openApp(d.app);
    if (d.complete) { const app = byId(d.complete); S.sheet = { kind: "complete", id: app.id, mode: "action", nextAction: "", nextDue: "", waitingFor: "" }; return P.render(); }
    if (d.completeMode) { S.sheet = { ...S.sheet, mode: d.completeMode, error: null }; return P.render(); }
    if (d.pick) { state.selected.has(d.pick) ? state.selected.delete(d.pick) : state.selected.add(d.pick); bump(); return P.render(); }
    if (d.page) { state.page[state.view] += Number(d.page); bump(); P.render(); P.els.page.scrollTop = 0; return; }
    if (d.move) return moveTo(d.move);
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
      case "select-page": pageOf(submittedList(), "submitted").items.forEach(app => state.selected.add(app.id)); bump(); return P.render();
      case "bulk-close": return bulkClose();
      case "add-app": S.sheet = { kind: "add", submittedAt: today() }; return P.render();
      case "commit-add": return commitAdd();
      case "response": { const app = byId(d.id); S.sheet = { kind: "response", id: app.id, stage: "replied", nextAction: app.nextAction || "", nextDue: app.nextDue || "" }; return P.render(); }
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
        state.q[state.view] = el.value; state.page[state.view] = 1; state.selected = new Set();
        bump(); return P.render();
      }
      if (el.dataset.draft && S.push?.kind === "app") S.push.draft[el.dataset.draft] = el.value;
      if (el.dataset.sheet && S.sheet) S.sheet[el.dataset.sheet] = el.value;
    });
    host.addEventListener("change", event => {
      const el = event.target;
      if (el.dataset.select) {
        state[el.dataset.select] = el.value; state.page[state.view] = 1; state.selected = new Set();
        bump(); P.render();
      }
    });
    host.addEventListener("submit", event => {
      if (!event.target.matches("[data-search-form]")) return;
      event.preventDefault();
      P.$("#aq").blur();
    });
    root.document.addEventListener("visibilitychange", () => { if (!root.document.hidden) load({ quiet: true }); });
    root.addEventListener("storage", async event => {
      if (event.key === "oneshot.visitor-data.state.v1" && await root.OneShotVisitorData?.isLocal()) load({ quiet: true });
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
})(window);

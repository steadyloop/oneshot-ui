// Applied's logic shared by the desktop page and the phone screens: records,
// calendar days, filters, the agenda week and the change recipes. No DOM.
import { clone, localDay as today } from "../shared/util.js";
import { logoSrc } from "../shared/company-logo.js";

export const PAGE_SIZE = 50;
const DAY = 86400000;

export const OPEN = ["replied", "assessment", "interview", "offer"];
export const STAGES = ["sent", ...OPEN, "closed"];
export const LABELS = { sent: "Submitted", replied: "Replied", assessment: "Assessment", interview: "Interview", offer: "Offer", closed: "Closed" };
export const REASONS = { rejected: "Rejected", withdrawn: "Withdrawn", no_reply: "No reply" };
export const PLACEHOLDERS = {
  pipeline: "Search tasks, companies, or roles…",
  sent: "Find a submitted application…",
  closed: "Search closed applications…",
};
export const initialFilters = () => ({
  pipeline: { query: "", sort: "next" },
  sent: { query: "", sort: "newest", age: "all" },
  closed: { query: "", sort: "recent", outcome: "all" },
});

/* ───────────── Calendar days ───────────── */
// Calendar fields are dates, not instants. UTC arithmetic avoids DST and
// formatting in UTC preserves the day picked by users west of UTC.
export const dayIndex = day => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY);
const dayAt = index => new Date(index * DAY).toISOString().slice(0, 10);
export const validDay = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(dayIndex(value)) && dayAt(dayIndex(value)) === value;
// `locale` undefined is the reader's own; the phone screens pass "en-US".
export const formatDay = (day, year = false, locale) => validDay(day)
  ? new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" }).format(new Date(dayIndex(day) * DAY))
  : "—";
export const zoneName = locale =>
  new Intl.DateTimeFormat(locale, { timeZoneName: "short" }).formatToParts(new Date()).find(part => part.type === "timeZoneName")?.value;

export const age = app => validDay(app.submittedAt) ? Math.max(0, dayIndex(today()) - dayIndex(app.submittedAt)) : null;
export const dueDays = app => validDay(app.nextDue) ? dayIndex(app.nextDue) - dayIndex(today()) : Infinity;
export const waitLabel = days => days === null ? "—" : days === 0 ? "Today" : `${days} ${days === 1 ? "day" : "days"}`;
export function dueLabel(app, locale) {
  const days = dueDays(app);
  if (days < 0) return `${-days}d overdue`;
  return days === 0 ? "Due today" : days === 1 ? "Tomorrow" : days === Infinity ? "No deadline" : formatDay(app.nextDue, false, locale);
}

/* ───────────── Records ───────────── */
export const inPipeline = app => OPEN.includes(app.stage);
export const waitingOnCompany = app => app.taskState === "waiting";
export const viewFor = stage => stage === "sent" || stage === "closed" ? stage : "pipeline";
export function taskGroup(app) {
  if (waitingOnCompany(app)) return "waiting";
  const days = dueDays(app);
  return days < 0 ? "overdue" : days === 0 ? "today" : days === Infinity ? "ready" : "later";
}
export const counts = apps => ({
  pipeline: apps.filter(inPipeline).length,
  sent: apps.filter(app => app.stage === "sent").length,
  closed: apps.filter(app => app.stage === "closed").length,
});
export const safeUrl = value => {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : "";
  } catch { return ""; }
};

const calendarDay = value => String(value || "").slice(0, 10);
const uiStage = stage => ["applied", "considering"].includes(stage) ? "sent" : stage;
const wireStage = stage => stage === "sent" ? "applied" : stage;
const eventText = event => {
  if (event.event_type !== "stage_changed") return event.note || "Application details updated";
  if (/^(Moved to |Closed · |Restored to |Change undone)/.test(event.note || "")) return event.note;
  const moved = event.to_stage === "considering" ? "Previously considering" : `Moved to ${LABELS[uiStage(event.to_stage)] || event.to_stage}`;
  return `${moved}${event.note ? ` · ${event.note}` : ""}`;
};

export function fromAPI(raw) {
  const stage = uiStage(raw.stage);
  return {
    id: String(raw.id), jobId: raw.job_id, external: raw.external === true,
    company: raw.company || "", companyId: raw.company_id ?? null, logo: logoSrc(raw.logo),
    role: raw.title || "", location: raw.location || "",
    url: raw.apply_url_snapshot || "", notes: raw.note || "", resumeVariant: raw.resume_variant || "",
    submittedAt: calendarDay(raw.submitted_at), nextAction: raw.next_action || "",
    nextDue: calendarDay(raw.next_due_at), taskState: raw.task_state || (stage === "sent" ? "waiting" : "action"),
    waitingFor: raw.waiting_for || "", stage, closedReason: raw.closed_reason,
    lastOpenStage: uiStage(raw.last_open_stage || (stage === "closed" ? "applied" : raw.stage)),
    updatedAt: raw.updated_at || "",
    events: (raw.events || []).map(event => ({ at: event.occurred_at, text: eventText(event) }))
      .sort((a, b) => String(b.at).localeCompare(String(a.at))),
  };
}
export function toAPI(app, activity) {
  return {
    stage: wireStage(app.stage), closed_reason: app.stage === "closed" ? app.closedReason : null,
    submitted_at: app.submittedAt || null, next_action: app.nextAction || null,
    next_due_at: app.nextDue || null, note: app.notes, resume_variant: app.resumeVariant || null,
    task_state: app.taskState, waiting_for: app.waitingFor,
    ...(app.external ? { company: app.company, title: app.role, location: app.location, apply_url_snapshot: app.url } : {}),
    ...(activity ? { activity } : {}),
  };
}
export const fromList = payload => (payload.applications || []).map(fromAPI);
// The Add application form's fields, as the API takes them.
export const externalPayload = text => ({
  company: text("company"), title: text("role"), submitted_at: text("submittedAt"),
  location: text("location"), url: text("url"), note: text("notes"),
});
export const resumeLink = target => `/resume/#target=${encodeURIComponent(target.id)}`;

/* ───────────── Search, filters and sorting ───────────── */
export function matches(app, query) {
  const needle = query.trim().toLocaleLowerCase();
  return !needle || `${app.company} ${app.role} ${app.location} ${app.nextAction} ${app.waitingFor}`.toLocaleLowerCase().includes(needle);
}
export function sortApplications(apps, key) {
  return apps.slice().sort((a, b) => {
    if (key === "company") return a.company.localeCompare(b.company) || a.role.localeCompare(b.role) || a.id.localeCompare(b.id);
    if (key === "oldest") return a.submittedAt.localeCompare(b.submittedAt) || a.id.localeCompare(b.id);
    if (key === "newest") return b.submittedAt.localeCompare(a.submittedAt) || a.id.localeCompare(b.id);
    const recent = String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.id.localeCompare(b.id);
    return key === "next" ? dueDays(a) - dueDays(b) || recent : recent;
  });
}
const AGE_BANDS = { all: () => true, 7: days => days !== null && days < 7, 30: days => days !== null && days >= 30 };
// One tab's records, filtered and sorted by that tab's `filters` (see initialFilters).
export function visibleApplications(apps, view, { query = "", age: band = "all", outcome = "all", sort = "next" } = {}) {
  return sortApplications(apps.filter(app => viewFor(app.stage) === view && matches(app, query)
    && AGE_BANDS[band](age(app)) && (outcome === "all" || app.closedReason === outcome)), sort);
}
export function paginate(list, page) {
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pages);
  const start = (current - 1) * PAGE_SIZE;
  return { page: current, pages, start, end: Math.min(start + PAGE_SIZE, list.length), items: list.slice(start, start + PAGE_SIZE) };
}

/* ───────────── Agenda ───────────── */
// Open tasks of the applications in progress, whether or not they are dated.
export const openTasks = apps => apps.filter(app => inPipeline(app) && !waitingOnCompany(app) && app.nextAction.trim());
export const agendaItems = apps => openTasks(apps).filter(app => validDay(app.nextDue));
// Tasks due today or overdue: the phone's Applied tab badge.
export const tasksDue = apps => agendaItems(apps).filter(app => dueDays(app) <= 0).length;
// Rows name the role only when that company has several of `tasks`.
export function agendaIdentity(tasks) {
  const key = app => app.company.trim().toLocaleLowerCase();
  const perCompany = new Map();
  tasks.forEach(app => perCompany.set(key(app), (perCompany.get(key(app)) || 0) + 1));
  return app => perCompany.get(key(app)) > 1 ? `${app.company} · ${app.role}` : app.company;
}
// The dated tasks of the week `week` weeks from this one (Monday first). This
// week also lists every overdue task, under today.
export function agendaWeek(apps, week, query, locale) {
  const now = today(), todayIndex = dayIndex(now);
  const start = todayIndex - (new Date(todayIndex * DAY).getUTCDay() + 6) % 7 + week * 7;
  const first = dayAt(start), last = dayAt(start + 6);
  const range = first.slice(0, 7) === last.slice(0, 7)
    ? `${formatDay(first, false, locale)}–${Number(last.slice(8))}`
    : `${formatDay(first, false, locale)}–${formatDay(last, false, locale)}`;
  const items = agendaItems(apps).filter(app => matches(app, query))
    .sort((a, b) => a.nextDue.localeCompare(b.nextDue) || a.nextAction.localeCompare(b.nextAction));
  const overdue = week === 0 ? items.filter(app => dueDays(app) < 0) : [];
  const dated = items.filter(app => dayIndex(app.nextDue) >= Math.max(start, todayIndex) && dayIndex(app.nextDue) < start + 7);
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  const days = [...new Set([...dated.map(app => app.nextDue), ...(overdue.length ? [now] : [])])].sort().map(day => ({
    day,
    isToday: day === now,
    label: `${weekday.format(new Date(dayIndex(day) * DAY))} ${Number(day.slice(8))}`,
    items: dated.filter(app => app.nextDue === day),
  }));
  return { first, last, range, overdue, days };
}

/* ───────────── Changes ───────────── */
export function addEvent(app, text) {
  app.updatedAt = new Date().toISOString();
  app.events.unshift({ at: app.updatedAt, text });
}
export function setStage(app, stage, reason = null) {
  if (stage === "closed") {
    if (app.stage !== "closed") app.lastOpenStage = app.stage;
    app.closedReason = reason;
  } else {
    app.closedReason = null;
    app.lastOpenStage = stage;
  }
  app.stage = stage;
  addEvent(app, stage === "closed" ? `Closed · ${REASONS[reason]}` : `Moved to ${LABELS[stage]}`);
}

export const replaceApp = (apps, app) => {
  const index = apps.findIndex(item => item.id === app.id);
  if (index >= 0) apps[index] = app;
};
// Saves `apply`'s edit of each record, six requests at a time, and swaps the
// saved records into `apps`. `succeeded` holds the records as they were.
export async function saveChanges(apps, ids, apply, update) {
  const before = [...new Set(ids)].map(id => apps.find(app => app.id === id)).filter(Boolean).map(clone);
  const succeeded = [], failed = [];
  for (let cursor = 0; cursor < before.length; cursor += 6) {
    await Promise.all(before.slice(cursor, cursor + 6).map(async old => {
      const desired = clone(old);
      try {
        apply(desired);
        replaceApp(apps, fromAPI(await update(old.id, toAPI(desired, desired.events[0]?.text))));
        succeeded.push(old);
      } catch (error) { failed.push({ old, error }); }
    }));
  }
  return { succeeded, failed };
}
// Undo: writes the records saved by saveChanges back as they were. Resolves to the errors.
export async function undoChanges(apps, succeeded, update) {
  const errors = [];
  for (const old of succeeded) {
    try { replaceApp(apps, fromAPI(await update(old.id, toAPI(old, "Change undone")))); }
    catch (error) { errors.push(error); }
  }
  return errors;
}
export const savedMessage = (message, succeeded, failed) => failed.length
  ? `${succeeded.length} updated; ${failed.length} could not be saved. ${failed[0].error.message}`
  : message;
export const undoneMessage = errors => errors.length
  ? `${errors.length} changes could not be undone. ${errors[0].message}`
  : "Change undone.";

// Shared save/Undo lifecycle; views retain selection, focus and toast rendering.
export function createApplicationActions(state, applications, view, update) {
  const run = async operation => {
    if (state.busy) return false;
    state.busy = true;
    view.busy(true);
    try { return await operation(); }
    finally { state.busy = false; view.busy(false); }
  };
  const undo = async succeeded => {
    const errors = await run(() => undoChanges(applications(), succeeded, update));
    if (errors !== false) view.undone(undoneMessage(errors));
  };
  return async (ids, { apply, message }) => {
    const result = await run(() => saveChanges(applications(), ids, apply, update));
    if (result === false) return false;
    const { succeeded, failed } = result;
    view.saved({ succeeded, failed, message: savedMessage(message, succeeded, failed), undo: succeeded.length ? () => undo(succeeded) : null });
    return !failed.length;
  };
}

/* Recipes: what each action changes on a copy of the record (`apply`) and
   the toast that confirms it (`message`). */
export const moveTo = (app, stage) => ({
  apply: a => {
    // Leaving Submitted for a stage in progress puts the next move on the user.
    if (OPEN.includes(stage) && a.stage === "sent") a.taskState = "action";
    setStage(a, stage);
  },
  message: `${app.company} moved to ${LABELS[stage]}.`,
});
export const closeAs = (app, reason) => ({
  apply: a => setStage(a, "closed", reason),
  message: `${app.company} closed as ${REASONS[reason].toLowerCase()}.`,
});
export const closeNoReply = count => ({
  apply: a => setStage(a, "closed", "no_reply"),
  message: `${count} closed as no reply.`,
});
export function restore(app) {
  const stage = app.lastOpenStage || "sent";
  return {
    stage,
    apply: a => { setStage(a, stage); a.events[0].text = `Restored to ${LABELS[stage]}`; },
    message: `${app.company} restored to ${LABELS[stage]}.`,
  };
}
export function respond(app, response, nextAction, nextDue) {
  const rejected = response === "rejected";
  return {
    apply: a => {
      if (!rejected) Object.assign(a, { nextAction, nextDue, taskState: "action", waitingFor: "" });
      setStage(a, rejected ? "closed" : response, rejected ? "rejected" : null);
    },
    message: `${app.company} ${rejected ? "closed as rejected" : `moved to ${LABELS[response]}`}.`,
  };
}
// `mode` "action" keeps a next task on the user's list; "waiting" hands the move to the company.
export function completeTask(app, mode, { nextAction = "", nextDue = "", waitingFor = "" }) {
  const another = mode === "action";
  return {
    apply: a => {
      Object.assign(a, { taskState: mode, nextAction: another ? nextAction : "", nextDue: another ? nextDue : "", waitingFor: another ? "" : waitingFor });
      addEvent(a, `Completed: ${app.nextAction}`);
    },
    message: `${app.company}: task done. ${another ? "Next step added." : "Waiting on company."}`,
  };
}
// Fields the details form edits. Postings tracked from Discover keep their posted identity.
export const detailFields = app => ["notes", "resumeVariant", "nextAction", "submittedAt", "nextDue", "taskState", "waitingFor",
  ...(app.external ? ["company", "role", "location", "url"] : [])];
export const hasChanges = (app, changes) => Object.keys(changes).some(key => changes[key] !== app[key]);
export const editDetails = (app, changes, stage = app.stage, reason = app.closedReason) => ({
  apply: a => {
    Object.assign(a, changes);
    if (stage !== a.stage || reason !== a.closedReason) setStage(a, stage, reason);
    else addEvent(a, "Application details updated");
  },
  message: stage === app.stage ? "Application updated." : `${app.company} moved to ${stage === "closed" ? REASONS[reason] : LABELS[stage]}.`,
});

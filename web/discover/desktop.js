// Discover on desktop: job type tabs over a list of postings and a detail pane,
// with keyboard triage (add, skip, report), a Hidden list and Undo.
import { refreshCount, startAccount } from "../shared/account.js";
import { api } from "../shared/api.js";
import { guest } from "../shared/guest.js";
import { $, $$, esc } from "../shared/util.js";
import {
  DEGREE_FILTERS, FILTERS, SKIP_REASONS, SORTS, defaultDegreeFields, appliedNoticeMarkup, skipMenuMarkup, skipNoticeMarkup, cardMetaMarkup, commonTerms, dayGroups, detailPaneMarkup,
  dueLabel, feedbackBody, fetchHidden, fetchHiddenTotal, fetchJobs, hiddenReason, icon, listTags, logoMarkup, needsRefill,
  putBack, reportCorrections, reportMarkup, rowAge, sameId, tabCount, takeOut,
} from "./core.js";

const view = $("#view");
const flash = $("#flash");
const freshUi = () => ({ report: null, links: false, places: false, common: false });
const state = {
  jobs: null, total: 0, typeCounts: {}, loadingMore: false, selected: null,
  filters: ["internships"], degreeFilters: [], sort: "fresh", query: "",
  // Triage: which list shows, the Hidden list once fetched, what the pane has
  // open, the open skip-reason menu, and the one action Undo reverses.
  view: "feed", hidden: null, hiddenTotal: 0, stale: false, ui: freshUi(), undo: null,
  skipMenu: null, skipNotice: null, appliedNotice: null, sheet: false, fieldOpen: false, sortOpen: false,
};
let searchTimer = 0;
let loadSeq = 0, loadingFeed = false, autoLoadFailed = false;

/* ───────────── Painting ───────────── */
// The job-type tabs scroll when the tools need the room; a fade says so.
function fadeFilters() {
  const bar = view.querySelector(".discover-filterbar");
  bar?.classList.toggle("fade", bar.scrollWidth > bar.clientWidth + 2);
}
// Keep the existing six-skill preview, fitting fewer chips when the row is narrow.
function fitListTags() {
  const desktop = matchMedia("(min-width: 761px)").matches;
  for (const tags of view.querySelectorAll(".tags")) {
    const chips = [...tags.querySelectorAll(".tag:not(.tag-more)")];
    let more = tags.querySelector(".tag-more");
    const extra = Number(tags.dataset.extra ?? (more?.textContent.slice(1) || 0));
    tags.dataset.extra = extra;
    for (const chip of chips) chip.hidden = false;
    const updateMore = count => {
      if (!count) { more?.remove(); more = null; return; }
      if (!more) {
        more = document.createElement("span");
        more.className = "tag tag-more";
        tags.append(more);
      }
      more.textContent = `+${count}`;
      more.setAttribute("aria-label", `${count} more skill${count === 1 ? "" : "s"}`);
    };
    updateMore(extra);
    if (!desktop) continue;
    const widths = chips.map(chip => chip.getBoundingClientRect().width);
    const gap = parseFloat(getComputedStyle(tags).columnGap) || 0;
    let count = chips.length;
    let width = widths.reduce((total, value) => total + value, 0);
    while (count > 0) {
      updateMore(extra + chips.length - count);
      const items = count + (more ? 1 : 0);
      if (width + (more?.getBoundingClientRect().width || 0) + gap * (items - 1) <= tags.clientWidth) break;
      width -= widths[--count];
    }
    updateMore(extra + chips.length - count);
    for (let index = count; index < chips.length; index++) chips[index].hidden = true;
  }
}
addEventListener("resize", () => { fadeFilters(); fitListTags(); });
document.fonts.ready.then(fitListTags);

function paint(html) {
  const filtersLeft = view.querySelector(".discover-filterbar")?.scrollLeft || 0;
  const list = view.querySelector(".opportunity-list");
  const detail = view.querySelector(".detail");
  const listTop = list?.scrollTop || 0;
  const detailTop = detail?.scrollTop || 0;
  const previousId = detail?.dataset.selected;
  view.innerHTML = html;
  const nextFilters = view.querySelector(".discover-filterbar");
  if (nextFilters) nextFilters.scrollLeft = filtersLeft;
  fadeFilters();
  fitListTags();
  const nextList = view.querySelector(".opportunity-list");
  const nextDetail = view.querySelector(".detail");
  if (nextList) nextList.scrollTop = listTop;
  if (nextDetail && nextDetail.dataset.selected === previousId) nextDetail.scrollTop = detailTop;
}

/* ───────────── Flash ───────────── */
let notice = null;  // what the flash shows: { undo, pending }
let flashTimer = 0;
let flashRemaining = 0;
let flashDeadline = null;
let appliedTimer = 0;
let skipTimer = 0;

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
};

function hideFlash() {
  flash.classList.remove("show", "has-action");
  flash.inert = true;
}

// The open-posting hint shows once per browser, and only after a mouse click:
// a keyboard user already knows the key.
const OPEN_TIP = "oneshot.triage.tip.open";
let openTipShown = false;
function firstOpenClick() {
  try {
    if (localStorage.getItem(OPEN_TIP)) return false;
    localStorage.setItem(OPEN_TIP, "1");
  } catch (_) {
    if (openTipShown) return false;
    openTipShown = true;
  }
  return true;
}

// The inline notices: one at a time, and either one ends the other.
function clearSkipNotice() {
  clearTimeout(skipTimer);
  state.skipNotice = null;
}

// "Skipped · Location · Undo" sits after Skip in the pane, where the click was.
function showSkipNotice(job, label) {
  clearTimeout(appliedTimer);
  state.appliedNotice = null;
  clearTimeout(flashTimer);
  notice = null;
  hideFlash();
  clearSkipNotice();
  state.skipNotice = { job, label };
  render();
  skipTimer = setTimeout(() => {
    state.skipNotice = null;
    render();
  }, 12000);
}

// "Added to Applied · Undo" sits beside the button it confirms, not in the flash.
function showAppliedNotice() {
  clearSkipNotice();
  clearTimeout(appliedTimer);
  clearTimeout(flashTimer);
  notice = null;
  hideFlash();
  flash.replaceChildren();
  state.appliedNotice = state.undo;
  render();
  appliedTimer = setTimeout(() => {
    state.appliedNotice = null;
    render();
  }, 8000);
}

function announce(message, { undo = false, hint = false } = {}) {
  clearTimeout(appliedTimer);
  if (state.appliedNotice || state.skipNotice) {
    state.appliedNotice = null;
    clearSkipNotice();
    render();
  }
  flash.replaceChildren();
  const copy = el("span", message, "flash-copy");
  notice = { undo: undo ? state.undo : null, pending: false };
  const job = notice.undo?.job;
  if (job) {
    copy.title = `${job.company} · ${job.title}`;
    copy.setAttribute("aria-label", `${message}. ${job.company}, ${job.title}`);
  }
  if (hint) {
    const small = el("small");
    small.append("Tip: press ", el("b", "D"), " to open the posting. ", el("b", "?"), " shows every shortcut.");
    copy.append(small);
  }
  flash.append(copy);
  if (undo) {
    const button = el("button", "Undo", "flash-undo");
    button.type = "button";
    button.dataset.action = "undo";
    flash.append(button);
  }
  flash.classList.toggle("has-action", undo);
  flash.classList.add("show");
  flash.inert = false;
  flashRemaining = undo ? 12000 : 3200;
  flashDeadline = null;
  resumeFlash();
}

function pauseFlash() {
  clearTimeout(flashTimer);
  if (flashDeadline != null) flashRemaining = Math.max(0, flashDeadline - Date.now());
  flashDeadline = null;
}

function resumeFlash() {
  if (!flash.classList.contains("show") || flash.matches(":hover") || flash.contains(document.activeElement)
    || notice?.pending) return;
  if (flashDeadline != null) return;
  clearTimeout(flashTimer);
  flashDeadline = Date.now() + flashRemaining;
  const shown = notice;
  flashTimer = setTimeout(() => {
    if (notice !== shown) return;
    hideFlash();
    flashDeadline = null;
  }, flashRemaining);
}

flash.inert = true;
flash.addEventListener("pointerenter", pauseFlash);
flash.addEventListener("pointerleave", resumeFlash);
flash.addEventListener("focusin", pauseFlash);
flash.addEventListener("focusout", () => setTimeout(resumeFlash, 0));

/* ───────────── Markup ───────────── */
const errorState = (title, error) =>
  `<div class="state"><h1>${esc(title)}</h1><p>${esc(error.message || error)}</p><button class="button primary" data-action="retry">Try again</button></div>`;
const loading = () => paint('<div class="state loading"><i></i><h1>Loading Opportunities</h1><p>Reading the latest API data.</p></div>');

const hiddenEntry = id => (state.hidden || []).find(row => sameId(row.job_id, id)) || null;
const visibleJobs = () => (state.view === "hidden" ? (state.hidden || []).map(row => row.job) : state.jobs || []);
const selectedJob = () => visibleJobs().find(job => sameId(job.id, state.selected)) || null;

let commonCache = { jobs: undefined, terms: new Map() };
function loadedCommonTerms() {
  if (commonCache.jobs !== state.jobs) commonCache = { jobs: state.jobs, terms: commonTerms(state.jobs || []) };
  return commonCache.terms;
}

function controlsMarkup() {
  const hiddenOn = state.view === "hidden";
  const tabs = FILTERS.map(filter => {
    const active = !hiddenOn && state.filters.includes(filter.key);
    const count = tabCount(state.typeCounts, filter).toLocaleString();
    return `<button class="filter ${active ? "active" : ""}" type="button" role="tab" data-filter="${filter.key}" aria-selected="${active}" tabindex="${active || (hiddenOn && filter.key === state.filters[0]) ? "0" : "-1"}">`
      + `<span>${filter.label}</span><span class="filter-count" aria-label="${count} opportunities">${count}</span></button>`;
  }).join("");
  const names = DEGREE_FILTERS.filter(filter => state.degreeFilters.includes(filter.key)).map(filter => filter.label);
  const fieldLabel = names.length === 1 ? names[0] : names.length ? `${names.length} fields` : "All fields";
  const fields = DEGREE_FILTERS.map(filter => {
    const active = state.degreeFilters.includes(filter.key);
    return `<button class="opt degree-filter" type="button" role="checkbox" data-degree-filter="${filter.key}" aria-checked="${active}"><span class="box">${icon("icon-check")}</span>${filter.label}</button>`;
  }).join("");
  const fieldMenu = state.fieldOpen
    ? `<div id="field-options" class="pop field-options" role="group" aria-label="Fields">${fields}<hr><button class="foot-link field-clear" type="button" data-action="clear-fields">Show all fields</button></div>`
    : "";
  const sortLabel = SORTS.find(([key]) => key === state.sort)?.[1] || SORTS[0][1];
  const sorts = SORTS.map(([key, label]) => `<button class="opt radio sort-option" type="button" role="menuitemradio" data-sort="${key}" aria-checked="${state.sort === key}"><span class="box"></span>${label}</button>`).join("");
  const sortMenu = state.sortOpen ? `<div id="sort-options" class="pop sort-options" role="menu" aria-label="Order or season">${sorts}</div>` : "";
  return `<div class="discover-controls-pane"><div class="discover-filterbar" role="tablist" aria-label="Job types">${tabs}</div><div class="list-tools">`
    + `<div class="focus-menu"><button type="button" class="field-trigger" data-action="toggle-fields" aria-expanded="${state.fieldOpen}" aria-controls="field-options">`
    + `${esc(fieldLabel)}${icon("icon-chevron")}</button>${fieldMenu}</div>`
    + `<div class="sort-menu"><button type="button" class="sort-trigger" data-action="toggle-sort" aria-haspopup="menu" aria-expanded="${state.sortOpen}" aria-controls="sort-options" aria-label="Opportunity order or season: ${esc(sortLabel)}">`
    + `${icon("icon-sort").replace("<svg", '<svg class="sort-icon"')}${esc(sortLabel)}${icon("icon-chevron")}</button>${sortMenu}</div>`
    + `<button class="hidden-toggle" type="button" data-action="toggle-hidden" aria-pressed="${hiddenOn}">${icon("icon-eye-off")}Hidden`
    + `<span class="hidden-count">${state.hiddenTotal.toLocaleString()}</span></button></div></div>`;
}

// The row's Skip opens the same reason menu as the pane's, anchored under it.
function rowSkipMarkup(job) {
  const open = state.skipMenu?.where === "row" && sameId(state.skipMenu.id, job.id);
  return `<span class="skip-wrap"><button class="card-skip" type="button" data-action="skip" data-where="row" data-id="${esc(job.id)}" aria-label="Skip ${esc(job.title)}"`
    + ` aria-haspopup="menu" aria-expanded="${open}"${open ? "" : ' data-tip="Skip" data-key="F"'}>${icon("icon-eye-off")}</button>`
    + `${open ? skipMenuMarkup(job.id, "row") : ""}</span>`;
}

function opportunity(job) {
  const selected = sameId(job.id, state.selected);
  const entry = state.view === "hidden" ? hiddenEntry(job.id) : null;
  const tags = entry ? "" : listTags(job);
  const reason = entry ? `<span class="hidden-reason${entry.kind === "mislabeled" ? " flagged" : ""}">${esc(hiddenReason(entry))}</span>` : "";
  const action = entry
    ? `<button class="card-restore" type="button" data-action="restore" data-id="${esc(job.id)}">Restore</button>`
    : `<div class="row-actions"><button class="card-add" type="button" data-action="add-to-applications" data-id="${esc(job.id)}" aria-label="Add ${esc(job.title)} to Applications">`
      + `${icon("icon-plus")}</button>${rowSkipMarkup(job)}</div>`;
  const due = dueLabel(job);
  const menu = state.skipMenu?.where === "row" && sameId(state.skipMenu.id, job.id);
  return `<article class="opportunity ${selected ? "selected" : ""}${menu ? " menu-open" : ""}" data-job="${esc(job.id)}" tabindex="0" role="button" aria-selected="${selected}">`
    + `<div class="job-logo">${logoMarkup(job)}</div><div class="opportunity-main"><h3>${esc(job.title)}</h3>`
    + `<div class="job-subline"><span class="job-company">${esc(job.company)}</span>${cardMetaMarkup(job)}</div>${tags ? `<div class="tags">${tags}</div>` : ""}${reason}</div>`
    + `<div class="row-meta"><span>${esc(rowAge(job))}</span>${due ? `<span class="row-deadline">${esc(due)}</span>` : ""}</div>${action}</article>`;
}

function feedMarkup(jobs) {
  if (!jobs.length) return '<div class="empty"><h2>No matching jobs yet</h2><p>Try another search.</p></div>';
  const groups = dayGroups(jobs).map(group => `<div class="recency-bucket"><span>${esc(group.label)}</span>`
    + `<span class="group-count" aria-label="${group.count} loaded jobs">${group.count}</span></div>${group.jobs.map(opportunity).join("")}`);
  const more = jobs.length < state.total
    ? `<button class="button" type="button" data-action="load-more" ${state.loadingMore ? "disabled" : ""}>${state.loadingMore ? "Loading…" : "Load more"}</button>`
    : "";
  return `${groups.join("")}<div class="list-pager"><span>Showing ${jobs.length.toLocaleString()} of ${state.total.toLocaleString()}</span>${more}</div>`;
}

function hiddenListMarkup() {
  if (state.hidden === null) return '<div class="state loading"><i></i><p>Loading hidden postings.</p></div>';
  if (!state.hidden.length) return '<div class="empty"><h2>Nothing hidden</h2><p>Skipped and mislabeled postings land here, each with Restore.</p></div>';
  return `<p class="hidden-intro">Skipped and mislabeled postings, newest first. Restore puts one back in the feed.</p>${visibleJobs().map(opportunity).join("")}`;
}

function detail(job) {
  if (job) {
    const pane = detailPaneMarkup(job, {
      ui: state.ui,
      hidden: state.view === "hidden" ? hiddenEntry(job.id) : null,
      common: loadedCommonTerms(),
      appliedNotice: state.appliedNotice,
      skipMenu: state.skipMenu?.where === "pane" && sameId(state.skipMenu.id, job.id) ? state.skipMenu : null,
      skipNotice: state.skipNotice,
    });
    return `<aside class="detail" data-selected="${esc(job.id)}" aria-label="Selected opportunity">${pane}</aside>`;
  }
  if (state.view === "hidden") {
    return '<aside class="detail"><div class="section-kicker">Hidden</div><h2>Nothing selected</h2><p>Pick a hidden posting to see why it left the feed.</p></aside>';
  }
  const feedback = state.appliedNotice || state.skipNotice
    ? `<div class="empty-detail-feedback">${appliedNoticeMarkup(state.appliedNotice)}${skipNoticeMarkup(state.skipNotice)}</div>` : "";
  return `<aside class="detail"><div class="section-kicker">Selection</div><h2>Choose a job</h2><p>Select a role to review its details and add it to Applications.</p>${feedback}</aside>`;
}

// Repaints the view, keeping focus on the control that had it.
function render() {
  const search = $("#opportunities-search");
  const active = document.activeElement;
  const caret = active === search ? search.selectionStart : null;
  const focusSelector = active?.matches("[data-filter]") ? `[data-filter="${CSS.escape(active.dataset.filter)}"]`
    : active?.matches("[data-degree-filter]") ? `[data-degree-filter="${CSS.escape(active.dataset.degreeFilter)}"]`
    : active?.matches(".field-trigger") ? ".field-trigger" : active?.matches(".sort-trigger") ? ".sort-trigger"
    : active?.matches("[data-sort]") ? `[data-sort="${CSS.escape(active.dataset.sort)}"]`
    : active?.matches("[data-job]") ? `[data-job="${CSS.escape(active.dataset.job)}"]`
    : active?.matches(".applied-notice [data-action='undo']") ? ".applied-notice [data-action='undo']"
    : active?.matches(".skip-notice [data-action='undo']") ? ".skip-notice [data-action='undo']"
    : active?.matches(".skip-menu [data-why]") ? `.skip-menu [data-why="${CSS.escape(active.dataset.why)}"]` : null;
  const list = state.view === "hidden" ? hiddenListMarkup() : feedMarkup(state.jobs || []);
  paint(`<section class="discover-page"><h1 class="sr-only">Opportunities</h1>${controlsMarkup()}<div class="discover-grid">`
    + `<div class="opportunity-list" role="tabpanel" aria-label="${state.view === "hidden" ? "Hidden postings" : "Opportunity results"}">${list}</div>`
    + `${detail(selectedJob())}</div></section>`);
  if (search.value !== state.query) search.value = state.query;
  if (caret != null) {
    search.focus();
    search.setSelectionRange(caret, caret);
  } else if (focusSelector) {
    ($(focusSelector) || (active?.closest(".applied-notice") ? $(".detail-actions .primary") : null))?.focus({ preventScroll: true });
  }
  syncReport();
  placeSkipMenu();
}

// A row's menu opens upward when the list would clip it.
function placeSkipMenu() {
  const menu = $(".skip-menu.at-row");
  const list = $(".opportunity-list");
  if (!menu || !list) return;
  menu.classList.remove("above");
  if (menu.getBoundingClientRect().bottom > list.getBoundingClientRect().bottom - 8) menu.classList.add("above");
}

function select(id, { focus = false } = {}) {
  if (!sameId(id, state.selected)) {
    state.selected = id;
    state.ui = freshUi();
    state.skipMenu = null;
  }
  render();
  if (focus) {
    const card = $(`[data-job="${CSS.escape(String(id))}"]`);
    card?.focus();
    card?.scrollIntoView({ block: "nearest" });
  }
}

/* ───────────── Data ───────────── */
async function loadJobs({ append = false } = {}) {
  if (append && (state.loadingMore || loadingFeed)) return;
  const seq = append ? loadSeq : ++loadSeq;
  if (!append) {
    loadingFeed = true;
    state.loadingMore = false;
    autoLoadFailed = false;
  }
  if (append) {
    state.loadingMore = true;
    render();
  } else if (state.jobs === null) loading();
  try {
    const filters = { query: state.query, sort: state.sort, types: state.filters, fields: state.degreeFilters };
    const payload = await fetchJobs(filters, append ? (state.jobs || []).length : 0);
    if (seq !== loadSeq) return;
    state.total = payload.total;
    state.typeCounts = payload.job_type_counts || {};
    state.jobs = append ? [...(state.jobs || []), ...payload.jobs] : payload.jobs;
    state.loadingMore = false;
    loadingFeed = false;
    autoLoadFailed = append && !payload.jobs.length;
    if (!append) state.stale = false;
    if (!append && state.view === "feed" && !state.jobs.some(job => sameId(job.id, state.selected))) {
      state.selected = state.jobs[0]?.id || null;
      state.ui = freshUi();
    }
    render();
    if (!append) {
      const list = $(".opportunity-list");
      if (list) list.scrollTop = 0;
    }
  } catch (error) {
    if (seq !== loadSeq) return;
    state.loadingMore = false;
    loadingFeed = false;
    autoLoadFailed = append;
    if (!append) return paint(errorState("Opportunities couldn’t load", error));
    render();
    announce(error.message || "Couldn’t load more opportunities.");
  }
}

async function loadHidden() {
  const { total, rows } = await fetchHidden();
  state.hidden = rows;
  state.hiddenTotal = total;
  if (state.view === "hidden" && !hiddenEntry(state.selected)) {
    state.selected = rows[0]?.job.id ?? null;
    state.ui = freshUi();
  }
  render();
}

// The count beside "Hidden" on first paint. It is a convenience, so a failure
// leaves it at zero rather than interrupting the feed.
async function loadHiddenCount() {
  try {
    state.hiddenTotal = await fetchHiddenTotal();
    render();
  } catch (_) { /* The toggle still opens the list, which reports its own error. */ }
}

async function showView(next) {
  if (next === state.view) return;
  state.view = next;
  state.selected = null;
  state.ui = freshUi();
  state.skipMenu = null;
  // Leaving the feed takes the skip's Undo along as a message.
  const pending = state.skipNotice;
  if (pending) {
    clearSkipNotice();
    announce(pending.label, { undo: true });
  }
  if (next === "hidden") {
    render();
    return loadHidden();
  }
  if (state.jobs === null) return loadJobs();
  state.selected = state.jobs[0]?.id ?? null;
  render();
  if (state.stale) return loadJobs();
}

/* ───────────── Triage ───────────── */
// Add, Skip and Mislabeled leave the feed at once and select the next
// posting; the write follows, and a failed write puts the posting back.
async function leaveFeed(job, write) {
  const listed = state.jobs || [];
  const position = takeOut(state, job);
  const successor = listed[position + 1] || listed[position - 1] || null;
  if (sameId(state.selected, job.id)) {
    state.selected = successor?.id ?? null;
    state.ui = freshUi();
  }
  render();
  let result;
  try {
    result = await write();
  } catch (error) {
    returnToFeed(job, position);
    throw error;
  }
  refreshCount();
  if (needsRefill(state)) loadJobs({ append: true });
  return { result, position };
}

// Puts a posting back where it left the feed: a failed write, or an Undo.
function returnToFeed(job, position) {
  if (putBack(state, job, position) && state.view === "feed") {
    state.selected = job.id;
    state.ui = freshUi();
  }
  render();
  refreshCount();
}

const feedJob = id => (state.view === "feed" ? (state.jobs || []).find(row => sameId(row.id, id)) : null);

async function addToApplications(id) {
  const job = feedJob(id);
  if (!job) return;
  const { result: application, position } = await leaveFeed(job, () => api.jobs.addToApplications(job.id, job));
  if (application.already_exists) return announce("This job is already in Applications.");
  state.undo = { kind: "add", id: application.id, job, position };
  showAppliedNotice();
}

async function hideJob(job, body, message) {
  const write = () => api.jobs.setFeedback(job.id, body, job);
  // Keep the report draft and dialog intact until the server accepts it.
  const mislabeled = body.kind === "mislabeled";
  if (mislabeled) await write();
  const { position } = await leaveFeed(job, mislabeled ? () => Promise.resolve() : write);
  state.hiddenTotal += 1;
  state.hidden = null;
  state.undo = { kind: "hide", job, position };
  if (body.kind === "skip") return showSkipNotice(job, message);
  render();
  announce(message, { undo: true });
}

// Skip opens the reason menu; the posting leaves only once a reason is picked.
function skip(id, where = "pane") {
  if (!feedJob(id)) return;
  if (where === "pane" && !$(".detail [data-action='skip']")) where = "row";
  const same = state.skipMenu && sameId(state.skipMenu.id, id) && state.skipMenu.where === where;
  state.skipMenu = same ? null : { id, where };
  render();
  if (state.skipMenu) $(".skip-menu [data-why]")?.focus({ preventScroll: true });
}

function closeSkipMenu({ focus = true } = {}) {
  const open = state.skipMenu;
  if (!open) return;
  state.skipMenu = null;
  render();
  if (focus) {
    const button = open.where === "row" ? $(`[data-job="${CSS.escape(String(open.id))}"] .card-skip`) : $(".detail [data-action='skip']");
    button?.focus({ preventScroll: true });
  }
}

async function chooseSkip(id, key) {
  const job = feedJob(id);
  const reason = SKIP_REASONS.find(item => item.key === key);
  state.skipMenu = null;
  if (!job || !reason) return render();
  await hideJob(job, { kind: "skip", skip_reason: reason.key }, `Skipped · ${reason.label}`);
}

async function restore(id) {
  const entry = hiddenEntry(id);
  if (!entry) return;
  const rows = state.hidden;
  const position = rows.indexOf(entry);
  const successor = rows[position + 1] || rows[position - 1] || null;
  await api.jobs.clearFeedback(entry.job_id);
  state.hidden = rows.filter(row => row !== entry);
  state.hiddenTotal = Math.max(0, state.hiddenTotal - 1);
  if (sameId(state.selected, id)) {
    state.selected = successor?.job.id ?? null;
    state.ui = freshUi();
  }
  // The feed refreshes quietly the next time it shows, with the posting back
  // in place; until then the old list stays on screen, not a spinner.
  state.stale = true;
  state.undo = { kind: "restore", entry };
  render();
  announce("Restored", { undo: true });
  refreshCount();
}

async function undo(last = state.undo) {
  if (!last) return;
  if (notice?.pending && last === notice.undo) return;
  if (state.undo === last) state.undo = null;
  if (state.appliedNotice || state.skipNotice) {
    state.appliedNotice = null;
    clearTimeout(appliedTimer);
    clearSkipNotice();
    render();
  }
  if (last.kind === "add") {
    await api.applications.remove(last.id);
    returnToFeed(last.job, last.position);
    return announce("Addition undone.");
  }
  if (last.kind === "hide") {
    await api.jobs.clearFeedback(last.job.id);
    state.hiddenTotal = Math.max(0, state.hiddenTotal - 1);
    state.hidden = null;
    returnToFeed(last.job, last.position);
    return announce("Undone.");
  }
  const { entry } = last;
  await api.jobs.setFeedback(entry.job_id, feedbackBody(entry), entry.job);
  state.hiddenTotal += 1;
  state.stale = true;
  if (state.view === "hidden") await loadHidden();
  refreshCount();
  announce("Hidden again.");
}

/* ───────────── Report dialog ───────────── */
let reportOpener = null;
function syncReport() {
  const report = state.ui.report;
  let dialog = $("#report-dialog");
  if (!report) {
    if (dialog?.open) {
      dialog.close();
      dialog.replaceChildren();
      setTimeout(() => {
        if (!state.ui.report) (reportOpener?.isConnected ? reportOpener : $(".detail-flag"))?.focus({ preventScroll: true });
      }, 0);
    }
    return;
  }
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "report-dialog";
    dialog.className = "report-dialog";
    dialog.setAttribute("aria-labelledby", "report-title");
    dialog.setAttribute("aria-describedby", "report-description");
    dialog.addEventListener("cancel", event => { event.preventDefault(); closeReport(); });
    // Closes on a click on the backdrop, not on a drag that ends there.
    let startedOutside = false;
    const outside = event => {
      const bounds = dialog.getBoundingClientRect();
      return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
    };
    dialog.addEventListener("pointerdown", event => { startedOutside = event.target === dialog && outside(event); });
    dialog.addEventListener("click", event => {
      if (startedOutside && event.target === dialog && outside(event)) closeReport();
      startedOutside = false;
    });
    document.body.append(dialog);
  }
  const activeId = dialog.contains(document.activeElement) ? document.activeElement.id : null;
  const scrollTop = dialog.querySelector(".report-body")?.scrollTop || 0;
  dialog.innerHTML = reportMarkup(report.job, report);
  if (!dialog.open) dialog.showModal();
  if (activeId) $(`#${CSS.escape(activeId)}`)?.focus({ preventScroll: true });
  dialog.querySelector(".report-body").scrollTop = scrollTop;
}

function closeReport() {
  if (state.ui.report?.submitting) return;
  state.ui.report = null;
  $(".detail-flag")?.setAttribute("aria-expanded", "false");
  syncReport();
}

function toggleReport() {
  if (state.ui.report) return closeReport();
  if (state.view !== "feed" || !selectedJob()) return;
  reportOpener = document.activeElement;
  state.skipMenu = null;
  pauseFlash();
  hideFlash();
  notice = null;
  state.ui.links = state.ui.places = false;
  state.ui.report = { job: selectedJob(), rows: {}, submitting: false, error: null };
  render();
}

async function submitReport() {
  const report = state.ui.report;
  const job = report?.job;
  if (!job || report.submitting) return;
  const corrections = reportCorrections(job, report.rows);
  if (!corrections.length) return;
  report.submitting = true;
  report.error = null;
  syncReport();
  try {
    await hideJob(job, { kind: "mislabeled", corrections }, "Reported");
  } catch (error) {
    report.submitting = false;
    report.error = error.message || "Report could not be saved. Try again.";
    state.ui.report = report;
    syncReport();
  }
}

/* ───────────── Menus and shortcuts ───────────── */
function toggleLinks() {
  if (!$(".open-more")) return;
  state.ui.links = !state.ui.links;
  state.ui.places = false;
  render();
  if (state.ui.links) $(".link-item")?.focus();
}

// Search lives in the persistent header, outside the re-rendered view.
function openSearch() {
  const input = $("#opportunities-search");
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

const SHORTCUTS = [
  ["A", "Add to Applications"],
  ["D", "Open the posting"],
  ["⇧ D", "Other links, when it is listed twice"],
  ["F", "Skip (opens the reasons)"],
  ["1 2 3 4", "Pick a skip reason"],
  ["↓ S", "Next job"],
  ["↑ W", "Previous job"],
  ["R", "Mislabeled"],
  ["Z", "Undo"],
  ["⌘ K", "Search"],
  ["?", "Show this list"],
];
function toggleSheet(open) {
  state.sheet = open;
  let host = $("#shortcut-sheet");
  if (!host) {
    host = el("div");
    host.id = "shortcut-sheet";
    document.body.append(host);
  }
  const rows = SHORTCUTS.map(([keys, label]) => `<dt>${keys.split(" ").map(key => `<kbd>${esc(key)}</kbd>`).join("")}</dt><dd>${esc(label)}</dd>`);
  host.innerHTML = open
    ? `<div class="sheet-scrim" data-sheet-scrim><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title"><div class="sheet-head">`
      + `<strong id="sheet-title">Keyboard shortcuts</strong><button class="text-button" type="button" data-sheet-close>Close</button></div><dl>${rows.join("")}</dl></div></div>`
    : "";
  if (open) host.querySelector("[data-sheet-close]").focus();
}

const run = async task => {
  try { await task(); }
  catch (error) { announce(error.message || "That action could not be completed."); }
};

function move(step) {
  const cards = $$("[data-job]");
  if (!cards.length) return;
  const current = cards.findIndex(card => card.dataset.job === String(state.selected));
  const next = cards[current < 0 ? 0 : current + step];
  if (next) select(next.dataset.job, { focus: true });
}

const reload = () => {
  state.view = "feed";
  return loadJobs();
};

/* ───────────── Events ───────────── */
// Capture on the stable view: the scrollable list is replaced on each render.
view.addEventListener("scroll", event => {
  const list = event.target;
  if (!list.matches(".opportunity-list") || state.view !== "feed"
    || loadingFeed || state.loadingMore || autoLoadFailed
    || !state.jobs?.length || state.jobs.length >= state.total) return;
  if (list.scrollTop + list.clientHeight > list.scrollHeight - 600) loadJobs({ append: true });
}, { capture: true, passive: true });

document.addEventListener("click", event => {
  const target = event.target;
  if (state.skipMenu && !target.closest(".skip-wrap")) closeSkipMenu({ focus: false });
  if (state.fieldOpen && !target.closest(".focus-menu")) {
    state.fieldOpen = false;
    render();
  }
  if (state.sortOpen && !target.closest(".sort-menu")) {
    state.sortOpen = false;
    render();
  }
  const sortChoice = target.closest("[data-sort]");
  if (sortChoice) {
    state.sortOpen = false;
    $(".sort-trigger")?.focus({ preventScroll: true });
    if (sortChoice.dataset.sort === state.sort) return render();
    state.sort = sortChoice.dataset.sort;
    return reload();
  }
  if ((state.ui.links && !target.closest(".link-menu, [data-action='toggle-links']"))
    || (state.ui.places && !target.closest(".place-menu, [data-action='toggle-places']"))) {
    state.ui.links = false;
    state.ui.places = false;
    render();
  }
  if (target.closest("[data-sheet-close]") || target.matches("[data-sheet-scrim]")) return toggleSheet(false);
  const why = target.closest("[data-why]");
  if (why) return run(() => chooseSkip(why.dataset.id, why.dataset.why));
  if (event.detail > 0 && target.closest(".open-link, .open-more") && firstOpenClick()) announce("", { hint: true });
  if (target.closest(".link-item")) {
    state.ui.links = false;
    setTimeout(render, 0);
    return;
  }
  const control = target.closest("[data-action]");
  // The form owns submission, including Enter from a correction field.
  if (control?.dataset.action === "report-submit") return;
  const id = control?.dataset.id ?? state.selected;
  const actions = {
    retry: start,
    "load-more": () => (state.loadingMore ? undefined : loadJobs({ append: true })),
    "add-to-applications": () => addToApplications(id),
    skip: () => skip(id, control.dataset.where || "pane"),
    restore: () => restore(id),
    undo: () => undo(control.closest("#flash") ? notice?.undo : state.undo),
    report: toggleReport,
    "report-cancel": closeReport,
    "toggle-links": toggleLinks,
    "toggle-places": () => {
      state.ui.places = !state.ui.places;
      state.ui.links = false;
      render();
    },
    "toggle-common": () => {
      state.ui.common = !state.ui.common;
      render();
    },
    "toggle-hidden": () => showView(state.view === "hidden" ? "feed" : "hidden"),
    "toggle-fields": () => {
      state.fieldOpen = !state.fieldOpen;
      state.sortOpen = false;
      render();
    },
    "toggle-sort": () => {
      state.sortOpen = !state.sortOpen;
      state.fieldOpen = false;
      render();
      if (state.sortOpen) $(`.sort-option[aria-checked="true"]`)?.focus({ preventScroll: true });
    },
    "clear-fields": () => {
      state.degreeFilters = [];
      state.fieldOpen = false;
      return reload();
    },
  };
  if (control && actions[control.dataset.action]) return run(actions[control.dataset.action]);
  const card = target.closest("[data-job]");
  if (card) select(card.dataset.job);
});

document.addEventListener("click", event => {
  const tab = event.target.closest("[data-filter]");
  if (!tab) return;
  state.filters = [tab.dataset.filter];
  reload();
});

document.addEventListener("click", event => {
  const field = event.target.closest("[data-degree-filter]");
  if (!field) return;
  const key = field.dataset.degreeFilter;
  state.degreeFilters = state.degreeFilters.includes(key) ? state.degreeFilters.filter(value => value !== key) : [...state.degreeFilters, key];
  reload();
});

document.addEventListener("keydown", event => {
  const tab = event.target.closest('[role="tab"][data-filter]');
  if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...tab.parentElement.querySelectorAll('[role="tab"][data-filter]')];
  const at = tabs.indexOf(tab);
  const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1)
    : tabs[(at + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
  event.preventDefault();
  next.click();
});

document.addEventListener("change", event => {
  const target = event.target;
  const box = target.closest?.("[data-report]");
  if (box && state.ui.report) {
    const field = box.dataset.report;
    state.ui.report.rows[field] = { ...(state.ui.report.rows[field] || {}), on: box.checked };
    syncReport();
    return $(`#report-${field}`)?.focus();
  }
  if (target.matches("[data-fix-select]") && state.ui.report && !state.ui.report.submitting) {
    const field = target.dataset.fixSelect;
    state.ui.report.rows[field] = { ...(state.ui.report.rows[field] || {}), to: target.value };
    return;
  }
});

document.addEventListener("input", event => {
  const target = event.target;
  if (target.matches("[data-fix-input]") && state.ui.report) {
    const field = target.dataset.fixInput;
    state.ui.report.rows[field] = { ...(state.ui.report.rows[field] || {}), to: target.value };
    return;
  }
  if (!target.matches("[data-search]")) return;
  state.query = target.value;
  state.view = "feed";
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadJobs, 250);
});

document.addEventListener("submit", event => {
  if (event.target.id !== "report-form") return;
  event.preventDefault();
  run(submitReport);
});

// A adds, D opens, F skips; arrows and S/W move, R reports a wrong label, Z undoes.
document.addEventListener("keydown", event => {
  const active = document.activeElement;
  const typing = active?.isContentEditable || (/^(input|textarea|select)$/i.test(active?.tagName || "") && active.type !== "checkbox");
  if (state.sheet) {
    if (event.key === "Escape" || event.key === "?") {
      event.preventDefault();
      toggleSheet(false);
    }
    return;
  }
  if (state.ui.report) {
    if (event.key === "Escape" || (!typing && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "r")) {
      event.preventDefault();
      closeReport();
    }
    return;
  }
  const skipMenu = state.skipMenu ? $(".skip-menu") : null;
  if (skipMenu) {
    if (event.key === "Escape") {
      event.preventDefault();
      return closeSkipMenu();
    }
    if (/^[1-4]$/.test(event.key) && !typing) {
      event.preventDefault();
      const { id } = state.skipMenu;
      return run(() => chooseSkip(id, SKIP_REASONS[Number(event.key) - 1].key));
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const choices = [...skipMenu.querySelectorAll("[data-why]")];
      const at = choices.indexOf(active);
      const next = event.key === "Home" ? choices[0] : event.key === "End" ? choices.at(-1)
        : choices[(at + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length];
      return next?.focus();
    }
    if (event.key === "Tab") closeSkipMenu({ focus: false });
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    return openSearch();
  }
  if (event.key === "Escape" && event.target.matches?.("[data-search]")) {
    clearTimeout(searchTimer);
    state.query = "";
    event.target.value = "";
    event.target.blur();
    return loadJobs();
  }
  if (event.key === "Escape" && state.sortOpen) {
    state.sortOpen = false;
    render();
    return $(".sort-trigger")?.focus();
  }
  if (state.sortOpen && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const choices = $$(".sort-option");
    const at = choices.indexOf(document.activeElement);
    const next = event.key === "Home" ? choices[0] : event.key === "End" ? choices.at(-1)
      : choices[(at + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length];
    return next?.focus();
  }
  if (event.key === "Escape" && state.fieldOpen) {
    state.fieldOpen = false;
    render();
    return $(".field-trigger")?.focus();
  }
  if (event.key === "Escape" && (state.ui.links || state.ui.places)) {
    const opener = state.ui.links ? ".open-more" : ".place-more";
    state.ui.links = false;
    state.ui.places = false;
    render();
    return $(opener)?.focus();
  }
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
  const focused = event.target.closest?.("[data-job]");
  if (focused && event.target === focused && ["Enter", " "].includes(event.key)) {
    event.preventDefault();
    return select(focused.dataset.job);
  }
  if (event.key === "?") {
    event.preventDefault();
    return toggleSheet(true);
  }
  if (state.ui.links && /^[1-9]$/.test(event.key)) {
    const item = $$(".link-item")[Number(event.key) - 1];
    if (item) {
      event.preventDefault();
      item.click();
    }
    return;
  }
  const key = event.key.toLowerCase();
  if (key === "d" && event.shiftKey) {
    event.preventDefault();
    return toggleLinks();
  }
  if (event.shiftKey) return;
  // Leave arrows with open menus and their controls.
  if (["arrowdown", "arrowup"].includes(key) && (state.fieldOpen || state.sortOpen || state.ui.links || state.ui.places || active?.closest(".account"))) return;
  const keys = {
    arrowdown: () => move(1),
    arrowup: () => move(-1),
    s: () => move(1),
    w: () => move(-1),
    a: () => addToApplications(state.selected),
    d: () => $(".open-link")?.click(),
    f: () => skip(state.selected),
    r: toggleReport,
    z: () => undo(),
  };
  if (!keys[key]) return;
  event.preventDefault();
  run(keys[key]);
});

async function start() {
  loading();
  try { state.degreeFilters = defaultDegreeFields(await guest.account()); }
  catch (_) { /* Identity unavailable: leave all fields unselected. */ }
  await loadJobs();
  loadHiddenCount();
}

startAccount();
start();

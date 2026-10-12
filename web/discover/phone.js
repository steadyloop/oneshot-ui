/* Discover on phones: a list for scanning, a full-screen job page with the
   actions at the bottom, filters in one sheet, swipe right to add and left to
   skip. The rules are the desktop page's own, from core.js. */
import P from "../phone/shell.js";
import { api } from "../shared/api.js";
import { guest } from "../shared/guest.js";
import {
  DEGREE_FILTERS, FILTERS, SKIP_REASONS, SORTS, defaultDegreeFields, degreeFields, commonNote, commonTerms, dayGroups, deadlineLabel, dueLabel, feedbackBody,
  createFeedLoader, fetchHidden, fetchHiddenTotal, foldLabel, hiddenReason, linkChoices, linkNote, listBundles, logoMarkup, needsRefill,
  placeList, placeSummary, postedFact, putBack, reportCorrections, reportRows, rowAge, sameId, skillGroups, skillLabel, skillTitle,
  tabCount, takeOut, workplaceLabel,
} from "./core.js";

const { esc, icon, S } = P;
const NOUNS = { internships: "internships", coops: "co-ops", students: "student jobs", new_grads: "new grad roles", research: "research roles" };
const STORE = "oneshot.phone.discover";
const HINT = "oneshot.phone.swipe-hint";

const saved = (() => { try { return JSON.parse(sessionStorage.getItem(STORE)) || {}; } catch (_) { return {}; } })();
const state = {
  type: FILTERS.some(filter => filter.key === saved.type) ? saved.type : "internships",
  fields: [],
  sort: SORTS.some(([key]) => key === saved.sort) ? saved.sort : "fresh",
  query: typeof saved.query === "string" ? saved.query : "",
  jobs: null, total: 0, typeCounts: {}, error: null, loadingMore: false, reloading: false,
  hidden: null, hiddenTotal: 0, hiddenError: null,
  added: new Map(),      // job id -> { id, position }, for "Added to Applied"
  known: new Map(),      // every posting seen, so a page outlives its row
  hint: (() => { try { return !localStorage.getItem(HINT); } catch (_) { return true; } })(),
  v: 0,
};
let fieldsStore = null;
const bump = () => { state.v += 1; };
const remember = () => {
  try {
    sessionStorage.setItem(STORE, JSON.stringify({ type: state.type, sort: state.sort, query: state.query }));
    if (fieldsStore) sessionStorage.setItem(fieldsStore, JSON.stringify(state.fields));
  }
  catch (_) { /* private mode */ }
};
const noun = () => NOUNS[state.type] || "jobs";
const jobById = id => state.known.get(String(id)) || null;
const hiddenRow = id => (state.hidden || []).find(row => sameId(row.job_id, id)) || null;
const know = jobs => (jobs || []).forEach(job => state.known.set(String(job.id), job));
const hideHint = () => { state.hint = false; try { localStorage.setItem(HINT, "1"); } catch (_) { /* private mode */ } };

/* ───────────── Formatting ───────────── */
const logo = (job, cls = "") => `<div class="logo${cls ? ` ${cls}` : ""}">${logoMarkup(job, "")}</div>`;
const pills = skills => `<div class="pills">${skills.map(skill => `<span class="pill" title="${esc(skillTitle(skill))}">${esc(skillLabel(skill))}</span>`).join("")}</div>`;
const placeLine = job => [placeSummary(job), workplaceLabel(job.remote), job.attributes?.term].filter(Boolean).join(" · ");

/* ───────────── Data ───────────── */
let searchTimer = null;
const feed = createFeedLoader(state,
  () => ({ query: state.query, sort: state.sort, types: [state.type], fields: state.fields }), {
  start(append) {
    if (!append) { state.error = null; state.reloading = state.jobs !== null; }
    P.render();
  },
  rows(jobs, append) {
    know(jobs);
    const fresh = (jobs || []).filter(job => !state.added.has(String(job.id)));
    return append ? fresh.filter(job => !(state.jobs || []).some(row => sameId(row.id, job.id))) : fresh;
  },
  received(payload, append) {
    state.total = Number(payload.total) || 0;
    if (!append) P.els.page.scrollTop = 0;
  },
  error(error, append) {
    if (append) P.toast(error.message || "Couldn’t load more opportunities.");
    else if (state.jobs === null) state.error = error.message || "The request failed.";
    else P.toast(error.message || "Opportunities couldn’t load");
  },
  settled() {
    state.reloading = false;
    bump();
    P.render();
  },
});
const loadJobs = options => feed.load(options);
const reload = () => { remember(); return loadJobs(); };

async function loadHidden() {
  state.hiddenError = null;
  try {
    const { total, rows } = await fetchHidden();
    state.hidden = rows;
    state.hiddenTotal = Number(total) || rows.length;
    know(rows.map(row => row.job));
  } catch (error) { state.hiddenError = error.message || "Hidden postings could not load."; }
  bump();
  P.render();
}
async function loadHiddenCount() {
  try { state.hiddenTotal = Number(await fetchHiddenTotal()) || 0; bump(); P.render(); }
  catch (_) { /* The Hidden row still opens the list, which reports its own error. */ }
}

// A posting leaves the list at once; the write follows, and a failed write
// puts it back where it was. The same as the desktop feed.
async function leaveFeed(job, write) {
  const position = takeOut(state, job);
  bump(); P.render();
  let result;
  try { result = await write(); }
  catch (error) { returnToFeed(job, position); throw error; }
  if (needsRefill(state)) loadJobs({ append: true });
  return { result, position };
}
function returnToFeed(job, position) {
  putBack(state, job, position);
  bump(); P.render();
}
const fail = error => P.toast(error?.message || "That action could not be completed.");

async function addJob(id) {
  const job = jobById(id);
  if (!job || state.added.has(String(job.id))) return;
  try {
    const { result: application, position } = await leaveFeed(job, () => api.jobs.addToApplications(job.id, job));
    if (application?.already_exists) {
      state.added.set(String(job.id), { id: null, position });
      bump(); P.render();
      return P.toast("This job is already in Applications.");
    }
    state.added.set(String(job.id), { id: application?.id ?? null, position });
    bump(); P.render();
    P.toast("Added to Applied", [{ label: "Undo", run: () => undoAdd(job, position) }]);
  } catch (error) { fail(error); }
}
async function undoAdd(job, position = state.added.get(String(job.id))?.position ?? 0) {
  const applicationId = state.added.get(String(job.id))?.id;
  try {
    if (applicationId != null) await api.applications.remove(applicationId);
    state.added.delete(String(job.id));
    returnToFeed(job, position);
    P.toast("Addition undone.");
  } catch (error) { fail(error); }
}

async function skipJob(id) {
  const job = jobById(id);
  if (!job) return;
  if (S.push?.kind === "job" && sameId(S.push.id, id)) S.push = null;
  try {
    const { position } = await leaveFeed(job, () => api.jobs.setFeedback(job.id, { kind: "skip" }, job));
    state.hiddenTotal += 1; state.hidden = null;
    bump(); P.render();
    P.toast("Skipped", [
      { label: "Reason ▾", quiet: true, run: () => { S.sheet = { kind: "skip-why", id: String(job.id), position }; P.render(); } },
      { label: "Undo", run: () => undoHide(job, position) },
    ]);
  } catch (error) { fail(error); }
}
async function undoHide(job, position) {
  try {
    await api.jobs.clearFeedback(job.id);
    state.hiddenTotal = Math.max(0, state.hiddenTotal - 1); state.hidden = null;
    returnToFeed(job, position);
    P.toast("Undone.");
  } catch (error) { fail(error); }
}
async function giveReason(key) {
  const sheet = S.sheet, job = jobById(sheet?.id);
  const reason = SKIP_REASONS.find(item => item.key === key);
  if (!job || !reason) return;
  S.sheet = { ...sheet, sending: key }; P.render();
  try {
    await api.jobs.setFeedback(job.id, { kind: "skip", skip_reason: reason.key }, job);
    state.hidden = null;
    S.sheet = null; P.render();
    P.toast(`Skipped · ${reason.label}`, [{ label: "Undo", run: () => undoHide(job, sheet.position) }]);
  } catch (error) { S.sheet = { ...sheet, error: error.message || "Reason could not be saved. Try again." }; P.render(); }
}

async function submitReport() {
  const sheet = S.sheet, job = jobById(sheet?.id);
  if (!job || sheet.sending) return;
  const corrections = reportCorrections(job, sheet.rows);
  if (!corrections.length) return;
  S.sheet = { ...sheet, sending: true, error: null }; P.render();
  try {
    // The report is saved before the posting leaves, so a failure keeps the draft.
    await api.jobs.setFeedback(job.id, { kind: "mislabeled", corrections }, job);
    S.sheet = null; S.push = null;
    const { position } = await leaveFeed(job, () => Promise.resolve());
    state.hiddenTotal += 1; state.hidden = null;
    bump(); P.render();
    P.toast("Reported", [{ label: "Undo", run: () => undoHide(job, position) }]);
  } catch (error) {
    S.sheet = { ...sheet, sending: false, error: error.message || "Report could not be saved. Try again." };
    P.render();
  }
}

// Unlike desktop, a restore reloads the feed at once.
async function restore(id) {
  const entry = hiddenRow(id);
  if (!entry) return;
  try {
    await api.jobs.clearFeedback(entry.job_id);
    state.hidden = state.hidden.filter(row => row !== entry);
    state.hiddenTotal = Math.max(0, state.hiddenTotal - 1);
    if (S.push?.kind === "job") S.push = { kind: "hidden" };
    bump(); P.render();
    loadJobs();
    P.toast("Restored", [{ label: "Undo", run: () => hideAgain(entry) }]);
  } catch (error) { fail(error); }
}
async function hideAgain(entry) {
  try {
    await api.jobs.setFeedback(entry.job_id, feedbackBody(entry), entry.job);
    state.hiddenTotal += 1;
    await loadHidden();
    loadJobs();
    P.toast("Hidden again.");
  } catch (error) { fail(error); }
}

/* ───────────── Page ───────────── */
const jobRow = job => {
  const tags = listBundles(job).flatMap(bundle => bundle.skills);
  const due = dueLabel(job);
  return `<div class="row-wrap" data-row="${esc(job.id)}"><div class="swipe-bg add">${icon("plus")}Add to Applied</div><div class="swipe-bg skip">Skip${icon("eyeoff")}</div>
    <article class="job-row" data-open-job="${esc(job.id)}" role="button" tabindex="0" aria-label="${esc(`${job.title}, ${job.company}`)}">${logo(job)}<div><h3>${esc(job.title)}</h3>
    <div class="row-meta"><span class="where"><span class="co">${esc(job.company)}</span> · ${esc(placeLine(job))}</span><span class="age">${esc(rowAge(job, { phone: true }))}</span></div>`
    + `${due ? `<div class="row-due">${esc(due)}</div>` : ""}${tags.length ? pills(tags) : ""}</div></article></div>`;
};
function listMarkup() {
  if (state.error) return P.stateBlock("error", { title: "Opportunities couldn’t load", detail: state.error });
  if (state.jobs === null) return P.stateBlock("loading", { title: "Loading Opportunities", detail: "Reading the latest API data." });
  const jobs = state.jobs;
  if (!jobs.length) return '<div class="empty"><strong>No matching jobs yet</strong>Try another search.</div>';
  const groups = dayGroups(jobs, { weekday: true })
    .map(group => `<div class="group-label"><span>${esc(group.label)}</span><span>${group.count}</span></div>${group.jobs.map(jobRow).join("")}`);
  const more = jobs.length < state.total
    ? `<button class="btn" type="button" data-act="load-more"${state.loadingMore ? " disabled" : ""}>${state.loadingMore ? "Loading…" : "Load more"}</button>`
    : "";
  return `${groups.join("")}<div class="list-end load"><span>Showing ${jobs.length.toLocaleString()} of ${state.total.toLocaleString()}</span>${more}</div>`;
}
let built = false;
function paint(page) {
  if (!built) {
    page.innerHTML = `${P.head("Discover")}
      <div class="sticky" id="discover-sticky">
        <div class="search-row"><form class="search" role="search" data-search-form><svg aria-hidden="true"><use href="#ph-search"/></svg><input id="q" type="search" enterkeyhint="search" placeholder="Search roles, companies, or ATS" aria-label="Search roles, companies, skills, or ATS" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"><button class="clear" type="button" data-act="clear-q" aria-label="Clear search" hidden><svg aria-hidden="true"><use href="#ph-x"/></svg></button></form>
        <button class="icon-btn filter-btn" type="button" data-act="filters" aria-label="Filters"><svg aria-hidden="true"><use href="#ph-sliders"/></svg><span class="badge-num" id="filter-badge" hidden></span></button></div>
        <div class="chips" id="type-chips" role="tablist" aria-label="Job type"></div>
      </div>
      <div class="result-line" id="result-line"></div><div id="hint-slot"></div><div id="job-list" aria-live="polite"></div>`;
    page.querySelector("#q").value = state.query;
    built = true;
  }
  const q = state.query.trim();
  page.querySelector("#q").closest("form").querySelector(".clear").hidden = !state.query;
  const badge = state.fields.length + (state.sort !== "fresh" ? 1 : 0);
  const badgeEl = page.querySelector("#filter-badge");
  badgeEl.hidden = !badge; badgeEl.textContent = badge;
  page.querySelector(".filter-btn").setAttribute("aria-label", badge ? `Filters, ${badge} on` : "Filters");
  P.region(page.querySelector("#type-chips"), FILTERS.map(filter => `<button class="chip" type="button" role="tab" data-type="${filter.key}" aria-selected="${filter.key === state.type}">`
    + `${esc(filter.label)}<small>${tabCount(state.typeCounts, filter).toLocaleString()}</small></button>`).join(""));
  const fieldNames = DEGREE_FILTERS.filter(filter => state.fields.includes(filter.key)).map(filter => filter.label);
  const summary = state.jobs === null ? ""
    : q ? `${state.total.toLocaleString()} ${state.total === 1 ? "match" : "matches"} for “${esc(q)}”`
    : `${state.total.toLocaleString()} ${noun()} · ${esc(fieldNames.length ? fieldNames.join(", ") : "All fields")}`;
  P.region(page.querySelector("#result-line"), `<span>${summary}</span><button type="button" data-act="filters">${SORTS.find(([key]) => key === state.sort)[1]}</button>`);
  P.region(page.querySelector("#hint-slot"), state.hint && !q && state.jobs?.length
    ? `<div class="hint"><span class="hint-art" aria-hidden="true"><i style="background:var(--green)">→</i><i style="background:#59615C">←</i></span>`
      + `<span>Swipe a job right to add it to Applied, left to skip it.</span><button type="button" data-act="hint-off">Got it</button></div>`
    : "");
  const list = page.querySelector("#job-list");
  list.style.opacity = state.reloading ? ".55" : "";
  P.region(list, listMarkup());
}

/* ───────────── Job page ───────────── */
function otherSkillsMarkup(groups, common, expanded) {
  const term = (skill, note) => `<span class="eterm${note ? " common" : ""}" title="${esc(note || skillTitle(skill))}">${esc(skillLabel(skill))}</span>`;
  const fold = groups.common.length
    ? `${expanded ? groups.common.map(skill => term(skill, commonNote(skill, common.get(skill.id)))).join("") : ""}`
      + `<button class="more-link" type="button" data-act="toggle-common" aria-expanded="${expanded}">${foldLabel(groups, expanded)}</button>`
    : "";
  const expertise = groups.expertise.length || groups.common.length
    ? `<div class="kicker">Expertise</div><div class="eterms">${groups.expertise.map(skill => term(skill)).join("")}${fold}</div>`
    : "";
  return expertise + (groups.other.length ? `<div class="kicker">Other</div>${pills(groups.other)}` : "");
}

function jobPage(push) {
  const job = jobById(push.id);
  if (!job) {
    return `<header class="push-bar scrolled"><button class="back" type="button" data-act="back">${icon("back")}Discover</button><span class="push-title"></span><span class="bar-spacer"></span></header>`
      + '<div class="push-scroll"><div class="empty"><strong>This posting is no longer listed</strong>Go back to the list.</div></div>';
  }
  const entry = push.hidden ? hiddenRow(job.id) : null;
  const added = state.added.has(String(job.id));
  const places = placeList(job);
  const term = job.attributes?.term;
  const workplace = workplaceLabel(job.remote);
  const deadline = deadlineLabel(job.attributes?.deadline_at);
  const links = linkChoices(job);
  const common = commonTerms(state.jobs || []);
  const groups = skillGroups(job, common);
  const fact = (label, value) => value ? `<div class="fact"><dt>${label}</dt><dd>${value}</dd></div>` : "";
  const details = fact("Languages", groups.languages.length ? pills(groups.languages) : "")
    + fact("Tools", groups.tools.length ? pills(groups.tools) : "")
    + fact("Other skills", otherSkillsMarkup(groups, common, Boolean(push.common)));
  const summary = String(job.summary || "").trim();
  const others = links.length - 1;
  const actions = entry
    ? `<button class="btn primary block" type="button" data-act="restore" data-id="${esc(job.id)}">${icon("undo")}Restore to feed</button>`
    : `<button class="btn quiet stack" type="button" data-act="skip"${added ? " disabled" : ""}>${icon("eyeoff")}Skip</button><span class="vdiv"></span>
      ${links[0] ? `<a class="btn" href="${esc(links[0].url)}" target="_blank" rel="noopener noreferrer">Apply${icon("out")}</a>` : ""}
      ${added ? `<button class="btn done grow" type="button" data-act="unadd">${icon("check")}Added to Applied</button>` : `<button class="btn primary grow" type="button" data-act="add">${icon("plus")}Add to Applied</button>`}`;
  const placeMore = places.length > 1
    ? `<button class="place-more" type="button" data-act="toggle-places" aria-expanded="${Boolean(push.places)}" aria-label="Show all ${places.length} locations">+${places.length - 1}</button>`
    : "";
  return `<header class="push-bar" id="push-bar"><button class="back" type="button" data-act="back">${icon("back")}${entry ? "Hidden" : "Discover"}</button><span class="push-title">${esc(job.company)}</span>${entry || push.hidden ? '<span class="bar-spacer"></span>' : `<button class="text-btn" type="button" data-act="report">${icon("flag")}Report</button>`}</header>
    <div class="push-scroll" id="push-scroll">${entry ? `<div class="hidden-banner">${icon("eyeoff")}<span>${esc(hiddenReason(entry))}</span></div>` : ""}<div class="d-wrap d-job">
      <div class="d-company">${logo(job, "lg")}<div><b>${esc(job.company)}</b></div></div>
      <h2 class="d-title">${esc(job.title)}</h2>
      <div class="d-meta"><span>${icon("pin")}${esc(places[0])}${placeMore}</span>${workplace ? `<span>${icon("brief")}${esc(workplace)}</span>` : ""}${term ? `<span>${icon("cal")}${esc(term)}</span>` : ""}${deadline ? `<span class="deadline">${esc(deadline)}</span>` : ""}</div>
      ${push.places && places.length > 1 ? `<ul class="place-list">${places.map(place => `<li>${icon("pin")}${esc(place)}</li>`).join("")}</ul>` : ""}
      ${others > 0 ? `<button class="more-link links-link" type="button" data-act="links">${others} other link${others > 1 ? "s" : ""}${icon("down")}</button>` : ""}
      <section class="d-section"><h3>About the role</h3>${summary ? `<p>${esc(summary)}</p>` : '<p class="missing">Summary unavailable. View the original posting for complete details.</p>'}</section>
      ${details ? `<section class="d-section"><h3>Details</h3><dl class="facts">${details}</dl></section>` : ""}
      <footer class="d-footer"><dl class="facts">${fact("Posted", esc(postedFact(job)))}</dl></footer>
    </div></div>
    <footer class="action-bar">${actions}</footer>`;
}
function hiddenPage() {
  const rows = state.hidden;
  const body = state.hiddenError ? P.stateBlock("error", { title: "Hidden postings couldn’t load", detail: state.hiddenError, retry: "retry-hidden" })
    : rows === null ? '<div class="state-box" role="status"><span class="spinner"></span><span>Loading hidden postings.</span></div>'
    : !rows.length ? '<div class="empty"><strong>Nothing hidden</strong>Skipped and mislabeled postings land here, each with Restore.</div>'
    : rows.map(row => `<div class="hidden-row"><button class="hidden-open" type="button" data-open-hidden="${esc(row.job_id)}">${logo(row.job)}<span><b>${esc(row.job.title)}</b>`
      + `<span class="sub">${esc(row.job.company)}</span><span class="reason">${esc(hiddenReason(row))}</span></span></button>`
      + `<button class="btn small" type="button" data-act="restore" data-id="${esc(row.job_id)}">Restore</button></div>`).join("");
  return `<header class="push-bar scrolled"><button class="back" type="button" data-act="back">${icon("back")}Discover</button><span class="push-title">Hidden postings</span><span class="bar-spacer"></span></header>
    <div class="push-scroll" id="push-scroll">${rows?.length ? '<p class="push-intro">Skipped and mislabeled postings, newest first. Restore puts one back in the feed.</p>' : ""}${body}</div>`;
}

/* ───────────── Sheets ───────────── */
const closeButton = `<button class="icon-btn" type="button" data-act="close-sheet" aria-label="Close">${icon("x")}</button>`;
function sheetMarkup(sheet) {
  if (sheet.kind === "filters") {
    return `<div class="grabber"></div><div class="sheet-head"><h2>Filters</h2>${closeButton}</div><div class="sheet-body">
      <div class="sheet-label first">Fields</div>${DEGREE_FILTERS.map(filter => `<button class="opt" type="button" role="checkbox" data-field="${filter.key}" aria-checked="${state.fields.includes(filter.key)}"><span class="box">${icon("check")}</span>${esc(filter.label)}</button>`).join("")}
      <div class="sheet-label">Sort</div>${SORTS.map(([key, label]) => `<button class="opt radio" type="button" role="radio" data-sort-pick="${key}" aria-checked="${state.sort === key}"><span class="box"></span>${label}</button>`).join("")}
      <div class="sheet-label">Hidden</div><button class="opt" type="button" data-act="hidden">${icon("eyeoff")}Hidden postings<span class="opt-end">${state.hiddenTotal.toLocaleString()}${icon("chev")}</span></button></div>
      <div class="sheet-foot"><button class="btn" type="button" data-act="clear-fields"${state.fields.length ? "" : " disabled"}>Show all fields</button><button class="btn primary grow" type="button" data-act="close-sheet">Show ${state.total.toLocaleString()} ${noun()}</button></div>`;
  }
  if (sheet.kind === "report") {
    const job = jobById(sheet.id);
    if (!job) return "";
    const rows = reportRows(job);
    const any = rows.some(row => sheet.rows[row.field]?.on);
    return `<div class="grabber"></div><div class="sheet-head"><div><h2>Report details</h2><p>${esc(job.company)} · ${esc(job.title)}</p></div>${closeButton}</div><div class="sheet-body">
      ${rows.map(row => {
        const entry = sheet.rows[row.field] || {};
        const fix = !entry.on ? ""
          : row.options ? `<label class="field fix"><span class="sr-only">Correct ${row.label.toLowerCase()} (optional)</span><select data-fix="${row.field}"><option value="">Correction (optional)</option>${row.options.map(option => `<option value="${esc(option)}"${entry.to === option ? " selected" : ""}>${esc(option)}</option>`).join("")}</select></label>`
          : row.input ? `<label class="field fix"><span class="sr-only">Correct ${row.label.toLowerCase()}</span><input data-fix="${row.field}" value="${esc(entry.to || "")}" placeholder="Correct ${row.label.toLowerCase()} (optional)" maxlength="300" autocomplete="off"></label>`
          : '<p class="field-hint fix">Flagged for review.</p>';
        return `<button class="opt" type="button" role="checkbox" data-report="${row.field}" aria-checked="${Boolean(entry.on)}"${sheet.sending ? " disabled" : ""}><span class="box">${icon("check")}</span><span>${esc(row.label)}<small>${esc(row.value)}</small></span></button>${fix}`;
      }).join("")}
      ${sheet.error ? `<p class="status-line error" role="alert">${esc(sheet.error)}</p>` : ""}
      <p class="sheet-note">Moves this job to Hidden. You can undo.</p></div>
      <div class="sheet-foot"><button class="btn" type="button" data-act="close-sheet"${sheet.sending ? " disabled" : ""}>Cancel</button><button class="btn primary grow" type="button" data-act="submit-report"${any && !sheet.sending ? "" : " disabled"}>${sheet.sending ? "Reporting…" : "Report"}</button></div>`;
  }
  if (sheet.kind === "links") {
    const job = jobById(sheet.id);
    const links = job ? linkChoices(job) : [];
    return `<div class="grabber"></div><div class="sheet-head"><h2>Listed ${links.length} times</h2>${closeButton}</div><div class="sheet-body end">${links.map((link, index) =>
      `<a class="opt" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer"><span>${esc(link.label)}<small>${esc(linkNote(job, link, index))}</small></span><span class="opt-end">${icon("out")}</span></a>`).join("")}</div>`;
  }
  if (sheet.kind === "skip-why") {
    return `<div class="grabber"></div><div class="sheet-head"><div><h2>Reason</h2><p>Optional. Why skip this one?</p></div>${closeButton}</div><div class="sheet-body end">`
      + `${SKIP_REASONS.map(reason => `<button class="opt" type="button" data-reason="${reason.key}"${sheet.sending ? " disabled" : ""}>${esc(reason.label)}<span class="opt-end">${sheet.sending === reason.key ? "Saving…" : icon("chev")}</span></button>`).join("")}`
      + `${sheet.error ? `<p class="status-line error" role="alert">${esc(sheet.error)}</p>` : ""}</div>`;
  }
  return "";
}

/* ───────────── Events ───────────── */
function onClick(target, d) {
  if (d.openJob) { if (swipe.justDragged) return; S.push = { kind: "job", id: d.openJob }; return P.render(); }
  if (d.openHidden) { S.push = { kind: "job", id: d.openHidden, hidden: true }; return P.render(); }
  if (d.type) {
    if (d.type === state.type) return;
    state.type = d.type; target.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
    return reload();
  }
  if (d.field) { state.fields = state.fields.includes(d.field) ? state.fields.filter(key => key !== d.field) : [...state.fields, d.field]; bump(); return reload(); }
  if (d.sortPick) { if (d.sortPick === state.sort) return; state.sort = d.sortPick; bump(); return reload(); }
  if (d.report) {
    const rows = { ...S.sheet.rows, [d.report]: { ...(S.sheet.rows[d.report] || {}), on: !S.sheet.rows[d.report]?.on } };
    S.sheet = { ...S.sheet, rows };
    return P.render();
  }
  if (d.reason) return giveReason(d.reason);
  switch (d.act) {
    case "filters": S.sheet = { kind: "filters" }; return P.render();
    case "clear-fields": state.fields = []; bump(); return reload();
    case "clear-q": {
      clearTimeout(searchTimer); state.query = "";
      const input = P.$("#q"); input.value = ""; input.focus();
      return reload();
    }
    case "hint-off": hideHint(); return P.render();
    case "hidden": S.sheet = null; S.push = { kind: "hidden" }; P.render(); return loadHidden();
    case "retry-hidden": state.hidden = null; P.render(); return loadHidden();
    case "load-more": return loadJobs({ append: true });
    case "retry": state.error = null; state.jobs = null; return reload();
    case "add": return addJob(S.push.id);
    case "unadd": { const job = jobById(S.push.id); if (job) undoAdd(job); return; }
    case "skip": return skipJob(S.push.id);
    case "report": S.sheet = { kind: "report", id: S.push.id, rows: {} }; return P.render();
    case "submit-report": return submitReport();
    case "toggle-places": S.push = { ...S.push, places: !S.push.places }; return P.render();
    case "toggle-common": S.push = { ...S.push, common: !S.push.common }; return P.render();
    case "links": S.sheet = { kind: "links", id: S.push.id }; return P.render();
    case "restore": return restore(d.id);
  }
}

function wireInputs() {
  const host = P.els.app;
  const saveFix = el => {
    if (el.dataset.fix && S.sheet?.kind === "report") S.sheet.rows[el.dataset.fix] = { ...(S.sheet.rows[el.dataset.fix] || {}), to: el.value };
  };
  host.addEventListener("input", event => {
    const el = event.target;
    if (el.id === "q") {
      state.query = el.value;
      el.closest("form").querySelector(".clear").hidden = !el.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(reload, 250);
    }
    saveFix(el);
  });
  host.addEventListener("change", event => saveFix(event.target));
  host.addEventListener("submit", event => {
    if (!event.target.matches("[data-search-form]")) return;
    event.preventDefault();
    clearTimeout(searchTimer);
    P.$("#q").blur();
    reload();
  });
  host.addEventListener("keydown", event => {
    if (!["Enter", " "].includes(event.key) || !event.target.matches?.("[data-open-job]")) return;
    event.preventDefault();
    event.target.click();
  });
  const page = P.els.page;
  page.addEventListener("scroll", () => {
    P.$("#discover-sticky")?.classList.toggle("stuck", page.scrollTop > 50);
    // Like desktop, the next page loads on its own near the end of the list.
    if (!state.loadingMore && state.jobs && state.jobs.length < state.total && page.scrollTop + page.clientHeight > page.scrollHeight - 600) loadJobs({ append: true });
  }, { passive: true });
}

/* Swipe: drag a row sideways. Right adds to Applied, left skips. */
const swipe = { row: null, justDragged: false };
function wireSwipe() {
  const page = P.els.page;
  page.addEventListener("pointerdown", event => {
    const row = event.target.closest(".job-row");
    if (!row || event.button) return;
    Object.assign(swipe, { row, wrap: row.parentElement, x0: event.clientX, y0: event.clientY, dx: 0, active: false });
  });
  addEventListener("pointermove", event => {
    if (!swipe.row) return;
    const dx = event.clientX - swipe.x0, dy = event.clientY - swipe.y0;
    if (!swipe.active) {
      if (Math.abs(dy) > 10) { swipe.row = null; return; }
      if (Math.abs(dx) < 10) return;
      swipe.active = true; swipe.row.classList.add("dragging"); P.els.app.classList.add("no-select");
      getSelection()?.removeAllRanges();
    }
    swipe.dx = dx;
    swipe.wrap.dataset.dir = dx > 0 ? "add" : "skip";
    swipe.row.style.transform = `translateX(${dx}px)`;
  }, { passive: true });
  const end = event => {
    if (!swipe.row) return;
    const { row, wrap, dx, active } = swipe;
    swipe.row = null; P.els.app.classList.remove("no-select");
    if (!active) return;
    swipe.justDragged = true; setTimeout(() => { swipe.justDragged = false; }, 60);
    row.classList.remove("dragging");
    const id = row.dataset.openJob;
    if (event.type !== "pointercancel" && Math.abs(dx) > 110) {
      row.style.transform = `translateX(${dx > 0 ? 110 : -110}%)`;
      wrap.style.transition = "height .2s ease .15s";
      wrap.style.height = `${wrap.offsetHeight}px`;
      requestAnimationFrame(() => { wrap.style.height = "0px"; });
      setTimeout(() => { hideHint(); dx > 0 ? addJob(id) : skipJob(id); }, 360);
    } else { row.style.transform = ""; delete wrap.dataset.dir; }
  };
  addEventListener("pointerup", end);
  addEventListener("pointercancel", end);
}

P.start({
  tab: "discover",
  paint,
  renderPush: push => push.kind === "hidden" ? hiddenPage() : jobPage(push),
  renderSheet: sheetMarkup,
  version: () => state.v,
  // Typed corrections stay out of the report sheet's signature.
  sheetSig: sheet => sheet.kind === "report"
    ? JSON.stringify([sheet.kind, sheet.id, Object.entries(sheet.rows).map(([field, row]) => [field, Boolean(row.on)]), sheet.sending, sheet.error])
    : JSON.stringify([sheet, state.v]),
  // Back from a hidden posting returns to the hidden list.
  back: () => { if (S.push?.kind === "job" && S.push.hidden) { S.push = { kind: "hidden" }; return true; } return false; },
  onClick,
  start: async () => {
    wireInputs(); wireSwipe();
    try {
      const account = await guest.account();
      state.fields = defaultDegreeFields(account);
      fieldsStore = `${STORE}.fields.v2.${account?.id || "guest"}`;
      try {
        const fields = JSON.parse(sessionStorage.getItem(fieldsStore));
        if (Array.isArray(fields)) state.fields = degreeFields(fields);
      } catch (_) { /* Use account defaults when storage is unavailable. */ }
    } catch (_) { /* Identity unavailable: leave all fields unselected. */ }
    loadJobs(); loadHiddenCount();
  },
});

(function (root) {
  "use strict";

  const FILTERS = [
    { key: "all", label: "All", types: [] },
    { key: "internships", label: "Internships", types: ["intern"] },
    { key: "coops", label: "Co-ops", types: ["coop"] },
    { key: "students", label: "Student Jobs", types: ["student"] },
    { key: "new_grads", label: "New Grad", types: ["new_grad"] },
  ];
  const jobTypes = filters => filters.flatMap(key => FILTERS.find(filter => filter.key === key)?.types || []);
  const relativeTime = (value, now = new Date()) => {
    if (!value) return "Never polled";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Unknown";
    const seconds = Math.max(0, Math.floor((now - date) / 1000));
    if (seconds < 60) return "Just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };
  const daysSince = (value, now) => {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return null;
    return Math.max(0, Math.floor((now - date) / 86400000));
  };
  const dayPhrase = (verb, days) =>
    days === 0 ? `${verb} today` : days === 1 ? `${verb} yesterday` : `${verb} ${days}d ago`;
  // Most feeds publish no posting date. Rather than telling the reader nothing,
  // fall back to when OneShot first saw the posting — the same column the
  // "fresh" sort already orders by, so the label finally explains the order.
  const postedPresentation = (value, now = new Date(), firstSeen = null) => {
    const posted = daysSince(value, now);
    if (posted !== null) return dayPhrase("Posted", posted);
    const added = daysSince(firstSeen, now);
    return added === null ? "Posted date unavailable" : dayPhrase("Added", added);
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { FILTERS, jobTypes, relativeTime, postedPresentation };
  }
  if (!root.document) return;

  const $ = selector => document.querySelector(selector);
  const view = $("#view"), flash = $("#flash");
  const PAGE_SIZE = 100;
  const state = { jobs: null, total: 0, loadingMore: false, selected: null, filters: ["all"], sort: "fresh", query: "" };
  const esc = value => String(value == null ? "" : value).replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
  const safeHref = value => /^https?:\/\//i.test(String(value || "")) ? String(value) : "";
  const attributes = job => job.attributes || {};
  const skills = job => attributes(job).skills || [];
  const initials = job => job.company.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "?";
  const workplace = job => ({ yes: "Remote", hybrid: "Hybrid" })[job?.remote] || "";

  function announce(message, action) {
    flash.replaceChildren();
    const copy = document.createElement("span");
    copy.textContent = message;
    flash.append(copy);
    if (action) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      button.dataset.action = action.name;
      button.dataset.id = action.id;
      flash.append(button);
    }
    flash.classList.toggle("has-action", Boolean(action));
    flash.classList.add("show");
    clearTimeout(announce.timer);
    announce.timer = setTimeout(() => flash.classList.remove("show", "has-action"), action ? 6000 : 3200);
  }

  // The same button the two static shells hand-write into their .workspace-header
  // (see application/index.html). Emitted in the off state and corrected by
  // sample-data.js's sync() in paint() — the state lives there, not here.
  // Absent sample-data.js it is inert markup, and navigation.css keeps it hidden
  // until nav-count.js confirms nobody is signed in.
  const sampleToggle = () => '<button class="sample-toggle" type="button" data-action="sample-toggle" role="switch" aria-checked="false" aria-label="Turn on sample data"><span class="sample-toggle-copy">Sample data<small>Off</small></span><span class="sample-switch" aria-hidden="true"><i></i></span></button>';

  // Every write to #view goes through here. Unlike Applications and Resume, this
  // page's switch is rendered rather than written into the shell, so it appears
  // after sample-data.js has run its one-shot sync and has to be re-synced on
  // each paint or it would read "Off" on a page already serving fixtures.
  const paint = html => { view.innerHTML = html; root.OneShotSampleData?.sync?.(); };

  // The switch is repeated here so a page that cannot reach its API is still
  // recoverable — turning on fixtures with no backend is half of what the
  // feature is for. The head carries no title: this is a failure, not the page.
  const errorState = (title, error) => `<header class="discover-page-head"><button class="menu-button" data-action="menu" aria-label="Open navigation">☰</button>${sampleToggle()}</header><div class="state"><h1>${esc(title)}</h1><p>${esc(error.message || error)}</p><button class="button primary" data-action="retry">Try again</button></div>`;
  const loading = () => { paint('<div class="state loading"><i></i><h1>Loading opportunities</h1><p>Reading the latest API data.</p></div>'); };
  const tags = job => skills(job).slice(0, 3).map(skill => `<span class="tag">${esc(skill)}</span>`).join("") + (skills(job).length > 3 ? `<span class="tag">+${skills(job).length - 3}</span>` : "");
  const facts = job => [job.location || "Location not listed", attributes(job).term, workplace(job)].filter(Boolean);
  const freshness = job => postedPresentation(job.posted_at, new Date(), job.first_seen_at);

  // Sources flatten a posting's markup before it reaches us, so the bullet list
  // arrives as one run of text with the bullet characters left inline. Splitting
  // on them restores the structure the posting actually had.
  // Not the middle dot: boards use it as ordinary punctuation often enough that
  // splitting on it would shred prose rather than reveal a list.
  const BULLETS = /\s*[•●▪‣]\s*/;
  function summaryMarkup(job) {
    const text = String(job.summary || "").trim();
    if (!text) return '<p class="detail-description">Summary unavailable. View the original posting for complete details.</p>';
    const [lead, ...rest] = text.split(BULLETS);
    const items = rest.map(item => item.trim()).filter(Boolean);
    if (!items.length) return `<p class="detail-description">${esc(text)}</p>`;
    const intro = lead.trim() ? `<p class="detail-description">${esc(lead.trim())}</p>` : "";
    return `${intro}<ul class="detail-bullets">${items.map(item => `<li>${esc(item)}</li>`).join("")}</ul>`;
  }

  function filtersMarkup() {
    return FILTERS.map(filter => {
      const active = state.filters.includes(filter.key);
      return `<button class="filter ${active ? "active" : ""}" type="button" role="tab" data-filter="${filter.key}" aria-selected="${active}" tabindex="${active ? "0" : "-1"}">${filter.label}</button>`;
    }).join("");
  }

  function opportunity(job) {
    const recent = new Date(job.posted_at || job.first_seen_at).getTime() > Date.now() - 3 * 86400000;
    return `<article class="opportunity ${String(job.id) === String(state.selected) ? "selected" : ""}" data-job="${esc(job.id)}" tabindex="0" role="button" aria-selected="${String(job.id) === String(state.selected)}"><div class="job-logo">${esc(initials(job))}</div><div class="opportunity-main"><div class="job-title-line"><h3>${esc(job.title)}</h3>${recent ? '<span class="new-badge">New</span>' : ""}</div><div class="job-company">${esc(job.company)}</div><div class="meta">${esc(facts(job).join(" · "))}</div><div class="tags">${tags(job)}</div><div class="job-footline"><span>${esc(freshness(job))}</span></div></div></article>`;
  }

  function detail(job) {
    if (!job) return '<aside class="detail"><div class="section-kicker">Selection</div><h2>Choose a job</h2><p>Select a role to review its details and add it to Applications.</p></aside>';
    const applyUrl = safeHref(job.apply_url);
    return `<aside class="detail"><div class="detail-head-row"><div class="job-logo large">${esc(initials(job))}</div><div><div class="detail-company">${esc(job.company)}</div><div class="meta">${esc(facts(job).join(" · "))}</div></div></div><h2>${esc(job.title)}</h2><div class="detail-actions"><button class="button primary" data-action="add-to-applications" data-id="${esc(job.id)}">Add to Applications</button>${applyUrl ? `<a class="button" href="${esc(applyUrl)}" target="_blank" rel="noopener noreferrer">Open posting ↗</a>` : ""}</div><section><div class="section-kicker">Job details</div><div class="tags">${tags(job) || '<span class="meta">No structured details available</span>'}</div></section><section><div class="section-kicker">Role summary</div>${summaryMarkup(job)}</section><div class="detail-freshness">${esc(freshness(job))}${job.last_seen_at ? ` · Last confirmed active ${esc(relativeTime(job.last_seen_at))}` : ""}</div></aside>`;
  }

  function pagerMarkup(jobs) {
    if (!jobs.length) return "";
    const hasMore = jobs.length < state.total;
    const more = hasMore ? `<button class="button" type="button" data-action="load-more" ${state.loadingMore ? "disabled" : ""}>${state.loadingMore ? "Loading…" : "Load more"}</button>` : "";
    return `<div class="list-pager"><span class="list-pager-count">Showing ${jobs.length.toLocaleString()} of ${state.total.toLocaleString()}</span>${more}</div>`;
  }

  function render() {
    const search = $("#discover-search"), restoreFocus = search && document.activeElement === search, selectionStart = restoreFocus ? search.selectionStart : null;
    const jobs = state.jobs || [], selected = jobs.find(job => String(job.id) === String(state.selected));
    paint(`<section class="discover-page"><header class="discover-page-head"><button class="menu-button" data-action="menu" aria-label="Open navigation">☰</button><div><div class="section-kicker">Multi-source intelligence</div><h1>Opportunities</h1></div>${sampleToggle()}</header><div class="discover-grid"><div class="discover-search-surface"><label class="discover-search"><svg class="discover-search-icon" aria-hidden="true"><use href="#icon-search"/></svg><span class="sr-only">Search opportunities</span><input id="discover-search" data-search placeholder="Search roles, companies, or skills" autocomplete="off" value="${esc(state.query)}"><kbd>⌘K</kbd></label><label class="discover-sort"><select data-sort aria-label="Sort opportunities"><option value="fresh" ${state.sort === "fresh" ? "selected" : ""}>Newest first</option><option value="company" ${state.sort === "company" ? "selected" : ""}>Company A–Z</option><option value="title" ${state.sort === "title" ? "selected" : ""}>Role title A–Z</option></select></label></div><section class="discover-controls-pane" aria-label="Opportunity controls"><div class="discover-filterbar" role="tablist" aria-label="Job types">${filtersMarkup()}</div></section><div class="opportunity-list" role="tabpanel" aria-label="Opportunity results">${jobs.length ? jobs.map(opportunity).join("") : '<div class="empty"><h2>No matching jobs yet</h2><p>Try another search.</p></div>'}${pagerMarkup(jobs)}</div>${detail(selected)}</div></section>`);
    if (restoreFocus) {
      const next = $("#discover-search");
      next.focus();
      if (selectionStart != null) next.setSelectionRange(selectionStart, selectionStart);
    }
  }

  async function loadJobs({ append = false } = {}) {
    if (append) {
      state.loadingMore = true;
      render();
    } else if (state.jobs === null) {
      loading();
    }
    try {
      const offset = append ? (state.jobs || []).length : 0;
      const payload = await root.OneShotAPI.jobs.list({ q: state.query, sort: state.sort, job_type: jobTypes(state.filters), limit: PAGE_SIZE, offset });
      state.total = payload.total;
      state.jobs = append ? [...(state.jobs || []), ...payload.jobs] : payload.jobs;
      state.loadingMore = false;
      if (!append && !state.jobs.some(job => String(job.id) === String(state.selected))) state.selected = state.jobs[0]?.id || null;
      render();
    } catch (error) {
      state.loadingMore = false;
      if (append) {
        render();
        announce(error.message || "Couldn’t load more opportunities.");
      } else {
        paint(errorState("Opportunities couldn’t load", error));
      }
    }
  }

  async function addToApplications(id) {
    // The added job leaves the list, so holding your place means landing on the
    // job that takes its slot — the next one down — rather than being thrown
    // back to the top of several thousand results mid-triage. Naming the
    // successor by id rather than by index survives rows shifting underneath.
    const listed = state.jobs || [];
    const position = listed.findIndex(job => String(job.id) === String(id));
    const selectedJob = position < 0 ? null : listed[position];
    const successor = position < 0 ? null : listed[position + 1];
    const application = await root.OneShotAPI.jobs.addToApplications(id, selectedJob);
    // state.jobs deliberately survives the reload. Nulling it repaints the whole
    // view as the loading state, which collapses the list and throws scroll back
    // to the top — undoing exactly what the successor above is preserving. The
    // slightly stale list stays on screen for one fetch, then re-renders in place.
    state.selected = successor ? successor.id : null;
    await loadJobs();
    await root.OneShotOpportunityCount.refresh();
    announce(application.already_exists ? "This job is already in Applications." : "Added to Applications.", application.already_exists ? null : { label: "Undo", name: "undo-add", id: application.id });
  }

  document.addEventListener("click", async event => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    try {
      if (action === "menu") return $(".sidebar").classList.toggle("open");
      if (action === "retry") return start();
      if (action === "load-more") return state.loadingMore ? undefined : loadJobs({ append: true });
      if (action === "add-to-applications") return addToApplications(event.target.closest("[data-id]").dataset.id);
      if (action === "undo-add") {
        await root.OneShotAPI.applications.remove(event.target.closest("[data-id]").dataset.id);
        await loadJobs();
        await root.OneShotOpportunityCount.refresh();
        return announce("Addition undone.");
      }
      const job = event.target.closest("[data-job]");
      if (job) {
        state.selected = job.dataset.job;
        render();
      }
    } catch (error) {
      announce(error.message || "That action could not be completed.");
    }
  });
  document.addEventListener("click", event => {
    const filter = event.target.closest("[data-filter]");
    if (!filter) return;
    state.filters = [filter.dataset.filter];
    loadJobs();
  });
  document.addEventListener("keydown", event => {
    const tab = event.target.closest('[role="tab"][data-filter]');
    if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...tab.parentElement.querySelectorAll('[role="tab"][data-filter]')];
    const at = tabs.indexOf(tab);
    const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1) : tabs[(at + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    event.preventDefault();
    next.click();
  });
  document.addEventListener("change", event => {
    if (!event.target.matches("[data-sort]")) return;
    state.sort = event.target.value;
    loadJobs();
  });
  document.addEventListener("input", event => {
    if (!event.target.matches("[data-search]")) return;
    state.query = event.target.value;
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(loadJobs, 250);
  });
  document.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      return $("#discover-search")?.focus();
    }
    const focused = event.target.closest?.("[data-job]");
    if (focused && ["Enter", " "].includes(event.key)) {
      event.preventDefault();
      state.selected = focused.dataset.job;
      return render();
    }
    if (/input|textarea|select/i.test(document.activeElement.tagName) || !["j", "k"].includes(event.key.toLowerCase())) return;
    const rows = [...document.querySelectorAll("[data-job]")], current = Math.max(0, rows.findIndex(row => row.dataset.job === String(state.selected))), offset = event.key.toLowerCase() === "j" ? 1 : -1, next = rows[current + offset];
    if (next) {
      state.selected = next.dataset.job;
      render();
      document.querySelector(`[data-job="${CSS.escape(String(state.selected))}"]`)?.focus();
    }
  });

  async function start() {
    try {
      await root.OneShotAPI.health();
      await loadJobs();
    } catch (error) {
      paint(errorState("OneShot is unavailable", error));
    }
  }
  start();
})(typeof window !== "undefined" ? window : globalThis);

(function (root) {
  "use strict";

  const safeDate = value => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const number = value => new Intl.NumberFormat().format(Number(value) || 0);
  const compact = value => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(Number(value) || 0);
  const relativeTime = (value, now = new Date()) => {
    const date = safeDate(value);
    if (!date) return "Never polled";
    const seconds = Math.max(0, Math.floor((now - date) / 1000));
    if (seconds < 60) return "Just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
  };
  const withTimeout = (promise, milliseconds = 8000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The feed overview request timed out.")), milliseconds);
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });

  const CELL_STATES = ["ok", "degraded", "failing", "stale", "paused", "never"];
  const stateKey = value => {
    const key = String(value || "").trim().toLowerCase();
    return CELL_STATES.includes(key) ? key : "unknown";
  };
  // The API's state keys stay as they are; these are the words people read.
  const STATE_LABEL = { ok: "healthy", failing: "failing", degraded: "retrying", stale: "overdue", paused: "paused", never: "unpolled", unknown: "unknown" };
  const PROBLEM_ORDER = ["failing", "degraded", "stale", "paused", "never", "unknown"];
  const SEVERITY = { failing: 0, degraded: 1, stale: 2, paused: 3, never: 4, unknown: 5, ok: 9 };

  const fleetTotals = payload => {
    const providers = Array.isArray(payload?.providers) ? payload.providers : [];
    const counts = { boards: 0, providers: providers.length, ok: 0, erroring: 0, stale: 0, paused: 0, never: 0, roles: 0 };
    for (const provider of providers) {
      for (const board of Array.isArray(provider.boards) ? provider.boards : []) {
        counts.boards += 1;
        counts.roles += Number(board.coverage) || 0;
        const state = stateKey(board.state);
        if (state === "ok") counts.ok += 1;
        else if (state === "failing" || state === "degraded") counts.erroring += 1;
        else if (state === "stale") counts.stale += 1;
        else if (state === "paused") counts.paused += 1;
        else counts.never += 1;
      }
    }
    const totals = payload?.totals;
    const roles = Number.isSafeInteger(totals?.active_postings) && totals.active_postings >= 0
      ? totals.active_postings : counts.roles;
    return totals && Number.isFinite(Number(totals.boards)) ? { ...counts, ...totals, roles } : counts;
  };

  // Missing closure data is unknown, rather than a fabricated zero.
  const todayLine = totals => {
    const jobs = Number(totals?.added_today) || 0;
    const closed = totals?.disappeared_today;
    if (closed != null) return `${number(jobs)} jobs posted, ${number(closed)} jobs closed today`;
    return jobs ? `${number(jobs)} jobs posted today` : "";
  };

  // "2026-09-09" is a calendar day in the pipeline's zone: read it as a local
  // date so it never slips a day for someone east or west of it.
  const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  const shortDate = value => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    return match ? DAY_FORMAT.format(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : "";
  };

  // A few named examples behind the headline number: proof it is real, not a
  // feed to read, so the card never grows past a handful of rows.
  const CARD_ROWS = 3;
  const tickerCard = (payload, now = new Date()) => ({
    jobs: (Array.isArray(payload?.latest_jobs) ? payload.latest_jobs : []).slice(0, CARD_ROWS).map(job => ({
      company: String(job.company || ""),
      title: String(job.title || ""),
      ago: relativeTime(job.first_seen_at, now),
    })),
    feeds: (Array.isArray(payload?.new_feeds?.latest) ? payload.new_feeds.latest : []).slice(0, CARD_ROWS).map(feed => ({
      company: String(feed.company || ""),
      source: String(feed.source || ""),
      date: shortDate(feed.added_on),
    })),
  });

  const problemText = problems => PROBLEM_ORDER
    .filter(state => problems[state])
    .map(state => `${problems[state]} ${STATE_LABEL[state]}`)
    .join(" · ");

  // Trouble first (worst first), then healthy boards heaviest first: each band
  // reads as a gradient with its problems pinned to the top-left corner.
  const byWeight = boards => [...boards].sort((a, b) => (SEVERITY[a.state] - SEVERITY[b.state]) || (b.jobs - a.jobs));

  // Rank providers by their deduplicated, active student jobs eligible for
  // Discover. Every provider appears in the same list.
  const buildBands = payload => {
    const groups = [];
    for (const provider of Array.isArray(payload?.providers) ? payload.providers : []) {
      const list = Array.isArray(provider.boards) ? provider.boards : [];
      if (!list.length) continue;
      const group = { id: String(provider.source || "?"), label: String(provider.source || "?"), boards: [], jobs: 0, discoverJobs: Number(provider.discover_jobs) || 0, problems: {} };
      for (const board of list) {
        const state = stateKey(board.state);
        const jobs = Number(board.coverage) || 0;
        group.boards.push({
          company: board.company || board.key,
          state,
          strikes: Number(board.strikes) || 0,
          jobs,
          last_poll_at: board.last_poll_at || null,
        });
        group.jobs += jobs;
        if (state !== "ok") group.problems[state] = (group.problems[state] || 0) + 1;
      }
      group.boards = byWeight(group.boards);
      groups.push(group);
    }
    groups.sort((a, b) => b.discoverJobs - a.discoverJobs || a.id.localeCompare(b.id));
    return groups;
  };

  const exported = { relativeTime, withTimeout, stateKey, fleetTotals, todayLine, shortDate, tickerCard, problemText, buildBands, STATE_LABEL };
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  if (!root.document) return;

  const $ = selector => document.querySelector(selector);
  const content = $("#coverage-content");
  const esc = value => String(value == null ? "" : value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const readVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const plural = (count, one, many) => `${count === 1 ? one : many}`;

  // Cell geometry: a 3px square on a 4px pitch. Every band measures its own
  // width, so expanded provider rows share the code.
  const PITCH = 4;
  const CELL = 3;
  const SNAP_RADIUS = 2;
  const RAMP_MAX_JOBS = 10000;

  let bands = [];
  let bandsById = new Map();
  let expandedProvider = null;
  let palette = {};

  // Healthy boards shade from light to dark by how many jobs they carry (log
  // scale, 10k+ saturates); every other state is one flat colour.
  function readPalette() {
    const hex = value => [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16));
    const low = hex(readVar("--cell-ok-low")), high = hex(readVar("--cell-ok-high"));
    const maxLog = Math.log1p(RAMP_MAX_JOBS);
    palette = {
      gap: readVar("--cell-gap"),
      ramp: jobs => {
        const t = Math.min(1, Math.log1p(jobs) / maxLog);
        return `rgb(${low.map((channel, index) => Math.round(channel + (high[index] - channel) * t)).join(",")})`;
      },
      failing: readVar("--cell-failing"),
      degraded: readVar("--cell-degraded"),
      stale: readVar("--cell-stale"),
      idle: readVar("--cell-idle"),
    };
  }
  const cellColor = board => board.state === "ok" ? palette.ramp(board.jobs) : palette[board.state] || palette.idle;

  const SUMMARY_STATES = ["ok", "degraded", "stale", "failing", "paused", "never", "unknown"];
  const CORE_STATES = SUMMARY_STATES.slice(0, 4);
  const healthCounts = group => ({ ...group.problems,
    ok: group.boards.length - Object.values(group.problems).reduce((sum, value) => sum + value, 0) });

  function providerListMarkup() {
    // Share widths across providers, sized to the actual counts and labels.
    // Four core states stay together without the padding of equal-width slots.
    const widths = CORE_STATES.map(state => STATE_LABEL[state].length + 2);
    for (const group of bands) {
      const counts = healthCounts(group);
      SUMMARY_STATES.forEach((state, index) => {
        if (state !== "never" && (index < 4 || counts[state])) widths[index % 4] = Math.max(widths[index % 4],
          number(counts[state]).length + 1 + STATE_LABEL[state].length);
      });
    }
    return `<div class="wall" style="--health-columns:${widths.map(width => `${width}ch`).join(" ")}"><div id="provider-list" class="provider-list">${bands.map(providerMarkup).join("")}</div></div>`;
  }

  const PROVIDER_NAMES = {
    workday: "Workday", oracle: "Oracle", greenhouse: "Greenhouse", ukg: "UKG",
    smartrecruiters: "SmartRecruiters", eightfold: "Eightfold",
    lever: "Lever", recruitee: "Recruitee", ashby: "Ashby", bamboohr: "BambooHR",
    workable: "Workable", rippling: "Rippling", gem: "Gem", icims: "iCIMS",
    avature: "Avature", amazon: "Amazon", janestreet: "Jane Street", apple: "Apple",
    adp: "ADP", comeet: "Comeet", dayforce: "Dayforce", flyio: "Fly.io",
    hn: "Hacker News", homerun: "Homerun", jazzhr: "JazzHR", join: "Join",
    manatal: "Manatal", personio: "Personio", pinpoint: "Pinpoint", simplify: "Simplify",
    successfactors: "SuccessFactors", teamtailor: "Teamtailor", trakstar: "Trakstar",
    unstop: "Unstop", vincere: "Vincere", zohorecruit: "Zoho Recruit",
  };

  function providerMarkup(group) {
    const count = group.boards.length;
    const label = PROVIDER_NAMES[group.id] || group.label;
    const states = ["ok", "degraded", "failing", "stale", "paused", "never", "unknown"];
    const counts = healthCounts(group);
    // Keep all four core states visible, including measured zero counts.
    const description = SUMMARY_STATES.filter(state => CORE_STATES.includes(state) || counts[state])
      .map(state => `${number(counts[state])} ${STATE_LABEL[state]}`).join(", ");
    // Fixed slots keep each state's count aligned across providers; omit
    // optional zero states without moving the remaining counts between columns.
    const summary = SUMMARY_STATES.map((state, index) =>
      state !== "never" && (CORE_STATES.includes(state) || counts[state])
        ? `<span class="health-status" data-state="${state}" style="--status-column:${index % 4 + 1};--status-row:${Math.floor(index / 4) + 1}"><span class="health-count">${number(counts[state])}</span><span class="health-label">${STATE_LABEL[state]}</span></span>`
        : "").join("");
    const meta = `<span class="provider-board-count">${number(count)} ${plural(count, "board", "boards")}</span> <span class="provider-count-separator" aria-hidden="true">|</span> <span class="provider-job-count">${compact(group.jobs)} ${plural(group.jobs, "job", "jobs")}</span>`;
    const segments = states.filter(state => counts[state]).map(state => `<span class="health-${state}" style="flex-grow:${counts[state]}"></span>`).join("");
    const open = expandedProvider === group.id;
    const detailId = `provider-detail-${encodeURIComponent(group.id)}`;
    const tipId = `provider-health-${encodeURIComponent(group.id)}`;
    return `<div class="provider-entry${open ? " is-open" : ""}"><button type="button" class="provider-row" data-provider="${esc(group.id)}" aria-expanded="${open}" aria-controls="${esc(detailId)}" aria-describedby="${esc(tipId)}"><span class="provider-identity"><svg class="provider-chevron" aria-hidden="true" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg><span class="provider-name">${esc(label)}</span></span><span class="provider-health"><span class="health-track" role="img" aria-label="${esc(description)}">${segments}</span><span class="health-summary"><span class="health-status-grid">${summary}</span><span class="health-tooltip" id="${esc(tipId)}" role="tooltip">${esc(description)}</span></span></span><span class="provider-counts">${meta}</span></button><div id="${esc(detailId)}" class="provider-detail"${open ? "" : " hidden"}>${open ? `<div class="band mini" data-band="${esc(group.id)}"><canvas role="img" aria-label="${esc(label)}: ${esc(description)}"></canvas></div>` : ""}</div></div>`;
  }

  function renderWall() {
    content.innerHTML = providerListMarkup();
    drawWall();
    for (const button of content.querySelectorAll(".provider-row")) {
      button.addEventListener("click", () => {
        expandedProvider = expandedProvider === button.dataset.provider ? null : button.dataset.provider;
        hideTip();
        renderWall();
        Array.from(content.querySelectorAll(".provider-row")).find(row => row.dataset.provider === button.dataset.provider).focus({ preventScroll: true });
      });
    }
    for (const canvas of content.querySelectorAll(".band[data-band] > canvas")) {
      const band = bandsById.get(canvas.parentElement.dataset.band);
      const probe = event => {
        const box = canvas.getBoundingClientRect();
        const board = pickBoard(band, event.clientX - box.left, event.clientY - box.top);
        if (board) showTip(board, event.clientX, event.clientY);
        else hideTip();
      };
      canvas.addEventListener("pointermove", probe);
      canvas.addEventListener("pointerdown", probe);
      canvas.addEventListener("pointerleave", event => { if (event.pointerType === "mouse") hideTip(); });
    }
  }

  function drawWall() {
    const ratio = root.devicePixelRatio || 1;
    for (const element of content.querySelectorAll(".band[data-band]")) {
      const band = bandsById.get(element.dataset.band);
      const canvas = element.querySelector(":scope > canvas");
      const columns = band.columns = Math.max(8, Math.floor((element.clientWidth + (PITCH - CELL)) / PITCH));
      const width = columns * PITCH, height = Math.ceil(band.boards.length / columns) * PITCH;
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const context = canvas.getContext("2d");
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      // Tint only occupied pitches: the last row keeps its original silhouette.
      // This softens the 1px gutters against the white page without adding a box.
      const fullRows = Math.floor(band.boards.length / columns);
      const remainder = band.boards.length % columns;
      context.fillStyle = palette.gap;
      context.fillRect(0, 0, width, fullRows * PITCH);
      if (remainder) context.fillRect(0, fullRows * PITCH, remainder * PITCH, PITCH);
      band.boards.forEach((board, index) => {
        context.fillStyle = cellColor(board);
        context.fillRect((index % columns) * PITCH, Math.floor(index / columns) * PITCH, CELL, CELL);
      });
    }
  }

  // Snap to the cell under the pointer, then prefer any problem board within a
  // couple of cells: those are what someone crossing the wall is aiming for,
  // and they are too small to hit exactly.
  function pickBoard(band, x, y) {
    const total = band.boards.length, columns = band.columns;
    const column = Math.floor(x / PITCH), row = Math.floor(y / PITCH);
    const index = row * columns + column;
    if (column < 0 || row < 0 || column >= columns || index >= total) return null;
    if (band.boards[index].state !== "ok") return band.boards[index];
    let nearest = null, nearestDistance = Infinity;
    for (let dr = -SNAP_RADIUS; dr <= SNAP_RADIUS; dr += 1) {
      for (let dc = -SNAP_RADIUS; dc <= SNAP_RADIUS; dc += 1) {
        const r = row + dr, c = column + dc, candidate = r * columns + c;
        if (r < 0 || c < 0 || c >= columns || candidate >= total || band.boards[candidate].state === "ok") continue;
        const distance = Math.hypot(dr, dc);
        if (distance < nearestDistance) { nearestDistance = distance; nearest = band.boards[candidate]; }
      }
    }
    return nearest || band.boards[index];
  }

  function showTip(board, pointerX, pointerY) {
    const tip = $("#board-tip");
    // With no legend on the page, the card names the state; its swatch is
    // the cell's own colour, so the two always agree.
    const strikes = board.strikes ? `<span>· ${esc(board.strikes)} ${board.strikes === 1 ? "strike" : "strikes"}</span>` : "";
    tip.innerHTML = `<div class="tip-name">${esc(board.company)}</div>
      <div class="tip-state"><i style="background: ${esc(cellColor(board))}"></i><b>${esc(STATE_LABEL[board.state] || STATE_LABEL.unknown)}</b>${strikes}</div>
      <div class="tip-row"><span>jobs</span><b>${esc(number(board.jobs))}</b></div>
      <div class="tip-row"><span>last polled</span><b>${esc(board.last_poll_at ? relativeTime(board.last_poll_at) : "never")}</b></div>`;
    tip.classList.add("visible");
    const width = tip.offsetWidth, height = tip.offsetHeight;
    let x = pointerX + 16, y = pointerY + 16;
    if (x + width > root.innerWidth - 8) x = pointerX - width - 16;
    if (y + height > root.innerHeight - 8) y = pointerY - height - 16;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }

  function hideTip() {
    $("#board-tip")?.classList.remove("visible");
  }

  function renderClassification(values) {
    $(".classification-summary").hidden = !values;
    if (!values) return;
    for (const [selector, key] of [[".classification-total", "total"], [".classification-students", "student_roles"]]) {
      const counter = $(selector);
      const value = values[key];
      if (!counter || !Number.isSafeInteger(value) || value < 0) continue;
      if (counter.dataset.initialized && Number(counter.dataset.count) === value) continue;
      const next = number(value);
      const previous = counter.dataset.initialized ? number(counter.dataset.count).padStart(next.length) : "";
      const digits = document.createDocumentFragment();
      [...next].forEach((character, index) => {
        const digit = document.createElement("span");
        digit.className = "classification-digit";
        if (character !== previous[index] && /\d/.test(character)) digit.classList.add("is-changing");
        digit.style.setProperty("--digit-delay", `${(next.length - index - 1) * 22}ms`);
        digit.setAttribute("aria-hidden", "true");
        digit.textContent = character;
        digits.append(digit);
      });
      counter.setAttribute("aria-label", next);
      counter.replaceChildren(digits);
      counter.dataset.count = String(value);
      counter.dataset.initialized = "true";
    }
  }

  function renderHeader(payload) {
    renderClassification(payload.classification);
    const totals = fleetTotals(payload);
    $("#fleet-stats").innerHTML = [
      `<strong>${esc(number(totals.boards))}</strong> boards`,
      `<strong>${esc(number(totals.providers))}</strong> providers`,
      `<strong>${esc(number(totals.roles))}</strong> active jobs`,
    ].join('<span class="stat-sep" aria-hidden="true"> | </span>');
    renderTicker(payload, totals);
  }

  function cardSection(label, count, rows) {
    if (!rows.length) return "";
    return `<section class="card-section"><div class="card-head"><span class="card-label">${esc(label)}</span>${count ? `<span class="card-count">${esc(count)}</span>` : ""}</div>${rows.join("")}</section>`;
  }

  function renderTicker(payload, totals) {
    const line = todayLine(totals);
    const ticker = $("#ticker");
    ticker.hidden = !line;
    $("#today-line").innerHTML = `<span class="activity-added activity-total">${number(totals.added_today)}</span> jobs posted`
      + (totals.disappeared_today != null
        ? `, <span class="activity-disappeared activity-total">${number(totals.disappeared_today)}</span> jobs closed today`
        : " today");
    $(".ticker-toggle").setAttribute("aria-label", `${line}. Show breakdown`);
    const card = $("#ticker-card");
    const detail = payload.today_breakdown || {};
    const jobTypes = [
      ["internships", "intern"], ["co-ops", "coop"],
      ["student jobs", "student"], ["new grad", "new_grad"],
      ["research", "research"], ["unclassified", "unclassified"],
    ];
    const signedCount = (value, sign) => value == null ? "—" : `${Number(value) === 0 ? "" : sign}${number(value)}`;
    for (const [side, total, values, sign, minimum] of [
      ["posted", totals.added_today, detail.types, "+", 1],
      ["closed", totals.disappeared_today, detail.disappeared?.types, "−", 1],
    ]) {
      const digits = Math.max(minimum, total == null ? 1 : number(total).length,
        ...jobTypes.map(([, key]) => signedCount(values?.[key], sign).length));
      ticker.style.setProperty(`--activity-${side}-width`, `${digits}ch`);
    }
    const cell = (value, sign, label, side) => `<td class="activity-cell ${side}${value == null ? " is-unknown" : Number(value) === 0 ? " is-zero" : ""}"><span class="activity-number">${signedCount(value, sign)}</span> <span class="activity-category">${esc(label)}</span></td>`;
    card.innerHTML = `<table class="today-table">
      <caption class="visually-hidden">Jobs posted and closed today, by job type</caption>
      <thead class="visually-hidden"><tr>
        <th scope="col">Posted</th>
        <th scope="col">Closed</th>
      </tr></thead>
      <tbody>${jobTypes.map(([label, key]) => `<tr${key === "unclassified" ? ' class="today-unclassified"' : ""}>
        ${cell(detail.types?.[key], "+", label, "activity-added")}
        ${cell(detail.disappeared?.types?.[key], "−", label, "activity-disappeared")}
      </tr>`).join("")}</tbody>
    </table>`
      + '<p class="dedup-note">Duplicate postings are filtered</p>';
    $("#ticker").classList.toggle("has-card", Boolean(card.innerHTML));
    if (!card.innerHTML) setCard(false);
    else if (!card.hidden) setCard(true);
  }

  function setCard(open) {
    const card = $("#ticker-card");
    const shown = Boolean(open && card.innerHTML);
    card.hidden = !shown;
    $(".ticker-toggle").setAttribute("aria-expanded", String(shown));
    if (shown) {
      const ticker = $("#ticker");
      const origin = ticker.getBoundingClientRect().left;
      const trigger = $(".ticker-toggle").getBoundingClientRect();
      const posted = $("#today-line .activity-added").getBoundingClientRect();
      const inset = parseFloat(getComputedStyle(card).paddingLeft) + 1;
      card.style.width = `${Math.min(root.innerWidth - 8, Math.max(320, trigger.width + inset * 2))}px`;
      const postedWidth = card.querySelector('.activity-added .activity-number').getBoundingClientRect().width;
      const left = Math.max(4, Math.min(posted.right - postedWidth - inset, root.innerWidth - card.offsetWidth - 4));
      card.style.left = `${left - origin}px`;
      const table = card.querySelector('.today-table').getBoundingClientRect();
      ticker.style.setProperty('--activity-posted-indent', `${Math.max(0, posted.right - postedWidth - table.left)}px`);
      const closed = $("#today-line .activity-disappeared")?.getBoundingClientRect();
      const gap = parseFloat(getComputedStyle(card.querySelector('.today-table')).columnGap);
      const closedWidth = card.querySelector('.activity-disappeared .activity-number').getBoundingClientRect().width;
      const firstColumn = closed ? closed.right - closedWidth - table.left - gap : 0;
      // The sentence stays natural; only the pane follows the totals' positions.
      if (closed && Math.abs(closed.top - posted.top) < 1 && firstColumn > 0 && firstColumn < table.width - gap) {
        ticker.style.setProperty('--activity-first-column', `${firstColumn}px`);
      } else {
        ticker.style.removeProperty('--activity-first-column');
      }
    }
  }

  function render(payload) {
    bands = buildBands(payload);
    bandsById = new Map();
    for (const band of bands) {
      bandsById.set(band.id, band);
    }
    if (!bandsById.has(expandedProvider)) expandedProvider = null;
    renderHeader(payload);
    if (!bands.length) {
      content.innerHTML = `<div class="state"><span class="state-icon"><svg aria-hidden="true"><use href="#icon-sources"/></svg></span><h2>No feed overview data yet</h2><p>Configured feeds will appear here after status data becomes available.</p></div>`;
      return;
    }
    readPalette();
    renderWall();
  }

  function renderError(error) {
    bands = [];
    content.innerHTML = `<div class="state"><span class="state-icon error"><svg aria-hidden="true"><use href="#icon-alert"/></svg></span><h2>Feed overview could not load</h2><p>${esc(error?.message || error || "The feed overview service is unavailable.")}</p><button type="button" data-action="retry">Try again</button></div>`;
  }

  function setStale(stale) {
    const note = $("#stale-note");
    if (note) note.hidden = !stale;
  }

  const REFRESH_MS = 60000;
  let lastGoodAt = 0, inFlight = false;

  async function refresh({ initial = false } = {}) {
    if (inFlight) return;
    inFlight = true;
    if (initial) content.innerHTML = `<div class="state loading-state"><span class="spinner"></span><p>Loading feed overview…</p></div>`;
    try {
      render(await withTimeout(root.OneShotAPI.sources.boards()));
      lastGoodAt = Date.now();
      setStale(false);
    } catch (error) {
      if (initial || !lastGoodAt) renderError(error);
      else setStale(true);
    } finally {
      inFlight = false;
    }
  }

  // Two formats joined by a space: one combined format puts a comma between
  // the date and the time.
  const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
  const CLOCK_FORMAT = new Intl.DateTimeFormat(undefined, {
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true, timeZoneName: "short",
  });

  function updateClock() {
    const clock = $("#clock");
    const now = new Date();
    if (clock) clock.textContent = `${DATE_FORMAT.format(now)} ${CLOCK_FORMAT.format(now)}`;
  }

  document.addEventListener("click", event => {
    if (event.target.closest('[data-action="retry"]')) refresh({ initial: true });
    if (!event.target.closest("#ticker")) setCard(false);
  });
  // A mouse opens the card by hovering; touch and keyboard toggle it. A click
  // while hovering must not close the card the hover just opened.
  const ticker = $("#ticker");
  let hoverOpen = false;
  ticker.addEventListener("pointerenter", event => { if (event.pointerType === "mouse") { hoverOpen = true; setCard(true); } });
  ticker.addEventListener("pointerleave", event => { if (event.pointerType === "mouse") { hoverOpen = false; setCard(false); } });
  $(".ticker-toggle").addEventListener("click", () => { if (!hoverOpen) setCard($("#ticker-card").hidden); });
  ticker.addEventListener("focusout", event => { if (!ticker.contains(event.relatedTarget)) setCard(false); });
  ticker.addEventListener("keydown", event => {
    if (event.key === "Escape") { hoverOpen = false; setCard(false); $(".ticker-toggle").focus(); }
  });
  let resizeTimer = 0;
  addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (bands.length) { hideTip(); drawWall(); }
      if (!$("#ticker-card").hidden) setCard(true);
    }, 80);
  });
  setInterval(updateClock, 1000);
  setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - lastGoodAt > REFRESH_MS) refresh();
  });
  updateClock();
  refresh({ initial: true });
})(typeof window !== "undefined" ? window : globalThis);

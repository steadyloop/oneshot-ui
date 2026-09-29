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
    const timer = setTimeout(() => reject(new Error("The feed status request timed out.")), milliseconds);
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
  const STATE_LABEL = { ok: "healthy", failing: "failing", degraded: "retrying", stale: "overdue", paused: "paused", never: "never polled", unknown: "unknown" };
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
    return totals && Number.isFinite(Number(totals.boards)) ? { ...counts, ...totals, roles: counts.roles } : counts;
  };

  const problemText = problems => PROBLEM_ORDER
    .filter(state => problems[state])
    .map(state => `${problems[state]} ${STATE_LABEL[state]}`)
    .join(" · ");

  // Trouble first (worst first), then healthy boards heaviest first: each band
  // reads as a gradient with its problems pinned to the top-left corner.
  const byWeight = boards => [...boards].sort((a, b) => (SEVERITY[a.state] - SEVERITY[b.state]) || (b.jobs - a.jobs));

  // The providers with the most boards get a band each; the long tail shares
  // one band that opens into a band per provider.
  const NAMED_BANDS = 6;
  const buildBands = (payload, named = NAMED_BANDS) => {
    const groups = [];
    for (const provider of Array.isArray(payload?.providers) ? payload.providers : []) {
      const list = Array.isArray(provider.boards) ? provider.boards : [];
      if (!list.length) continue;
      const group = { id: String(provider.source || "?"), label: String(provider.source || "?"), boards: [], jobs: 0, problems: {} };
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
    const largest = new Set([...groups].sort((a, b) => b.boards.length - a.boards.length).slice(0, named).map(group => group.id));
    const bands = groups.filter(group => largest.has(group.id)).sort((a, b) => b.jobs - a.jobs);
    const tail = groups.filter(group => !largest.has(group.id)).sort((a, b) => b.jobs - a.jobs);
    if (tail.length) {
      const combined = { id: "__tail", label: `+${tail.length} more providers`, boards: [], jobs: 0, problems: {}, groups: tail };
      for (const group of tail) {
        combined.boards.push(...group.boards);
        combined.jobs += group.jobs;
        for (const [state, count] of Object.entries(group.problems)) combined.problems[state] = (combined.problems[state] || 0) + count;
      }
      combined.boards = byWeight(combined.boards);
      bands.push(combined);
    }
    return bands;
  };

  const exported = { relativeTime, withTimeout, stateKey, fleetTotals, problemText, buildBands, STATE_LABEL };
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  if (!root.document) return;

  const $ = selector => document.querySelector(selector);
  const content = $("#coverage-content");
  const esc = value => String(value == null ? "" : value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const readVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const plural = (count, one, many) => `${count === 1 ? one : many}`;

  // Cell geometry: a 3px square on a 4px pitch. Every band measures its own
  // width, so a full row and one column of the opened tail share the code.
  const PITCH = 4;
  const CELL = 3;
  const SNAP_RADIUS = 2;
  const RAMP_MAX_JOBS = 10000;

  let bands = [];
  let bandsById = new Map();
  let tailOpen = false;
  let palette = {};

  // Healthy boards shade from light to dark by how many jobs they carry (log
  // scale, 10k+ saturates); every other state is one flat colour.
  function readPalette() {
    const hex = value => [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16));
    const low = hex(readVar("--cell-ok-low")), high = hex(readVar("--cell-ok-high"));
    const maxLog = Math.log1p(RAMP_MAX_JOBS);
    palette = {
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

  function bandMarkup(band, mini = false) {
    // The cells carry each band's problems visually; the label keeps them for
    // screen readers only.
    const problems = problemText(band.problems);
    const count = band.boards.length;
    const meta = `<span>${number(count)} ${plural(count, "board", "boards")} · ${compact(band.jobs)} ${plural(band.jobs, "job", "jobs")}</span>`;
    const canvas = `<canvas role="img" aria-label="${esc(band.label)}: ${number(count)} ${plural(count, "board", "boards")}${problems ? `, ${esc(problems)}` : ""}"></canvas>`;
    if (!band.groups) {
      return `<div class="band${mini ? " mini" : ""}" data-band="${esc(band.id)}"><div class="band-label"><strong>${esc(band.label)}</strong>${meta}</div>${canvas}</div>`;
    }
    const toggle = `<button type="button" class="band-label tail-toggle" aria-expanded="${tailOpen}"><strong>${esc(band.label)}<svg class="chev" aria-hidden="true" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg></strong>${meta}</button>`;
    return tailOpen
      ? `<div class="band tail">${toggle}<div class="tail-grid">${band.groups.map(group => bandMarkup(group, true)).join("")}</div></div>`
      : `<div class="band tail" data-band="${esc(band.id)}">${toggle}${canvas}</div>`;
  }

  function renderWall() {
    content.innerHTML = `<div class="wall">${bands.map(band => bandMarkup(band)).join("")}</div>`;
    drawWall();
    $(".tail-toggle")?.addEventListener("click", () => { tailOpen = !tailOpen; hideTip(); renderWall(); });
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
    // The cell's colour already says the state, so the card carries only what colour cannot.
    tip.innerHTML = `<div class="tip-name">${esc(board.company)}</div>
      <div class="tip-row"><span>jobs</span><b>${esc(number(board.jobs))}</b></div>
      ${board.strikes ? `<div class="tip-row"><span>strikes</span><b>${esc(board.strikes)}</b></div>` : ""}
      <div class="tip-row"><span>last polled</span><b>${esc(relativeTime(board.last_poll_at))}</b></div>`;
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

  function renderHeader(payload) {
    const totals = fleetTotals(payload);
    $("#fleet-stats").innerHTML = [
      `<strong>${esc(number(totals.boards))}</strong> boards / <strong>${esc(number(totals.providers))}</strong> providers`,
      `<strong>${esc(number(totals.roles))}</strong> jobs`,
    ].join('<span class="stat-sep" aria-hidden="true"> · </span>');
    // Counted off the boards the wall draws, so the legend always adds up to it.
    const counts = {};
    for (const band of bands) for (const board of band.boards) counts[board.state] = (counts[board.state] || 0) + 1;
    for (const slot of document.querySelectorAll("[data-state-count]")) {
      const value = counts[slot.dataset.stateCount] || 0;
      slot.textContent = number(value);
      slot.closest(".legend-key")?.classList.toggle("zero", value === 0);
    }
  }

  function render(payload) {
    bands = buildBands(payload);
    bandsById = new Map();
    for (const band of bands) {
      bandsById.set(band.id, band);
      for (const group of band.groups || []) bandsById.set(group.id, group);
    }
    renderHeader(payload);
    if (!bands.length) {
      content.innerHTML = `<div class="state"><span class="state-icon"><svg aria-hidden="true"><use href="#icon-sources"/></svg></span><h2>No feed status data yet</h2><p>Configured feeds will appear here after status data becomes available.</p></div>`;
      return;
    }
    readPalette();
    renderWall();
  }

  function renderError(error) {
    bands = [];
    content.innerHTML = `<div class="state"><span class="state-icon error"><svg aria-hidden="true"><use href="#icon-alert"/></svg></span><h2>Feed status could not load</h2><p>${esc(error?.message || error || "The feed status service is unavailable.")}</p><button type="button" data-action="retry">Try again</button></div>`;
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
    if (initial) content.innerHTML = `<div class="state loading-state"><span class="spinner"></span><p>Loading feed status…</p></div>`;
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

  const CLOCK_FORMAT = new Intl.DateTimeFormat(undefined, {
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true, timeZoneName: "short",
  });

  function updateClock() {
    const clock = $("#clock");
    if (clock) clock.textContent = CLOCK_FORMAT.format(new Date());
  }

  document.addEventListener("click", event => {
    if (event.target.closest('[data-action="retry"]')) refresh({ initial: true });
  });
  let resizeTimer = 0;
  addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (bands.length) { hideTip(); drawWall(); } }, 80);
  });
  setInterval(updateClock, 1000);
  setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - lastGoodAt > REFRESH_MS) refresh();
  });
  updateClock();
  refresh({ initial: true });
})(typeof window !== "undefined" ? window : globalThis);

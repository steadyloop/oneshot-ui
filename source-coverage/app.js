(function (root) {
  "use strict";

  const safeDate = value => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const number = value => new Intl.NumberFormat().format(Number(value) || 0);
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
  const cellTitle = (source, board) => {
    const name = board?.company || board?.key || "?";
    const base = `${name} (${number(board?.coverage)} roles)`;
    return board?.last_poll_at ? `${base}, ${relativeTime(board.last_poll_at)}` : base;
  };

  // One flat cell list plus the provider ranges that index into it. The strip
  // draws a contiguous slice, so filtering to one provider is a slice, not a
  // second pass over the payload.
  const flattenFleet = payload => {
    const providers = [];
    const boards = [];
    for (const provider of Array.isArray(payload?.providers) ? payload.providers : []) {
      const list = Array.isArray(provider.boards) ? provider.boards : [];
      if (!list.length) continue;
      const range = { source: String(provider.source || "?"), start: boards.length, count: list.length, failing: 0, degraded: 0 };
      for (const board of list) {
        const state = stateKey(board.state);
        if (state === "failing") range.failing += 1;
        else if (state === "degraded") range.degraded += 1;
        boards.push({
          key: board.key,
          company: board.company || board.key,
          source: range.source,
          state,
          strikes: Number(board.strikes) || 0,
          coverage: Number(board.coverage) || 0,
          last_poll_at: board.last_poll_at || null,
        });
      }
      providers.push(range);
    }
    return { providers, boards };
  };

  const exported = { relativeTime, withTimeout, stateKey, fleetTotals, cellTitle, flattenFleet };
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  if (!root.document) return;

  const $ = selector => document.querySelector(selector);
  const content = $("#coverage-content");
  const esc = value => String(value == null ? "" : value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const readVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // Cell geometry. PITCH is the hit target the pointer snaps to, which is what
  // makes a 6px cell reachable; CELL is the painted square inside it.
  const PITCH = 7;
  const CELL = 6;
  const SNAP_RADIUS = 2;

  const STRIP_MARKUP = `
    <div class="provider-list" id="provider-list" role="group" aria-label="Filter the strip by provider"></div>
    <div class="strip-wrap">
      <div class="strip" id="strip">
        <canvas id="fleet-cells" role="img"></canvas>
        <canvas id="fleet-overlay" aria-hidden="true"></canvas>
      </div>
      <div class="probe" id="probe" aria-hidden="true"></div>
    </div>`;

  let fleet = { providers: [], boards: [] };
  let view = { start: 0, count: 0, provider: -1 };
  let selectedSource = null;
  let shellReady = false;
  let columns = 0, rows = 0, stripWidth = 0, stripHeight = 0;
  let hovered = -1;
  let palette = {};

  const nodes = {};
  const boardAt = index => fleet.boards[view.start + index];
  const providerOf = index => {
    let low = 0, high = fleet.providers.length - 1, found = 0;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (fleet.providers[middle].start <= index) { found = middle; low = middle + 1; } else high = middle - 1;
    }
    return found;
  };

  function readPalette() {
    palette = {
      ok: readVar("--cell-ok"),
      okAlt: readVar("--cell-ok-alt"),
      degraded: readVar("--cell-degraded"),
      failing: readVar("--cell-failing"),
      stale: readVar("--cell-stale"),
      paused: readVar("--line-strong"),
      never: readVar("--line-strong"),
      ink: readVar("--ink"),
      surface: readVar("--surface"),
      muted: readVar("--surface-muted"),
    };
  }

  // Providers alternate between two greens so the boundary between one vendor
  // and the next stays visible without drawing a rule through the strip.
  function paintCell(context, board, providerIndex, x, y, size) {
    if (board.state === "never" || board.state === "unknown") {
      context.strokeStyle = palette.never;
      context.lineWidth = 1;
      context.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
      return;
    }
    context.fillStyle = board.state === "ok"
      ? (providerIndex % 2 ? palette.okAlt : palette.ok)
      : palette[board.state];
    context.fillRect(x, y, size, size);
  }

  function drawStrip() {
    if (!shellReady || !view.count) return;
    readPalette();
    const ratio = root.devicePixelRatio || 1;
    stripWidth = nodes.strip.clientWidth;
    if (!stripWidth) return;
    columns = Math.max(1, Math.floor(stripWidth / PITCH));
    rows = Math.ceil(view.count / columns);
    stripHeight = rows * PITCH;
    for (const canvas of [nodes.cells, nodes.overlay]) {
      canvas.width = stripWidth * ratio;
      canvas.height = stripHeight * ratio;
      canvas.style.width = `${stripWidth}px`;
      canvas.style.height = `${stripHeight}px`;
    }
    const context = nodes.cells.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, stripWidth, stripHeight);
    let providerIndex = providerOf(view.start);
    for (let cell = 0; cell < view.count; cell += 1) {
      const index = view.start + cell;
      while (providerIndex + 1 < fleet.providers.length && index >= fleet.providers[providerIndex + 1].start) providerIndex += 1;
      paintCell(context, fleet.boards[index], providerIndex, (cell % columns) * PITCH, Math.floor(cell / columns) * PITCH, CELL);
    }
    drawOverlay();
  }

  function drawOverlay() {
    const ratio = root.devicePixelRatio || 1;
    const context = nodes.overlay.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, stripWidth, stripHeight);
    if (hovered < 0) return;
    const x = (hovered % columns) * PITCH;
    const y = Math.floor(hovered / columns) * PITCH;
    context.strokeStyle = palette.surface;
    context.lineWidth = 2;
    context.strokeRect(x - 2, y - 2, CELL + 4, CELL + 4);
    context.strokeStyle = palette.ink;
    context.lineWidth = 1.5;
    context.strokeRect(x - 2, y - 2, CELL + 4, CELL + 4);
  }

  // Snap to the cell under the pointer, then prefer any non-ok board within a
  // couple of cells: the flecks are what someone crossing the strip is aiming
  // for, and they are the ones too small to hit exactly.
  function pickCell(pointerX, pointerY) {
    const column = Math.min(columns - 1, Math.max(0, Math.floor(pointerX / PITCH)));
    const rowIndex = Math.min(rows - 1, Math.max(0, Math.floor(pointerY / PITCH)));
    let best = Math.min(view.count - 1, rowIndex * columns + column);
    if (boardAt(best).state !== "ok") return best;
    let bestDistance = Infinity;
    for (let dr = -SNAP_RADIUS; dr <= SNAP_RADIUS; dr += 1) {
      for (let dc = -SNAP_RADIUS; dc <= SNAP_RADIUS; dc += 1) {
        const r = rowIndex + dr, c = column + dc;
        if (r < 0 || c < 0 || r >= rows || c >= columns) continue;
        const candidate = r * columns + c;
        if (candidate >= view.count || boardAt(candidate).state === "ok") continue;
        const distance = Math.hypot(pointerX - (c * PITCH + CELL / 2), pointerY - (r * PITCH + CELL / 2));
        if (distance < bestDistance) { bestDistance = distance; best = candidate; }
      }
    }
    return best;
  }

  function showProbe(cell, pointerX, pointerY) {
    if (cell !== hovered) {
      hovered = cell;
      drawOverlay();
      // The cell's colour already carries the state, so the card stays down to
      // the four facts the colour cannot show.
      const board = boardAt(cell);
      nodes.probe.innerHTML = `<div class="tip-name">${esc(board.company)}</div>
        <div class="tip-source">${esc(board.source)}</div>
        <div class="tip-row"><span>roles</span><span>${esc(number(board.coverage))}</span></div>
        <div class="tip-row"><span>last poll</span><span>${esc(relativeTime(board.last_poll_at))}</span></div>`;
    }
    nodes.probe.classList.add("visible");
    const width = nodes.probe.offsetWidth, height = nodes.probe.offsetHeight;
    let x = pointerX + 18, y = pointerY + 18;
    if (x + width > stripWidth) x = pointerX - width - 18;
    if (x < 0) x = 0;
    if (y + height > stripHeight + 40) y = pointerY - height - 18;
    if (y < 0) y = pointerY + 18;
    nodes.probe.style.transform = `translate(${x}px, ${y}px)`;
  }

  function hideProbe() {
    if (!shellReady) return;
    nodes.probe.classList.remove("visible");
    hovered = -1;
    drawOverlay();
  }

  function setView(providerIndex) {
    const range = providerIndex >= 0 ? fleet.providers[providerIndex] : null;
    view = range
      ? { start: range.start, count: range.count, provider: providerIndex }
      : { start: 0, count: fleet.boards.length, provider: -1 };
    selectedSource = range ? range.source : null;
    for (const button of nodes.providerList.children) {
      button.classList.toggle("active", button.dataset.provider === (selectedSource || ""));
      button.setAttribute("aria-pressed", String(button.dataset.provider === (selectedSource || "")));
    }
    nodes.cells.setAttribute("aria-label", range
      ? `${range.source}: ${number(range.count)} boards, one cell each`
      : `${number(fleet.boards.length)} boards across ${number(fleet.providers.length)} providers, one cell each`);
    hideProbe();
    drawStrip();
  }

  function renderProviderList() {
    const buttons = [`<button type="button" class="provider all" data-provider="" aria-pressed="true">all providers</button>`];
    for (const range of fleet.providers) {
      const problem = range.failing ? " has-failing" : range.degraded ? " has-degraded" : "";
      buttons.push(`<button type="button" class="provider${problem}" data-provider="${esc(range.source)}" aria-pressed="false">${esc(range.source)} <b>${esc(number(range.count))}</b></button>`);
    }
    nodes.providerList.innerHTML = buttons.join("");
  }

  function renderLegendCounts(totals) {
    for (const state of CELL_STATES) {
      const slot = document.querySelector(`[data-state-count="${state}"]`);
      if (!slot) continue;
      const value = state === "degraded" || state === "failing"
        ? countState(state)
        : Number(totals[state]) || countState(state);
      slot.textContent = number(value);
    }
  }

  // `totals` folds failing and degraded into one `erroring` count, so the two
  // are counted off the flattened boards instead of read from the payload.
  function countState(state) {
    let total = 0;
    for (const board of fleet.boards) if (board.state === state) total += 1;
    return total;
  }

  function renderStats(totals) {
    $("#fleet-stats").innerHTML = [
      `<strong>${esc(number(totals.boards))}</strong> boards / <strong>${esc(number(totals.providers))}</strong> providers`,
      `<strong>${esc(number(totals.roles))}</strong> roles`,
    ].join('<span class="stat-sep" aria-hidden="true"> · </span>');
  }

  function mountShell() {
    if (shellReady) return;
    content.innerHTML = STRIP_MARKUP;
    nodes.providerList = $("#provider-list");
    nodes.strip = $("#strip");
    nodes.cells = $("#fleet-cells");
    nodes.overlay = $("#fleet-overlay");
    nodes.probe = $("#probe");

    const pointAt = event => {
      const box = nodes.strip.getBoundingClientRect();
      return [event.clientX - box.left, event.clientY - box.top];
    };
    const probeFrom = event => {
      const [x, y] = pointAt(event);
      showProbe(pickCell(x, y), x, y);
    };
    nodes.strip.addEventListener("pointermove", probeFrom);
    nodes.strip.addEventListener("pointerdown", probeFrom);
    nodes.strip.addEventListener("pointerleave", event => { if (event.pointerType === "mouse") hideProbe(); });
    nodes.providerList.addEventListener("click", event => {
      const button = event.target.closest("[data-provider]");
      if (!button) return;
      const source = button.dataset.provider;
      const index = source ? fleet.providers.findIndex(range => range.source === source) : -1;
      setView(index === view.provider ? -1 : index);
    });
    shellReady = true;
  }

  function render(payload) {
    const totals = fleetTotals(payload);
    renderStats(totals);
    fleet = flattenFleet(payload);
    if (!fleet.boards.length) {
      shellReady = false;
      content.innerHTML = `<div class="state"><span class="state-icon"><svg aria-hidden="true"><use href="#icon-sources"/></svg></span><h2>No feed status data yet</h2><p>Configured feeds will appear here after status data becomes available.</p></div>`;
      return;
    }
    mountShell();
    renderProviderList();
    renderLegendCounts(totals);
    // A refresh keeps whichever provider is on screen; if that vendor dropped
    // out of the payload the strip falls back to the whole fleet.
    const keep = selectedSource ? fleet.providers.findIndex(range => range.source === selectedSource) : -1;
    setView(keep);
  }

  function renderError(error) {
    shellReady = false;
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
    if (initial) {
      shellReady = false;
      content.innerHTML = `<div class="state loading-state"><span class="spinner"></span><p>Loading feed status…</p></div>`;
    }
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
    resizeTimer = setTimeout(() => { hideProbe(); drawStrip(); }, 80);
  });
  setInterval(updateClock, 1000);
  setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - lastGoodAt > REFRESH_MS) refresh();
  });
  updateClock();
  refresh({ initial: true });
})(typeof window !== "undefined" ? window : globalThis);

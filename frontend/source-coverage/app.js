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

  const exported = { relativeTime, withTimeout, stateKey, fleetTotals, cellTitle };
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  if (!root.document) return;

  const $ = selector => document.querySelector(selector);
  const content = $("#coverage-content");
  const esc = value => String(value == null ? "" : value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

  function renderStats(totals) {
    $("#fleet-stats").innerHTML = [
      `<strong>${esc(number(totals.boards))}</strong> boards / <strong>${esc(number(totals.providers))}</strong> providers`,
      `<strong>${esc(number(totals.roles))}</strong> roles`,
    ].join('<span class="stat-sep" aria-hidden="true"> · </span>');
  }

  function fleetRow(provider) {
    const boards = Array.isArray(provider.boards) ? provider.boards : [];
    const cells = boards.map(board =>
      `<i class="cell ${esc(stateKey(board.state))}" title="${esc(cellTitle(provider.source, board))}"></i>`).join("");
    return `<section class="fleet-row" aria-label="${esc(provider.source)}: ${esc(number(provider.board_count))} boards, ${esc(number(provider.err_count))} erroring">
      <div class="fleet-label"><strong>${esc(provider.source)}</strong></div>
      <div class="fleet-cells" aria-hidden="true">${cells}</div>
    </section>`;
  }

  function render(payload) {
    const providers = Array.isArray(payload?.providers) ? payload.providers : [];
    renderStats(fleetTotals(payload));
    if (!providers.length) {
      content.innerHTML = `<div class="state"><span class="state-icon"><svg aria-hidden="true"><use href="#icon-sources"/></svg></span><h2>No feed status data yet</h2><p>Configured feeds will appear here after status data becomes available.</p></div>`;
      return;
    }
    content.innerHTML = `<div class="fleet-map">${providers.map(fleetRow).join("")}</div>`;
  }

  function renderError(error) {
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
  setInterval(updateClock, 1000);
  setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - lastGoodAt > REFRESH_MS) refresh();
  });
  updateClock();
  refresh({ initial: true });
})(typeof window !== "undefined" ? window : globalThis);

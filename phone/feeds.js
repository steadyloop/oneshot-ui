/* Feeds on phones: the desktop overview, stacked. Totals as tiles, today's
   activity with its breakdown, the live clock, then one row per provider that
   opens to its state counts and board squares. Phones cannot hover, so tapping
   a square shows its board. The numbers come from source-coverage/app.js. */
(function (root) {
  "use strict";
  const P = root.OneShotPhoneShell;
  const K = root.OneShotFeedsKit;
  const { esc, icon, S } = P;

  const number = value => new Intl.NumberFormat().format(Number(value) || 0);
  const compact = value => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(Number(value) || 0);
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
  // The desktop wall's colours: healthy boards shade by job count, every other
  // state is one flat colour.
  const BAR = { ok: "#a7c4ae", degraded: "#c9860f", failing: "#b3342b", stale: "#66717c", paused: "#d4d8d2", never: "#d4d8d2", unknown: "#d4d8d2" };
  const CELL = { failing: "#b3342b", degraded: "#c9860f", stale: "#4f5863", idle: "#a9afa8", gap: "#f0f3ed" };
  const LOW = [0xd8, 0xe6, 0xd9], HIGH = [0x56, 0x85, 0x67];
  const ramp = jobs => { const t = Math.min(1, Math.log1p(jobs) / Math.log1p(10000)); return `rgb(${LOW.map((c, i) => Math.round(c + (HIGH[i] - c) * t)).join(",")})`; };
  const cellColor = board => board.state === "ok" ? ramp(board.jobs) : CELL[board.state] || CELL.idle;
  const SUMMARY = ["ok", "degraded", "stale", "failing", "paused", "unknown"];
  const CORE = new Set(["ok", "degraded", "stale", "failing"]);
  const SEGMENTS = ["ok", "degraded", "failing", "stale", "paused", "never", "unknown"];
  const TYPES = [["internships", "intern"], ["co-ops", "coop"], ["student jobs", "student"], ["new grad", "new_grad"], ["research", "research"], ["unclassified", "unclassified"]];
  const PITCH = 6, SIZE = 5, SNAP = 2;
  const REFRESH_MS = 60000;

  const state = { payload: null, bands: [], error: "", loading: true, stale: false, open: null, square: null, ticker: false, v: 0 };
  const bump = () => { state.v += 1; };
  const counts = band => ({ ...band.problems, ok: band.boards.length - Object.values(band.problems).reduce((sum, n) => sum + n, 0) });

  /* ───────────── Data ───────────── */
  let inFlight = false, lastGood = 0;
  async function refresh({ initial = false } = {}) {
    if (inFlight) return;
    inFlight = true;
    if (initial) { state.loading = true; state.error = ""; P.render(); }
    try {
      const payload = await K.withTimeout(root.OneShotAPI.sources.boards());
      state.payload = payload;
      state.bands = K.buildBands(payload);
      if (!state.bands.some(band => band.id === state.open)) { state.open = null; state.square = null; }
      state.error = ""; state.stale = false; lastGood = Date.now();
    } catch (error) {
      if (initial || !lastGood) state.error = error?.message || "The feed overview service is unavailable.";
      else state.stale = true;
    } finally {
      inFlight = false; state.loading = false; bump(); P.render();
    }
  }

  /* ───────────── Page ───────────── */
  const DATE = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
  const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true, timeZoneName: "short" });
  const clockText = () => { const now = new Date(); return `${DATE.format(now)} ${TIME.format(now)}`; };

  function squareInfo(band) {
    const board = state.square === null ? null : band.boards[state.square];
    if (!board) return '<p class="sq-hint">Tap a square to see its board.</p>';
    const label = K.STATE_LABEL[board.state] || K.STATE_LABEL.unknown;
    return `<div class="sq-info" role="status"><b>${esc(board.company)}</b><span><i style="background:${cellColor(board)}"></i>${esc(label[0].toUpperCase() + label.slice(1))}${board.strikes ? ` · ${board.strikes} ${board.strikes === 1 ? "strike" : "strikes"}` : ""}</span><span>jobs ${esc(number(board.jobs))}</span><span>last polled ${esc(board.last_poll_at ? K.relativeTime(board.last_poll_at) : "never")}</span></div>`;
  }
  function providerRow(band) {
    const open = state.open === band.id;
    const name = PROVIDER_NAMES[band.id] || band.label;
    const tally = counts(band);
    const segments = SEGMENTS.filter(key => tally[key]).map(key => `<i style="width:${(tally[key] / band.boards.length) * 100}%;background:${BAR[key]}"></i>`).join("");
    const description = SUMMARY.filter(key => CORE.has(key) || tally[key]).map(key => `${number(tally[key])} ${K.STATE_LABEL[key]}`).join(", ");
    const detail = open ? `<div class="prov-detail">${SUMMARY.filter(key => CORE.has(key) || tally[key]).map(key => `<div class="hstat"><i style="background:${key === "ok" ? BAR.ok : BAR[key]}"></i>${esc(K.STATE_LABEL[key])}<b>${esc(number(tally[key]))}</b></div>`).join("")}
      <div class="squares-wrap"><canvas class="squares" data-squares="${esc(band.id)}" role="img" aria-label="${esc(`${name}: ${description}`)}"></canvas>${squareInfo(band)}</div></div>` : "";
    return `<div class="prov${open ? " open" : ""}"><button class="prov-btn" type="button" data-prov="${esc(band.id)}" aria-expanded="${open}"><b>${esc(name)}</b><span class="jobs">${number(band.boards.length)} ${band.boards.length === 1 ? "board" : "boards"} <i>|</i> ${compact(band.jobs)} ${band.jobs === 1 ? "job" : "jobs"}</span>${icon("chev")}<span class="bar" role="img" aria-label="${esc(description)}">${segments}</span></button>${detail}</div>`;
  }
  function renderPage() {
    if (state.loading && !state.payload) return `${P.head("Feeds")}${P.stateBlock("loading", { title: "Loading feed overview…" })}`;
    if (state.error) return `${P.head("Feeds")}${P.stateBlock("error", { title: "Feed overview could not load", detail: state.error })}`;
    const payload = state.payload;
    const totals = K.fleetTotals(payload);
    const line = K.todayLine(totals);
    const detail = payload.today_breakdown || {};
    const signed = (value, sign) => value == null ? "—" : `${Number(value) === 0 ? "" : sign}${number(value)}`;
    const ticker = line ? `<button class="ticker" type="button" data-act="ticker" aria-expanded="${state.ticker}"><span><b>${number(totals.added_today)}</b> jobs posted${totals.disappeared_today != null ? `, <b>${number(totals.disappeared_today)}</b> jobs closed today` : " today"}</span>${icon("down")}</button>
      ${state.ticker ? `<div class="ticker-card"><table><caption class="sr-only">Jobs posted and closed today, by job type</caption>${TYPES.map(([label, key]) => { const plus = detail.types?.[key], minus = detail.disappeared?.types?.[key]; return `<tr><td>${label}</td><td class="pos${Number(plus) ? "" : " zero"}">${signed(plus, "+")}</td><td class="neg">${signed(minus, "−")}</td></tr>`; }).join("")}</table><p>Duplicate postings are filtered</p></div>` : ""}` : "";
    const classification = payload.classification;
    const foot = `<footer class="feeds-foot">${classification && Number.isSafeInteger(classification.total) ? `<p>OneShot currently classifies <b>${number(classification.total)}</b> active job postings to identify <b>${number(classification.student_roles)}</b> student roles for ${icon("search")} Discover.</p>` : ""}<p>Need a filter tailored to your search? <a href="mailto:chkim@tuta.io?subject=OneShot%20filter%20request">Contact me</a></p></footer>`;
    const list = state.bands.length
      ? state.bands.map(providerRow).join("")
      : '<div class="empty"><strong>No feed overview data yet</strong>Configured feeds will appear here after status data becomes available.</div>';
    return `${P.head("Feeds")}
      ${state.stale ? `<div class="stale" role="status">${icon("alert")}Refresh failed — showing last known data</div>` : ""}
      <div class="stat-grid"><div class="stat"><b>${number(totals.boards)}</b><span>boards</span></div><div class="stat"><b>${number(totals.providers)}</b><span>providers</span></div><div class="stat"><b>${number(totals.roles)}</b><span>active jobs</span></div></div>
      ${ticker}
      <div class="clock" id="clock" aria-label="Current date and time">${esc(clockText())}</div>
      <div class="section-h" style="padding-top:12px"><h2>Providers</h2><small>by student jobs</small></div>
      ${list}${foot}`;
  }

  /* Board squares: worst first, then healthy boards heaviest first. */
  let layout = null;
  function drawSquares() {
    const canvas = P.$("canvas[data-squares]");
    if (!canvas) { layout = null; return; }
    const band = state.bands.find(item => item.id === canvas.dataset.squares);
    if (!band) return;
    const width = canvas.parentElement.clientWidth;
    const columns = Math.max(8, Math.floor((width + (PITCH - SIZE)) / PITCH));
    const rows = Math.ceil(band.boards.length / columns);
    const ratio = root.devicePixelRatio || 1;
    canvas.width = columns * PITCH * ratio; canvas.height = rows * PITCH * ratio;
    canvas.style.width = `${columns * PITCH}px`; canvas.style.height = `${rows * PITCH}px`;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = CELL.gap;
    const full = Math.floor(band.boards.length / columns), rest = band.boards.length % columns;
    ctx.fillRect(0, 0, columns * PITCH, full * PITCH);
    if (rest) ctx.fillRect(0, full * PITCH, rest * PITCH, PITCH);
    band.boards.forEach((board, index) => {
      ctx.fillStyle = cellColor(board);
      ctx.fillRect((index % columns) * PITCH, Math.floor(index / columns) * PITCH, SIZE, SIZE);
    });
    if (state.square !== null && band.boards[state.square]) {
      const x = (state.square % columns) * PITCH, y = Math.floor(state.square / columns) * PITCH;
      ctx.strokeStyle = "#141816"; ctx.lineWidth = 1.5;
      ctx.strokeRect(x - 1.25, y - 1.25, SIZE + 2.5, SIZE + 2.5);
    }
    layout = { band, columns };
  }
  // A finger covers several squares, so a tap prefers a problem board nearby,
  // the way the desktop pointer does.
  function pick(event, canvas) {
    if (!layout) return null;
    const box = canvas.getBoundingClientRect();
    const column = Math.floor((event.clientX - box.left) / PITCH), row = Math.floor((event.clientY - box.top) / PITCH);
    const { band, columns } = layout, total = band.boards.length;
    const index = row * columns + column;
    if (column < 0 || row < 0 || column >= columns || index >= total) return null;
    if (band.boards[index].state !== "ok") return index;
    let best = null, distance = Infinity;
    for (let dr = -SNAP; dr <= SNAP; dr += 1) for (let dc = -SNAP; dc <= SNAP; dc += 1) {
      const r = row + dr, c = column + dc, candidate = r * columns + c;
      if (r < 0 || c < 0 || c >= columns || candidate >= total || band.boards[candidate].state === "ok") continue;
      const d = Math.hypot(dr, dc);
      if (d < distance) { distance = d; best = candidate; }
    }
    return best ?? index;
  }

  function onClick(target, d, event) {
    if (d.squares) {
      state.square = pick(event, target);
      bump(); P.render();
      return;
    }
    if (d.prov) {
      state.open = state.open === d.prov ? null : d.prov;
      state.square = null; bump(); P.render();
      if (state.open) root.requestAnimationFrame(() => target.scrollIntoView({ block: "nearest", behavior: "smooth" }));
      return;
    }
    switch (d.act) {
      case "ticker": state.ticker = !state.ticker; bump(); return P.render();
      case "retry": return refresh({ initial: true });
    }
  }

  P.start({
    tab: "feeds",
    renderPage,
    afterPage: drawSquares,
    renderPush: () => "",
    renderSheet: () => "",
    version: () => state.v,
    onClick,
    start: () => {
      setInterval(() => { const clock = P.$("#clock"); if (clock) clock.textContent = clockText(); }, 1000);
      setInterval(() => { if (!root.document.hidden) refresh(); }, REFRESH_MS);
      root.document.addEventListener("visibilitychange", () => { if (!root.document.hidden && Date.now() - lastGood > REFRESH_MS) refresh(); });
      let resizeTimer = 0;
      root.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawSquares, 120); });
      refresh({ initial: true });
    },
  });
})(window);

/* Feeds on phones: the desktop overview, stacked. Totals as tiles, today's
   activity with its breakdown, the live clock, then one row per provider that
   opens to its state counts and board squares. Phones cannot hover, so tapping
   a square shows its board. */
import P from "../phone/shell.js";
import { api } from "../shared/api.js";
import {
  JOB_TYPES, boardCount, buildBands, clockText, feedLoader,
  fleetTotals, jobCount, number, paintSquares, palette, pickSquare, providerName,
  relativeTime, signedCount, squareColumns, studentCount, todayLine, todaySentence,
} from "./core.js";

const { $, esc, icon } = P;
// The desktop wall's colours.
const COLORS = palette({ low: "#d8e6d9", high: "#568567", gap: "#f0f3ed" });
const SQUARES = { pitch: 6, size: 5 };

const state = { payload: null, bands: [], error: "", loading: true, stale: false, open: null, square: null, ticker: false };

const loader = feedLoader(api.sources.boards, {
  started() { state.loading = true; state.error = ""; P.render(); },
  loaded(payload) {
    state.payload = payload;
    state.bands = buildBands(payload);
    if (!state.bands.some(band => band.id === state.open)) { state.open = null; state.square = null; }
    state.error = "";
  },
  failed(error) { state.error = error?.message || "The feed overview service is unavailable."; },
  stale(stale) { state.stale = stale; },
  settled() { state.loading = false; P.render(); },
});

/* ───────────── Page ───────────── */
function squareInfo(band) {
  const board = state.square === null ? null : band.boards[state.square];
  if (!board) return '<p class="sq-hint">Tap a square to see its board.</p>';
  return `<div class="sq-info" role="status"><b>${esc(board.company)}</b><span>${esc(number(board.jobs))} indexed jobs</span><span>Last polled ${esc(board.last_poll_at ? relativeTime(board.last_poll_at).toLowerCase() : "never")}</span></div>`;
}

function providerRow(band) {
  const open = state.open === band.id;
  const name = providerName(band);
  const detail = open ? `<div class="prov-detail"><div class="squares-wrap"><canvas class="squares" data-squares="${esc(band.id)}" role="img" aria-label="${esc(`${name}: ${boardCount(band)} shaded by indexed job count`)}"></canvas>${squareInfo(band)}</div></div>` : "";
  return `<div class="prov${open ? " open" : ""}"><button class="prov-btn" type="button" data-prov="${esc(band.id)}" aria-expanded="${open}"><b>${esc(name)}</b>`
    + `<span class="jobs">${boardCount(band)} <i>|</i> ${jobCount(band)} indexed <i>|</i> ${studentCount(band)} student opportunities</span>${icon("chev")}</button>${detail}</div>`;
}

function tickerCard(detail) {
  const rows = JOB_TYPES.map(([label, key]) => {
    const plus = detail.types?.[key], minus = detail.disappeared?.types?.[key];
    return `<tr><td>${label}</td><td class="pos${Number(plus) ? "" : " zero"}">${signedCount(plus, "+")}</td><td class="neg">${signedCount(minus, "−")}</td></tr>`;
  }).join("");
  return `<div class="ticker-card"><table><caption class="sr-only">Jobs posted and closed today, by job type</caption>${rows}</table><p>Duplicate postings are filtered</p></div>`;
}

function renderPage() {
  if (state.loading && !state.payload) return `${P.head("Feeds")}${P.stateBlock("loading", { title: "Loading feed overview…" })}`;
  if (state.error) return `${P.head("Feeds")}${P.stateBlock("error", { title: "Feed overview could not load", detail: state.error })}`;
  // An empty response reads as no data yet.
  const payload = state.payload || {};
  const totals = fleetTotals(payload);
  const ticker = todayLine(totals)
    ? `<button class="ticker" type="button" data-act="ticker" aria-expanded="${state.ticker}"><span>${todaySentence(totals, value => `<b>${value}</b>`)}</span>${icon("down")}</button>
      ${state.ticker ? tickerCard(payload.today_breakdown || {}) : ""}`
    : "";
  const foot = `<footer class="feeds-foot"><p>Need a filter tailored to your search? <a href="mailto:chkim@tuta.io?subject=OneShot%20filter%20request">Contact me</a></p></footer>`;
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

/* ───────────── Board squares ───────────── */
let layout = null;  // The drawn band and its column count, for hit-testing.
function drawSquares() {
  const canvas = $("canvas[data-squares]");
  if (!canvas) { layout = null; return; }
  const band = state.bands.find(item => item.id === canvas.dataset.squares);
  if (!band) return;
  const columns = squareColumns(canvas.parentElement.clientWidth, SQUARES);
  const width = columns * SQUARES.pitch, height = Math.ceil(band.boards.length / columns) * SQUARES.pitch;
  const ratio = devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  paintSquares(context, band.boards, columns, SQUARES, COLORS);
  if (state.square !== null && band.boards[state.square]) {
    const { pitch, size } = SQUARES;
    context.strokeStyle = "#141816";
    context.lineWidth = 1.5;
    context.strokeRect((state.square % columns) * pitch - 1.25, Math.floor(state.square / columns) * pitch - 1.25, size + 2.5, size + 2.5);
  }
  layout = { band, columns };
}

function onClick(target, d, event) {
  if (d.squares) {
    if (!layout) state.square = null;
    else {
      const box = target.getBoundingClientRect();
      state.square = pickSquare(layout.band.boards, layout.columns, event.clientX - box.left, event.clientY - box.top, SQUARES.pitch);
    }
    P.render();
  } else if (d.prov) {
    state.open = state.open === d.prov ? null : d.prov;
    state.square = null;
    P.render();
  } else if (d.act === "ticker") {
    state.ticker = !state.ticker;
    P.render();
  } else if (d.act === "retry") {
    loader.refresh({ initial: true });
  }
}

P.start({
  tab: "feeds",
  renderPage,
  afterPage: drawSquares,
  onClick,
  start() {
    setInterval(() => { const clock = $("#clock"); if (clock) clock.textContent = clockText(); }, 1000);
    loader.poll(document);
    let resizeTimer = 0;
    addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawSquares, 120); });
    loader.refresh({ initial: true });
  },
});

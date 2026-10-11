// Feeds on desktop: fleet totals, today's activity with its breakdown, and one
// row per provider that opens to a wall of board squares.
import { startAccount } from "../shared/account.js";
import { api } from "../shared/api.js";
import { $, esc } from "../shared/util.js";
import {
  ISSUE_STATES, JOB_TYPES, STATE_LABEL, boardCount, buildBands, cellColor, clockLine, feedLoader, fleetTotals,
  healthCounts, healthText, healthTone, healthyShare, jobCount, number, paintSquares, palette, pickSquare,
  providerName, relativeTime, todayLine, todaySentence,
} from "./core.js";

const content = $("#coverage-content");
const ticker = $("#ticker");
const card = $("#ticker-card");
const toggle = $(".ticker-toggle");

// 5px squares on a 6px grid.
const SQUARES = { pitch: 6, size: 5 };
const LOADING = `<div class="state loading-state"><span class="spinner"></span><p>Loading feed overview…</p></div>`;
// Healthy boards shade by jobs; the rest are flat. Unpolled and unknown boards read as paused.
const COLORS = palette({
  low: "#C4DEBE", high: "#74A26E",
  failing: "#C0473A", degraded: "#D9A441", stale: "#6B7480", paused: "#D3D7D2", idle: "#D3D7D2",
});
const ISSUE_TONE = { failing: "bad", stale: "", degraded: "warn" };

let bands = [];
let expandedProvider = null;
let wall = null;  // The open band and its column count, for hit-testing.

/* ───────────── Provider rows ───────────── */
function providerMarkup(band) {
  const label = providerName(band);
  const counts = healthCounts(band);
  const description = healthText(counts);
  const open = expandedProvider === band.id;
  const issues = ISSUE_STATES.map(state => `<td class="issue-cell">${counts[state]
    ? `<span class="issue ${ISSUE_TONE[state]}"><i style="background:${COLORS[state]}"></i>${esc(number(counts[state]))} ${STATE_LABEL[state]}</span>` : ""}</td>`).join("");
  const row = `<tr class="p-row${open ? " open" : ""}" data-provider="${esc(band.id)}" tabindex="0" aria-expanded="${open}">`
    + `<td><span class="p-name"><svg aria-hidden="true"><use href="#icon-chev"/></svg>${esc(label)}</span></td>`
    + `<td class="pct ${healthTone(counts)}" title="${esc(description)}">${healthyShare(counts)}</td>${issues}<td class="fill"></td>`
    + `<td class="scale">${boardCount(band)}</td><td class="scale">${jobCount(band)}</td></tr>`;
  if (!open) return row;
  return `${row}<tr class="p-detail"><td colspan="8"><div class="sq-wrap"><canvas role="img" aria-label="${esc(label)}: ${esc(description)}"></canvas><div class="sq-tip" hidden></div></div></td></tr>`;
}

function renderWall() {
  content.innerHTML = `<div class="prov-card"><table class="prov"><tbody>${bands.map(providerMarkup).join("")}</tbody></table></div>`;
  drawWall();
  const canvas = $(".sq-wrap > canvas", content);
  if (!canvas) return;
  const probe = event => {
    const box = canvas.getBoundingClientRect();
    const index = pickSquare(wall.band.boards, wall.columns, event.clientX - box.left, event.clientY - box.top, SQUARES.pitch);
    if (index === null) hideTip();
    else showTip(wall.band.boards[index], event.clientX, event.clientY);
  };
  canvas.addEventListener("pointermove", probe);
  canvas.addEventListener("pointerdown", probe);
  canvas.addEventListener("pointerleave", event => { if (event.pointerType === "mouse") hideTip(); });
}

function drawWall() {
  const canvas = $(".sq-wrap > canvas", content);
  const band = bands.find(item => item.id === expandedProvider);
  if (!canvas || !band) return;
  const ratio = devicePixelRatio || 1;
  const columns = Math.max(20, Math.floor((canvas.parentElement.clientWidth - 24) / SQUARES.pitch));
  const width = columns * SQUARES.pitch, height = Math.max(1, Math.ceil(band.boards.length / columns)) * SQUARES.pitch;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  paintSquares(context, band.boards, columns, SQUARES, COLORS);
  wall = { band, columns };
}

function showTip(board, pointerX, pointerY) {
  const tip = $(".sq-tip", content);
  const strikes = board.strikes ? ` · ${board.strikes} ${board.strikes === 1 ? "strike" : "strikes"}` : "";
  const state = STATE_LABEL[board.state] || STATE_LABEL.unknown;
  tip.innerHTML = `<b>${esc(board.company)}</b><span>${esc(state[0].toUpperCase() + state.slice(1))}${esc(strikes)}</span>`
    + `<span>${esc(number(board.jobs))} jobs · last polled ${esc(board.last_poll_at ? relativeTime(board.last_poll_at).toLowerCase() : "never")}</span>`;
  tip.hidden = false;
  const wrap = tip.parentElement.getBoundingClientRect();
  tip.style.left = `${Math.min(pointerX - wrap.left + 14, wrap.width - 200)}px`;
  tip.style.top = `${pointerY - wrap.top + 14}px`;
}

const hideTip = () => { const tip = $(".sq-tip", content); if (tip) tip.hidden = true; };

/* ───────────── Summary line and footer ───────────── */
function renderHeader(payload) {
  const totals = fleetTotals(payload);
  const sep = '<span class="fl-sep" aria-hidden="true">|</span>';
  $("#fleet-stats").innerHTML = [
    `<b>${esc(number(totals.boards))}</b> boards`,
    `<b>${esc(number(totals.providers))}</b> providers`,
    `<b>${esc(number(totals.roles))}</b> active jobs`,
  ].join(sep);
  renderTicker(payload, totals);
  const values = payload.classification;
  const summary = $(".classification-summary");
  summary.hidden = !values;
  if (values) {
    $(".classification-total").textContent = number(values.total);
    $(".classification-students").textContent = number(values.student_roles);
  }
}

function renderTicker(payload, totals) {
  const line = todayLine(totals);
  ticker.hidden = !line;
  $("[data-ticker-sep]").hidden = !line;
  $("#today-line").innerHTML = todaySentence(totals, (value, side) => `<span class="${side === "added" ? "added" : "gone"}">${value}</span>`);
  toggle.setAttribute("aria-label", `${line}. Show breakdown`);
  const detail = payload.today_breakdown || {};
  card.innerHTML = `<table><caption class="visually-hidden">Jobs posted and closed today, by job type</caption><tbody>${JOB_TYPES.map(([label, key]) => {
    const closed = detail.disappeared?.types?.[key];
    return `<tr><td>${esc(label)}</td><td class="pos">+${esc(number(detail.types?.[key]))}</td><td class="neg">${closed == null ? "—" : `−${esc(number(closed))}`}</td></tr>`;
  }).join("")}</tbody></table><p>Duplicate postings are filtered</p>`;
}

function setCard(open) {
  card.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
}

/* ───────────── Page states ───────────── */
function render(payload) {
  bands = buildBands(payload);
  if (!bands.some(band => band.id === expandedProvider)) expandedProvider = null;
  renderHeader(payload);
  if (!bands.length) {
    content.innerHTML = `<div class="state"><span class="state-icon"><svg aria-hidden="true"><use href="#icon-sources"/></svg></span><h2>No feed overview data yet</h2><p>Configured feeds will appear here after status data becomes available.</p></div>`;
    return;
  }
  renderWall();
}

function renderError(error) {
  bands = [];
  content.innerHTML = `<div class="state"><span class="state-icon error"><svg aria-hidden="true"><use href="#icon-alert"/></svg></span><h2>Feed overview could not load</h2><p>${esc(error?.message || error || "The feed overview service is unavailable.")}</p><button type="button" data-action="retry">Try again</button></div>`;
}

const loader = feedLoader(api.sources.boards, {
  started: () => { content.innerHTML = LOADING; },
  loaded: render,
  failed: renderError,
  stale: stale => { $("#stale-note").hidden = !stale; },
});

/* ───────────── Events ───────────── */
function toggleProvider(row) {
  const id = row.dataset.provider;
  expandedProvider = expandedProvider === id ? null : id;
  renderWall();
  [...content.querySelectorAll(".p-row")].find(item => item.dataset.provider === id)?.focus({ preventScroll: true });
}
content.addEventListener("click", event => {
  const row = event.target.closest(".p-row");
  if (row) toggleProvider(row);
});
content.addEventListener("keydown", event => {
  const row = event.target.closest(".p-row");
  if (row && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); toggleProvider(row); }
});
toggle.addEventListener("click", () => setCard(card.hidden));
document.addEventListener("click", event => {
  if (event.target.closest('[data-action="retry"]')) loader.refresh({ initial: true });
  if (!event.target.closest("#ticker")) setCard(false);
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !card.hidden) { setCard(false); toggle.focus(); }
});
let resizeTimer = 0;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (bands.length) { hideTip(); drawWall(); } }, 80);
});

const clock = $("#clock");
const tick = () => { clock.textContent = clockLine(); };
startAccount();
setInterval(tick, 1000);
loader.poll(document);
tick();
loader.refresh({ initial: true });

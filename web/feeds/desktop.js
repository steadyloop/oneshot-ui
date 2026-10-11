// Feeds on desktop: fleet totals, today's activity with its breakdown card,
// and one row per provider that opens to a wall of board squares.
import { startAccount } from "../shared/account.js";
import { api } from "../shared/api.js";
import { $, $$, esc } from "../shared/util.js";
import {
  CORE_STATES, JOB_TYPES, STATES, STATE_LABEL, SUMMARY_STATES, boardCount, buildBands, cellColor, clockText,
  feedLoader, fleetTotals, healthCounts, healthText, jobCount, number, paintSquares, palette, pickSquare,
  providerName, relativeTime, signedCount, squareColumns, todayLine, todaySentence,
} from "./core.js";

const content = $("#coverage-content");
const ticker = $("#ticker");
const card = $("#ticker-card");
const toggle = $(".ticker-toggle");
const tip = $("#board-tip");
const readVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// A 3px square on a 4px pitch.
const SQUARES = { pitch: 4, size: 3 };
const LOADING = `<div class="state loading-state"><span class="spinner"></span><p>Loading feed overview…</p></div>`;

let bands = [];
let expandedProvider = null;
let wall = null;  // The open band and its column count, for hit-testing.
let colors = {};

/* ───────────── Provider rows ───────────── */
function providerListMarkup() {
  // Share widths across providers, sized to the actual counts and labels.
  // Four core states stay together without the padding of equal-width slots.
  const widths = CORE_STATES.map(state => STATE_LABEL[state].length + 2);
  for (const band of bands) {
    const counts = healthCounts(band);
    SUMMARY_STATES.forEach((state, index) => {
      if (state !== "never" && (index < 4 || counts[state])) {
        widths[index % 4] = Math.max(widths[index % 4], number(counts[state]).length + 1 + STATE_LABEL[state].length);
      }
    });
  }
  return `<div class="wall" style="--health-columns:${widths.map(width => `${width}ch`).join(" ")}"><div id="provider-list" class="provider-list">${bands.map(providerMarkup).join("")}</div></div>`;
}

function providerMarkup(band) {
  const label = providerName(band);
  const counts = healthCounts(band);
  const description = healthText(counts);
  // Fixed slots keep each state's count aligned across providers; omit
  // optional zero states without moving the remaining counts between columns.
  const summary = SUMMARY_STATES.map((state, index) =>
    state !== "never" && (CORE_STATES.includes(state) || counts[state])
      ? `<span class="health-status" data-state="${state}" style="--status-column:${index % 4 + 1};--status-row:${Math.floor(index / 4) + 1}">`
        + `<span class="health-count">${number(counts[state])}</span><span class="health-label">${STATE_LABEL[state]}</span></span>`
      : "").join("");
  const segments = STATES.filter(state => counts[state]).map(state => `<span class="health-${state}" style="flex-grow:${counts[state]}"></span>`).join("");
  const open = expandedProvider === band.id;
  const detailId = `provider-detail-${encodeURIComponent(band.id)}`;
  const tipId = `provider-health-${encodeURIComponent(band.id)}`;
  const squares = open ? `<div class="band" data-band="${esc(band.id)}"><canvas role="img" aria-label="${esc(label)}: ${esc(description)}"></canvas></div>` : "";
  return `<div class="provider-entry"><button type="button" class="provider-row" data-provider="${esc(band.id)}" aria-expanded="${open}" aria-controls="${esc(detailId)}" aria-describedby="${esc(tipId)}">`
    + `<span class="provider-identity"><svg class="provider-chevron" aria-hidden="true" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg><span class="provider-name">${esc(label)}</span></span>`
    + `<span class="provider-health"><span class="health-track" role="img" aria-label="${esc(description)}">${segments}</span>`
    + `<span class="health-summary"><span class="health-status-grid">${summary}</span><span class="health-tooltip" id="${esc(tipId)}" role="tooltip">${esc(description)}</span></span></span>`
    + `<span class="provider-counts"><span class="provider-board-count">${boardCount(band)}</span> <span class="provider-count-separator" aria-hidden="true">|</span> <span class="provider-job-count">${jobCount(band)}</span></span>`
    + `</button><div id="${esc(detailId)}" class="provider-detail"${open ? "" : " hidden"}>${squares}</div></div>`;
}

function renderWall() {
  content.innerHTML = providerListMarkup();
  drawWall();
  const canvas = $(".band > canvas", content);
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
  const element = $(".band", content);
  const band = bands.find(item => item.id === element?.dataset.band);
  if (!band) return;
  const canvas = $(":scope > canvas", element);
  const ratio = devicePixelRatio || 1;
  const columns = squareColumns(element.clientWidth, SQUARES);
  const width = columns * SQUARES.pitch, height = Math.ceil(band.boards.length / columns) * SQUARES.pitch;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  paintSquares(context, band.boards, columns, SQUARES, colors);
  wall = { band, columns };
}

function showTip(board, pointerX, pointerY) {
  // With no legend on the page, the card names the state; its swatch is
  // the cell's own colour, so the two always agree.
  const strikes = board.strikes ? `<span>· ${esc(board.strikes)} ${board.strikes === 1 ? "strike" : "strikes"}</span>` : "";
  tip.innerHTML = `<div class="tip-name">${esc(board.company)}</div>
      <div class="tip-state"><i style="background: ${esc(cellColor(colors, board))}"></i><b>${esc(STATE_LABEL[board.state] || STATE_LABEL.unknown)}</b>${strikes}</div>
      <div class="tip-row"><span>jobs</span><b>${esc(number(board.jobs))}</b></div>
      <div class="tip-row"><span>last polled</span><b>${esc(board.last_poll_at ? relativeTime(board.last_poll_at) : "never")}</b></div>`;
  tip.classList.add("visible");
  const width = tip.offsetWidth, height = tip.offsetHeight;
  let x = pointerX + 16, y = pointerY + 16;
  if (x + width > innerWidth - 8) x = pointerX - width - 16;
  if (y + height > innerHeight - 8) y = pointerY - height - 16;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}

const hideTip = () => tip.classList.remove("visible");

/* ───────────── Header and footer ───────────── */
// Changed digits roll in, so a refresh shows what moved.
function renderClassification(values) {
  $(".classification-summary").hidden = !values;
  if (!values) return;
  for (const [selector, key] of [[".classification-total", "total"], [".classification-students", "student_roles"]]) {
    const counter = $(selector);
    const value = values[key];
    if (!Number.isSafeInteger(value) || value < 0) continue;
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

function renderTicker(payload, totals) {
  const line = todayLine(totals);
  ticker.hidden = !line;
  $("#today-line").innerHTML = todaySentence(totals, (value, side) => `<span class="activity-${side} activity-total">${value}</span>`);
  toggle.setAttribute("aria-label", `${line}. Show breakdown`);
  const detail = payload.today_breakdown || {};
  // Each column is as wide as its longest number, the day's total included.
  for (const [side, total, types, sign] of [
    ["posted", totals.added_today, detail.types, "+"],
    ["closed", totals.disappeared_today, detail.disappeared?.types, "−"],
  ]) {
    const digits = Math.max(number(total).length, ...JOB_TYPES.map(([, key]) => signedCount(types?.[key], sign).length));
    ticker.style.setProperty(`--activity-${side}-width`, `${digits}ch`);
  }
  const cell = (value, sign, label, side) => `<td class="activity-cell ${side}${value == null ? " is-unknown" : Number(value) === 0 ? " is-zero" : ""}"><span class="activity-number">${signedCount(value, sign)}</span> <span class="activity-category">${esc(label)}</span></td>`;
  card.innerHTML = `<table class="today-table">
      <caption class="visually-hidden">Jobs posted and closed today, by job type</caption>
      <thead class="visually-hidden"><tr>
        <th scope="col">Posted</th>
        <th scope="col">Closed</th>
      </tr></thead>
      <tbody>${JOB_TYPES.map(([label, key]) => `<tr${key === "unclassified" ? ' class="today-unclassified"' : ""}>
        ${cell(detail.types?.[key], "+", label, "activity-added")}
        ${cell(detail.disappeared?.types?.[key], "−", label, "activity-disappeared")}
      </tr>`).join("")}</tbody>
    </table>`
    + '<p class="dedup-note">Duplicate postings are filtered</p>';
  if (!card.hidden) setCard(true);
}

// Opening sizes the card to the line and lines its numbers up under the totals.
function setCard(open) {
  card.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  if (!open) return;
  const origin = ticker.getBoundingClientRect().left;
  const trigger = toggle.getBoundingClientRect();
  const posted = $("#today-line .activity-added").getBoundingClientRect();
  const inset = parseFloat(getComputedStyle(card).paddingLeft) + 1;
  card.style.width = `${Math.min(innerWidth - 8, Math.max(320, trigger.width + inset * 2))}px`;
  const postedWidth = $(".activity-added .activity-number", card).getBoundingClientRect().width;
  const left = Math.max(4, Math.min(posted.right - postedWidth - inset, innerWidth - card.offsetWidth - 4));
  card.style.left = `${left - origin}px`;
  const table = $(".today-table", card);
  const tableBox = table.getBoundingClientRect();
  ticker.style.setProperty("--activity-posted-indent", `${Math.max(0, posted.right - postedWidth - tableBox.left)}px`);
  const closed = $("#today-line .activity-disappeared")?.getBoundingClientRect();
  const gap = parseFloat(getComputedStyle(table).columnGap);
  const closedWidth = $(".activity-disappeared .activity-number", card).getBoundingClientRect().width;
  const firstColumn = closed ? closed.right - closedWidth - tableBox.left - gap : 0;
  // The sentence stays natural; only the pane follows the totals' positions.
  if (closed && Math.abs(closed.top - posted.top) < 1 && firstColumn > 0 && firstColumn < tableBox.width - gap) {
    ticker.style.setProperty("--activity-first-column", `${firstColumn}px`);
  } else {
    ticker.style.removeProperty("--activity-first-column");
  }
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
  colors = palette({
    low: readVar("--cell-ok-low"), high: readVar("--cell-ok-high"), gap: readVar("--cell-gap"),
    failing: readVar("--cell-failing"), degraded: readVar("--cell-degraded"), stale: readVar("--cell-stale"), idle: readVar("--cell-idle"),
  });
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
content.addEventListener("click", event => {
  const row = event.target.closest(".provider-row");
  if (!row) return;
  const id = row.dataset.provider;
  expandedProvider = expandedProvider === id ? null : id;
  hideTip();
  renderWall();
  $$(".provider-row", content).find(button => button.dataset.provider === id).focus({ preventScroll: true });
});
document.addEventListener("click", event => {
  if (event.target.closest('[data-action="retry"]')) loader.refresh({ initial: true });
  if (!event.target.closest("#ticker")) setCard(false);
});
// A mouse opens the card by hovering; touch and keyboard toggle it. A click
// while hovering must not close the card the hover just opened.
let hoverOpen = false;
ticker.addEventListener("pointerenter", event => { if (event.pointerType === "mouse") { hoverOpen = true; setCard(true); } });
ticker.addEventListener("pointerleave", event => { if (event.pointerType === "mouse") { hoverOpen = false; setCard(false); } });
toggle.addEventListener("click", () => { if (!hoverOpen) setCard(card.hidden); });
ticker.addEventListener("focusout", event => { if (!ticker.contains(event.relatedTarget)) setCard(false); });
ticker.addEventListener("keydown", event => {
  if (event.key === "Escape") { hoverOpen = false; setCard(false); toggle.focus(); }
});
let resizeTimer = 0;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (bands.length) { hideTip(); drawWall(); }
    if (!card.hidden) setCard(true);
  }, 80);
});

const clock = $("#clock");
const tick = () => { clock.textContent = clockText(); };
startAccount();
setInterval(tick, 1000);
loader.poll(document);
tick();
loader.refresh({ initial: true });

// Feed overview rules shared by the desktop and phone pages. No DOM access.

export const number = value => new Intl.NumberFormat().format(Number(value) || 0);
const compact = value => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(Number(value) || 0);

export const relativeTime = (value, now = new Date()) => {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "Never polled";
  const seconds = Math.max(0, Math.floor((now - date) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
};

export const withTimeout = (promise, milliseconds = 8000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("The feed overview request timed out.")), milliseconds);
  Promise.resolve(promise).then(
    value => { clearTimeout(timer); resolve(value); },
    error => { clearTimeout(timer); reject(error); },
  );
});

/* ───────────── Board states ───────────── */
// Every state a board can be in, in the health bar's order.
export const STATES = ["ok", "degraded", "failing", "stale", "paused", "never", "unknown"];
export const stateKey = value => {
  const key = String(value || "").trim().toLowerCase();
  return STATES.includes(key) ? key : "unknown";
};
// The API's state keys stay as they are; these are the words people read.
export const STATE_LABEL = { ok: "healthy", failing: "failing", degraded: "retrying", stale: "overdue", paused: "paused", never: "unpolled", unknown: "unknown" };
const PROBLEM_ORDER = ["failing", "degraded", "stale", "paused", "never", "unknown"];
const SEVERITY = { failing: 0, degraded: 1, stale: 2, paused: 3, never: 4, unknown: 5, ok: 9 };

export const problemText = problems => PROBLEM_ORDER
  .filter(state => problems[state])
  .map(state => `${problems[state]} ${STATE_LABEL[state]}`)
  .join(" · ");

// Summaries list states in this order. The four core states always show,
// measured zeros included; the rest only when some board is in them.
export const SUMMARY_STATES = ["ok", "degraded", "stale", "failing", "paused", "never", "unknown"];
export const CORE_STATES = SUMMARY_STATES.slice(0, 4);
export const shownStates = (counts, states = SUMMARY_STATES) => states.filter(state => CORE_STATES.includes(state) || counts[state]);
export const healthText = (counts, states) => shownStates(counts, states).map(state => `${number(counts[state])} ${STATE_LABEL[state]}`).join(", ");

/* ───────────── Fleet and providers ───────────── */
export const fleetTotals = payload => {
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

// Trouble first (worst first), pinned to the top-left corner. Within each
// state boards keep the API's order, so healthy shades mix across the wall.
const byWeight = boards => [...boards].sort((a, b) => SEVERITY[a.state] - SEVERITY[b.state]);

// Single-employer sources (not an ATS) are left off the Feeds page.
export const SINGLE_SOURCES = new Set(["amazon", "apple", "janestreet", "flyio", "hn", "simplify"]);

// One band per ATS provider with boards, ranked by its deduplicated, active
// student jobs eligible for Discover.
export const buildBands = payload => {
  const bands = [];
  for (const provider of Array.isArray(payload?.providers) ? payload.providers : []) {
    const list = Array.isArray(provider.boards) ? provider.boards : [];
    if (!list.length || SINGLE_SOURCES.has(provider.source)) continue;
    const band = { id: String(provider.source || "?"), boards: [], jobs: 0, discoverJobs: Number(provider.discover_jobs) || 0, problems: {} };
    for (const board of list) {
      const state = stateKey(board.state);
      const jobs = Number(board.coverage) || 0;
      band.boards.push({ company: board.company || board.key, state, strikes: Number(board.strikes) || 0, jobs, last_poll_at: board.last_poll_at || null });
      band.jobs += jobs;
      if (state !== "ok") band.problems[state] = (band.problems[state] || 0) + 1;
    }
    band.boards = byWeight(band.boards);
    bands.push(band);
  }
  return bands.sort((a, b) => b.discoverJobs - a.discoverJobs || a.id.localeCompare(b.id));
};

export const healthCounts = band => ({
  ...band.problems,
  ok: band.boards.length - Object.values(band.problems).reduce((sum, value) => sum + value, 0),
});

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
export const providerName = band => PROVIDER_NAMES[band.id] || band.id;
export const boardCount = band => `${number(band.boards.length)} ${band.boards.length === 1 ? "board" : "boards"}`;
export const jobCount = band => `${compact(band.jobs)} ${band.jobs === 1 ? "job" : "jobs"}`;

// Share of a provider's boards that are healthy, floored so 100% means all of them.
export const healthyShare = counts => {
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  if (!total) return "—";
  return `${counts.ok === total ? 100 : Math.min(99, Math.floor((counts.ok / total) * 100))}%`;
};
// The share colours itself, so weak providers stand out without reading.
export const healthTone = counts => {
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const share = total ? counts.ok / total : 0;
  return share >= 0.9 ? "" : share >= 0.5 ? "warn" : "bad";
};
// Problem columns on each provider row, worst first.
export const ISSUE_STATES = ["failing", "stale", "degraded"];

/* ───────────── Today's activity ───────────── */
// `mark` wraps each number, so the same sentence serves as text and as markup.
// Missing closure data is unknown, rather than a fabricated zero.
export const todaySentence = (totals, mark = value => value) => {
  const closed = totals?.disappeared_today;
  return `${mark(number(totals?.added_today), "added")} jobs posted`
    + (closed != null ? `, ${mark(number(closed), "disappeared")} jobs closed today` : " today");
};
// Empty when there is nothing to report.
export const todayLine = totals => totals?.disappeared_today != null || Number(totals?.added_today) ? todaySentence(totals) : "";

export const JOB_TYPES = [
  ["internships", "intern"], ["co-ops", "coop"],
  ["student jobs", "student"], ["new grad", "new_grad"],
  ["research", "research"], ["unclassified", "unclassified"],
];
export const signedCount = (value, sign) => value == null ? "—" : `${Number(value) === 0 ? "" : sign}${number(value)}`;

/* ───────────── Board squares ───────────── */
const RAMP_MAX_JOBS = 10000;
const SNAP_RADIUS = 2;
const rgb = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));

// Healthy boards shade from `low` to `high` by how many jobs they carry (log
// scale, 10k+ saturates); every other state is one flat colour.
export function palette({ low, high, ...flat }) {
  const from = rgb(low), to = rgb(high), maxLog = Math.log1p(RAMP_MAX_JOBS);
  const ramp = jobs => {
    const t = Math.min(1, Math.log1p(jobs) / maxLog);
    return `rgb(${from.map((channel, index) => Math.round(channel + (to[index] - channel) * t)).join(",")})`;
  };
  return { ...flat, ramp };
}
export const cellColor = (colors, board) => board.state === "ok" ? colors.ramp(board.jobs) : colors[board.state] || colors.idle;

export const squareColumns = (width, { pitch, size }) => Math.max(8, Math.floor((width + (pitch - size)) / pitch));

// Row by row, one square per board. Only occupied pitches get the gap tint, so
// the last row keeps its silhouette and the gutters soften against the page.
// Without a gap colour the gutters show the page.
export function paintSquares(context, boards, columns, { pitch, size }, colors) {
  const fullRows = Math.floor(boards.length / columns), remainder = boards.length % columns;
  if (colors.gap) {
    context.fillStyle = colors.gap;
    context.fillRect(0, 0, columns * pitch, fullRows * pitch);
    if (remainder) context.fillRect(0, fullRows * pitch, remainder * pitch, pitch);
  }
  boards.forEach((board, index) => {
    context.fillStyle = cellColor(colors, board);
    context.fillRect((index % columns) * pitch, Math.floor(index / columns) * pitch, size, size);
  });
}

// The index of the square under a point, preferring any problem board within a
// couple of squares: those are what someone is aiming for, and they are too
// small to hit exactly. Null off the grid.
export function pickSquare(boards, columns, x, y, pitch) {
  const column = Math.floor(x / pitch), row = Math.floor(y / pitch);
  const index = row * columns + column;
  if (column < 0 || row < 0 || column >= columns || index >= boards.length) return null;
  if (boards[index].state !== "ok") return index;
  let nearest = null, nearestDistance = Infinity;
  for (let dr = -SNAP_RADIUS; dr <= SNAP_RADIUS; dr += 1) {
    for (let dc = -SNAP_RADIUS; dc <= SNAP_RADIUS; dc += 1) {
      const r = row + dr, c = column + dc, candidate = r * columns + c;
      if (r < 0 || c < 0 || c >= columns || candidate >= boards.length || boards[candidate].state === "ok") continue;
      const distance = Math.hypot(dr, dc);
      if (distance < nearestDistance) { nearestDistance = distance; nearest = candidate; }
    }
  }
  return nearest ?? index;
}

/* ───────────── Clock and polling ───────────── */
// Two formats joined by a space: one combined format puts a comma between
// the date and the time.
const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true, timeZoneName: "short",
});
export const clockText = (now = new Date()) => `${DATE_FORMAT.format(now)} ${TIME_FORMAT.format(now)}`;

// Desktop: "Thu Oct 8, 10:59:06 PM PDT", built from parts since locales place
// commas differently.
const CLOCK_FORMAT = new Intl.DateTimeFormat("en-US", {
  weekday: "short", month: "short", day: "numeric",
  hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true, timeZoneName: "short",
});
export const clockLine = (now = new Date()) => {
  const part = Object.fromEntries(CLOCK_FORMAT.formatToParts(now).map(({ type, value }) => [type, value]));
  return `${part.weekday} ${part.month} ${part.day}, ${part.hour}:${part.minute}:${part.second} ${part.dayPeriod} ${part.timeZoneName}`;
};

const REFRESH_MS = 60000;

// Loads the overview one request at a time. A failure on the first load (or a
// retry) is an error; a later one keeps the last data and only marks it stale.
// `poll(document)` refreshes every minute while the page is visible.
export function feedLoader(load, { started, loaded, failed, stale, settled = () => {} }) {
  let inFlight = false, lastGood = 0;
  async function refresh({ initial = false } = {}) {
    if (inFlight) return;
    inFlight = true;
    if (initial) started();
    try {
      loaded(await withTimeout(load()));
      lastGood = Date.now();
      stale(false);
    } catch (error) {
      if (initial || !lastGood) failed(error);
      else stale(true);
    } finally {
      inFlight = false;
      settled();
    }
  }
  function poll(doc) {
    setInterval(() => { if (!doc.hidden) refresh(); }, REFRESH_MS);
    doc.addEventListener("visibilitychange", () => {
      if (!doc.hidden && Date.now() - lastGood > REFRESH_MS) refresh();
    });
  }
  return { refresh, poll };
}

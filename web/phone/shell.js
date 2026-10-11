/* The frame every phone page shares: the wordmark on top, four tabs and Profile
 at the bottom, full-screen pages that slide in, bottom sheets, and a toast with
 Undo. Each page's phone.js draws into it through P.start(module). */
import { api } from "../shared/api.js";
import { guest } from "../shared/guest.js";
import { $, $$, esc, localDay as today } from "../shared/util.js";
import { fromAPI, tasksDue } from "../applied/core.js";

const doc = document;
const icon = (id, cls = "") => `<svg class="${cls}" aria-hidden="true"><use href="#ph-${id}"/></svg>`;
const plural = (n, word, many = `${word}s`) => `${Number(n).toLocaleString()} ${n === 1 ? word : many}`;
const initials = name => {
  const words = String(name || "").replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
};

const SPRITE = `<svg class="ph-sprite" aria-hidden="true">
  <symbol id="ph-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></symbol>
  <symbol id="ph-applied" viewBox="0 0 24 24"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="m9 14 2 2 4-4"/></symbol>
  <symbol id="ph-resume" viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/></symbol>
  <symbol id="ph-feeds" viewBox="0 0 24 24"><path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1" fill="currentColor"/></symbol>
  <symbol id="ph-sliders" viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></symbol>
  <symbol id="ph-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
  <symbol id="ph-x" viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></symbol>
  <symbol id="ph-back" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></symbol>
  <symbol id="ph-chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></symbol>
  <symbol id="ph-down" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></symbol>
  <symbol id="ph-out" viewBox="0 0 24 24"><path d="M7 17 17 7M9 7h8v8"/></symbol>
  <symbol id="ph-check" viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></symbol>
  <symbol id="ph-flag" viewBox="0 0 24 24"><path d="M5 21V4"/><path d="M5 4h12l-2.5 4.5L17 13H5"/></symbol>
  <symbol id="ph-pin" viewBox="0 0 24 24"><path d="M12 21s7-7.2 7-12.5A7 7 0 0 0 5 8.5C5 13.8 12 21 12 21Z"/><circle cx="12" cy="8.5" r="2.4"/></symbol>
  <symbol id="ph-brief" viewBox="0 0 24 24"><rect x="3" y="7.5" width="18" height="12" rx="2"/><path d="M8 7.5V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v1.5M3 12.5h18"/></symbol>
  <symbol id="ph-eyeoff" viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c5 0 9 4.5 10 7-.4 1-1.3 2.4-2.6 3.7M6.6 6.6C4.5 8 3 10 2 12c1 2.5 5 7 10 7 1.9 0 3.6-.6 5.1-1.5M9.9 9.9a3 3 0 0 0 4.2 4.2"/></symbol>
  <symbol id="ph-user" viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c1.2-3.6 3.8-5.5 7-5.5s5.8 1.9 7 5.5"/></symbol>
  <symbol id="ph-pencil" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></symbol>
  <symbol id="ph-mail" viewBox="0 0 24 24"><rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="m4 7 8 6 8-6"/></symbol>
  <symbol id="ph-file" viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></symbol>
  <symbol id="ph-dl" viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></symbol>
  <symbol id="ph-undo" viewBox="0 0 24 24"><path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></symbol>
  <symbol id="ph-google" viewBox="0 0 24 24"><path fill="#4285F4" stroke="none" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z"/><path fill="#34A853" stroke="none" d="M12 22c2.7 0 5-.9 6.6-2.5l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z"/><path fill="#FBBC05" stroke="none" d="M6.4 13.9a6 6 0 0 1 0-3.8V7.5H3.1a10 10 0 0 0 0 9z"/><path fill="#EA4335" stroke="none" d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.5l3.3 2.6C7.2 7.8 9.4 6 12 6z"/></symbol>
  <symbol id="ph-more" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/></symbol>
  <symbol id="ph-eye" viewBox="0 0 24 24"><path d="M2.5 12C5 7.5 8.5 6 12 6s7 1.5 9.5 6c-2.5 4.5-6 6-9.5 6s-7-1.5-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></symbol>
  <symbol id="ph-trash" viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></symbol>
  <symbol id="ph-cal" viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/></symbol>
  <symbol id="ph-logout" viewBox="0 0 24 24"><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10"/></symbol>
  <symbol id="ph-select" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12 2.5 2.5 4.5-5"/></symbol>
  <symbol id="ph-alert" viewBox="0 0 24 24"><path d="M12 4 2.5 20h19z"/><path d="M12 10v4M12 17h.01"/></symbol>
  <symbol id="ph-refresh" viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4"/></symbol>
</svg>`;
const TABS = [
  ["discover", "Discover", "search", "/"],
  ["applied", "Applied", "applied", "/application/"],
  ["resume", "Resume", "resume", "/resume/"],
  ["feeds", "Feeds", "feeds", "/source-coverage/"],
];

// Overlay state shared with the page module: one full-screen page and one
// bottom sheet at most. The module owns everything else.
const S = { push: null, sheet: null };
const P = { $, $$, esc, icon, plural, initials, today, S };
let mod = null;
let els = null;
let account;          // undefined while unknown, null for a guest
let badge = 0;

/* ───────────── Frame ───────────── */
P.head = (title, extra = "") => `<header class="page-head"><div class="wordmark"><span class="wordmark-name">OneShot</span> <span class="wordmark-descriptor">Applications</span></div><h1 class="sr-only">${esc(title)}</h1>${extra}</header>`;

// Loading and error states keep each desktop page's own wording.
P.stateBlock = (kind, { title, detail = "", retry = "retry" } = {}) => kind === "loading"
  ? `<div class="state-box" role="status"><span class="spinner"></span><strong>${esc(title)}</strong>${detail ? `<span>${esc(detail)}</span>` : ""}</div>`
  : `<div class="state-box error" role="alert">${icon("alert")}<strong>${esc(title)}</strong>${detail ? `<span>${esc(detail)}</span>` : ""}<button class="btn" type="button" data-act="${retry}">${icon("refresh")}Try again</button></div>`;

function renderTabbar() {
  const tabs = TABS.map(([key, label, glyph, href]) => {
    const current = mod?.tab === key;
    const count = key === "applied" && badge ? `<span class="tab-badge" aria-label="${esc(plural(badge, "task"))} due">${badge}</span>` : "";
    return `<a href="${href}" data-tab="${key}"${current ? ' aria-current="page"' : ""}><span class="ind">${icon(glyph)}</span>${label}${count}</a>`;
  }).join("");
  const ring = account
    ? `<span class="ring user">${account.picture_url ? `<img src="${esc(account.picture_url)}" alt="" referrerpolicy="no-referrer">` : ""}<b>${esc(initials(account.name || account.email))}</b></span>`
    : `<span class="ring">${icon("user")}</span>`;
  els.tabbar.innerHTML = `${tabs}<button type="button" class="tab-profile" data-act="profile" aria-label="Profile" aria-expanded="${S.sheet?.kind === "profile"}"><span class="ind">${ring}</span>Profile</button>`;
}
P.setBadge = count => {
  const next = Math.max(0, Number(count) || 0);
  if (next === badge) return;
  badge = next;
  if (els) renderTabbar();
};

// Tasks due today or overdue, from raw API records: the Applied tab's badge.
P.openTaskCount = applications => tasksDue((applications || []).map(fromAPI));
async function loadBadge() {
  try { P.setBadge(P.openTaskCount((await api.applications.list())?.applications)); }
  catch (_) { /* The badge is a convenience; the Applied page reports its own errors. */ }
}

P.account = () => account;
async function loadAccount() {
  try { return await guest.account(); }
  catch (_) { return undefined; }
}

/* ───────────── Render ───────────── */
let lastPush = null, lastPushKey = null, lastSheet = null;
P.render = () => {
  if (!els || !mod) return;
  const page = els.page;
  const top = page.scrollTop;
  const active = doc.activeElement;
  const keepFocus = active && page.contains(active) && active.id ? active.id : null;
  const caret = keepFocus && "selectionStart" in active ? [active.selectionStart, active.selectionEnd] : null;
  // A page with a search box paints its own regions, so the box (and the
  // phone keyboard attached to it) survives every update.
  const html = mod.paint ? (mod.paint(page), P.lastPageHtml) : mod.renderPage();
  if (html !== P.lastPageHtml) {
    page.innerHTML = html;
    P.lastPageHtml = html;
    page.scrollTop = top;
    if (keepFocus) {
      const next = doc.getElementById(keepFocus);
      if (next) {
        next.focus({ preventScroll: true });
        if (caret && next.setSelectionRange) try { next.setSelectionRange(...caret); } catch (_) { /* not a text field */ }
      }
    }
    mod.afterPage?.();
  }

  const bar = mod.selectBar?.() || "";
  els.selectBar.innerHTML = bar;
  els.selectBar.classList.toggle("open", Boolean(bar));

  const push = els.push;
  // A module can leave typed values out of a signature, so saving one field
  // never redraws the form (and drops the keyboard) under the next one.
  const pushSig = S.push ? (mod.pushSig ? mod.pushSig(S.push) : JSON.stringify([S.push, mod.version?.() || 0])) : null;
  if (S.push && pushSig !== lastPush) {
    const scroller = $("#push-scroll", push);
    const scroll = scroller?.scrollTop || 0;
    // Redrawing the same page keeps its scroll position; a new page starts at the top.
    const key = JSON.stringify([S.push.kind, S.push.id, S.push.mode, S.push.token]);
    const same = key === lastPushKey;
    lastPushKey = key;
    push.innerHTML = mod.renderPush(S.push);
    const next = $("#push-scroll", push);
    if (next) {
      if (same) next.scrollTop = scroll;
      const bar = $(".push-bar", push);
      if (bar && !bar.classList.contains("scrolled")) next.addEventListener("scroll", () => bar.classList.toggle("scrolled", next.scrollTop > 90), { passive: true });
    }
    mod.afterPush?.();
  }
  // The closed page keeps its content while it slides away.
  if (!S.push && lastPushKey) { lastPushKey = null; setTimeout(() => { if (!S.push) push.innerHTML = ""; }, 320); }
  lastPush = pushSig;
  push.classList.toggle("open", Boolean(S.push));
  push.setAttribute("aria-hidden", String(!S.push));

  const sheet = els.sheet;
  const sheetSig = !S.sheet ? null
    : S.sheet.kind === "profile" ? JSON.stringify(["profile", account === undefined ? 0 : account ? 1 : 2, localCounts])
    : mod.sheetSig ? mod.sheetSig(S.sheet) : JSON.stringify([S.sheet, mod.version?.() || 0]);
  if (S.sheet && sheetSig !== lastSheet) {
    const body = $(".sheet-body", sheet);
    const scroll = body?.scrollTop || 0;
    const reopened = Boolean(lastSheet);
    sheet.innerHTML = S.sheet.kind === "profile" ? profileSheet() : mod.renderSheet(S.sheet);
    const nextBody = $(".sheet-body", sheet);
    if (nextBody && reopened) nextBody.scrollTop = scroll;
    if (!reopened) { P.hideToast(); requestAnimationFrame(() => sheet.focus({ preventScroll: true })); }
  }
  lastSheet = sheetSig;
  sheet.classList.toggle("open", Boolean(S.sheet));
  els.scrim.classList.toggle("open", Boolean(S.sheet));

  // Only the topmost layer takes taps and focus.
  page.inert = Boolean(S.push || S.sheet);
  els.tabbar.inert = Boolean(S.push || S.sheet);
  els.selectBar.inert = Boolean(S.push || S.sheet);
  push.inert = Boolean(S.sheet) || !S.push;
  els.toast.classList.toggle("high", Boolean(S.push));
  els.toast.classList.toggle("above-bar", !S.push && Boolean(bar));
  renderTabbar();
  syncHistory();
};

/* Hardware and gesture Back close the top layer instead of leaving the site. */
let armed = false, ignorePop = false;
function syncHistory() {
  const open = Boolean(S.push || S.sheet);
  if (open && !armed) {
    history.pushState({ oneshotPhone: true }, "");
    armed = true;
  } else if (!open && armed) {
    armed = false;
    ignorePop = true;
    history.back();
  }
}
addEventListener("popstate", () => {
  if (ignorePop) { ignorePop = false; return; }
  if (!armed) return;
  armed = false;
  P.back();
});
P.back = () => {
  if (S.sheet) { closeSheet(); return; }
  if (S.push) {
    if (!mod.back?.()) S.push = null;
    P.render();
  }
};
function closeSheet() {
  const kind = S.sheet?.kind;
  S.sheet = null;
  if (!mod.closeSheet?.(kind)) P.render();
}
P.closeSheet = closeSheet;

// Sets a region's markup only when it changed, keeping its scroll position.
P.region = (el, html) => {
  if (!el || el.__html === html) return false;
  const left = el.scrollLeft;
  el.innerHTML = html;
  el.__html = html;
  el.scrollLeft = left;
  return true;
};

/* ───────────── Toast ───────────── */
let toastTimer = null;
P.toast = (message, actions = []) => {
  const el = els.toast;
  el.innerHTML = `<span class="t-msg">${esc(message)}</span>${actions.map((action, index) => `<button type="button" class="${action.quiet ? "t-quiet" : ""}" data-toast="${index}">${esc(action.label)}</button>`).join("")}`;
  el.classList.add("show");
  el.onclick = event => {
    const button = event.target.closest("[data-toast]");
    if (!button) return;
    el.classList.remove("show");
    clearTimeout(toastTimer);
    actions[Number(button.dataset.toast)].run();
  };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), actions.some(action => action.label === "Undo") ? 12000 : 6000);
};
P.hideToast = () => { clearTimeout(toastTimer); els?.toast.classList.remove("show"); };

/* Deletes that offer Undo wait until the toast has gone, so Undo never has to
   rebuild what the server already threw away. Leaving the page sends them. */
const pending = new Map();
let pendingId = 0;
P.deferDelete = (commit, delay = 12500) => {
  const id = ++pendingId;
  const timer = setTimeout(() => { pending.delete(id); commit(false).catch(error => P.toast(error.message || "Could not delete.")); }, delay);
  pending.set(id, { timer, commit });
  return () => { const entry = pending.get(id); if (!entry) return false; clearTimeout(entry.timer); pending.delete(id); return true; };
};
addEventListener("pagehide", () => {
  for (const { timer, commit } of pending.values()) { clearTimeout(timer); commit(true).catch(() => {}); }
  pending.clear();
});

/* ───────────── Profile ───────────── */
let localCounts = null;
async function loadLocalCounts() {
  try {
    const [applications, resumes] = await Promise.all([
      api.applications.list().catch(() => null),
      api.resumes.list().catch(() => null),
    ]);
    localCounts = { applications: applications?.applications?.length ?? null, resumes: resumes?.resumes?.length ?? null };
  } catch (_) { localCounts = { applications: null, resumes: null }; }
  if (S.sheet?.kind === "profile") P.render();
}
function profileSheet() {
  const close = `<button class="icon-btn" type="button" data-act="close-sheet" aria-label="Close">${icon("x")}</button>`;
  if (account) {
    return `<div class="grabber"></div><div class="sheet-head"><h2 class="sr-only">Account</h2><span class="grow"></span>${close}</div><div class="sheet-body"><div class="guest-hero"><span class="ring user">${account.picture_url ? `<img src="${esc(account.picture_url)}" alt="" referrerpolicy="no-referrer">` : ""}<b>${esc(initials(account.name || account.email))}</b></span><h2>${esc(account.name || "Signed in")}</h2><p class="email">${esc(account.email || "")}</p></div>
      <div class="menu-list"><button class="opt" type="button" data-act="sign-out">${icon("logout")}Sign out</button></div></div><div class="sheet-pad"></div>`;
  }
  const count = (n, noun) => n == null ? "Saved here" : `${Number(n).toLocaleString()} saved here`;
  return `<div class="grabber"></div><div class="sheet-head"><h2 class="sr-only">Profile</h2><span class="grow"></span>${close}</div><div class="sheet-body"><div class="guest-hero"><span class="ring">${icon("user")}</span><h2>You're browsing as a guest</h2><p>Your applications and resume are saved in this browser only. Sign in to keep them on every device.</p></div>
    <ul class="local-list"><li>Applications<span>${count(localCounts?.applications, "application")}</span></li><li>Resumes<span>${count(localCounts?.resumes, "resume")}</span></li></ul></div>
    <div class="sheet-foot column"><a class="btn google block" href="/api/auth/login">${icon("google")}Continue with Google</a><button class="btn quiet block" type="button" data-act="close-sheet">Not now</button></div>`;
}

/* ───────────── Events ───────────── */
function onClick(event) {
  const target = event.target.closest("button, a, [data-act], [role=\"button\"], canvas");
  if (!target || !els.app.contains(target)) return;
  const d = target.dataset;
  if (d.tab) {
    // Re-tapping the current tab scrolls it to the top, as native tab bars do.
    if (d.tab === mod.tab) { event.preventDefault(); if (S.push || S.sheet) { S.sheet = null; S.push = null; P.render(); } else els.page.scrollTo({ top: 0, behavior: "smooth" }); }
    return;
  }
  switch (d.act) {
    case "profile":
      S.sheet = { kind: "profile" };
      if (!account) loadLocalCounts();
      return P.render();
    case "close-sheet": return closeSheet();
    case "back": return P.back();
    case "sign-out":
      target.disabled = true;
      fetch("/api/auth/logout", { method: "POST" }).finally(() => location.assign("/login/"));
      return;
  }
  mod.onClick?.(target, d, event);
}

// Keep fields above the on-screen keyboard: sheets and pages shrink to the
// part of the screen it leaves visible.
function trackKeyboard() {
  const viewport = visualViewport;
  if (!viewport) return;
  const update = () => {
    const covered = Math.max(0, innerHeight - viewport.height - viewport.offsetTop);
    doc.documentElement.style.setProperty("--kb", `${covered > 80 ? covered : 0}px`);
  };
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  update();
}

P.start = (module) => {
  mod = module;
  const boot = async () => {
    const host = doc.createElement("div");
    host.id = "phone";
    host.className = "app";
    host.innerHTML = `${SPRITE}<main class="page" id="page"></main><div class="select-bar" id="select-bar"></div><nav class="tabbar" id="tabbar" aria-label="Primary"></nav><section class="push" id="push" aria-hidden="true"></section><div class="scrim" id="scrim" data-act="close-sheet"></div><div class="sheet" id="sheet" role="dialog" aria-modal="true" tabindex="-1"></div><div class="toast" id="toast" role="status" aria-live="polite"></div>`;
    doc.body.append(host);
    els = { app: host, page: $("#page", host), selectBar: $("#select-bar", host), tabbar: $("#tabbar", host), push: $("#push", host), scrim: $("#scrim", host), sheet: $("#sheet", host), toast: $("#toast", host) };
    P.els = els;
    host.addEventListener("click", onClick);
    doc.addEventListener("keydown", event => {
      if (event.key !== "Escape" || (!S.sheet && !S.push)) return;
      event.preventDefault();
      P.back();
    });
    host.addEventListener("focusin", event => {
      if (!event.target.matches("input, textarea, select") || !event.target.closest(".push, .sheet")) return;
      setTimeout(() => event.target.scrollIntoView({ block: "nearest", behavior: "smooth" }), 320);
    });
    trackKeyboard();
    P.render();
    mod.start?.();
    account = await loadAccount();
    P.render();
    if (mod.tab !== "applied") loadBadge();
  };
  boot();
};

export default P;

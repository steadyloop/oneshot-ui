"""Checks that desktop Discover matches the approved mockup, element by element.

Loads mockup/desktop-overhaul (Discover) and the running app side by side at
1440 and 1024px, then compares the computed styles of each element pair in
every state the mockup shows: default, row hover, Skip menu, Skip notice,
Fields and Sort menus, Hidden view and Report. Any difference not on the
allow-list below fails the check.

Run against a running server (guest mode is enough):
    ONESHOT_URL=http://127.0.0.1:8766 uv run --with playwright python tests/browser/discover_matches_mockup.py

The mockup lives in the git-ignored mockup/ folder; the check skips without it.
"""
import asyncio
import os
import sys
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
MOCKUP = ROOT / "mockup" / "desktop-overhaul" / "index.html"
LIVE = os.environ.get("ONESHOT_URL", "http://127.0.0.1:8766").rstrip("/") + "/"

STYLE = [
    "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "color", "background-color",
    "border-top", "border-right", "border-bottom", "border-left", "border-radius", "padding", "margin", "gap",
    "box-shadow", "text-decoration-line", "text-transform", "max-width",
]
# Sizes are compared only for elements whose size the design fixes, not their content.
SIZE = ["height", "width"]

# (name, mockup selector, live selector, compare sizes?)
DEFAULT = [
    ("topbar", ".topbar", ".app-topbar", "h"),
    ("wordmark name", ".wordmark b", ".wordmark-name", ""),
    ("wordmark sub", ".wordmark span", ".wordmark-descriptor", ""),
    ("search box", ".top-search input", ".topbar-search", "hw"),
    ("search text", ".top-search input", ".topbar-search input", ""),
    ("subbar", ".subbar", ".discover-controls-pane", "h"),
    ("tab active", ".tab[aria-selected=true]", ".filter.active", ""),
    ("tab", ".tab[aria-selected=false]", ".filter:not(.active)", ""),
    ("tab count active", ".tab[aria-selected=true] .count", ".filter.active .filter-count", "h"),
    ("tab count", ".tab[aria-selected=false] .count", ".filter:not(.active) .filter-count", "h"),
    ("fields button", "[data-pop=fields]", ".field-trigger", "h"),
    ("sort button", "[data-pop=sort]", ".sort-trigger", "h"),
    ("hidden button", "[data-act=toggle-hidden]", ".hidden-toggle", "h"),
    ("hidden count", "[data-act=toggle-hidden] .count", ".hidden-count", "h"),
    ("list", ".list", ".opportunity-list", "w"),
    ("day header", ".group-h", ".recency-bucket", "h"),
    ("day count", ".group-h small", ".group-count", ""),
    ("row", ".row:not(.sel)", ".opportunity:not(.selected)", ""),
    ("row selected", ".row.sel", ".opportunity.selected", ""),
    ("row logo", ".row .logo", ".job-logo", "hw"),
    ("row title", ".row-title", ".opportunity-main h3", ""),
    ("row sub-line", ".row-sub", ".job-subline", ""),
    ("row company", ".row-sub b", ".job-company", ""),
    ("row pills", ".row .pills", ".tags", ""),
    ("row pill", ".row .pill", ".tag", "h"),
    ("row time", ".row-time", ".row-meta > span", ""),
    ("list footer", ".list-foot", ".list-pager", ""),
    ("pane", ".pane", ".detail", ""),
    ("card", ".card.job", ".detail-inner", ""),
    ("card logo", ".job-co .logo", ".detail-logo", "hw"),
    ("company row", ".job-co", ".detail-company-row", "h"),
    ("company", ".job-co b", ".detail-company", ""),
    ("report button", ".report-btn", ".detail-flag", "h"),
    ("title", ".job h1", ".detail-head h2", ""),
    ("meta", ".job-meta", ".detail-metadata", ""),
    ("actions", ".job-actions", ".detail-actions", "h"),
    ("apply", ".job-actions a.btn", ".open-link", "h"),
    ("add", ".job-actions .btn.primary", ".detail-actions .primary", "h"),
    ("divider", ".job-actions .vdiv", ".action-divider", "hw"),
    ("skip", ".job-actions .skip-wrap > button", ".detail-actions .skip", "h"),
    ("rule", ".job hr", ".detail-rule", "h"),
    ("about heading", ".job h3", ".detail-body h3", ""),
    ("summary", ".job p.summary", ".role-summary", ""),
    ("details heading", ".job h3 + p + h3", ".detail-facts > h3", ""),
    ("facts", ".facts", ".detail-facts dl", ""),
    ("fact row 1", ".fact:nth-of-type(1)", ".detail-fact:nth-of-type(1)", ""),
    ("fact row 2", ".fact:nth-of-type(2)", ".detail-fact:nth-of-type(2)", ""),
    ("fact label", ".fact dt", ".detail-fact dt", ""),
    ("fact value", ".fact dd", ".detail-fact dd", ""),
    ("skill pill", ".facts .pill", ".skill", "h"),
    ("other skill", ".facts .term", ".expertise-term", "h"),
]
HOVER = [
    ("row hover", ".row:hover", ".opportunity:hover", ""),
    ("hover add", ".row:hover .row-actions > button", ".opportunity:hover .card-add", "hw"),
    ("hover skip", ".row:hover .skip-wrap > button", ".opportunity:hover .card-skip", "hw"),
]
SKIP_MENU = [
    ("skip menu", ".skip-pop", ".skip-menu", "w"),
    ("skip menu label", ".skip-pop .pop-label", ".skip-menu p", "h"),
    ("skip menu item", ".skip-pop .opt", ".skip-menu button", "h"),
    ("skip menu key", ".skip-pop kbd", ".skip-menu kbd", ""),
    ("skip open", ".skip-wrap > button[aria-expanded=true]", ".detail .skip[aria-expanded=true]", "h"),
]
NOTICE = [
    ("skip notice", ".inline-notice", ".skip-notice", ""),
    ("skip notice undo", ".inline-notice button", ".skip-notice button", "h"),
]
FIELDS = [
    ("fields menu", ".pop", ".field-options", "w"),
    ("field option", ".pop .opt", ".degree-filter", "h"),
    ("field box on", ".pop .opt[aria-checked=true] .box", ".degree-filter[aria-checked=true] .box", "hw"),
    ("field box off", ".pop .opt[aria-checked=false] .box", ".degree-filter[aria-checked=false] .box", "hw"),
    ("show all fields", ".pop .foot-link", ".field-clear", "h"),
]
SORT = [
    ("sort menu", ".pop", ".sort-options", ""),
    ("sort option", ".pop .opt", ".sort-option", "h"),
    ("sort radio", ".pop .opt .box", ".sort-option .box", "hw"),
]
HIDDEN = [
    ("skip message after leaving the feed", ".toast", ".flash.show", ""),
    ("hidden button on", "[data-act=toggle-hidden]", ".hidden-toggle", "h"),
    ("hidden intro", ".list-intro", ".hidden-intro", ""),
    ("hidden reason", ".row .why", ".hidden-reason", ""),
    ("restore", ".row .restore", ".card-restore", "h"),
    ("hidden banner", ".hidden-banner", ".hidden-banner", ""),
    ("banner restore", ".hidden-banner .btn", ".hidden-banner .button", "h"),
]
TOAST = [
    ("toast", ".toast", ".flash.show", ""),
    ("toast undo", ".toast button", ".flash .flash-undo", "h"),
]
REPORT = [
    ("report dialog", ".modal", "#report-dialog", "w"),
    ("report title", ".modal-head h2", "#report-title", ""),
    ("report context", ".modal-head p", ".report-context", ""),
    ("report first row", ".report-row:first-of-type", ".report-row:first-of-type", ""),
    ("report row", ".report-row:nth-of-type(2)", ".report-row:nth-of-type(2)", ""),
    ("report box", ".report-row .tick", ".report-check .tick", "hw"),
    ("report key", ".report-row .k", ".report-key", ""),
    ("report value", ".report-row .v", ".report-value", ""),
    ("report submit", ".modal-foot .btn.primary", "#report-form .primary", "h"),
    ("report cancel", ".modal-foot .btn:not(.primary)", ".report-cancel", "h"),
    ("report note", ".modal-foot .note", ".report-foot p", ""),
]

# Differences that are intended. Keep this short, and say why.
ALLOW = {
    # The approved grounded-backdrop refinement fills the capped pane, aligns
    # the toolbar/card inset, and adds a faint shadow. Geometry is checked below.
    ("card", "max-width"), ("card", "box-shadow"),
    ("pane", "padding"), ("subbar", "padding"),
    # Content differs (sample vs real postings), so these follow the text.
    ("*", "width"), ("*", "height"),
    # The mockup lays out with an inner span the live markup doesn't have.
    ("list footer", "margin"),
    # Live keeps a Load more button beside the count, so the footer is a flex row.
    ("list footer", "gap"),
    # The live search box is a label holding an icon and the input; the mockup's is
    # the input itself with the icon laid over it. Text and icon land in the same place.
    ("search box", "font-size"), ("search box", "line-height"), ("search box", "color"), ("search box", "padding"), ("search box", "gap"),
    ("search text", "background-color"), ("search text", "border-top"), ("search text", "border-right"), ("search text", "border-bottom"),
    ("search text", "border-left"), ("search text", "border-radius"), ("search text", "padding"), ("search text", "line-height"),
    # The live topbar keeps its 20px left inset on the brand link instead of the bar.
    ("topbar", "padding"),
    # Layout boxes: their own line-height is inherited and never shows.
    ("pane", "line-height"), ("card", "line-height"), ("list", "line-height"),
    ("actions", "line-height"), ("facts", "line-height"), ("rule", "line-height"),
    ("company row", "line-height"), ("row", "line-height"), ("row selected", "line-height"),
    ("row hover", "line-height"), ("subbar", "line-height"), ("topbar", "line-height"),
    ("row pills", "line-height"), ("skip menu", "line-height"), ("fields menu", "line-height"), ("sort menu", "line-height"),
    ("report dialog", "line-height"), ("report row", "line-height"), ("report first row", "line-height"),
    # The rule is an <hr> in the mockup and a border on the body here; only its line matters.
    ("rule", "color"), ("rule", "border-right"), ("rule", "border-bottom"), ("rule", "border-left"),
    # The mockup centres its dialog with margin; the live <dialog> uses margin to place it.
    ("report dialog", "margin"),
    # Initials vs a real company logo inside the tile.
    ("row logo", "color"), ("row logo", "font-size"), ("row logo", "letter-spacing"), ("row logo", "line-height"),
    ("card logo", "line-height"), ("card logo", "letter-spacing"),
}

JS = """([sel, props]) => { const e = document.querySelector(sel); if (!e) return null;
  const c = getComputedStyle(e), r = e.getBoundingClientRect(), o = {};
  for (const p of props) o[p] = c.getPropertyValue(p);
  o['font-family'] = o['font-family'].split(',')[0].replace(/"/g, '');
  o.height = Math.round(r.height) + 'px'; o.width = Math.round(r.width) + 'px';
  for (const side of ['top', 'right', 'bottom', 'left']) { const k = 'border-' + side; if (o[k].startsWith('0px')) o[k] = 'none'; }
  return o; }"""


def allowed(name, prop):
    return (name, prop) in ALLOW or ("*", prop) in ALLOW


async def compare(mock, live, pairs, state, width, failures):
    for name, m_sel, l_sel, sizes in pairs:
        props = STYLE + [p for p, flag in (("height", "h"), ("width", "w")) if flag in sizes]
        a = await mock.evaluate(JS, [m_sel, STYLE])
        b = await live.evaluate(JS, [l_sel, STYLE])
        if a is None or b is None:
            failures.append(f"[{width} {state}] {name}: missing in {'mockup' if a is None else 'live'} ({m_sel} | {l_sel})")
            continue
        for prop in props:
            fixed = prop in SIZE
            if a[prop] != b[prop] and (fixed or not allowed(name, prop)):
                failures.append(f"[{width} {state}] {name} {prop}: mockup {a[prop]} | live {b[prop]}")


async def check(browser, width):
    failures = []
    mock = await browser.new_page(viewport={"width": width, "height": 900})
    live = await browser.new_page(viewport={"width": width, "height": 900})
    await mock.goto(MOCKUP.as_uri() + "#discover")
    await live.goto(LIVE)
    await live.wait_for_selector(".detail h2", timeout=20000)
    geometry = await live.evaluate("""() => {
      const right = s => document.querySelector(s).getBoundingClientRect().right;
      return { search: right('.topbar-search'), tools: right('.list-tools'), card: right('.detail-inner'),
        grid: document.querySelector('.discover-grid').getBoundingClientRect().width }; }""")
    if abs(geometry["search"] - geometry["card"]) > 1 or abs(geometry["tools"] - geometry["card"]) > 1:
        failures.append(f"[{width}] search, controls and card must share a right edge: {geometry}")
    if abs(geometry["grid"] - min(width - 76, 1560)) > 1:
        failures.append(f"[{width}] workspace must be left aligned and capped at 1560px: {geometry}")
    await mock.wait_for_timeout(500)
    app = mock.locator("#app")
    # Compare a posting listed with skills and on more than one board where the
    # live feed has one, like the mockup's first posting.
    for pick in (".opportunity:has(.tag-languages):has(.tag-stack)", ".opportunity:has(.tags)"):
        rows = live.locator(pick)
        if await rows.count():
            await rows.first.click()
            await live.wait_for_timeout(300)
            break
    # Only the mockup's first posting is listed twice (split Apply button).
    if not await live.locator(".open-more").count():
        await app.locator(".row").nth(1).click()
        await mock.wait_for_timeout(200)

    await compare(mock, live, DEFAULT, "default", width, failures)

    await app.locator(".row").nth(1).hover()
    await live.locator(".opportunity").nth(1).hover()
    await mock.wait_for_timeout(150)
    await compare(mock, live, HOVER, "row hover", width, failures)

    await app.locator(".job-actions [data-pop^=skip-pane]").click()
    await live.locator(".detail [data-action=skip]").click()
    await compare(mock, live, SKIP_MENU, "skip menu", width, failures)

    await mock.keyboard.press("2")
    await live.keyboard.press("2")
    await live.wait_for_selector(".skip-notice")
    await mock.wait_for_timeout(150)
    await compare(mock, live, NOTICE, "skip notice", width, failures)
    await live.locator(".skip-notice [data-action=undo]").click()
    await live.wait_for_timeout(600)

    await app.locator("[data-pop=fields]").click()
    await live.locator(".field-trigger").click()
    # Both menus need a ticked and an unticked field.
    if not await live.locator(".degree-filter[aria-checked=true]").count():
        await live.locator(".degree-filter").first.click()
        await live.wait_for_selector(".degree-filter[aria-checked=true]")
        await live.mouse.move(1, 1)
    await compare(mock, live, FIELDS, "fields menu", width, failures)
    await mock.keyboard.press("Escape")
    await live.keyboard.press("Escape")

    await app.locator("[data-pop=sort]").click()
    await live.locator(".sort-trigger").click()
    await compare(mock, live, SORT, "sort menu", width, failures)
    await mock.keyboard.press("Escape")
    await live.keyboard.press("Escape")

    # A skip gives both Hidden lists a row to compare.
    await app.locator(".job-actions [data-pop^=skip-pane]").click()
    await mock.keyboard.press("1")
    await live.locator(".detail [data-action=skip]").click()
    await live.keyboard.press("1")
    await live.wait_for_selector(".skip-notice")
    await app.locator("[data-act=toggle-hidden]").click()
    await live.locator(".hidden-toggle").click()
    await live.wait_for_selector(".hidden-reason", timeout=10000)
    await mock.wait_for_timeout(200)
    await compare(mock, live, HIDDEN, "hidden view", width, failures)
    await live.locator(".hidden-banner .button").click()
    await live.wait_for_timeout(600)
    await app.locator("[data-act=toggle-hidden]").click()
    await live.locator(".hidden-toggle").click()
    await live.wait_for_selector(".detail-flag", timeout=10000)

    await app.locator("[data-act=report]").click()
    await live.locator(".detail-flag").click()
    await app.locator("[data-report=focus]").click()
    await live.locator("#report-focus").click()
    await mock.wait_for_timeout(200)
    await compare(mock, live, REPORT, "report", width, failures)

    await app.locator("[data-act=report-submit]").click()
    await live.locator("#report-form .primary").click()
    await live.wait_for_selector(".flash.show")
    await mock.wait_for_timeout(200)
    await compare(mock, live, TOAST, "toast", width, failures)

    await mock.close()
    await live.close()
    return failures


async def main():
    if not MOCKUP.exists():
        print(f"skip: {MOCKUP} not found")
        return 0
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        failures = []
        for width in (1440, 1024):
            failures += await check(browser, width)
        await browser.close()
    for line in failures:
        print(line)
    print(f"{len(failures)} difference(s) from the mockup")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

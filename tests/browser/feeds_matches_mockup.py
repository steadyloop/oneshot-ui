"""Checks that desktop Feeds matches the approved mockup, element by element.

Loads mockup/desktop-overhaul (#feeds) and the running app side by side at
1440 and 1024px, then compares the computed styles of each element pair in
every state the mockup shows: default, row hover, an expanded provider with
its board tooltip, and today's breakdown. Any difference not on the
allow-list below fails the check.

Run against a running server (guest mode is enough):
    ONESHOT_URL=http://127.0.0.1:8766 uv run --with playwright python tests/browser/feeds_matches_mockup.py

The mockup lives in the git-ignored mockup/ folder; the check skips without it.
"""
import asyncio
import os
import sys
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
MOCKUP = ROOT / "mockup" / "desktop-overhaul" / "index.html"
LIVE = os.environ.get("ONESHOT_URL", "http://127.0.0.1:8766").rstrip("/") + "/source-coverage/"

STYLE = [
    "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "color", "background-color",
    "border-top", "border-right", "border-bottom", "border-left", "border-radius", "padding", "margin", "gap",
    "box-shadow", "text-decoration-line", "text-transform", "max-width",
]
SIZE = ["height", "width"]

# (name, mockup selector, live selector, compare sizes?)
DEFAULT = [
    ("page", ".feeds", ".feeds", ""),
    ("summary line", ".fleet-line", ".fleet-line", "h"),
    ("summary number", ".fleet-stats b", ".fleet-stats b", ""),
    ("summary separator", ".fleet-stats .fl-sep", ".fleet-stats .fl-sep", ""),
    ("today button", ".fleet-today button", ".fleet-today button", "h"),
    ("today posted", ".fleet-today .added", ".fleet-today .added", ""),
    ("today closed", ".fleet-today .gone", ".fleet-today .gone", ""),
    ("today chevron", ".fleet-today button svg", ".fleet-today button svg", "hw"),
    ("clock", ".clock", ".clock", ""),
    ("card", ".prov-card", ".prov-card", ""),
    ("row", ".p-row:not(.open)", ".p-row:not(.open)", ""),
    ("name cell", ".p-row td:first-child", ".p-row td:first-child", "h"),
    ("name", ".p-name", ".p-name", ""),
    ("chevron", ".p-name svg", ".p-name svg", "hw"),
    ("share", "td.pct:not(.warn):not(.bad)", "td.pct:not(.warn):not(.bad)", "h"),
    ("share warn", "td.pct.warn", "td.pct.warn", ""),
    ("share bad", "td.pct.bad", "td.pct.bad", ""),
    ("issue cell", "td.issue-cell", "td.issue-cell", ""),
    ("failing", ".issue.bad", ".issue.bad", ""),
    ("retrying", ".issue.warn", ".issue.warn", ""),
    ("overdue", ".issue:not(.bad):not(.warn)", ".issue:not(.bad):not(.warn)", ""),
    ("issue square", ".issue i", ".issue i", "hw"),
    ("boards", "td.scale", "td.scale", ""),
    ("jobs", "td.scale + td.scale", "td.scale + td.scale", ""),
    ("last row cell", ".prov tr:last-child td", ".prov tr:last-child td", ""),
    ("footer", ".fleet-foot", ".fleet-foot", ""),
    ("footer number", ".fleet-foot b", ".fleet-foot b", ""),
    ("footer link", ".fleet-foot a", ".fleet-foot a", ""),
]
HOVER = [
    ("row hover cell", ".p-row:hover td", ".p-row:hover td", ""),
]
OPEN = [
    ("open row cell", ".p-row.open td", ".p-row.open td", ""),
    ("open chevron", ".p-row.open .p-name svg", ".p-row.open .p-name svg", "hw"),
    ("detail cell", ".p-detail td", ".p-detail td", ""),
    ("wall box", ".sq-wrap", ".sq-wrap", ""),
    ("wall", ".sq-wrap canvas", ".sq-wrap canvas", ""),
    ("tooltip", ".sq-tip", ".sq-tip", ""),
    ("tooltip name", ".sq-tip b", ".sq-tip b", ""),
    ("tooltip line", ".sq-tip span", ".sq-tip span", ""),
]
TICKER = [
    ("breakdown", ".ticker-pop", ".ticker-pop", "w"),
    ("breakdown cell", ".ticker-pop td", ".ticker-pop td", "h"),
    ("breakdown posted", ".ticker-pop .pos", ".ticker-pop .pos", "h"),
    ("breakdown closed", ".ticker-pop .neg", ".ticker-pop .neg", "h"),
    ("breakdown note", ".ticker-pop p", ".ticker-pop p", ""),
]

# Differences that are intended. Keep this short, and say why.
ALLOW = {
    # Content differs (sample vs live numbers and names), so these follow the text.
    ("*", "width"), ("*", "height"),
    # The live page scrolls the window; its column fills the viewport below the topbar.
    ("page", "max-width"),
    # The clock is pushed right by an auto margin, so its size follows the line's text.
    ("clock", "margin"),
    # The line wraps the clock under the stats only when the numbers run long.
    ("summary line", "height"),
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
            fixed = prop in SIZE and (name, prop) not in ALLOW
            if a[prop] != b[prop] and (fixed or not allowed(name, prop)):
                failures.append(f"[{width} {state}] {name} {prop}: mockup {a[prop]} | live {b[prop]}")


async def hover_problem_square(page):
    """Hovers the wall's first square (a problem board when there is one)."""
    box = await page.locator(".sq-wrap canvas").bounding_box()
    await page.mouse.move(box["x"] + 2, box["y"] + 2)
    await page.wait_for_timeout(150)


async def check(browser, width, shots):
    failures = []
    mock = await browser.new_page(viewport={"width": width, "height": 900})
    live = await browser.new_page(viewport={"width": width, "height": 900})
    await mock.goto(MOCKUP.as_uri() + "#feeds")
    await live.goto(LIVE)
    await live.wait_for_selector(".p-row", timeout=20000)
    await mock.wait_for_timeout(500)
    app = mock.locator("#app")

    await compare(mock, live, DEFAULT, "default", width, failures)
    if shots:
        await mock.screenshot(path=str(shots / f"mock-{width}.png"))
        await live.screenshot(path=str(shots / f"live-{width}.png"))

    await app.locator(".p-row").nth(1).hover()
    await live.locator(".p-row").nth(1).hover()
    await mock.wait_for_timeout(150)
    await compare(mock, live, HOVER, "row hover", width, failures)

    await app.locator(".p-row").first.click()
    await live.locator(".p-row").first.click()
    await live.wait_for_selector(".sq-wrap canvas")
    await mock.wait_for_timeout(200)
    await hover_problem_square(mock)
    await hover_problem_square(live)
    await compare(mock, live, OPEN, "expanded", width, failures)
    if shots:
        await mock.screenshot(path=str(shots / f"mock-{width}-open.png"))
        await live.screenshot(path=str(shots / f"live-{width}-open.png"))
    await app.locator(".p-row.open").click()
    await live.locator(".p-row.open").click()

    await app.locator("[data-act=ticker]").click()
    await live.locator(".ticker-toggle").click()
    await mock.wait_for_timeout(150)
    await compare(mock, live, TICKER, "breakdown", width, failures)
    if shots:
        await mock.screenshot(path=str(shots / f"mock-{width}-ticker.png"))
        await live.screenshot(path=str(shots / f"live-{width}-ticker.png"))

    await mock.close()
    await live.close()
    return failures


async def main():
    if not MOCKUP.exists():
        print(f"skip: {MOCKUP} not found")
        return 0
    shots = Path(os.environ["SHOTS"]) if os.environ.get("SHOTS") else None
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        failures = []
        for width in (1440, 1024):
            failures += await check(browser, width, shots)
        await browser.close()
    for line in failures:
        print(line)
    print(f"{len(failures)} difference(s) from the mockup")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

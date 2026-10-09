/* Decides, before any page script runs, whether this visit gets the phone
   screens (phone/*) or the desktop page. Desktop is left exactly as it was:
   this file only reads the viewport there, and every phone style and script
   loads only on a phone. Crossing the breakpoint reloads, because the two
   versions are different code. */
(function (root) {
  "use strict";
  // Portrait phones by width; a phone turned sideways by its touch screen and
  // short viewport, so rotating never swaps versions mid-task.
  var QUERY = "(max-width: 760px), (hover: none) and (pointer: coarse) and (max-height: 500px)";
  var VERSION = "phone-20261008";
  var PAGES = { "/": "discover", "/application/": "applied", "/resume/": "resume", "/source-coverage/": "feeds" };
  var path = root.location.pathname.replace(/^\/static(?=\/)/, "").replace(/index\.html$/, "");
  var page = PAGES[path] || null;
  var media = root.matchMedia ? root.matchMedia(QUERY) : null;
  var active = Boolean(page && media && media.matches);
  root.OneShotPhone = { active: active, page: active ? page : null, query: QUERY, version: VERSION };

  if (page && media) {
    var started = media.matches;
    var onChange = function () { if (media.matches !== started) root.location.reload(); };
    if (media.addEventListener) media.addEventListener("change", onChange);
    else if (media.addListener) media.addListener(onChange);
  }
  if (!active) return;

  var doc = root.document;
  doc.documentElement.classList.add("is-phone");
  var viewport = doc.querySelector('meta[name="viewport"]');
  if (viewport && !/viewport-fit/.test(viewport.content)) viewport.content += ", viewport-fit=cover";

  // The desktop sheets stay in the page but stop applying; phone.css styles
  // everything. Until it arrives, nothing desktop flashes on screen.
  Array.prototype.forEach.call(doc.querySelectorAll('link[rel="stylesheet"]'), function (link) { link.media = "not all"; });
  var guard = doc.createElement("style");
  guard.textContent = "html.is-phone body > :not(#phone) { display: none !important; } html.is-phone body { margin: 0; background: #fff; } #phone { visibility: hidden; }";
  doc.head.appendChild(guard);
  var css = doc.createElement("link");
  css.rel = "stylesheet";
  css.href = "/static/phone/phone.css?v=" + VERSION;
  doc.head.appendChild(css);

  // Feeds has no guest workspace of its own, but the Profile sheet and the
  // Applied badge read it, so the phone version loads it there too.
  var scripts = (page === "feeds" ? ["/static/sample-data.js?v=tracker-20261006"] : [])
    .concat(["/static/phone/shell.js?v=" + VERSION, "/static/phone/" + page + ".js?v=" + VERSION]);
  scripts.forEach(function (src) {
    var script = doc.createElement("script");
    script.src = src;
    script.async = false;
    doc.head.appendChild(script);
  });
})(window);

/* The one script each page loads, from <head>. Phones get the phone screens,
   everything else the desktop page; crossing the breakpoint reloads. */
(function () {
  "use strict";
  // Portrait phones by width; landscape phones by touch and a short viewport.
  var media = matchMedia("(max-width: 760px), (hover: none) and (pointer: coarse) and (max-height: 500px)");
  var page = { "/": "discover", "/application/": "applied", "/resume/": "resume", "/source-coverage/": "feeds" }[location.pathname];
  if (!page) return;
  var phone = media.matches;
  media.addEventListener("change", function () { if (media.matches !== phone) location.reload(); });

  var entry = "/static/" + page + "/" + (phone ? "phone" : "desktop") + ".js";
  var preload = document.createElement("link");
  preload.rel = "modulepreload";
  preload.href = entry;
  document.head.appendChild(preload);
  // Inserted modules run as soon as they load, so wait for the parsed page.
  document.addEventListener("DOMContentLoaded", function () {
    var script = document.createElement("script");
    script.type = "module";
    script.src = entry;
    document.head.appendChild(script);
  });
  if (!phone) return;

  document.documentElement.classList.add("is-phone");
  var viewport = document.querySelector('meta[name="viewport"]');
  if (viewport && !/viewport-fit/.test(viewport.content)) viewport.content += ", viewport-fit=cover";
  // Desktop sheets stop applying; nothing desktop flashes while phone.css loads.
  document.querySelectorAll('link[rel="stylesheet"]').forEach(function (link) { link.media = "not all"; });
  var guard = document.createElement("style");
  guard.textContent = "html.is-phone body > :not(#phone) { display: none !important; } html.is-phone body { margin: 0; background: #fff; } #phone { visibility: hidden; }";
  document.head.appendChild(guard);
  var css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "/static/phone/phone.css";
  document.head.appendChild(css);
})();

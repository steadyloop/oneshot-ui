(function (root) {
  "use strict";

  const opportunityTotal = payload => Math.max(0, Number(payload?.total) || 0);
  const ownsOpportunityCount = () => ["/", "/index.html"].includes(root.location?.pathname);

  function setTotal(total) {
    const text = opportunityTotal({ total }).toLocaleString();
    root.document.querySelectorAll("[data-opportunity-count]").forEach(badge => {
      badge.textContent = text;
    });
  }

  // "Ada Lovelace" -> "AL", "ada" -> "A". Drawn under the avatar image so a
  // blocked or 404'd Google photo degrades to initials instead of a grey disc.
  const initials = name => (name || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0].toUpperCase())
    .join("") || "?";

  if (typeof module !== "undefined" && module.exports) module.exports = { opportunityTotal, initials };
  if (!root.document) return;

  const sampleModeOn = () => Boolean(root.OneShotSampleData?.isEnabled?.());

  async function refresh() {
    const badges = [...root.document.querySelectorAll("[data-opportunity-count]")];
    if (!badges.length) return;
    try {
      const total = opportunityTotal(await root.OneShotAPI.jobs.list({ limit: 1, offset: 0 }));
      setTotal(total);
    } catch (_) {
      badges.forEach(badge => { badge.textContent = "—"; });
    }
  }

  const el = (tag, className, text) => {
    const node = root.document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  // The sidebar is copied into four pages and the copies are not identical, so
  // the chip is built here — the one script all four already load — rather than
  // hand-edited into each of them.
  function mount(chip) {
    const sidebar = root.document.querySelector(".sidebar");
    if (!sidebar) return;
    sidebar.querySelector(".account")?.remove();
    sidebar.append(chip);
  }

  function avatar(account) {
    const node = el("span", "account-avatar", initials(account?.name || account?.email));
    const src = account?.picture_url;
    if (src) {
      const img = el("img", "account-photo");
      img.src = src;
      img.alt = "";
      img.referrerPolicy = "no-referrer";  // Google 403s some referrers
      node.append(img);
    }
    return node;
  }

  function signedOutChip() {
    // Same geometry as the signed-in chip so nothing shifts on sign-in.
    const chip = el("a", "account is-guest");
    chip.href = "/api/auth/login";
    const empty = el("span", "account-avatar is-empty");
    empty.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.4"/>' +
      '<path d="M5.5 19.5a6.5 6.5 0 0 1 13 0"/></svg>';
    const text = el("span", "account-text");
    text.append(el("span", "account-name", "Guest"), el("span", "account-action", "Browser-local · Sign in"));
    chip.append(empty, text);
    return chip;
  }

  function signedInChip(account) {
    const chip = el("div", "account");
    const text = el("span", "account-text");
    const email = el("span", "account-email", account.email || "");
    email.title = account.email || "";
    text.append(el("span", "account-name", account.name || account.email || "Signed in"), email);

    const more = el("button", "account-more");
    more.type = "button";
    more.setAttribute("aria-label", "Account menu");
    more.setAttribute("aria-expanded", "false");
    more.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/>' +
      '<circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';

    const menu = el("div", "account-menu");
    // The chip truncates the address; the menu is where it is readable in full.
    menu.append(el("p", "account-menu-email", account.email || ""));
    const out = el("button", "account-menu-item", "Sign out");
    out.type = "button";
    out.addEventListener("click", async () => {
      out.disabled = true;
      try {
        await root.fetch("/api/auth/logout", { method: "POST" });
      } finally {
        root.location.assign("/login/");
      }
    });
    menu.append(out);

    const close = () => {
      chip.classList.remove("is-open");
      more.setAttribute("aria-expanded", "false");
    };
    more.addEventListener("click", event => {
      event.stopPropagation();
      const open = chip.classList.toggle("is-open");
      more.setAttribute("aria-expanded", String(open));
    });
    // On narrow screens the ⋯ is hidden, so the avatar is the tap target.
    chip.addEventListener("click", event => {
      if (event.target.closest(".account-menu")) return;
      if (!event.target.closest(".account-avatar")) return;
      const open = chip.classList.toggle("is-open");
      more.setAttribute("aria-expanded", String(open));
    });
    root.document.addEventListener("click", event => {
      if (!chip.contains(event.target)) close();
    });
    root.document.addEventListener("keydown", event => {
      if (event.key === "Escape") close();
    });

    chip.append(avatar(account), text, more, menu);
    return chip;
  }

  // The sample-data switch is a guest affordance, so it ships hidden and this
  // reveals it — the class gates it in navigation.css. Doing it here rather than
  // in each shell means the button never flashes on screen for a signed-in user
  // before we know who they are.
  const markGuest = () => root.document.body.classList.add("is-guest");

  const asGuest = () => {
    markGuest();
    mount(signedOutChip());
    if (!ownsOpportunityCount()) refresh();
  };

  async function start() {
    // Sample mode serves every request from an in-browser fixture, so the chip
    // and the count are drawn before any network call: that page has to work
    // with no backend at all. The identity probe below still runs, because a
    // switch left on from browsing as a guest has to be noticed — but nothing
    // on screen is waiting on it.
    await root.OneShotSampleData?.ready?.();
    const sample = sampleModeOn();
    if (sample) asGuest();

    let account;
    try {
      if (root.OneShotVisitorData) {
        account = await root.OneShotVisitorData.account();
      } else {
        const response = await root.fetch("/api/auth/me");
        if (response.status !== 401 && !response.ok) return;
        account = response.ok ? await response.json().catch(() => ({})) : null;
      }
    } catch (_) {
      // Server unreachable. In sample mode the page is already drawn and stays
      // usable; otherwise leave it alone and let the view's own loader render
      // its error state.
      return;
    }
    // Deliberately no redirect on the identity 401. It means "use the guest
    // browser-local workspace", a state the chip renders rather than rejects.
    if (!account) {
      if (!sample) asGuest();
      return;
    }
    // Signed in. Any sample switch left on from browsing as a guest is cleared,
    // and the page reloads only when it was this page's switch — fixtures are
    // already on screen by then, and swapping the transport under them without
    // a reload would leave half the view fake.
    if (root.OneShotSampleData?.disableAll?.()) {
      root.location.reload();
      return;
    }
    mount(signedInChip(account));
    if (!ownsOpportunityCount()) refresh();
  }

  root.OneShotOpportunityCount = { refresh, set: setTotal };
  start();
})(typeof window !== "undefined" ? window : globalThis);

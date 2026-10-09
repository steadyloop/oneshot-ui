(function (root) {
  "use strict";

  const opportunityTotal = payload => Math.max(0, Number(payload?.total) || 0);

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

  // All four sidebars expose the same mount; retain the sidebar fallback
  // for older shells that still load this shared identity script.
  function mount(chip) {
    const host = root.document.querySelector("[data-account-slot]") || root.document.querySelector(".sidebar");
    if (!host) return;
    host.querySelector(".account")?.remove();
    host.append(chip);
  }

  function avatar(account) {
    const node = el("button", "account-avatar");
    const image = el("span", "account-initials", initials(account?.name || account?.email));
    node.type = "button";
    node.setAttribute("aria-label", "Account menu");
    node.setAttribute("aria-expanded", "false");
    node.setAttribute("aria-haspopup", "true");
    const src = account?.picture_url;
    if (src) {
      const img = el("img", "account-photo");
      img.src = src;
      img.alt = "";
      img.referrerPolicy = "no-referrer";  // Google 403s some referrers
      image.append(img);
    }
    node.append(image, el("span", "account-label", "Profile"));
    return node;
  }

  function signedOutChip() {
    // Same geometry as the signed-in chip so nothing shifts on sign-in.
    const chip = el("a", "account is-guest");
    chip.href = "/api/auth/login";
    chip.setAttribute("aria-label", "Guest account — sign in");
    const empty = el("span", "account-avatar is-empty");
    const image = el("span", "account-initials is-empty");
    image.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.4"/>' +
      '<path d="M5.5 19.5a6.5 6.5 0 0 1 13 0"/></svg>';
    empty.append(image, el("span", "account-label", "Profile"));
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
    menu.append(el("p", "account-menu-name", account.name || "Signed in"));
    menu.append(el("p", "account-menu-email", account.email || ""));
    if (account.can_edit_companies === true) {
      const companies = el("button", "account-menu-item", "Manage companies");
      companies.type = "button";
      companies.addEventListener("click", async () => {
        companies.disabled = true;
        try {
          const editor = await import("/static/company-editor.js?v=company-editor-20261007");
          close();
          await editor.openCompanyEditor();
        } catch (_) {
          companies.textContent = "Could not open editor — try again";
        } finally {
          companies.disabled = false;
        }
      });
      menu.append(companies);
    }
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
      chip.querySelector(".account-avatar")?.setAttribute("aria-expanded", "false");
    };
    more.addEventListener("click", event => {
      event.stopPropagation();
      const open = chip.classList.toggle("is-open");
      more.setAttribute("aria-expanded", String(open));
      chip.querySelector(".account-avatar")?.setAttribute("aria-expanded", String(open));
    });
    // The avatar and Profile label form one keyboard-accessible menu trigger.
    chip.addEventListener("click", event => {
      if (event.target.closest(".account-menu")) return;
      if (!event.target.closest(".account-avatar")) return;
      const open = chip.classList.toggle("is-open");
      more.setAttribute("aria-expanded", String(open));
      chip.querySelector(".account-avatar")?.setAttribute("aria-expanded", String(open));
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
    refresh();
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
    refresh();
  }

  root.OneShotOpportunityCount = { refresh, set: setTotal };
  start();
})(typeof window !== "undefined" ? window : globalThis);

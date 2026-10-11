// The sidebar's Profile control and Discover count, shared by every desktop page.
import { api } from "./api.js";
import { guest } from "./guest.js";

export const opportunityTotal = payload => Math.max(0, Number(payload?.total) || 0);

function setTotal(total) {
  const text = opportunityTotal({ total }).toLocaleString();
  document.querySelectorAll("[data-opportunity-count]").forEach(badge => {
    badge.textContent = text;
  });
}

// "Ada Lovelace" -> "AL". Drawn under the photo, so a blocked image shows initials.
export const initials = name => (name || "")
  .split(/\s+/)
  .filter(Boolean)
  .slice(0, 2)
  .map(part => part[0].toUpperCase())
  .join("") || "?";

export async function refreshCount() {
  const badges = [...document.querySelectorAll("[data-opportunity-count]")];
  if (!badges.length) return;
  try {
    const total = opportunityTotal(await api.jobs.list({ limit: 1, offset: 0 }));
    setTotal(total);
  } catch (_) {
    badges.forEach(badge => { badge.textContent = "—"; });
  }
}

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

function mount(chip) {
  const host = document.querySelector("[data-account-slot]");
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
        const editor = await import("./company-editor.js");
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
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("Sign out failed");
      location.assign("/");
    } catch (_) {
      out.textContent = "Could not sign out — try again";
      out.disabled = false;
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
  document.addEventListener("click", event => {
    if (!chip.contains(event.target)) close();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") close();
  });

  chip.append(avatar(account), text, more, menu);
  return chip;
}

export async function startAccount() {
  let account;
  try { account = await guest.account(); }
  catch (_) { return; }  // Server unreachable: the page's own loader shows the error.
  // No redirect on 401: that is the browser-local guest state.
  mount(account ? signedInChip(account) : signedOutChip());
  refreshCount();
}

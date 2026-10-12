import { esc } from "./util.js";

// Only use the app's stored company logos, including in browser-local records.
export const logoSrc = value => /^\/api\/companies\/\d+\/logo$/.test(String(value || "")) ? String(value) : "";
export function companyInitials(company) {
  const words = String(company || "").trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words.slice(0, 2).map(word => word[0]).join("") : (words[0] || "?").slice(0, 2)).toUpperCase();
}

export function companyLogoContent(app, fallback = companyInitials(app.company)) {
  const src = logoSrc(app.logo);
  return `<span>${esc(fallback)}</span>${src ? `<img data-company-logo src="${esc(src)}" alt="" loading="lazy" decoding="async">` : ""}`;
}

export function startCompanyLogoFallbacks(root = document) {
  // Image errors do not bubble, so capture also covers later table and drawer renders.
  root.addEventListener("error", event => {
    if (event.target?.matches?.("img[data-company-logo]")) event.target.remove();
  }, true);
}

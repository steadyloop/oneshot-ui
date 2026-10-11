// Small helpers shared by every page.
const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ENTITIES[ch]);
export const $ = (selector, scope = document) => scope.querySelector(selector);
export const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
export const clone = value => JSON.parse(JSON.stringify(value));

// YYYY-MM-DD in the reader's time zone.
export const localDay = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

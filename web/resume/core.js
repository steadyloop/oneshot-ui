// Resume logic shared by the desktop and phone pages: the section tables,
// reading and editing a resume's selection, and the /api/resume calls.
import { privateRequest } from "../shared/api.js";
import { guest } from "../shared/guest.js";
import { clone } from "../shared/util.js";

// fields: the two header fields an entry leads with, as [key, label, phone placeholder].
export const KIND = {
  education: { title: "Education", one: "education", fields: [["org", "School", "e.g. University of Washington"], ["role", "Degree", "e.g. B.S. Computer Science"]] },
  experience: { title: "Experience", one: "experience", fields: [["role", "Role", "e.g. Software Engineering Intern"], ["org", "Company", "e.g. Stripe"]] },
  project: { title: "Projects", one: "project", fields: [["org", "Project", "e.g. Trailhead"], ["role", "Description", "e.g. Hiking route planner"]] },
  research: { title: "Research", one: "research", fields: [["role", "Role", "e.g. Undergraduate Researcher"], ["org", "Organization", "e.g. UW Data Lab"]] },
  leadership: { title: "Leadership", one: "leadership role", fields: [["role", "Role", "e.g. President"], ["org", "Organization", "e.g. ACM chapter"]] },
};
export const BULLET_KINDS = ["experience", "project", "research", "leadership"];
export const SECTION_ORDER = ["education", "skills", ...BULLET_KINDS];
export const SKILL_GROUPS = [
  { key: "language", title: "Languages", categories: ["language"] },
  { key: "framework", title: "Frameworks & Libraries", categories: ["framework"] },
  { key: "data", title: "Data", categories: ["data"] },
  { key: "tool", title: "Tools & Systems", categories: ["tool", "math"] },
];
export const TEMPLATES = [["main", "Main"], ["barlow", "Barlow"]];
export const DENSITIES = [["standard", "Standard"], ["compact", "Compact"]];

export const groupOf = category => SKILL_GROUPS.find(group => group.categories.includes(category))?.key || "tool";
export const orgLabel = kind => KIND[kind].fields.find(([key]) => key === "org")[1];
export const dates = entry => [entry.start_date, entry.end_date].filter(Boolean).join(" – ");
export const gpa = entry => String(entry.detail || "").replace(/^GPA\s*:\s*/i, "");
export const shortDay = (iso, locale) => iso ? new Date(iso).toLocaleDateString(locale, { month: "short", day: "numeric" }) : "";

// "Jun 2026 – Present" -> both dates; a single value is the end date.
export function parseDates(raw) {
  const parts = raw.split(/\s+[–—-]\s+/).map(value => value.trim());
  return parts.length > 1 ? { start_date: parts[0], end_date: parts.slice(1).join(" – ") } : { start_date: "", end_date: raw.trim() };
}

// People paste "github.com/name" far more often than they type a scheme, so a
// missing one is filled in rather than rejected. Parsing with no base keeps a
// schemeless value from resolving against this origin as a same-site path.
export const webUrl = value => {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    return ["http:", "https:"].includes(url.protocol) && url.hostname.includes(".") ? url : null;
  } catch (_) {
    return null;
  }
};
// A profile link as stored, or null when the address is not a web link.
export const linkOf = (label, url) => {
  const parsed = webUrl(url);
  return parsed && { label: label.trim(), url: parsed.href };
};

/* Reading a resume */
export const pickOf = (resume, entryId) => (resume.selection?.entries || []).find(pick => pick.entry_id === entryId) || null;
export const bulletPick = (resume, entryId, bulletId) => pickOf(resume, entryId)?.bullets?.find(item => item.bullet_id === bulletId) || null;
export const skillOn = (resume, skillId) => (resume.selection?.skills || []).includes(skillId);
export const showsDetail = (resume, entryId) => pickOf(resume, entryId)?.show_detail !== false;
export const templateOf = resume => resume.selection?.template || resume.template || "main";
export const densityOf = resume => resume.selection?.density || "standard";
export const targetOf = (jobs, resume) => jobs.find(job => job.id === resume?.target_job_id) || null;

// Header fields a resume may reword for itself (resume_models.EntryPick).
const ENTRY_OVERRIDES = ["org", "role", "location", "start_date", "end_date", "detail"];
export function shownEntry(entry, resume) {
  const pick = resume && pickOf(resume, entry.id);
  if (!pick) return entry;
  const shown = { ...entry };
  ENTRY_OVERRIDES.forEach(field => { if (pick[field] != null) shown[field] = pick[field]; });
  return shown;
}

/* Editing a selection: each takes a copy from cloneSelection and changes it in place. */
export const cloneSelection = resume => clone(resume.selection || { entries: [], skills: [] });

// What a new resume starts with: everything tagged for its variant, and every
// entry that has no bullets to choose from.
export function initialSelection(entries, skills, variant) {
  const matches = audience => !variant || !audience || audience === "all" || audience === variant;
  const picks = entries.map(entry => ({
    entry_id: entry.id,
    bullets: entry.bullets.filter(bullet => matches(bullet.audience)).map(bullet => ({ bullet_id: bullet.id, text_override: null })),
  }));
  return {
    entries: picks.filter((pick, index) => pick.bullets.length || !entries[index].bullets.length),
    skills: skills.filter(skill => matches(skill.audience)).map(skill => skill.id),
  };
}

export function toggleSkill(selection, skillId) {
  const set = new Set(selection.skills || []);
  if (set.has(skillId)) set.delete(skillId); else set.add(skillId);
  selection.skills = [...set];
}

function entryPick(selection, entryId) {
  let pick = selection.entries.find(item => item.entry_id === entryId);
  if (!pick) { pick = { entry_id: entryId, bullets: [] }; selection.entries.push(pick); }
  return pick;
}

export function toggleBullet(selection, entryId, bulletId) {
  const pick = entryPick(selection, entryId);
  const index = pick.bullets.findIndex(item => item.bullet_id === bulletId);
  if (index >= 0) pick.bullets.splice(index, 1); else pick.bullets.push({ bullet_id: bulletId, text_override: null });
  // An entry with no bullets left leaves the resume.
  if (!pick.bullets.length) selection.entries = selection.entries.filter(item => item.entry_id !== entryId);
}

// Phone switches an entry on or off. With `complete` (desktop), a partly picked
// entry first gains its missing bullets, keeping its rewording and header overrides.
export function toggleEntry(selection, entry, { complete = false } = {}) {
  const existing = selection.entries.find(pick => pick.entry_id === entry.id);
  const others = selection.entries.filter(pick => pick.entry_id !== entry.id);
  const whole = !complete || !entry.bullets.length || existing?.bullets.length === entry.bullets.length;
  if (existing && whole) { selection.entries = others; return; }
  const overrides = new Map((existing?.bullets || []).map(item => [item.bullet_id, item.text_override ?? null]));
  const bullets = entry.bullets.map(bullet => ({ bullet_id: bullet.id, text_override: overrides.get(bullet.id) ?? null }));
  selection.entries = others.concat({ ...existing, entry_id: entry.id, bullets });
}

// Shows or hides an education entry's GPA.
export function toggleDetail(selection, entryId) {
  const pick = selection.entries.find(item => item.entry_id === entryId);
  if (pick) pick.show_detail = pick.show_detail === false;
  else selection.entries.push({ entry_id: entryId, bullets: [], show_detail: false });
}

// Rewords a bullet for one resume; empty or profile text goes back to the profile's.
export function rewordBullet(selection, entryId, bullet, text) {
  const pick = entryPick(selection, entryId);
  let chosen = pick.bullets.find(item => item.bullet_id === bullet.id);
  if (!chosen) { chosen = { bullet_id: bullet.id, text_override: null }; pick.bullets.push(chosen); }
  chosen.text_override = !text || text === bullet.text ? null : text;
}

export const newResume = ({ name, target, variant }, entries, skills) =>
  ({ name, target_job_id: target ? Number(target) : null, variant, selection: initialSelection(entries, skills, variant) });

// Applied's "Tailor resume" opens /resume/#target=<job id>.
export const handoffTarget = hash => Number(new URLSearchParams(hash.replace(/^#/, "")).get("target"));
export const resumeForJob = (job, variants, entries, skills) =>
  newResume({ name: `${job.company} · ${job.title}`.slice(0, 300), target: job.id, variant: variants[0]?.key || "" }, entries, skills);

/* /api/resume */
const call = (method, path, body) => privateRequest(`/resume${path}`, { method, body: body && JSON.stringify(body) });

export const resumeApi = {
  async load() {
    const [profile, entries, skills, variants, jobs, resumes] = await Promise.all(
      ["/profile", "/entries", "/skills", "/variants", "/jobs", "/resumes"].map(path => call("GET", path)));
    return {
      profile: profile || {}, entries: entries?.entries || [], skills: skills?.skills || [], variants: variants?.variants || [],
      jobs: jobs?.jobs || [], resumes: resumes?.resumes || [], local: await guest.isLocal(),
    };
  },
  saveProfile: fields => call("PUT", "/profile", fields),
  addEntry: fields => call("POST", "/entries", fields),
  updateEntry: (id, fields) => call("PATCH", `/entries/${id}`, fields),
  addBullet: (entryId, text) => call("POST", `/entries/${entryId}/bullets`, { text, audience: "all", tags: [], defense_notes: "" }),
  updateBullet: (id, text) => call("PATCH", `/bullets/${id}`, { text }),
  addSkill: (category, name, audience = "all") => call("POST", "/skills", { category, name, audience }),
  // The server has no skill edit; only the guest workspace answers this.
  updateSkill: (id, fields) => call("PATCH", `/skills/${id}`, fields),
  addResume: fields => call("POST", "/resumes", fields),
  updateResume: (id, fields) => call("PATCH", `/resumes/${id}`, fields),
  remove: path => call("DELETE", path),
};

// The PDF comes back as a file, not JSON. Signed out there is no stored resume
// to render, so the document travels with the request.
export async function pdfBlob({ local, profile, resume, entries, skills }) {
  const response = local
    ? await fetch("/api/resume/render/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile, resume, entries, skills }),
    })
    : await fetch(`/api/resume/resumes/${resume.id}/pdf`);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.detail || "Could not build PDF");
  }
  return response.blob();
}
export const pdfName = resume => `${(resume.name || "resume").replace(/[^a-z0-9]+/gi, "_")}.pdf`;

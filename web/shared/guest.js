// The signed-out workspace: a browser-local stand-in for the private API routes,
// stored in localStorage. Signing in switches to the account API; nothing is merged.
import { clone, localDay } from "./util.js";

const STATE_KEY = "oneshot.visitor-data.state.v1";

function createResumeState() {
  return {
    profile: { full_name: "", email: "", phone: "", location: "", links: [] },
    entries: [],
    skills: [],
    variants: [],
    targetJobs: [],
    resumes: [],
    nextEntryId: 1,
    nextBulletId: 1,
    nextSkillId: 1,
    nextResumeId: 1,
  };
}

export function createVisitorState() {
  return {
    jobs: [],
    applications: [],
    nextApplicationId: 1,
    applicationIdPrefix: "visitor-app",
    resume: createResumeState(),
    feedback: [],
  };
}

const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { "Content-Type": "application/json" },
});
const parseBody = options => {
  try { return JSON.parse(options?.body || "{}"); }
  catch (_) { return {}; }
};
const findJob = (state, id) => state.jobs.find(job => String(job.id) === String(id));
const findApplication = (state, id) => state.applications.find(application => String(application.id) === String(id));
// Older stored workspaces predate triage, so the list is created on first use.
const feedbackRows = state => state.feedback || (state.feedback = []);
const SKIP_REASONS = ["level", "location", "field", "company"];
const CORRECTION_FIELDS = ["type", "focus", "company", "location", "skills"];

// Mirrors the server's JobFeedbackCommand so a guest sees the same 422s.
function feedbackProblem(body) {
  const corrections = Array.isArray(body?.corrections) ? body.corrections : [];
  if (!["skip", "mislabeled"].includes(body?.kind)) return "kind must be skip or mislabeled";
  if (body.skip_reason != null && !SKIP_REASONS.includes(body.skip_reason)) return "unknown skip_reason";
  if (corrections.length > 5) return "at most 5 corrections";
  if (corrections.some(row => !CORRECTION_FIELDS.includes(row?.field) || String(row?.from ?? "").length > 300 || String(row?.to ?? "").length > 300)) return "invalid correction";
  if (body.kind === "skip" && corrections.length) return "a skip carries no corrections";
  if (body.kind === "mislabeled" && body.skip_reason != null) return "skip_reason is only valid for a skip";
  if (body.kind === "mislabeled" && !corrections.length) return "a mislabeled report needs at least one correction";
  return "";
}

const APPLICATION_STAGES = new Set(['applied', 'replied', 'assessment', 'interview', 'offer', 'closed']);
const CLOSED_REASONS = new Set(['rejected', 'withdrawn', 'no_reply']);
const validApplicationDate = value => value == null || value === '' || (typeof value === 'string' && Number.isFinite(Date.parse(value)) && (value.length !== 10 || new Date(value).toISOString().slice(0, 10) === value));
const validPostingURL = value => { if (!value) return true; try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } };
function normalizeApplications(state) {
  let changed = false;
  for (const app of state.applications || []) {
    if (app.stage === 'considering') { app.stage = 'applied'; changed = true; }
    if (!app.last_open_stage || app.last_open_stage === 'considering') {
      const previous = [...(app.events || [])].reverse().find(e => e.to_stage && e.to_stage !== 'closed')?.to_stage;
      app.last_open_stage = app.stage !== 'closed' ? app.stage : previous === 'considering' ? 'applied' : previous || 'applied';
      changed = true;
    }
    if (!app.task_state) { app.task_state = app.stage === 'applied' && !app.next_action ? 'waiting' : 'action'; changed = true; }
    if (app.waiting_for == null) { app.waiting_for = ''; changed = true; }
    // submitted_at is deliberately left alone, including legacy unknown dates.
  }
  return changed;
}
function applicationFromJob(state, job, submittedAt = localDay()) {
  return {
    id: `${state.applicationIdPrefix || "sample-app"}-${state.nextApplicationId++}`,
    job_id: job.id, company: job.company, title: job.title, location: job.location,
    stage: 'applied', closed_reason: null, last_open_stage: 'applied',
    task_state: 'waiting', waiting_for: '', next_action: null, next_due_at: null,
    external: false, submitted_at: submittedAt, apply_url_snapshot: job.apply_url,
    resume_variant: null, updated_at: new Date().toISOString(),
    stage_changed_at: new Date().toISOString(), note: '',
    events: [{ occurred_at: new Date().toISOString(), event_type: 'stage_changed', to_stage: 'applied', note: null }],
  };
}

export async function handle(input, options = {}, state) {
  normalizeApplications(state);
  const url = new URL(typeof input === "string" ? input : input.url, "http://oneshot.local");
  const method = String(options.method || "GET").toUpperCase();
  const path = url.pathname.replace(/^\/api(?=\/)/, "");

  const addMatch = path.match(/^\/jobs\/([^/]+)\/applications$/);
  if (method === "POST" && addMatch) {
    const job = findJob(state, decodeURIComponent(addMatch[1]));
    if (!job) return jsonResponse({ detail: "Job not found" }, 404);
    const existing = state.applications.find(application => application.job_id === job.id);
    if (existing) return jsonResponse({ ...clone(existing), already_exists: true });
    const submitted = parseBody(options).submitted_at || localDay();
    if (!validApplicationDate(submitted)) return jsonResponse({ detail: 'application dates must be ISO-8601 values' }, 422);
    const application = applicationFromJob(state, job, submitted);
    state.applications.unshift(application);
    return jsonResponse(clone(application), 201);
  }

  const feedbackMatch = path.match(/^\/jobs\/([^/]+)\/feedback$/);
  if (method === "PUT" && feedbackMatch) {
    const job = findJob(state, decodeURIComponent(feedbackMatch[1]));
    if (!job) return jsonResponse({ detail: "Job not found" }, 404);
    let body = {};
    try { body = JSON.parse(options.body || "{}"); } catch (_) { body = null; }
    const problem = feedbackProblem(body);
    if (problem) return jsonResponse({ detail: problem }, 422);
    const rows = feedbackRows(state);
    const now = new Date().toISOString();
    const existing = rows.find(row => row.job_id === job.id);
    const row = {
      job_id: job.id,
      kind: body.kind,
      skip_reason: body.skip_reason ?? null,
      corrections: (body.corrections || []).map(item => ({ field: item.field, from: String(item.from ?? ""), to: item.to ?? null })),
      created_at: existing?.created_at || now,
      updated_at: now,
    };
    if (existing) rows.splice(rows.indexOf(existing), 1, row);
    else rows.unshift(row);
    return jsonResponse(clone(row));
  }
  if (method === "DELETE" && feedbackMatch) {
    const rows = feedbackRows(state);
    const index = rows.findIndex(row => String(row.job_id) === decodeURIComponent(feedbackMatch[1]));
    if (index < 0) return jsonResponse({ detail: "Posting is not hidden" }, 404);
    rows.splice(index, 1);
    return new Response(null, { status: 204 });
  }
  if (method === "GET" && path === "/feedback") {
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 100));
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const rows = feedbackRows(state);
    const hidden = rows.slice(offset, offset + limit).map(row => ({ ...clone(row), job: clone(findJob(state, row.job_id) || null) }));
    return jsonResponse({ total: rows.length, hidden });
  }

  if (method === "POST" && path === "/applications/external") {
    const body = parseBody(options);
    const company = String(body.company || '').trim(), title = String(body.title || '').trim();
    if (!company || !title) return jsonResponse({ detail: 'company and title are required' }, 422);
    if (!validPostingURL(body.url)) return jsonResponse({ detail: 'application URL must be HTTP(S)' }, 422);
    if (!validApplicationDate(body.submitted_at)) return jsonResponse({ detail: 'application dates must be ISO-8601 values' }, 422);
    const application = {
      id: `${state.applicationIdPrefix || "sample-app"}-${state.nextApplicationId++}`,
      company, title, stage: 'applied', closed_reason: null, last_open_stage: 'applied',
      task_state: 'waiting', waiting_for: '', next_action: null, next_due_at: null,
      external: true, submitted_at: body.submitted_at || localDay(),
      apply_url_snapshot: body.url || null, resume_variant: null,
      updated_at: new Date().toISOString(), stage_changed_at: new Date().toISOString(),
      location: body.location || '', note: body.note || '',
      events: [{ occurred_at: new Date().toISOString(), event_type: 'stage_changed', to_stage: 'applied', note: body.note || null }],
    };
    state.applications.unshift(application);
    return jsonResponse(clone(application), 201);
  }

  if (method === "GET" && path === "/applications") {
    const applications = state.applications.map(({ events, ...application }) => application);
    return jsonResponse({ applications: clone(applications) });
  }

  const applicationMatch = path.match(/^\/applications\/([^/]+)$/);
  if (method === "GET" && applicationMatch) {
    const application = findApplication(state, decodeURIComponent(applicationMatch[1]));
    return application ? jsonResponse(clone(application)) : jsonResponse({ detail: "Application not found" }, 404);
  }
  if (method === "PATCH" && applicationMatch) {
    const application = findApplication(state, decodeURIComponent(applicationMatch[1]));
    if (!application) return jsonResponse({ detail: "Application not found" }, 404);
    const body = parseBody(options), previousStage = application.stage;
    const stage = Object.hasOwn(body, 'stage') ? body.stage : previousStage;
    const reason = Object.hasOwn(body, 'closed_reason') ? body.closed_reason : application.closed_reason;
    if (!APPLICATION_STAGES.has(stage)) return jsonResponse({ detail: 'unknown application stage' }, 422);
    if (stage === 'closed' && !CLOSED_REASONS.has(reason)) return jsonResponse({ detail: 'closed_reason is required when stage is closed' }, 422);
    if (stage !== 'closed' && body.closed_reason != null) return jsonResponse({ detail: 'closed_reason is only valid when stage is closed' }, 422);
    if (Object.hasOwn(body, 'task_state') && !['action', 'waiting'].includes(body.task_state)) return jsonResponse({ detail: 'unknown task state' }, 422);
    if (![body.submitted_at, body.next_due_at].every(validApplicationDate)) return jsonResponse({ detail: 'application dates must be ISO-8601 values' }, 422);
    if (Object.hasOwn(body, 'apply_url_snapshot') && !validPostingURL(body.apply_url_snapshot)) return jsonResponse({ detail: 'application URL must be HTTP(S)' }, 422);
    for (const key of ['company', 'title', 'location', 'apply_url_snapshot']) {
      if (!Object.hasOwn(body, key)) continue;
      if (!application.external && body[key] !== application[key]) return jsonResponse({ detail: 'discovered application snapshots cannot be edited' }, 422);
      if (['company', 'title'].includes(key) && !String(body[key] || '').trim()) return jsonResponse({ detail: `${key} is required` }, 422);
    }
    // All validation precedes mutation; rejected requests never partially edit a record.
    if (application.external) for (const key of ['company', 'title', 'location', 'apply_url_snapshot']) {
      if (Object.hasOwn(body, key)) application[key] = String(body[key] || '').trim();
    }
    if (stage === 'closed') {
      if (previousStage !== 'closed') application.last_open_stage = previousStage;
    } else application.last_open_stage = stage;
    application.stage = stage; application.closed_reason = stage === 'closed' ? reason : null;
    for (const key of ['submitted_at', 'next_action', 'next_due_at', 'note', 'task_state', 'waiting_for', 'resume_variant']) {
      if (Object.hasOwn(body, key)) application[key] = body[key];
    }
    application.updated_at = new Date().toISOString();
    application.events ||= [];
    if (stage !== previousStage) {
      application.stage_changed_at = application.updated_at;
      application.events.push({ occurred_at: application.updated_at, event_type: 'stage_changed', to_stage: stage, note: body.activity || null });
    } else if (body.activity) application.events.push({ occurred_at: application.updated_at, event_type: 'details_updated', to_stage: null, note: body.activity });
    return jsonResponse(clone(application));
  }
  if (method === "DELETE" && applicationMatch) {
    const index = state.applications.findIndex(application => String(application.id) === String(decodeURIComponent(applicationMatch[1])));
    if (index < 0) return jsonResponse({ detail: "Application not found" }, 404);
    state.applications.splice(index, 1);
    return new Response(null, { status: 204 });
  }

  // A state persisted before the resume workspace existed has no `resume` key.
  const resumeState = state.resume || (state.resume = createResumeState());

  if (method === "GET" && path === "/resume/profile") {
    return jsonResponse(clone(resumeState.profile));
  }
  if (method === "PUT" && path === "/resume/profile") {
    const body = parseBody(options);
    ["full_name", "email", "phone", "location", "links"].forEach(key => {
      if (body[key] !== undefined) resumeState.profile[key] = body[key];
    });
    return jsonResponse(clone(resumeState.profile));
  }

  if (method === "GET" && path === "/resume/entries") {
    // Sorted the way resume_workspace.list_entries sorts: (position, id) over
    // every entry, and over the bullets within each. Returning insertion order
    // here would have made the reorder buttons write a position the guest
    // workspace then ignored.
    const byPosition = (a, b) => a.position - b.position || a.id - b.id;
    const entries = clone(resumeState.entries).sort(byPosition);
    entries.forEach(entry => entry.bullets.sort(byPosition));
    return jsonResponse({ entries });
  }
  if (method === "POST" && path === "/resume/entries") {
    const body = parseBody(options);
    const siblings = resumeState.entries.filter(entry => entry.kind === body.kind);
    const entry = {
      id: resumeState.nextEntryId++, kind: body.kind, org: body.org,
      role: body.role || "", location: body.location || "",
      start_date: body.start_date || "", end_date: body.end_date || "",
      url: body.url || "", detail: body.detail || "",
      position: siblings.length + 1, bullets: [],
    };
    resumeState.entries.push(entry);
    return jsonResponse(clone(entry), 201);
  }
  const entryMatch = path.match(/^\/resume\/entries\/(\d+)$/);
  if (method === "PATCH" && entryMatch) {
    const entry = resumeState.entries.find(row => String(row.id) === entryMatch[1]);
    if (!entry) return jsonResponse({ detail: "Entry not found" }, 404);
    const body = parseBody(options);
    ["kind", "org", "role", "location", "start_date", "end_date", "url", "detail", "position"].forEach(key => {
      if (body[key] !== undefined) entry[key] = body[key];
    });
    return jsonResponse(clone(entry));
  }
  if (method === "DELETE" && entryMatch) {
    const index = resumeState.entries.findIndex(row => String(row.id) === entryMatch[1]);
    if (index < 0) return jsonResponse({ detail: "Entry not found" }, 404);
    resumeState.entries.splice(index, 1);
    return new Response(null, { status: 204 });
  }

  const entryBulletsMatch = path.match(/^\/resume\/entries\/(\d+)\/bullets$/);
  if (method === "POST" && entryBulletsMatch) {
    const entry = resumeState.entries.find(row => String(row.id) === entryBulletsMatch[1]);
    if (!entry) return jsonResponse({ detail: "Entry not found" }, 404);
    const body = parseBody(options);
    const bullet = {
      id: resumeState.nextBulletId++, entry_id: entry.id,
      text: body.text, audience: body.audience || "all",
      tags: body.tags || [], defense_notes: body.defense_notes || "",
      position: entry.bullets.length + 1,
    };
    entry.bullets.push(bullet);
    return jsonResponse(clone(bullet), 201);
  }
  const bulletMatch = path.match(/^\/resume\/bullets\/(\d+)$/);
  if (method === "PATCH" && bulletMatch) {
    const bullet = resumeState.entries.flatMap(entry => entry.bullets).find(row => String(row.id) === bulletMatch[1]);
    if (!bullet) return jsonResponse({ detail: "Bullet not found" }, 404);
    const body = parseBody(options);
    ["text", "audience", "tags", "defense_notes", "position"].forEach(key => {
      if (body[key] !== undefined) bullet[key] = body[key];
    });
    return jsonResponse(clone(bullet));
  }
  if (method === "DELETE" && bulletMatch) {
    for (const entry of resumeState.entries) {
      const index = entry.bullets.findIndex(row => String(row.id) === bulletMatch[1]);
      if (index >= 0) {
        entry.bullets.splice(index, 1);
        return new Response(null, { status: 204 });
      }
    }
    return jsonResponse({ detail: "Bullet not found" }, 404);
  }

  if (method === "GET" && path === "/resume/variants") {
    return jsonResponse({ variants: clone(resumeState.variants || []) });
  }
  if (method === "PUT" && path === "/resume/variants") {
    const incoming = parseBody(options).variants || [];
    const seen = new Set();
    const variants = [];
    incoming.forEach(item => {
      const key = String(item?.key || "").trim().toLowerCase().slice(0, 40);
      if (!key || key === "all" || seen.has(key)) return;
      seen.add(key);
      variants.push({ key, label: String(item?.label || "").trim().slice(0, 80) || key });
    });
    // Mirrors the server's 409: dropping a variant must not silently untag
    // the bullets and skills still carrying it.
    const used = new Map();
    const count = audience => {
      if (audience && audience !== "all" && !seen.has(audience)) {
        used.set(audience, (used.get(audience) || 0) + 1);
      }
    };
    resumeState.entries.forEach(entry => (entry.bullets || []).forEach(b => count(b.audience)));
    resumeState.skills.forEach(skill => count(skill.audience));
    if (used.size) {
      const detail = [...used].sort().map(([key, n]) => `${key} (${n})`).join(", ");
      return jsonResponse({ detail: `variant still in use: ${detail}` }, 409);
    }
    resumeState.variants = variants;
    return jsonResponse({ variants: clone(variants) });
  }

  if (method === "GET" && path === "/resume/skills") {
    return jsonResponse({ skills: clone(resumeState.skills) });
  }
  if (method === "POST" && path === "/resume/skills") {
    const body = parseBody(options);
    const duplicate = resumeState.skills.some(skill =>
      skill.category === body.category && skill.name.toLowerCase() === String(body.name).toLowerCase());
    if (duplicate) return jsonResponse({ detail: "Skill already exists in that category" }, 409);
    const skill = { id: resumeState.nextSkillId++, category: body.category, name: body.name, audience: body.audience || "all" };
    resumeState.skills.push(skill);
    return jsonResponse(clone(skill), 201);
  }
  const skillMatch = path.match(/^\/resume\/skills\/(\d+)$/);
  if (method === "PATCH" && skillMatch) {
    const skill = resumeState.skills.find(row => String(row.id) === skillMatch[1]);
    if (!skill) return jsonResponse({ detail: "Skill not found" }, 404);
    const body = parseBody(options);
    const category = body.category ?? skill.category;
    const name = body.name ?? skill.name;
    const duplicate = resumeState.skills.some(row => row.id !== skill.id && row.category === category && row.name === name);
    if (duplicate) return jsonResponse({ detail: "Skill already exists in that category" }, 422);
    ["category", "name", "audience"].forEach(key => {
      if (body[key] !== undefined) skill[key] = body[key];
    });
    return jsonResponse(clone(skill));
  }
  if (method === "DELETE" && skillMatch) {
    const index = resumeState.skills.findIndex(row => String(row.id) === skillMatch[1]);
    if (index < 0) return jsonResponse({ detail: "Skill not found" }, 404);
    resumeState.skills.splice(index, 1);
    return new Response(null, { status: 204 });
  }

  if (method === "GET" && path === "/resume/jobs") {
    return jsonResponse({ jobs: clone(resumeState.targetJobs) });
  }
  if (method === "GET" && path === "/resume/resumes") {
    return jsonResponse({ resumes: clone(resumeState.resumes) });
  }
  if (method === "POST" && path === "/resume/resumes") {
    const body = parseBody(options);
    const resumeRecord = {
      id: resumeState.nextResumeId++, name: body.name, target_job_id: body.target_job_id ?? null,
      variant: body.variant || "", template: body.template || "main", availability_line: body.availability_line || "",
      education_note: body.education_note || "", selection: body.selection || { entries: [], skills: [] },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    resumeState.resumes.unshift(resumeRecord);
    return jsonResponse(clone(resumeRecord), 201);
  }
  const resumeIdMatch = path.match(/^\/resume\/resumes\/(\d+)$/);
  if (method === "GET" && resumeIdMatch) {
    const record = resumeState.resumes.find(row => String(row.id) === resumeIdMatch[1]);
    return record ? jsonResponse(clone(record)) : jsonResponse({ detail: "Resume not found" }, 404);
  }
  if (method === "PATCH" && resumeIdMatch) {
    const record = resumeState.resumes.find(row => String(row.id) === resumeIdMatch[1]);
    if (!record) return jsonResponse({ detail: "Resume not found" }, 404);
    const body = parseBody(options);
    ["name", "target_job_id", "variant", "template", "availability_line", "education_note", "selection"].forEach(key => {
      if (body[key] !== undefined) record[key] = body[key];
    });
    record.updated_at = new Date().toISOString();
    return jsonResponse(clone(record));
  }
  if (method === "DELETE" && resumeIdMatch) {
    const index = resumeState.resumes.findIndex(row => String(row.id) === resumeIdMatch[1]);
    if (index < 0) return jsonResponse({ detail: "Resume not found" }, 404);
    resumeState.resumes.splice(index, 1);
    return new Response(null, { status: 204 });
  }

  return jsonResponse({ detail: `No sample response for ${method} ${path}` }, 404);
}

let visitorState;
let accountPromise;

const loadState = () => {
  if (visitorState) return visitorState;
  try { visitorState = JSON.parse(localStorage.getItem(STATE_KEY)) || createVisitorState(); }
  catch (_) { visitorState = createVisitorState(); }
  if (normalizeApplications(visitorState)) saveState();
  return visitorState;
};
const saveState = () => {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(visitorState)); }
  catch (_) { /* The in-memory workspace still works for this page load. */ }
};
const request = async (path, options = {}) => {
  const result = await handle(path, options, loadState());
  if (String(options.method || "GET").toUpperCase() !== "GET") saveState();
  return result;
};
// Memoised identity probe; a 401 means a guest.
const account = () => accountPromise ||= (async () => {
  const response = await fetch("/api/auth/me");
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`Identity check failed (${response.status})`);
  return response.json();
})();
const isLocal = async () => (await account()) === null;
const rememberJob = job => {
  if (!job) return;
  const jobs = loadState().jobs;
  const index = jobs.findIndex(row => String(row.id) === String(job.id));
  if (index >= 0) jobs[index] = clone(job);
  else jobs.push(clone(job));
};
const applicationJobIds = () => loadState().applications.map(row => row.job_id).filter(id => id != null);
const hiddenJobIds = () => (loadState().feedback || []).map(row => row.job_id).filter(id => id != null);

export const guest = { account, isLocal, request, rememberJob, applicationJobIds, hiddenJobIds };

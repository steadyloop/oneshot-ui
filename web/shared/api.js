// The browser's client for /api. Private routes (applications, feedback, resumes)
// are answered by the browser-local guest workspace while signed out.
import { guest } from "./guest.js";
import { localDay } from "./util.js";

export const query = values => {
  const params = new URLSearchParams();
  Object.entries(values || {}).forEach(([key, value]) => {
    if (value == null || value === "") return;
    (Array.isArray(value) ? value : [value]).forEach(item => params.append(key, item));
  });
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
};

export const errorMessage = (payload, status) => {
  const detail = payload?.detail;
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail)) {
    const messages = detail.map(item => (typeof item === "string" ? item : item?.msg)).filter(Boolean);
    if (messages.length) return [...new Set(messages)].join(". ");
  }
  return `Request failed (${status})`;
};

// A 401 means the session ended. The promise never settles, so no caller paints
// an error over the page while it navigates away.
function toLogin() {
  if (location.pathname !== "/login/") location.assign("/login/");
  return new Promise(() => {});
}

async function send(path, options = {}, isPrivate = false) {
  const response = isPrivate && await guest.isLocal()
    ? await guest.request(path, options)
    : await fetch(`/api${path}`, { ...options, headers: { "Content-Type": "application/json", ...options.headers } });
  if (response.status === 401) return toLogin();
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorMessage(payload, response.status));
  return payload;
}

export const request = (path, options) => send(path, options);
export const privateRequest = (path, options) => send(path, options, true);

const id = encodeURIComponent;
const body = (method, payload) => ({ method, body: JSON.stringify(payload) });
const resumeRequest = (method, path, payload) => privateRequest(`/resume${path}`, { method, body: payload && JSON.stringify(payload) });
// Guests snapshot a posting before writing about it, so their lists can still show it.
const remember = async job => { if (await guest.isLocal()) guest.rememberJob(job); };

export const api = {
  jobs: {
    async list(filters) {
      const values = { ...filters };
      if (await guest.isLocal()) {
        // Tracked and hidden postings leave a guest's feed; signed in, PostgreSQL filters them.
        const ids = [...guest.applicationJobIds(), ...guest.hiddenJobIds()]
          .filter(value => String(value).trim() !== "" && Number.isSafeInteger(Number(value))).map(String);
        if (ids.length) values.exclude_job_id = [...new Set(ids)];
      }
      return request(`/jobs${query(values)}`);
    },
    async addToApplications(jobId, job) {
      await remember(job);
      return privateRequest(`/jobs/${id(jobId)}/applications`, body("POST", { submitted_at: localDay() }));
    },
    async setFeedback(jobId, payload, job) {
      await remember(job);
      return privateRequest(`/jobs/${id(jobId)}/feedback`, body("PUT", payload));
    },
    clearFeedback: jobId => privateRequest(`/jobs/${id(jobId)}/feedback`, { method: "DELETE" }),
  },
  feedback: {
    list: filters => privateRequest(`/feedback${query(filters)}`),
  },
  applications: {
    list: () => privateRequest("/applications"),
    get: appId => privateRequest(`/applications/${id(appId)}`),
    createExternal: payload => privateRequest("/applications/external", body("POST", payload)),
    update: (appId, payload) => privateRequest(`/applications/${id(appId)}`, body("PATCH", payload)),
    remove: appId => privateRequest(`/applications/${id(appId)}`, { method: "DELETE" }),
  },
  resumes: {
    async load() {
      const [profile, entries, skills, variants, jobs, resumes] = await Promise.all(
        ["/profile", "/entries", "/skills", "/variants", "/jobs", "/resumes"].map(path => resumeRequest("GET", path)));
      return {
        profile: profile || {}, entries: entries?.entries || [], skills: skills?.skills || [], variants: variants?.variants || [],
        jobs: jobs?.jobs || [], resumes: resumes?.resumes || [], local: await guest.isLocal(),
      };
    },
    list: () => privateRequest("/resume/resumes"),
    saveProfile: fields => resumeRequest("PUT", "/profile", fields),
    addEntry: fields => resumeRequest("POST", "/entries", fields),
    updateEntry: (entryId, fields) => resumeRequest("PATCH", `/entries/${id(entryId)}`, fields),
    addBullet: (entryId, text) => resumeRequest("POST", `/entries/${id(entryId)}/bullets`, { text, audience: "all", tags: [], defense_notes: "" }),
    updateBullet: (bulletId, text) => resumeRequest("PATCH", `/bullets/${id(bulletId)}`, { text }),
    addSkill: (category, name, audience = "all") => resumeRequest("POST", "/skills", { category, name, audience }),
    // Skill editing is supported by the guest workspace only.
    updateSkill: (skillId, fields) => resumeRequest("PATCH", `/skills/${id(skillId)}`, fields),
    addResume: fields => resumeRequest("POST", "/resumes", fields),
    updateResume: (resumeId, fields) => resumeRequest("PATCH", `/resumes/${id(resumeId)}`, fields),
    remove: path => resumeRequest("DELETE", path),
    async parse(input, type, signal) {
      const response = await fetch(`/api/resume/parse?file_type=${type}`, {
        method: "POST", body: input, signal,
        headers: { "Content-Type": type === "text" ? "text/plain; charset=utf-8" : "application/octet-stream" },
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || "The resume could not be read. Try pasting its text.");
      return result;
    },
    async pdf({ local, profile, resume, entries, skills }) {
      const response = local
        ? await fetch("/api/resume/render/pdf", {
          ...body("POST", { profile, resume, entries, skills }), headers: { "Content-Type": "application/json" },
        })
        : await fetch(`/api/resume/resumes/${resume.id}/pdf`);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.detail || "Could not build PDF");
      }
      return response.blob();
    },
    // Idempotent: a double click returns the existing target.
    targetFromApplication: appId => privateRequest(`/resume/jobs/from-application/${id(appId)}`, { method: "POST" }),
  },
  sources: {
    boards: () => request("/source-coverage/boards"),
  },
};

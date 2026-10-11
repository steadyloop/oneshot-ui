import test from "node:test";
import assert from "node:assert/strict";
import { createVisitorState, handle } from "../../web/shared/guest.js";
import { api, errorMessage, query } from "../../web/shared/api.js";
import { opportunityTotal } from "../../web/shared/account.js";

// Signed out: the identity probe answers 401, and every other request is recorded.
const requests = [];
globalThis.fetch = async (url, options = {}) => {
  requests.push(`${options.method || "GET"} ${url}`);
  return url === "/api/auth/me" ? new Response(null, { status: 401 }) : Response.json({ jobs: [], total: 0 });
};

const call = async (state, path, method = "GET", body) =>
  handle(path, { method, body: body && JSON.stringify(body) }, state);

test("query strings repeat array values and skip empty ones", () => {
  assert.equal(query({ q: "python", job_type: ["intern", "new_grad"], season: "" }), "?q=python&job_type=intern&job_type=new_grad");
  assert.equal(query({}), "");
});

test("error messages prefer the server's detail", () => {
  assert.equal(errorMessage({ detail: "Nope" }, 422), "Nope");
  assert.equal(errorMessage({ detail: [{ msg: "a" }, { msg: "a" }, { msg: "b" }] }, 422), "a. b");
  assert.equal(errorMessage(null, 500), "Request failed (500)");
});

test("the Discover count is never negative or missing", () => {
  assert.equal(opportunityTotal({ total: 428 }), 428);
  assert.equal(opportunityTotal({ total: null }), 0);
});

test("a guest workspace starts blank", () => {
  const state = createVisitorState();
  assert.deepEqual(state.applications, []);
  assert.deepEqual(state.resume.entries, []);
  assert.equal(state.resume.profile.full_name, "");
});

test("guest applications follow the server's editing rules", async () => {
  const state = createVisitorState();
  state.jobs.push({ id: 7, company: "Northwind", title: "Intern", location: "Remote", apply_url: "https://example.com/7" });

  const external = await (await call(state, "/applications/external", "POST", { company: "Example Co", title: "Platform Intern", url: "https://example.com/apply" })).json();
  assert.match(external.id, /^visitor-app-/);
  assert.equal(external.external, true);
  const edited = await (await call(state, `/applications/${external.id}`, "PATCH", { company: "Edited Co", stage: "interview" })).json();
  assert.equal(edited.company, "Edited Co");
  assert.equal(edited.events.at(-1).to_stage, "interview");

  const discovered = await (await call(state, "/jobs/7/applications", "POST", {})).json();
  assert.equal((await call(state, `/applications/${discovered.id}`, "PATCH", { company: "Wrong" })).status, 422);
  assert.equal((await call(state, `/applications/${discovered.id}`, "PATCH", { stage: "closed" })).status, 422);
  assert.equal((await call(state, "/jobs/7/applications", "POST", {})).status, 200, "adding twice returns the existing record");

  assert.equal((await call(state, `/applications/${external.id}`, "DELETE")).status, 204);
  assert.equal((await (await call(state, "/applications")).json()).applications.length, 1);
});

test("guest resumes round-trip through the resume routes", async () => {
  const state = createVisitorState();
  await call(state, "/resume/profile", "PUT", { full_name: "Ada", email: "ada@example.test" });
  const resume = await (await call(state, "/resume/resumes", "POST", { name: "Browser resume" })).json();
  assert.equal((await (await call(state, "/resume/profile")).json()).full_name, "Ada");
  assert.equal((await (await call(state, `/resume/resumes/${resume.id}`)).json()).name, "Browser resume");
  await call(state, "/resume/variants", "PUT", { variants: [{ key: "bio", label: "Bio" }] });
  const entry = await (await call(state, "/resume/entries", "POST", { kind: "experience", org: "Lab" })).json();
  await call(state, `/resume/entries/${entry.id}/bullets`, "POST", { text: "Did a thing", audience: "bio" });
  assert.equal((await call(state, "/resume/variants", "PUT", { variants: [] })).status, 409, "a variant in use cannot be dropped");
});

test("signed out, private writes stay in the browser and leave the feed", async () => {
  requests.length = 0;
  await api.jobs.addToApplications(41, { id: 41, company: "Co", title: "Intern" });
  await api.jobs.setFeedback(42, { kind: "skip" }, { id: 42, company: "Co", title: "Other" });
  assert.equal((await api.applications.list()).applications.length, 1);
  assert.equal((await api.feedback.list()).hidden.length, 1);
  await api.jobs.list({ limit: 1 });
  assert.deepEqual(requests, ["GET /api/auth/me", "GET /api/jobs?limit=1&exclude_job_id=41&exclude_job_id=42"]);
});

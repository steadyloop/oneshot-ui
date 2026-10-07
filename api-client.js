(function (root) {
  "use strict";

  const ROUTES = Object.freeze({
    health: "/health",
    jobs: "/jobs",
    addToApplications: id => `/jobs/${encodeURIComponent(id)}/applications`,
    feedback: id => `/jobs/${encodeURIComponent(id)}/feedback`,
    feedbackList: "/feedback",
    applications: "/applications",
    application: id => `/applications/${encodeURIComponent(id)}`,
    externalApplications: "/applications/external",
    autoApplyPreview: id => `/applications/${encodeURIComponent(id)}/auto-apply/preview`,
    autoApply: id => `/applications/${encodeURIComponent(id)}/auto-apply`,
    resumes: "/resume/resumes",
    targetFromApplication: id => `/resume/jobs/from-application/${encodeURIComponent(id)}`,
    sourceCoverage: "/source-coverage",
    sourceBoards: "/source-coverage/boards",
  });

  const remoteTransport = (path, options = {}) => root.fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  async function transport(path, options = {}, privateData = false) {
    if (privateData && root.OneShotVisitorData && await root.OneShotVisitorData.isLocal()) {
      return root.OneShotVisitorData.request(path, options);
    }
    return remoteTransport(path, options);
  }

  const LOGIN_PATH = "/login/";

  // A 401 means the session expired or was never established. Send the browser
  // to the login page rather than surfacing "Not authenticated" as a toast that
  // disappears after three seconds and explains nothing.
  //
  // The returned promise never settles, on purpose: navigation is already under
  // way, and resolving or rejecting here would let the caller's catch block
  // paint an error over a page that is about to be replaced.
  function redirectToLogin() {
    if (root.location && root.location.pathname !== LOGIN_PATH) {
      root.location.assign(LOGIN_PATH);
    }
    return new Promise(() => {});
  }

  const errorMessage = (payload, status) => {
    const detail = payload?.detail;
    if (typeof detail === "string" && detail) return detail;
    if (Array.isArray(detail)) {
      const messages = detail.map(item => (typeof item === "string" ? item : item?.msg)).filter(Boolean);
      if (messages.length) return [...new Set(messages)].join(". ");
    }
    return `Request failed (${status})`;
  };

  async function request(path, options = {}, privateData = false) {
    const response = await transport(path, options, privateData);
    // Sample-data mode short-circuits before fetch, so it never yields a 401.
    if (response.status === 401) return redirectToLogin();
    if (response.status === 204) return null;
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(errorMessage(payload, response.status));
    return payload;
  }

  const query = values => {
    const params = new URLSearchParams();
    Object.entries(values || {}).forEach(([key, value]) => {
      if (value == null || value === "") return;
      (Array.isArray(value) ? value : [value]).forEach(item => params.append(key, item));
    });
    const encoded = params.toString();
    return encoded ? `?${encoded}` : "";
  };

  // Signed-out application tracking is browser-local. Signed-in tracking lives
  // in PostgreSQL, so it has no browser-side store.
  const applicationStore = async () => (
    root.OneShotVisitorData && await root.OneShotVisitorData.isLocal()
      ? root.OneShotVisitorData
      : null
  );

  root.OneShotAPI = {
    health: () => request(ROUTES.health),
    jobs: {
      list: async filters => {
        const values = { ...(filters || {}) };
        const tracker = await applicationStore();
        if (tracker) {
          // Tracked and hidden (skipped or mislabeled) postings both leave a
          // guest's feed; a signed-in feed is filtered in PostgreSQL instead.
          const ids = [...tracker.applicationJobIds(), ...(tracker.hiddenJobIds?.() || [])];
          const liveIds = [...new Set(ids.filter(id =>
            String(id).trim() !== "" && Number.isSafeInteger(Number(id))).map(String))];
          if (liveIds.length) values.exclude_job_id = liveIds;
        }
        return request(`${ROUTES.jobs}${query(values)}`);
      },
      addToApplications: async (id, job) => {
        // The browser-local tracker snapshots the public posting before its
        // private POST; a signed-in tracker reads the posting from PostgreSQL.
        const tracker = await applicationStore();
        tracker?.rememberJob(job);
        const now = new Date();
        const submitted_at = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        return request(ROUTES.addToApplications(id), { method: "POST", body: JSON.stringify({ submitted_at }) }, true);
      },
      // Skip or Mislabeled. Like an add, the guest store snapshots the posting
      // first so its Hidden list can still show it after it leaves the feed.
      setFeedback: async (id, body, job) => {
        const tracker = await applicationStore();
        tracker?.rememberJob(job);
        return request(ROUTES.feedback(id), { method: "PUT", body: JSON.stringify(body) }, true);
      },
      clearFeedback: id => request(ROUTES.feedback(id), { method: "DELETE" }, true),
    },
    feedback: {
      list: filters => request(`${ROUTES.feedbackList}${query(filters)}`, {}, true),
    },
    applications: {
      list: () => request(ROUTES.applications, {}, true),
      get: id => request(ROUTES.application(id), {}, true),
      createExternal: body => request(ROUTES.externalApplications, { method: "POST", body: JSON.stringify(body) }, true),
      update: (id, body) => request(ROUTES.application(id), { method: "PATCH", body: JSON.stringify(body) }, true),
      remove: id => request(ROUTES.application(id), { method: "DELETE" }, true),
      // Auto-apply is server-only: it needs the account's resume and a
      // browser on the server, so the guest (browser-local) tracker never
      // handles it and a signed-out reader is sent to the login page.
      autoApplyPreview: id => request(ROUTES.autoApplyPreview(id), { method: "POST" }),
      autoApply: (id, body) => request(ROUTES.autoApply(id), { method: "POST", body: JSON.stringify(body) }),
    },
    resumes: {
      list: () => request(ROUTES.resumes, {}, true),
      // Turn a queued application into a resume target. Idempotent server-side,
      // so a double click returns the existing target rather than forking it.
      targetFromApplication: id => request(
        ROUTES.targetFromApplication(id), { method: "POST" }, true,
      ),
    },
    sources: {
      coverage: () => request(ROUTES.sourceCoverage),
      boards: () => request(ROUTES.sourceBoards),
    },
  };

  if (typeof module !== "undefined" && module.exports) module.exports = { ROUTES, query, errorMessage };
})(typeof window !== "undefined" ? window : globalThis);

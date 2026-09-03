(function (root) {
  "use strict";

  const ROUTES = Object.freeze({
    health: "/health",
    jobs: "/jobs",
    addToApplications: id => `/jobs/${encodeURIComponent(id)}/applications`,
    applications: "/applications",
    application: id => `/applications/${encodeURIComponent(id)}`,
    externalApplications: "/applications/external",
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
    await root.OneShotSampleData?.ready?.();
    if (root.OneShotSampleData?.servesFixtures?.(path)) {
      return root.OneShotSampleData.request(path, options);
    }
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

  // Which browser-side store backs the tracker right now, or null when a real
  // session means the tracker lives on the server. Opportunities asks from a
  // page that is not itself a fixture page, so this cannot be a page question.
  const applicationStore = () => {
    if (root.OneShotSampleData?.servesFixtures?.(ROUTES.applications)) return root.OneShotSampleData;
    return null;
  };

  root.OneShotAPI = {
    health: () => request(ROUTES.health),
    jobs: {
      list: async filters => {
        const values = { ...(filters || {}) };
        await root.OneShotSampleData?.ready?.();
        // Whichever store answers /applications is the one that knows what is
        // already tracked, so the two always agree on what to hide here.
        const tracker = applicationStore();
        if (tracker) {
          // The fixture board uses readable ids such as `sample-quant`, while
          // the public Postgres jobs route accepts integer ids. Those fixture-
          // only values can never match a live row and used to make the whole
          // sidebar-count request fail validation on every signed-out page.
          const liveIds = tracker.applicationJobIds().filter(id =>
            String(id).trim() !== "" && Number.isSafeInteger(Number(id)));
          if (liveIds.length) values.exclude_job_id = liveIds;
        }
        return request(`${ROUTES.jobs}${query(values)}`);
      },
      addToApplications: async (id, job) => {
        await root.OneShotSampleData?.ready?.();
        // The tracker snapshots the posting from its own store, so the job has
        // to be there before the POST or it comes back 404.
        applicationStore()?.rememberJob(job);
        return request(ROUTES.addToApplications(id), { method: "POST" }, true);
      },
    },
    applications: {
      list: () => request(ROUTES.applications, {}, true),
      get: id => request(ROUTES.application(id), {}, true),
      createExternal: body => request(ROUTES.externalApplications, { method: "POST", body: JSON.stringify(body) }, true),
      update: (id, body) => request(ROUTES.application(id), { method: "PATCH", body: JSON.stringify(body) }, true),
      remove: id => request(ROUTES.application(id), { method: "DELETE" }, true),
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

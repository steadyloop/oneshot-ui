(function (root) {
  "use strict";

  // A per-page suffix is appended: "…enabled.application". The bare key is a
  // v1 leftover and is never read; clearing it is not worth a migration, since
  // an unread key changes nothing.
  const ENABLED_KEY = "oneshot.sample-data.enabled";
  const STATE_KEY = "oneshot.sample-data.state.v7";
  const VISITOR_STATE_KEY = "oneshot.visitor-data.state.v1";
  // Mirrors oneshot_ui/repository.py's DEFAULT_JOB_TYPES: the live API reads no
  // job_type filter as this classified scope, not as "everything" — job_type is
  // NULL when no vendor rule matched, and that pool is opt-in via the
  // "unclassified" token.
  const DEFAULT_JOB_TYPES = ["intern", "coop", "student", "new_grad", "research"];
  // The fixture mirrors the live read-time policy for the normalized cities it
  // contains. The full production metro map remains server-side.
  const SAMPLE_US_HUBS = new Set([
    "NY|New York City", "CA|San Francisco", "CA|San Diego", "TX|Austin",
    "MA|Boston", "MA|Cambridge", "DC|Washington", "IL|Chicago",
    "WA|Seattle",
  ]);
  const SAMPLE_US_SUBURBS = new Set(["CA|Berkeley"]);
  const SAMPLE_NORCAL = new Set(["CA|San Francisco", "CA|Berkeley"]);
  const SAMPLE_SOCAL = new Set(["CA|San Diego"]);
  const SAMPLE_SEATTLE = new Set(["WA|Seattle"]);
  // Mirrors repository.list_jobs: `unclassified` is not a stored value, it is
  // the NULL pool, so it is matched separately from the named types.
  const matchesType = (types, job) =>
    job.job_type === null || job.job_type === undefined
      ? types.includes("unclassified")
      : types.includes(job.job_type);
  const clone = value => JSON.parse(JSON.stringify(value));
  const isoIn = (days = 0, hours = 0) => new Date(Date.now() + days * 86400000 + hours * 3600000).toISOString();
  const dateIn = (days = 0) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const locationBucket = job => {
    const locations = Array.isArray(job?.locations) ? job.locations : [];
    if (!locations.length) return 4;
    const us = locations.filter(location => String(location?.country || "").toUpperCase() === "US");
    if (!us.length) return null;
    const keys = us.map(location => `${String(location.state || "").toUpperCase()}|${location.city || ""}`);
    if (keys.some(key => SAMPLE_US_HUBS.has(key))) return 1;
    if (keys.some(key => SAMPLE_US_SUBURBS.has(key))) return 2;
    return 3;
  };
  const proximityPriority = job => {
    const keys = (Array.isArray(job?.locations) ? job.locations : [])
      .filter(location => String(location?.country || "").toUpperCase() === "US")
      .map(location => `${String(location.state || "").toUpperCase()}|${location.city || ""}`);
    if (keys.some(key => SAMPLE_NORCAL.has(key))) return 1;
    if (keys.some(key => SAMPLE_SOCAL.has(key))) return 2;
    if (keys.some(key => SAMPLE_SEATTLE.has(key))) return 3;
    return 4;
  };
  const recencyDay = job => {
    const value = job?.posted_at || job?.first_seen_at;
    const date = new Date(value || "");
    if (Number.isNaN(date.getTime())) return "";
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(date).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };

  // Mirrors oneshot_ui/resume_workspace.py's TECH_VOCABULARY — kept in sync by hand.
  const TECH_VOCABULARY = [
    "Python", "C", "C++", "C#", "Java", "JavaScript", "TypeScript", "Go", "Rust",
    "Kotlin", "Swift", "Scala", "R", "Julia", "MATLAB", "SQL", "Bash", "OCaml",
    "Haskell", "React", "Vue", "Angular", "Node.js", "Django", "Flask", "FastAPI",
    "Spring", "NumPy", "pandas", "SciPy", "scikit-learn", "PyTorch", "TensorFlow",
    "JAX", "Keras", "XGBoost", "Spark", "Hadoop", "Kafka", "Airflow", "dbt",
    "PostgreSQL", "MySQL", "SQLite", "MongoDB", "Redis", "DuckDB", "Snowflake",
    "Docker", "Kubernetes", "Terraform", "AWS", "GCP", "Azure", "Linux", "Git",
    "CI/CD", "GraphQL", "gRPC", "REST", "WebSocket", "CUDA", "OpenMP", "MPI",
    "machine learning", "deep learning", "reinforcement learning", "NLP",
    "computer vision", "linear algebra", "probability", "statistics",
    "stochastic processes", "optimization", "numerical methods", "PDE",
    "Monte Carlo", "time series", "regression", "A/B testing", "data structures",
    "algorithms", "distributed systems", "operating systems", "networking",
    "concurrency", "functional programming", "object-oriented",
    // GPU / ML systems
    "Triton", "CUTLASS", "cuBLAS", "NCCL", "TensorRT", "vLLM", "SGLang", "PTX",
    "ROCm", "HIP", "MLIR", "LLVM", "XLA", "TVM", "Nsight", "GPU", "tensor cores",
    "kernel optimization", "quantization", "mixed precision", "FP8", "FP4", "GEMM",
    "attention", "transformers", "KV cache", "inference", "model serving",
    "batching", "roofline", "memory bandwidth", "SIMD", "vectorization", "HPC",
    "parallel computing", "RDMA", "InfiniBand", "profiling", "compilers",
    "computer architecture",
    // Low latency / trading systems
    "low latency", "lock-free", "kernel bypass", "DPDK", "io_uring", "NUMA",
    "cache optimization", "market data", "order book", "market microstructure",
    "FIX protocol", "ITCH", "floating point", "numerical linear algebra",
    "queueing theory",
    // Infrastructure
    "eBPF", "CMake", "Bazel", "gdb", "Raft", "consensus", "Prometheus", "Grafana",
  ];

  // The resume workspace ships no fixture persona: like the server-side guest
  // workspace, it starts empty rather than seeded with someone else's career
  // shape. The /resume/* routes below still run against this state — they are
  // the transport for the browser-local guest workspace.
  function createResumeState() {
    return {
      profile: { full_name: "", email: "", phone: "", location: "", links: [] },
      entries: [],
      skills: [],
      // User-defined resume variants, mirroring resume_workspace.variants.
      // Empty like a fresh server workspace: a guest declares their own.
      variants: [],
      // The guest workspace ships no seed list: TECH_VOCABULARY lives on the
      // server, and duplicating 150 terms here to drift out of sync is worse
      // than a guest starting with an empty `missing` column.
      vocabulary: [],
      targetJobs: [],
      resumes: [],
      nextEntryId: 1,
      nextBulletId: 1,
      nextSkillId: 1,
      nextTargetJobId: 1,
      nextResumeId: 1,
    };
  }

  // Opt-in content for the Resume page's interactive mockup. A fresh visitor
  // still starts blank; the page loads this workspace only after an explicit
  // click (or `?demo=1`). Once loaded, every edit goes through the same local
  // API transport as real guest content, so the mockup exercises actual CRUD,
  // selection, coverage, checks, and render requests rather than a second UI-
  // only data model.
  function createResumeDemoState() {
    const createdAt = new Date().toISOString();
    return {
      profile: {
        full_name: "Maya Chen",
        email: "maya.chen@example.com",
        phone: "+1 206 555 0148",
        location: "Seattle, WA",
        links: [
          { label: "Portfolio", url: "https://maya.example.com" },
          { label: "GitHub", url: "https://github.com/example" },
          { label: "LinkedIn", url: "https://linkedin.com/in/example" },
        ],
      },
      variants: [
        { key: "platform", label: "Platform engineering" },
        { key: "data", label: "Data & ML infrastructure" },
        { key: "product", label: "Product engineering" },
      ],
      vocabulary: [
        "Python", "Go", "TypeScript", "SQL", "React", "FastAPI", "PostgreSQL",
        "Redis", "Docker", "Kubernetes", "AWS", "Terraform", "distributed systems",
        "observability", "CI/CD", "machine learning", "data pipelines", "gRPC",
      ],
      entries: [
        {
          id: 1, kind: "education", org: "University of Washington",
          role: "B.S. Computer Science", location: "Seattle, WA",
          start_date: "Sep 2023", end_date: "Jun 2027", url: "",
          detail: "GPA: 3.86 / 4.00 · Dean’s List", position: 1, bullets: [],
        },
        {
          id: 2, kind: "experience", org: "Atlas Labs", role: "Software Engineering Intern",
          location: "San Francisco, CA", start_date: "Jun 2026", end_date: "Sep 2026",
          url: "", detail: "Developer Infrastructure", position: 1,
          bullets: [
            {
              id: 1, entry_id: 2, position: 1, audience: "platform",
              text: "Cut CI feedback time 42% by parallelizing integration suites across ephemeral Kubernetes runners.",
              tags: ["Kubernetes", "CI/CD", "Python"],
              defense_notes: "Measured median main-branch runtime over the six weeks before and after rollout.",
            },
            {
              id: 2, entry_id: 2, position: 2, audience: "all",
              text: "Built a Go service that processed 18M daily events with idempotent retries and end-to-end tracing.",
              tags: ["Go", "distributed systems", "observability"],
              defense_notes: "Owned the service from RFC through staged production rollout.",
            },
            {
              id: 3, entry_id: 2, position: 3, audience: "data",
              text: "Added data-quality checks that caught 31 schema regressions before they reached customer dashboards.",
              tags: ["SQL", "data pipelines"], defense_notes: "Checks ran at ingest and publish boundaries.",
            },
          ],
        },
        {
          id: 3, kind: "research", org: "UW Systems Lab", role: "Undergraduate Researcher",
          location: "Seattle, WA", start_date: "Jan 2026", end_date: "Present",
          url: "", detail: "Reliable model serving", position: 1,
          bullets: [
            {
              id: 4, entry_id: 3, position: 1, audience: "data",
              text: "Designed a failure-injection harness for GPU inference workers and reproduced 4 production failure modes.",
              tags: ["Python", "machine learning"], defense_notes: "Faults covered process, network, and memory pressure.",
            },
            {
              id: 5, entry_id: 3, position: 2, audience: "platform",
              text: "Presented reliability findings to a 12-person lab and translated results into an open-source benchmark plan.",
              tags: ["observability"], defense_notes: "The proposal defines recovery time and error-budget measures.",
            },
          ],
        },
        {
          id: 4, kind: "project", org: "Threadline", role: "Creator",
          location: "", start_date: "Oct 2025", end_date: "Present",
          url: "https://github.com/example/threadline", detail: "Go · PostgreSQL · React", position: 1,
          bullets: [
            {
              id: 6, entry_id: 4, position: 1, audience: "all",
              text: "Shipped a collaborative incident timeline used by 140+ students across 22 project teams.",
              tags: ["Go", "PostgreSQL", "React"], defense_notes: "Usage is counted from unique active workspaces.",
            },
            {
              id: 7, entry_id: 4, position: 2, audience: "product",
              text: "Interviewed 16 users and redesigned onboarding, increasing first-session completion from 58% to 81%.",
              tags: ["React"], defense_notes: "Compared equal two-week cohorts before and after the redesign.",
            },
          ],
        },
        {
          id: 5, kind: "leadership", org: "Husky Coding Club", role: "Workshop Lead",
          location: "Seattle, WA", start_date: "Sep 2025", end_date: "Present",
          url: "", detail: "", position: 1,
          bullets: [
            {
              id: 8, entry_id: 5, position: 1, audience: "all",
              text: "Led 8 backend workshops for 90+ students and mentored 6 first-time hackathon teams.",
              tags: ["Python"], defense_notes: "Workshop attendance is deduplicated per session.",
            },
          ],
        },
      ],
      skills: [
        { id: 1, category: "language", name: "Python", audience: "all" },
        { id: 2, category: "language", name: "Go", audience: "platform" },
        { id: 3, category: "language", name: "TypeScript", audience: "product" },
        { id: 4, category: "language", name: "SQL", audience: "all" },
        { id: 5, category: "framework", name: "FastAPI", audience: "data" },
        { id: 6, category: "framework", name: "React", audience: "product" },
        { id: 7, category: "framework", name: "PostgreSQL", audience: "all" },
        { id: 8, category: "framework", name: "Redis", audience: "platform" },
        { id: 9, category: "tool", name: "Docker", audience: "all" },
        { id: 10, category: "tool", name: "Kubernetes", audience: "platform" },
        { id: 11, category: "tool", name: "GitHub Actions", audience: "all" },
        { id: 12, category: "tool", name: "AWS", audience: "platform" },
        { id: 13, category: "math", name: "Distributed systems", audience: "platform" },
        { id: 14, category: "math", name: "Experiment design", audience: "data" },
      ],
      targetJobs: [
        {
          id: 1, company: "Northstar Robotics", title: "Platform Engineering Intern",
          url: "https://example.com/northstar-platform", date_posted: dateIn(-5),
          jd_text: "Build reliable Go and Python services on Kubernetes and AWS. Improve CI/CD, observability, PostgreSQL performance, and infrastructure managed with Terraform. Collaborate across product and robotics teams.",
          note: "Avery offered to refer after the resume is tailored.",
          job_application_id: null, created_at: createdAt,
        },
        {
          id: 2, company: "Lumen Data", title: "Data Infrastructure Co-op",
          url: "https://example.com/lumen-data", date_posted: dateIn(-12),
          jd_text: "Develop Python and SQL data pipelines, production FastAPI services, experiment tooling, and machine learning infrastructure. Experience with Docker, PostgreSQL, and data-quality systems preferred.",
          note: "Fall term; hybrid in Seattle.", job_application_id: null, created_at: createdAt,
        },
      ],
      resumes: [
        {
          id: 1, name: "Northstar · Platform", target_job_id: 1, variant: "platform",
          availability_line: "Available June–September 2027 · Seattle or San Francisco",
          education_note: "GPA: 3.86 / 4.00",
          selection: {
            entries: [
              { entry_id: 1, bullets: [] },
              { entry_id: 2, bullets: [{ bullet_id: 1, text_override: null }, { bullet_id: 2, text_override: null }] },
              { entry_id: 3, bullets: [{ bullet_id: 5, text_override: null }] },
              { entry_id: 4, bullets: [{ bullet_id: 6, text_override: null }] },
            ],
            skills: [1, 2, 4, 7, 9, 10, 12, 13],
          },
          created_at: createdAt, updated_at: createdAt,
        },
        {
          id: 2, name: "Lumen · Data infrastructure", target_job_id: 2, variant: "data",
          availability_line: "Available for Fall 2027 co-op · Seattle",
          education_note: "GPA: 3.86 / 4.00",
          selection: {
            entries: [
              { entry_id: 1, bullets: [] },
              { entry_id: 2, bullets: [{ bullet_id: 2, text_override: null }, { bullet_id: 3, text_override: null }] },
              { entry_id: 3, bullets: [{ bullet_id: 4, text_override: null }] },
              { entry_id: 4, bullets: [{ bullet_id: 6, text_override: null }] },
            ],
            skills: [1, 4, 5, 7, 9, 14],
          },
          created_at: createdAt, updated_at: createdAt,
        },
      ],
      nextEntryId: 6,
      nextBulletId: 9,
      nextSkillId: 15,
      nextTargetJobId: 3,
      nextResumeId: 3,
    };
  }

  function createVisitorState() {
    return {
      jobs: [],
      applications: [],
      nextApplicationId: 1,
      applicationIdPrefix: "visitor-app",
      resume: createResumeState(),
    };
  }

  function createState() {
    const jobs = [
      {
        id: "sample-research",
        company: "Northwind Robotics",
        title: "Student Researcher, Distributed Training",
        location: "Remote, United States",
        locations: [{ country: "US", state: null, city: null }],
        posted_at: isoIn(0, -2),
        first_seen_at: isoIn(0, -2),
        last_seen_at: isoIn(0, -1),
        status: "active",
        source: "greenhouse:northwind-robotics",
        source_url: "https://example.com/jobs/sample-research",
        summary: "Research sharded optimizer state and fault-tolerant training for multi-node machine-learning workloads. You will prototype ideas, evaluate them on production-scale clusters, and present results to the research systems team.",
        job_type: "research",
        remote: "yes",
        attributes: { version: 1, term: "Spring 2027", skills: ["JAX", "Python", "Ray"], degree: ["cs", "mathematics"], deadline_at: dateIn(18) },
        apply_url: "https://example.com/apply/sample-research",
      },
      {
        id: "sample-quant",
        company: "Vantage Quant",
        title: "Summer Quant Systems Intern",
        location: "New York, NY",
        locations: [{ country: "US", state: "NY", city: "New York City" }],
        posted_at: isoIn(-1),
        first_seen_at: isoIn(-1),
        last_seen_at: isoIn(0, -3),
        status: "active",
        source: "lever:vantage-quant",
        source_url: "https://example.com/jobs/sample-quant",
        summary: "Build research infrastructure used to test and deploy systematic trading strategies. Projects include low-latency data processing, simulation tooling, and production monitoring.",
        job_type: "intern",
        remote: "unknown",
        attributes: { version: 1, term: "Summer 2027", skills: ["Python", "C++", "Linux", "Microsoft Excel", "FIX Protocol"], degree: ["mathematics"] },
        apply_url: "https://example.com/apply/sample-quant",
      },
      {
        id: "sample-software",
        company: "Halcyon Systems",
        title: "Software Engineering Intern",
        location: "San Diego, CA",
        locations: [{ country: "US", state: "CA", city: "San Diego" }],
        posted_at: isoIn(-2),
        first_seen_at: isoIn(-2),
        last_seen_at: isoIn(0, -4),
        status: "active",
        source: "ashby:halcyon-systems",
        source_url: "https://example.com/jobs/sample-software",
        summary: "Join the platform team building services for fleet operations. You will own a scoped backend project, write production code, and work with engineers across infrastructure and product.",
        job_type: "intern",
        remote: "hybrid",
        attributes: { version: 1, skills: ["Go", "Kubernetes", "PostgreSQL"], degree: ["cs"] },
        apply_url: "https://example.com/apply/sample-software",
      },
      {
        id: "sample-embedded",
        company: "Cobalt Foundry",
        title: "Fall Embedded Software Co-op",
        location: "Austin, TX",
        locations: [{ country: "US", state: "TX", city: "Austin" }],
        posted_at: isoIn(-3),
        first_seen_at: isoIn(-3),
        last_seen_at: isoIn(-1),
        status: "active",
        source: "workday:cobalt-foundry",
        source_url: "https://example.com/jobs/sample-embedded",
        summary: "Develop firmware and systems software for industrial control hardware. The role includes driver development, hardware bring-up, automated testing, and debugging real-time systems.",
        job_type: "coop",
        remote: "unknown",
        attributes: { version: 1, term: "Fall 2027", skills: ["C++", "FreeRTOS", "Linux", "FPGA"], degree: ["cs"] },
        apply_url: "https://example.com/apply/sample-embedded",
      },
      {
        id: "sample-platform",
        company: "Arbor Signal",
        title: "Backend Platform Intern",
        location: "Boston, MA",
        locations: [{ country: "US", state: "MA", city: "Boston" }],
        posted_at: isoIn(-4),
        first_seen_at: isoIn(-4),
        last_seen_at: isoIn(0, -5),
        status: "active",
        source: "smartrecruiters:arbor-signal",
        source_url: "https://example.com/jobs/sample-platform",
        summary: "Build internal APIs and data services for a growing observability platform. You will ship a production project with the infrastructure team.",
        job_type: "intern",
        remote: "hybrid",
        attributes: { version: 1, term: "Summer 2027", skills: ["TypeScript", "PostgreSQL", "AWS", "Docker", "JSON"] },
        apply_url: "https://example.com/apply/sample-platform",
      },
      {
        id: "sample-ml-research",
        company: "Kepler Bio",
        title: "Machine Learning Research Intern",
        location: "Cambridge, MA",
        locations: [{ country: "US", state: "MA", city: "Cambridge" }],
        posted_at: isoIn(-5),
        first_seen_at: isoIn(-5),
        last_seen_at: isoIn(0, -6),
        status: "active",
        source: "icims:kepler-bio",
        source_url: "https://example.com/jobs/sample-ml-research",
        summary: "Develop evaluation methods for biological foundation models and collaborate with research scientists on reproducible experiments.",
        job_type: "intern",
        remote: "unknown",
        attributes: { version: 1, term: "Summer 2027", skills: ["Python", "PyTorch", "Hugging Face Transformers", "Model evaluation", "Artificial intelligence"], degree: ["biotech"] },
        apply_url: "https://example.com/apply/sample-ml-research",
      },
      {
        id: "sample-graduate-research",
        company: "Pacific Materials Lab",
        title: "Graduate Research Appointment",
        location: "Berkeley, CA",
        locations: [{ country: "US", state: "CA", city: "Berkeley" }],
        posted_at: isoIn(-6),
        first_seen_at: isoIn(-6),
        last_seen_at: isoIn(0, -7),
        status: "active",
        source: "greenhouse:pacific-materials",
        source_url: "https://example.com/jobs/sample-graduate-research",
        summary: "Investigate efficient simulation methods with the computational materials group and publish reproducible results.",
        job_type: "research",
        remote: "hybrid",
        attributes: { version: 1, skills: ["Python", "JAX"] },
        apply_url: "https://example.com/apply/sample-graduate-research",
      },
      {
        id: "sample-fellowship",
        company: "Civic AI Institute",
        title: "AI Policy Fellowship",
        location: "Washington, DC",
        locations: [{ country: "US", state: "DC", city: "Washington" }],
        posted_at: isoIn(-7),
        first_seen_at: isoIn(-7),
        last_seen_at: isoIn(-1),
        status: "active",
        source: "lever:civic-ai",
        source_url: "https://example.com/jobs/sample-fellowship",
        summary: "Join a twelve-week cohort studying practical governance approaches for deployed AI systems.",
        job_type: "student",
        remote: "hybrid",
        attributes: { version: 1, term: "Summer 2027", skills: ["Policy research", "Python"] },
        apply_url: "https://example.com/apply/sample-fellowship",
      },
      {
        id: "sample-apprentice",
        company: "Forge Automation",
        title: "Software Engineering Apprentice",
        location: "Chicago, IL",
        locations: [{ country: "US", state: "IL", city: "Chicago" }],
        posted_at: isoIn(-8),
        first_seen_at: isoIn(-8),
        last_seen_at: isoIn(-1),
        status: "active",
        source: "workday:forge-automation",
        source_url: "https://example.com/jobs/sample-apprentice",
        summary: "Learn production software development through mentored rotations across platform and automation teams.",
        job_type: "student",
        remote: "unknown",
        attributes: { version: 1, skills: ["Java", "SQL"] },
        apply_url: "https://example.com/apply/sample-apprentice",
      },
      {
        id: "sample-new-grad",
        company: "Atlas Compute",
        title: "Software Engineer, New Grad",
        location: "San Francisco, CA",
        locations: [{ country: "US", state: "CA", city: "San Francisco" }],
        posted_at: isoIn(-9),
        first_seen_at: isoIn(-9),
        last_seen_at: isoIn(-2),
        status: "active",
        source: "ashby:atlas-compute",
        source_url: "https://example.com/jobs/sample-new-grad",
        summary: "Start in a structured engineering cohort with rotations through distributed systems and developer infrastructure.",
        job_type: "new_grad",
        remote: "unknown",
        attributes: { version: 1, skills: ["Go", "Linux"] },
        apply_url: "https://example.com/apply/sample-new-grad",
      },
      {
        id: "sample-working-student",
        company: "Helix Cloud",
        title: "Working Student, Developer Infrastructure",
        location: "Berlin, Germany",
        locations: [{ country: "DE", state: "16", city: "Berlin" }],
        posted_at: isoIn(-10),
        first_seen_at: isoIn(-10),
        last_seen_at: isoIn(-2),
        status: "active",
        source: "smartrecruiters:helix-cloud",
        source_url: "https://example.com/jobs/sample-working-student",
        summary: "Support build tooling and internal developer workflows alongside your university studies.",
        job_type: "student",
        remote: "hybrid",
        attributes: { version: 1, skills: ["TypeScript", "CI/CD"] },
        apply_url: "https://example.com/apply/sample-working-student",
      },
      {
        // Deliberately outside DEFAULT_OPPORTUNITY_TYPES, mirroring the live
        // pool of postings the classifier has not selected for the board.
        id: "sample-unclassified",
        company: "Bellwether Analytics",
        title: "Senior Data Platform Manager",
        location: "New York, NY",
        locations: [{ country: "US", state: "NY", city: "New York City" }],
        posted_at: isoIn(-11),
        first_seen_at: isoIn(-11),
        last_seen_at: isoIn(0, -12),
        status: "active",
        source: "greenhouse:bellwether-analytics",
        source_url: "https://example.com/jobs/sample-unclassified",
        summary: null,
        job_type: null,
        remote: "hybrid",
        attributes: { version: 1, skills: ["SQL", "Apache Spark"] },
        apply_url: "https://example.com/apply/sample-unclassified",
      },
    ];

    const jobSkillDetails = {
      "Apache Spark": { id: "apache-spark", category: "platform" },
      "Artificial intelligence": { id: "artificial-intelligence", name: "Artificial intelligence (AI)", label: "AI", category: "concept" },
      AWS: { id: "amazon-web-services", name: "Amazon Web Services (AWS)", label: "AWS", category: "platform" },
      "C++": { id: "cpp", category: "language" },
      "CI/CD": { id: "ci-cd", category: "method" },
      Docker: { id: "docker", category: "tool" },
      FPGA: { id: "fpga", category: "hardware" },
      "FIX Protocol": { id: "fix-protocol", category: "protocol" },
      FreeRTOS: { id: "freertos", category: "platform" },
      Go: { id: "go", category: "language" },
      "Hugging Face Transformers": { id: "hugging-face-transformers", label: "HF Transformers", category: "library" },
      Java: { id: "java", category: "language" },
      JAX: { id: "jax", category: "library" },
      JSON: { id: "json", category: "format" },
      Kubernetes: { id: "kubernetes", category: "platform" },
      Linux: { id: "linux", category: "platform" },
      "Microsoft Excel": { id: "microsoft-excel", label: "Excel", category: "tool" },
      "Model evaluation": { id: "model-evaluation", category: "method" },
      PostgreSQL: { id: "postgresql", category: "datastore" },
      Python: { id: "python", category: "language" },
      PyTorch: { id: "pytorch", category: "library" },
      Ray: { id: "ray", category: "framework" },
      SQL: { id: "sql", category: "language" },
      TypeScript: { id: "typescript", category: "language" },
    };

    for (const job of jobs) {
      job.other_sources = [];
      job.skills = (job.attributes.skills || []).map(name => ({
        id: jobSkillDetails[name]?.id || String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
        ...jobSkillDetails[name],
        name: jobSkillDetails[name]?.name || name,
        label: jobSkillDetails[name]?.label || name,
        category: jobSkillDetails[name]?.category || null,
      }));
    }

    const applications = [
      {
        id: "sample-app-considering",
        job_id: "sample-quant",
        company: "Vantage Quant",
        title: "Summer Quant Systems Intern",
        stage: "considering",
        closed_reason: null,
        next_action: "Review the role and decide whether to apply",
        next_due_at: isoIn(4),
        external: false,
        submitted_at: null,
        apply_url_snapshot: "https://example.com/apply/sample-quant",
        updated_at: isoIn(-1),
        note: "",
        events: [{ occurred_at: isoIn(-1), event_type: "considering", to_stage: "considering", note: "Added from Discover." }],
      },
      {
        id: "sample-app-assessment",
        job_id: "sample-research",
        company: "Northwind Robotics",
        title: "Student Researcher, Distributed Training",
        stage: "assessment",
        closed_reason: null,
        next_action: "Complete the systems exercise",
        next_due_at: isoIn(1),
        external: false,
        submitted_at: isoIn(-6),
        apply_url_snapshot: "https://example.com/apply/sample-research",
        updated_at: isoIn(-1),
        note: "",
        events: [
          { occurred_at: isoIn(-6), event_type: "applied", to_stage: "applied", note: "Application submitted." },
          { occurred_at: isoIn(-1), event_type: "assessment", to_stage: "assessment", note: "Systems exercise received." },
        ],
      },
      {
        id: "sample-app-interview",
        company: "Meridian Labs",
        title: "Robotics Software Co-op",
        stage: "interview",
        closed_reason: null,
        next_action: "Prepare architecture examples",
        next_due_at: isoIn(7),
        external: true,
        submitted_at: isoIn(-10),
        apply_url_snapshot: "https://example.com/apply/meridian",
        updated_at: isoIn(-2),
        note: "Technical interview scheduled with the platform team.",
        events: [{ occurred_at: isoIn(-2), event_type: "interview", to_stage: "interview", note: "Technical interview scheduled." }],
      },
      {
        id: "sample-app-offer",
        company: "Atlas Grid",
        title: "Site Reliability Intern",
        stage: "offer",
        closed_reason: null,
        next_action: "Review the written offer",
        next_due_at: isoIn(10),
        external: true,
        submitted_at: isoIn(-18),
        apply_url_snapshot: "https://example.com/apply/atlas",
        updated_at: isoIn(-1),
        note: "Compare the start date and relocation package.",
        events: [{ occurred_at: isoIn(-1), event_type: "offer", to_stage: "offer", note: "Written offer received." }],
      },
    ];

    return { jobs, applications, nextApplicationId: 5, resume: createResumeState() };
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

  function applicationFromJob(state, job) {
    return {
      id: `${state.applicationIdPrefix || "sample-app"}-${state.nextApplicationId++}`,
      job_id: job.id,
      company: job.company,
      title: job.title,
      location: job.location,
      stage: "considering",
      closed_reason: null,
      next_action: null,
      next_due_at: null,
      external: false,
      submitted_at: null,
      apply_url_snapshot: job.apply_url,
      resume_variant: null,
      updated_at: new Date().toISOString(),
      note: "",
      events: [{ occurred_at: new Date().toISOString(), event_type: "stage_changed", to_stage: "considering", note: null }],
    };
  }

  async function handle(input, options = {}, state = createState()) {
    const url = new URL(typeof input === "string" ? input : input.url, "http://oneshot.local");
    const method = String(options.method || "GET").toUpperCase();
    const path = url.pathname.replace(/^\/api(?=\/)/, "");

    if (method === "GET" && path === "/health") {
      return jsonResponse({ ok: true });
    }
    if (method === "GET" && path === "/jobs") {
      const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
      const requested = url.searchParams.getAll("job_type");
      const types = requested.length ? requested : DEFAULT_JOB_TYPES;
      const degreeFields = url.searchParams.getAll("degree_field");
      const excludedJobIds = new Set(url.searchParams.getAll("exclude_job_id"));
      const applicationJobIds = new Set(state.applications.map(application => application.job_id).filter(Boolean));
      const available = state.jobs.filter(job => {
        if (locationBucket(job) === null) return false;
        const searchable = `${job.title} ${job.company} ${(job.skills || []).map(skill => skill.name).join(" ")}`.toLowerCase();
        const postingFields = job.attributes.degree || [];
        const matchesDegree = !degreeFields.length || degreeFields.some(field =>
          field === "bioengineering"
            ? ["biotech", "med_device", "clinical_affairs"].some(value => postingFields.includes(value))
            : postingFields.includes(field));
        return !applicationJobIds.has(job.id) && !excludedJobIds.has(String(job.id)) && (!q || searchable.includes(q)) && matchesDegree;
      });
      const job_type_counts = Object.fromEntries(DEFAULT_JOB_TYPES.map(type => [
        type, available.filter(job => job.job_type === type).length,
      ]));
      const filtered = available.filter(job => matchesType(types, job));
      const sort = url.searchParams.get("sort") || "fresh";
      filtered.sort((a, b) => sort === "company"
        ? a.company.localeCompare(b.company)
        : sort === "title"
          ? a.title.localeCompare(b.title)
          : recencyDay(b).localeCompare(recencyDay(a))
            || locationBucket(a) - locationBucket(b)
            || proximityPriority(a) - proximityPriority(b)
            || String(b.posted_at || b.first_seen_at || "").localeCompare(String(a.posted_at || a.first_seen_at || "")));
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 100));
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const page = filtered.slice(offset, offset + limit);
      return jsonResponse({ jobs: clone(page), total: filtered.length, job_type_counts, limit, offset });
    }

    const addMatch = path.match(/^\/jobs\/([^/]+)\/applications$/);
    if (method === "POST" && addMatch) {
      const job = findJob(state, decodeURIComponent(addMatch[1]));
      if (!job) return jsonResponse({ detail: "Job not found" }, 404);
      const existing = state.applications.find(application => application.job_id === job.id);
      if (existing) return jsonResponse({ ...clone(existing), already_exists: true });
      const application = applicationFromJob(state, job);
      state.applications.unshift(application);
      return jsonResponse(clone(application), 201);
    }

    if (method === "POST" && path === "/applications/external") {
      const body = parseBody(options);
      const application = {
        id: `${state.applicationIdPrefix || "sample-app"}-${state.nextApplicationId++}`,
        company: body.company,
        title: body.title,
        stage: "considering",
        closed_reason: null,
        next_action: null,
        next_due_at: null,
        external: true,
        submitted_at: null,
        apply_url_snapshot: body.url,
        resume_variant: null,
        updated_at: new Date().toISOString(),
        location: body.location || "",
        note: body.note || "",
        events: [{ occurred_at: new Date().toISOString(), event_type: "stage_changed", to_stage: "considering", note: body.note || null }],
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
      const body = parseBody(options),previousStage=application.stage;
      if (application.external) {
        if (typeof body.company === "string" && body.company.trim()) application.company = body.company.trim();
        if (typeof body.title === "string" && body.title.trim()) application.title = body.title.trim();
        if (typeof body.location === "string") application.location = body.location.trim();
        if (typeof body.apply_url_snapshot === "string") application.apply_url_snapshot = body.apply_url_snapshot.trim();
      }
      if (body.resume_variant !== undefined) application.resume_variant = String(body.resume_variant || "").trim() || null;
      if (body.stage) application.stage = body.stage;
      if (body.closed_reason !== undefined) application.closed_reason = body.closed_reason;
      if (application.stage !== "closed") application.closed_reason = null;
      if (body.submitted_at !== undefined) application.submitted_at = body.submitted_at;
      if (body.next_action !== undefined) application.next_action = body.next_action;
      if (body.next_due_at !== undefined) application.next_due_at = body.next_due_at;
      if (body.note !== undefined) application.note = body.note;
      application.updated_at = new Date().toISOString();
      if (application.stage !== previousStage) application.events.push({ occurred_at: application.updated_at, event_type: "stage_changed", to_stage: application.stage, note: "" });
      return jsonResponse(clone(application));
    }
    if (method === "DELETE" && applicationMatch) {
      const index = state.applications.findIndex(application => String(application.id) === String(decodeURIComponent(applicationMatch[1])));
      if (index < 0) return jsonResponse({ detail: "Application not found" }, 404);
      state.applications.splice(index, 1);
      return new Response(null, { status: 204 });
    }

    if (method === "GET" && path === "/source-coverage") {
      return jsonResponse({
        sources: [
          { source: "greenhouse", type: "ATS", board_count: 1, coverage: 1, last_poll_at: isoIn(0, -1), health: "Healthy", added_today: 1 },
          { source: "lever", type: "ATS", board_count: 2, coverage: 2, last_poll_at: isoIn(0, -3), health: "Healthy", added_today: 1 },
          { source: "smartrecruiters", type: "ATS", board_count: 1, coverage: 1, last_poll_at: isoIn(-1), health: "Needs attention", added_today: 0 },
        ],
        source_count: 3,
        total_coverage: 4,
        total_added_today: 2,
      });
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

    if (method === "GET" && path === "/resume/vocabulary") {
      return jsonResponse({ terms: (resumeState.vocabulary || []).slice() });
    }
    if (method === "PUT" && path === "/resume/vocabulary") {
      const seen = new Set();
      resumeState.vocabulary = (parseBody(options).terms || [])
        .map(term => String(term).trim())
        .filter(term => term && !seen.has(term.toLowerCase()) && seen.add(term.toLowerCase()));
      return jsonResponse({ terms: resumeState.vocabulary.slice() });
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
    if (method === "DELETE" && skillMatch) {
      const index = resumeState.skills.findIndex(row => String(row.id) === skillMatch[1]);
      if (index < 0) return jsonResponse({ detail: "Skill not found" }, 404);
      resumeState.skills.splice(index, 1);
      return new Response(null, { status: 204 });
    }

    if (method === "GET" && path === "/resume/jobs") {
      return jsonResponse({ jobs: clone(resumeState.targetJobs) });
    }
    if (method === "POST" && path === "/resume/jobs") {
      const body = parseBody(options);
      const job = {
        id: resumeState.nextTargetJobId++, company: body.company, title: body.title,
        url: body.url || "", jd_text: body.jd_text || "", date_posted: body.date_posted || "",
        note: body.note || "", job_application_id: body.job_application_id ?? null,
        created_at: new Date().toISOString(),
      };
      resumeState.targetJobs.unshift(job);
      return jsonResponse(clone(job), 201);
    }
    const targetJobMatch = path.match(/^\/resume\/jobs\/(\d+)$/);
    if (method === "PATCH" && targetJobMatch) {
      const job = resumeState.targetJobs.find(row => String(row.id) === targetJobMatch[1]);
      if (!job) return jsonResponse({ detail: "Target job not found" }, 404);
      const body = parseBody(options);
      ["company", "title", "url", "jd_text", "date_posted", "note"].forEach(key => {
        if (body[key] !== undefined) job[key] = body[key];
      });
      return jsonResponse(clone(job));
    }
    if (method === "DELETE" && targetJobMatch) {
      const index = resumeState.targetJobs.findIndex(row => String(row.id) === targetJobMatch[1]);
      if (index < 0) return jsonResponse({ detail: "Target job not found" }, 404);
      const deletedId = resumeState.targetJobs[index].id;
      resumeState.targetJobs.splice(index, 1);
      resumeState.resumes.forEach(record => {
        if (record.target_job_id === deletedId) record.target_job_id = null;
      });
      return new Response(null, { status: 204 });
    }

    const coverageMatch = path.match(/^\/resume\/jobs\/(\d+)\/coverage$/);
    if (method === "GET" && coverageMatch) {
      const job = resumeState.targetJobs.find(row => String(row.id) === coverageMatch[1]);
      if (!job) return jsonResponse({ detail: "Target job not found" }, 404);
      const jd = (job.jd_text || "").toLowerCase();
      // Same boundary set as resume_workspace.compute_coverage: `+#&` are part
      // of a word (so "C" misses "C++", "C#" and "R&D"), `.` is not (so "Go."
      // still matches Go). Kept in sync by hand, like TECH_VOCABULARY above.
      const mentions = name => new RegExp(`(?<![a-z0-9+#&])${escapeRegex(name.toLowerCase())}(?![a-z0-9+#&])`).test(jd);
      const inJd = resumeState.skills.filter(skill => skill.name && mentions(skill.name));
      const resumeIdParam = url.searchParams.get("resume_id");
      let shownIds = new Set();
      if (resumeIdParam) {
        const linkedResume = resumeState.resumes.find(row => String(row.id) === resumeIdParam);
        if (linkedResume) shownIds = new Set(linkedResume.selection.skills || []);
      }
      const bankNames = new Set(resumeState.skills.map(skill => skill.name.toLowerCase()));
      const missing = TECH_VOCABULARY.filter(term => !bankNames.has(term.toLowerCase()) && mentions(term)).sort();
      return jsonResponse({
        job_id: job.id,
        matched: clone(inJd.filter(skill => shownIds.has(skill.id))),
        have_not_shown: clone(inJd.filter(skill => !shownIds.has(skill.id))),
        missing,
      });
    }

    if (method === "GET" && path === "/resume/resumes") {
      return jsonResponse({ resumes: clone(resumeState.resumes), typst_available: false });
    }
    if (method === "POST" && path === "/resume/resumes") {
      const body = parseBody(options);
      const resumeRecord = {
        id: resumeState.nextResumeId++, name: body.name, target_job_id: body.target_job_id ?? null,
        variant: body.variant || "swe", availability_line: body.availability_line || "",
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
      ["name", "target_job_id", "variant", "availability_line", "education_note", "selection"].forEach(key => {
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

    const checkMatch = path.match(/^\/resume\/resumes\/(\d+)\/check$/);
    if (method === "GET" && checkMatch) {
      const record = resumeState.resumes.find(row => String(row.id) === checkMatch[1]);
      if (!record) return jsonResponse({ detail: "Resume not found" }, 404);
      const bulletById = new Map(resumeState.entries.flatMap(entry => entry.bullets).map(bullet => [bullet.id, bullet]));
      const selected = (record.selection?.entries || []).flatMap(entry =>
        (entry.bullets || []).map(pick => pick.text_override || bulletById.get(pick.bullet_id)?.text).filter(Boolean));
      const problems = [];
      if (!resumeState.profile.email) problems.push({ level: "error", message: "Profile has no email address." });
      if (!record.availability_line) problems.push({ level: "warn", message: "No availability line (e.g. 'Available for Spring 2027 co-op') — recruiters filter on legible availability." });
      if (!selected.length) problems.push({ level: "error", message: "No bullets selected." });
      selected.forEach(text => {
        if (!/\d/.test(text)) problems.push({ level: "info", message: `No metric in: "${text.slice(0, 70)}…" — quantify if honestly possible.` });
      });
      return jsonResponse({
        problems,
        page_count: null,
        typst_available: false,
        compile_error: "Browser-local resumes require sign-in for Typst export.",
      });
    }

    if (path.startsWith("/resume/resumes/") && (path.endsWith("/source") || path.endsWith("/pdf"))) {
      return jsonResponse({ detail: "Sign in to export this browser-local resume." }, 501);
    }

    return jsonResponse({ detail: `No sample response for ${method} ${path}` }, 404);
  }

  let state;
  let visitorState;
  let accountPromise;
  let readyPromise;
  let resolvedMode = null;
  let signedOut = null;
  const storageAvailable = () => Boolean(root.localStorage);

  // Which page you are on decides whether fixture mode can resolve at all.
  // Only Applications exposes it: Opportunities remains a live job feed,
  // Feed Status remains a live report on the harvest itself, and Resume
  // serves guests from their own empty browser-local workspace instead of a
  // fixture persona.
  //
  // Scoping by pathname rather than by an argument is what keeps every caller
  // unchanged — a page only ever requests its own data, so "is sample mode on"
  // and "is sample mode on for this page" are the same question at every call
  // site (api-client.js's transport).
  const PAGES = Object.freeze({
    "/application/": "application",
  });

  // Every shell answers on two URLs — the canonical /application/ the nav links
  // to, and /static/application/index.html from the StaticFiles mount. Both are
  // the same page, so both have to resolve to the same switch, or the mount
  // path would show a switch that silently stores nothing.
  const scopeOf = path => PAGES[String(path || "").replace(/^\/static/, "").replace(/index\.html$/, "")];
  const enabledKey = () => {
    const scope = scopeOf(root.location?.pathname);
    return scope ? `${ENABLED_KEY}.${scope}` : null;
  };

  // Nothing of your own is stored yet: no applications. An empty board is what
  // makes fixtures the better first screen, and a non-empty one is what forbids
  // them -- real work must never end up hidden behind a mode the visitor never
  // chose. Only the applications are consulted: the guest resume lives on a
  // page with no fixture mode, so it says nothing about the board.
  // Applications carries no switch: signed out it is the fixtures, signed in it
  // is the account, and there is no third state to offer. The visitor
  // workspace still backs the resume studio, which is browser-local by design.
  //
  // This cannot be answered from storage alone -- it depends on whether you are
  // signed in, and that is a request. Every transport awaits this once before
  // its first call, so `isEnabled` below stays synchronous for the callers that
  // cannot await, and no page paints fixtures it is about to swap out.
  const ready = () => {
    if (!readyPromise) {
      readyPromise = (async () => {
        // A failed identity check means the API is unreachable, in which case
        // the fixtures are the only thing on the page that can render at all.
        signedOut = await isLocal().catch(() => true);
        // Tracked separately from `signedOut`: a page with no fixture scope --
        // Opportunities -- is signed out too, and its job feed must stay live.
        resolvedMode = signedOut && Boolean(enabledKey());
        return resolvedMode;
      })();
    }
    return readyPromise;
  };

  // Applications are fixtures for every signed-out visitor, whichever page is
  // asking. Opportunities is not a fixture page -- its job feed stays live --
  // but "Add to Applications" there has to land in the store the tracker will
  // read from on the next click, or the record silently vanishes.
  const APPLICATION_ROUTE = /^\/applications(\/|$)|^\/jobs\/[^/]+\/applications$/;
  const servesFixtures = path => isEnabled() || (signedOut === true && APPLICATION_ROUTE.test(String(path || "")));

  const isEnabled = () => resolvedMode === true;

  const save = () => { if (storageAvailable()) root.localStorage.setItem(STATE_KEY, JSON.stringify(state)); };
  const loadState = () => {
    if (state) return state;
    try { state = JSON.parse(root.localStorage.getItem(STATE_KEY)) || createState(); }
    catch (_) { state = createState(); }
    return state;
  };
  // Called when the account chip resolves to a real session: sample data is a
  // guest affordance, and a flag left on from browsing signed out would show a
  // signed-in user fixtures in place of their own workspace, with no visible
  // switch to explain it. Returns whether *this* page was the one affected, so
  // the caller can reload only when the page in front of you is now wrong.
  const disableAll = () => {
    if (!storageAvailable()) return false;
    const wasOn = isEnabled();
    Object.values(PAGES).forEach(scope => root.localStorage.removeItem(`${ENABLED_KEY}.${scope}`));
    return wasOn;
  };
  // The fixture store is the signed-out tracker, so it needs the same two
  // helpers the visitor store has: remember a real posting well enough to track
  // it, and report what is already tracked so Opportunities can hide it.
  const rememberSampleJob = job => {
    if (!job) return;
    // A live posting joins the fixture feed, which reads `attributes.degree`
    // and `locations` without guarding. Filling them in here keeps the nav
    // count -- the one caller that lists jobs from this store -- from throwing
    // on a row the fixtures did not author.
    const row = clone(job);
    row.attributes = row.attributes || {};
    row.locations = row.locations || (row.location ? [row.location] : []);
    row.skills = row.skills || [];
    const jobs = loadState().jobs;
    const index = jobs.findIndex(item => String(item.id) === String(row.id));
    if (index >= 0) jobs[index] = row;
    else jobs.push(row);
  };
  const sampleApplicationJobIds = () => loadState().applications
    .map(application => application.job_id)
    .filter(id => id != null);

  const request = async (path, options = {}) => {
    const result = await handle(path, options, loadState());
    if (String(options.method || "GET").toUpperCase() !== "GET") save();
    return result;
  };

  const loadVisitorState = () => {
    if (visitorState) return visitorState;
    try { visitorState = JSON.parse(root.localStorage.getItem(VISITOR_STATE_KEY)) || createVisitorState(); }
    catch (_) { visitorState = createVisitorState(); }
    return visitorState;
  };
  const saveVisitorState = () => {
    if (!storageAvailable()) return;
    try { root.localStorage.setItem(VISITOR_STATE_KEY, JSON.stringify(visitorState)); }
    catch (_) { /* The in-memory workspace still works for this page load. */ }
  };
  const visitorRequest = async (path, options = {}) => {
    const result = await handle(path, options, loadVisitorState());
    if (String(options.method || "GET").toUpperCase() !== "GET") saveVisitorState();
    return result;
  };
  const loadResumeDemo = () => {
    const visitor = loadVisitorState();
    visitor.resume = createResumeDemoState();
    saveVisitorState();
    return clone(visitor.resume);
  };
  const account = async () => {
    if (!accountPromise) {
      accountPromise = (async () => {
        const response = await root.fetch("/api/auth/me");
        if (response.status === 401) return null;
        if (!response.ok) throw new Error(`Identity check failed (${response.status})`);
        return response.json();
      })();
    }
    return accountPromise;
  };
  const isLocal = async () => (await account()) === null;
  const rememberJob = job => {
    if (!job) return;
    const visitor = loadVisitorState();
    const index = visitor.jobs.findIndex(row => String(row.id) === String(job.id));
    if (index >= 0) visitor.jobs[index] = clone(job);
    else visitor.jobs.push(clone(job));
  };
  const applicationJobIds = () => loadVisitorState().applications
    .map(application => application.job_id)
    .filter(id => id != null);
  if (typeof module !== "undefined" && module.exports) module.exports = {
    createState, createVisitorState, createResumeDemoState, handle, PAGES,
  };
  root.OneShotSampleData = {
    request, ready, isEnabled, servesFixtures, disableAll,
    rememberJob: rememberSampleJob,
    applicationJobIds: sampleApplicationJobIds,
  };
  root.OneShotVisitorData = {
    account,
    isLocal,
    request: visitorRequest,
    loadResumeDemo,
    rememberJob,
    applicationJobIds,
  };
})(typeof window !== "undefined" ? window : globalThis);

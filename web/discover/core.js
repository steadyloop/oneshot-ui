// Discover's rules, shared by the desktop page and the phone screens: filters,
// skills, places, links, dates, reports and the loaded feed. Also the desktop
// pane's markup, so it can be tested without a DOM.
import { api } from "../shared/api.js";
import { esc, localDay } from "../shared/util.js";

/* ───────────── Filters and sorting ───────────── */
export const FILTERS = [
  { key: "internships", label: "Internships", types: ["intern"] },
  { key: "coops", label: "Co-ops", types: ["coop"] },
  { key: "students", label: "Student jobs", types: ["student"] },
  { key: "new_grads", label: "New grad", types: ["new_grad"] },
  { key: "research", label: "Research", types: ["research"] },
];
// Keys are the API's degree_field values.
export const DEGREE_FILTERS = [
  { key: "software", label: "Software" },
  { key: "finance", label: "Finance" },
  { key: "med_device", label: "MedTech" },
  { key: "biotech", label: "BioTech" },
  { key: "clinical_affairs", label: "Regulatory" },
  { key: "unlabeled", label: "Unlabeled" },
];
export const SORTS = [["fresh", "Newest first"], ["oldest", "Oldest first"], ["fall", "Fall Only"], ["winter", "Winter Only"]];

// The seasons share the sort menu: they filter by title and description, newest first.
export const seasonFilter = value => ["fall", "winter"].includes(value) ? value : "";
export const sortOrder = value => seasonFilter(value) ? "fresh" : value;
export const jobTypes = filters => filters.flatMap(key => FILTERS.find(filter => filter.key === key)?.types || []);
export const degreeFields = filters => filters.filter(key => DEGREE_FILTERS.some(filter => filter.key === key));
export const defaultDegreeFields = account => degreeFields(
  Array.isArray(account?.discover_default_fields) ? account.discover_default_fields : [],
);
export const tabCount = (counts, filter) => filter.types.reduce(
  (total, type) => total + Math.max(0, Number(counts?.[type]) || 0), 0,
);

/* ───────────── Skills ───────────── */
export const SKILL_CATEGORIES = [
  { key: "language", label: "Languages" },
  { key: "framework", label: "Frameworks" },
  { key: "library", label: "Libraries" },
  { key: "platform", label: "Platforms" },
  { key: "tool", label: "Tools" },
  { key: "datastore", label: "Datastores" },
  { key: "protocol", label: "Protocols" },
  { key: "format", label: "Formats" },
  { key: "hardware", label: "Hardware" },
  { key: "method", label: "Methods" },
  { key: "concept", label: "Concepts" },
];
export const SKILL_BUNDLES = [
  { key: "languages", label: "Languages", categories: ["language"] },
  { key: "stack", label: "Stack", categories: ["framework", "library", "datastore"] },
  { key: "systems", label: "Systems", categories: ["platform", "tool", "protocol", "format", "hardware"] },
  { key: "knowledge", label: "Knowledge", categories: ["method", "concept"] },
  { key: "other", label: "Other", categories: [] },
];
const BUNDLE_BY_CATEGORY = new Map(SKILL_BUNDLES.flatMap(bundle => bundle.categories.map(category => [category, bundle.key])));
const CATEGORY_BY_KEY = new Map(SKILL_CATEGORIES.map((category, index) => [category.key, { ...category, index }]));
const UNKNOWN_CATEGORY = { key: "unknown", label: "Other", index: SKILL_CATEGORIES.length };
const CONCRETE = new Set(["language", "framework", "library", "datastore", "platform", "tool", "protocol", "format", "hardware"]);
const EXPERTISE = new Set(["method", "concept"]);
const skillCategory = skill => CATEGORY_BY_KEY.get(skill.category) || UNKNOWN_CATEGORY;

// Canonical skill objects, or plain strings from older postings.
export function skillDetails(job) {
  const values = Array.isArray(job?.skills) ? job.skills : job?.attributes?.skills;
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  return values.flatMap(value => {
    const structured = value && typeof value === "object" && !Array.isArray(value);
    const name = String(structured ? value.name || value.label || "" : typeof value === "string" ? value : "").trim();
    if (!name) return [];
    const id = String(structured ? value.id || name : name).trim();
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const label = String(structured ? value.label || name : name).trim() || name;
    const category = structured && typeof value.category === "string" && value.category.trim()
      ? value.category.trim().toLowerCase()
      : null;
    return [{ id, name, label, category }];
  });
}

export const orderedSkillDetails = job => skillDetails(job).sort((left, right) =>
  skillCategory(left).index - skillCategory(right).index
  || left.label.localeCompare(right.label, "en-US", { sensitivity: "base" })
  || left.id.localeCompare(right.id));

export function skillBundles(job) {
  const groups = new Map(SKILL_BUNDLES.map(bundle => [bundle.key, { ...bundle, skills: [] }]));
  for (const skill of orderedSkillDetails(job)) {
    groups.get(BUNDLE_BY_CATEGORY.get(skillCategory(skill).key) || "other").skills.push(skill);
  }
  return SKILL_BUNDLES.map(bundle => groups.get(bundle.key)).filter(bundle => bundle.skills.length);
}

// List rows show languages and the stack; the job's detail shows every skill.
export const listBundles = job => skillBundles(job).filter(bundle => bundle.key === "languages" || bundle.key === "stack");

// Expertise written as one compact word ("ModelDeploy") shows its full name.
export const skillLabel = skill => EXPERTISE.has(skillCategory(skill).key)
  && /[a-z][A-Z]|^(?:API|DB|GPU)-(?:Dev|Design)$/.test(skill.label) ? skill.name : skill.label;
export const skillTitle = skill => `${skill.name} · ${skillCategory(skill).label}`;

// Expertise terms on a quarter or more of the loaded postings (AI sits on half
// of Software internships) say little about any one posting, so the detail
// folds them behind "+N common". Below 50 loaded postings the share is noise.
const COMMON_TERM_SHARE = 0.25;
const COMMON_TERM_MIN_JOBS = 50;
export function commonTerms(jobs) {
  if (jobs.length < COMMON_TERM_MIN_JOBS) return new Map();
  const counts = new Map();
  for (const job of jobs) {
    for (const skill of skillDetails(job)) {
      if (EXPERTISE.has(skillCategory(skill).key)) counts.set(skill.id, (counts.get(skill.id) || 0) + 1);
    }
  }
  return new Map([...counts]
    .map(([id, count]) => [id, count / jobs.length])
    .filter(([, share]) => share >= COMMON_TERM_SHARE));
}
export const commonNote = (skill, share) => `${skill.name} · on ${Math.round(share * 100)}% of loaded postings`;

// The detail's skill rows: languages, the other concrete tools, expertise
// (the common terms apart) and anything uncategorised.
export function skillGroups(job, common = new Map()) {
  const skills = orderedSkillDetails(job);
  const expertise = skills.filter(skill => EXPERTISE.has(skill.category));
  return {
    languages: skills.filter(skill => skill.category === "language"),
    tools: skills.filter(skill => CONCRETE.has(skill.category) && skill.category !== "language"),
    expertise: expertise.filter(skill => !common.has(skill.id)),
    common: expertise.filter(skill => common.has(skill.id)),
    other: skills.filter(skill => !CONCRETE.has(skill.category) && !EXPERTISE.has(skill.category)),
  };
}
export const foldLabel = ({ expertise, common }, expanded) => expanded ? "Hide common"
  : expertise.length ? `+${common.length} common`
  : `Show ${common.length} common term${common.length > 1 ? "s" : ""}`;

/* ───────────── Company, places and links ───────────── */
export function initials(job) {
  const words = String(job?.company || "").split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length > 1 ? words.slice(0, 2).map(word => word[0]).join("") : words[0].slice(0, 2)).toUpperCase();
}
// Same-origin path only. The mark is server-issued, so a value that does not
// look like the logo route is dropped rather than rendered as a remote src.
export const logoSrc = value => /^\/api\/companies\/\d+\/logo$/.test(String(value || "")) ? String(value) : "";
// The logo or the initials, never both: a transparent PNG layered over the
// letters it replaces reads as a smudge.
export function logoMarkup(job, imageClass = "job-logo-mark") {
  const src = logoSrc(job?.logo);
  if (!src) return esc(initials(job));
  return `<img${imageClass ? ` class="${imageClass}"` : ""} src="${esc(src)}" alt="" loading="lazy" decoding="async">`;
}

export const workplaceLabel = value => ({ yes: "Remote", hybrid: "Hybrid" })[value] || "";

const SOURCE_LABELS = {
  adp: "ADP",
  ashby: "Ashby",
  greenhouse: "Greenhouse",
  icims: "iCIMS",
  lever: "Lever",
  smartrecruiters: "SmartRecruiters",
  workday: "Workday",
  "workday-list": "Workday (list)",
};
const sourceProvider = value => String(value || "").split(":", 1)[0].trim().toLowerCase();
export function sourceLabel(value) {
  const provider = sourceProvider(value);
  if (!provider) return "Source unavailable";
  return SOURCE_LABELS[provider] || provider.replace(/[-_]+/g, " ").replace(/\b\w/g, character => character.toUpperCase());
}

const safeHref = value => /^https?:\/\//i.test(String(value || "")) ? String(value) : "";
// Every distinct link to this posting, primary first. Distinct by URL, not by
// vendor: two career sites of one Oracle tenant are two ways in.
export function linkChoices(job) {
  const candidates = [
    { source: job?.source, url: job?.apply_url, posted_at: job?.posted_at, first_seen_at: job?.first_seen_at },
    ...(Array.isArray(job?.other_sources) ? job.other_sources : []),
  ];
  const seen = new Set();
  const choices = candidates.flatMap(candidate => {
    const url = safeHref(candidate?.url);
    if (!sourceProvider(candidate?.source) || !url || seen.has(url)) return [];
    seen.add(url);
    const { source, posted_at, first_seen_at } = candidate;
    return [{ source, label: sourceLabel(source), url, posted_at, first_seen_at }];
  });
  // Same-vendor links read identically by name, so the board key after the
  // colon tells them apart.
  return choices.map(choice => ({
    ...choice,
    board: choices.filter(other => other.label === choice.label).length > 1
      ? String(choice.source).split(":").slice(1).join(":").split("/").pop()
      : "",
  }));
}
// "board cx_1 · Posted yesterday"; the primary link says when it was last checked.
export function linkNote(job, choice, index, now = new Date()) {
  const when = index === 0 && job.last_seen_at ? `checked ${relativeTime(job.last_seen_at, now)}` : freshness(choice, now);
  return [choice.board && `board ${choice.board}`, when].filter(Boolean).join(" · ");
}

const US_STATES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "Washington, DC", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};
// Built from the full locations array: the API's `location` label stops at
// three places and says "+N more", so it cannot feed the expanded list.
export function placeList(job) {
  const places = (Array.isArray(job?.locations) ? job.locations : []).map(place => {
    const city = String(place?.city || "").trim();
    const region = String(place?.state || "").trim();
    const country = String(place?.country || "").trim();
    if (city) return [city, region || (country !== "US" ? country : "")].filter(Boolean).join(", ");
    if (region) return US_STATES[region] || region;
    return country === "US" ? "United States" : country;
  }).filter(Boolean);
  const unique = [...new Set(places)];
  return unique.length ? unique : [job?.location || "Location not listed"];
}
export function placeSummary(job) {
  const places = placeList(job);
  return places.length > 1 ? `${places[0]} +${places.length - 1}` : places[0];
}

/* ───────────── Dates ───────────── */
export function relativeTime(value, now = new Date()) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "Verification unavailable";
  const seconds = Math.max(0, Math.floor((now - date) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function postedPresentation(value, now = new Date(), firstSeen = null) {
  const days = input => {
    const date = new Date(input);
    return !input || Number.isNaN(date.getTime()) ? null : Math.max(0, Math.floor((now - date) / 86400000));
  };
  const phrase = (verb, count) => count === 0 ? `${verb} today` : count === 1 ? `${verb} yesterday` : `${verb} ${count}d ago`;
  const posted = days(value);
  if (posted !== null) return phrase("Posted", posted);
  const added = days(firstSeen);
  return added === null ? "Date unavailable" : phrase("Added", added);
}
const freshness = (job, now = new Date()) => postedPresentation(job.posted_at, now, job.first_seen_at);

// A row's age: "5m", "3h", "2d". Phones say "now" and leave an unknown date blank.
export function rowAge(job, { phone = false } = {}) {
  const age = relativeTime(job.posted_at || job.first_seen_at).replace(/ ago$/, "");
  if (!phone) return age;
  return age === "just now" ? "now" : /unavailable/i.test(age) ? "" : age;
}

export function deadlineLabel(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  return `Apply by ${date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
}
export const dueLabel = job => deadlineLabel(job.attributes?.deadline_at).replace(/^Apply by /, "Due ");

// "Oct 5, 2026 on Ashby", or only the source when the posting date is unknown.
export function postedFact(job) {
  const date = new Date(job.posted_at || "");
  const source = sourceLabel(job.source);
  if (Number.isNaN(date.getTime())) return `On ${source}`;
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} on ${source}`;
}

// The calendar day a posting opened, in the reader's time zone.
export function recencyBucket(job, now = new Date()) {
  const date = new Date(job?.posted_at || job?.first_seen_at || "");
  if (Number.isNaN(date.getTime())) return { key: "unknown", label: "Date unavailable" };
  const key = localDay(date);
  if (key === localDay(now)) return { key, label: "Opened today" };
  if (key === localDay(new Date(now.getTime() - 86400000))) return { key, label: "Opened yesterday" };
  const year = key.slice(0, 4) === localDay(now).slice(0, 4) ? {} : { year: "numeric" };
  return { key, label: `Opened ${date.toLocaleDateString("en-US", { month: "short", day: "numeric", ...year })}` };
}

// The list's day headings, each with its count of loaded postings. Phones
// add the weekday ("Wed, Aug 19").
export function dayGroups(jobs, { weekday = false, now = new Date() } = {}) {
  const day = job => {
    const { key, label } = recencyBucket(job, now);
    if (label === "Opened today") return { key, label: "Today" };
    if (label === "Opened yesterday") return { key, label: "Yesterday" };
    if (!weekday || key === "unknown") return { key, label: label.replace(/^Opened /, "") };
    const year = key.slice(0, 4) === String(now.getFullYear()) ? {} : { year: "numeric" };
    return { key, label: new Date(`${key}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", ...year }) };
  };
  const counts = new Map();
  const groups = [];
  for (const job of jobs) {
    const { key, label } = day(job);
    counts.set(key, (counts.get(key) || 0) + 1);
    if (groups.at(-1)?.key !== key) groups.push({ key, label, jobs: [] });
    groups.at(-1).jobs.push(job);
  }
  return groups.map(group => ({ ...group, count: counts.get(group.key) }));
}

/* ───────────── Hidden postings and reports ───────────── */
export const SKIP_REASONS = [
  { key: "level", label: "Level" },
  { key: "location", label: "Location" },
  { key: "field", label: "Field" },
  { key: "company", label: "Company" },
];
const TYPE_LABELS = { intern: "Internship", coop: "Co-op", student: "Student job", new_grad: "New grad", research: "Research" };
const DOMAIN_LABELS = {
  software: "Software", finance: "Finance", med_device: "MedTech", clinical_affairs: "Regulatory", biotech: "BioTech", unlabeled: "Unlabeled",
};
const CORRECTION_LABELS = { type: "Job type", focus: "Focus", company: "Company", location: "Location", skills: "Skills" };

// The labels a Mislabeled report can dispute, each with the value shown now.
export function reportRows(job) {
  const type = TYPE_LABELS[job.job_type] || "Unlabeled";
  const focus = DOMAIN_LABELS[job.focus ?? job.job_domain] || "Unlabeled";
  return [
    { field: "type", value: type, options: [...Object.values(TYPE_LABELS), "Not early-career"].filter(option => option !== type) },
    {
      field: "focus", value: focus,
      options: ["Software", "Finance", "MedTech", "BioTech", "Regulatory", "None of these"].filter(option => option !== focus),
    },
    { field: "company", value: String(job.company || ""), input: true },
    { field: "location", value: placeList(job).join(" · "), input: true },
    { field: "skills", value: "Skills and expertise list" },
  ].map(row => ({ ...row, label: CORRECTION_LABELS[row.field] }));
}
// The checked rows of a report draft ({ field: { on, to } }), as the API takes them.
export const reportCorrections = (job, rows) => reportRows(job)
  .filter(row => rows[row.field]?.on)
  .map(row => ({ field: row.field, from: row.value.slice(0, 300), to: String(rows[row.field].to || "").trim().slice(0, 300) || null }));

export function hiddenReason(entry) {
  if (!entry) return "";
  if (entry.kind === "skip") {
    const reason = SKIP_REASONS.find(item => item.key === entry.skip_reason);
    return reason ? `Skipped · ${reason.label}` : "Skipped";
  }
  const fields = Array.isArray(entry.corrections) ? entry.corrections : [];
  if (fields.length === 1) {
    const [only] = fields;
    const label = CORRECTION_LABELS[only.field] || only.field;
    return only.to ? `Mislabeled · ${label}: ${only.from} → ${only.to}` : `Mislabeled · ${label}`;
  }
  return fields.length ? `Mislabeled · ${fields.map(item => CORRECTION_LABELS[item.field] || item.field).join(", ")}` : "Mislabeled";
}
// The feedback that hid a posting, to hide it again after a Restore.
export const feedbackBody = entry => entry.kind === "skip"
  ? { kind: "skip", skip_reason: entry.skip_reason ?? null }
  : { kind: "mislabeled", corrections: entry.corrections };

/* ───────────── The loaded feed ───────────── */
const PAGE_SIZE = 100;
// Below this many loaded postings the next page loads in the background, so
// triage never runs the list dry.
const REFILL_AT = 10;

export const sameId = (a, b) => String(a) === String(b);

// One page of postings for the chosen tabs (`types`), fields, sort and search.
export const fetchJobs = ({ query, sort, types, fields }, offset = 0) => api.jobs.list({
  q: query, season: seasonFilter(sort), sort: sortOrder(sort),
  job_type: jobTypes(types), degree_field: degreeFields(fields), limit: PAGE_SIZE, offset,
});
export async function fetchHidden() {
  const payload = await api.feedback.list({ limit: 200 });
  return { total: payload.total, rows: (payload.hidden || []).filter(row => row.job) };
}
export const fetchHiddenTotal = async () => (await api.feedback.list({ limit: 1 })).total;

// `feed` is a page's state: { jobs, total, typeCounts, loadingMore }. Add, Skip
// and Report take a posting out at once; a failed write or an Undo puts it back.
function adjustCounts(feed, job, delta) {
  feed.total = Math.max(0, feed.total + delta);
  if (job.job_type && job.job_type in feed.typeCounts) {
    feed.typeCounts[job.job_type] = Math.max(0, feed.typeCounts[job.job_type] + delta);
  }
}
// Returns where the posting was, or -1 when it was not loaded.
export function takeOut(feed, job) {
  const position = (feed.jobs || []).findIndex(row => sameId(row.id, job.id));
  if (position >= 0) {
    feed.jobs = feed.jobs.filter(row => !sameId(row.id, job.id));
    adjustCounts(feed, job, -1);
  }
  return position;
}
// Returns whether the posting went back in.
export function putBack(feed, job, position) {
  if (!feed.jobs || position < 0 || feed.jobs.some(row => sameId(row.id, job.id))) return false;
  feed.jobs.splice(Math.min(position, feed.jobs.length), 0, job);
  adjustCounts(feed, job, 1);
  return true;
}
export const needsRefill = feed => Boolean(feed.jobs)
  && feed.jobs.length < REFILL_AT && feed.jobs.length < feed.total && !feed.loadingMore;

/* ───────────── Desktop markup ───────────── */
export const icon = id => `<svg aria-hidden="true"><use href="#${id}"/></svg>`;

function skillChipMarkup(skill, className) {
  const category = skillCategory(skill);
  return `<span class="${className}" data-skill-id="${esc(skill.id)}" data-skill-category="${category.key}" title="${esc(skillTitle(skill))}"`
    + ` aria-label="${esc(`${skill.name}, ${category.label}`)}">${esc(skillLabel(skill))}</span>`;
}
const chips = (skills, className) => skills.map(skill => skillChipMarkup(skill, className)).join("");

export const listTags = job => listBundles(job).map(bundle => chips(bundle.skills, `tag tag-${bundle.key}`)).join("");

export function cardMetaMarkup(job) {
  const workplace = workplaceLabel(job.remote);
  const term = job.attributes?.term;
  const items = [
    `<span class="card-location">${esc(placeSummary(job))}</span>`,
    workplace ? `<span class="workplace-cue">${esc(workplace)}</span>` : "",
    term ? `<span class="card-term">${esc(term)}</span>` : "",
  ];
  return `<div class="card-meta">${items.join("")}</div>`;
}

function expertiseMarkup(groups, common, expanded) {
  const section = (key, title, body) =>
    `<section class="detail-skill-section" data-skill-section="${key}"><div class="section-kicker">${title}</div>${body}</section>`;
  const folded = groups.common.map(skill => {
    const note = esc(commonNote(skill, common.get(skill.id)));
    return `<span class="expertise-term common" data-skill-id="${esc(skill.id)}" data-skill-category="${skillCategory(skill).key}"`
      + ` title="${note}" aria-label="${note}">${esc(skillLabel(skill))}</span>`;
  });
  const fold = folded.length
    ? `${expanded ? folded.join("") : ""}<button class="more-link" type="button" data-action="toggle-common" aria-expanded="${expanded}">${foldLabel(groups, expanded)}</button>`
    : "";
  const expertise = groups.expertise.length || folded.length
    ? section("expertise", "Expertise", `<div class="expertise-list" role="group" aria-label="Methods and concepts">${chips(groups.expertise, "expertise-term")}${fold}</div>`)
    : "";
  return expertise + (groups.other.length ? section("other", "Other", `<div class="skill-list">${chips(groups.other, "skill")}</div>`) : "");
}

export function detailSkillsMarkup(job, { common = new Map(), expanded = false } = {}) {
  const groups = skillGroups(job, common);
  const concrete = [...groups.languages, ...groups.tools];
  const skills = concrete.length
    ? `<section class="detail-skill-section" data-skill-section="skills"><div class="section-kicker">Skills</div><div class="skill-list">${chips(concrete, "skill")}</div></section>`
    : "";
  return skills + expertiseMarkup(groups, common, expanded);
}

export function detailFactsMarkup(job, { common = new Map(), expanded = false } = {}) {
  const groups = skillGroups(job, common);
  const row = (label, value) => `<div class="detail-fact"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
  const pills = skills => `<div class="skill-list">${chips(skills, "skill")}</div>`;
  const others = expertiseMarkup(groups, common, expanded);
  return `<section class="detail-facts"><h3>Details</h3><dl>`
    + (groups.languages.length ? row("Languages", pills(groups.languages)) : "")
    + (groups.tools.length ? row("Tools", pills(groups.tools)) : "")
    + (others ? row("Other skills", others) : "")
    + row("Posted", esc(postedFact(job)))
    + `</dl></section>`;
}

// The main half always opens the primary posting; the chevron half exists only
// when the posting is listed more than once, and lists every link.
export function openMarkup(job, ui = {}, now = new Date()) {
  const choices = linkChoices(job);
  if (!choices.length) return "";
  const main = `<a class="button open-link" href="${esc(choices[0].url)}" target="_blank" rel="noopener noreferrer"`
    + ` data-tip="Open the original posting" data-key="D"><span>Apply</span>${icon("icon-out")}</a>`;
  if (choices.length === 1) return main;
  const count = `${choices.length - 1} other link${choices.length > 2 ? "s" : ""}`;
  const items = choices.map((choice, index) => `<a class="link-item" role="menuitem" href="${esc(choice.url)}" target="_blank" rel="noopener noreferrer">`
    + `<span><b>${esc(choice.label)}</b><small>${esc(linkNote(job, choice, index, now))}</small></span>${icon("icon-out")}</a>`);
  const menu = ui.links ? `<div class="pop link-menu" role="menu" aria-label="Posting links"><p>Listed ${choices.length} times</p>${items.join("")}</div>` : "";
  return `<div class="open-split">${main}<button class="button open-more" type="button" data-action="toggle-links" aria-haspopup="menu"`
    + ` aria-expanded="${Boolean(ui.links)}" aria-label="${count}" data-tip="${count}" data-key="⇧D">${icon("icon-chevron")}</button>${menu}</div>`;
}

export function reportMarkup(job, report) {
  const busy = report.submitting ? " disabled" : "";
  const rows = reportRows(job).map(row => {
    const entry = report.rows[row.field] || {};
    const label = `<label class="sr-only" for="report-fix-${row.field}">Correct ${row.label.toLowerCase()} (optional)</label>`;
    let fix = "";
    if (entry.on && row.options) {
      const options = row.options.map(option => `<option value="${esc(option)}"${entry.to === option ? " selected" : ""}>${esc(option)}</option>`);
      fix = `<div class="report-fix">${label}<select id="report-fix-${row.field}" data-fix-select="${row.field}"><option value="">Correction (optional)</option>${options.join("")}</select></div>`;
    }
    if (entry.on && row.input) {
      fix = `<div class="report-fix">${label}<input id="report-fix-${row.field}" data-fix-input="${row.field}" value="${esc(entry.to || "")}"`
        + ` placeholder="Correct ${row.label.toLowerCase()} (optional)" maxlength="300" autocomplete="off"></div>`;
    }
    if (entry.on && row.field === "skills") fix = '<div class="report-fix"><p>Flagged for review.</p></div>';
    return `<div class="report-row${entry.on ? " on" : ""}"><label class="report-check"><input type="checkbox" id="report-${row.field}" data-report="${row.field}"`
      + `${entry.on ? " checked" : ""}${busy}><span class="report-key">${row.label}</span><span class="report-value">${esc(row.value)}</span></label>${fix}</div>`;
  }).join("");
  const ready = Object.values(report.rows).some(entry => entry.on);
  return `<form id="report-form" aria-busy="${Boolean(report.submitting)}"><header class="report-head"><div><h2 id="report-title">Report details</h2>`
    + `<p class="report-context">${esc(job.company)} · ${esc(job.title)}</p><p id="report-description" class="sr-only">Select incorrect details. Corrections are optional.</p></div>`
    + `<button class="report-close" type="button" data-action="report-cancel" aria-label="Close report"${busy}>${icon("icon-x")}</button></header>`
    + `<div class="report-body"><fieldset${busy}><legend class="sr-only">Incorrect details</legend>${rows}</fieldset>`
    + `${report.error ? `<p class="report-error" role="alert">${esc(report.error)}</p>` : ""}</div>`
    + `<footer class="report-foot"><p>Moves this job to Hidden. You can undo.</p><div><button class="button report-cancel" type="button" data-action="report-cancel"${busy}>Cancel</button>`
    + `<button class="button primary" type="submit" data-action="report-submit"${ready && !report.submitting ? "" : " disabled"}>${report.submitting ? "Reporting…" : "Report"}</button></div></footer></form>`;
}

export function appliedNoticeMarkup(notice) {
  if (!notice) return "";
  return `<span class="applied-notice" role="status" aria-label="${esc(`Added ${notice.job.company} to Applied`)}"><span>Added to Applied</span><span aria-hidden="true">·</span>`
    + `<button type="button" data-action="undo" aria-label="${esc(`Undo adding ${notice.job.company} to Applied`)}">Undo</button></span>`;
}

export function detailPaneMarkup(job, { ui = {}, hidden = null, common = new Map(), now = new Date(), appliedNotice = null } = {}) {
  const places = placeList(job);
  const workplace = workplaceLabel(job.remote);
  const term = job.attributes?.term;
  const deadline = deadlineLabel(job.attributes?.deadline_at);
  const more = places.length > 1
    ? `<button class="place-more" type="button" data-action="toggle-places" aria-expanded="${Boolean(ui.places)}" aria-label="Show all ${places.length} locations">+${places.length - 1}</button>`
    : "";
  const placeMenu = ui.places && places.length > 1
    ? `<div class="pop place-menu" role="dialog" aria-label="Locations"><p>${places.length} locations</p><ul>${places.map(place => `<li>${icon("icon-pin")}${esc(place)}</li>`).join("")}</ul></div>`
    : "";
  const flag = hidden ? "" : `<button class="detail-flag" type="button" data-action="report" aria-expanded="${Boolean(ui.report)}" aria-label="Mislabeled"`
    + ` data-tip="Mislabeled" data-key="R" data-tip-below>${icon("icon-flag")}<span>Report</span></button>`;
  const actions = hidden
    ? `<div class="hidden-banner${hidden.kind === "mislabeled" ? " flagged" : ""}"><p>${esc(hiddenReason(hidden))}</p>`
      + `<button class="button" type="button" data-action="restore" data-id="${esc(job.id)}">${icon("icon-undo")}<span>Restore to feed</span></button></div>`
    : `<div class="detail-actions">${openMarkup(job, ui, now)}`
      + `<button class="button primary" type="button" data-action="add-to-applications" data-id="${esc(job.id)}" data-tip="Add to Applications" data-key="A">${icon("icon-plus")}<span>Applied</span></button>`
      + `${appliedNoticeMarkup(appliedNotice)}`
      + `<button class="button skip" type="button" data-action="skip" data-id="${esc(job.id)}" data-tip="Skip" data-key="F">${icon("icon-eye-off")}<span>Skip</span></button></div>`;
  const summary = String(job?.summary || "").trim();
  const metadata = `<div class="detail-place">${icon("icon-pin")}<span>${esc(places[0])}</span>${more}${placeMenu}</div>`
    + (workplace ? `<span>${icon("icon-briefcase")}${esc(workplace)}</span>` : "")
    + (term ? `<span>${icon("icon-calendar")}${esc(term)}</span>` : "")
    + (deadline ? `<span>${esc(deadline)}</span>` : "");
  return `<div class="detail-inner"><header class="detail-head"><div class="detail-logo">${logoMarkup(job)}</div><div class="detail-line">`
    + `<div class="detail-company-row"><div class="detail-company" title="${esc(job.company)}">${esc(job.company)}</div>${flag}</div>`
    + `<h2>${esc(job.title)}</h2><div class="detail-metadata">${metadata}</div></div></header>`
    + actions
    + `<div class="detail-body"><section><h3>About the role</h3>`
    + (summary ? `<p class="role-summary">${esc(summary)}</p>` : '<p class="summary-missing">Summary unavailable. View the original posting for complete details.</p>')
    + `</section>${detailFactsMarkup(job, { common, expanded: Boolean(ui.common) })}</div></div>`;
}

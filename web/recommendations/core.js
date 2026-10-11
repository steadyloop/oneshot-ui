export const views = { ready: 'Ready to apply', conditional: 'Check conditions', unverified: 'Needs verification', excluded: 'Excluded' };
const sameId = (a, b) => String(a) === String(b);
export function isTracked(job, applications) {
  const ids = [job.id, ...(job.aliases || [])];
  return applications.some(app => ids.some(id => sameId(id, app.job_id)) || ((app.apply_url_snapshot || app.apply_url || app.url) && (app.apply_url_snapshot || app.apply_url || app.url) === job.apply_url));
}
export function termMatches(job, term) {
  if (!term) return true;
  const value = String(job.term || '').toLowerCase();
  if (term === 'winter') return /winter|spring|jan|feb|march|april/.test(value);
  if (term === 'summer') return /summer|may|june|july|august/.test(value);
  if (term === 'fall') return /fall|autumn|sept|october/.test(value);
  return !/winter|spring|summer|fall|autumn|jan|feb|march|april|may|june|july|august|sept|october/.test(value);
}
export function gpaMatches(job, filter) {
  const minimum = job.gpa_min;
  if (filter === 'none') return minimum == null;
  if (filter === 'compatible') return minimum == null || minimum <= 3.4;
  if (filter === 'higher') return minimum != null && minimum > 3.4;
  if (filter === 'required') return minimum != null;
  return true;
}
export function visibleJobs(rows, filters, applications = []) {
  const words = filters.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter(job => job.view === filters.view
    && (!filters.category || job.category === filters.category)
    && (!filters.fit || String(job.fit) === filters.fit)
    && termMatches(job, filters.term) && gpaMatches(job, filters.gpa)
    && (!filters.hideApplied || !isTracked(job, applications))
    && words.every(word => [job.company, job.title, job.location, job.reason, job.evidence, ...(job.skills || [])].join(' ').toLowerCase().includes(word)));
}
export function csv(rows) {
  const columns = ['rank', 'company', 'title', 'location', 'term', 'posted_day', 'deadline', 'category', 'view', 'gpa_min', 'gpa_preferred', 'gpa_note', 'reason', 'conditions', 'apply_url'];
  const cell = value => {
    const raw = Array.isArray(value) ? value.join('; ') : String(value ?? '');
    const safe = /^[=+@\-\t\r]/.test(raw) ? `'${raw}` : raw;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return [columns.join(','), ...rows.map(row => columns.map(column => cell(row[column])).join(','))].join('\r\n');
}

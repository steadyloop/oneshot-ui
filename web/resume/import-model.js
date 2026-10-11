// Import state and writes are separate from the existing workspace/editor.
export const categories = ['language', 'framework', 'data', 'tool', 'coursework', 'math'];
export const fields = ['kind', 'org', 'role', 'location', 'start_date', 'end_date', 'url', 'detail'];
const contactLimits = { full_name: 200, email: 320, phone: 50, location: 200 };
const entryLimits = { org: 300, role: 300, location: 200, start_date: 40, end_date: 40, url: 2000, detail: 500 };
const norm = value => String(value || '').trim();
const size = value => Array.from(String(value || '')).length;
const entryKey = entry => JSON.stringify([...fields.map(key => norm(entry[key])), (entry.bullets || []).map(b => norm(b.text))]);
const skillKey = skill => `${skill.category}:${norm(skill.name)}`;
export function reviewDraft(draft) {
  return {
    profile: Object.fromEntries(Object.entries(draft.profile).filter(([key]) => key !== 'links').map(([key, value]) => [key, { value, selected: Boolean(value) }])),
    links: draft.profile.links.map(link => ({ ...link, selected: true })),
    entries: draft.entries.map(entry => ({ ...entry, selected: true, bullets: entry.bullets.map(b => ({ ...b, selected: true })), savedId: null, done: false })),
    skills: draft.skills.map(skill => ({ ...skill, selected: true, done: false })),
  };
}
export function entryPayload(entry) {
  return Object.fromEntries(fields.map(key => [key, norm(entry[key])]));
}
export function validateReview(review) {
  const errors = [];
  for (const [key, item] of Object.entries(review.profile)) if (item.selected && size(item.value) > contactLimits[key]) errors.push(`${key}: maximum ${contactLimits[key]} characters.`);
  review.links.filter(x => x.selected).forEach(link => {
    if (!norm(link.url) || size(link.url) > 2000 || size(link.label) > 200) errors.push('Links need a URL of at most 2000 characters and a label of at most 200.');
  });
  review.entries.filter(x => x.selected && !x.done).forEach(entry => {
    if (!['education', 'experience', 'research', 'project', 'leadership'].includes(entry.kind)) errors.push('Choose a section for each selected entry.');
    if (!norm(entry.org)) errors.push('Every selected entry needs an organization, school, or project name.');
    for (const [key, limit] of Object.entries(entryLimits)) if (size(entry[key]) > limit) errors.push(`${key}: maximum ${limit} characters.`);
    entry.bullets.filter(x => x.selected && !x.done).forEach(b => {
      if (!norm(b.text) || size(b.text) > 600) errors.push('Each selected bullet needs 1–600 characters.');
    });
  });
  review.skills.filter(x => x.selected && !x.done).forEach(skill => {
    if (!categories.includes(skill.category)) errors.push(`Choose a category for ${skill.name || 'each skill'}.`);
    if (!norm(skill.name) || size(skill.name) > 120) errors.push('Each selected skill needs 1–120 characters.');
  });
  return [...new Set(errors)];
}
export function duplicateEntry(entry, existing) {
  return existing.some(item => entryKey(item) === entryKey({ ...entry, bullets: entry.bullets.filter(b => b.selected) }));
}
export function possibleDuplicate(entry, existing) {
  return existing.some(item => item.kind === entry.kind && norm(item.org).toLowerCase() === norm(entry.org).toLowerCase());
}
export async function applyReview(review, workspace, api) {
  const errors = validateReview(review);
  if (errors.length) throw new Error(errors.join('\n'));
  const patch = {};
  for (const [key, item] of Object.entries(review.profile)) {
    if (item.selected && norm(item.value) && !norm(workspace.profile[key])) patch[key] = norm(item.value);
  }
  const links = [...(workspace.profile.links || [])];
  for (const link of review.links.filter(x => x.selected)) if (!links.some(x => norm(x.url) === norm(link.url))) links.push({ label: norm(link.label), url: norm(link.url) });
  if (links.length !== (workspace.profile.links || []).length) patch.links = links;
  if (Object.keys(patch).length) {
    await api.saveProfile(patch);
    Object.assign(workspace.profile, patch);
  }
  for (const entry of review.entries.filter(x => x.selected && !x.done)) {
    if (!entry.savedId && duplicateEntry(entry, workspace.entries)) { entry.done = true; continue; }
    if (!entry.savedId) {
      const saved = await api.addEntry(entryPayload(entry));
      entry.savedId = saved.id;
    }
    for (const bullet of entry.bullets.filter(x => x.selected && !x.done)) {
      await api.addBullet(entry.savedId, norm(bullet.text));
      bullet.done = true;
    }
    entry.done = true;
    workspace.entries.push({ ...entryPayload(entry), id: entry.savedId, bullets: entry.bullets.filter(b => b.selected) });
  }
  for (const skill of review.skills.filter(x => x.selected && !x.done)) {
    if (!workspace.skills.some(x => skillKey(x) === skillKey(skill))) {
      const saved = await api.addSkill(skill.category, norm(skill.name));
      workspace.skills.push(saved);
    }
    skill.done = true;
  }
}

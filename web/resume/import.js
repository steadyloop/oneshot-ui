import { esc } from '../shared/util.js';
import { resumeApi } from './core.js';
import { applyReview, categories, duplicateEntry, fields, possibleDuplicate, reviewDraft, validateReview } from './import-model.js';

const uploadIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5M4 14v7h16v-7"/></svg>';
const documentIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 2h9l5 5v15H5zM14 2v6h5M12 18v-7m-3 3 3-3 3 3"/></svg>';
export const importButton = () => `<button type="button" class="resume-import-trigger" data-resume-import>${uploadIcon}Fill with resume</button>`;
const labels = { full_name: 'Name', email: 'Email', phone: 'Phone', location: 'Location', kind: 'Section', org: 'Organization / school / project', role: 'Role / degree', start_date: 'Start date', end_date: 'End date', url: 'URL', detail: 'Detail / GPA', label: 'Label', text: 'Bullet', name: 'Skill', category: 'Category' };
const input = (path, key, value, disabled = false, label = labels[key] || key) => `<label>${esc(label)}<${key === 'text' ? 'textarea' : 'input'} data-import-field="${path}.${key}" ${disabled ? 'disabled' : ''}${key !== 'text' ? ` value="${esc(value || '')}"` : ''}>${key === 'text' ? `${esc(value || '')}</textarea>` : ''}</label>`;
const select = (path, key, value, options, disabled = false) => `<label>${esc(labels[key])}<select data-import-field="${path}.${key}" ${disabled ? 'disabled' : ''}><option value="">Choose…</option>${options.map(x => `<option value="${x}" ${x === value ? 'selected' : ''}>${x}</option>`).join('')}</select></label>`;
const check = (path, selected, text, disabled = false) => `<label class="ri-check"><input type="checkbox" data-import-field="${path}.selected" ${selected ? 'checked' : ''} ${disabled ? 'disabled' : ''}>${esc(text)}</label>`;

export function installResumeImport({ getWorkspace, refresh, notify }) {
  const css = document.createElement('link');
  css.rel = 'stylesheet'; css.href = '/static/resume/import.css'; document.head.append(css);
  let dialog, original, review, file, pasted = false, busy = false, opener, controller;
  const resolve = path => path.split('.').reduce((obj, key) => obj[key], review);
  const message = text => { dialog.querySelector('.ri-status').textContent = text; };
  function lock(value) {
    busy = value;
    dialog.querySelectorAll('button, input, textarea, select').forEach(el => {
      if (value) { el.dataset.riDisabled = String(el.disabled); el.disabled = true; }
      else { el.disabled = el.dataset.riDisabled === 'true'; delete el.dataset.riDisabled; }
    });
    dialog.setAttribute('aria-busy', String(value));
  }
  function frame(body, action) {
    dialog.innerHTML = `<form novalidate><header><h2 id="resume-import-title">${review ? 'Review your resume' : 'Fill with resume'}</h2><button type="button" data-ri="close" aria-label="Close">×</button></header><div class="ri-body">${body}<p class="ri-status" role="status" aria-live="polite"></p></div><footer><button type="button" data-ri="close">Cancel</button><button type="submit" class="ri-primary">${action}</button></footer></form>`;
  }
  function upload() {
    frame(`<p>Upload your resume to fill your profile.</p>${getWorkspace().local ? '<p class="ri-note">Your document is sent to the server for parsing and is not stored. Your guest profile stays in this browser.</p>' : ''}<div class="ri-drop" tabindex="0" role="button" aria-label="Choose a resume file">${documentIcon}<strong>Drop your resume here</strong><span>or <button type="button" data-ri="choose">choose a file</button></span><small>PDF or DOCX · Up to 10 MB</small><span class="ri-filename"></span></div><input type="file" accept=".pdf,.docx" hidden><button class="ri-text" type="button" data-ri="paste">Paste resume text instead</button><label class="ri-paste" hidden>Resume text<textarea data-pasted rows="10"></textarea></label>`, 'Continue');
  }
  function showReview() {
    const workspace = getWorkspace();
    const contact = Object.entries(review.profile).map(([key, item]) => `<div>${check(`profile.${key}`, item.selected, labels[key])}${input(`profile.${key}`, 'value', item.value, false, labels[key])}${workspace.profile[key] ? '<small>Existing value will be kept.</small>' : ''}</div>`).join('');
    const links = review.links.map((link, i) => `<fieldset>${check(`links.${i}`, link.selected, 'Add link')}${input(`links.${i}`, 'label', link.label)}${input(`links.${i}`, 'url', link.url)}</fieldset>`).join('');
    const entries = review.entries.map((entry, i) => {
      const path = `entries.${i}`;
      const duplicate = duplicateEntry(entry, workspace.entries);
      return `<fieldset>${check(path, entry.selected, `${entry.kind}: ${entry.org || 'Name needed'}`, Boolean(entry.savedId || entry.done))}${entry.done ? '<p class="ri-note">Saved or already present.</p>' : duplicate ? '<p class="ri-note">Exact duplicate will be skipped.</p>' : possibleDuplicate(entry, workspace.entries) ? '<p class="ri-note">This organization already appears in your profile. Check before adding.</p>' : ''}<div class="ri-grid">${select(path, 'kind', entry.kind, ['education', 'experience', 'research', 'project', 'leadership'], Boolean(entry.savedId || entry.done))}${fields.filter(x => x !== 'kind').map(key => input(path, key, entry[key], Boolean(entry.savedId || entry.done))).join('')}</div>${entry.bullets.map((b, j) => `<div class="ri-bullet">${check(`${path}.bullets.${j}`, b.selected, 'Include bullet', b.done || entry.done)}${input(`${path}.bullets.${j}`, 'text', b.text, b.done || entry.done)}</div>`).join('')}</fieldset>`;
    }).join('');
    const skills = review.skills.map((skill, i) => `<fieldset>${check(`skills.${i}`, skill.selected, 'Include skill', skill.done)}<div class="ri-grid">${input(`skills.${i}`, 'name', skill.name, skill.done)}${select(`skills.${i}`, 'category', skill.category, categories, skill.done)}</div></fieldset>`).join('');
    const passage = ids => original.sources.filter(s => ids.includes(s.id)).map(s => s.text).join('\n');
    const warnings = original.warnings.map(w => `<li>${esc(w.message)}<pre>${esc(passage(w.source_ids))}</pre></li>`).join('');
    frame(`<p>Check the extracted details. Existing contact values will be kept; selected entries and skills will be added.</p><h3>Contact</h3><div class="ri-grid">${contact}</div>${links}<h3>Entries</h3>${entries || '<p>No entries extracted.</p>'}<h3>Skills and coursework</h3>${skills || '<p>No skills extracted.</p>'}${warnings ? `<details><summary>Review warnings (${original.warnings.length})</summary><ul>${warnings}</ul></details>` : ''}<details><summary>Original and unmatched content (${original.unparsed.length} unmatched passages)</summary>${original.unparsed.map(u => `<p>${esc(u.reason)}</p><pre>${esc(u.text)}</pre>`).join('')}<h3>Original passages</h3>${original.sources.map(s => `<pre>${esc(s.text)}</pre>`).join('')}</details><button class="ri-text" type="button" data-ri="download">Download draft with original content</button>`, 'Apply to profile');
  }
  function chooseFile(selected) {
    if (!selected) return;
    file = null; dialog.querySelector('.ri-filename').textContent = '';
    if (!/\.(pdf|docx)$/i.test(selected.name)) { message('Choose a PDF or DOCX file, or paste its text.'); return; }
    if (selected.size > 10 * 1024 * 1024) { message('Resume files must be 10 MB or smaller.'); return; }
    file = selected; pasted = false;
    dialog.querySelector('.ri-filename').textContent = selected.name;
    dialog.querySelector('.ri-paste').hidden = true;
    message('');
  }
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    if (review) {
      const errors = validateReview(review);
      if (errors.length) { message(errors.join('\n')); return; }
      lock(true); message('Applying reviewed details…');
      let error;
      try {
        // Reload before merging so values saved since opening the dialog win.
        const current = await resumeApi.load();
        await applyReview(review, current, resumeApi);
      } catch (exc) { error = exc; }
      try { await refresh(); } catch (exc) { error ||= exc; }
      lock(false);
      if (error) { showReview(); message(`${error.message}\nConfirmed saves are retained. Retry to apply unfinished items.`); }
      else { dialog.close(); notify('Resume details added to profile'); }
      return;
    }
    const text = dialog.querySelector('[data-pasted]').value;
    if (pasted ? !text.trim() : !file) { message('Choose a resume file or paste resume text.'); return; }
    const body = pasted ? text : file;
    if ((pasted ? new Blob([text]).size : file.size) > 10 * 1024 * 1024) { message('Resume input must be 10 MB or smaller.'); return; }
    controller = new AbortController(); lock(true); message('Reading your resume…');
    try {
      const type = pasted ? 'text' : file.name.split('.').pop().toLowerCase();
      const response = await fetch(`/api/resume/parse?file_type=${type}`, { method: 'POST', body, headers: { 'Content-Type': pasted ? 'text/plain; charset=utf-8' : 'application/octet-stream' }, signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || 'The resume could not be read. Try pasting its text.');
      original = result; review = reviewDraft(result); lock(false); showReview();
      dialog.querySelector('h3').tabIndex = -1; dialog.querySelector('h3').focus();
    } catch (error) { lock(false); if (error.name !== 'AbortError') message(error.message); }
  }
  function open(target) {
    if (dialog?.open) return;
    opener = target; original = review = file = null; pasted = busy = false;
    dialog = document.createElement('dialog'); dialog.className = 'resume-import-dialog';
    dialog.setAttribute('aria-labelledby', 'resume-import-title');
    (document.getElementById('phone') || document.body).append(dialog);
    upload();
    dialog.addEventListener('submit', submit);
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => { controller?.abort(); dialog.remove(); opener?.focus(); });
    dialog.addEventListener('input', event => {
      if (!review || !event.target.dataset.importField) return;
      const path = event.target.dataset.importField.split('.'); const key = path.pop();
      resolve(path.join('.'))[key] = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    });
    dialog.addEventListener('change', event => { if (event.target.type === 'file') chooseFile(event.target.files[0]); });
    dialog.addEventListener('click', event => {
      const action = event.target.closest('[data-ri]')?.dataset.ri;
      if (action === 'close' && !busy) dialog.close();
      if (action === 'choose') dialog.querySelector('[type=file]').click();
      if (action === 'paste') { pasted = true; dialog.querySelector('.ri-paste').hidden = false; dialog.querySelector('[data-pasted]').focus(); }
      if (action === 'download') {
        const url = URL.createObjectURL(new Blob([JSON.stringify({ extracted: original, reviewed: review }, null, 2)], { type: 'application/json' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'resume-import-draft.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      if (!action && event.target.closest('.ri-drop') && !busy) dialog.querySelector('[type=file]').click();
    });
    dialog.addEventListener('keydown', event => {
      if (event.target.matches('.ri-drop') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); dialog.querySelector('[type=file]').click(); }
    });
    dialog.addEventListener('dragover', event => { event.preventDefault(); });
    dialog.addEventListener('drop', event => { event.preventDefault(); if (!busy && !review) chooseFile(event.dataTransfer.files[0]); });
    dialog.showModal();
  }
  document.addEventListener('click', event => {
    const target = event.target.closest('[data-resume-import]');
    if (target && getWorkspace().profile) open(target);
  });
}

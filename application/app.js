
  (() => {
    'use strict';

    const PAGE_SIZE = 50;
    const DAY = 86400000;
    const COLUMNS = [
      { key: 'replied', label: 'Replied', caption: 'A conversation has started', color: '#859584', line: '#ced8cb', icon: 'chat', empty: 'Your next conversation starts here.' },
      { key: 'assessment', label: 'Assessment', caption: 'A chance to show your work', color: '#b5a080', line: '#e5dccb', icon: 'resume', empty: 'Tests and take-homes, with room to focus.' },
      { key: 'interview', label: 'Interview', caption: 'Meet the people behind the role', color: '#8b9eab', line: '#d4dee5', icon: 'calendar', empty: 'From first screens to final rounds.' },
      { key: 'offer', label: 'Offer', caption: 'Your next chapter, within reach', color: '#528565', line: '#bcd2bf', icon: 'briefcase', empty: 'Good things are ahead.' },
    ];
    const STAGES = ['sent', ...COLUMNS.map(c => c.key), 'closed'];
    const LABELS = { sent: 'Submitted', replied: 'Replied', assessment: 'Assessment', interview: 'Interview', offer: 'Offer', closed: 'Closed' };
    const REASONS = { rejected: 'Rejected', withdrawn: 'Withdrawn', no_reply: 'No reply' };
    const $ = selector => document.querySelector(selector);
    const $$ = selector => [...document.querySelectorAll(selector)];
    const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const clone = value => JSON.parse(JSON.stringify(value));
    // Calendar fields are dates, not instants. UTC arithmetic avoids DST and
    // formatting in UTC preserves the day picked by users west of UTC.
    const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const dayIndex = day => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY);
    const dateAt = offset => new Date((dayIndex(today()) + offset) * DAY).toISOString().slice(0, 10);
    const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(dayIndex(value)) && new Date(dayIndex(value) * DAY).toISOString().slice(0, 10) === value;
    const formatDay = (day, year = false) => validDay(day) ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' }).format(new Date(dayIndex(day) * DAY)) : '—';
    const age = app => validDay(app.submittedAt) ? Math.max(0, dayIndex(today()) - dayIndex(app.submittedAt)) : null;
    const dueDays = app => validDay(app.nextDue) ? dayIndex(app.nextDue) - dayIndex(today()) : Infinity;
    const inPipeline = app => COLUMNS.some(c => c.key === app.stage);
    const waitingOnCompany = app => app.taskState === 'waiting';
    const taskGroup = app => waitingOnCompany(app) ? 'waiting' : dueDays(app) < 0 ? 'overdue' : dueDays(app) === 0 ? 'today' : dueDays(app) === Infinity ? 'ready' : 'later';
    const viewFor = stage => stage === 'sent' || stage === 'closed' ? stage : 'pipeline';
    const dueInfo = app => {
      const days = dueDays(app);
      if (!Number.isFinite(days)) return null;
      if (days < 0) return { class: 'overdue', text: `${Math.abs(days)}d overdue` };
      if (days === 0) return { class: 'today', text: 'Due today' };
      if (days === 1) return { class: 'soon', text: 'Tomorrow' };
      return { class: days <= 6 ? 'soon' : '', text: formatDay(app.nextDue) };
    };
    const safeUrl = value => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };
    const companyMark = company => {
      const palettes = [['#eaf0eb', '#4d6f56'], ['#eeeaf2', '#6c5c7d'], ['#eaf0f3', '#526c7a'], ['#f2ece6', '#8a6e52'], ['#f1e9e7', '#8a625c']];
      const hash = [...company].reduce((n, c) => n + c.charCodeAt(0), 0);
      const [bg, color] = palettes[hash % palettes.length];
      const initial = company.trim().charAt(0).toUpperCase() || '?';
      return `<i class="company-mark" aria-hidden="true" style="--mark-bg:${bg};--mark-color:${color}">${esc(initial)}</i>`;
    };

    const state = { applications: [], loading: true, error: '', busy: false, view: 'pipeline', filters: { pipeline: { query: '', sort: 'next' }, sent: { query: '', sort: 'newest', age: 'all' }, closed: { query: '', sort: 'recent', outcome: 'all' } }, page: 1, selected: new Set(), selectedId: null, responseId: null, completionId: null, closureId: null, agendaWeek: 0, agendaOverdueOpen: false, mobileStage: 'replied', dragId: null, flashId: null };
    const currentFilters = () => state.filters[state.view];
    const byId = id => state.applications.find(a => a.id === id);
    const api = globalThis.OneShotAPI;
    const calendarDay = value => String(value || '').slice(0, 10);
    const uiStage = stage => ['applied', 'considering'].includes(stage) ? 'sent' : stage;
    const wireStage = stage => stage === 'sent' ? 'applied' : stage;
    function fromAPI(raw) {
      const stage = uiStage(raw.stage);
      return {
        id: String(raw.id), jobId: raw.job_id, external: raw.external === true,
        company: raw.company || '', role: raw.title || '', location: raw.location || '',
        url: raw.apply_url_snapshot || '', notes: raw.note || '', resumeVariant: raw.resume_variant || '',
        submittedAt: calendarDay(raw.submitted_at), nextAction: raw.next_action || '',
        nextDue: calendarDay(raw.next_due_at), taskState: raw.task_state || (stage === 'sent' ? 'waiting' : 'action'),
        waitingFor: raw.waiting_for || '', stage, closedReason: raw.closed_reason,
        lastOpenStage: uiStage(raw.last_open_stage || (stage === 'closed' ? 'applied' : raw.stage)),
        updatedAt: raw.updated_at || '',
        events: (raw.events || []).map(e => ({ at: e.occurred_at, text:
          e.event_type === 'stage_changed'
            ? (/^(Moved to |Closed · |Restored to |Change undone)/.test(e.note || '') ? e.note : `${e.to_stage === 'considering' ? 'Previously considering' : `Moved to ${LABELS[uiStage(e.to_stage)] || e.to_stage}`}${e.note ? ` · ${e.note}` : ''}`)
            : e.note || 'Application details updated'
        })).sort((a, b) => String(b.at).localeCompare(String(a.at))),
      };
    }
    function toAPI(app, activity) {
      return {
        stage: wireStage(app.stage), closed_reason: app.stage === 'closed' ? app.closedReason : null,
        submitted_at: app.submittedAt || null, next_action: app.nextAction || null,
        next_due_at: app.nextDue || null, note: app.notes, resume_variant: app.resumeVariant || null,
        task_state: app.taskState, waiting_for: app.waitingFor,
        ...(app.external ? { company: app.company, title: app.role, location: app.location, apply_url_snapshot: app.url } : {}),
        ...(activity ? { activity } : {}),
      };
    }
    function replaceApplication(app) {
      const index = state.applications.findIndex(a => a.id === app.id);
      if (index >= 0) state.applications[index] = app;
    }
    async function loadApplications() {
      if (state.busy || $$('dialog').some(d => d.open)) return;
      setBusy(true);
      try {
        const result = await api.applications.list();
        state.applications = result.applications.map(fromAPI);
        state.error = '';
      } catch (error) { state.error = error.message || 'Could not load applications.'; }
      setBusy(false); state.loading = false; state.selected.clear(); render();
    }
    function setBusy(value) {
      state.busy = value;
      $('#workspace').setAttribute('aria-busy', String(value));
      $$('button, .agenda input[type=checkbox]').forEach(button => {
        if (value) { button.dataset.wasDisabled = String(button.disabled); button.disabled = true; }
        else if (button.dataset.wasDisabled !== undefined) { button.disabled = button.dataset.wasDisabled === 'true'; delete button.dataset.wasDisabled; }
      });
    }

    function visibleApplications() {
      const f = currentFilters();
      const query = f.query.trim().toLocaleLowerCase();
      return state.applications.filter(app => {
        if (viewFor(app.stage) !== state.view) return false;
        if (query && !`${app.company} ${app.role} ${app.location || ''} ${app.nextAction || ''} ${app.waitingFor || ''}`.toLocaleLowerCase().includes(query)) return false;
        if (f.age === '7' && (age(app) === null || age(app) >= 7)) return false;
        if (f.age === '30' && (age(app) === null || age(app) < 30)) return false;
        if (f.outcome && f.outcome !== 'all' && app.closedReason !== f.outcome) return false;
        return true;
      }).sort((a, b) => {
        if (f.sort === 'company') return a.company.localeCompare(b.company) || a.role.localeCompare(b.role) || a.id.localeCompare(b.id);
        if (f.sort === 'oldest') return a.submittedAt.localeCompare(b.submittedAt) || a.id.localeCompare(b.id);
        if (f.sort === 'newest') return b.submittedAt.localeCompare(a.submittedAt) || a.id.localeCompare(b.id);
        const recent = String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.id.localeCompare(b.id);
        if (f.sort === 'next') return (dueDays(a) - dueDays(b) || recent);
        return recent;
      });
    }

    function renderHeader() {
      const apps = state.applications, active = apps.filter(inPipeline);
      $('#count-pipeline').textContent = active.length;
      $('#count-sent').textContent = apps.filter(a => a.stage === 'sent').length;
      $('#count-closed').textContent = apps.filter(a => a.stage === 'closed').length;
      $$('[data-view]').forEach(button => { const selected = button.dataset.view === state.view; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; });
      $('#panel').setAttribute('aria-labelledby', `tab-${state.view}`);
      $('#workspace').classList.toggle('records-view', state.view !== 'pipeline');
      $('#records-toolbar').hidden = state.view === 'pipeline';
      $('#sort-control').hidden = state.view === 'pipeline';
      $('#age-control').hidden = state.view !== 'sent';
      $('#outcome-control').hidden = state.view !== 'closed';
      $('#age-filter').value = state.filters.sent.age;
      $('#outcome-filter').value = state.filters.closed.outcome;
      $('#sort').value = currentFilters().sort;
      const placeholder = { pipeline: 'Search tasks, companies, or roles…', sent: 'Find a submitted application…', closed: 'Search closed applications…' }[state.view];
      $('#search').placeholder = placeholder;
    }

    function deadlineMarkup(app, className) {
      if (waitingOnCompany(app)) return `<span class="${className}">Waiting</span>`;
      const days = dueDays(app);
      const label = days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? 'Due today' : days === 1 ? 'Tomorrow' : days === Infinity ? 'No deadline' : formatDay(app.nextDue);
      const urgency = days < 0 ? 'overdue' : days === 0 ? 'today' : '';
      return `<span class="${className} ${urgency}"${validDay(app.nextDue) ? ` title="${esc(formatDay(app.nextDue, true))}"` : ''}>${esc(label)}</span>`;
    }
    function cardMarkup(app) {
      const group = taskGroup(app), waiting = waitingOnCompany(app);
      const task = waiting ? app.waitingFor || 'Waiting on company' : app.nextAction || 'Set a next step';
      return `<button class="card card-open ${group}" type="button" draggable="true" data-open="${esc(app.id)}" data-drag="${esc(app.id)}" aria-label="${esc(`${app.company}, ${app.role}, ${task}`)}">
        <span class="card-identity" title="${esc(`${app.company} · ${app.role}`)}"><strong>${esc(app.company)}</strong> · ${esc(app.role)}</span><span class="card-drag" aria-hidden="true">${icon('drag')}</span>
        <span class="card-task${waiting ? ' waiting' : ''}">${esc(task)}</span>${deadlineMarkup(app, 'card-deadline')}
      </button>`;
    }

    // The agenda projects existing dated next actions; records and workflows stay shared.
    function agendaApplications() {
      const query = state.filters.pipeline.query.trim().toLocaleLowerCase();
      return state.applications.filter(app => inPipeline(app) && !waitingOnCompany(app) && app.nextAction.trim() && validDay(app.nextDue))
        .filter(app => !query || `${app.company} ${app.role} ${app.location} ${app.nextAction} ${app.waitingFor}`.toLocaleLowerCase().includes(query))
        .sort((a, b) => a.nextDue.localeCompare(b.nextDue) || a.nextAction.localeCompare(b.nextAction));
    }
    function agendaRow(app, showRole) {
      const days = dueDays(app), group = days < 0 ? 'overdue' : days === 0 ? 'today' : 'later';
      const identity = showRole ? `${app.company} · ${app.role}` : app.company;
      return `<div class="agenda-row ${group}" data-agenda-app="${esc(app.id)}"><label class="agenda-check"><input class="complete-task" type="checkbox" data-agenda-complete="${esc(app.id)}" aria-label="Complete task: ${esc(app.nextAction)} at ${esc(app.company)}" title="Complete task" ${state.busy ? 'disabled' : ''}></label><button class="agenda-open" type="button" data-agenda-open="${esc(app.id)}" aria-label="${esc(`${app.nextAction}, ${app.company}, ${app.role}, ${formatDay(app.nextDue, true)}`)}"><span class="agenda-title" title="${esc(app.nextAction)}">${esc(app.nextAction)}</span><span class="agenda-identity" title="${esc(`${app.company} · ${app.role}`)}">${esc(identity)}</span>${days < 0 ? `<span class="agenda-time overdue">${Math.abs(days)}d overdue</span>` : ''}</button></div>`;
    }
    function agendaMarkup() {
      const all = agendaApplications();
      const companyApps = new Map();
      for (const app of state.applications.filter(a => inPipeline(a) && !waitingOnCompany(a) && a.nextAction.trim())) {
        const key = app.company.trim().toLocaleLowerCase();
        if (!companyApps.has(key)) companyApps.set(key, new Set());
        companyApps.get(key).add(app.id);
      }
      const rows = apps => apps.map(app => agendaRow(app, companyApps.get(app.company.trim().toLocaleLowerCase()).size > 1)).join('');
      const weekday = new Date(dayIndex(today()) * DAY).getUTCDay();
      const start = dayIndex(today()) - (weekday + 6) % 7 + state.agendaWeek * 7;
      const dayAt = offset => new Date((start + offset) * DAY).toISOString().slice(0, 10);
      const end = dayAt(6);
      const range = dayAt(0).slice(0, 7) === end.slice(0, 7) ? `${formatDay(dayAt(0))}–${Number(end.slice(8))}` : `${formatDay(dayAt(0))}–${formatDay(end)}`;
      const overdueApps = state.agendaWeek === 0 ? all.filter(app => dueDays(app) < 0) : [];
      const overdue = overdueApps.length === 1 ? rows(overdueApps) : overdueApps.length ? `<details class="agenda-fold" data-agenda-overdue ${state.agendaOverdueOpen ? 'open' : ''}><summary>${overdueApps.length} overdue</summary>${rows(overdueApps)}</details>` : '';
      const dated = all.filter(app => dayIndex(app.nextDue) >= Math.max(start, dayIndex(today())) && dayIndex(app.nextDue) < start + 7);
      const schedule = [...new Set([...dated.map(app => app.nextDue), ...(overdue ? [today()] : [])])].sort().map(day => {
        const label = new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' }).format(new Date(dayIndex(day) * DAY)) + ` ${Number(day.slice(8))}`;
        const title = day === today() ? `Today · ${label}` : label;
        return `<section class="agenda-group" aria-label="${esc(title)}" data-agenda-day="${day}"><h3>${esc(title)}</h3>${day === today() ? overdue : ''}${rows(dated.filter(app => app.nextDue === day))}</section>`;
      }).join('');
      const query = state.filters.pipeline.query.trim();
      const clear = !schedule ? `<p class="agenda-clear">${query ? 'No matching items this week.' : 'Nothing scheduled this week.'}</p>` : '';
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const zoneLabel = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date()).find(part => part.type === 'timeZoneName')?.value || zone;
      return `<aside class="agenda" aria-label="Agenda"><header class="agenda-head"><h2>Agenda</h2><div class="agenda-week"><button type="button" data-agenda-week="-1" aria-label="Previous week">‹</button><time datetime="${dayAt(0)}" title="${esc(`${formatDay(dayAt(0), true)} – ${formatDay(end, true)}. ${zone}`)}">${esc(range)} · ${esc(zoneLabel)}</time><button type="button" data-agenda-week="1" aria-label="Next week">›</button></div></header><div class="agenda-scroll">${schedule}${clear}</div></aside>`;
    }

    function boardMarkup(apps) {
      return `<div class="mobile-stages" role="group" aria-label="Visible hiring stage">${COLUMNS.map(c => `<button type="button" data-mobile-stage="${c.key}" aria-pressed="${state.mobileStage === c.key}">${c.label} <span class="mono">${apps.filter(a => a.stage === c.key).length}</span></button>`).join('')}</div>
        <div class="board">${COLUMNS.map(c => {
          const items = apps.filter(a => a.stage === c.key);
          return `<section class="column${state.mobileStage === c.key ? ' mobile-current' : ''}" data-drop="${c.key}" aria-label="${c.label}"><header class="column-head"><h2>${c.label}</h2><span class="count">${items.length}</span></header><div class="column-stack">${items.map(cardMarkup).join('')}</div></section>`;
        }).join('')}</div>`;
    }

    function recordsCompanyMark(company) {
      const words = company.trim().split(/\s+/).filter(Boolean);
      const initials = words.length > 1 ? words.slice(0, 2).map(word => word[0]).join('') : (words[0] || '?').slice(0, 2);
      return `<span class="records-company-mark" aria-hidden="true">${esc(initials.toUpperCase())}</span>`;
    }
    function tableMarkup(apps, filtered = false) {
      const sent = state.view === 'sent';
      const pages = Math.max(1, Math.ceil(apps.length / PAGE_SIZE));
      state.page = Math.min(state.page, pages);
      const start = (state.page - 1) * PAGE_SIZE;
      const items = apps.slice(start, start + PAGE_SIZE);
      const allPageSelected = items.length && items.every(a => state.selected.has(a.id));
      const emptyRow = `<tr class="table-empty"><td colspan="6">${filtered ? 'No matching applications.' : sent ? 'No submitted applications yet.' : 'No closed applications.'}</td></tr>`;
      return `<div class="table-scroll"><table class="${sent ? 'sent' : 'closed'}-table"><caption class="sr-only">${sent ? 'Applications awaiting a response' : 'Closed applications'}</caption><thead><tr>${sent ? `<th class="check-cell"><input id="select-page" type="checkbox" aria-label="Select all applications on this page" ${allPageSelected ? 'checked' : ''}></th>` : ''}<th class="company-cell" scope="col">Company</th><th class="role-cell" scope="col"><span class="records-desktop-label">Role</span><span class="records-mobile-label">Application</span></th><th class="date-cell" scope="col">Submitted</th><th class="waiting-cell" scope="col">${sent ? 'Waiting' : 'Outcome'}</th>${sent ? '' : '<th class="last-stage-cell" scope="col">Last stage</th>'}<th class="action-cell" scope="col"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${items.map(a => {
          const days = age(a), mark = recordsCompanyMark(a.company);
          const identity = esc(`${a.company}, ${a.role}`);
          return `<tr data-row-open="${esc(a.id)}"${state.selected.has(a.id) ? ' class="selected"' : ''}>${sent ? `<td class="check-cell"><input type="checkbox" data-select="${esc(a.id)}" aria-label="Select ${identity}" ${state.selected.has(a.id) ? 'checked' : ''}></td>` : ''}<td class="company-cell"><span class="company-row">${mark}<button class="text-button records-company-name" type="button" data-open="${esc(a.id)}" title="${esc(a.company)}">${esc(a.company)}</button></span></td><td class="role-cell"><span class="records-identity"><span class="records-mobile-mark">${mark}</span><span class="records-copy"><button class="text-button role-title" type="button" data-open="${esc(a.id)}" aria-label="Open ${identity}" title="${esc(a.role)}">${esc(a.role)}</button><span class="records-mobile-company" title="${esc(a.company)}">${esc(a.company)}</span></span></span></td><td class="date-cell"><time class="table-date"${validDay(a.submittedAt) ? ` datetime="${esc(a.submittedAt)}" title="${esc(formatDay(a.submittedAt, true))}"` : ''}>${esc(formatDay(a.submittedAt))}</time></td><td class="waiting-cell">${sent ? `<span class="waiting${days >= 30 ? ' quiet' : ''}">${days === null ? '—' : days === 0 ? 'Today' : `${days} ${days === 1 ? 'day' : 'days'}`}</span>` : `<span class="outcome ${esc(a.closedReason)}">${REASONS[a.closedReason] || 'Closed'}</span>`}</td>${sent ? '' : `<td class="last-stage-cell"><span class="waiting">${LABELS[a.lastOpenStage] || 'Submitted'}</span></td>`}<td class="action-cell">${sent ? `<button class="button small records-row-action" type="button" data-response="${esc(a.id)}" aria-label="Record response for ${identity}">${icon('mail')}Record response</button>` : `<button class="button small records-row-action" type="button" data-restore="${esc(a.id)}" aria-label="Restore ${identity}">${icon('reset')}Restore</button>`}</td></tr>`;
        }).join('') || emptyRow}</tbody></table></div>
        <div class="pagination"><span>${apps.length ? `${(start + 1).toLocaleString()}–${Math.min(start + PAGE_SIZE, apps.length).toLocaleString()} of ${apps.length.toLocaleString()} applications` : '0 applications'}</span><div class="pagination-controls"><button class="button small" type="button" data-page="previous" ${state.page === 1 ? 'disabled' : ''}>Previous</button><span class="mono">${state.page} / ${pages}</span><button class="button small" type="button" data-page="next" ${state.page >= pages ? 'disabled' : ''}>Next</button></div></div>`;
    }

    function render() {
      const overdueFold = $('[data-agenda-overdue]');
      if (overdueFold) state.agendaOverdueOpen = overdueFold.open;
      const offsets = Object.fromEntries($$('.column').map(c => [c.dataset.drop, c.querySelector('.column-stack').scrollTop]));
      const agendaScroll = $('.agenda-scroll')?.scrollTop || 0;
      const boardLeft = $('.board-pane')?.scrollLeft || 0;
      const tableScroll = $('.table-scroll')?.scrollTop || 0;
      const tableLeft = $('.table-scroll')?.scrollLeft || 0;
      renderHeader();
      const apps = visibleApplications();
      const f = currentFilters();
      const filtered = Boolean(f.query.trim() || (f.age && f.age !== 'all') || (f.outcome && f.outcome !== 'all'));
      const selectedCount = state.view === 'sent' ? [...state.selected].filter(id => byId(id)?.stage === 'sent').length : 0;
      $('#records-bulk').hidden = !selectedCount;
      $('#selected-count').textContent = selectedCount ? `${selectedCount.toLocaleString()} selected` : '';
      $('#age-control').hidden = state.view !== 'sent' || Boolean(selectedCount);
      const total = state.applications.filter(a => viewFor(a.stage) === state.view).length;
      $('#result-count').hidden = !filtered || Boolean(selectedCount);
      $('#result-count').textContent = filtered ? `${apps.length.toLocaleString()} of ${total.toLocaleString()}` : '';
      $('#panel').innerHTML = state.loading ? '<div class="empty-state" role="status">Loading applications…</div>' : state.error ? `<div class="empty-state"><h2>Could not load applications</h2><p>${esc(state.error)}</p><button class="button" type="button" data-action="retry">Try again</button></div>` : state.view === 'pipeline' ? `<div class="progress-layout">${agendaMarkup()}<div class="board-pane">${boardMarkup(apps)}</div></div>` : tableMarkup(apps, filtered);
      $$('.column').forEach(c => { c.querySelector('.column-stack').scrollTop = offsets[c.dataset.drop] || 0; });
      if ($('.table-scroll')) { $('.table-scroll').scrollTop = tableScroll; $('.table-scroll').scrollLeft = tableLeft; }
      if ($('.agenda-scroll')) $('.agenda-scroll').scrollTop = agendaScroll;
      if ($('.board-pane')) $('.board-pane').scrollLeft = boardLeft;
      updatePageCheckbox();
    }

    function switchView(view, focus = false) {
      state.view = view; state.page = 1; state.selected.clear();
      $('#search').value = currentFilters().query;
      render();
      if (focus) $(`#tab-${view}`).focus();
    }

    let toastTimer, dialogOrder = 0;
    function showToast(message, undo) {
      clearTimeout(toastTimer);
      const toast = $('#toast');
      toast.replaceChildren();
      const text = document.createElement('span');
      text.textContent = message;
      toast.append(text);
      if (undo) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Undo';
        button.addEventListener('click', async () => { if (state.busy) return; toast.classList.remove('visible'); clearTimeout(toastTimer); await undo(); $('#panel').focus({ preventScroll: true }); }, { once: true });
        toast.append(button);
      }
      toast.classList.add('visible');
      toastTimer = setTimeout(() => { if (!toast.contains(document.activeElement)) toast.classList.remove('visible'); }, undo ? 12000 : 6000);
    }

    function showSaveError(message) {
      const dialog = $$('dialog[open]').sort((a, b) => (a.openedOrder || 0) - (b.openedOrder || 0)).at(-1);
      if (dialog) {
        let alert = dialog.querySelector('[data-save-error]');
        if (!alert) {
          alert = document.createElement('p'); alert.dataset.saveError = '';
          alert.setAttribute('role', 'alert'); alert.className = 'save-error';
          (dialog.querySelector('.form-body, .drawer-body') || dialog).append(alert);
        }
        alert.textContent = message; alert.scrollIntoView({ block: 'nearest' });
      }
      showToast(message);
    }

    async function commit(ids, apply, message, undoable = true) {
      if (state.busy) return false;
      const before = [...new Set(ids)].map(byId).filter(Boolean).map(clone);
      setBusy(true);
      const succeeded = [], failed = [];
      // Bound requests for bulk work; preserve server IDs and update each record.
      for (let cursor = 0; cursor < before.length; cursor += 6) {
        await Promise.all(before.slice(cursor, cursor + 6).map(async old => {
          const desired = clone(old); apply(desired);
          try {
            const saved = fromAPI(await api.applications.update(old.id, toAPI(desired, desired.events[0]?.text)));
            replaceApplication(saved); succeeded.push(old);
          } catch (error) { failed.push({ old, error }); }
        }));
      }
      setBusy(false); state.selected = new Set(failed.map(f => f.old.id)); render();
      if ($('#drawer').open && succeeded.some(a => a.id === state.selectedId)) renderDrawer();
      const feedback = failed.length ? `${succeeded.length} updated; ${failed.length} could not be saved. ${failed[0].error.message}` : message;
      if (failed.length && !succeeded.length) { showSaveError(feedback); return false; }
      showToast(feedback, undoable && succeeded.length ? async () => {
        if (state.busy) return;
        setBusy(true); const undoFailed = [];
        for (const old of succeeded) {
          try { replaceApplication(fromAPI(await api.applications.update(old.id, toAPI(old, 'Change undone')))); }
          catch (error) { undoFailed.push(error); }
        }
        setBusy(false); state.selected.clear(); render();
        if ($('#drawer').open) renderDrawer();
        showToast(undoFailed.length ? `${undoFailed.length} changes could not be undone. ${undoFailed[0].message}` : 'Change undone.');
      } : null);
      return failed.length === 0;
    }

    function addEvent(app, text) {
      app.updatedAt = new Date().toISOString();
      app.events.unshift({ at: app.updatedAt, text });
    }
    function setStage(app, stage, reason = null) {
      if (stage === 'closed') { if (app.stage !== 'closed') app.lastOpenStage = app.stage; app.closedReason = reason; }
      else { app.closedReason = null; app.lastOpenStage = stage; }
      app.stage = stage;
      addEvent(app, stage === 'closed' ? `Closed · ${REASONS[reason]}` : `Moved to ${LABELS[stage]}`);
    }

    function openDialog(id) {
      const dialog = $(`#${id}`);
      if (dialog.open) return;
      dialog.opener = document.activeElement;
      dialog.openedOrder = ++dialogOrder;
      dialog.showModal();
    }
    function closeDialog(id) { if ($(`#${id}`).open) $(`#${id}`).close(); }

    function openClosure(id) {
      const app = byId(id);
      if (!app || app.stage === 'closed') return;
      state.closureId = id;
      $('#close-form').reset();
      $('#close-form [data-save-error]')?.remove();
      $('#close-context').textContent = `${app.company} · ${app.role}`;
      openDialog('close-dialog');
    }

    function renderDrawer() {
      const app = byId(state.selectedId); if (!app) return;
      const closed = app.stage === 'closed';
      const url = safeUrl(app.url), snapshotDisabled = app.external ? '' : 'disabled';
      $('#drawer-content').innerHTML = `<form id="detail-form" class="drawer-form"><header class="drawer-head">${companyMark(app.company)}<div class="drawer-title"><h2 id="drawer-title">${esc(app.role)}</h2><p>${esc(app.company)}</p></div><button class="icon-button" type="button" data-close="drawer" aria-label="Close application details" autofocus>${icon('close')}</button></header>
        <div class="drawer-body"><div class="form-grid"><label class="field ${closed ? '' : 'full'}">Stage<select name="stage" id="detail-stage">${STAGES.map(s => `<option value="${s}" ${app.stage === s ? 'selected' : ''}>${LABELS[s]}${s === 'sent' ? ' · awaiting a response' : ''}</option>`).join('')}</select></label><label class="field" id="detail-reason-field" ${closed ? '' : 'hidden'}>Outcome<select name="closedReason" ${closed ? 'required' : 'disabled'}><option value="">Choose an outcome</option>${Object.entries(REASONS).map(([value, label]) => `<option value="${value}" ${app.closedReason === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label class="field">Company<input ${snapshotDisabled} name="company" required maxlength="200" value="${esc(app.company)}"></label><label class="field">Role<input ${snapshotDisabled} name="role" required maxlength="500" value="${esc(app.role)}"></label>
        <label class="field">Date submitted<input name="submittedAt" type="date" max="${today()}" value="${esc(app.submittedAt)}"></label><label class="field">Location<input ${snapshotDisabled} name="location" maxlength="200" value="${esc(app.location)}" placeholder="Optional"></label>
        <label class="field full">Posting URL<input ${snapshotDisabled} name="url" type="url" maxlength="2000" value="${esc(app.url)}" placeholder="https://… (optional)"></label>
        <label class="field full">Whose move?<select name="taskState" id="detail-task-state"><option value="action" ${!waitingOnCompany(app) ? 'selected' : ''}>Mine · I have a task to do</option><option value="waiting" ${waitingOnCompany(app) ? 'selected' : ''}>Company · waiting for a response</option></select></label>
        <label class="field full" id="detail-waiting-field" ${waitingOnCompany(app) ? '' : 'hidden'}>Waiting for<input name="waitingFor" maxlength="500" value="${esc(app.waitingFor)}" placeholder="Optional context" ${waitingOnCompany(app) ? '' : 'disabled'}></label>
        <label class="field" id="detail-next-action-field" ${waitingOnCompany(app) ? 'hidden' : ''}>Next task<input name="nextAction" maxlength="500" value="${esc(app.nextAction)}" placeholder="What happens next?" ${waitingOnCompany(app) ? 'disabled' : ''}></label><label class="field" id="detail-next-due-field" ${waitingOnCompany(app) ? 'hidden' : ''}>Due date<input name="nextDue" type="date" value="${esc(app.nextDue)}" ${waitingOnCompany(app) ? 'disabled' : ''}></label>
        <label class="field full">Resume sent<input name="resumeVariant" maxlength="200" value="${esc(app.resumeVariant)}" placeholder="Optional"></label><label class="field full">Notes<textarea name="notes" maxlength="8000" rows="4" placeholder="People, prep, resume version, or anything to remember…">${esc(app.notes)}</textarea></label></div>
        <h3 class="section-heading">Activity</h3><ol class="history">${app.events.map(e => `<li><strong>${esc(String(e.text).replace(/\bSent\b/g, 'Submitted'))}</strong><time datetime="${esc(e.at)}">${esc(formatDay(String(e.at).slice(0, 10), true))}</time></li>`).join('')}</ol></div>
        <footer class="dialog-foot drawer-foot">${closed ? `<button class="button ghost" type="button" data-restore="${esc(app.id)}">${icon('reset')}Restore</button>` : `<button class="button ghost danger" type="button" data-action="close-application">Close application</button>`}${url ? `<a class="button ghost" href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="Open posting in a new tab">${icon('external')}Posting</a>` : ''}${app.stage === 'sent' ? `<button class="button" type="button" data-response="${esc(app.id)}">Record response</button>` : inPipeline(app) && !waitingOnCompany(app) && app.nextAction ? `<button class="button" type="button" data-complete="${esc(app.id)}">Complete task</button>` : ''}<button class="button" type="button" data-action="tailor-resume">Tailor resume</button><button class="button primary" type="submit">Save changes</button></footer></form>`;
    }

    async function openApplication(id) {
      if (!byId(id) || state.busy) return;
      setBusy(true);
      try {
        replaceApplication(fromAPI(await api.applications.get(id)));
        state.selectedId = id; renderDrawer(); openDialog('drawer');
      } catch (error) { showToast(`Could not open application. ${error.message}`); }
      finally { setBusy(false); }
    }
    function openResponse(id) {
      const app = byId(id); if (!app) return;
      state.responseId = id;
      $('#response-form').reset();
      $('#response-context').innerHTML = `${companyMark(app.company)}<div><strong>${esc(app.company)}</strong><span>${esc(app.role)}</span></div>`;
      $('#response-form').elements.nextAction.value = app.nextAction || '';
      $('#response-form').elements.nextDue.value = app.nextDue || '';
      updateResponseFields(); openDialog('response-dialog');
    }
    function updateResponseFields() {
      const stage = $('#response-form').elements.response.value;
      const rejected = stage === 'rejected';
      $('#response-next-fields').hidden = rejected;
      $('#response-form').elements.nextAction.disabled = rejected;
      $('#response-form').elements.nextDue.disabled = rejected;
      $('#response-submit').innerHTML = `${rejected ? 'Close as rejected' : `Move to ${LABELS[stage]}`} ${icon(rejected ? 'archive' : 'arrow')}`;
    }
    function openCompletion(id) {
      const app = byId(id);
      if (!app || !inPipeline(app) || waitingOnCompany(app) || !app.nextAction) return;
      state.completionId = id;
      $('#complete-form').reset();
      $('#complete-form').elements.nextAction.setCustomValidity('');
      $('#complete-context').textContent = `${app.nextAction} · ${app.company}`;
      updateCompletionFields();
      openDialog('complete-dialog');
    }
    function updateCompletionFields() {
      const form = $('#complete-form'), anotherTask = form.elements.after.value === 'action';
      $('#complete-next-fields').hidden = !anotherTask;
      $('#complete-waiting-field').hidden = anotherTask;
      form.elements.nextAction.disabled = !anotherTask;
      form.elements.nextAction.required = anotherTask;
      form.elements.nextDue.disabled = !anotherTask;
      form.elements.waitingFor.disabled = anotherTask;
    }
    function updateTaskFields() {
      const waiting = $('#detail-task-state').value === 'waiting';
      for (const id of ['detail-next-action-field', 'detail-next-due-field']) {
        $(`#${id}`).hidden = waiting;
        $(`#${id} input`).disabled = waiting;
      }
      $('#detail-waiting-field').hidden = !waiting;
      $('#detail-waiting-field input').disabled = !waiting;
    }
    async function restore(id) {
      const app = byId(id); if (!app || app.stage !== 'closed') return;
      const stage = app.lastOpenStage || 'sent';
      const saved = await commit([id], a => { setStage(a, stage); a.events[0].text = `Restored to ${LABELS[stage]}`; }, `${app.company} restored to ${LABELS[stage]}.`);
      if (!saved) return;
      closeDialog('drawer');
      state.mobileStage = stage === 'sent' ? state.mobileStage : stage;
      switchView(viewFor(stage));
    }
    function updatePageCheckbox() {
      const box = $('#select-page'); if (!box) return;
      const boxes = $$('[data-select]');
      box.disabled = state.busy || boxes.length === 0;
      box.indeterminate = boxes.some(b => b.checked) && !boxes.every(b => b.checked);
    }
    function restoreCheckboxFocus(id) {
      render();
      const checkbox = $$('[data-select]').find(b => b.dataset.select === id);
      (checkbox || $('#select-page') || $('#panel')).focus({ preventScroll: true });
    }

    if (typeof module !== 'undefined' && module.exports) module.exports = { fromAPI, toAPI, age, dueDays, validDay, viewFor, taskGroup, STAGES, state, visibleApplications };
    if (typeof document === 'undefined') return;

    document.addEventListener('click', async event => {
      if (state.busy) return;
      const target = event.target.closest('button, a');
      if (!target) {
        const row = event.target.closest('[data-row-open]');
        if (row && !event.target.closest('input, select, textarea, label') && !window.getSelection()?.toString()) {
          // The role button remains the keyboard and return-focus target.
          row.querySelector('.role-title').focus({ preventScroll: true });
          return openApplication(row.dataset.rowOpen);
        }
        return;
      }
      if (target.dataset.agendaWeek) {
        state.agendaWeek += Number(target.dataset.agendaWeek);
        render(); $('.agenda-scroll').scrollTop = 0;
        $(`[data-agenda-week="${target.dataset.agendaWeek}"]`).focus({ preventScroll: true });
        return;
      }
      if (target.dataset.close) return closeDialog(target.dataset.close);
      if (target.dataset.view) return switchView(target.dataset.view, true);
      if (target.dataset.agendaOpen) return openApplication(target.dataset.agendaOpen);
      if (target.dataset.complete) return openCompletion(target.dataset.complete);
      if (target.dataset.open) return openApplication(target.dataset.open);
      if (target.dataset.response) return openResponse(target.dataset.response);
      if (target.dataset.restore) return restore(target.dataset.restore);
      if (target.dataset.mobileStage) {
        state.mobileStage = target.dataset.mobileStage; render();
        $(`[data-mobile-stage="${state.mobileStage}"]`).focus({ preventScroll: true }); return;
      }
      if (target.dataset.page) {
        state.page += target.dataset.page === 'next' ? 1 : -1; render();
        if ($('.table-scroll')) $('.table-scroll').scrollTop = 0;
        $('#panel').focus({ preventScroll: true }); return;
      }
      switch (target.dataset.action) {
        case 'log': $('#log-form').reset(); $('#log-form').elements.submittedAt.value = today(); $('#log-form').elements.submittedAt.max = today(); openDialog('log-dialog'); break;
        case 'retry': state.loading = true; state.error = ''; render(); await loadApplications(); break;
        case 'tailor-resume': {
          const app = byId(state.selectedId); if (!app) break;
          setBusy(true);
          try {
            const target = await api.resumes.targetFromApplication(app.id);
            window.location.assign(`/resume/#target=${encodeURIComponent(target.id)}`);
          } catch (error) { showToast(error.message); }
          finally { setBusy(false); }
          break;
        }
        case 'go-sent': switchView('sent', true); break;
        case 'clear-filters': {
          const f = currentFilters(); f.query = ''; if (f.age) f.age = 'all'; if (f.outcome) f.outcome = 'all'; $('#search').value = ''; state.page = 1; render(); $('#search').focus(); break;
        }
        case 'clear-selection': state.selected.clear(); render(); $('#select-page')?.focus(); break;
        case 'bulk-close': {
          const ids = [...state.selected].filter(id => byId(id)?.stage === 'sent');
          if (!ids.length) break;
          await commit(ids, a => setStage(a, 'closed', 'no_reply'), `${ids.length} application${ids.length === 1 ? '' : 's'} closed as no reply.`); $('#panel').focus(); break;
        }
        case 'close-application': {
          openClosure(state.selectedId); break;
        }
      }
    });

    function updateDetailReason() {
      const closed = $('#detail-stage').value === 'closed';
      const field = $('#detail-reason-field'), select = field.querySelector('select');
      field.hidden = !closed; select.disabled = !closed; select.required = closed;
      $('#detail-stage').closest('label').classList.toggle('full', !closed);
    }
    document.addEventListener('change', event => {
      const el = event.target;
      if (el.dataset.agendaComplete) {
        el.checked = false;
        if (!state.busy) openCompletion(el.dataset.agendaComplete);
        return;
      }
      if (el.id === 'sort') { currentFilters().sort = el.value; state.page = 1; render(); }
      if (el.id === 'age-filter') { state.filters.sent.age = el.value; state.selected.clear(); state.page = 1; render(); }
      if (el.id === 'outcome-filter') { state.filters.closed.outcome = el.value; state.page = 1; render(); }
      if (el.id === 'detail-stage') updateDetailReason();
      if (el.name === 'response') updateResponseFields();
      if (el.name === 'after') updateCompletionFields();
      if (el.id === 'detail-task-state') updateTaskFields();
      if (el.dataset.select) { if (el.checked) state.selected.add(el.dataset.select); else state.selected.delete(el.dataset.select); restoreCheckboxFocus(el.dataset.select); }
      if (el.id === 'select-page') {
        const ids = $$('[data-select]').map(b => b.dataset.select);
        for (const id of ids) { if (el.checked) state.selected.add(id); else state.selected.delete(id); }
        render(); $('#select-page').focus({ preventScroll: true });
      }
    });
    function highlightAgendaApplication(id) {
      $$('.card').forEach(card => card.classList.toggle('agenda-hover', card.dataset.drag === id));
    }
    for (const name of ['mouseover', 'focusin']) document.addEventListener(name, event => {
      const row = event.target.closest('.agenda-row');
      if (row) highlightAgendaApplication(row.dataset.agendaApp);
    });
    for (const name of ['mouseout', 'focusout']) document.addEventListener(name, event => {
      const row = event.target.closest('.agenda-row');
      if (row && !row.contains(event.relatedTarget)) highlightAgendaApplication(null);
    });
    document.addEventListener('toggle', event => {
      if (event.target.isConnected && event.target.matches('[data-agenda-overdue]')) state.agendaOverdueOpen = event.target.open;
    }, true);

    $('#search').addEventListener('input', event => {
      currentFilters().query = event.target.value; state.page = 1; state.selected.clear(); render();
    });
    // Trim required text before native validation so whitespace-only names are
    // rejected without adding a second, conflicting validation system.
    document.addEventListener('input', event => { if (['company', 'role'].includes(event.target.name)) event.target.setCustomValidity(event.target.value.trim() ? '' : 'Enter a name.'); });
    $('#complete-form [name="nextAction"]').addEventListener('input', event => event.target.setCustomValidity(event.target.value.trim() ? '' : 'Enter the next task.'));
    document.addEventListener('submit', async event => {
      const form = event.target;
      if (!['log-form', 'response-form', 'detail-form', 'complete-form', 'close-form'].includes(form.id)) return;
      event.preventDefault();
      if (state.busy) return;
      form.querySelector('[data-save-error]')?.remove();
      const data = new FormData(form), text = key => String(data.get(key) || '').trim();
      if (form.id === 'close-form') {
        const app = byId(state.closureId), reason = text('closedReason');
        if (!app || app.stage === 'closed' || !Object.hasOwn(REASONS, reason)) return;
        const saved = await commit([app.id], a => setStage(a, 'closed', reason), `${app.company} closed as ${REASONS[reason].toLowerCase()}.`);
        if (saved) { closeDialog('close-dialog'); closeDialog('drawer'); }
        return;
      }
      if (form.id === 'log-form') {
        setBusy(true);
        try {
          const app = fromAPI(await api.applications.createExternal({ company: text('company'), title: text('role'), submitted_at: text('submittedAt'), location: text('location'), url: text('url'), note: text('notes') }));
          state.applications.unshift(app);
          closeDialog('log-dialog'); state.filters.sent.query = ''; state.filters.sent.age = 'all';
          switchView('sent', true); showToast(`${app.company} added to Submitted.`);
        } catch (error) { showSaveError(`Could not add application. ${error.message}`); }
        finally { setBusy(false); }
        return;
      }
      if (form.id === 'complete-form') {
        const app = byId(state.completionId);
        if (!app || !inPipeline(app) || waitingOnCompany(app) || !app.nextAction) return;
        const completedTask = app.nextAction, after = text('after');
        const saved = await commit([app.id], a => {
          a.taskState = after; a.nextAction = after === 'action' ? text('nextAction') : '';
          a.nextDue = after === 'action' ? text('nextDue') : '';
          a.waitingFor = after === 'waiting' ? text('waitingFor') : '';
          addEvent(a, `Completed: ${completedTask}`);
        }, after === 'waiting' ? `${app.company}: task done. Waiting on company.` : `${app.company}: task done. Next step added.`);
        if (saved) { closeDialog('complete-dialog'); closeDialog('drawer'); $('#panel').focus({ preventScroll: true }); }
        return;
      }
      if (form.id === 'response-form') {
        const app = byId(state.responseId); if (!app) return;
        const response = text('response'), rejected = response === 'rejected';
        const saved = await commit([app.id], a => {
          if (!rejected) { a.nextAction = text('nextAction'); a.nextDue = text('nextDue'); a.taskState = 'action'; a.waitingFor = ''; }
          setStage(a, rejected ? 'closed' : response, rejected ? 'rejected' : null);
        }, `${app.company} ${rejected ? 'closed as rejected' : `moved to ${LABELS[response]}`}.`);
        if (!saved) return;
        closeDialog('response-dialog'); closeDialog('drawer');
        if (!rejected) { state.filters.pipeline.query = ''; state.mobileStage = response; switchView('pipeline', true); }
        else { render(); $('#panel').focus({ preventScroll: true }); }
        return;
      }
      const app = byId(state.selectedId); if (!app) return;
      const stage = text('stage'), previousStage = app.stage;
      const reason = stage === 'closed' ? text('closedReason') : null;
      const fields = ['notes', 'resumeVariant', 'nextAction', 'submittedAt', 'nextDue', 'taskState', 'waitingFor', ...(app.external ? ['company', 'role', 'location', 'url'] : [])];
      const changes = Object.fromEntries(fields.map(key => [key, text(key)]));
      const changed = fields.some(key => changes[key] !== app[key]) || stage !== app.stage || reason !== app.closedReason;
      if (!changed) { closeDialog('drawer'); return; }
      const saved = await commit([app.id], a => {
        Object.assign(a, changes);
        if (stage !== a.stage || reason !== a.closedReason) setStage(a, stage, reason);
        else addEvent(a, 'Application details updated');
      }, stage === previousStage ? 'Application updated.' : `${app.company} moved to ${stage === 'closed' ? REASONS[reason] : LABELS[stage]}.`);
      if (!saved) return;
      closeDialog('drawer');
      if (stage !== previousStage) { if (COLUMNS.some(c => c.key === stage)) state.mobileStage = stage; switchView(viewFor(stage), true); }
    });

    document.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !$$('dialog').some(d => d.open)) { event.preventDefault(); $('#search').focus(); $('#search').select(); }
      const tab = event.target.closest('[role="tab"]');
      if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const views = ['pipeline', 'sent', 'closed']; let i = views.indexOf(tab.dataset.view);
        i = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (i + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
        switchView(views[i], true);
      }
      const task = event.target.closest('.card-open');
      if (task && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
        const rows = [...task.closest('.column-stack').querySelectorAll('.card-open')], index = rows.indexOf(task);
        const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
        if (next) { event.preventDefault(); next.focus(); }
      }
    });

    document.addEventListener('dragstart', event => {
      if (state.busy) { event.preventDefault(); return; }
      if (event.target.closest('[data-complete]')) { event.preventDefault(); return; }
      const card = event.target.closest('[data-drag]'); if (!card) return;
      state.dragId = card.dataset.drag; card.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', state.dragId);
    });
    document.addEventListener('dragover', event => {
      const column = event.target.closest('[data-drop]'); if (!column || !state.dragId) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'move'; column.classList.add('drag-over');
    });
    document.addEventListener('dragleave', event => { const column = event.target.closest('[data-drop]'); if (column && !column.contains(event.relatedTarget)) column.classList.remove('drag-over'); });
    document.addEventListener('drop', async event => {
      const column = event.target.closest('[data-drop]'), app = byId(state.dragId);
      if (!column || !app) return;
      event.preventDefault(); const stage = column.dataset.drop; state.dragId = null;
      if (app.stage === stage) { column.classList.remove('drag-over'); return; }
      state.flashId = app.id;
      await commit([app.id], a => setStage(a, stage), `${app.company} moved to ${LABELS[stage]}.`);
    });
    document.addEventListener('dragend', () => { state.dragId = null; $$('.dragging, .drag-over').forEach(el => el.classList.remove('dragging', 'drag-over')); });

    $$('dialog').forEach(dialog => {
      // Backdrop clicks close only when both pointer endpoints are outside the
      // dialog, avoiding lost edits from a text-selection drag that ends outside.
      dialog.addEventListener('cancel', event => { if (state.busy) event.preventDefault(); });
      let startedOutside = false;
      const outside = event => { const r = dialog.getBoundingClientRect(); return event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom; };
      dialog.addEventListener('pointerdown', event => { startedOutside = event.target === dialog && outside(event); });
      dialog.addEventListener('click', event => { if (!state.busy && startedOutside && event.target === dialog && outside(event)) dialog.close(); startedOutside = false; });
      dialog.addEventListener('close', () => {
        // A record may disappear from its old view after a move. Restore focus
        // to the active tab when its original opener no longer exists.
        const opener = dialog.opener;
        if ($$('dialog').some(d => d.open)) return;
        if (opener?.isConnected) opener.focus({ preventScroll: true });
        else $(`#tab-${state.view}`).focus({ preventScroll: true });
      });
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) loadApplications(); });
    window.addEventListener('storage', async event => {
      if (event.key === 'oneshot.visitor-data.state.v1' && await window.OneShotVisitorData.isLocal()) window.location.reload();
    });
    render();
    loadApplications();
  })();

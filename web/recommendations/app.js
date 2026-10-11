import { api } from '../shared/api.js';
import { guest } from '../shared/guest.js';
import { esc } from '../shared/util.js';
import { csv, isTracked, views, visibleJobs } from './core.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const fields = ['search','category','term','fit','gpa'];
const state = { data:null, applications:[], trackingReady:false, rows:50, pending:new Set(), undo:new Map(),
  filters:{view:Object.hasOwn(views,params.get('view')) ? params.get('view') : 'ready',search:params.get('q') || '',category:params.get('category') || '',term:params.get('term') || '',fit:params.get('fit') || '',gpa:params.get('gpa') || '',hideApplied:params.get('applied') !== 'show'} };
let toastTimer;
function toast(message, undoId) {
  $('toast').textContent = message;
  if (undoId) {const button=document.createElement('button');button.textContent='Undo';button.type='button';button.addEventListener('click',()=>undo(undoId));$('toast').append(button);}
  $('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,12000);
}
const dateLabel = value => value ? new Date(`${value.slice(0,10)}T12:00:00`).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : 'Date unconfirmed';
const fitLabel = fit => ({1:'Strongest fit',2:'Good fit',3:'Adjacent fit'})[fit] || 'Review';
function rowMarkup(job) {
  const applied=isTracked(job,state.applications),pending=state.pending.has(String(job.id));
  const conditions=job.conditions?.length ? `<div class="conditions">${job.conditions.map(c=>`<p>${esc(c)}</p>`).join('')}</div>` : '';
  const add=['ready','conditional'].includes(job.view) ? `<button class="add${applied ? ' applied' : ''}" type="button" data-add="${job.id}" ${applied || pending || !state.trackingReady ? 'disabled' : ''}>${pending ? 'Saving…' : applied ? '✓ Added to Applied' : '+ Add to Applied'}</button>` : '';
  const undo=state.undo.has(String(job.id)) ? `<button class="undo" type="button" data-undo="${job.id}" ${pending ? 'disabled' : ''}>Undo</button>` : '';
  const source=job.date_basis==='employer' ? 'Employer posting date' : job.date_basis==='listing' ? 'Listing date; employer date unconfirmed' : 'Discovery date; opening date unconfirmed';
  const verified=job.link_state==='verified' ? 'Employer details verified' : job.link_state==='page_available' ? 'Employer page available' : job.link_state==='closed' ? 'Closed / unavailable' : 'Live link could not be verified';
  const gpa=job.gpa_min != null ? `<span>GPA minimum ${job.gpa_min}</span>` : '<span>No stated GPA minimum</span>';
  const preferred=job.gpa_preferred != null ? `<span>GPA ${job.gpa_preferred} preferred</span>` : '';
  return `<article class="job${applied ? ' is-applied' : ''}" id="job-${job.id}"><span class="rank">${job.rank ? `#${job.rank}` : '—'}</span><div>
    <div class="job-top"><span class="company">${esc(job.company)}</span><div class="badges">${job.view==='excluded' ? '' : `<span class="badge${job.fit===1 ? ' strong' : ''}">${fitLabel(job.fit)}</span>`}<span class="badge">${esc(job.category)}</span>${job.view==='conditional' ? '<span class="badge condition">Check conditions</span>' : ''}</div></div>
    <h3>${esc(job.title)}</h3><div class="facts"><span>${esc(job.location)}</span><span>${esc(job.term)}</span><span>${job.date_basis==='employer' ? 'Posted' : 'Listed / discovered'} ${dateLabel(job.posted_day)}</span>${job.deadline_day ? `<span class="deadline">Deadline ${dateLabel(job.deadline_day)}</span>` : ''}${gpa}${preferred}</div>
    <p class="why">${esc(job.reason)}</p>${conditions}
    <div class="actions"><a href="${esc(job.apply_url)}" target="_blank" rel="noopener noreferrer">View employer posting ↗</a>${add}${undo}</div>
    <details class="evidence"><summary>Eligibility &amp; sources</summary><p>${esc(job.evidence || 'Full eligibility details were unavailable at review time.')}</p><p>${esc(job.gpa_note || '')}</p><p>${esc(source)} · ${esc(verified)} · OneShot posting ${job.id}${job.aliases?.length ? ` · ${job.aliases.length} duplicate listing${job.aliases.length>1 ? 's' : ''} collapsed` : ''}</p><div class="skills">${(job.skills || []).slice(0,16).map(s=>`<span>${esc(s.replaceAll('-',' '))}</span>`).join('')}</div></details>
  </div></article>`;
}
const filtered = () => visibleJobs(state.data?.jobs || [],state.filters,state.applications);
function syncURL() {
  const p=new URLSearchParams();
  for (const [key,value] of [['view',state.filters.view==='ready' ? '' : state.filters.view],['q',state.filters.search],['category',state.filters.category],['term',state.filters.term],['fit',state.filters.fit],['gpa',state.filters.gpa],['applied',state.filters.hideApplied ? '' : 'show']]) if(value)p.set(key,value);
  history.replaceState(null,'',`${location.pathname}${p.size ? `?${p}` : ''}${location.hash}`);
}
function render() {
  if(!state.data)return;
  const rows=filtered();
  $('result-count').textContent=`${rows.length.toLocaleString()} ${views[state.filters.view].toLowerCase()} · showing ${Math.min(rows.length,state.rows)}`;
  $('jobs').innerHTML=rows.length ? rows.slice(0,state.rows).map(rowMarkup).join('') : '<div class="empty">No jobs match these filters. Try another review group or clear a filter.</div>';
  $('more').hidden=rows.length<=state.rows;$('more').textContent=`Show next ${Math.min(50,rows.length-state.rows)} jobs`;
  $('view-note').textContent={ready:'',conditional:'Worthwhile if the stated condition works for you. Check graduation changes, GPA thresholds, clearance and program requirements before applying.',unverified:'Outside the confirmed queue: opening date or full eligibility remains unconfirmed. A recent listing or discovery alone does not establish a new opening.',excluded:'Removed for a concrete mismatch, old opening date, expired deadline or closure. These appear for transparency.'}[state.filters.view];
  document.querySelectorAll('[data-view]').forEach(button=>{button.setAttribute('aria-pressed',String(button.dataset.view===state.filters.view));button.querySelector('span').textContent=state.data.jobs.filter(j=>j.view===button.dataset.view && (!state.filters.hideApplied || !isTracked(j,state.applications))).length.toLocaleString();});
  syncURL();
}
async function add(id) {
  const job=state.data.jobs.find(j=>String(j.id)===id);
  if(!job || !state.trackingReady || state.pending.has(id) || isTracked(job,state.applications))return;
  state.pending.add(id);render();
  try {const application=await api.jobs.addToApplications(job.id,job);state.applications.push(application);if(!application.already_exists)state.undo.set(id,application.id);toast(`${job.company} added to Applied.`,application.already_exists ? null : id);}
  catch(error){toast(`Could not save: ${error.message}`);}
  finally{state.pending.delete(id);render();}
}
async function undo(id) {
  const applicationId=state.undo.get(id);if(!applicationId || state.pending.has(id))return;
  state.pending.add(id);render();
  try {await api.applications.remove(applicationId);state.applications=state.applications.filter(a=>String(a.id)!==String(applicationId));state.undo.delete(id);toast('Removed from Applied.');}
  catch(error){toast(`Could not undo: ${error.message}`);}
  finally{state.pending.delete(id);render();}
}
async function refreshTracking() {
  try {state.applications=(await api.applications.list()).applications || [];state.trackingReady=true;render();}
  catch(error){state.trackingReady=false;render();toast(`Applied tracker unavailable: ${error.message}`);}
}
async function init() {
  try {
    const response=await fetch('./data.json',{cache:'no-cache'});if(!response.ok)throw Error(`Review data unavailable (${response.status})`);state.data=await response.json();
    const m=state.data.metrics;$('stats').innerHTML=[[m.recent_universe,'recent postings screened'],[m.ready,'ready to apply'],[m.conditional,'with an eligibility condition'],[m.excluded,'relevant roles excluded']].map(([n,label])=>`<div class="stat"><b>${Number(n).toLocaleString()}</b><span>${label}</span></div>`).join('');
    $('methodology').innerHTML=state.data.methodology.map(p=>`<p>${esc(p)}</p>`).join('');
    $('category').innerHTML += [...new Set(state.data.jobs.map(j=>j.category).filter(Boolean))].sort().map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
    for(const id of fields){$(id).value=state.filters[id];state.filters[id]=$(id).value;}
    $('hide-applied').checked=state.filters.hideApplied;$('download').disabled=false;render();
    if(location.hash)document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }catch(error){$('jobs').innerHTML=`<div class="empty error" role="alert">${esc(error.message)}. Reload to retry.</div>`;}
  try {const account=await guest.account();$('identity').innerHTML=account ? `<span>Signed in · ${esc(account.name || 'OneShot account')}</span>` : 'Guest · Saved in this browser · <a href="/api/auth/login">Sign in</a>';await refreshTracking();}
  catch(error){$('identity').textContent='Workspace could not be loaded';toast(error.message);}
}
document.querySelector('.tabs').addEventListener('click',event=>{const b=event.target.closest('[data-view]');if(b){state.filters.view=b.dataset.view;state.rows=50;render();}});
for(const id of fields)$(id).addEventListener(id==='search' ? 'input' : 'change',()=>{state.filters[id]=$(id).value;state.rows=50;render();});
$('hide-applied').addEventListener('change',()=>{state.filters.hideApplied=$('hide-applied').checked;state.rows=50;render();});
$('more').addEventListener('click',()=>{state.rows+=50;render();});
$('jobs').addEventListener('click',event=>{const a=event.target.closest('[data-add]'),u=event.target.closest('[data-undo]');if(a)add(a.dataset.add);if(u)undo(u.dataset.undo);});
$('download').addEventListener('click',()=>{const url=URL.createObjectURL(new Blob(['\uFEFF'+csv(filtered())],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`oneshot-reviewed-jobs-2026-10-11-${state.filters.view}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
window.addEventListener('focus',()=>{if(state.trackingReady)refreshTracking();});
window.addEventListener('storage',event=>{if(event.key==='oneshot.visitor-data.state.v1')location.reload();});
init();

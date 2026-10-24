import { BACKENDS, BackendError, call, forcedBackend, getBackend, health, onAnswer, saveBackend } from './api.js';
import {
  CASE_STATUS, COMPANIES, DECISIONS, PHASES, STATUS, TERMINAL, blockedByAdvisor, currentPhase, esc, fmtSeconds, orderedSteps,
} from './domain.js';
import { icon, stepIcon } from './icons.js';
import { Checkpoints } from './checkpoints.js';
import { Timeline } from './timeline.js';
import { openStepDialog } from './detail.js';
import { Understand } from './understand.js';
import * as views from './views.js';
import { morph } from './morph.js';

const $ = sel => document.querySelector(sel);
const POLL_MS = 450;           // SCENARIO: ≤ 500 ms, the Comprendre mode follows each poll
const MAX_POLL_MINUTES = 30;   // a case lasts about a minute, plus the advisor's time

const state = {
  backend: getBackend(),
  caseId: null,
  caseBackend: null,
  c: null,
  pollToken: null,
  skew: 0,
  tab: 'overview',
  journalFilter: 'ALL',
  understand: null,
  renderedSig: {},
};
const serverNow = () => Date.now() - state.skew;

/* ---------- Header: theme, backend flip, answered badge ---------- */
const THEMES = ['auto', 'light', 'dark'];
const THEME_TEXT = { auto: 'Auto', light: 'Clair', dark: 'Sombre' };
function applyTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  $('#themeText').textContent = THEME_TEXT[t];
  $('#themeToggle').setAttribute('aria-label', `Thème : ${THEME_TEXT[t].toLowerCase()} (changer)`);
  $('#themeToggle').title = `Thème : ${THEME_TEXT[t].toLowerCase()}`;
}
const currentTheme = () => { try { return localStorage.getItem('csp.theme') || 'auto'; } catch (e) { return 'auto'; } };
$('#themeToggle').addEventListener('click', () => {
  const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
  try { localStorage.setItem('csp.theme', next); } catch (e) { /* session only */ }
  applyTheme(next);
});
applyTheme(currentTheme());

function initFlip() {
  const forced = forcedBackend();
  document.querySelectorAll('input[name=backend]').forEach(r => {
    r.checked = r.value === state.backend;
    r.disabled = !!forced;
    r.addEventListener('change', () => {
      if (!r.checked) return;
      state.backend = r.value;
      saveBackend(r.value);
      announce(`Backend choisi : ${BACKENDS[r.value].label}. Le dossier affiché est fermé.`);
      closeCase();
      checkHealth();
    });
  });
  if (forced) { $('#flip').classList.add('disabled'); $('#flip').title = `Forcé par l'URL (?backend=${forced})`; }
}

function setAnswered({ answeredBy, unreachable, requested }) {
  const el = $('#answered');
  if (unreachable) {
    el.dataset.state = 'down';
    el.dataset.backend = requested;
    $('#answeredValue').textContent = `${BACKENDS[requested]?.label || requested} injoignable`;
    return;
  }
  el.dataset.state = 'up';
  el.dataset.backend = answeredBy || '';
  el.dataset.mismatch = String(!!answeredBy && answeredBy !== requested);
  $('#answeredValue').textContent = BACKENDS[answeredBy]?.label || answeredBy || 'inconnu';
}
onAnswer(info => {
  setAnswered(info);
  if (info.unreachable) showUnreachable(info.requested); else if (info.answeredBy === state.backend) hideAlert();
});

function showUnreachable(backend, extra) {
  const other = backend === 'orchestrator' ? 'microcks' : 'orchestrator';
  const b = BACKENDS[backend] || { label: backend, where: '' };
  const box = $('#backendAlert');
  const canSwitch = !forcedBackend() && backend !== 'fake';
  box.innerHTML = `<p><strong>${esc(b.label)} ne répond pas</strong> (${esc(b.where)}). ${extra ? esc(extra) + ' ' : ''}`
    + `${backend === 'orchestrator' ? 'Démarrez l\'orchestrateur, ou basculez sur le mock Microcks.' : 'Vérifiez que Microcks tourne et que le mock « Underwriting cases » est importé.'}</p>`
    + (canSwitch ? `<button type="button" class="btn btn-sm" id="switchBackend">Basculer sur ${esc(BACKENDS[other].label)}</button>` : '')
    + '<button type="button" class="btn btn-sm btn-link" id="retryBackend">Réessayer</button>';
  box.hidden = false;
  box.querySelector('#switchBackend')?.addEventListener('click', () => {
    const radio = document.querySelector(`input[name=backend][value=${other}]`);
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
  });
  box.querySelector('#retryBackend').addEventListener('click', checkHealth);
}
const hideAlert = () => { $('#backendAlert').hidden = true; };

async function checkHealth() {
  const b = state.backend;
  if (b === 'fake') { hideAlert(); return; }
  const h = await health();
  if (!h) { showUnreachable(b, 'L\'hôte de l\'IHM ne répond pas non plus.'); return; }
  if (b !== state.backend) return;
  if (b === 'orchestrator' && !h.orchestrator.reachable) showUnreachable(b);
  else if (b === 'microcks' && !h.microcks.reachable) showUnreachable(b);
  else if (b === 'microcks' && !h.microcks.mockImported) showUnreachable(b, 'Microcks répond, mais le service « Underwriting cases » 1.0.0 n\'y est pas importé.');
  else hideAlert();
}

/* ---------- Company picker: changing company closes the case on screen ---------- */
function renderCompanies() {
  const grid = $('#companyGrid');
  grid.innerHTML = COMPANIES.map((c, i) => `
    <label class="company">
      <input type="radio" name="company" value="${c.siren}" ${i === 0 ? 'checked' : ''}>
      <span class="company-name">${esc(c.name)}</span>
      <span class="company-city">${esc(c.city)}</span>
      <span class="company-siren">SIREN ${c.siren.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3')}</span>
    </label>`).join('') + `
    <label class="company company-free">
      <input type="radio" name="company" value="free">
      <span class="company-name">Autre SIREN</span>
      <input type="text" id="freeSiren" inputmode="numeric" autocomplete="off" maxlength="11" placeholder="9 chiffres" aria-label="SIREN saisi librement" aria-describedby="formError">
    </label>`;
  const free = $('#freeSiren');
  free.addEventListener('focus', () => { const r = grid.querySelector('input[value=free]'); if (!r.checked) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); } });
  free.addEventListener('input', () => { free.removeAttribute('aria-invalid'); $('#formError').hidden = true; });
  grid.addEventListener('change', e => {
    if (e.target.name !== 'company') return;
    if (state.c || state.pollToken) { closeCase(); announce('Entreprise changée : le dossier précédent est fermé.'); }
  });
}

function selectedSiren() {
  const v = document.querySelector('input[name=company]:checked')?.value;
  if (v !== 'free') return { siren: v };
  const raw = $('#freeSiren').value.replace(/\s+/g, '');
  if (!/^\d{9}$/.test(raw)) return { error: 'Le SIREN doit compter 9 chiffres.' };
  return { siren: raw };
}

/* ---------- Status bar: where the case is, what runs, what the advisor must do ---------- */
function renderStatusbar(c) {
  const bar = $('#statusbar');
  if (!c) { bar.hidden = true; return; }
  bar.hidden = false;
  const steps = orderedSteps(c);
  const p = currentPhase(c);
  const running = steps.filter(s => s.status === 'RUNNING').length;
  const queued = steps.filter(s => s.status === 'QUEUED').length;
  const blocked = steps.filter(s => blockedByAdvisor(c, s)).length;
  const done = steps.filter(s => TERMINAL.has(s.status)).length;
  const action = c.status === 'DECIDED' ? null : c.pendingAction;
  const activity = [running && `${running} en cours`, queued && `${queued} en file LLM`, blocked && `${blocked} attend votre validation`].filter(Boolean).join(' · ');
  const decided = c.advisorDecision;
  bar.dataset.status = c.status;
  // Patched in place: a poll never moves the page or takes the focus.
  morph(bar, `
    <div class="sb-main">
      <span class="case-status cs-${esc(c.status)}">${c.status === 'WAITING_ADVISOR' || action ? icon('person', 'ico') : c.status === 'DECIDED' ? icon('check', 'ico') : '<span class="spin" aria-hidden="true"></span>'}${esc(action && c.status !== 'WAITING_ADVISOR' ? 'En cours · à vous' : CASE_STATUS[c.status] || c.status)}</span>
      <div class="sb-text">
        <strong>${decided ? `Décidé : ${esc(DECISIONS[decided.finalDecision] || decided.finalDecision)}` : p ? `Phase ${p} · ${esc(PHASES[p].title)}` : 'Dossier'}</strong>
        <span>${esc(c.companyName || '')} · <code>${esc(c.caseId)}</code>${activity ? ' · ' + esc(activity) : ''}</span>
      </div>
      <span class="sb-time" title="Durée du dossier">${icon('clock', 'ico')}<span id="caseClock">${clock(c)}</span></span>
    </div>
    <ol class="sb-steps" style="grid-template-columns: repeat(${steps.length}, 1fr)" aria-label="${done} étapes terminées sur ${steps.length}">${steps.map(s => `<li class="s-${esc(s.status)} k-${esc(s.kind)} ${blockedByAdvisor(c, s) ? 'blocked' : ''}" title="${esc(s.label)} : ${esc(blockedByAdvisor(c, s) ? 'attend votre validation' : STATUS[s.status] || s.status)}"><span class="sr-only">${esc(s.label)} : ${esc(STATUS[s.status] || s.status)}</span></li>`).join('')}</ol>
    ${action ? `<div class="sb-action"><p>${icon('person', 'ico')}<strong>À vous :</strong> ${action === 'DATA_REVIEW' ? 'validez les données collectées. Votre validation débloque l\'analyse financière.' : `prenez la décision${c.escalation?.level === 'REINFORCED' ? ' (décision renforcée)' : ''}.`}${running || queued ? ' Les autres étapes continuent pendant ce temps.' : ''}</p>
      <button type="button" class="btn btn-human" id="goAction" data-action="${esc(action)}">${action === 'DATA_REVIEW' ? 'Valider les données' : 'Prendre la décision'}</button></div>` : ''}`);
}
// The only scroll the screen does by itself: on the advisor's explicit click.
$('#statusbar').addEventListener('click', e => {
  const btn = e.target.closest('#goAction');
  if (!btn) return;
  const target = btn.dataset.action === 'DATA_REVIEW' ? $('#cpReview') : $('#cpDecision');
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  (target.querySelector('input, textarea, button[type=submit]') || target).focus({ preventScroll: true });
});
function clock(c) {
  const t0 = Date.parse(c.createdAt);
  if (!Number.isFinite(t0)) return '—';
  const end = c.status === 'DECIDED' ? Date.parse(c.advisorDecision?.decidedAt) || serverNow() : serverNow();
  const s = Math.max(0, Math.round((end - t0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ---------- Tabs ---------- */
const TABS = [
  ['overview', 'Vue 360', 'overview'], ['company', 'Entreprise', 'building'], ['risks', 'Risques', 'map'],
  ['finances', 'Finances', 'euro'], ['claims', 'Sinistres & contrats', 'file'], ['timeline', 'Parcours', 'timeline'],
  ['board', 'Tableau', 'board'], ['journal', 'Journal des appels', 'list'],
];
function initTabs() {
  $('#tabs').innerHTML = TABS.map(([id, label, ic]) => `<button type="button" role="tab" id="tab-${id}" aria-controls="panel-${id}" aria-selected="${id === state.tab}" tabindex="${id === state.tab ? 0 : -1}">${icon(ic, 'ico')}<span>${esc(label)}</span></button>`).join('');
  $('#tabPanels').innerHTML = TABS.map(([id]) => `<div role="tabpanel" id="panel-${id}" aria-labelledby="tab-${id}" class="tabpanel" tabindex="0" ${id === state.tab ? '' : 'hidden'}></div>`).join('');
  const tabs = [...document.querySelectorAll('[role=tab]')];
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => selectTab(t.id.slice(4)));
    t.addEventListener('keydown', e => {
      const k = { ArrowRight: 1, ArrowLeft: -1, Home: -i, End: tabs.length - 1 - i }[e.key];
      if (k === undefined) return;
      e.preventDefault();
      const n = tabs[(i + k + tabs.length) % tabs.length];
      n.focus(); selectTab(n.id.slice(4));
    });
  });
  state.timeline = new Timeline($('#panel-timeline'), { onOpen: openStep, serverNow });
  document.querySelector('#tabPanels').addEventListener('click', e => {
    const b = e.target.closest('[data-open-step]');
    if (b) { openStep(b.dataset.openStep); return; }
    const f = e.target.closest('[data-filter]');
    if (f) { state.journalFilter = f.dataset.filter; renderTab(true); }
  });
}
function selectTab(id) {
  state.tab = id;
  document.querySelectorAll('[role=tab]').forEach(t => { const on = t.id === `tab-${id}`; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
  document.querySelectorAll('[role=tabpanel]').forEach(p => { p.hidden = p.id !== `panel-${id}`; });
  renderTab(true);
}
const RENDER = { overview: views.overview, company: views.company, risks: views.risks, finances: views.finances, claims: views.claims, board: views.board };
function renderTab(force) {
  const c = state.c;
  if (state.tab === 'timeline') { state.timeline.update(c); return; }
  const panel = $(`#panel-${state.tab}`);
  const sig = JSON.stringify([c, state.journalFilter, document.documentElement.dataset.theme]);
  if (!force && state.renderedSig[state.tab] === sig) return;
  state.renderedSig[state.tab] = sig;
  // Patched in place: scroll, focus and opened <details> stay as the user left them.
  morph(panel, state.tab === 'journal' ? views.journal(c, serverNow(), state.journalFilter) : RENDER[state.tab](c, serverNow()));
}

function openStep(id) {
  if (!state.c) return;
  openStepDialog($('#stepDialog'), state.c, id, serverNow());
}

/* ---------- Case lifecycle ---------- */
const announce = text => { $('#live').textContent = text; };
const stopPolling = () => { state.pollToken = null; };

function closeCase() {
  stopPolling();
  state.c = null;
  state.caseId = null;
  state.renderedSig = {};
  renderAll();
  state.understand?.reset(state.backend);
}

function renderAll() {
  const c = state.c;
  renderStatusbar(c);
  state.checkpoints.update(c);
  renderTab();
  if (!c) document.querySelectorAll('[role=tabpanel]').forEach(p => { if (p.id !== 'panel-timeline' && p.id !== `panel-${state.tab}`) p.innerHTML = ''; });
}

function onCase(c) {
  state.c = c;
  renderAll();
  state.understand?.onCase(c);
}

async function launch(siren) {
  closeCase();
  const backend = state.backend;
  const token = (state.pollToken = {});
  $('#launchBtn').disabled = true;
  $('#formError').hidden = true;
  state.understand?.reset(backend);
  state.understand?.open(siren);
  announce('Dossier en cours d\'ouverture.');
  let sentAt = Date.now();
  try {
    const scale = backend === 'fake' ? new URLSearchParams(location.search).get('fakeScale') : null;
    sentAt = Date.now();
    const { data } = await call(backend, 'POST', `underwriting-cases${scale ? `?timeScale=${encodeURIComponent(scale)}` : ''}`, { siren, product: 'MULTIRISQUE_PRO' });
    if (state.pollToken !== token) return;
    if (!data || !data.caseId) throw new BackendError('http', backend, 'réponse sans caseId', data);
    state.caseId = data.caseId;
    state.caseBackend = backend;
    state.understand?.created(data);
    $('#launchBtn').disabled = false;
    let first = true;
    let lastAction = null;
    const deadline = Date.now() + MAX_POLL_MINUTES * 60000;
    while (state.pollToken === token && Date.now() < deadline) {
      const { data: c } = await call(backend, 'GET', `underwriting-cases/${encodeURIComponent(data.caseId)}`);
      if (state.pollToken !== token) return;
      if (first) {
        // Align the time axis on the server clock (the mock may carry its own timestamps).
        const created = Date.parse(c.createdAt);
        state.skew = Number.isFinite(created) ? sentAt - created : 0;
        first = false;
      }
      onCase(c);
      if (c.pendingAction !== lastAction) {
        lastAction = c.pendingAction;
        if (c.pendingAction === 'DATA_REVIEW') announce('À vous : validez les données collectées.');
        if (c.pendingAction === 'DECISION') announce(`À vous : prenez la décision${c.escalation?.level === 'REINFORCED' ? ' (décision renforcée)' : ''}.`);
      }
      if (c.status === 'DECIDED') { announce('Dossier décidé.'); break; }
      await new Promise(r => setTimeout(r, POLL_MS));
    }
  } catch (err) {
    if (state.pollToken !== token) return;
    const box = $('#formError');
    if (err instanceof BackendError && err.kind !== 'http') box.textContent = `${BACKENDS[backend].label} injoignable : le suivi du dossier est interrompu.`;
    else if (err.status === 404) box.textContent = 'Dossier introuvable côté backend (404).';
    else {
      const code = err.body && typeof err.body === 'object' ? (err.body.code || err.body.title || '') : '';
      box.textContent = `Le backend a refusé la demande (HTTP ${err.status}${code ? ' · ' + code : ''}).`;
    }
    box.hidden = false;
  } finally {
    if (state.pollToken === token) state.pollToken = null;
    $('#launchBtn').disabled = false;
  }
}

async function post(kind, payload) {
  const backend = state.caseBackend;
  const caseId = state.caseId;
  state.understand?.post(kind);
  try {
    const { data } = await call(backend, 'POST', `underwriting-cases/${encodeURIComponent(caseId)}/${kind}`, payload);
    state.understand?.postResult(kind, true);
    if (data && data.caseId === state.caseId) onCase(data);
    announce(kind === 'data-review' ? 'Données validées : l\'analyse financière peut démarrer.' : 'Décision du conseiller enregistrée.');
    return data;
  } catch (err) {
    state.understand?.postResult(kind, false);
    throw err;
  }
}

$('#intakeForm').addEventListener('submit', e => {
  e.preventDefault();
  const sel = selectedSiren();
  if (sel.error) {
    const box = $('#formError');
    box.textContent = sel.error;
    box.hidden = false;
    $('#freeSiren').setAttribute('aria-invalid', 'true');
    $('#freeSiren').focus();
    return;
  }
  launch(sel.siren);
});

/* ---------- Comprendre: a sticky side panel, collapsible ---------- */
function setUnderstand(open, collapsed = false) {
  $('#understandToggle').setAttribute('aria-pressed', String(open));
  $('#understandPanel').hidden = !open || collapsed;
  $('#understandRail').hidden = !open || !collapsed;
  $('#workspace').dataset.understand = open ? (collapsed ? 'collapsed' : 'open') : 'off';
  try { localStorage.setItem('csp.understand', open ? (collapsed ? 'collapsed' : '1') : '0'); } catch (e) { /* session only */ }
  if (open && !collapsed) {
    state.understand = state.understand || new Understand($('#flowHost'));
    state.understand.show(state.caseBackend && state.c ? state.caseBackend : state.backend, state.c);
  } else if (state.understand) state.understand.hide();
  state.timeline?.render();
}
$('#understandToggle').addEventListener('click', () => setUnderstand($('#understandToggle').getAttribute('aria-pressed') !== 'true'));
$('#understandCollapse').addEventListener('click', () => { setUnderstand(true, true); $('#understandRail').focus(); });
$('#understandRail').addEventListener('click', () => { setUnderstand(true, false); $('#understandCollapse').focus(); });

/* ---------- Ticker: live durations, the growing bars of the Parcours ---------- */
setInterval(() => {
  const c = state.c;
  if (!c) return;
  const now = serverNow();
  document.querySelectorAll('.since[data-since]').forEach(el => { const t = Date.parse(el.dataset.since); if (Number.isFinite(t)) el.textContent = fmtSeconds(Math.max(0, now - t)); });
  const clk = $('#caseClock');
  if (clk) clk.textContent = clock(c);
  if (state.tab === 'timeline' && c.status !== 'DECIDED') state.timeline.render();
}, 250);

/* ---------- Boot ---------- */
state.checkpoints = new Checkpoints($('#checkpoints'), {
  now: serverNow,
  postReview: payload => post('data-review', payload),
  postDecision: payload => post('advisor-decision', payload),
  openStep,
});
initFlip();
renderCompanies();
initTabs();
renderAll();
let understandSaved = '0';
try { understandSaved = localStorage.getItem('csp.understand') || '0'; } catch (e) { /* default off */ }
const q = new URLSearchParams(location.search);
if (q.get('comprendre') === '1') understandSaved = '1';
if (q.get('tab') && TABS.some(t => t[0] === q.get('tab'))) selectTab(q.get('tab'));
if (understandSaved !== '0') setUnderstand(true, understandSaved === 'collapsed');
checkHealth();

// For the end-to-end tests.
window.__csp = { state, launch, selectTab };

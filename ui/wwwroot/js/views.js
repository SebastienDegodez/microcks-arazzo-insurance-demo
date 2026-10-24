// The tabs of the case: each view is a function (case, ctx) → HTML. ctx.now() is the server time.
import {
  DECISIONS, LEVELS, PHASES, STATUS, TERMINAL, blockedByAdvisor, currentPhase, durationOf, esc, euros, fmtSeconds,
  frDate, headcountMismatch, isCollective, naturalRisksOf, orderedSteps, pct, resultOf, sourceOf, stepMap,
} from './domain.js';
import { icon, stepIcon } from './icons.js';
import { renderMap } from './map.js';

const empty = text => `<div class="empty">${icon('clock')}<span>${esc(text)}</span></div>`;
const dl = pairs => `<dl class="kv">${pairs.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
const level = l => `<span class="level l-${esc(l || 'NONE')}">${esc(LEVELS[l] || l || '—')}</span>`;

export function statusChip(c, s, now) {
  const blocked = blockedByAdvisor(c, s);
  if (blocked) return `<span class="status s-BLOCKED">${icon('person', 'ico status-ico')}attend votre validation</span>`;
  const since = s.startedAt && ['RUNNING', 'WAITING'].includes(s.status) ? ` · <span class="since" data-since="${esc(s.startedAt)}">${fmtSeconds(now - Date.parse(s.startedAt))}</span>` : '';
  const ico = { RUNNING: '<span class="spin" aria-hidden="true"></span>', QUEUED: icon('queue', 'ico status-ico'), WAITING: icon('person', 'ico status-ico'), DONE: icon('check', 'ico status-ico'), FAILED: icon('cross', 'ico status-ico'), SKIPPED: '<span class="dash" aria-hidden="true">–</span>', PENDING: '<span class="ring" aria-hidden="true"></span>' }[s.status] || '';
  return `<span class="status s-${esc(s.status)}">${ico}${esc(STATUS[s.status] || s.status)}${since}</span>`;
}

// The block of an LLM analysis: what it says, and that it is only an analysis.
export function analysisBlock(c, id, title, now) {
  const s = c?.steps?.[id] ? { id, ...c.steps[id] } : null;
  if (!s) return '';
  const r = s.result || {};
  let body = '';
  if (s.status === 'DONE') {
    if (id === 'dataQuality') body = `<p class="an-head">Données <span class="level l-${r.status === 'VALID' ? 'LOW' : r.status === 'WARNINGS' ? 'MEDIUM' : 'HIGH'}">${esc({ VALID: 'cohérentes', WARNINGS: 'avec alertes', INVALID: 'incohérentes' }[r.status] || r.status || '—')}</span> · score ${esc(r.score ?? '—')}/100</p>${(r.issues || []).length ? `<ul class="issues">${r.issues.map(i => `<li>${icon('warn', 'ico warn-ico')}${esc(i)}</li>`).join('')}</ul>` : '<p class="muted">Aucune alerte.</p>'}`;
    else if (id === 'climateRisk') body = `<p class="an-head">Risque ${level(r.level)} · score ${esc(r.score ?? '—')}/100</p>${(r.drivers || []).length ? `<ul class="drivers">${r.drivers.map(d => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}<p>${esc(r.rationale || s.summary || '')}</p>`;
    else if (id === 'financialHealth') body = `<p class="an-head">Situation ${esc({ SOUND: 'saine', FRAGILE: 'fragile', CRITICAL: 'critique' }[r.level] || r.level || '—')} · score ${esc(r.score ?? '—')}/100</p><p>${esc(r.rationale || s.summary || '')}</p>`;
    else if (id === 'openItemsReview') body = `<p class="an-head">Complexité ${level(r.complexity)} · ${r.manageable === false ? 'difficilement gérable' : 'gérable'}</p><p>${esc(r.rationale || s.summary || '')}</p>`;
    else body = `<p>${esc(s.summary || '')}</p>`;
  } else {
    body = `<p class="muted">${esc(blockedByAdvisor(c, s) ? 'Cette analyse attend votre validation des données (données financières sensibles).' : s.summary || { PENDING: 'Pas encore lancée.', QUEUED: 'En file d\'attente : 2 créneaux LLM au maximum.', RUNNING: 'Analyse en cours…' }[s.status] || '')}</p>`;
  }
  return `<section class="analysis ${s.status === 'DONE' ? '' : 'pending'}" aria-label="${esc(title)}">
    <header>${stepIcon(s)}<h4>${esc(title)}</h4><span class="consult">analyse LLM · consultatif</span>${statusChip(c, s, now)}</header>${body}</section>`;
}

/* ---------- Vue 360 ---------- */
function processStrip(c, now) {
  const steps = orderedSteps(c);
  const cur = currentPhase(c);
  return `<ol class="process" aria-label="Avancement par phase">${[1, 2, 3, 4, 5, 6].map(p => {
    const list = steps.filter(s => s.phase === p);
    const done = list.filter(s => TERMINAL.has(s.status)).length;
    const skipped = list.length && list.every(s => s.status === 'SKIPPED');
    const waiting = list.some(s => s.status === 'WAITING');
    const running = list.filter(s => s.status === 'RUNNING').length;
    const queued = list.filter(s => s.status === 'QUEUED').length;
    const state = skipped ? 'skipped' : list.length && done === list.length ? 'done' : waiting ? 'waiting' : running || queued ? 'active' : p === cur ? 'active' : 'pending';
    const stateText = { skipped: 'non exécutée', done: 'terminée', waiting: 'à vous', active: `${running} en cours${queued ? ` · ${queued} en file` : ''}`, pending: 'à venir' }[state];
    return `<li class="ph ${state} ${PHASES[p].human ? 'human' : ''}" ${p === cur ? 'aria-current="step"' : ''}>
      <span class="ph-n">${p}</span><span class="ph-t">${PHASES[p].human ? icon('person', 'ico') : ''}${esc(PHASES[p].short)}</span>
      <span class="ph-s">${esc(stateText)} · ${done}/${list.length}</span></li>`;
  }).join('')}</ol>`;
}

function controlChain(c, now) {
  const m = stepMap(c);
  const node = (id, label) => {
    const s = m[id];
    if (!s) return '';
    return `<button type="button" class="chain-node k-${s.kind} s-${s.status} ${blockedByAdvisor(c, s) ? 'blocked' : ''}" data-open-step="${id}">${stepIcon(s)}<span class="cn-label">${esc(label)}</span>${statusChip(c, s, now)}</button>`;
  };
  return `<div class="chain" aria-label="Chaîne de contrôle des données">
    <div class="chain-col">${node('checkAccount', 'Compte client')}${node('companyIdentity', 'Identité Sirene')}${node('financials', 'Comptes annuels')}</div>
    <span class="chain-arrow" aria-hidden="true">→</span>
    <div class="chain-col">${node('dataQuality', 'Contrôle de la collecte')}</div>
    <span class="chain-arrow" aria-hidden="true">→</span>
    <div class="chain-col">${node('dataReview', 'Votre validation')}</div>
    <span class="chain-arrow" aria-hidden="true">→</span>
    <div class="chain-col">${node('financialHealth', 'Analyse financière')}</div>
  </div>
  <p class="note">Le contrôle de la collecte (LLM) compare CRM, Sirene et bilan ; ses alertes reviennent dans votre validation, qui débloque l'analyse financière.</p>`;
}

function liveActivity(c, now) {
  const steps = orderedSteps(c).filter(s => ['RUNNING', 'QUEUED', 'WAITING'].includes(s.status) || blockedByAdvisor(c, s));
  const llmRunning = orderedSteps(c).filter(s => s.kind === 'LLM' && s.status === 'RUNNING').length;
  if (!steps.length) return `<p class="muted">${c.status === 'DECIDED' ? 'Dossier décidé : plus rien ne tourne.' : 'Rien en cours pour l\'instant.'}</p>`;
  return `<p class="slots">${icon('robot', 'ico ico-llm')}Créneaux LLM : <strong>${llmRunning}/2</strong> occupés</p>
    <ul class="activity">${steps.map(s => `<li><button type="button" class="link-btn" data-open-step="${s.id}">${stepIcon(s)}${esc(s.label)}</button>${statusChip(c, s, now)}</li>`).join('')}</ul>`;
}

export function overview(c, now) {
  if (!c) return empty('Choisissez une entreprise et ouvrez le dossier : la vue 360 rassemble l\'entreprise, les données collectées, les analyses et vos points de contrôle.');
  const m = stepMap(c);
  const id = resultOf(c, 'companyIdentity'), acc = resultOf(c, 'checkAccount'), fin = resultOf(c, 'financials'), items = resultOf(c, 'openItems'), geo = naturalRisksOf(c);
  const declared = c.dataReview?.corrections?.declaredHeadcount ?? acc?.declaredHeadcount;
  const mismatch = headcountMismatch(id?.headcountRange, declared);
  const rn = geo?.risquesNaturels || {};
  const major = Object.entries(rn).filter(([k, v]) => v && ['HIGH', 'VERY_HIGH', 'MEDIUM'].includes(v.level)).map(([k, v]) => `${{ inondation: 'Inondation', submersionMarine: 'Submersion marine', retraitGonflementArgiles: 'Argiles', feuxForet: 'Feux de forêt' }[k] || k} ${LEVELS[v.level]}`);
  const claims = items?.openClaims || [];
  const reasons = c.escalation?.reasons || [];
  return `<div class="v360">
    ${processStrip(c, now)}
    <div class="v360-grid">
      <section class="card c-company"><h3>${icon('building', 'ico')}Entreprise</h3>
        <div class="c-company-body"><div>
          <p class="big">${esc(c.companyName || id?.denomination || 'Entreprise inconnue')}</p>
          ${dl([['SIREN', `<code>${esc(c.siren)}</code>`], id && ['Activité', esc(`${id.nafLabel || ''} (${id.nafCode || '—'})`)], id && ['Commune', esc(`${id.address?.city || '—'} ${id.address?.postalCode || ''}`)],
            ['Effectif', id || acc ? `INSEE ${esc(id?.headcountRange || '—')} · déclaré ${esc(declared ?? '—')}${mismatch ? ` <span class="flag warn">${icon('warn', 'ico')}incohérent</span>` : ''}` : '—'],
            acc && ['Client depuis', esc(frDate(acc.customerSince))]])}
          ${m.checkAccount?.status === 'DONE' && !acc?.customerId ? `<p class="flag ko">${icon('warn', 'ico')}Aucun compte client</p>` : ''}
        </div>${id ? renderMap({ identity: id, risks: geo, name: c.companyName, compact: true }) : ''}</div>
      </section>
      <section class="card c-chain"><h3>${icon('shield', 'ico')}Contrôle de la collecte → votre validation</h3>${controlChain(c, now)}</section>
      <section class="card c-kpi"><h3>${icon('euro', 'ico')}Indicateurs clés</h3>
        <ul class="kpis">
          <li><span>Chiffre d'affaires</span><strong>${euros(fin?.revenue)}</strong></li>
          <li><span>Résultat net</span><strong class="${fin?.netIncome < 0 ? 'neg' : ''}">${euros(fin?.netIncome)}</strong></li>
          <li><span>Endettement</span><strong>${pct(fin?.debtRatio)}</strong></li>
          <li><span>Trésorerie</span><strong>${fin ? `${esc(fin.cashDays)} j` : '—'}</strong></li>
          <li><span>Sinistres ouverts</span><strong>${items ? `${claims.length}${claims.some(x => x.litigation) ? ` (dont ${claims.filter(x => x.litigation).length} contentieux)` : ''}` : '—'}</strong></li>
          <li><span>Risques naturels</span><strong>${geo ? esc(major.join(', ') || 'faibles') : '—'}</strong></li>
        </ul>
        ${(resultOf(c, 'legalEvents')?.records || []).some(isCollective) ? `<p class="flag ko">${icon('warn', 'ico')}Procédure collective au BODACC</p>` : ''}
      </section>
      <section class="card c-analyses"><h3>${icon('robot', 'ico ico-llm')}Analyses (consultatives)</h3>
        <ul class="an-list">${['dataQuality', 'climateRisk', 'financialHealth', 'openItemsReview', 'synthesis'].filter(k => m[k]).map(k => `<li><button type="button" class="link-btn" data-open-step="${k}">${stepIcon(m[k])}${esc(m[k].label)}</button>${statusChip(c, m[k], now)}</li>`).join('')}</ul>
      </section>
      <section class="card c-live"><h3>${icon('clock', 'ico')}En ce moment</h3>${liveActivity(c, now)}</section>
      <section class="card c-reasons"><h3>${icon('warn', 'ico')}Raisons de risque</h3>
        ${c.escalation ? `<p class="esc-level ${c.escalation.level === 'REINFORCED' ? 'reinforced' : ''}">${c.escalation.level === 'REINFORCED' ? 'Décision renforcée' : 'Décision standard'} · ${reasons.length} raison${reasons.length > 1 ? 's' : ''}</p>
          <ul class="reasons-mini">${reasons.map(r => `<li>${esc(r.label)}</li>`).join('') || '<li class="muted">Aucune raison relevée.</li>'}</ul>` : '<p class="muted">Relevées par l\'orchestrateur (règle déterministe) avant votre décision.</p>'}
      </section>
    </div></div>`;
}

/* ---------- Entreprise ---------- */
export function company(c, now) {
  if (!c) return empty('Ouvrez un dossier pour voir l\'entreprise.');
  const id = resultOf(c, 'companyIdentity'), acc = resultOf(c, 'checkAccount'), legal = resultOf(c, 'legalEvents'), geo = naturalRisksOf(c);
  const m = stepMap(c);
  const corrected = c.dataReview?.corrections?.declaredHeadcount;
  const declared = acc?.declaredHeadcount;
  const mismatch = headcountMismatch(id?.headcountRange, corrected ?? declared);
  return `<div class="cols">
    <div class="col">
      <section class="card"><h3>${icon('bank', 'ico')}Identité (Sirene)</h3>${id ? dl([['Dénomination', esc(id.denomination)], ['SIREN', `<code>${esc(id.siren)}</code>`], ['Activité', esc(`${id.nafLabel} (${id.nafCode})`)], ['Création', esc(frDate(id.creationDate))], ['État', id.active ? 'active' : '<span class="flag ko">cessée</span>'], ['Adresse', esc(`${id.address?.street || ''}, ${id.address?.postalCode || ''} ${id.address?.city || ''}`)], ['Code INSEE', `<code>${esc(id.address?.inseeCityCode)}</code>`]]) : `<p class="muted">${esc(m.companyIdentity?.summary || 'En attente de Sirene.')}</p>`}</section>
      <section class="card"><h3>${icon('building', 'ico')}Compte client (CRM)</h3>${acc?.customerId ? dl([['Client', `<code>${esc(acc.customerId)}</code>`], ['Segment', esc(acc.segment)], ['Client depuis', esc(frDate(acc.customerSince))]]) : `<p class="muted">${esc(m.checkAccount?.summary || 'En attente du CRM.')}</p>`}</section>
      <section class="card"><h3>${icon('person', 'ico')}Effectifs</h3>
        <table class="cmp"><thead><tr><th scope="col">Source</th><th scope="col">Effectif</th></tr></thead><tbody>
          <tr><th scope="row">INSEE (tranche)</th><td>${esc(id?.headcountRange ?? '—')}</td></tr>
          <tr><th scope="row">Déclaré (CRM)</th><td>${esc(declared ?? '—')}</td></tr>
          ${corrected !== undefined && corrected !== null ? `<tr><th scope="row">Corrigé par le conseiller</th><td><strong>${esc(corrected)}</strong></td></tr>` : ''}
        </tbody></table>
        ${mismatch ? `<p class="flag warn">${icon('warn', 'ico')}L'effectif ${corrected ? 'corrigé' : 'déclaré'} sort de la tranche INSEE.</p>` : mismatch === false ? `<p class="flag ok">${icon('check', 'ico')}Cohérent avec la tranche INSEE.</p>` : ''}
      </section>
      <section class="card"><h3>${icon('file', 'ico')}Annonces légales (BODACC)</h3>${legal ? `<ul class="annonces">${(legal.records || []).map(r => `<li class="${isCollective(r) ? 'collective' : ''}"><strong>${esc(r.type)}</strong> · ${esc(r.nature)}<br><span class="muted">${esc(frDate(r.date))} · ${esc(r.court)}</span>${isCollective(r) ? `<span class="flag ko">${icon('warn', 'ico')}procédure collective</span>` : ''}</li>`).join('') || '<li class="muted">Aucune annonce.</li>'}</ul>` : `<p class="muted">${esc(m.legalEvents?.summary || 'En attente du BODACC.')}</p>`}</section>
    </div>
    <div class="col"><section class="card"><h3>${icon('map', 'ico')}Localisation</h3>${id ? renderMap({ identity: id, risks: geo, name: c.companyName }) : '<p class="muted">La carte apparaît dès que Sirene a donné l\'adresse.</p>'}</section></div>
  </div>`;
}

/* ---------- Risques ---------- */
const RISK_NAMES = { inondation: 'Inondation', submersionMarine: 'Submersion marine', retraitGonflementArgiles: 'Retrait-gonflement des argiles', feuxForet: 'Feux de forêt' };
export function risks(c, now) {
  if (!c) return empty('Ouvrez un dossier pour voir ses risques.');
  const id = resultOf(c, 'companyIdentity'), geo = naturalRisksOf(c);
  const m = stepMap(c);
  const rn = geo?.risquesNaturels || {};
  const W = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, VERY_HIGH: 4 };
  return `<div class="cols">
    <div class="col"><section class="card"><h3>${icon('map', 'ico')}Carte des risques</h3>${id ? renderMap({ identity: id, risks: geo, name: c.companyName }) : '<p class="muted">En attente de l\'adresse (Sirene).</p>'}</section></div>
    <div class="col">
      <section class="card"><h3>${icon('plug', 'ico ico-mcp')}Risques naturels (Géorisques)</h3>
        ${geo ? `<table class="risk-table"><thead><tr><th scope="col">Risque</th><th scope="col">Niveau</th><th scope="col"><span class="sr-only">Échelle</span></th></tr></thead><tbody>
          ${Object.entries(RISK_NAMES).map(([k, name]) => { const l = rn[k]?.level || 'NONE'; return `<tr><th scope="row">${esc(name)}</th><td>${level(l)}</td><td><span class="meter" aria-hidden="true"><span style="width:${W[l] * 25}%" class="l-${l}"></span></span></td></tr>`; }).join('')}
          <tr><th scope="row">Sismicité</th><td>zone ${esc(rn.seisme?.zone ?? '—')}</td><td></td></tr></tbody></table>
          <p class="note">Commune : ${esc(geo.commune || id?.address?.city || '—')} · obtenus par l'agent climat avec son outil MCP : reShapr expose Géorisques, Microcks simule l'API derrière lui.</p>` : `<p class="muted">${esc(m.climateRisk?.status === 'SKIPPED' ? 'Analyse climat non exécutée : pas de risques naturels.' : 'L\'agent climat va chercher les risques naturels avec son outil MCP (reShapr → Géorisques).')}</p>`}
      </section>
      ${analysisBlock(c, 'climateRisk', 'Analyse du risque climatique', now)}
    </div></div>`;
}

/* ---------- Finances ---------- */
export function finances(c, now) {
  if (!c) return empty('Ouvrez un dossier pour voir ses comptes.');
  const fin = resultOf(c, 'financials');
  const m = stepMap(c);
  const bar = (label, value, max, text, warn) => `<li><span>${esc(label)}</span><span class="meter ${warn ? 'warn' : ''}" aria-hidden="true"><span style="width:${Math.max(2, Math.min(100, (value / max) * 100))}%"></span></span><strong>${text}</strong></li>`;
  return `<div class="cols">
    <div class="col"><section class="card"><h3>${icon('euro', 'ico')}Comptes annuels ${fin?.year ? esc(fin.year) : ''}</h3>
      ${fin ? `<ul class="kpis big">
        <li><span>Chiffre d'affaires</span><strong>${euros(fin.revenue)}</strong></li>
        <li><span>Résultat net</span><strong class="${fin.netIncome < 0 ? 'neg' : ''}">${euros(fin.netIncome)}</strong></li>
        <li><span>Fonds propres</span><strong>${euros(fin.equity)}</strong></li></ul>
        <ul class="ratios">${bar('Taux d\'endettement', fin.debtRatio, 1, pct(fin.debtRatio), fin.debtRatio > 0.7)}${bar('Trésorerie', fin.cashDays, 90, `${esc(fin.cashDays)} jours`, fin.cashDays < 15)}</ul>`
        : `<p class="muted">${m.financials?.status === 'RUNNING' ? `${esc('Les comptes annuels arrivent (appel long)…')} ${statusChip(c, m.financials, now)}` : esc(m.financials?.summary || 'En attente des comptes.')}</p>`}
    </section></div>
    <div class="col">${analysisBlock(c, 'financialHealth', 'Analyse de la santé financière', now)}</div></div>`;
}

/* ---------- Sinistres & contrats ---------- */
export function claims(c, now) {
  if (!c) return empty('Ouvrez un dossier pour voir ses sinistres et contrats.');
  const items = resultOf(c, 'openItems');
  const m = stepMap(c);
  return `<div class="cols">
    <div class="col"><section class="card"><h3>${icon('file', 'ico')}Sinistres ouverts et contrats</h3>
      ${items ? `<table class="claims"><thead><tr><th scope="col">Sinistre</th><th scope="col">Nature</th><th scope="col" class="num">Montant</th><th scope="col">Statut</th></tr></thead><tbody>
        ${(items.openClaims || []).map(x => `<tr><td><code>${esc(x.claimId)}</code></td><td>${esc(x.type)}</td><td class="num">${euros(x.amount)}</td><td>${esc(x.status)}${x.litigation ? ` <span class="flag ko">${icon('warn', 'ico')}contentieux</span>` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Aucun sinistre ouvert.</td></tr>'}
        </tbody></table>
        ${dl([['Primes impayées', esc(items.unpaidPremiums ?? 0)], ['Résiliation en cours', items.pendingTermination ? 'oui' : 'non']])}`
        : `<p class="muted">${esc(m.openItems?.summary || 'En attente des sinistres et contrats.')}</p>`}
    </section></div>
    <div class="col">${analysisBlock(c, 'openItemsReview', 'Analyse des sinistres et contrats', now)}</div></div>`;
}

/* ---------- Tableau (kanban) ---------- */
function callsHtml(step) {
  const calls = step.calls || [];
  if (!calls.length) return '';
  return `<details class="calls"><summary>${calls.length} appel${calls.length > 1 ? 's' : ''} sortant${calls.length > 1 ? 's' : ''}</summary>
    <ul class="call-list">${calls.map(callLi).join('')}</ul></details>`;
}
export function callLi(c) {
  let shown = c.url;
  try { const u = new URL(c.url); shown = `${u.host}${decodeURIComponent(u.pathname)}${u.search}`; } catch (e) { /* raw */ }
  const ok = Number(c.status) > 0 && Number(c.status) < 400;
  return `<li class="call"><span class="call-method">${esc(c.method)}</span><span class="call-url">${esc(shown)}</span>
    <span class="call-status ${ok ? 'ok' : 'ko'}">${esc(c.status)}${ok ? '' : ' ✗'}</span><span class="call-via" data-via="${esc(c.via)}">via ${esc(c.via)}</span></li>`;
}

export function board(c, now) {
  const steps = c ? orderedSteps(c) : null;
  if (!steps) return empty('Ouvrez un dossier : le tableau montre les 13 étapes par phase.');
  return `<ol class="phases">${[1, 2, 3, 4, 5, 6].map(p => {
    const list = steps.filter(s => s.phase === p);
    const parallel = list.some(s => s.mode === 'PARALLEL');
    return `<li class="phase ${parallel ? 'parallel' : 'chain'} ${PHASES[p].human ? 'human' : ''}">
      <div class="phase-head"><span class="phase-num">Phase ${p}</span><h3 class="phase-title">${esc(PHASES[p].title)}</h3>
        <span class="mode ${parallel ? 'parallel' : ''}">${parallel ? 'En parallèle' : 'À la chaîne'}</span></div>
      <div class="phase-cards">${list.map(s => {
        const src = sourceOf(s);
        const blocked = blockedByAdvisor(c, s);
        return `<article class="step k-${s.kind} ${blocked ? 'blocked' : ''}" data-status="${esc(s.status)}" aria-labelledby="bl-${s.id}">
          <div class="step-top">${stepIcon(s)}<h4 class="step-label" id="bl-${s.id}">${esc(s.label)}</h4></div>
          <div class="step-meta">${statusChip(c, s, now)}<span class="source-tag" data-src="${src.src}">${esc(src.text)}</span>${durationOf(s) ? `<span class="step-time">${durationOf(s)}</span>` : ''}</div>
          ${s.dependsOn?.length ? `<p class="deps">après : ${s.dependsOn.map(d => esc(c.steps[d]?.label || d)).join(', ')}</p>` : ''}
          <p class="step-summary">${esc(s.summary || (blocked ? 'Attend votre validation des données.' : ''))}</p>
          <div class="step-actions">${callsHtml(s).replace('<details class="calls">', `<details class="calls" data-keep="calls-${s.id}">`)}<button type="button" class="btn-link-sm" data-open-step="${s.id}">Détail</button></div>
        </article>`;
      }).join('')}</div></li>`;
  }).join('')}</ol>`;
}

/* ---------- Journal des appels ---------- */
export function journal(c, now, filter = 'ALL') {
  if (!c) return empty('Ouvrez un dossier : chaque appel sortant de l\'orchestrateur s\'inscrit ici.');
  const steps = orderedSteps(c);
  const rows = steps.flatMap(s => s.calls.map((x, i) => ({ s, x, i, t: Date.parse(s.startedAt) })));
  rows.sort((a, b) => (a.t || 0) - (b.t || 0));
  const t0 = Date.parse(c.createdAt);
  const shown = rows.filter(r => filter === 'ALL' || r.x.via === filter);
  const counts = ['REST', 'MCP', 'LLM'].map(v => [v, rows.filter(r => r.x.via === v).length]);
  return `<div class="journal">
    <div class="journal-tools" role="group" aria-label="Filtrer par type d'appel">
      ${[['ALL', `Tous (${rows.length})`], ...counts.map(([v, n]) => [v, `${v} (${n})`])].map(([v, l]) => `<button type="button" class="chip-btn" data-filter="${v}" aria-pressed="${filter === v}">${esc(l)}</button>`).join('')}
    </div>
    ${shown.length ? `<table class="calls-table"><thead><tr><th scope="col">Départ</th><th scope="col">Étape</th><th scope="col">Appel</th><th scope="col">Statut</th><th scope="col">Via</th></tr></thead><tbody>
      ${shown.map(({ s, x, t }) => { let u = x.url; try { const p = new URL(x.url); u = `${p.host}${decodeURIComponent(p.pathname)}${p.search}`; } catch (e) { /* raw */ } const ok = Number(x.status) > 0 && Number(x.status) < 400;
        return `<tr><td class="num">${Number.isFinite(t) && Number.isFinite(t0) ? '+' + fmtSeconds(t - t0) : '—'}</td><td><button type="button" class="link-btn" data-open-step="${s.id}">${stepIcon(s)}${esc(s.label)}</button></td>
          <td><code>${esc(x.method)} ${esc(u)}</code></td><td class="${ok ? 'ok' : 'ko'}"><strong>${esc(x.status)}</strong>${ok ? '' : ' (erreur)'}</td><td><span class="call-via" data-via="${esc(x.via)}">${esc(x.via)}</span></td></tr>`; }).join('')}
    </tbody></table>` : '<p class="muted">Aucun appel terminé pour l\'instant : un appel apparaît quand son étape se termine.</p>'}
  </div>`;
}

// What the screen knows about the demo (SCENARIO.md v2): companies, the 13 steps, phases, lanes, labels.
export const COMPANIES = [
  { siren: '100000001', name: 'Boulangerie Les Délices du Port', city: 'La Rochelle (17)' },
  { siren: '100000002', name: 'Atelier Mécanique Durand', city: 'Clermont-Ferrand (63)' },
  { siren: '100000003', name: 'Transports Express Nord', city: 'Lille (59)' },
  { siren: '100000004', name: 'Restaurant Le Vieux Moulin', city: 'Avignon (84)' },
  { siren: '999999999', name: 'Entreprise inconnue', city: 'aucun compte client' },
];

// The 12 steps (v3), for the empty screen before the first case (the case brings its own labels and dependencies).
export const DEFAULT_STEPS = [
  ['checkAccount', 'Compte client', 1, 'CHAIN', 'SERVICE', []],
  ['companyIdentity', "Identité de l'entreprise", 2, 'PARALLEL', 'SERVICE', ['checkAccount']],
  ['legalEvents', 'Annonces légales', 2, 'PARALLEL', 'SERVICE', ['checkAccount']],
  ['financials', 'Comptes annuels', 2, 'PARALLEL', 'SERVICE', ['checkAccount']],
  ['openItems', 'Sinistres et contrats', 2, 'PARALLEL', 'SERVICE', ['checkAccount']],
  ['dataQuality', 'Contrôle de la collecte', 2, 'CHAIN', 'LLM', ['checkAccount', 'companyIdentity', 'financials']],
  ['dataReview', 'Validation des données', 3, 'CHAIN', 'HUMAN', ['companyIdentity', 'legalEvents', 'financials', 'openItems', 'dataQuality']],
  ['climateRisk', 'Analyse risque climatique', 4, 'PARALLEL', 'LLM', ['companyIdentity', 'dataQuality']],
  ['financialHealth', 'Analyse santé financière', 4, 'PARALLEL', 'LLM', ['financials', 'legalEvents', 'dataReview']],
  ['openItemsReview', 'Analyse sinistres et contrats', 4, 'PARALLEL', 'LLM', ['openItems', 'dataQuality']],
  ['synthesis', 'Synthèse des analyses', 5, 'CHAIN', 'LLM', ['climateRisk', 'financialHealth', 'openItemsReview', 'dataReview']],
  ['advisorDecision', 'Décision du conseiller', 6, 'CHAIN', 'HUMAN', ['synthesis']],
].map(([id, label, phase, mode, kind, dependsOn]) => ({ id, label, phase, mode, kind, dependsOn, status: 'PENDING', calls: [] }));
const DEFAULT_DEPS = Object.fromEntries(DEFAULT_STEPS.map(s => [s.id, s.dependsOn]));

export const PHASES = {
  1: { title: 'Éligibilité', short: 'Éligibilité', note: 'Le compte client conditionne la suite.' },
  2: { title: 'Collecte et contrôle', short: 'Collecte', note: 'API de l\'État et internes, puis contrôle de cohérence.' },
  3: { title: 'Validation des données', short: 'Validation', note: 'Le conseiller confirme ou corrige.', human: true },
  4: { title: 'Analyses', short: 'Analyses', note: '2 créneaux LLM ; l\'analyse financière attend votre validation.' },
  5: { title: 'Synthèse', short: 'Synthèse', note: 'Une suggestion consultative.' },
  6: { title: 'Décision du conseiller', short: 'Décision', note: 'Le conseiller décide.', human: true },
};

// Swimlanes of the "Parcours" view: who does the work.
export const LANES = [
  { id: 'advisor', label: 'Conseiller', icon: 'person' },
  { id: 'orchestrator', label: 'Orchestrateur', icon: 'gear' },
  { id: 'state', label: "API de l'État", icon: 'bank' },
  { id: 'internal', label: 'API internes', icon: 'building' },
  { id: 'llm', label: 'Analyses LLM', icon: 'robot' },
];
const STEP_SOURCES = {
  checkAccount: { src: 'internal', text: 'API interne · CRM' },
  companyIdentity: { src: 'state', text: "API de l'État · Sirene" },
  legalEvents: { src: 'state', text: "API de l'État · BODACC" },
  financials: { src: 'state', text: "API de l'État · bilans" },
  openItems: { src: 'internal', text: 'API interne · sinistres' },
};
export function laneOf(step) {
  if (step.kind === 'HUMAN') return 'advisor';
  if (step.kind === 'RULE') return 'orchestrator';
  if (step.kind === 'LLM') return 'llm';
  if (step.kind === 'MCP') return 'state';
  return STEP_SOURCES[step.id]?.src === 'internal' ? 'internal' : 'state';
}
export function sourceOf(step) {
  if (step.kind === 'HUMAN') return { src: 'human', text: 'Conseiller' };
  if (step.kind === 'RULE') return { src: 'rule', text: 'Règle métier' };
  if (step.kind === 'LLM') return { src: 'llm', text: 'Analyse LLM · ' + (LLM_AGENTS[step.id] || step.id) };
  if (step.kind === 'MCP') return { src: 'mcp', text: STEP_SOURCES[step.id]?.text || 'MCP' };
  return STEP_SOURCES[step.id] || { src: 'external', text: 'Service' };
}

export const LLM_AGENTS = {
  dataQuality: 'data-quality', climateRisk: 'climate-risk', financialHealth: 'financial-health',
  openItemsReview: 'open-items', synthesis: 'synthèse',
};

export const STATUS = {
  PENDING: 'En attente', QUEUED: 'En file', RUNNING: 'En cours', WAITING: 'À vous',
  DONE: 'Terminée', SKIPPED: 'Non exécutée', FAILED: 'Échec',
};
export const TERMINAL = new Set(['DONE', 'SKIPPED', 'FAILED']);
export const ACTIVE = new Set(['RUNNING', 'QUEUED', 'WAITING']);

export const DECISIONS = {
  ACCEPT: 'Accepter',
  ACCEPT_WITH_SURCHARGE: 'Accepter avec surprime',
  REVIEW: 'Examen approfondi',
  REFUSE: 'Refuser',
  NOT_ELIGIBLE: 'Non éligible',
};
export const CASE_STATUS = { IN_PROGRESS: 'En cours', WAITING_ADVISOR: 'À vous', DECIDED: 'Décidé' };
export const LEVELS = { NONE: 'aucun', LOW: 'faible', MEDIUM: 'moyen', HIGH: 'fort', VERY_HIGH: 'très fort' };

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Steps in display order, whatever the backend sends (stepOrder, else the object order).
export function orderedSteps(c) {
  const order = Array.isArray(c?.stepOrder) && c.stepOrder.length ? c.stepOrder : Object.keys(c?.steps || {});
  return order.filter(id => c.steps && c.steps[id]).map(id => {
    const s = c.steps[id];
    return { id, ...s, calls: s.calls || [], dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : DEFAULT_DEPS[id] || [] };
  });
}
export const stepMap = c => Object.fromEntries(orderedSteps(c).map(s => [s.id, s]));
export const resultOf = (c, id) => c?.steps?.[id]?.result || null;

export const fmtSeconds = ms => (ms < 10000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000).toString()).replace('.', ',') + ' s';
export function durationOf(step) {
  if (!step.startedAt || !step.endedAt) return '';
  const ms = new Date(step.endedAt) - new Date(step.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? fmtSeconds(ms) : '';
}
export const euros = n => (n === undefined || n === null ? '—' : new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n));
export const pct = n => (n === undefined || n === null ? '—' : `${Math.round(n * 100)} %`);
export const frDate = s => { const d = new Date(s); return Number.isNaN(+d) ? (s || '—') : d.toLocaleDateString('fr-FR'); };
export const frTime = s => { const d = new Date(s); return Number.isNaN(+d) ? '—' : d.toLocaleTimeString('fr-FR'); };

// The phase the case is in: the first one with a step at work, waiting or queued; else the first not finished.
export function currentPhase(c) {
  const steps = orderedSteps(c);
  const busy = steps.filter(s => ACTIVE.has(s.status));
  if (busy.length) return Math.min(...busy.map(s => s.phase));
  const open = steps.filter(s => !TERMINAL.has(s.status));
  return open.length ? Math.min(...open.map(s => s.phase)) : null;
}

// Short-circuits that the orchestrator applies (SCENARIO.md, "Règles de l'orchestrateur").
export function shortCircuit(c) {
  const steps = c?.steps || {};
  const codes = (c?.escalation?.reasons || []).map(r => r.code);
  if ((steps.checkAccount?.calls || []).some(x => Number(x.status) === 404) || codes.includes('UNKNOWN_CUSTOMER')) return 'unknown-customer';
  const analyses = ['climateRisk', 'financialHealth', 'openItemsReview'];
  if (codes.includes('COLLECTIVE_PROCEDURE') || (analyses.every(id => steps[id]?.status === 'SKIPPED') && steps.synthesis?.kind === 'RULE')) return 'collective-procedure';
  return null;
}

// INSEE headcount ranges look like "6-9", "10-19", "250+" in the mocks.
export function headcountMismatch(range, declared) {
  if (declared === undefined || declared === null || !range) return null;
  const m = String(range).match(/(\d+)\s*(?:-|à)\s*(\d+)/);
  if (m) return declared < +m[1] || declared > +m[2];
  const plus = String(range).match(/(\d+)\s*\+/);
  return plus ? declared < +plus[1] : null;
}

const COLLECTIVE = /redressement|liquidation|sauvegarde|proc[ée]dure collective/i;
export const isCollective = rec => COLLECTIVE.test(`${rec?.type || ''} ${rec?.nature || ''}`);

// A step that cannot start before the advisor acts (financialHealth waits for dataReview).
export function blockedByAdvisor(c, step) {
  if (!['PENDING', 'QUEUED'].includes(step.status)) return null;
  const steps = c?.steps || {};
  // Blocked by the advisor only when the advisor is all it still waits for.
  const deps = step.dependsOn || [];
  const human = deps.find(d => steps[d]?.kind === 'HUMAN' && steps[d]?.status !== 'DONE');
  if (!human) return null;
  return deps.every(d => d === human || ['DONE', 'SKIPPED', 'FAILED'].includes(steps[d]?.status)) ? human : null;
}

// v3: the natural risks come from the climate agent, which fetched them with its MCP tool (reShapr → Géorisques).
// { commune, risquesNaturels } — older cases carried them in a geoRisks step.
export function naturalRisksOf(c) {
  return c?.steps?.climateRisk?.result?.naturalRisks || c?.steps?.geoRisks?.result || null;
}

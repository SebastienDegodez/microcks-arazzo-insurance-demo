// Calls go through the BFF of the host: /bff/{orchestrator|microcks|fake}/…; X-Backend says who answered.
const KEY = 'csp.backend';

export const BACKENDS = {
  orchestrator: { label: 'Orchestrateur .NET', where: 'localhost:5180' },
  microcks: { label: 'Microcks (mock)', where: 'localhost:8080 · Underwriting cases 1.0.0' },
  fake: { label: 'Données factices', where: 'hôte IHM (développement)' },
};

export function forcedBackend() {
  const q = new URLSearchParams(location.search).get('backend');
  return q && BACKENDS[q] ? q : null;
}

export function getBackend() {
  const forced = forcedBackend();
  if (forced) return forced;
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'orchestrator' || v === 'microcks') return v;
  } catch (e) { /* storage blocked: default */ }
  return 'orchestrator';
}

export function saveBackend(b) {
  try { localStorage.setItem(KEY, b); } catch (e) { /* not persisted */ }
}

export class BackendError extends Error {
  constructor(kind, backend, status, body) {
    super(kind === 'unreachable' ? `${backend} injoignable` : kind === 'host' ? 'Hôte IHM injoignable' : `HTTP ${status}`);
    Object.assign(this, { kind, backend, status, body });
  }
}

const listeners = new Set();
export const onAnswer = fn => listeners.add(fn);

export async function call(backend, method, path, body) {
  let res;
  try {
    res = await fetch(`/bff/${backend}/${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch (e) {
    listeners.forEach(fn => fn({ requested: backend, answeredBy: null, status: 0, unreachable: true }));
    throw new BackendError('host', backend, 0);
  }
  const unreachable = res.headers.get('X-Bff-Error') === 'unreachable';
  const answeredBy = res.headers.get('X-Backend');
  listeners.forEach(fn => fn({ requested: backend, answeredBy, status: res.status, unreachable }));
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (unreachable) throw new BackendError('unreachable', backend, res.status, data);
  if (!res.ok) throw new BackendError('http', backend, res.status, data);
  return { data, answeredBy, status: res.status };
}

export async function health() {
  try {
    const res = await fetch('/bff/health', { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch (e) {
    return null;
  }
}

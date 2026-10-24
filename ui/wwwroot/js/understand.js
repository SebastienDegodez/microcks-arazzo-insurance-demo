// Mode « Comprendre », synchronised with the live case (SCENARIO.md v3): at each poll the state is compared with
// the previous one, and a node only moves for a call that is really made.
// - A step that turns RUNNING sends its request to its target, which pulses while it works; the response comes
//   back when the step ends. Parallel steps leave together.
// - The climate agent follows its own calls: MCP tools/list, the model (which asks for a tool), the tool run for
//   the model through reShapr (MCP) → Géorisques (mocked by Microcks), then the model again with the result.
// - In mock mode, Microcks answers instead of the orchestrator: only IHM ⇄ Microcks moves, nothing downstream.
// - The advisor's POSTs are IHM → orchestrator hops at the click. Everything is recorded for the replay.
import { FlowDiagram } from './flow-diagram.js';
import { DECISIONS, PHASES, TERMINAL, blockedByAdvisor, currentPhase, esc, orderedSteps, shortCircuit } from './domain.js';

const IHM = 'ihm', ORCH = 'orch', UW = 'uw', LLM = 'llm', MCP = 'reshapr', GEO = 'svc:Georisques';
const TARGET = {
  checkAccount: 'svc:Customer accounts', companyIdentity: 'svc:Sirene', legalEvents: 'svc:BODACC',
  financials: 'svc:Company financials', openItems: 'svc:Claims and contracts',
};
const PATHS = {
  checkAccount: s => `GET /customers/by-siren/${s}`, companyIdentity: s => `GET /siren/${s}`,
  legalEvents: s => `GET /annonces?siren=${s}`, financials: s => `GET /companies/${s}/financials`,
  openItems: () => 'GET /customers/…/open-items',
};
const AGENT = { dataQuality: 'data-quality', climateRisk: 'climate-risk', financialHealth: 'financial-health', openItemsReview: 'open-items', synthesis: 'synthèse' };
const DEFAULT_MCP_HOST = 'localhost:7778';
const MOCK_CAPTION = 'Mode mock : Microcks joue l\'orchestrateur, aucun appel réel en aval.';

// The host serving the MCP, for the node's subtitle only: the node is always « reShapr (MCP) ».
function mcpHostOf(c) {
  const call = orderedSteps(c || {}).flatMap(s => s.calls).find(x => x.via === 'MCP');
  try { return call ? new URL(call.url).host : null; } catch (e) { return null; }
}

// How far the climate agent's tool loop went, from its calls (each call shows up once it is over):
// 0 nothing, 1 tools/list, 2 model asked for a tool, 3 tool run through reShapr, 4 model answered.
function toolLoopProgress(calls) {
  const llmIdx = calls.map((x, i) => (x.via === 'LLM' ? i : -1)).filter(i => i >= 0);
  if (!llmIdx.length) return calls.some(x => x.via === 'MCP') ? 1 : 0;
  if (llmIdx.length === 1) return calls.slice(llmIdx[0] + 1).some(x => x.via === 'MCP') ? 3 : 2;
  return 4;
}
const usesTools = step => step.id === 'climateRisk' && step.kind === 'LLM';

// Portrait layout for the side panel. Outside Microcks: IHM, the orchestrator, reShapr (above the frame).
// In the frame: Géorisques under reShapr, the LLM gateway and the other mocks in a column fanned from the caller.
function graph(backend, mcpHost) {
  const flip = backend === 'microcks';
  const W = 600, NH = 40, GAP = 12, top = 86;
  const colB = { x: 488, w: 186 }, colA = { x: 290, w: 156 };
  const list = [
    { id: LLM, label: 'Passerelle LLM', sub: 'LLM gateway · mock', kind: 'llm', icon: 'robot' },
    { id: 'svc:Customer accounts', label: 'CRM client', sub: 'Customer accounts', kind: 'mock', icon: 'building' },
    { id: 'svc:Sirene', label: 'Sirene', sub: 'INSEE · État', kind: 'mock', icon: 'bank' },
    { id: 'svc:BODACC', label: 'BODACC', sub: 'annonces légales', kind: 'mock', icon: 'bank' },
    { id: 'svc:Company financials', label: 'Bilans', sub: 'Company financials', kind: 'mock', icon: 'bank' },
    { id: 'svc:Claims and contracts', label: 'Sinistres', sub: 'Claims and contracts', kind: 'mock', icon: 'building' },
  ];
  const nodes = list.map((t, i) => ({ ...t, x: colB.x, y: top + 44 + NH / 2 + i * (NH + GAP), w: colB.w, h: NH }));
  const firstY = nodes[0].y;
  const frameH = 44 + list.length * (NH + GAP) - GAP + 16;
  const frame = { x: 168, y: top, w: W - 178, h: frameH, label: 'Microcks', sub: 'localhost:8080' };
  const midY = top + frameH / 2 + 8;
  nodes.push({ id: GEO, label: 'Géorisques', sub: 'API simulée par Microcks', kind: 'mock', icon: 'map', x: colA.x, y: firstY, w: colA.w, h: NH });
  nodes.push({ id: MCP, label: 'reShapr (MCP)', sub: mcpHost || DEFAULT_MCP_HOST, kind: 'reshapr', icon: 'plug', x: colA.x, y: 38, w: colA.w, h: NH });
  nodes.push({ id: IHM, label: 'IHM conseiller', sub: 'navigateur + BFF', kind: 'ui', icon: 'person', x: 82, y: 38, w: 150 });
  if (flip) {
    nodes.push({ id: ORCH, label: 'Orchestrateur .NET', sub: 'hors circuit (mock)', kind: 'off', icon: 'gear', x: 82, y: midY + 120, w: 150 });
    nodes.push({ id: UW, label: 'Underwriting cases', sub: 'mock : joue l\'orchestrateur', kind: 'uw', icon: 'gear', x: colA.x, y: midY, w: colA.w + 10, h: 56 });
  } else {
    nodes.push({ id: ORCH, label: 'Orchestrateur', sub: '.NET · :5180', kind: 'orch', icon: 'gear', x: 82, y: midY, w: 150, h: 52 });
  }
  // In mock mode nothing downstream is called: those nodes stay at rest (only the bypassed orchestrator is grey).
  // reShapr is still the model's tool, referenced by the real orchestrator: a dotted link, never a packet.
  const caller = flip ? UW : ORCH;
  const toolLink = [LLM, MCP, { cls: 'tool', label: 'outil du modèle', note: flip ? ['référencé par l\'orchestrateur réel :', 'appelé seulement quand il tourne'] : null }];
  const links = flip ? [[IHM, UW], toolLink, [MCP, GEO, { cls: 'rest' }]]
    : [[IHM, ORCH], ...list.map(t => [ORCH, t.id]), [ORCH, MCP], toolLink, [MCP, GEO]];
  const height = Math.max(...nodes.map(n => n.y + (n.h || 42) / 2)) + 14;
  return { nodes, links, frame, width: W, height, caller };
}

export class Understand {
  constructor(host) {
    this.host = host;
    this.fd = null;
    this.visible = false;
    this.reset('orchestrator');
  }

  ensure() {
    if (this.fd) return;
    this.fd = new FlowDiagram(this.host, { title: 'Qui appelle qui, en direct' });
    this.fd.onReplay = () => this.replay();
  }

  get flip() { return this.backend === 'microcks'; }

  /* ---------- Lifecycle, called by the app ---------- */
  reset(backend) {
    this.backend = backend;
    this.c = null;
    this.siren = null;
    this.prev = {};
    this.prevSig = '';
    this.said = new Set();
    this.inflight = {};
    this.segDone = {};
    this.started = {};
    this.posted = {};
    this.recording = [];
    this.t0 = null;
    this.mcpHost = null;
    this.replaying = false;
    if (this.fd && this.visible) { this.fd.gen++; this.draw(true); }
  }

  show(backend, c) {
    this.visible = true;
    this.ensure();
    if (!c) this.backend = backend;
    this.draw(true);
    if (c) {
      this.catchUp(c);
      if (c.status === 'DECIDED') {
        this.fd.replayBtn.disabled = false;
        this.fd.idle('Dossier décidé : <b>Rejouer</b> pour revoir qui a appelé qui.');
      }
    }
  }

  hide() {
    this.visible = false;
    if (this.fd) this.fd.gen++;
  }

  open(siren) {
    this.siren = siren;
    this.record({ type: 'open' });
    if (this.visible) this.onOpen();
  }

  created(data) {
    this.record({ type: 'created', caseId: data.caseId });
    if (this.visible) this.onCreated(data.caseId);
  }

  onCase(c) {
    this.record({ type: 'case', c });
    if (this.visible && !this.replaying) this.apply(c);
    else { this.c = c; this.prev = statuses(c); this.prevSig = signature(c); }
  }

  post(kind) {
    this.posted[kind === 'data-review' ? 'dataReview' : 'advisorDecision'] = true;
    this.record({ type: 'post', kind });
    if (this.visible && !this.replaying) this.onPost(kind);
  }

  postResult(kind, ok) {
    this.record({ type: 'postResult', kind, ok });
    if (this.visible && !this.replaying) this.onPostResult(kind, ok);
  }

  record(entry) {
    if (this.replaying) return;
    const t = performance.now();
    if (this.t0 === null) this.t0 = t;
    this.recording.push({ ...entry, t: t - this.t0 });
  }

  /* ---------- Drawing ---------- */
  draw(clear) {
    this.g = graph(this.backend, this.mcpHost);
    this.fd.layout(this.g);
    if (clear) {
      this.fd.clearLog();
      this.fd.replayBtn.disabled = true;
      this.fd.idle(this.flip
        ? `<b>${MOCK_CAPTION}</b> Seul l'échange IHM ⇄ Microcks (mock de l'orchestrateur) est animé. reShapr reste l'outil du modèle, référencé par l'orchestrateur réel : il n'est appelé que lorsque l'orchestrateur tourne.`
        : 'Ouvrez un dossier : chaque paquet suit un appel réellement fait par l\'orchestrateur (requête, réponse, MCP, LLM, conseiller).');
    }
  }

  // Arriving in the middle of a case: no animation for the past, the targets of running steps pulse.
  catchUp(c) {
    this.c = c;
    const host = mcpHostOf(c);
    if (host && host !== this.mcpHost) { this.mcpHost = host; this.draw(false); }
    const steps = orderedSteps(c);
    steps.forEach(s => {
      if (!this.flip && s.status === 'RUNNING' && !usesTools(s)) this.targetsOf(s).forEach(t => this.fd.busy(t, +1));
      if (s.status === 'WAITING') this.fd.busy(IHM, +1, 'waiting');
      if (usesTools(s)) this.segDone[s.id] = toolLoopProgress(s.calls);
    });
    this.prev = statuses(c);
    this.prevSig = signature(c);
    this.badges(c);
    if (c.status !== 'DECIDED') this.fd.say(`Vous rejoignez le dossier en cours : ${phaseText(c)}.${this.flip ? ' ' + MOCK_CAPTION : ''}`, 'req');
  }

  onOpen() {
    this.draw(true);
    this.fd.say(this.flip
      ? `Le conseiller ouvre le dossier : <code>POST /underwriting-cases</code> au <b>mock Microcks</b>, qui joue l'orchestrateur. ${MOCK_CAPTION}`
      : 'Le conseiller ouvre le dossier : l\'IHM envoie <code>POST /underwriting-cases</code> à l\'<b>orchestrateur .NET</b>.', 'req');
    this.openHop = this.fd.hop({ from: IHM, to: this.g.caller, label: 'POST /underwriting-cases', tone: 'req', dur: 700 });
  }

  onCreated(caseId) {
    (this.openHop || Promise.resolve()).then(() => this.fd.hop({ from: this.g.caller, to: IHM, label: `202 · ${caseId}`, tone: 'ok', dur: 700 }));
  }

  onPost(kind) {
    const what = kind === 'data-review' ? 'valide les données' : 'enregistre sa décision';
    this.fd.say(`<b>Le conseiller ${what}</b> : <code>POST …/${kind}</code>, de l'IHM vers ${this.flip ? 'le mock Microcks' : 'l\'orchestrateur'}.`, 'post');
    this.postHop = this.fd.hop({ from: IHM, to: this.g.caller, label: `POST …/${kind}`, tone: 'post', dur: 700 });
  }

  onPostResult(kind, ok) {
    (this.postHop || Promise.resolve()).then(() => this.fd.hop({ from: this.g.caller, to: IHM, label: ok ? '200' : 'refusé', tone: ok ? 'ok' : 'ko', dur: 700 }));
  }

  targetsOf(step) {
    if (step.kind === 'LLM') return [LLM];
    return TARGET[step.id] ? [TARGET[step.id]] : [];
  }

  /* ---------- Real calls of the orchestrator ---------- */
  // Chains hops for one step, so its response never overtakes its request.
  chain(id, fn) {
    const gen = this.fd.gen;
    this.inflight[id] = (this.inflight[id] || Promise.resolve()).then(() => (this.fd.gen === gen ? fn() : null));
    return this.inflight[id];
  }

  request(step) {
    if (step.kind === 'RULE' || step.kind === 'HUMAN') return;
    if (usesTools(step)) {
      const k = this.segDone[step.id] || 0;
      this.segDone[step.id] = k;
      this.started[step.id] = k;
      this.startSegment(step, k);
      return;
    }
    const target = this.targetsOf(step)[0];
    if (!target) return;
    const label = step.kind === 'LLM' ? `agent ${AGENT[step.id] || step.id}` : (PATHS[step.id] || (() => step.label))(this.c?.siren || this.siren || '');
    this.chain(step.id, () => this.fd.hop({ from: ORCH, to: target, label, tone: step.kind === 'LLM' ? 'llm' : 'req' }).then(() => this.fd.busy(target, +1)));
  }

  response(step) {
    if (step.kind === 'RULE' || step.kind === 'HUMAN') return;
    if (usesTools(step)) { this.advanceTools(step, true); return; }
    const target = this.targetsOf(step)[0];
    if (!target) return;
    const failed = step.status === 'FAILED' || step.calls.some(x => Number(x.status) >= 400 || Number(x.status) === 0);
    const label = failed ? String(step.calls.find(x => Number(x.status) >= 400)?.status || 'échec') : step.kind === 'LLM' ? `200 · ${AGENT[step.id] || ''}` : '200';
    this.chain(step.id, () => { this.fd.busy(target, -1); return this.fd.hop({ from: target, to: ORCH, label, tone: failed ? 'ko' : 'ok' }); });
  }

  // The climate agent's tool loop, segment by segment, as its calls show up.
  startSegment(step, k) {
    const id = step.id;
    if (k === 0) {
      this.once('tools-list', '<b>Agent climat</b> : l\'orchestrateur liste les outils de <b>reShapr (MCP)</b> (<code>tools/list</code>).', 'mcp');
      this.chain(id, () => this.fd.hop({ from: ORCH, to: MCP, label: 'tools/list', tone: 'mcp' }).then(() => this.fd.busy(MCP, +1)));
    } else if (k === 1) {
      this.chain(id, () => this.fd.hop({ from: ORCH, to: LLM, label: 'agent climate-risk + outils', tone: 'llm' }).then(() => this.fd.busy(LLM, +1)));
    } else if (k === 2) {
      this.once('tool-call', `Le modèle demande l'outil <code>get_resultats_rapport_risque</code> : <b>l'orchestrateur l'exécute pour son compte</b> via reShapr (MCP). <b>reShapr expose Géorisques en MCP ; Microcks simule l'API derrière lui.</b>`, 'mcp');
      this.chain(id, () => this.fd.hop({ from: LLM, to: MCP, label: 'get_resultats_rapport_risque', tone: 'mcp' })
        .then(() => { this.fd.busy(MCP, +1); return this.fd.hop({ from: MCP, to: GEO, label: 'GET /resultats_rapport_risque', tone: 'mcp' }); })
        .then(() => this.fd.busy(GEO, +1)));
    } else if (k === 3) {
      this.chain(id, () => this.fd.hop({ from: ORCH, to: LLM, label: 'résultat de l\'outil (role: tool)', tone: 'llm' }).then(() => this.fd.busy(LLM, +1)));
    }
  }

  endSegment(step, k, failed) {
    const id = step.id;
    const tone = failed ? 'ko' : 'ok';
    if (k === 0) this.chain(id, () => { this.fd.busy(MCP, -1); return this.fd.hop({ from: MCP, to: ORCH, label: 'outils', tone }); });
    else if (k === 1) this.chain(id, () => { this.fd.busy(LLM, -1); return this.fd.hop({ from: LLM, to: ORCH, label: 'tool_calls', tone }); });
    else if (k === 2) {
      this.chain(id, () => { this.fd.busy(GEO, -1); return this.fd.hop({ from: GEO, to: MCP, label: '200', tone }); })
        .then(() => this.chain(id, () => { this.fd.busy(MCP, -1); return this.fd.hop({ from: MCP, to: ORCH, label: 'risques naturels', tone }); }));
    } else if (k === 3) this.chain(id, () => { this.fd.busy(LLM, -1); return this.fd.hop({ from: LLM, to: ORCH, label: `200 · ${step.result?.level || 'climat'}`, tone }); });
  }

  // Catches up with the calls the step made since the last poll; at the end, closes what is still open.
  advanceTools(step, finished) {
    const id = step.id;
    let done = this.segDone[id] || 0;
    const target = finished ? Math.max(toolLoopProgress(step.calls), step.status === 'DONE' ? 4 : 0) : toolLoopProgress(step.calls);
    const failed = step.status === 'FAILED';
    if (this.started[id] === undefined) this.started[id] = done - 1;
    while (done < target) {
      if (this.started[id] < done) { this.startSegment(step, done); this.started[id] = done; }
      this.endSegment(step, done, false);
      done++;
      if (done < 4 && (!finished || done < target)) { this.startSegment(step, done); this.started[id] = done; }
    }
    if (finished && failed && this.started[id] === done && done < 4) this.endSegment(step, done, true);
    this.segDone[id] = done;
  }

  badges(c) {
    const pa = c.pendingAction;
    this.fd.badge(IHM, c.status === 'DECIDED' ? '' : pa === 'DATA_REVIEW' ? 'à vous : valider' : pa === 'DECISION' ? 'à vous : décider' : '', 'human');
    if (this.flip) return;
    const llm = orderedSteps(c).filter(s => s.kind === 'LLM');
    const running = llm.filter(s => s.status === 'RUNNING').length;
    const queued = llm.filter(s => s.status === 'QUEUED').length;
    const blocked = llm.filter(s => blockedByAdvisor(c, s)).length;
    const parts = [running && `${running} en cours`, queued && `${queued} en file`, blocked && `${blocked} attend le conseiller`].filter(Boolean);
    this.fd.badge(LLM, parts.join(' · '), queued || blocked ? 'queue' : 'run');
  }

  once(key, text, tone) {
    if (this.said.has(key)) return;
    this.said.add(key);
    this.fd.say(text, tone);
  }

  // The heart of the live mode: what changed since the previous poll.
  apply(c) {
    this.c = c;
    const host = mcpHostOf(c);
    if (host && host !== this.mcpHost) {
      this.mcpHost = host;
      this.draw(false);
      this.inflight = {};
      if (!this.flip) orderedSteps(c).forEach(s => { if (s.status === 'RUNNING' && this.prev[s.id] === 'RUNNING' && !usesTools(s)) this.targetsOf(s).forEach(t => this.fd.busy(t, +1)); });
      if (Object.values(this.prev).includes('WAITING')) this.fd.busy(IHM, +1, 'waiting');
    }
    const steps = orderedSteps(c);
    const phase = currentPhase(c);
    if (phase && !this.said.has('phase' + phase)) this.phaseCaption(phase, steps);
    if (this.flip) this.applyMock(c, steps); else this.applyLive(c, steps);
    this.prev = statuses(c);
    this.prevSig = signature(c);
    this.badges(c);
    if (c.status === 'DECIDED') {
      const a = c.advisorDecision || {};
      this.once('decided', `Dossier décidé par le conseiller : <b>${esc(DECISIONS[a.finalDecision] || a.finalDecision || '')}</b>${a.followsRecommendation === false ? ', en s\'écartant de la suggestion' : ''}.${this.replaying ? '' : ' <b>Rejouer</b> pour revoir le dossier.'}`, 'ok');
      if (!this.replaying) this.fd.replayBtn.disabled = false;
    }
  }

  // Mock mode: Microcks answers each GET with the next state of the case; nothing is called downstream.
  applyMock(c, steps) {
    const sig = signature(c);
    if (sig !== this.prevSig && !this.pollHop) {
      this.pollHop = this.fd.hop({ from: IHM, to: UW, label: `GET …/${c.caseId}`, tone: 'req', dur: 600 })
        .then(() => this.fd.hop({ from: UW, to: IHM, label: `200 · ${c.status === 'DECIDED' ? 'décidé' : phaseText(c)}`, tone: 'ok', dur: 600 }))
        .finally(() => { this.pollHop = null; });
    }
    // The business story still holds: it is in the case Microcks returns, not in calls made downstream.
    const sc = shortCircuit(c);
    if (sc === 'unknown-customer' && c.steps.checkAccount && TERMINAL.has(c.steps.checkAccount.status)) this.once('unknown', '<b>Client introuvable</b> dans le dossier renvoyé par le mock : le parcours s\'arrête après la 1ʳᵉ étape, aucune analyse. Le conseiller confirme quand même.', 'ko');
    if (sc === 'collective-procedure' && ['climateRisk', 'financialHealth', 'openItemsReview'].some(id => c.steps[id]?.status === 'SKIPPED')) this.once('collective', '<b>Procédure collective</b> dans le dossier renvoyé par le mock : les analyses ne sont pas lancées, la suggestion vient d\'une règle.', 'ko');
    this.humanWaits(c, steps);
  }

  applyLive(c, steps) {
    steps.forEach(s => {
      const before = this.prev[s.id] || 'PENDING';
      const now = s.status;
      if (usesTools(s) && now === 'RUNNING' && before === 'RUNNING') { this.advanceTools(s, false); return; }
      if (before === now) return;
      if (now === 'RUNNING') {
        this.request(s);
        if (usesTools(s)) this.advanceTools(s, false);
        if (s.id === 'dataQuality') this.once('dq', '<b>Contrôle de la collecte</b> : l\'agent qualité compare CRM, Sirene et bilan, sans attendre la fin de la collecte.', 'llm');
      } else if (now === 'QUEUED') {
        this.once('queue' + s.id, `<b>File d'attente LLM</b> : 2 créneaux au maximum, « ${esc(s.label)} » attend son tour.`, 'llm');
      } else if (TERMINAL.has(now) && before !== 'WAITING') {
        if (before === 'RUNNING') this.response(s);
        else if (now !== 'SKIPPED' && s.calls.length) {
          // Started and ended between two polls: the request and its response, back to back.
          this.request(s);
          this.response(s);
        }
        if (s.id === 'checkAccount' && shortCircuit(c) === 'unknown-customer') this.once('unknown', '<b>Client introuvable</b> (404) : l\'orchestrateur <b>coupe court</b> ; aucune API de l\'État, aucun MCP, <b>aucun LLM appelé</b>. Le conseiller confirme quand même.', 'ko');
        if (now === 'SKIPPED' && ['climateRisk', 'financialHealth', 'openItemsReview'].includes(s.id) && shortCircuit(c) === 'collective-procedure') this.once('collective', '<b>Procédure collective</b> au BODACC : l\'orchestrateur coupe court, les analyses ne sont pas lancées, <b>aucun LLM appelé</b>. La suggestion vient d\'une règle.', 'ko');
        if (s.id === 'synthesis' && s.kind === 'RULE' && now === 'DONE') this.once('rule', `<b>Règle métier</b> : suggestion « ${esc(DECISIONS[c.recommendation?.decision] || c.recommendation?.decision || '')} », sans LLM.`, 'ko');
      }
    });
    this.humanWaits(c, steps);
  }

  // The advisor's checkpoints: a wait on the IHM, and the POST hop if it was not drawn at the click.
  humanWaits(c, steps) {
    steps.filter(s => s.kind === 'HUMAN').forEach(s => {
      const before = this.prev[s.id] || 'PENDING';
      if (before === s.status) return;
      if (s.status === 'WAITING') {
        this.fd.busy(IHM, +1, 'waiting');
        if (s.id === 'dataReview') this.once('wait-review', `<b>À vous</b> : validation des données attendue.${this.flip ? '' : ' <b>Tout avance sauf l\'analyse financière</b>, qui attend cette validation.'}`, 'post');
        else this.once('wait-decision', `<b>À vous</b> : la décision revient au conseiller.${c.escalation?.level === 'REINFORCED' ? ` <b>Décision renforcée</b> : ${c.escalation.reasons.length} raison${c.escalation.reasons.length > 1 ? 's' : ''} à reconnaître une à une.` : ''}`, 'post');
      } else if (before === 'WAITING' && TERMINAL.has(s.status)) {
        this.fd.busy(IHM, -1, 'waiting');
        if (!this.posted[s.id]) {
          const kind = s.id === 'dataReview' ? 'data-review' : 'advisor-decision';
          this.posted[s.id] = true;
          this.onPost(kind); this.onPostResult(kind, true);
        }
      }
    });
  }

  phaseCaption(phase, steps) {
    this.said.add('phase' + phase);
    if (this.flip) {
      this.fd.say(`Microcks renvoie le dossier en <b>phase ${phase} · ${esc(PHASES[phase].title.toLowerCase())}</b>. ${MOCK_CAPTION}`, PHASES[phase].human ? 'post' : 'req');
      return;
    }
    const running = steps.filter(s => s.phase === phase && s.status === 'RUNNING').length;
    const text = {
      1: '<b>Phase 1 — éligibilité.</b> L\'orchestrateur vérifie d\'abord le compte client dans le CRM interne.',
      2: `<b>Phase 2 — collecte en parallèle.</b> ${running > 1 ? running + ' appels partent' : 'Les appels partent'} vers les API de l'État et internes, en ordre dispersé ; le contrôle qualité démarre dès que l'identité et le bilan sont là.`,
      3: '<b>Phase 3 — le conseiller valide les données.</b> Sa validation débloque l\'analyse financière.',
      4: '<b>Phase 4 — analyses</b> par la passerelle LLM mockée par Microcks, <b>2 créneaux au maximum</b>. L\'agent climat va chercher les risques naturels avec son outil MCP.',
      5: '<b>Phase 5 — synthèse</b> : une suggestion <b>consultative</b>, à partir des analyses.',
      6: '<b>Phase 6 — décision du conseiller.</b> C\'est lui qui décide.',
    }[phase];
    if (text) this.fd.say(text, PHASES[phase].human ? 'post' : phase === 4 || phase === 5 ? 'llm' : 'req');
  }

  /* ---------- Replay: the recorded polls and clicks, faster ---------- */
  async replay() {
    if (!this.fd) return;
    let entries = this.recording;
    if (!entries.some(e => e.type === 'case') && this.c) entries = synthesize(this.c);
    const total = entries.length ? entries[entries.length - 1].t : 0;
    const factor = Math.max(1, total / 24000);
    const saved = { prev: this.prev, prevSig: this.prevSig, said: this.said, posted: this.posted, c: this.c, segDone: this.segDone, started: this.started };
    Object.assign(this, { prev: {}, prevSig: '', said: new Set(), posted: {}, inflight: {}, segDone: {}, started: {} });
    this.replaying = true;
    this.draw(true);
    const gen = this.fd.gen;
    let last = 0;
    for (const e of entries) {
      const gap = Math.min(3500, (e.t - last) / factor);
      last = e.t;
      await this.fd.sleep(gap);
      if (this.fd.gen !== gen || !this.visible) break;
      if (e.type === 'open') this.onOpen();
      else if (e.type === 'created') this.onCreated(e.caseId || this.c?.caseId || '');
      else if (e.type === 'case') this.apply(e.c);
      else if (e.type === 'post') { this.posted[e.kind === 'data-review' ? 'dataReview' : 'advisorDecision'] = true; this.onPost(e.kind); }
      else if (e.type === 'postResult') this.onPostResult(e.kind, e.ok);
    }
    this.replaying = false;
    if (this.fd.gen === gen) this.fd.replayBtn.disabled = false;
    Object.assign(this, saved);
  }
}

const statuses = c => Object.fromEntries(orderedSteps(c).map(s => [s.id, s.status]));
const signature = c => JSON.stringify([c.status, c.pendingAction, orderedSteps(c).map(s => [s.status, s.calls.length])]);
function phaseText(c) {
  const p = currentPhase(c);
  return p ? `phase ${p} · ${PHASES[p].title.toLowerCase()}` : 'dossier terminé';
}

// No recording (the panel was opened after the case): rebuild the polls from startedAt / endedAt.
function synthesize(c) {
  const steps = orderedSteps(c);
  const t0 = Date.parse(c.createdAt) || Math.min(...steps.map(s => Date.parse(s.startedAt)).filter(Number.isFinite));
  const times = [...new Set(steps.flatMap(s => [s.startedAt, s.endedAt]).filter(Boolean).map(Date.parse).filter(Number.isFinite))].sort((a, b) => a - b);
  const out = [{ type: 'open', t: 0 }, { type: 'created', t: 300, caseId: c.caseId }];
  const lastT = times[times.length - 1];
  times.forEach(T => {
    const snap = JSON.parse(JSON.stringify(c));
    let waiting = null;
    Object.entries(snap.steps).forEach(([id, s]) => {
      const st = Date.parse(s.startedAt), en = Date.parse(s.endedAt);
      if (s.status === 'SKIPPED') {
        const deps = (s.dependsOn || []).map(d => Date.parse(c.steps[d]?.endedAt)).filter(Number.isFinite);
        s.status = deps.length && Math.max(...deps) > T ? 'PENDING' : 'SKIPPED';
      } else if (!Number.isFinite(st) || T < st) { s.status = 'PENDING'; s.calls = []; }
      else if (Number.isFinite(en) && T < en) {
        s.status = s.kind === 'HUMAN' ? 'WAITING' : 'RUNNING';
        if (s.kind === 'HUMAN') waiting = id;
        // Calls show up as the step goes: a share of them, in proportion to the time spent.
        s.calls = (s.calls || []).slice(0, Math.floor(((T - st) / (en - st)) * (s.calls || []).length));
      }
    });
    snap.pendingAction = waiting === 'dataReview' ? 'DATA_REVIEW' : waiting === 'advisorDecision' ? 'DECISION' : null;
    snap.status = T >= lastT ? c.status : 'IN_PROGRESS';
    out.push({ type: 'case', t: 300 + T - t0, c: snap });
  });
  return out;
}

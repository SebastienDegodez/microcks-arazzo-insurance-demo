// "Parcours": the case on a real time axis, one swimlane per actor (advisor, orchestrator, State APIs, internal
// APIs, LLM analyses). Bars follow startedAt / endedAt; RUNNING bars grow live; an LLM step that waited for a slot
// shows its queue before its bar; the advisor's checkpoints are milestones (diamonds) after a growing wait;
// arrows draw dependsOn. A bar opens the step detail.
import { LANES, PHASES, STATUS, blockedByAdvisor, esc, fmtSeconds, laneOf, orderedSteps } from './domain.js';
import { ICON_PATHS } from './icons.js';
import { morph } from './morph.js';

const ROW = 30, HEAD = 24, AXIS = 30, PAD_R = 18;
const KEY_EDGES = new Set(['companyIdentity>dataQuality', 'financials>dataQuality', 'checkAccount>dataQuality', 'dataQuality>dataReview', 'dataReview>financialHealth']);
const iconSvg = (name, x, y, s = 0.62) => `<g transform="translate(${x} ${y}) scale(${s})" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name] || ''}</g>`;

export class Timeline {
  constructor(host, { onOpen, serverNow }) {
    this.host = host;
    this.onOpen = onOpen;
    this.serverNow = serverNow;
    this.c = null;
    this.span = 60000;
    this.showAll = true;
    host.innerHTML = `
      <div class="gantt-tools">
        <ul class="gantt-legend" aria-label="Légende">
          <li><i class="lg run"></i>en cours</li><li><i class="lg done"></i>terminée</li><li><i class="lg queue"></i>file d'attente LLM</li>
          <li><i class="lg wait"></i>attente du conseiller</li><li><i class="lg ms"></i>jalon du conseiller</li><li><i class="lg dep"></i>dépendance</li>
        </ul>
        <label class="gantt-toggle"><input type="checkbox" id="ganttAll" checked> Toutes les dépendances</label>
      </div>
      <div class="gantt-scroll"><div class="gantt-canvas"></div></div>
      <p class="gantt-hint muted">Une barre s'ouvre au clic (ou Entrée) : résumé, données et appels de l'étape.</p>`;
    this.canvas = host.querySelector('.gantt-canvas');
    host.querySelector('#ganttAll').addEventListener('change', e => { this.showAll = e.target.checked; this.render(); });
    // The canvas is redrawn several times a second: remember the bar under the pointer at pointerdown.
    this.canvas.addEventListener('pointerdown', e => { this.downStep = e.target.closest('[data-step]')?.dataset.step; });
    this.canvas.addEventListener('click', e => { const id = e.target.closest('[data-step]')?.dataset.step || this.downStep; this.downStep = null; if (id) this.onOpen(id); });
    this.canvas.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const g = e.target.closest('[data-step]');
      if (g) { e.preventDefault(); this.onOpen(g.dataset.step); }
    });
    // Redraw on resize, but only when the width changes (a redraw must not feed the observer back).
    new ResizeObserver(() => { const w = host.clientWidth; if (w !== this.lastWidth) { this.lastWidth = w; this.render(); } }).observe(host);
  }

  update(c) { this.c = c; this.render(); }

  render() {
    const host = this.canvas;
    if (!this.host.isConnected || this.host.closest('[hidden]')) return;
    const width = Math.max(560, this.host.clientWidth - 2);
    const c = this.c;
    if (!c) { morph(host, '<p class="empty-line">Ouvrez un dossier : son parcours se dessine ici, en temps réel.</p>'); return; }
    const focused = document.activeElement?.closest?.('.gantt-canvas [data-step]')?.dataset.step;
    const steps = orderedSteps(c);
    const byId = Object.fromEntries(steps.map(s => [s.id, s]));
    const LABEL = width < 760 ? 150 : 214;
    const trackW = width - LABEL - PAD_R;
    const t0 = Date.parse(c.createdAt) || Math.min(...steps.map(s => Date.parse(s.startedAt)).filter(Number.isFinite), Date.now());
    const now = this.serverNow();
    const ends = steps.map(s => Date.parse(s.endedAt)).filter(Number.isFinite);
    const decidedAt = Date.parse(c.advisorDecision?.decidedAt);
    const last = c.status === 'DECIDED' ? Math.max(...ends, Number.isFinite(decidedAt) ? decidedAt : 0) : now;
    // The axis only grows (by 10 s), so bars do not shrink back while the case runs.
    const need = Math.max(60000, (last - t0) * (c.status === 'DECIDED' ? 1.04 : 1.1));
    this.span = c.status === 'DECIDED' ? Math.ceil(need / 5000) * 5000 : Math.max(this.caseId === c.caseId ? this.span : 0, Math.ceil(need / 10000) * 10000);
    this.caseId = c.caseId;
    const x = t => LABEL + Math.max(0, Math.min(1, (t - t0) / this.span)) * trackW;
    const readyOf = s => {
      const deps = (s.dependsOn || []).map(d => Date.parse(byId[d]?.endedAt)).filter(Number.isFinite);
      return deps.length ? Math.max(...deps) : t0;
    };

    // Rows, lane by lane.
    const rows = [];
    let y = AXIS;
    const laneBoxes = [];
    LANES.forEach(lane => {
      const list = steps.filter(s => laneOf(s) === lane.id);
      const extra = lane.id === 'advisor' ? [{ id: '__open', label: 'Ouverture du dossier' }] : lane.id === 'orchestrator' ? [{ id: '__phases', label: 'Phases du dossier' }] : [];
      const all = [...extra, ...list];
      laneBoxes.push({ lane, y, h: HEAD + all.length * ROW });
      y += HEAD;
      all.forEach(s => { rows.push({ s, lane: lane.id, y }); y += ROW; });
    });
    const height = y + 8;
    const rowY = Object.fromEntries(rows.map(r => [r.s.id, r.y + ROW / 2]));

    // Axis: ticks every 1, 2, 5, 10, 15, 30 or 60 s.
    const stepMs = [1, 2, 5, 10, 15, 20, 30, 60, 120].map(s => s * 1000).find(s => this.span / s <= trackW / 70) || 120000;
    let axis = '';
    const nowX = c.status === 'DECIDED' ? -1000 : x(now);
    for (let t = 0; t <= this.span; t += stepMs) {
      const xx = LABEL + (t / this.span) * trackW;
      axis += `<line class="g-tick" x1="${xx}" x2="${xx}" y1="${AXIS - 6}" y2="${height - 4}"/>${Math.abs(xx - nowX) < 34 ? '' : `<text class="g-tick-label" x="${xx}" y="${AXIS - 12}" text-anchor="middle">${t / 1000} s</text>`}`;
    }

    // Lane backgrounds and labels.
    let lanes = '';
    laneBoxes.forEach(({ lane, y: ly, h }, i) => {
      lanes += `<rect class="g-lane ${lane.id} ${i % 2 ? 'odd' : ''}" x="0" y="${ly}" width="${width}" height="${h}"/>
        <g class="g-lane-head ${lane.id}">${iconSvg(lane.icon, 8, ly + 4, 0.66)}<text x="28" y="${ly + 16}">${esc(lane.label)}</text></g>`;
    });

    // Bars.
    let bars = '';
    const label = (s, text) => `<text class="g-row-label ${s.kind === 'HUMAN' ? 'human' : ''}" x="${s.kind ? 30 : 14}" y="0">${esc(text)}</text>`;
    rows.forEach(({ s, y: ry }) => {
      const cy = ry + ROW / 2;
      if (s.id === '__open') {
        bars += `<g class="g-row" transform="translate(0 ${cy + 4})">${label({}, s.label)}</g>`;
        bars += diamond(x(t0), cy, 'done', 'Ouverture');
        return;
      }
      if (s.id === '__phases') {
        bars += `<g class="g-row" transform="translate(0 ${cy + 4})">${label({}, s.label)}</g>`;
        [1, 2, 3, 4, 5, 6].forEach(p => {
          const ps = steps.filter(z => z.phase === p && z.status !== 'SKIPPED');
          const starts = ps.map(z => Date.parse(z.startedAt)).filter(Number.isFinite);
          if (!starts.length) return;
          const open = ps.some(z => !z.endedAt && ['RUNNING', 'WAITING', 'QUEUED'].includes(z.status));
          const endT = open ? now : Math.max(...ps.map(z => Date.parse(z.endedAt)).filter(Number.isFinite), Math.min(...starts));
          const x1 = x(Math.min(...starts)), x2 = Math.max(x1 + 4, x(endT));
          bars += `<g class="g-phase ${open ? 'open' : ''} ${PHASES[p].human ? 'human' : ''}"><rect x="${x1}" y="${cy - 8}" width="${x2 - x1}" height="16" rx="3"/>
            ${x2 - x1 > 22 ? `<text x="${x1 + 5}" y="${cy + 4}">${p}${x2 - x1 > 90 ? ' · ' + esc(PHASES[p].short) : ''}</text>` : ''}</g>`;
        });
        return;
      }
      const iconName = s.kind === 'HUMAN' ? 'person' : s.kind === 'LLM' ? 'robot' : s.kind === 'RULE' ? 'rule' : s.kind === 'MCP' ? 'plug' : ['checkAccount', 'openItems'].includes(s.id) ? 'building' : 'bank';
      const blocked = blockedByAdvisor(c, s);
      const statusText = blocked ? 'attend votre validation' : (STATUS[s.status] || s.status).toLowerCase();
      bars += `<g class="g-row ${s.kind === 'LLM' ? 'llm' : ''} ${s.kind === 'HUMAN' ? 'human' : ''}" transform="translate(0 ${cy})">
        <g class="g-row-icon">${iconSvg(iconName, 10, -8, 0.66)}</g>
        <text class="g-row-label" x="30" y="-1">${esc(shortLabel(s.label, LABEL))}</text>
        <text class="g-row-status s-${s.status} ${blocked ? 'blocked' : ''}" x="30" y="10">${esc(statusText)}</text></g>`;
      const st = Date.parse(s.startedAt), en = Date.parse(s.endedAt);
      const ready = readyOf(s);
      const aria = `${s.label} : ${statusText}`;
      const open = (inner, extraCls = '', title = aria) => `<g class="g-bar ${extraCls}" data-step="${s.id}" tabindex="0" role="button" aria-label="${esc(title)}">${inner}</g>`;
      if (s.status === 'SKIPPED') {
        bars += open(`<text class="g-skip" x="${x(Math.max(ready, t0)) + 4}" y="${cy + 4}">non exécutée</text>`, 'skipped');
        return;
      }
      if (s.status === 'PENDING') {
        if (blocked) {
          const bx = x(now);
          bars += open(`<g class="g-lock" transform="translate(${bx + 4} ${cy - 9})">${iconSvg('person', 0, 0, 0.75)}</g><text class="g-blocked" x="${bx + 24}" y="${cy + 4}">attend votre validation</text>`, 'blocked');
        }
        return;
      }
      if (s.kind === 'HUMAN') {
        const x1 = x(Number.isFinite(st) ? st : ready), x2 = x(Number.isFinite(en) ? en : now);
        const waitMs = (Number.isFinite(en) ? en : now) - (Number.isFinite(st) ? st : ready);
        const what = s.id === 'dataReview' ? 'validé' : 'décidé';
        bars += open(`<rect class="g-hit" x="${x1 - 6}" y="${cy - 12}" width="${Math.max(24, x2 - x1 + 18)}" height="24"/><rect class="g-wait" x="${x1}" y="${cy - 7}" width="${Math.max(3, x2 - x1)}" height="14" rx="2"/>
          <text class="g-bar-text outside" ${x2 > width - 230 ? `x="${x1 - 8}" text-anchor="end"` : `x="${x2 + (Number.isFinite(en) ? 14 : 16)}"`} y="${cy + 4}">${Number.isFinite(en) ? `${what} après ${fmtSeconds(waitMs)}` : `en attente du conseiller · ${fmtSeconds(waitMs)}`}</text>
          ${diamond(x2, cy, Number.isFinite(en) ? 'done' : 'pending')}`, 'human', `${s.label} : ${Number.isFinite(en) ? what : 'en attente du conseiller'}, ${fmtSeconds(waitMs)}`);
        return;
      }
      let inner = '';
      const queueEnd = s.status === 'QUEUED' ? now : st;
      if (s.kind === 'LLM' && Number.isFinite(queueEnd) && queueEnd - ready > 400) {
        const q1 = x(ready), q2 = x(queueEnd);
        inner += `<rect class="g-queue" x="${q1}" y="${cy - 6}" width="${Math.max(2, q2 - q1)}" height="12" rx="2"/>`;
        if (s.status === 'QUEUED') inner += `<text class="g-bar-text outside" x="${q2 + 6}" y="${cy + 4}">en file · ${fmtSeconds(now - ready)}</text>`;
      }
      if (Number.isFinite(st)) {
        const endT = Number.isFinite(en) ? en : now;
        const x1 = x(st), x2 = Math.max(x1 + 3, x(endT));
        const dur = fmtSeconds(endT - st) + (s.status === 'RUNNING' ? '…' : '');
        const inside = x2 - x1 > 54;
        inner += `<rect class="g-hit" x="${x1 - 6}" y="${cy - 12}" width="${Math.max(24, x2 - x1 + 12)}" height="24"/><rect class="g-run s-${s.status} k-${s.kind}" x="${x1}" y="${cy - 9}" width="${x2 - x1}" height="18" rx="3"/>
          <text class="g-bar-text ${inside ? 'inside' : 'outside'}" x="${inside ? x1 + 6 : x2 + 6}" y="${cy + 4}">${dur}</text>`;
      }
      bars += open(inner, `s-${s.status}`, `${aria}${Number.isFinite(st) ? ', ' + fmtSeconds((Number.isFinite(en) ? en : now) - st) : ''}`);
    });

    // Dependency arrows: from the end of what a step needs to its start (or its queue, or now if blocked).
    let arrows = '';
    steps.forEach(s => {
      const sy = rowY[s.id];
      if (sy === undefined || s.status === 'SKIPPED') return;
      const blocked = blockedByAdvisor(c, s);
      const st = Date.parse(s.startedAt);
      const target = Number.isFinite(st) ? st : (s.status === 'QUEUED' || blocked) ? null : undefined;
      if (target === undefined) return;
      const ready = readyOf(s);
      (s.dependsOn || []).forEach(d => {
        const dep = byId[d];
        if (!dep || dep.status === 'SKIPPED' || rowY[d] === undefined) return;
        const depEnd = Date.parse(dep.endedAt);
        const fromT = Number.isFinite(depEnd) ? depEnd : (dep.status === 'WAITING' ? now : null);
        if (fromT === null) return;
        const key = KEY_EDGES.has(`${d}>${s.id}`);
        if (!this.showAll && !key) return;
        const x1 = x(fromT), y1 = rowY[d];
        const x2 = target === null ? x(Math.max(now, ready)) + (blocked ? 2 : 0) : x(s.kind === 'LLM' && Number.isFinite(st) && st - ready > 400 ? ready : st);
        const y2 = sy;
        const mx = Math.max(x1 + 10, Math.min(x2 - 6, x1 + 18));
        arrows += `<path class="g-dep ${key ? 'key' : ''} ${blocked && dep.kind === 'HUMAN' ? 'blocking' : ''}" data-from="${d}" data-to="${s.id}" d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${Math.max(x2 - 2, x1 + 4)} ${y2}" marker-end="url(#g-arrow${key ? '-key' : ''})"/>`;
      });
    });

    // Now.
    const nowLine = c.status === 'DECIDED' ? '' : `<line class="g-now" x1="${x(now)}" x2="${x(now)}" y1="${AXIS - 4}" y2="${height - 4}"/><text class="g-now-label" x="${x(now)}" y="${AXIS - 12}" text-anchor="middle">${fmtSeconds(now - t0)}</text>`;

    // Redrawn several times a second: patched in place, so the page, the focused bar and the hover stay put.
    morph(host, `<svg class="gantt" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-label="Parcours du dossier dans le temps">
      <defs>
        <marker id="g-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" class="g-arrow-head"/></marker>
        <marker id="g-arrow-key" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" class="g-arrow-head key"/></marker>
        <pattern id="g-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" class="g-hatch-bg"/><path d="M0 0V6" class="g-hatch-line"/></pattern>
        <pattern id="g-hatch-human" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" class="g-hatch-human-bg"/><path d="M0 0V6" class="g-hatch-human-line"/></pattern>
      </defs>
      ${lanes}${axis}<line class="g-label-sep" x1="${LABEL - 6}" x2="${LABEL - 6}" y1="${AXIS}" y2="${height}"/>${arrows}${bars}${nowLine}
    </svg>`);
    if (focused && document.activeElement?.closest?.('[data-step]')?.dataset.step !== focused) host.querySelector(`[data-step="${focused}"]`)?.focus({ preventScroll: true });
  }
}

function diamond(cx, cy, state, text) {
  return `<g class="g-ms ${state}"><path d="M${cx} ${cy - 8} L${cx + 8} ${cy} L${cx} ${cy + 8} L${cx - 8} ${cy}Z"/>${text ? `<text x="${cx + 12}" y="${cy + 4}">${text}</text>` : ''}</g>`;
}

function shortLabel(s, labelW) {
  const max = labelW < 200 ? 15 : 24;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

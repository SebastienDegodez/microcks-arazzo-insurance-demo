// "Who calls whom": nodes around a Microcks frame, packets travelling between them, a numbered caption.
// Adapted from the FlowDiagram of the Arazzo cockpit demo for a narrow side panel and for live use:
// nodes come positioned by the caller, hops are fired as the case changes (several at once), a node pulses while
// it works (busy counter), and a badge on a node tells what waits there (e.g. the LLM queue).
import { ICON_PATHS } from './icons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
export const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const short = (s, n = 34) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const bezier = (p0, c, p2, t) => [0, 1].map(k => (1 - t) * (1 - t) * p0[k] + 2 * (1 - t) * t * c[k] + t * t * p2[k]);
function svgEl(tag, attrs, parent) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
const REQUEST_TONES = new Set(['req', 'mcp', 'llm', 'ghost', 'post']);

export class FlowDiagram {
  constructor(host, opts = {}) {
    this.opts = { title: 'Schéma animé : qui appelle qui', ...opts };
    this.speed = 1;
    this.gen = 0;
    this.captionCount = 0;
    this.wrap = document.createElement('div');
    this.wrap.className = 'fd';
    this.scroller = document.createElement('div');
    this.scroller.className = 'fd-scroll';
    this.wrap.appendChild(this.scroller);

    this.caption = document.createElement('div');
    this.caption.className = 'fd-caption';
    this.caption.setAttribute('aria-live', 'polite');
    this.wrap.appendChild(this.caption);

    const bar = document.createElement('div');
    bar.className = 'fd-bar';
    bar.innerHTML = `<button type="button" class="btn btn-sm" data-a="replay" disabled>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>Rejouer</button>
      <div class="fd-speed" role="radiogroup" aria-label="Vitesse de l'animation">
        ${[0.5, 1, 2].map(v => `<button type="button" role="radio" aria-checked="${v === 1}" tabindex="${v === 1 ? 0 : -1}" data-speed="${v}">×${String(v).replace('.', ',')}</button>`).join('')}
      </div>
      <ul class="fd-legend" aria-label="Légende des couleurs">
        <li><i class="req"></i>requête</li><li><i class="ok"></i>OK</li><li><i class="ko"></i>erreur</li>
        <li><i class="mcp"></i>MCP</li><li><i class="llm"></i>LLM</li><li><i class="post"></i>conseiller</li>
      </ul>`;
    this.replayBtn = bar.querySelector('[data-a=replay]');
    this.replayBtn.onclick = () => this.onReplay && this.onReplay();
    const speeds = [...bar.querySelectorAll('[data-speed]')];
    speeds.forEach(b => {
      b.onclick = () => {
        this.speed = Number(b.dataset.speed);
        speeds.forEach(x => { x.setAttribute('aria-checked', String(x === b)); x.tabIndex = x === b ? 0 : -1; });
      };
      b.onkeydown = e => {
        if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
        e.preventDefault();
        const next = speeds[(speeds.indexOf(b) + (e.key === 'ArrowRight' ? 1 : speeds.length - 1)) % speeds.length];
        next.focus(); next.click();
      };
    });
    this.wrap.appendChild(bar);

    this.logBox = document.createElement('details');
    this.logBox.className = 'fd-log';
    this.logBox.innerHTML = '<summary>Déroulé numéroté</summary><ol></ol>';
    this.log = this.logBox.querySelector('ol');
    this.wrap.appendChild(this.logBox);
    host.appendChild(this.wrap);
  }

  /* ---------- Layout: nodes come with x, y, w (h optional); frame = the Microcks rectangle ---------- */
  layout({ nodes, links = [], frame, width, height }) {
    this.gen++;
    this.nodes = {};
    this.edges = {};
    this.scroller.innerHTML = '';
    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'fd-svg', role: 'img', 'aria-label': this.opts.title }, this.scroller);
    this.svg = svg;
    if (frame) {
      const g = svgEl('g', { class: 'fd-frame' }, svg);
      svgEl('rect', { x: frame.x, y: frame.y, width: frame.w, height: frame.h, rx: 10 }, g);
      svgEl('text', { x: frame.x + 14, y: frame.y + 24, class: 'fd-frame-label' }, g).textContent = frame.label || 'Microcks';
      svgEl('text', { x: frame.x + 14 + (frame.label || 'Microcks').length * 9.4 + 8, y: frame.y + 24, class: 'fd-frame-sub' }, g).textContent = frame.sub || '';
    }
    this.edgesG = svgEl('g', {}, svg);
    this.nodesG = svgEl('g', {}, svg);
    this.packG = svgEl('g', {}, svg);
    nodes.forEach(n => {
      const h = n.h || 42, w = n.w || 170;
      const node = { ...n, h, w, busyCount: 0 };
      node.g = svgEl('g', { class: `fd-node ${n.kind}${n.idle ? ' idle' : ''}`, 'data-node': n.id }, this.nodesG);
      svgEl('title', {}, node.g).textContent = [n.label, n.sub].filter(Boolean).join(' · ');
      svgEl('rect', { x: n.x - w / 2, y: n.y - h / 2, width: w, height: h, rx: n.kind === 'ui' || n.kind === 'orch' || n.kind === 'off' ? 4 : 7 }, node.g);
      const hasIcon = n.icon && ICON_PATHS[n.icon];
      if (hasIcon) {
        const ig = svgEl('g', { class: 'fd-icon', transform: `translate(${n.x - w / 2 + 7} ${n.y - 9}) scale(0.75)`, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, node.g);
        ig.innerHTML = ICON_PATHS[n.icon];
      }
      const tx = hasIcon ? n.x + 9 : n.x;
      const max = Math.max(10, Math.floor((w - (hasIcon ? 28 : 10)) / 7));
      svgEl('text', { x: tx, y: n.sub ? n.y - 2 : n.y + 5, 'text-anchor': 'middle', class: 'fd-label' }, node.g).textContent = short(n.label, max);
      if (n.sub) svgEl('text', { x: tx, y: n.y + 13, 'text-anchor': 'middle', class: 'fd-sub' }, node.g).textContent = short(n.sub, max + 4);
      node.badgeG = svgEl('g', { class: 'fd-badge', transform: `translate(${n.x + w / 2} ${n.y - h / 2 - 9})` }, node.g);
      this.nodes[n.id] = node;
    });
    links.forEach(([a, b, opts]) => this.edge(a, b, opts));
  }

  // From a to b: a segment between the node borders, bent just enough not to cross another node.
  geometry(a, b) {
    const A = this.nodes[a], B = this.nodes[b];
    const len = Math.hypot(B.x - A.x, B.y - A.y) || 1, dx = (B.x - A.x) / len, dy = (B.y - A.y) / len;
    const p0 = this.border(A, dx, dy), p2 = this.border(B, -dx, -dy);
    const mid = [(p0[0] + p2[0]) / 2, (p0[1] + p2[1]) / 2], nx = -dy, ny = dx;
    for (const off of [0, -40, 40, -80, 80, -130, 130]) {
      const c = [mid[0] + nx * off * 2, mid[1] + ny * off * 2];
      if (!this.crosses(p0, c, p2, a, b)) return { p0, c, p2, curved: off !== 0 };
    }
    return { p0, c: mid, p2, curved: false };
  }

  crosses(p0, c, p2, a, b) {
    const others = Object.values(this.nodes).filter(n => n.id !== a && n.id !== b);
    for (let i = 1; i < 24; i++) {
      const [x, y] = bezier(p0, c, p2, i / 24);
      if (others.some(n => Math.abs(x - n.x) < n.w / 2 + 4 && Math.abs(y - n.y) < n.h / 2 + 4)) return true;
    }
    return false;
  }

  // opts: { cls, label, note: [lines] } for a link drawn at rest (e.g. the model's tool).
  edge(a, b, opts = {}) {
    const key = [a, b].sort().join('|');
    if (this.edges[key]) return this.edges[key];
    if (!this.nodes[a] || !this.nodes[b]) return null;
    const [first, second] = [a, b].sort();
    const { p0, c, p2 } = this.geometry(first, second);
    const line = svgEl('path', { d: `M${p0} Q${c} ${p2}`, class: `fd-edge ${opts.cls || ''}`, fill: 'none' }, this.edgesG);
    if (opts.label) {
      const [mx, my] = bezier(p0, c, p2, 0.5);
      const t = svgEl('text', { x: mx + 8, y: my - 4, class: 'fd-edge-label' }, this.edgesG);
      t.textContent = opts.label;
      (opts.note || []).forEach((n, i) => { svgEl('text', { x: mx + 8, y: my + 9 + i * 11, class: 'fd-edge-note' }, this.edgesG).textContent = n; });
    }
    return (this.edges[key] = { line, hot: 0 });
  }

  border(n, dx, dy) {
    const tx = dx ? n.w / 2 / Math.abs(dx) : Infinity, ty = dy ? n.h / 2 / Math.abs(dy) : Infinity;
    const t = Math.min(tx, ty);
    return [n.x + dx * t, n.y + dy * t];
  }

  /* ---------- Narration ---------- */
  sleep(ms) { return new Promise(r => setTimeout(r, REDUCED ? 0 : ms / this.speed)); }

  say(text, tone, numbered = true) {
    const n = numbered ? ++this.captionCount : null;
    this.caption.className = 'fd-caption ' + (tone || '');
    this.caption.innerHTML = `<span class="fd-n">${n || ''}</span><span class="fd-t">${text}</span>`;
    if (n) {
      const li = document.createElement('li');
      li.className = tone || '';
      li.innerHTML = text;
      this.log.appendChild(li);
    }
  }

  idle(text) {
    this.caption.className = 'fd-caption';
    this.caption.innerHTML = `<span class="fd-n"></span><span class="fd-t">${text}</span>`;
  }

  clearLog() { this.log.innerHTML = ''; this.captionCount = 0; }

  flash(id, tone) {
    const n = this.nodes[id];
    if (!n) return;
    const cls = 'flash-' + tone.split(' ')[0];
    n.g.classList.add(cls);
    setTimeout(() => n.g.classList.remove(cls), 650 / this.speed);
  }

  // A node pulses while at least one step works there; "waiting" pulses in the advisor's colour.
  busy(id, delta, cls = 'busy') {
    const n = this.nodes[id];
    if (!n) return;
    n[cls + 'Count'] = Math.max(0, (n[cls + 'Count'] || 0) + delta);
    n.g.classList.toggle(cls, n[cls + 'Count'] > 0);
  }

  clearBusy() {
    Object.values(this.nodes || {}).forEach(n => { n.busyCount = 0; n.waitingCount = 0; n.g.classList.remove('busy', 'waiting'); });
  }

  badge(id, text, tone = '') {
    const n = this.nodes[id];
    if (!n) return;
    n.badgeG.innerHTML = '';
    if (!text) return;
    const w = Math.min(n.w + 20, text.length * 6.4 + 14);
    svgEl('rect', { x: -w + 8, y: -9, width: w, height: 18, rx: 9, class: 'fd-badge-bg ' + tone }, n.badgeG);
    svgEl('text', { x: -w / 2 + 8, y: 4, 'text-anchor': 'middle' }, n.badgeG).textContent = text;
  }

  hop(ev) {
    if (!this.nodes) return Promise.resolve();
    const A = this.nodes[ev.from], B = this.nodes[ev.to], e = this.edge(ev.from, ev.to);
    if (!A || !B || !e) return Promise.resolve();
    if (REDUCED) { this.flash(ev.to, ev.tone); return Promise.resolve(); }
    const gen = this.gen;
    return new Promise(done => {
      // Requests and responses travel on two lanes, a few pixels apart.
      const [first, second] = [ev.from, ev.to].sort();
      const { p0, c, p2, curved } = this.geometry(first, second);
      const flipped = first !== ev.from;
      const len = Math.hypot(p2[0] - p0[0], p2[1] - p0[1]) || 1;
      const lane = (REQUEST_TONES.has(ev.tone.split(' ')[0]) ? -6 : 6) * (flipped ? -1 : 1);
      const [ox, oy] = curved ? [0, 0] : [-(p2[1] - p0[1]) / len * lane, (p2[0] - p0[0]) / len * lane];
      const cc = curved ? [c[0], c[1] + lane] : c;
      const g = svgEl('g', { class: `fd-packet ${ev.tone}` }, this.packG);
      svgEl('circle', { r: 6.5 }, g);
      // Several packets on one edge: only the first one is labelled, the others would overlap it.
      if (ev.label && !e.hot) svgEl('text', { y: -11, 'text-anchor': 'middle' }, g).textContent = short(ev.label, 30);
      e.hot++;
      e.line.classList.add('hot');
      const dur = (ev.dur || 900) / this.speed, t0 = performance.now();
      const end = () => { g.remove(); if (--e.hot <= 0) { e.hot = 0; e.line.classList.remove('hot'); } };
      const frame = now => {
        if (this.gen !== gen) { end(); return done(); }
        const p = Math.min(1, (now - t0) / dur), q = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        const [x, y] = bezier(p0, cc, p2, flipped ? 1 - q : q);
        g.setAttribute('transform', `translate(${x + ox},${y + oy})`);
        if (p < 1) return requestAnimationFrame(frame);
        end();
        this.flash(ev.to, ev.tone);
        done();
      };
      requestAnimationFrame(frame);
    });
  }
}

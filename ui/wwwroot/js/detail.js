// The detail of a step, in a modal dialog: summary, status and timing, what it needs, its data, its calls.
import { STATUS, blockedByAdvisor, durationOf, esc, frTime, sourceOf } from './domain.js';
import { icon, stepIcon } from './icons.js';
import { callLi, statusChip } from './views.js';

function value(v, depth = 0) {
  if (v === null || v === undefined) return '<span class="muted">—</span>';
  if (Array.isArray(v)) {
    if (!v.length) return '<span class="muted">aucun</span>';
    if (v.every(x => typeof x !== 'object')) return esc(v.join(', '));
    return `<ol class="kv-list">${v.map(x => `<li>${value(x, depth + 1)}</li>`).join('')}</ol>`;
  }
  if (typeof v === 'object') {
    if (depth > 2) return `<code>${esc(JSON.stringify(v))}</code>`;
    return `<dl class="kv nested">${Object.entries(v).map(([k, x]) => `<dt>${esc(k)}</dt><dd>${value(x, depth + 1)}</dd>`).join('')}</dl>`;
  }
  if (typeof v === 'boolean') return v ? 'oui' : 'non';
  return esc(v);
}

export function openStepDialog(dialog, c, id, now) {
  const raw = c?.steps?.[id];
  if (!raw) return;
  const s = { id, ...raw, calls: raw.calls || [] };
  const src = sourceOf(s);
  const blocked = blockedByAdvisor(c, s);
  const deps = (s.dependsOn || []).map(d => `<li>${c.steps[d] ? stepIcon({ id: d, ...c.steps[d] }) : ''}${esc(c.steps[d]?.label || d)} — ${esc((STATUS[c.steps[d]?.status] || c.steps[d]?.status || '').toLowerCase())}</li>`).join('');
  const elapsed = s.startedAt && !s.endedAt ? ` · depuis ${Math.round((now - Date.parse(s.startedAt)) / 1000)} s` : '';
  dialog.innerHTML = `<form method="dialog" class="dlg">
    <header class="dlg-head">${stepIcon(s, 'ico dlg-ico')}<div><h2 id="dlgTitle">${esc(s.label)}</h2>
      <p class="muted"><span class="source-tag" data-src="${src.src}">${esc(src.text)}</span> · phase ${esc(s.phase)} · ${s.mode === 'PARALLEL' ? 'en parallèle' : 'à la chaîne'}</p></div>
      <button class="icon-close" value="close" aria-label="Fermer">${icon('close', 'ico')}</button></header>
    <div class="dlg-body">
      <p>${statusChip(c, s, now)}${durationOf(s) ? ` · durée ${durationOf(s)}` : elapsed}${s.startedAt ? ` · départ ${esc(frTime(s.startedAt))}` : ''}${s.endedAt ? ` · fin ${esc(frTime(s.endedAt))}` : ''}</p>
      ${s.kind === 'LLM' ? `<p class="consult-note">${icon('robot', 'ico ico-llm')}Analyse produite par un LLM : un éclairage consultatif, pas une décision.</p>` : ''}
      ${blocked ? `<p class="flag human">${icon('person', 'ico')}Cette étape attend votre validation des données.</p>` : ''}
      <h3>Résumé</h3><p>${esc(s.summary || '—')}</p>
      ${deps ? `<h3>Dépend de</h3><ul class="dep-list">${deps}</ul>` : ''}
      <h3>Données</h3>${s.result ? value(s.result) : '<p class="muted">Pas encore de données.</p>'}
      <h3>Appels sortants (${s.calls.length})</h3>${s.calls.length ? `<ul class="call-list">${s.calls.map(callLi).join('')}</ul>` : '<p class="muted">Aucun appel enregistré pour l\'instant.</p>'}
    </div></form>`;
  dialog.setAttribute('aria-labelledby', 'dlgTitle');
  if (!dialog.open) dialog.showModal();
}

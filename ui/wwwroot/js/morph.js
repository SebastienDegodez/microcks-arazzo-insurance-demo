// Patches the DOM in place towards new HTML instead of replacing it, so a poll never moves the page:
// the nodes stay (scroll anchoring, focus, selection), fields keep what the user typed, <details> stay open.
const KEYS = ['id', 'data-step', 'data-node', 'data-keep', 'data-open-step', 'data-filter'];
const USER_STATE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export function morph(target, html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  patchChildren(target, tpl.content);
}

function sameNode(a, b) {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return false;
  if (a.nodeType !== 1) return true;
  return KEYS.every(k => (a.getAttribute(k) || '') === (b.getAttribute(k) || ''));
}

function patchAttrs(a, b) {
  for (const { name, value } of [...b.attributes]) {
    if (USER_STATE.has(a.nodeName) && (name === 'value' || name === 'checked')) continue;
    if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  }
  for (const { name } of [...a.attributes]) {
    if (b.hasAttribute(name)) continue;
    if (name === 'open' && a.nodeName === 'DETAILS') continue; // opened by the user
    a.removeAttribute(name);
  }
}

function patchChildren(from, to) {
  const before = [...from.childNodes];
  const after = [...to.childNodes];
  after.forEach((nb, i) => {
    const na = before[i];
    if (!na) { from.appendChild(nb); return; }
    if (!sameNode(na, nb)) { from.replaceChild(nb, na); return; }
    if (na.nodeType !== 1) { if (na.data !== nb.data) na.data = nb.data; return; }
    patchAttrs(na, nb);
    if (USER_STATE.has(na.nodeName)) return; // what the user typed or ticked stays
    patchChildren(na, nb);
  });
  for (let i = before.length - 1; i >= after.length; i--) from.removeChild(before[i]);
}

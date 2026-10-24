// Inline SVG icons (stroke = currentColor). robot: LLM steps everywhere; person: the advisor's steps.
const P = {
  robot: '<rect x="5" y="8" width="14" height="11" rx="2.5"/><path d="M12 4.5V8M9.5 12.5v1M14.5 12.5v1M9.5 16.5h5M3 12v3M21 12v3"/><circle cx="12" cy="3.6" r="1.1"/>',
  person: '<circle cx="12" cy="7.5" r="3.6"/><path d="M4.5 20.5c.8-4 3.8-6.2 7.5-6.2s6.7 2.2 7.5 6.2"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M5.5 18.5l1.8-1.8M16.7 7.3l1.8-1.8"/>',
  bank: '<path d="M3 9.5 12 4l9 5.5M4.5 10v8M9 10v8M15 10v8M19.5 10v8M3 20h18"/>',
  building: '<rect x="5" y="3.5" width="14" height="17" rx="1"/><path d="M9 7.5h2M13 7.5h2M9 11h2M13 11h2M9 14.5h2M13 14.5h2M10.5 20.5v-3h3v3"/>',
  plug: '<path d="M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 0 1-11 0zM12 16.5V21"/>',
  rule: '<path d="M5 4h14v16H5zM8.5 9h7M8.5 12.5h7M8.5 16h4"/>',
  map: '<path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4zM9 4v14M15 6v14"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8 7.5 9.5 4.3-1.5 7.5-4.9 7.5-9.5V6z"/>',
  euro: '<path d="M17.5 6.5A6.5 6.5 0 1 0 17.5 17.5M4 10.5h9M4 13.5h9"/>',
  file: '<path d="M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  timeline: '<path d="M3 6h7M6 12h10M10 18h11"/>',
  board: '<rect x="3.5" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="10" rx="1"/><rect x="16.5" y="4" width="4" height="13" rx="1"/>',
  overview: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17M3.5 12h17"/>',
  warn: '<path d="M12 4 2.8 19.5h18.4zM12 10v4.5M12 17.2v.1"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  cross: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.2 2"/>',
  queue: '<path d="M4 7h10M4 12h10M4 17h10M17 9.5l3 2.5-3 2.5"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  panel: '<rect x="3.5" y="4" width="17" height="16" rx="1.5"/><path d="M14 4v16"/>',
  pin: '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
};

export function icon(name, cls = 'ico', label) {
  const a11y = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
  return `<svg class="${cls}" viewBox="0 0 24 24" ${a11y} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;
}

// The icon of a step: who does the work.
export function stepIcon(step, cls = 'ico') {
  const kind = step.kind;
  if (kind === 'HUMAN') return icon('person', cls + ' ico-human');
  if (kind === 'LLM') return icon('robot', cls + ' ico-llm');
  if (kind === 'RULE') return icon('rule', cls + ' ico-rule');
  if (kind === 'MCP') return icon('plug', cls + ' ico-mcp');
  return icon(['checkAccount', 'openItems'].includes(step.id) ? 'building' : 'bank', cls + ' ico-service');
}

export const ICON_PATHS = P;

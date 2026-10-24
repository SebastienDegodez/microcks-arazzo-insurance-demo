// Illustrative location maps, drawn as SVG by the screen: no tiles, no external service, no real geometry.
// A silhouette of the place (coast for La Rochelle, the Rhône for Avignon, a city for Lille and Clermont),
// a pin for the company, and the natural risks (climateRisk.result.naturalRisks) drawn over it, with a legend.
import { LEVELS, esc } from './domain.js';

let seq = 0;
const OPACITY = { LOW: 0.28, MEDIUM: 0.45, HIGH: 0.65, VERY_HIGH: 0.8 };

const PLACES = {
  coast: {
    match: c => /rochelle/i.test(c.city) || c.insee === '17300',
    pin: [196, 120],
    base: () => `
      <path class="m-water" d="M0 0H118C104 22 112 40 96 58C84 74 100 92 86 108C76 122 92 140 80 160C70 178 84 196 74 220H0Z"/>
      <path class="m-water" d="M118 0H150C146 12 132 18 126 12Z"/>
      <path class="m-land" d="M18 34C34 26 62 28 74 36C66 44 40 46 22 44Z"/>
      <path class="m-water" d="M96 112C122 110 150 116 176 118C150 124 120 124 92 122Z"/>
      <path class="m-road" d="M176 118C210 110 240 92 320 86M176 118C200 150 230 170 260 220M150 20C170 60 176 90 176 118"/>
      <text class="m-place" x="16" y="196">Océan</text><text class="m-place" x="22" y="58">Île</text>`,
    zones: {
      submersionMarine: '<path d="M60 0H136C122 22 130 40 114 58C102 74 118 92 104 108C94 122 110 140 98 160C88 178 102 196 92 220H54C64 196 50 178 60 160C72 140 56 122 66 108C80 92 64 74 76 58C92 40 84 22 98 0Z"/><path d="M96 104C130 102 160 108 192 112L194 128C160 132 126 132 92 130Z"/>',
      inondation: '<ellipse cx="170" cy="122" rx="42" ry="18"/>',
      retraitGonflementArgiles: '<path d="M228 140C262 128 300 138 312 160C300 190 256 196 232 182C218 170 216 150 228 140Z"/>',
      feuxForet: '<path d="M250 20C280 12 312 22 316 44C300 62 268 60 252 46Z"/>',
    },
  },
  river: {
    match: c => /avignon/i.test(c.city) || c.insee === '84007',
    pin: [176, 112],
    base: () => `
      <path class="m-river" d="M118 0C108 30 132 52 120 80C108 108 136 128 124 156C114 182 132 200 126 220"/>
      <path class="m-river thin" d="M150 0C146 24 162 40 150 62C142 78 124 76 120 80"/>
      <path class="m-city" d="M150 92h52v40h-52z" rx="6"/>
      <path class="m-road" d="M0 112H320M176 0V220M200 132L300 210"/>
      <text class="m-place" x="70" y="40">Rhône</text>`,
    zones: {
      inondation: '<path d="M88 0H160C150 30 172 52 160 80C148 108 176 128 164 156C154 182 172 200 166 220H86C92 200 74 182 84 156C96 128 68 108 80 80C92 52 78 30 88 0Z"/>',
      retraitGonflementArgiles: '<path d="M150 70C196 58 250 70 262 104C268 140 230 160 188 156C150 152 132 120 140 94Z"/>',
      feuxForet: '<path d="M236 160C268 150 304 164 312 190C306 212 266 218 244 206C228 194 224 172 236 160Z"/>',
      submersionMarine: '',
    },
  },
  city: {
    match: () => true,
    pin: [168, 106],
    base: c => `
      <circle class="m-ring" cx="160" cy="110" r="72"/>
      <path class="m-city" d="M118 74h30v24h-30zM154 70h40v30h-40zM122 104h26v34h-26zM154 106h22v20h-22zM182 106h30v38h-30zM140 144h40v18h-40z"/>
      <path class="m-road" d="M0 110H320M160 0V220M40 20L280 200M40 200L280 20"/>
      ${/clermont/i.test(c.city) || c.insee === '63113'
        ? '<path class="m-hill" d="M8 170C28 120 52 120 70 170ZM40 120C58 80 78 80 92 120Z"/><text class="m-place" x="10" y="190">Puys</text>'
        : '<path class="m-river thin" d="M0 60C60 70 90 52 140 64C200 78 250 60 320 70"/><text class="m-place" x="10" y="52">Canal</text>'}`,
    zones: {
      inondation: '<path d="M0 46C60 56 90 38 140 50C200 64 250 46 320 56V86C250 76 200 94 140 80C90 68 60 86 0 76Z"/>',
      retraitGonflementArgiles: '<path d="M200 130C236 122 270 136 276 160C272 186 236 192 210 180C192 170 188 142 200 130Z"/>',
      feuxForet: '<path d="M10 150C40 140 70 150 76 176C70 198 36 204 16 190C4 178 2 160 10 150Z"/>',
      submersionMarine: '',
    },
  },
};

const ZONES = [
  ['submersionMarine', 'Submersion marine', 'z-sub'],
  ['inondation', 'Inondation', 'z-flood'],
  ['retraitGonflementArgiles', 'Argiles (retrait-gonflement)', 'z-clay'],
  ['feuxForet', 'Feux de forêt', 'z-fire'],
];

// identity: companyIdentity.result; risks: { commune, risquesNaturels } (null until the climate agent fetched them).
export function renderMap({ identity, risks, name, compact = false }) {
  const addr = identity?.address || {};
  const c = { city: addr.city || '', insee: addr.inseeCityCode || '' };
  const place = Object.values(PLACES).find(p => p.match(c));
  const id = `m${++seq}`;
  const rn = risks?.risquesNaturels || {};
  const zones = ZONES.map(([key, label, cls]) => {
    const r = rn[key];
    const level = r && r.present !== false ? r.level : 'NONE';
    const shape = place.zones[key];
    const draw = shape && level && level !== 'NONE';
    return { key, label, cls, level: level || 'NONE', svg: draw ? `<g class="zone ${cls}" fill="url(#${id}-${cls})" style="opacity:${OPACITY[level] || 0.4}">${shape}</g>` : '' };
  });
  const [px, py] = place.pin;
  const svg = `<svg class="map-svg" viewBox="0 0 320 220" role="img" aria-label="Carte illustrative de ${esc(c.city || 'la commune')} : ${zones.filter(z => z.level !== 'NONE').map(z => `${z.label} ${LEVELS[z.level] || z.level}`).join(', ') || 'aucune zone de risque connue'}">
    <defs>
      <pattern id="${id}-z-sub" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" class="pz-sub"/><path d="M0 0V8" class="pz-line"/></pattern>
      <pattern id="${id}-z-flood" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="7" height="7" class="pz-flood"/><path d="M0 0V7" class="pz-line"/></pattern>
      <pattern id="${id}-z-clay" width="9" height="9" patternUnits="userSpaceOnUse"><rect width="9" height="9" class="pz-clay"/><circle cx="4.5" cy="4.5" r="1.6" class="pz-dot"/></pattern>
      <pattern id="${id}-z-fire" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(30)"><rect width="8" height="8" class="pz-fire"/><path d="M0 0V8" class="pz-line"/></pattern>
    </defs>
    <rect class="m-bg" width="320" height="220"/>
    ${place.base(c)}
    ${zones.map(z => z.svg).join('')}
    <g class="m-pin" transform="translate(${px} ${py})"><path d="M0 0C-9-13-12-18-12-24a12 12 0 0 1 24 0c0 6-3 11-12 24z"/><circle cx="0" cy="-24" r="4.5"/></g>
    ${compact ? '' : `<text class="m-pin-label" x="${Math.min(250, Math.max(70, px))}" y="${py + 15}" text-anchor="middle">${esc((name || 'Entreprise').length > 30 ? name.slice(0, 29) + '…' : name || 'Entreprise')}</text>`}
    <g class="m-north" transform="translate(298 22)"><path d="M0-12 5 4 0 1-5 4z"/><text y="16" text-anchor="middle">N</text></g>
    <text class="m-tag" x="8" y="14">Carte illustrative</text>
  </svg>`;
  const legend = `<ul class="map-legend">${zones.map(z => `<li class="${z.level === 'NONE' ? 'off' : ''}"><i class="sw ${z.cls}"></i>${esc(z.label)} : <strong>${esc(LEVELS[z.level] || z.level)}</strong></li>`).join('')}
    ${rn.seisme?.zone ? `<li><i class="sw z-seism"></i>Sismicité : <strong>zone ${esc(rn.seisme.zone)}</strong></li>` : ''}
    <li><i class="sw z-pin"></i>${esc(name || 'Entreprise')}</li></ul>`;
  const note = risks ? '' : '<p class="map-note">Zones de risque : en attente de l\'agent climat (outil MCP → Géorisques).</p>';
  return `<figure class="map ${compact ? 'compact' : ''}">${svg}<figcaption>${compact ? '' : legend}${note}<span class="map-disclaimer">Silhouette schématique de ${esc(c.city || 'la commune')}, sans données cartographiques réelles.</span></figcaption></figure>`;
}

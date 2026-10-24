// Generates ui/fake/cases.json: the final state of each demo case, consistent with SCENARIO.md.
const fs = require('fs');
const M = 'http://localhost:8080';
const rest = (svc, path, status = 200) => ({ method: 'GET', url: `${M}/rest/${svc}/1.0.0${path}`, status, via: 'REST' });
// v3: the MCP is reShapr; Microcks only simulates the Géorisques API behind it.
const RESHAPR = 'http://localhost:7778/mcp/reshapr/georisques-1-0-0-default';
// climateRisk's tool loop, in order: MCP tools/list, LLM (tool_calls), MCP tools/call, LLM (answer).
const climateCalls = () => [
  { method: 'POST', url: RESHAPR, status: 200, via: 'MCP' },
  { method: 'POST', url: `${M}/rest/LLM+gateway/1.0.0/v1/chat/completions`, status: 200, via: 'LLM' },
  { method: 'POST', url: RESHAPR, status: 200, via: 'MCP' },
  { method: 'POST', url: `${M}/rest/LLM+gateway/1.0.0/v1/chat/completions`, status: 200, via: 'LLM' },
];
const mcp = (base = RESHAPR) => [
  { method: 'POST', url: base, status: 200, via: 'MCP' },
  { method: 'POST', url: base, status: 200, via: 'MCP' },
];
const llm = () => [{ method: 'POST', url: `${M}/rest/LLM+gateway/1.0.0/v1/chat/completions`, status: 200, via: 'LLM' }];

const company = (siren, cid, name, naf, nafLabel, headRange, created, street, pc, city, insee, lat, lon) => ({
  siren, cid, name,
  identity: { siren, denomination: name, nafCode: naf, nafLabel, headcountRange: headRange, creationDate: created, active: true,
    address: { street, postalCode: pc, city, inseeCityCode: insee, lat, lon } },
});

function eligible(c, o) {
  const s = c.siren;
  return {
    companyName: c.name, flow: 'normal', reasons: o.reasons,
    steps: {
      checkAccount: { summary: o.account.summary, result: { customerId: c.cid, siren: s, name: c.name, ...o.account.result }, calls: [rest('Customer+accounts', `/customers/by-siren/${s}`)] },
      companyIdentity: { summary: o.identitySummary, result: c.identity, calls: [rest('Sirene', `/siren/${s}`)] },
      legalEvents: { summary: o.legal.summary, result: o.legal.result, calls: [rest('BODACC', `/annonces?siren=${s}`)] },
      financials: { summary: o.fin.summary, result: { siren: s, ...o.fin.result }, calls: [rest('Company+financials', `/companies/${s}/financials`)] },
      openItems: { summary: o.items.summary, result: { customerId: c.cid, ...o.items.result }, calls: [rest('Claims+and+contracts', `/customers/${c.cid}/open-items`)] },
      dataQuality: { summary: o.dq.summary, result: o.dq.result, calls: llm() },
      climateRisk: { summary: o.climate.summary, result: { ...o.climate.result, naturalRisks: o.geo.result }, calls: climateCalls() },
      financialHealth: { summary: o.health.summary, result: o.health.result, calls: llm() },
      openItemsReview: { summary: o.review.summary, result: o.review.result, calls: llm() },
      synthesis: { summary: o.verdict.summary, result: o.reco, calls: llm() },
    },
    recommendation: { ...o.reco, source: 'LLM' },
  };
}
const risks = (commune, inond, sub, arg, zone, feux) => ({ commune, risquesNaturels: {
  inondation: { present: inond !== 'NONE', level: inond }, submersionMarine: { present: sub !== 'NONE', level: sub },
  retraitGonflementArgiles: { present: arg !== 'NONE', level: arg }, seisme: { zone }, feuxForet: { present: feux !== 'NONE', level: feux } } });

const c1 = company('100000001', 'C-1001', 'Boulangerie Les Délices du Port', '10.71C', 'Boulangerie et boulangerie-pâtisserie', '6-9', '2012-05-14', '12 quai Duperré', '17300', 'La Rochelle', '17300', 46.1591, -1.152);
const c2 = company('100000002', 'C-1002', 'Atelier Mécanique Durand', '25.62B', 'Mécanique industrielle', '10-19', '2004-09-01', '8 rue de l\'Industrie', '63000', 'Clermont-Ferrand', '63113', 45.7772, 3.087);
const c3 = company('100000003', 'C-1003', 'Transports Express Nord', '49.41A', 'Transports routiers de fret interurbains', '20-49', '2009-02-10', '45 avenue de la République', '59000', 'Lille', '59350', 50.6292, 3.0573);
const c4 = company('100000004', 'C-1004', 'Restaurant Le Vieux Moulin', '56.10A', 'Restauration traditionnelle', '6-9', '2015-06-20', '3 rue du Moulin', '84000', 'Avignon', '84007', 43.9493, 4.8055);

const R = {
  UNKNOWN_CUSTOMER: { code: 'UNKNOWN_CUSTOMER', label: 'Compte client introuvable pour ce SIREN', stepId: 'checkAccount' },
  COLLECTIVE_PROCEDURE: { code: 'COLLECTIVE_PROCEDURE', label: 'Procédure collective en cours (BODACC)', stepId: 'legalEvents' },
  CLIMATE_HIGH: { code: 'CLIMATE_HIGH', label: 'Exposition climatique élevée', stepId: 'climateRisk' },
  FINANCIAL_FRAGILE: { code: 'FINANCIAL_FRAGILE', label: 'Situation financière fragile', stepId: 'financialHealth' },
  OPEN_LITIGATION: { code: 'OPEN_LITIGATION', label: 'Sinistre ouvert en contentieux', stepId: 'openItems' },
  DATA_INCONSISTENT: { code: 'DATA_INCONSISTENT', label: 'Données incohérentes (effectif déclaré vs INSEE)', stepId: 'dataQuality' },
};
const out = {};
out['100000001'] = eligible(c1, {
  account: { summary: 'Client C-1001 depuis 2016, segment TPE, effectif déclaré 8.', result: { segment: 'TPE', customerSince: '2016-03-01', declaredHeadcount: 8 } },
  identitySummary: 'Boulangerie-pâtisserie (10.71C) active, quai Duperré à La Rochelle.',
  legal: { summary: 'Aucune procédure collective : 1 annonce (immatriculation).', result: { total: 1, records: [{ type: 'Immatriculation', nature: 'Création', date: '2012-05-14', court: 'Greffe du tribunal de commerce de La Rochelle' }] } },
  fin: { summary: 'CA 612 k€, résultat 38 k€, endettement 42 %, 41 jours de trésorerie.', result: { year: 2025, revenue: 612000, netIncome: 38000, equity: 210000, debtRatio: 0.42, cashDays: 41 } },
  items: { summary: 'Aucun sinistre ouvert, primes à jour.', result: { openClaims: [], unpaidPremiums: 0, pendingTermination: false } },
  geo: { summary: 'Submersion marine forte, inondation moyenne, argiles faible (via MCP).', result: risks('La Rochelle', 'MEDIUM', 'HIGH', 'LOW', 2, 'NONE') },
  dq: { summary: 'Données cohérentes entre CRM, Sirene et bilans (score 94).', result: { status: 'VALID', score: 94, issues: [] } },
  climate: { summary: 'Risque climatique élevé : local en front de mer exposé à la submersion.', result: { level: 'HIGH', score: 78, drivers: ['Submersion marine HIGH', 'Inondation MEDIUM'], rationale: 'Local commercial sur le port, en zone de submersion marine forte.' } },
  health: { summary: 'Situation financière saine (score 81).', result: { level: 'SOUND', score: 81, rationale: 'Rentable, endettement maîtrisé, trésorerie confortable.' } },
  review: { summary: 'Aucun encours : complexité faible.', result: { complexity: 'LOW', manageable: true, rationale: 'Ni sinistre ouvert ni impayé.' } },
  verdict: { summary: 'Suggestion : accepter avec une surprime de 15 % (submersion marine).' },
  reasons: [R.CLIMATE_HIGH],
  reco: { decision: 'ACCEPT_WITH_SURCHARGE', surchargePercent: 15, confidence: 0.86, rationale: ['Entreprise saine et rentable, sans sinistre ouvert.', 'Exposition forte à la submersion marine sur le port de La Rochelle.', 'Surprime de 15 % sur la garantie événements naturels recommandée.'] },
});
out['100000002'] = eligible(c2, {
  account: { summary: 'Client C-1002 depuis 2011, segment PME, effectif déclaré 14.', result: { segment: 'PME', customerSince: '2011-01-15', declaredHeadcount: 14 } },
  identitySummary: 'Mécanique industrielle (25.62B) active à Clermont-Ferrand.',
  legal: { summary: 'Aucune procédure collective : 2 annonces de routine.', result: { total: 2, records: [{ type: 'Immatriculation', nature: 'Création', date: '2004-09-01', court: 'Greffe du tribunal de commerce de Clermont-Ferrand' }, { type: 'Modification', nature: 'Transfert de siège', date: '2018-04-03', court: 'Greffe du tribunal de commerce de Clermont-Ferrand' }] } },
  fin: { summary: 'CA 1,84 M€, résultat 126 k€, endettement 31 %, 63 jours de trésorerie.', result: { year: 2025, revenue: 1840000, netIncome: 126000, equity: 640000, debtRatio: 0.31, cashDays: 63 } },
  items: { summary: '1 sinistre clos en cours de règlement, primes à jour.', result: { openClaims: [{ claimId: 'S-2025-0412', type: 'Bris de machine', amount: 3200, status: 'SETTLING', litigation: false }], unpaidPremiums: 0, pendingTermination: false } },
  geo: { summary: 'Risques naturels faibles, sismicité modérée (via MCP).', result: risks('Clermont-Ferrand', 'LOW', 'NONE', 'LOW', 3, 'NONE') },
  dq: { summary: 'Données cohérentes (score 97).', result: { status: 'VALID', score: 97, issues: [] } },
  climate: { summary: 'Risque climatique faible.', result: { level: 'LOW', score: 18, drivers: ['Inondation LOW'], rationale: 'Zone urbaine peu exposée.' } },
  health: { summary: 'Situation financière saine (score 88).', result: { level: 'SOUND', score: 88, rationale: 'Bonne rentabilité, fonds propres solides.' } },
  review: { summary: '1 petit sinistre en règlement : complexité faible.', result: { complexity: 'LOW', manageable: true, rationale: 'Sinistre de faible montant, sans contentieux.' } },
  verdict: { summary: 'Suggestion : accepter aux conditions standard.' },
  reasons: [],
  reco: { decision: 'ACCEPT', surchargePercent: 0, confidence: 0.93, rationale: ['Entreprise solide et cliente fidèle depuis 2011.', 'Risques naturels faibles sur le site de Clermont-Ferrand.', 'Sinistralité faible et maîtrisée.'] },
});
// Collective procedure: phase 3 skipped, verdict by rule, no LLM call.
{
  const s = c3.siren, skip = 'Non exécutée : procédure collective, l\'orchestrateur coupe court (aucun LLM appelé).';
  out[s] = {
    companyName: c3.name, flow: 'collective', reasons: [R.COLLECTIVE_PROCEDURE],
    steps: {
      checkAccount: { summary: 'Client C-1003 depuis 2014, segment PME, effectif déclaré 32.', result: { customerId: c3.cid, siren: s, name: c3.name, segment: 'PME', customerSince: '2014-09-01', declaredHeadcount: 32 }, calls: [rest('Customer+accounts', `/customers/by-siren/${s}`)] },
      companyIdentity: { summary: 'Transport routier de fret (49.41A) à Lille.', result: c3.identity, calls: [rest('Sirene', `/siren/${s}`)] },
      legalEvents: { summary: 'Redressement judiciaire publié au BODACC le 12/09/2026.', result: { total: 2, records: [{ type: 'Procédure collective', nature: 'Jugement d\'ouverture de redressement judiciaire', date: '2026-09-12', court: 'Tribunal de commerce de Lille Métropole' }, { type: 'Immatriculation', nature: 'Création', date: '2009-02-10', court: 'Greffe du tribunal de commerce de Lille Métropole' }] }, calls: [rest('BODACC', `/annonces?siren=${s}`)] },
      financials: { summary: 'CA 4,2 M€, perte de 380 k€, endettement 91 %.', result: { siren: s, year: 2025, revenue: 4200000, netIncome: -380000, equity: 95000, debtRatio: 0.91, cashDays: 6 }, calls: [rest('Company+financials', `/companies/${s}/financials`)] },
      openItems: { summary: '2 sinistres ouverts, 1 prime impayée.', result: { customerId: c3.cid, openClaims: [{ claimId: 'S-2026-0101', type: 'Dommages marchandises', amount: 18500, status: 'OPEN', litigation: false }, { claimId: 'S-2026-0233', type: 'Vol', amount: 7400, status: 'OPEN', litigation: false }], unpaidPremiums: 1, pendingTermination: false }, calls: [rest('Claims+and+contracts', `/customers/${c3.cid}/open-items`)] },
      dataQuality: { status: 'SKIPPED', summary: skip },
      climateRisk: { status: 'SKIPPED', summary: skip },
      financialHealth: { status: 'SKIPPED', summary: skip },
      openItemsReview: { status: 'SKIPPED', summary: skip },
      synthesis: { kind: 'RULE', summary: 'Règle métier : refus suggéré en cas de procédure collective.', result: { rule: 'COLLECTIVE_PROCEDURE' }, calls: [] },
    },
    recommendation: { decision: 'REFUSE', surchargePercent: 0, confidence: 1.0, rationale: ['Redressement judiciaire en cours (BODACC, 12/09/2026).', 'Règle de souscription : pas de nouveau contrat pendant une procédure collective.'], source: 'RULE' },
  };
}
out['100000004'] = eligible(c4, {
  account: { summary: 'Client C-1004 depuis 2019, segment TPE, effectif déclaré 25.', result: { segment: 'TPE', customerSince: '2019-04-01', declaredHeadcount: 25 } },
  identitySummary: 'Restauration traditionnelle (56.10A), tranche 6 à 9 salariés, Avignon.',
  legal: { summary: 'Aucune procédure collective.', result: { total: 1, records: [{ type: 'Immatriculation', nature: 'Création', date: '2015-06-20', court: 'Greffe du tribunal de commerce d\'Avignon' }] } },
  fin: { summary: 'CA 480 k€, perte de 22 k€, endettement 78 %, 9 jours de trésorerie.', result: { year: 2025, revenue: 480000, netIncome: -22000, equity: 41000, debtRatio: 0.78, cashDays: 9 } },
  items: { summary: '3 sinistres ouverts dont 1 en contentieux.', result: { openClaims: [{ claimId: 'S-2025-0877', type: 'Dégât des eaux', amount: 12400, status: 'OPEN', litigation: false }, { claimId: 'S-2026-0045', type: 'Responsabilité civile', amount: 38000, status: 'OPEN', litigation: true }, { claimId: 'S-2026-0310', type: 'Bris de glace', amount: 1900, status: 'OPEN', litigation: false }], unpaidPremiums: 0, pendingTermination: false } },
  geo: { summary: 'Retrait-gonflement des argiles fort, inondation moyenne (via MCP).', result: risks('Avignon', 'MEDIUM', 'NONE', 'HIGH', 2, 'LOW') },
  dq: { summary: 'Effectif déclaré (25) incohérent avec Sirene (6 à 9 salariés).', result: { status: 'WARNINGS', score: 61, issues: ['Effectif déclaré 25 vs tranche INSEE 6-9', 'Bilan 2025 sans annexe'] } },
  climate: { summary: 'Risque climatique élevé : argiles fort et inondation moyenne.', result: { level: 'HIGH', score: 71, drivers: ['Retrait-gonflement des argiles HIGH', 'Inondation MEDIUM'], rationale: 'Bâti ancien exposé aux mouvements de terrain.' } },
  health: { summary: 'Situation financière fragile (score 38).', result: { level: 'FRAGILE', score: 38, rationale: 'Exercice en perte, trésorerie tendue, endettement élevé.' } },
  review: { summary: 'Encours complexe : un contentieux RC en cours.', result: { complexity: 'HIGH', manageable: false, rationale: '3 sinistres ouverts dont un contentieux de 38 k€.' } },
  verdict: { summary: 'Suggestion : examen approfondi par un souscripteur.' },
  reasons: [R.CLIMATE_HIGH, R.FINANCIAL_FRAGILE, R.OPEN_LITIGATION, R.DATA_INCONSISTENT],
  reco: { decision: 'REVIEW', surchargePercent: 0, confidence: 0.58, rationale: ['Finances fragiles : exercice en perte et 9 jours de trésorerie.', 'Argiles fort sur un bâti ancien.', '3 sinistres ouverts dont un contentieux.', 'Effectif déclaré incohérent avec Sirene : à faire confirmer.'] },
});
// Unknown customer: stop after the first step.
{
  const s = '999999999', skip = 'Non exécutée : aucun compte client pour ce SIREN.';
  const steps = { checkAccount: { summary: 'Aucun compte client pour ce SIREN (CUSTOMER_NOT_FOUND).', result: { code: 'CUSTOMER_NOT_FOUND' }, calls: [rest('Customer+accounts', `/customers/by-siren/${s}`, 404)] } };
  for (const id of ['companyIdentity', 'legalEvents', 'financials', 'openItems', 'dataReview', 'dataQuality', 'climateRisk', 'financialHealth', 'openItemsReview']) steps[id] = { status: 'SKIPPED', summary: skip };
  steps.synthesis = { status: 'SKIPPED', kind: 'RULE', summary: 'Règle métier : non éligible sans compte client.' };
  out[s] = { flow: 'unknown', reasons: [R.UNKNOWN_CUSTOMER], steps,
    recommendation: { decision: 'NOT_ELIGIBLE', surchargePercent: 0, confidence: 1.0, rationale: ['Aucun compte client pour ce SIREN : ouvrir d\'abord le compte dans le CRM.'], source: 'RULE' } };
}
fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2));

// End-to-end tests of the "Souscription Pro" screen (SCENARIO.md v2), with Playwright (Chrome).
//   node ui/tests/e2e.cjs [--backends=orchestrator,microcks,fake] [--sirens=100000001,...] [--no-shots]
// Each (backend, SIREN) runs in its own browser context, all in parallel (a case lasts 1 to 3 minutes): the test
// plays the advisor (data review, then decision), watches the live views and the Comprendre panel, and takes
// light and dark screenshots into ../.run/shots/. Backends that do not answer are skipped.
const path = require('path');
const fs = require('fs');
const { chromium } = require(process.env.PW_CORE
  || '/private/tmp/claude-501/-Users-sebastiendegodez-Documents-source-nosync-microcks/977a5282-6356-47ac-9f8f-eed67088fd15/scratchpad/pw/node_modules/playwright-core');

const BASE = process.env.UI_URL || 'http://localhost:5190';
const SHOTS = path.resolve(__dirname, '../../.run/shots');
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const EXPECTED = {
  100000001: { suggestion: 'ACCEPT_WITH_SURCHARGE', source: 'RULE_OR_LLM', level: 'STANDARD', flow: 'normal', decide: 'follow' },
  100000002: { suggestion: 'ACCEPT', level: 'STANDARD', flow: 'normal', decide: 'override' },
  100000003: { suggestion: 'REFUSE', level: 'REINFORCED', flow: 'collective', caption: 'Procédure collective', decide: 'follow' },
  100000004: { suggestion: 'REVIEW', level: 'REINFORCED', flow: 'normal', decide: 'follow', correct: 8 },
  999999999: { suggestion: 'NOT_ELIGIBLE', level: 'REINFORCED', flow: 'unknown', caption: 'Client introuvable', decide: 'follow' },
};
const LABEL = { orchestrator: 'Orchestrateur .NET', microcks: 'Microcks (mock)', fake: 'Données factices' };
const WORDS_FORBIDDEN = /avis de l.IA|verdict/i;

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + String(detail).slice(0, 220) : ''}`); };
const shots = !args['no-shots'];

async function newPage(browser, { theme = 'light', width = 1600, height = 1000, storage = {} } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
  await ctx.addInitScript(s => { try { if (sessionStorage.getItem('__seeded')) return; sessionStorage.setItem('__seeded', '1'); for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); } catch (e) { /* none */ } }, storage);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.errors.push(m.text()); });
  return page;
}

// Full-page screenshot in light and dark, without the sticky parts.
async function shoot(page, name, { tab, full = true } = {}) {
  if (!shots) return;
  if (tab) { await page.evaluate(t => window.__csp.selectTab(t), tab); await page.waitForTimeout(300); }
  for (const theme of ['light', 'dark']) {
    await page.evaluate(t => { document.documentElement.classList.add('shot'); document.documentElement.dataset.theme = t; }, theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/${name}-${theme}.png`, fullPage: full });
  }
  await page.evaluate(() => { document.documentElement.classList.remove('shot'); delete document.documentElement.dataset.theme; });
  if (tab) await page.evaluate(() => window.__csp.selectTab('overview'));
}

// Records, in the page, what the live views showed over the whole case.
async function watch(page) {
  await page.evaluate(() => {
    const w = window.__watch = { statuses: new Set(), maxPackets: 0, tones: new Set(), labels: new Set(), busyNodes: new Set(), busy: false, waiting: false, queuedSeen: false, blockedSeen: false, pendingWhileRunning: false };
    setInterval(() => {
      const c = window.__csp.state.c;
      if (c) {
        Object.values(c.steps || {}).forEach(s => w.statuses.add(s.status));
        if (Object.values(c.steps).some(s => s.status === 'QUEUED')) w.queuedSeen = true;
        if (c.pendingAction && Object.values(c.steps).some(s => ['RUNNING', 'QUEUED'].includes(s.status))) w.pendingWhileRunning = true;
      }
      if (document.querySelector('.status.s-BLOCKED')) w.blockedSeen = true;
      const ps = document.querySelectorAll('.fd-packet');
      w.maxPackets = Math.max(w.maxPackets, ps.length);
      ps.forEach(p => { p.classList.forEach(x => w.tones.add(x)); const t = p.querySelector('text'); if (t) w.labels.add(t.textContent); });
      document.querySelectorAll('.fd-node.busy').forEach(n => { w.busy = true; w.busyNodes.add(n.dataset.node); });
      if (document.querySelector('.fd-node.waiting')) w.waiting = true;
    }, 120);
  });
}

async function scenario(browser, backend, siren) {
  const exp = EXPECTED[siren];
  const tag = `[${backend}] ${siren}`;
  const page = await newPage(browser, { storage: { 'csp.understand': '1' } });
  try {
    await page.goto(`${BASE}/?backend=${backend}${backend === 'fake' ? '&fakeScale=0.25' : ''}`);
    await page.waitForSelector('#companyGrid input');
    await watch(page);
    await page.check(`input[name=company][value="${siren}"]`);
    await page.click('#launchBtn');
    await page.waitForFunction(() => window.__csp.state.c, null, { timeout: 30000 });
    check(`${tag} dossier ouvert, badge « ${LABEL[backend]} »`, (await page.textContent('#answeredValue')).trim() === LABEL[backend]);
    check(`${tag} 12 étapes (v3, sans geoRisks)`, await page.evaluate(() => Object.keys(window.__csp.state.c.steps).length === 12 && !window.__csp.state.c.steps.geoRisks));
    if (backend === 'microcks') {
      check(`${tag} Comprendre : Microcks joue l'orchestrateur ; reShapr et le LLM au repos, pas grisés`, await page.isVisible('[data-node="uw"]') && !/idle/.test(await page.getAttribute('[data-node="llm"]', 'class')) && !/idle/.test(await page.getAttribute('[data-node="reshapr"]', 'class')));
      check(`${tag} Comprendre : lien pointillé « outil du modèle », référencé par l'orchestrateur réel`, (await page.$('.fd-edge.tool')) !== null && (await page.textContent('.fd-svg')).includes('outil du modèle') && (await page.textContent('.fd-svg')).includes('référencé par l\'orchestrateur réel'));
    }
    check(`${tag} Comprendre : nœud « reShapr (MCP) » hors du cadre`, (await page.textContent('[data-node="reshapr"]')).includes('reShapr (MCP)') && !(await page.$('[data-node="mcp:microcks"]')));

    // 1. Data review (not for an unknown customer).
    if (exp.flow !== 'unknown') {
      await page.waitForFunction(() => window.__csp.state.c?.pendingAction === 'DATA_REVIEW', null, { timeout: 300000 });
      await page.waitForSelector('#reviewForm', { timeout: 10000 });
      const card = await page.textContent('#cpReview');
      check(`${tag} carte de validation : « débloque l'analyse financière »`, card.includes('Votre validation débloque l\'analyse financière'));
      check(`${tag} carte de validation : récapitulatif et alertes du contrôle`, card.includes('Effectif INSEE') && card.includes('Contrôle de la collecte'));
      if (exp.flow === 'normal') {
        await page.waitForTimeout(800);
        check(`${tag} analyse financière « attend votre validation »`, await page.evaluate(() => !!document.querySelector('.status.s-BLOCKED')));
      }
      await shoot(page, `${backend}-${siren}-1-validation`);
      await page.click('#reviewSubmit');
      check(`${tag} validation : confirmation exigée`, await page.isVisible('#reviewError'));
      await page.check('#reviewConfirm');
      if (exp.correct) await page.fill('#headcount', String(exp.correct));
      await page.fill('#reviewComment', 'Données vérifiées avec le client.');
      await page.click('#reviewSubmit');
      await page.waitForFunction(() => window.__csp.state.c?.steps?.dataReview?.status === 'DONE', null, { timeout: 30000 });
      check(`${tag} validation enregistrée`, true);
    }

    // 2. Decision.
    await page.waitForFunction(() => window.__csp.state.c?.pendingAction === 'DECISION', null, { timeout: 300000 });
    await page.waitForSelector('#decisionForm', { timeout: 10000 });
    const c = await page.evaluate(() => window.__csp.state.c);
    check(`${tag} suggestion ${exp.suggestion}`, c.recommendation?.decision === exp.suggestion, c.recommendation?.decision);
    check(`${tag} escalade ${exp.level}`, c.escalation?.level === exp.level, `${c.escalation?.level} · ${(c.escalation?.reasons || []).map(r => r.code).join(',')}`);
    check(`${tag} aucune décision pré-remplie`, await page.evaluate(() => !document.querySelector('input[name=finalDecision]:checked')));
    const reasons = c.escalation?.reasons || [];
    if (exp.level === 'REINFORCED') {
      const banner = await page.textContent('.reinforced-banner');
      check(`${tag} bandeau « risque trop important pour ${reasons.length} raisons »`, banner.includes(`Décision humaine requise — risque trop important pour ${reasons.length} raison`));
      check(`${tag} suggestion masquée derrière « Voir l'éclairage »`, !(await page.isVisible('.insight')) && await page.isVisible('#insightToggle'));
    } else {
      check(`${tag} suggestion visible en retrait (« Éclairage des analyses — consultatif »)`, (await page.textContent('.insight')).includes('Éclairage des analyses — consultatif'));
    }
    await shoot(page, `${backend}-${siren}-2-decision`);
    if (exp.level === 'REINFORCED') {
      await page.click('#insightToggle');
      check(`${tag} éclairage dévoilé à la demande`, await page.isVisible('.insight'));
    }
    // Refusals the screen enforces before posting.
    await page.check(`input[name=finalDecision][value="${exp.decide === 'override' ? 'REVIEW' : exp.suggestion}"]`);
    if (exp.suggestion === 'ACCEPT_WITH_SURCHARGE') await page.fill('#surcharge', String(c.recommendation.surchargePercent || 15));
    await page.click('#decisionSubmit');
    if (exp.level === 'REINFORCED') {
      check(`${tag} renforcée : refus tant que les raisons ne sont pas reconnues`, (await page.textContent('#decisionError')).includes('Reconnaissez'));
      for (const box of await page.$$('input[name=reason]')) await box.check();
      await page.click('#decisionSubmit');
      check(`${tag} renforcée : commentaire obligatoire`, (await page.textContent('#decisionError')).includes('commentaire'));
      await page.fill('#decisionComment', 'Raisons revues une à une avec le client.');
    } else if (exp.decide === 'override') {
      check(`${tag} s'écarter de la suggestion exige un commentaire`, (await page.textContent('#decisionError')).includes('commentaire'));
      await page.fill('#decisionComment', 'Visite de risque demandée avant engagement.');
    }
    if (exp.level === 'REINFORCED' || exp.decide === 'override') await page.click('#decisionSubmit');
    await page.waitForSelector('#decisionRecorded', { timeout: 30000 });
    check(`${tag} « Décision du conseiller enregistrée »`, (await page.textContent('#cpDecision')).includes('Décision du conseiller enregistrée'));
    await page.waitForFunction(() => window.__csp.state.c?.status === 'DECIDED', null, { timeout: 30000 });
    const fin = await page.evaluate(() => window.__csp.state.c);
    if (exp.decide === 'override' && backend !== 'microcks') check(`${tag} followsRecommendation == false (calculé par le serveur)`, fin.advisorDecision?.followsRecommendation === false, JSON.stringify(fin.advisorDecision));

    // 3. What the live views showed.
    const w = await page.evaluate(() => ({ ...window.__watch, statuses: [...window.__watch.statuses], tones: [...window.__watch.tones], labels: [...window.__watch.labels], busyNodes: [...window.__watch.busyNodes] }));
    const llmCalls = Object.values(fin.steps).flatMap(s => s.calls || []).filter(x => x.via === 'LLM').length;
    if (exp.flow === 'normal') {
      // QUEUED depends on timing (two LLM slots actually contended): reported, not required.
      console.log(`INFO  ${tag} file d'attente LLM ${w.queuedSeen ? 'vue (QUEUED)' : 'non observée sur ce passage'}`);
      check(`${tag} pendingAction pendant que d'autres étapes tournent`, w.pendingWhileRunning);
      if (backend !== 'microcks') {
        const vias = (fin.steps.climateRisk?.calls || []).map(x => x.via).join(',');
        check(`${tag} climateRisk : MCP, LLM, MCP, LLM`, /MCP.*LLM.*MCP.*LLM/.test(vias), vias);
        check(`${tag} Comprendre : paquets requête, OK, LLM, MCP, conseiller`, ['req', 'ok', 'llm', 'mcp', 'post'].every(t => w.tones.includes(t)), w.tones.join(','));
        check(`${tag} Comprendre : le modèle demande l'outil (LLM → reShapr → Géorisques)`, w.labels.includes('get_resultats_rapport_risque') && w.labels.includes('GET /resultats_rapport_risque'), w.labels.filter(l => /outil|resultats|tools/.test(l)).join(' | '));
      }
    } else if (backend !== 'microcks') {
      check(`${tag} aucun appel LLM`, llmCalls === 0, String(llmCalls));
      check(`${tag} Comprendre : aucun paquet LLM`, !w.tones.includes('llm'), w.tones.join(','));
    }
    if (backend === 'microcks') {
      check(`${tag} mock : aucune activité fictive en aval (ni LLM, ni MCP, ni rejeu)`, !['llm', 'mcp', 'ghost'].some(t => w.tones.includes(t)), w.tones.join(','));
      check(`${tag} mock : seul l'échange IHM ⇄ Microcks est animé`, w.tones.includes('req') && w.tones.includes('ok'));
      check(`${tag} mock : aucune pulsation en aval (reShapr, LLM, services)`, w.busyNodes.length === 0, w.busyNodes.join(','));
    } else {
      if (exp.flow !== 'unknown') check(`${tag} Comprendre : appels simultanés (≥ 2 paquets)`, w.maxPackets >= 2, String(w.maxPackets));
      if (exp.flow !== 'unknown') check(`${tag} Comprendre : la cible pulse pendant le travail`, w.busy);
    }
    check(`${tag} Comprendre : attente du conseiller côté IHM`, w.waiting);
    const log = await page.$$eval('.fd-log li', l => l.map(x => x.textContent));
    if (exp.caption) check(`${tag} Comprendre : légende « ${exp.caption} »`, log.some(l => l.includes(exp.caption)), log.slice(-4).join(' / '));
    if (exp.flow === 'normal' && backend !== 'microcks') check(`${tag} Comprendre : légende « reShapr expose Géorisques en MCP »`, log.some(l => /reShapr expose Géorisques en MCP ; Microcks simule l.API derrière lui/.test(l)), log.join(' / ').slice(0, 200));
    if (backend === 'microcks') check(`${tag} Comprendre : légende du mode mock`, log.some(l => l.includes('Mode mock : Microcks joue l\'orchestrateur, aucun appel réel en aval')) || (await page.textContent('.fd-caption')).includes('Mode mock'));
    // Parcours: bars, milestones, dependencies; a bar opens its detail.
    await page.evaluate(() => window.__csp.selectTab('timeline'));
    await page.waitForTimeout(400);
    const g = await page.evaluate(() => ({ bars: document.querySelectorAll('.g-bar').length, ms: document.querySelectorAll('.g-ms').length, deps: document.querySelectorAll('.g-dep').length, key: document.querySelectorAll('.g-dep.key').length }));
    check(`${tag} Parcours : barres, jalons et dépendances`, g.bars >= 3 && g.ms >= 2 && (exp.flow !== 'normal' || g.key >= 2), JSON.stringify(g));
    await page.click('.g-bar[data-step="checkAccount"]');
    await page.waitForSelector('#stepDialog[open]');
    check(`${tag} Parcours : une barre ouvre le détail`, (await page.textContent('#dlgTitle')).length > 0);
    await page.keyboard.press('Escape');
    await shoot(page, `${backend}-${siren}-3-parcours`, { tab: 'timeline' });
    // Journal, Risques (map), Vue 360 wording.
    await page.evaluate(() => window.__csp.selectTab('journal'));
    await page.waitForTimeout(200);
    check(`${tag} journal des appels rempli`, (await page.$$('.calls-table tbody tr')).length >= 1);
    if (exp.flow !== 'unknown') {
      await page.evaluate(() => window.__csp.selectTab('risks'));
      await page.waitForTimeout(200);
      check(`${tag} carte illustrative`, (await page.textContent('#panel-risks')).includes('Carte illustrative') || (await page.$('.map-svg')) !== null);
      if (siren === '100000001' || siren === '100000004') await shoot(page, `${backend}-${siren}-4-risques`, { tab: 'risks' });
    }
    await page.evaluate(() => window.__csp.selectTab('overview'));
    const text = await page.evaluate(() => document.body.innerText);
    check(`${tag} vocabulaire (ni « avis de l'IA » ni « verdict »)`, !WORDS_FORBIDDEN.test(text), (text.match(WORDS_FORBIDDEN) || [])[0]);
    check(`${tag} aucune erreur JavaScript`, page.errors.length === 0, page.errors.join(' | '));
    await shoot(page, `${backend}-${siren}-5-final`);
  } catch (e) {
    check(`${tag} scénario complet`, false, e.message.split('\n').slice(0, 4).join(' | '));
    if (shots) await page.screenshot({ path: `${SHOTS}/FAILED-${backend}-${siren}.png`, fullPage: true }).catch(() => {});
  } finally {
    await page.context().close();
  }
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const health = await (await fetch(`${BASE}/bff/health`)).json();
  const available = { fake: true, orchestrator: health.orchestrator.reachable, microcks: health.microcks.reachable && health.microcks.mockImported };
  const wanted = args.backends ? String(args.backends).split(',') : ['orchestrator', 'microcks'];
  const backends = wanted.filter(b => available[b]);
  wanted.filter(b => !available[b]).forEach(b => console.log(`SKIP  backend ${b} indisponible`));
  const sirens = args.sirens ? String(args.sirens).split(',') : Object.keys(EXPECTED);
  const browser = await chromium.launch({ channel: 'chrome' });

  // The cases, all in parallel (one live case per SIREN and per backend).
  // --skip=microcks:100000001,… leaves out a case that an Arazzo run is using at the same time.
  const skip = new Set(args.skip ? String(args.skip).split(',') : []);
  await Promise.all(backends.flatMap(b => sirens.filter(s => !skip.has(`${b}:${s}`)).map(s => scenario(browser, b, s))));

  if (!args['cases-only']) {
    // Changing company closes the case on screen and stops following it.
    {
      const page = await newPage(browser);
      await page.goto(`${BASE}/?backend=fake&fakeScale=0.25`);
      await page.check('input[name=company][value="100000002"]');
      await page.click('#launchBtn');
      await page.waitForFunction(() => window.__csp.state.c, null, { timeout: 20000 });
      await page.check('input[name=company][value="100000001"]');
      const cleared = await page.evaluate(() => !window.__csp.state.c && window.__csp.state.pollToken === null && document.getElementById('statusbar').hidden);
      check('changer d\'entreprise efface le dossier et arrête le suivi', cleared);
      // Tabs with the keyboard.
      await page.focus('#tab-overview');
      await page.keyboard.press('ArrowRight');
      check('onglets : flèches du clavier', await page.evaluate(() => document.activeElement.id === 'tab-company' && document.getElementById('tab-company').getAttribute('aria-selected') === 'true'));
      await page.context().close();
    }
    // Polls never move the page nor take the focus (fast fake case, so each poll brings changes).
    {
      const page = await newPage(browser, { height: 800, storage: { 'csp.understand': '1' } });
      await page.goto(`${BASE}/?backend=fake&fakeScale=0.5`);
      await page.check('input[name=company][value="100000004"]');
      await page.click('#launchBtn');
      await page.waitForFunction(() => Object.values(window.__csp.state.c?.steps || {}).some(s => s.status === 'RUNNING'), null, { timeout: 20000 });
      for (const tab of ['overview', 'timeline', 'board']) {
        await page.evaluate(t => window.__csp.selectTab(t), tab);
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForTimeout(300);
        const before = await page.evaluate(() => {
          const el = document.elementFromPoint(innerWidth * 0.3, innerHeight / 2);
          window.__anchor = el; return { y: scrollY, top: el.getBoundingClientRect().top };
        });
        const polls0 = await page.evaluate(() => window.__csp.state.polls || 0);
        await page.waitForTimeout(5 * 450 + 300);
        const after = await page.evaluate(() => ({ y: scrollY, top: window.__anchor.isConnected ? window.__anchor.getBoundingClientRect().top : null }));
        // scrollY must not move; an element may still shift if a card above it grows (a step just ended).
        check(`défilement : onglet ${tab}, 5 polls sans bouger la page (scrollY)`, Math.abs(after.y - before.y) <= 2 && after.y > 0, `scrollY ${before.y} → ${after.y}, élément sondé ${Math.round(before.top)} → ${after.top === null ? 'retiré' : Math.round(after.top)}`);
      }
      // A <details> opened in the Tableau stays open.
      await page.evaluate(() => window.__csp.selectTab('board'));
      await page.waitForFunction(() => document.querySelector('#panel-board details.calls'), null, { timeout: 30000 });
      await page.evaluate(() => { document.querySelector('#panel-board details.calls').open = true; });
      await page.waitForTimeout(5 * 450);
      check('Tableau : un <details> ouvert reste ouvert pendant les polls', await page.evaluate(() => document.querySelector('#panel-board details.calls')?.open === true));
      // Typing in the review comment while polls go on: text and focus stay.
      await page.waitForFunction(() => window.__csp.state.c?.pendingAction === 'DATA_REVIEW', null, { timeout: 120000 });
      await page.click('#reviewComment');
      await page.keyboard.type('Effectif vérifié ');
      await page.waitForTimeout(5 * 450);
      await page.keyboard.type('sur place.');
      const kept = await page.evaluate(() => ({ v: document.getElementById('reviewComment').value, f: document.activeElement?.id }));
      check('saisie pendant les polls : texte et focus gardés', kept.v === 'Effectif vérifié sur place.' && kept.f === 'reviewComment', JSON.stringify(kept));
      await page.check('#reviewConfirm');
      await page.waitForTimeout(5 * 450);
      check('case cochée gardée pendant les polls', await page.isChecked('#reviewConfirm'));
      await page.context().close();
    }
    // Feature flip, remembered.
    if (available.orchestrator && available.microcks) {
      const page = await newPage(browser, { storage: { 'csp.backend': 'orchestrator' } });
      await page.goto(BASE);
      await page.check('input[name=backend][value=microcks]');
      await page.reload();
      check('flip mémorisé après rechargement', await page.isChecked('input[name=backend][value=microcks]'));
      await page.check('input[name=backend][value=orchestrator]');
      await page.context().close();
    }
    // Backend unreachable (simulated 502 + X-Bff-Error).
    {
      const page = await newPage(browser, { storage: { 'csp.backend': 'orchestrator' } });
      await page.route('**/bff/health', r => r.fulfill({ json: { orchestrator: { reachable: false }, microcks: { reachable: true, mockImported: true } } }));
      await page.route('**/bff/orchestrator/**', r => r.fulfill({ status: 502, headers: { 'X-Backend': 'orchestrator', 'X-Bff-Error': 'unreachable', 'Content-Type': 'application/json' }, body: '{"error":"BACKEND_UNREACHABLE"}' }));
      await page.goto(BASE);
      await page.waitForSelector('#backendAlert:not([hidden])');
      check('injoignable : message clair', (await page.textContent('#backendAlert')).includes('ne répond pas'));
      await page.click('#launchBtn');
      await page.waitForSelector('#formError:not([hidden])');
      check('injoignable : suivi interrompu avec message', (await page.textContent('#formError')).includes('injoignable'));
      if (shots) await page.screenshot({ path: `${SHOTS}/unreachable-light.png` });
      await page.context().close();
    }
    // Mobile, light and dark.
    for (const theme of ['light', 'dark']) {
      const page = await newPage(browser, { theme, width: 390, height: 844 });
      await page.goto(`${BASE}/?backend=fake&fakeScale=0.25`);
      await page.check('input[name=company][value="100000004"]');
      await page.click('#launchBtn');
      await page.waitForFunction(() => window.__csp.state.c?.pendingAction === 'DATA_REVIEW', null, { timeout: 120000 });
      await page.waitForTimeout(500);
      check(`mobile ${theme} : pas de défilement horizontal`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      if (shots) {
        await page.evaluate(() => document.documentElement.classList.add('shot'));
        await page.screenshot({ path: `${SHOTS}/mobile-${theme}.png`, fullPage: true });
      }
      await page.context().close();
    }
  }
  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} vérifications OK · backends : ${backends.join(', ')} · SIREN : ${sirens.join(', ')}`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });

// The advisor's two checkpoints: validate the collected data (dataReview), then decide (advisorDecision).
// Forms are only rebuilt when what they need changes, so a poll never wipes what the advisor is typing.
import { DECISIONS, LEVELS, esc, euros, frTime, headcountMismatch, isCollective, naturalRisksOf, pct, resultOf } from './domain.js';
import { icon } from './icons.js';
import { statusChip } from './views.js';

const ERRORS = {
  COMMENT_REQUIRED: 'Un commentaire est obligatoire (décision renforcée, ou décision différente de la suggestion).',
  REASONS_NOT_ACKNOWLEDGED: 'Reconnaissez chacune des raisons de risque avant de décider.',
  NOT_EXPECTED: 'Ce n\'est plus le moment : le dossier a avancé. L\'écran se met à jour.',
  DECISION_REQUIRED: 'Choisissez une décision.',
};
const errorText = err => ERRORS[err?.body?.code] || (err?.kind === 'unreachable' ? 'Backend injoignable : rien n\'a été enregistré.' : `Refusé par le backend (HTTP ${err?.status || '?'}${err?.body?.code ? ' · ' + err.body.code : ''}).`);

export class Checkpoints {
  constructor(host, { now, postReview, postDecision, openStep, onFocusRequest }) {
    Object.assign(this, { host, now, postReview, postDecision, openStep, onFocusRequest });
    this.keys = {};
    host.innerHTML = `
      <article class="checkpoint" id="cpReview" aria-labelledby="cpReviewTitle"></article>
      <article class="checkpoint" id="cpDecision" aria-labelledby="cpDecisionTitle"></article>`;
    this.review = host.querySelector('#cpReview');
    this.decision = host.querySelector('#cpDecision');
    host.addEventListener('click', e => { const b = e.target.closest('[data-open-step]'); if (b) this.openStep(b.dataset.openStep); });
  }

  update(c) {
    this.c = c;
    this.renderReview(c);
    this.renderDecision(c);
    const active = c?.pendingAction === 'DATA_REVIEW' ? 'review' : c?.pendingAction === 'DECISION' ? 'decision' : null;
    this.host.dataset.active = active || '';
    this.review.classList.toggle('compact', active === 'decision');
    this.decision.classList.toggle('compact', active === 'review');
  }

  head(id, num, title, step, sub) {
    return `<header class="cp-head">${icon('person', 'ico ico-human')}<div><h3 id="${id}"><span class="cp-num">${num}</span>${esc(title)}</h3><p class="cp-sub">${sub}</p></div>
      ${step && this.c ? statusChip(this.c, { ...step, id: step.id }, this.now()) : ''}</header>`;
  }

  /* ---------- 1. Data review ---------- */
  renderReview(c) {
    const step = c?.steps?.dataReview ? { id: 'dataReview', ...c.steps.dataReview } : null;
    const state = !c ? 'none' : c.pendingAction === 'DATA_REVIEW' ? 'active' : step?.status === 'DONE' ? 'done' : step?.status === 'SKIPPED' ? 'skipped' : 'pending';
    const key = `${c?.caseId}|${state}|${state === 'pending' ? collectProgress(c) : ''}|${state === 'done' ? JSON.stringify(c.dataReview) : ''}`;
    const sub = 'Votre validation débloque l\'analyse financière.';
    if (this.keys.review === key) { this.refreshHead(this.review, step); return; }
    this.keys.review = key;
    this.review.className = `checkpoint state-${state}`;
    const head = this.head('cpReviewTitle', '1', 'Validation des données', step, sub);
    if (state === 'none') { this.review.innerHTML = head + '<p class="cp-idle">Après la collecte et son contrôle, vous confirmez ou corrigez les données.</p>'; return; }
    if (state === 'skipped') { this.review.innerHTML = head + `<p class="cp-idle">${esc(step.summary || 'Non requise.')}</p>`; return; }
    if (state === 'pending') { this.review.innerHTML = head + `<p class="cp-idle">${icon('clock', 'ico')}Collecte en cours : ${collectProgress(c)} étapes terminées sur 5. Le formulaire s'ouvre dès que l'orchestrateur vous le demande.</p>`; return; }
    if (state === 'done') {
      const r = c.dataReview || step.result || {};
      this.review.innerHTML = head + `<div class="cp-done">${icon('check', 'ico')}<div><strong>Données validées</strong>${r.reviewedAt ? ` à ${esc(frTime(r.reviewedAt))}` : ''}
        ${r.corrections?.declaredHeadcount !== undefined && r.corrections?.declaredHeadcount !== null ? `<br>Effectif déclaré corrigé : <strong>${esc(r.corrections.declaredHeadcount)}</strong>` : ''}
        ${r.comment ? `<br>Commentaire : ${esc(r.comment)}` : ''}</div></div>`;
      return;
    }
    // Active: the recap of what was collected, the data-quality alerts, and the form.
    const id = resultOf(c, 'companyIdentity'), acc = resultOf(c, 'checkAccount'), fin = resultOf(c, 'financials'), legal = resultOf(c, 'legalEvents'),
      items = resultOf(c, 'openItems'), geo = naturalRisksOf(c), dq = resultOf(c, 'dataQuality');
    const mismatch = headcountMismatch(id?.headcountRange, acc?.declaredHeadcount);
    const rn = geo?.risquesNaturels || {};
    const riskText = Object.entries({ submersionMarine: 'submersion', inondation: 'inondation', retraitGonflementArgiles: 'argiles', feuxForet: 'feux' })
      .map(([k, l]) => rn[k]?.level && rn[k].level !== 'NONE' ? `${l} ${LEVELS[rn[k].level]}` : null).filter(Boolean).join(', ') || 'faibles';
    const claims = items?.openClaims || [];
    const collective = (legal?.records || []).filter(isCollective);
    this.review.innerHTML = head + `
      <div class="cp-body">
        <div class="recap">
          <div class="recap-item"><span>Identité (Sirene)</span><strong>${esc(id?.denomination || '—')}</strong><small>${esc(id ? `${id.nafLabel} · ${id.address?.city || ''}` : '')}</small></div>
          <div class="recap-item ${mismatch ? 'warn' : ''}"><span>Effectif INSEE / déclaré</span><strong>${esc(id?.headcountRange ?? '—')} / ${esc(acc?.declaredHeadcount ?? '—')}</strong>${mismatch ? `<small class="flag warn">${icon('warn', 'ico')}incohérent</small>` : '<small>cohérent</small>'}</div>
          <div class="recap-item"><span>Bilan ${esc(fin?.year || '')}</span><strong>${euros(fin?.revenue)}</strong><small>résultat ${euros(fin?.netIncome)} · endettement ${pct(fin?.debtRatio)}</small></div>
          <div class="recap-item ${collective.length ? 'ko' : ''}"><span>Annonces BODACC</span><strong>${esc(legal?.total ?? (legal?.records || []).length)}</strong><small>${collective.length ? `<span class="flag ko">${icon('warn', 'ico')}${esc(collective[0].nature)}</span>` : 'aucune procédure collective'}</small></div>
          <div class="recap-item ${claims.some(x => x.litigation) ? 'warn' : ''}"><span>Sinistres ouverts</span><strong>${claims.length}</strong><small>${claims.some(x => x.litigation) ? `dont ${claims.filter(x => x.litigation).length} en contentieux` : 'aucun contentieux'}</small></div>
          <div class="recap-item"><span>Risques naturels</span><strong>${esc(geo ? riskText : 'à venir')}</strong><small>${geo ? 'agent climat · outil MCP' : 'l\'agent climat les cherche (MCP)'}</small></div>
        </div>
        <div class="dq-alerts ${dq?.issues?.length ? 'has' : ''}">
          <h4>${icon('robot', 'ico ico-llm')}Contrôle de la collecte <span class="consult">analyse LLM · consultatif</span></h4>
          ${dq ? (dq.issues?.length ? `<ul>${dq.issues.map(i => `<li>${icon('warn', 'ico warn-ico')}${esc(i)}</li>`).join('')}</ul>` : '<p>Aucune alerte : les sources concordent.</p>') : '<p class="muted">Pas de contrôle disponible.</p>'}
        </div>
        <form class="cp-form" id="reviewForm" novalidate>
          <label class="check"><input type="checkbox" id="reviewConfirm" required> Je confirme les données collectées${dq?.issues?.length ? ', alertes comprises' : ''}.</label>
          <div class="field-row">
            <div class="field"><label for="headcount">Corriger l'effectif déclaré <span class="hint">(facultatif)</span></label>
              <input type="number" id="headcount" min="0" max="100000" inputmode="numeric" placeholder="déclaré : ${esc(acc?.declaredHeadcount ?? '—')}" aria-describedby="headcountHint">
              <span class="hint" id="headcountHint">INSEE : tranche ${esc(id?.headcountRange ?? '—')}.</span></div>
            <div class="field grow"><label for="reviewComment">Commentaire <span class="hint">(facultatif)</span></label>
              <textarea id="reviewComment" rows="2" placeholder="Ce que vous avez vérifié"></textarea></div>
          </div>
          <p class="form-error" id="reviewError" role="alert" hidden></p>
          <div class="form-actions"><button type="submit" class="btn btn-human" id="reviewSubmit">${icon('check', 'ico')}Valider les données</button>
            <span class="hint">L'analyse financière démarrera après votre validation.</span></div>
        </form>
      </div>`;
    this.review.querySelector('#reviewForm').addEventListener('submit', e => this.submitReview(e));
  }

  async submitReview(e) {
    e.preventDefault();
    const err = this.review.querySelector('#reviewError');
    const confirm = this.review.querySelector('#reviewConfirm');
    if (!confirm.checked) { err.textContent = 'Cochez la confirmation des données.'; err.hidden = false; confirm.focus(); return; }
    const hc = this.review.querySelector('#headcount').value.trim();
    const payload = { confirmed: true, corrections: hc === '' ? {} : { declaredHeadcount: Number(hc) }, comment: this.review.querySelector('#reviewComment').value.trim() };
    const btn = this.review.querySelector('#reviewSubmit');
    btn.disabled = true;
    try { await this.postReview(payload); } catch (ex) { btn.disabled = false; err.textContent = errorText(ex); err.hidden = false; }
  }

  refreshHead(el, step) {
    const chip = el.querySelector('.cp-head .status');
    if (chip && step && this.c) chip.outerHTML = statusChip(this.c, step, this.now());
  }

  /* ---------- 2. Decision ---------- */
  renderDecision(c) {
    const step = c?.steps?.advisorDecision ? { id: 'advisorDecision', ...c.steps.advisorDecision } : null;
    const state = !c ? 'none' : c.pendingAction === 'DECISION' ? 'active' : c.advisorDecision || step?.status === 'DONE' ? 'done' : 'pending';
    const esc8 = c?.escalation;
    const key = `${c?.caseId}|${state}|${esc8?.level}|${(esc8?.reasons || []).map(r => r.code).join(',')}|${c?.recommendation?.decision}|${state === 'done' ? JSON.stringify(c.advisorDecision) : ''}`;
    if (this.keys.decision === key) { this.refreshHead(this.decision, step); return; }
    this.keys.decision = key;
    const reinforced = esc8?.level === 'REINFORCED';
    this.decision.className = `checkpoint state-${state} ${reinforced ? 'reinforced' : ''}`;
    const head = this.head('cpDecisionTitle', '2', 'Décision du conseiller', step, 'C\'est vous qui décidez ; les analyses n\'apportent qu\'un éclairage.');
    if (state === 'none') { this.decision.innerHTML = head + '<p class="cp-idle">Après les analyses, vous choisissez la décision et la surprime.</p>'; return; }
    if (state === 'pending') { this.decision.innerHTML = head + `<p class="cp-idle">${icon('clock', 'ico')}Disponible après la synthèse des analyses.</p>`; return; }
    const reco = c.recommendation;
    if (state === 'done') {
      const a = c.advisorDecision || step?.result || {};
      const sent = this.sent;
      this.decision.innerHTML = head + `<div class="cp-done big" id="decisionRecorded" tabindex="-1">${icon('check', 'ico')}<div>
        <strong class="done-title">Décision du conseiller enregistrée</strong>
        <dl class="kv"><dt>Décision</dt><dd id="finalDecisionValue">${esc(DECISIONS[a.finalDecision] || a.finalDecision)}${a.surchargePercent ? ` · surprime +${esc(a.surchargePercent)} %` : ''}</dd>
          <dt>Par rapport à la suggestion</dt><dd>${a.followsRecommendation === undefined ? '—' : a.followsRecommendation ? 'conforme' : 's\'en écarte'}</dd>
          <dt>Commentaire</dt><dd>${esc(a.comment || '—')}</dd>
          ${(a.acknowledgedReasons || []).length ? `<dt>Raisons reconnues</dt><dd>${a.acknowledgedReasons.length}</dd>` : ''}
          <dt>Le</dt><dd>${a.decidedAt ? esc(new Date(a.decidedAt).toLocaleString('fr-FR')) : '—'}</dd></dl>
        ${sent && sent.finalDecision !== a.finalDecision ? '<p class="note">Réponse figée du mock : elle peut différer de votre saisie.</p>' : ''}</div></div>`;
      return;
    }
    const reasons = esc8?.reasons || [];
    const insight = reco ? `
      <aside class="insight" aria-labelledby="insightTitle">
        <h4 id="insightTitle">${reco.source === 'RULE' ? icon('rule', 'ico ico-rule') : icon('robot', 'ico ico-llm')}Éclairage des analyses — consultatif</h4>
        <p class="insight-sugg">Suggestion : <strong>${esc(DECISIONS[reco.decision] || reco.decision)}</strong>${reco.surchargePercent ? ` · surprime +${esc(reco.surchargePercent)} %` : ''}</p>
        <div class="gauge" data-band="${reco.confidence < 0.6 ? 'low' : reco.confidence < 0.8 ? 'mid' : 'high'}">
          <div class="gauge-head"><span id="confLabel">Confiance</span><strong>${Math.round((reco.confidence || 0) * 100)} %</strong></div>
          <div class="gauge-track" role="meter" aria-labelledby="confLabel" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round((reco.confidence || 0) * 100)}"><span class="gauge-fill" style="width:${Math.round((reco.confidence || 0) * 100)}%"></span></div>
        </div>
        <ul class="rationale">${(reco.rationale || []).map(r => `<li>${esc(r)}</li>`).join('')}</ul>
        <p class="insight-src">Source : ${reco.source === 'RULE' ? 'règle métier (sans LLM)' : 'synthèse des analyses LLM'}. Elle ne décide pas à votre place.</p>
      </aside>` : '';
    this.decision.innerHTML = head + `
      ${reinforced ? `<div class="reinforced-banner" role="alert">${icon('warn', 'ico')}<div><strong>Décision humaine requise — risque trop important pour ${reasons.length} raison${reasons.length > 1 ? 's' : ''}</strong>
        <p>Reconnaissez chaque raison une à une ; un commentaire est obligatoire.</p></div></div>` : ''}
      <div class="cp-body decision-layout">
        <form class="cp-form" id="decisionForm" novalidate>
          ${reinforced ? `<fieldset class="reasons"><legend>Raisons de risque à reconnaître</legend>
            ${reasons.map((r, i) => `<div class="reason"><label><input type="checkbox" name="reason" value="${esc(r.code)}"> ${esc(r.label)}</label>
              ${r.stepId ? `<button type="button" class="link-btn" data-open-step="${esc(r.stepId)}">voir l'étape</button>` : ''}</div>`).join('')}
            <p class="hint" id="reasonCount">0 sur ${reasons.length} reconnue${reasons.length > 1 ? 's' : ''}</p></fieldset>` : ''}
          <fieldset class="decision-choice"><legend>Votre décision</legend>
            ${Object.entries(DECISIONS).map(([k, v]) => `<label class="radio"><input type="radio" name="finalDecision" value="${k}"> ${esc(v)}</label>`).join('')}
          </fieldset>
          <div class="field-row">
            <div class="field"><label for="surcharge">Surprime (%)</label><input type="number" id="surcharge" min="0" max="100" step="1" disabled aria-describedby="surchargeHint"><span class="hint" id="surchargeHint">Pour « Accepter avec surprime ».</span></div>
            <div class="field grow"><label for="decisionComment">Commentaire <span class="hint" id="commentRule">${reinforced ? '(obligatoire)' : '(obligatoire si vous vous écartez de la suggestion)'}</span></label>
              <textarea id="decisionComment" rows="3" placeholder="Votre justification"></textarea></div>
          </div>
          <p class="form-error" id="decisionError" role="alert" hidden></p>
          <div class="form-actions"><button type="submit" class="btn btn-human" id="decisionSubmit">${icon('check', 'ico')}Enregistrer ma décision</button></div>
        </form>
        ${reinforced && insight ? `<div class="insight-wrap"><button type="button" class="btn btn-sm" id="insightToggle" aria-expanded="false" aria-controls="insightBox">${icon('eye', 'ico')}Voir l'éclairage des analyses</button><div id="insightBox" hidden>${insight}</div></div>` : insight}
      </div>`;
    const form = this.decision.querySelector('#decisionForm');
    const surcharge = form.querySelector('#surcharge');
    form.querySelectorAll('input[name=finalDecision]').forEach(r => r.addEventListener('change', () => {
      surcharge.disabled = r.value !== 'ACCEPT_WITH_SURCHARGE';
      if (surcharge.disabled) surcharge.value = '';
    }));
    form.querySelectorAll('input[name=reason]').forEach(r => r.addEventListener('change', () => {
      const n = form.querySelectorAll('input[name=reason]:checked').length;
      form.querySelector('#reasonCount').textContent = `${n} sur ${reasons.length} reconnue${reasons.length > 1 ? 's' : ''}`;
    }));
    const toggle = this.decision.querySelector('#insightToggle');
    if (toggle) toggle.addEventListener('click', () => {
      const box = this.decision.querySelector('#insightBox');
      box.hidden = !box.hidden;
      toggle.setAttribute('aria-expanded', String(!box.hidden));
      toggle.lastChild.textContent = box.hidden ? 'Voir l\'éclairage des analyses' : 'Masquer l\'éclairage des analyses';
    });
    form.addEventListener('submit', e => this.submitDecision(e, reco, reasons, reinforced));
  }

  async submitDecision(e, reco, reasons, reinforced) {
    e.preventDefault();
    const form = this.decision.querySelector('#decisionForm');
    const err = form.querySelector('#decisionError');
    const show = (text, focus) => { err.textContent = text; err.hidden = false; focus?.focus(); };
    const choice = form.querySelector('input[name=finalDecision]:checked');
    if (!choice) return show('Choisissez votre décision.', form.querySelector('input[name=finalDecision]'));
    const acked = [...form.querySelectorAll('input[name=reason]:checked')].map(x => x.value);
    if (reinforced && acked.length < reasons.length) return show(`Reconnaissez chacune des ${reasons.length} raisons (${acked.length} cochée${acked.length > 1 ? 's' : ''}).`, form.querySelector('input[name=reason]:not(:checked)'));
    const surchargeRaw = form.querySelector('#surcharge').value;
    const surcharge = choice.value === 'ACCEPT_WITH_SURCHARGE' ? Number(surchargeRaw || 0) : 0;
    if (choice.value === 'ACCEPT_WITH_SURCHARGE' && !(surcharge > 0)) return show('Indiquez la surprime (en %).', form.querySelector('#surcharge'));
    const comment = form.querySelector('#decisionComment').value.trim();
    const differs = reco && (choice.value !== reco.decision || (choice.value === 'ACCEPT_WITH_SURCHARGE' && surcharge !== Number(reco.surchargePercent || 0)));
    if (!comment && (reinforced || differs)) {
      form.querySelector('#decisionComment').setAttribute('aria-invalid', 'true');
      return show(reinforced ? 'Décision renforcée : un commentaire est obligatoire.' : 'Vous vous écartez de la suggestion : un commentaire est obligatoire.', form.querySelector('#decisionComment'));
    }
    const payload = { finalDecision: choice.value, surchargePercent: surcharge, comment };
    if (reinforced) payload.acknowledgedReasons = acked;
    const btn = form.querySelector('#decisionSubmit');
    btn.disabled = true;
    this.sent = payload;
    try { await this.postDecision(payload); this.decision.querySelector('#decisionRecorded')?.focus(); } catch (ex) { btn.disabled = false; show(errorText(ex)); }
  }
}

function collectProgress(c) {
  const ids = ['companyIdentity', 'legalEvents', 'financials', 'openItems', 'dataQuality'];
  return ids.filter(id => ['DONE', 'SKIPPED', 'FAILED'].includes(c?.steps?.[id]?.status)).length;
}

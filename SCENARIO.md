# Souscription Pro — scénario de démo

Une démo Microcks + Arazzo sur un cas d'assurance : un conseiller souscription ouvre un dossier
« Multirisque Pro » pour une entreprise. Un orchestrateur central fait travailler des services (API de l'État,
API internes) et des assistants d'analyse (LLM), à la chaîne ou en parallèle, et rend compte étape par étape.

**Le conseiller est au cœur du dossier (v2, normatif).** Rien n'est décidé sans lui : il **valide les données
collectées** avant toute analyse, et il **prend la décision finale**. Les LLM ne donnent qu'un éclairage
**consultatif** ; l'IHM ne le présente jamais comme une décision. Les temps sont **longs et aléatoires**, comme
avec de vrais services.

Ce fichier est le **contrat entre les trois parties** (contrats/mocks, orchestrateur, IHM). Tout nom, chemin,
port ou champ ci-dessous est normatif : ne pas le changer sans mettre ce fichier à jour.

## Ce que la démo montre

| # | Ce qu'on montre | Comment |
|---|---|---|
| 1 | Une IHM de souscription où les agents rendent compte en direct | `ui/` (port 5190) |
| 2 | Un orchestrateur .NET qui enchaîne et parallélise services et LLM | `orchestrator/` (port 5180) |
| 3 | Microcks qui **mocke de vraies API** (État, internes) | contrats OpenAPI dans `contracts/` |
| 4 | Microcks qui **mocke un LLM** (API compatible OpenAI) | `contracts/llm-gateway.openapi.yaml` |
| 5 | Microcks en **serveur MCP** : l'agent climat découvre et appelle ses outils | `POST /mcp/Georisques/1.0.0` |
| 6 | Arazzo **vérifie que l'orchestrateur fait le parcours** attendu | `contracts/underwriting.arazzo.yaml` + overlay |
| 7 | Microcks **se fait passer pour l'orchestrateur** (feature flip dans l'IHM) | mock stateful de `Underwriting cases` |

## Ports et URLs

| Composant | URL |
|---|---|
| Microcks (stack Arazzo existante) | `http://localhost:8080` |
| Mock REST d'une API | `http://localhost:8080/rest/<Nom avec + pour les espaces>/1.0.0` |
| Serveur MCP Microcks (Streamable HTTP, JSON-RPC) | `http://localhost:8080/mcp/Georisques/1.0.0` |
| Orchestrateur .NET | `http://localhost:5180` |
| IHM (hôte .NET statique + BFF) | `http://localhost:5190` |

## Entreprises de démo (données cohérentes dans tous les mocks)

| SIREN | Entreprise | Ville (INSEE) | Client | Ce qui se passe | Avis attendu |
|---|---|---|---|---|---|
| `100000001` | Boulangerie Les Délices du Port | La Rochelle 17300 (`17300`), lat 46.1591 lon -1.1520 | `C-1001` | Saine, mais **submersion marine forte** | `ACCEPT_WITH_SURCHARGE`, +15 % |
| `100000002` | Atelier Mécanique Durand | Clermont-Ferrand 63000 (`63113`), lat 45.7772 lon 3.0870 | `C-1002` | Saine, risques faibles | `ACCEPT` |
| `100000003` | Transports Express Nord | Lille 59000 (`59350`), lat 50.6292 lon 3.0573 | `C-1003` | **Redressement judiciaire** au BODACC → l'orchestrateur coupe court, **aucun LLM appelé** | `REFUSE` (source `RULE`) |
| `100000004` | Restaurant Le Vieux Moulin | Avignon 84000 (`84007`), lat 43.9493 lon 4.8055 | `C-1004` | Finances fragiles, argiles fort, **3 sinistres ouverts dont 1 contentieux**, effectif déclaré incohérent | `REVIEW` |
| `999999999` | (inconnue) | — | aucun | **Compte client introuvable** → arrêt après la 1ʳᵉ étape | `NOT_ELIGIBLE` (source `RULE`) |

## API appelées par l'orchestrateur (mockées par Microcks)

Contrats OpenAPI 3.0 inspirés des vraies API, simplifiés. Nom Microcks = `info.title`, version `1.0.0`.

| `info.title` | Rôle | Opérations |
|---|---|---|
| `Customer accounts` | CRM interne | `GET /customers/by-siren/{siren}` → 200 `{customerId, siren, name, segment, customerSince, declaredHeadcount}` ; 404 `{code: CUSTOMER_NOT_FOUND}` |
| `Sirene` | INSEE (identité) | `GET /siren/{siren}` → `{siren, denomination, nafCode, nafLabel, headcountRange, creationDate, active, address: {street, postalCode, city, inseeCityCode, lat, lon}}` |
| `BODACC` | annonces légales | `GET /annonces?siren={siren}` → `{total, records: [{type, nature, date, court}]}` |
| `Georisques` | risques naturels (**exposé aussi en MCP**) | `GET /resultats_rapport_risque?code_insee={code}&latlon={lon},{lat}` → `{commune, risquesNaturels: {inondation: {present, level}, submersionMarine: {present, level}, retraitGonflementArgiles: {present, level}, seisme: {zone}, feuxForet: {present, level}}}` (`level`: `NONE`/`LOW`/`MEDIUM`/`HIGH`) |
| `Company financials` | bilans (type Banque de France) | `GET /companies/{siren}/financials` → `{siren, year, revenue, netIncome, equity, debtRatio, cashDays}` |
| `Claims and contracts` | sinistres et contrats internes | `GET /customers/{customerId}/open-items` → `{customerId, openClaims: [{claimId, type, amount, status, litigation}], unpaidPremiums, pendingTermination}` |
| `LLM gateway` | LLM compatible OpenAI | `POST /v1/chat/completions` (voir ci-dessous) |

### Le LLM mocké

Requête au format OpenAI Chat Completions. L'orchestrateur ajoute **toujours** un champ `metadata` qui sert au
dispatch Microcks (dispatcher `SCRIPT` qui lit le corps JSON) :

```json
{ "model": "gpt-4o-mini", "messages": [ ... ], "response_format": { "type": "json_object" },
  "metadata": { "agent": "climate-risk", "siren": "100000001" } }
```

Nom d'exemple Microcks = `<agent>-<siren>` (ex. `climate-risk-100000001`). Réponse : format OpenAI, la sortie
structurée de l'agent est la **chaîne JSON** de `choices[0].message.content`.

| `metadata.agent` | Sortie (`content`, JSON) |
|---|---|
| `data-quality` | `{"status": "VALID|WARNINGS|INVALID", "score": 0-100, "issues": ["…"]}` |
| `climate-risk` | `{"level": "LOW|MEDIUM|HIGH|VERY_HIGH", "score": 0-100, "drivers": ["…"], "rationale": "…"}` |
| `financial-health` | `{"level": "SOUND|FRAGILE|CRITICAL", "score": 0-100, "rationale": "…"}` |
| `open-items` | `{"complexity": "LOW|MEDIUM|HIGH", "manageable": true|false, "rationale": "…"}` |
| `verdict` | `{"decision": "ACCEPT|ACCEPT_WITH_SURCHARGE|REVIEW|REFUSE", "surchargePercent": 0, "confidence": 0.0-1.0, "rationale": ["…"]}` |

Les exemples n'existent que pour les SIREN `100000001`, `100000002`, `100000004` (le 3 et le 999 n'appellent
aucun LLM).

### Microcks en serveur MCP

Microcks expose les opérations d'une API importée comme outils MCP sur `POST /mcp/{service}/{version}`
(JSON-RPC 2.0 : `initialize`, `tools/list`, `tools/call`). L'étape `geoRisks` de l'orchestrateur **ne connaît pas
l'URL REST de Géorisques** : elle fait `tools/list` sur `http://localhost:8080/mcp/Georisques/1.0.0`, choisit
l'outil de l'opération `GET /resultats_rapport_risque`, puis `tools/call` avec `code_insee` et `latlon`.
Le nom exact de l'outil est relevé par l'agent contrats dans la section « Constaté » en bas de ce fichier.

**Variante reShapr** (si le MCP natif de Microcks ne suffit pas) : reShapr, l'outil de Laurent Broudoux qui
expose une API existante en MCP de façon déclarative, sert le MCP. **Microcks simule l'API Géorisques derrière
lui.** L'endpoint MCP est donc configurable dans l'orchestrateur (`Mcp:Georisques:Endpoint`), et l'IHM déduit
du `calls[].url` qui expose le MCP (Microcks dans le cadre, ou reShapr hors du cadre → mock Georisques).

## v3 — le modèle appelle le MCP, qui appelle l'API (normatif, remplace ce qui précède sur `geoRisks`)

- **Le serveur MCP, c'est reShapr** (`http://localhost:7778/mcp/reshapr/georisques-1-0-0-default`). Microcks ne fait
  que **simuler l'API Géorisques derrière lui**. L'IHM affiche toujours « reShapr (MCP) », quel que soit le backend.
- **La chaîne réelle est : agent climat (LLM) → reShapr (MCP) → API Géorisques (mock Microcks).** L'étape
  `geoRisks` disparaît de la collecte : c'est **l'agent `climateRisk` qui va chercher les risques naturels par un
  appel d'outil**. Il y a donc **12 étapes**. Boucle d'agent dans l'orchestrateur, pour l'étape `climateRisk` :
  1. `tools/list` sur reShapr, pour obtenir les outils ;
  2. appel LLM avec `tools` (format OpenAI, à partir de l'`inputSchema` MCP), la commune et les coordonnées ;
  3. le LLM répond par un `tool_calls` `get_resultats_rapport_risque({code_insee, latlon})` ;
  4. l'orchestrateur exécute l'outil **via reShapr** (`tools/call`), et reShapr appelle le mock Géorisques ;
  5. deuxième appel LLM avec le message `role: tool` qui contient le résultat → la sortie structurée de l'agent.
  `calls` de `climateRisk` = dans l'ordre : MCP `tools/list`, LLM (`tool_calls`), MCP `tools/call`, LLM (réponse).
  `result` contient aussi `naturalRisks` (le corps Géorisques), utilisé par les onglets Risques et Vue 360.
- **Le LLM mocké sait demander un outil** : pour `metadata.agent == 'climate-risk'`, le dispatcher SCRIPT renvoie
  l'exemple `climate-risk-<siren>-tool-call` (`finish_reason: tool_calls`) tant que la requête ne contient aucun
  message `role: tool`, puis `climate-risk-<siren>` une fois le résultat de l'outil fourni.
- `dependsOn` : `climateRisk` ← `companyIdentity`, `dataQuality` ; `dataReview` ← les 4 étapes de collecte +
  `dataQuality`. Le reste est inchangé (la validation du conseiller bloque toujours `financialHealth`).
- **Pas d'activité fictive.** En mode « Microcks (mock) », Microcks répond **à la place** de l'orchestrateur :
  aucun service, aucun LLM ni aucun MCP n'est réellement appelé. Le mode Comprendre ne montre alors **que**
  l'échange IHM ⇄ Microcks (mock de l'orchestrateur) ; les autres nœuds restent inactifs, grisés, avec la légende
  « Mode mock : Microcks joue l'orchestrateur, aucun appel réel en aval ». Un nœud ne s'anime que pour un appel
  réellement fait, d'après les `calls` de l'orchestrateur réel.
- Arazzo : les workflows ne connaissent plus `geoRisks` ; ils vérifient que `climateRisk.calls` contient bien un
  appel `via == 'MCP'` (le `tools/call`) encadré par deux appels `via == 'LLM'`.

## L'orchestrateur : `Underwriting cases` 1.0.0 (port 5180)

Son contrat OpenAPI est `contracts/underwriting-cases.openapi.yaml` (`info.title: Underwriting cases`). Il est
**aussi importé dans Microcks**, avec un mock stateful, pour que l'IHM puisse tourner sans l'orchestrateur.

- `POST /underwriting-cases` `{siren, product: "MULTIRISQUE_PRO"}` → **202** `{caseId, status: "IN_PROGRESS"}`
- `GET /underwriting-cases/{caseId}` → **200** `Case`
- `POST /underwriting-cases/{caseId}/advisor-decision` `{followsRecommendation, finalDecision, comment}` → **200** `Case`
- `GET /underwriting-cases/{caseId}` d'un id inconnu → 404

```text
Case {
  caseId, siren, product, companyName?, createdAt,
  status: IN_PROGRESS | WAITING_ADVISOR | DECIDED,
  pendingAction: DATA_REVIEW | DECISION | null,   // ce que le conseiller doit faire quand WAITING_ADVISOR
  stepOrder: [stepId…],                 // l'ordre d'affichage, toujours les 13 étapes
  steps: { <stepId>: Step },            // objet indexé par stepId (pratique pour les JSON pointers Arazzo)
  recommendation?: { decision: ACCEPT | ACCEPT_WITH_SURCHARGE | REVIEW | REFUSE | NOT_ELIGIBLE,
                     surchargePercent, confidence, rationale: [string], source: LLM | RULE },  // CONSULTATIF
  dataReview?: { confirmed, corrections: { declaredHeadcount? }, comment, reviewedAt },
  escalation?: { level: STANDARD | REINFORCED,                  // connu dès que pendingAction == DECISION
                 reasons: [{ code, label, stepId }] },          // les raisons de risque, en français

  advisorDecision?: { finalDecision, surchargePercent, followsRecommendation, comment, decidedAt }
}
Step {
  label, phase: 1..6, mode: CHAIN | PARALLEL, kind: SERVICE | MCP | LLM | RULE | HUMAN,
  status: PENDING | QUEUED | RUNNING | WAITING | DONE | SKIPPED | FAILED,
                                        // QUEUED = prête, attend un créneau LLM ; WAITING = attend le conseiller
  dependsOn: [stepId…],                 // ce dont l'étape a besoin : l'orchestrateur la lance dès que c'est prêt
  startedAt?, endedAt?, summary?, result?,
  calls: [{ method, url, status, via: REST | MCP | LLM }]
}
```

Endpoints (en plus du POST et du GET) :
- `POST /underwriting-cases/{caseId}/data-review` `{confirmed: true, corrections: {declaredHeadcount?}, comment}`
  → **200** `Case` ; **409** `{code: NOT_EXPECTED}` si `pendingAction != DATA_REVIEW`.
- `POST /underwriting-cases/{caseId}/advisor-decision`
  `{finalDecision, surchargePercent?, comment, acknowledgedReasons?: [code]}` → **200** `Case` (`status: DECIDED`) ;
  en `REINFORCED`, **chaque raison doit être reconnue** (`acknowledgedReasons` = tous les `code`) et le commentaire
  est obligatoire, sinon 400 `REASONS_NOT_ACKNOWLEDGED` ou `COMMENT_REQUIRED` ; `followsRecommendation`
  est **calculé par le serveur** ; `comment` est **obligatoire** quand la décision diffère de la suggestion
  (400 `COMMENT_REQUIRED` sinon) ; **409** si `pendingAction != DECISION`.

### Les 13 étapes et qui décide

| Phase | Mode | stepId | kind | Ce qui se passe |
|---|---|---|---|---|
| 1 | CHAIN | `checkAccount` | SERVICE | Customer accounts |
| 2 | PARALLEL | `companyIdentity` | SERVICE | Sirene |
| 2 | PARALLEL | `legalEvents` | SERVICE | BODACC |
| 2 | PARALLEL | `financials` | SERVICE | Company financials |
| 2 | PARALLEL | `openItems` | SERVICE | Claims and contracts |
| 2 | PARALLEL | `geoRisks` | MCP | Microcks MCP → Georisques (après `companyIdentity`) |
| 2 | CHAIN | `dataQuality` | LLM | agent `data-quality` : **contrôle la collecte** (CRM vs Sirene vs bilan) **avant** que le conseiller ne la valide |
| 3 | CHAIN | `dataReview` | HUMAN | **Le conseiller valide (ou corrige) les données collectées**, avec les alertes de `dataQuality` : `WAITING` jusqu'au POST `data-review` |
| 4 | PARALLEL | `climateRisk` | LLM | agent `climate-risk` |
| 4 | PARALLEL | `financialHealth` | LLM | agent `financial-health` |
| 4 | PARALLEL | `openItemsReview` | LLM | agent `open-items` |
| 5 | CHAIN | `synthesis` | LLM (ou RULE) | agent `verdict` : **suggestion consultative** (remplace l'ancien `verdict`) |
| 6 | CHAIN | `advisorDecision` | HUMAN | **Le conseiller décide** : `WAITING` jusqu'au POST `advisor-decision` |

**L'orchestrateur décide de l'ordre d'après les dépendances (`dependsOn`), pas par phases bloquantes.** La
validation humaine ne gèle pas tout le dossier : elle **bloque un agent précis** (`financialHealth`) pendant que
les autres analyses avancent. `status` vaut `IN_PROGRESS` tant qu'une étape tourne ou attend son tour,
`WAITING_ADVISOR` quand plus rien n'avance sans le conseiller ; `pendingAction` signale l'action humaine attendue
**dès qu'elle est possible**, même si d'autres étapes tournent encore.



| stepId | dependsOn |
|---|---|
| `companyIdentity`, `legalEvents`, `financials`, `openItems` | `checkAccount` |
| `geoRisks` | `companyIdentity` |
| `dataQuality` | `checkAccount`, `companyIdentity`, `financials` (démarre **pendant** que `geoRisks` tourne encore) |
| `dataReview` | les 5 étapes de collecte + `dataQuality` |
| `climateRisk` | `geoRisks`, `dataQuality` (**n'attend pas le conseiller**) |
| `financialHealth` | `financials`, `legalEvents`, **`dataReview`** : **cet agent ne démarre pas tant que le conseiller n'a pas validé le dossier** (données financières sensibles) |
| `openItemsReview` | `openItems`, `dataQuality` (**n'attend pas le conseiller**) |
| `synthesis` | les 3 analyses + `dataReview` |
| `advisorDecision` | `synthesis` |

- **Créneaux LLM limités** (`Llm:MaxConcurrency`, 2 par défaut, comme un vrai quota) : une étape LLM prête passe
  `QUEUED` jusqu'à ce qu'un créneau se libère. Priorité : `climateRisk`, puis `financialHealth`, puis
  `openItemsReview`. Les analyses ne tournent donc **pas toutes en même temps** : on voit la file d'attente.
- Le numéro de `phase` ne sert qu'à regrouper l'affichage ; la vérité, ce sont `dependsOn`, `startedAt`, `endedAt`.

Règles de l'orchestrateur :
- `checkAccount` en 404 → phases 2 à 5 `SKIPPED`, suggestion `NOT_ELIGIBLE` (`RULE`), puis **`advisorDecision`
  WAITING** : même un refus d'office est confirmé par le conseiller.
- `legalEvents` contient une procédure collective → `dataReview` reste demandé (le conseiller voit l'annonce),
  puis phase 4 `SKIPPED`, `synthesis` en `RULE` → `REFUSE`, puis `advisorDecision` WAITING (**aucun LLM appelé**).
- Sinon : `dataReview` → phase 4 en parallèle → `synthesis` → `advisorDecision`.
- **Délais longs et aléatoires, portés par Microcks** (et non par un `Task.Delay` dans l'orchestrateur) : chaque
  opération mockée déclare sa latence dans son contrat, `x-microcks-operation: {delay, delayStrategy}`. Les
  stratégies de Microcks sont `fixed`, `random` (de 0 à `delay`) et `random-XX` (`delay` ± XX %). Valeurs :
  API de l'État et internes `delay: 6000, delayStrategy: random-80` (1 à 11 s), BODACC `delay: 20000,
  delayStrategy: random-50` (10 à 30 s), **Company financials `delay: 45000, delayStrategy: random-33`
  (30 à 60 s)**, LLM `delay: 12000, delayStrategy: random-50` (6 à 18 s). **Certains appels durent jusqu'à
  60 s** : en plus du bilan, l'agent `financial-health` est ralenti **par requête** — l'orchestrateur lui envoie
  `x-microcks-delay: 50000` et `x-microcks-delay-strategy: random-20` (40 à 60 s), ce qui montre les deux
  mécanismes de Microcks (contrat et header).
- **Démarrages décalés** : l'orchestrateur ne lance pas tout à la même milliseconde. Une étape prête attend un
  décalage aléatoire `Orchestration:StartJitterMilliseconds:{Min,Max}` = 300–5000 avant de partir (elle reste
  `PENDING` pendant ce temps) : les appels parallèles démarrent en ordre dispersé. L'orchestrateur peut **surcharger** la latence par requête avec les headers
  `x-microcks-delay` / `x-microcks-delay-strategy` (config `Demo:MicrocksDelayOverride`, vide par défaut).
  Les délais artificiels de l'orchestrateur passent à 0 par défaut (ils restent configurables pour de vraies API).
  Si le MCP ne prend pas en compte le délai de l'opération, l'agent contrats le note dans « Constaté ». Un dossier
  met environ 30 à 40 s jusqu'à la validation des données, puis 25 à 35 s jusqu'à la décision.
- Toutes les URL des dépendances sont en configuration (`appsettings.json`), pour pointer Microcks ou de vraies API.

### Décision renforcée : « risque trop important pour N raisons »

Avant `advisorDecision`, l'orchestrateur (règle déterministe, pas un LLM) relève les **raisons de risque** :

| code | Quand | stepId |
|---|---|---|
| `UNKNOWN_CUSTOMER` | compte client introuvable | `checkAccount` |
| `COLLECTIVE_PROCEDURE` | procédure collective au BODACC | `legalEvents` |
| `CLIMATE_HIGH` | `climateRisk.level` HIGH ou VERY_HIGH | `climateRisk` |
| `FINANCIAL_FRAGILE` | `financialHealth.level` FRAGILE ou CRITICAL | `financialHealth` |
| `OPEN_LITIGATION` | un sinistre ouvert en contentieux | `openItems` |
| `DATA_INCONSISTENT` | `dataQuality.status` WARNINGS/INVALID, ou effectif corrigé par le conseiller | `dataQuality` |

`escalation.level` = **`REINFORCED`** dès **2 raisons**, ou dès qu'il y a `COLLECTIVE_PROCEDURE` ou
`UNKNOWN_CUSTOMER` ; sinon `STANDARD`. Attendu : 100000001 → STANDARD (1 raison : climat) ; 100000002 →
STANDARD (0) ; 100000003 → REINFORCED (procédure collective) ; 100000004 → REINFORCED (4 raisons : finances,
contentieux, données, + argiles fort si l'agent climat le classe HIGH) ; 999999999 → REINFORCED (client inconnu).
En `REINFORCED`, l'IHM affiche « **Décision humaine requise — risque trop important pour N raisons** », la
liste des raisons à reconnaître une à une, et **masque la suggestion** derrière « Voir l'éclairage des analyses ».

## Le mock de l'orchestrateur dans Microcks (feature flip)

Le mock doit **se comporter comme l'orchestrateur, au temps près** (dispatcher `SCRIPT` + store Microcks) :
- `POST /underwriting-cases` : `caseId` = `case-<siren>` ; enregistre dans le store l'heure de départ et des
  durées **tirées au hasard** dans les mêmes fourchettes que l'orchestrateur, et remet le dossier à zéro.
- `GET /underwriting-cases/{caseId}` : choisit l'instantané d'après le **temps écoulé** (et non le nombre de
  GET) : phase 1 en cours → phase 2 en cours → `WAITING_ADVISOR/DATA_REVIEW` (y reste tant que la validation
  n'est pas postée) → phase 4 en cours → `synthesis` en cours → `WAITING_ADVISOR/DECISION` → `DECIDED` après
  la décision. Les exceptions 999999999 et 100000003 suivent les règles ci-dessus.
- `POST …/data-review` et `POST …/advisor-decision` : enregistrent l'heure dans le store et renvoient le dossier ;
  409 hors de l'étape attendue.
- Si le script n'a pas accès à l'heure, l'agent contrats le signale et propose l'alternative la plus proche.

## Arazzo : vérifier que l'orchestrateur fait le parcours

`contracts/underwriting.arazzo.yaml` (`info.title: Commercial underwriting`, source `underwritingApi` →
`underwriting-cases.openapi.yaml`) et son overlay `contracts/underwriting.arazzo-sources.yaml`
(`kind: ArazzoSources`, lien vers `Underwriting cases` 1.0.0, exemples nommés par SIREN).

Workflows (sous-ensemble supporté : sources openapi, critères simple/regex, actions `retry`/`end` seulement).
L'attente se fait par `retry` (toutes les 2 s, jusqu'à 150 fois, soit 300 s) **tant que l'action attendue n'est pas
encore là** (`pendingAction != 'DATA_REVIEW'`, puis `pendingAction != 'DECISION'`). Au moment de `DATA_REVIEW`,
le workflow vérifie que `financialHealth` est `PENDING` (**pas démarré sans le conseiller**) alors que
`climateRisk` peut déjà tourner ou être fini. Le
workflow **joue aussi le rôle du conseiller** (il poste la validation et la décision) : Arazzo vérifie que
l'orchestrateur **s'arrête et attend l'humain** aux bons endroits.
- `advisorValidatesThenDecides` : POST → attend `pendingAction == 'DATA_REVIEW'` (phase 2 DONE, `geoRisks` via
  MCP, aucune étape LLM commencée) → POST data-review → attend `pendingAction == 'DECISION'` (4 analyses et
  `synthesis` DONE, suggestion `source == 'LLM'`) → POST advisor-decision (suit la suggestion) → `DECIDED`.
- `advisorOverridesSuggestion` : même parcours, le conseiller ne suit pas la suggestion → commentaire exigé,
  `followsRecommendation == false`.
- `decisionWithoutCommentIsRefused` : le conseiller s'écarte de la suggestion sans commentaire → 400.
- `noDecisionBeforeDataReview` : POST advisor-decision pendant `DATA_REVIEW` → 409.
- `unknownCustomerNeedsNoAnalysis` : 999999999 → `pendingAction == 'DECISION'` direct, phases 2 à 5 SKIPPED,
  suggestion `NOT_ELIGIBLE` en `RULE` → le conseiller confirme.
- `highRiskRequiresReinforcedDecision` : 100000004 → `escalation.level == 'REINFORCED'`, décision sans
  `acknowledgedReasons` → 400 `REASONS_NOT_ACKNOWLEDGED`, puis avec toutes les raisons + commentaire → `DECIDED`.
- `collectiveProcedureSkipsAnalyses` : 100000003 → validation des données → 4 analyses SKIPPED, `synthesis` en
  `RULE` (`REFUSE`) → décision du conseiller.

Les mêmes workflows tournent **contre l'orchestrateur réel** (cible implémentation `http://localhost:5180`) et
**contre le mock Microcks de l'orchestrateur** (cible mocks).

## L'IHM (port 5190)

- Hôte ASP.NET minimal : sert `wwwroot/` et un BFF :
  `/bff/orchestrator/{**path}` → `http://localhost:5180/{path}` ;
  `/bff/microcks/{**path}` → `http://localhost:8080/rest/Underwriting+cases/1.0.0/{path}`.
- **Feature flip** dans l'en-tête : « Orchestrateur .NET ⇄ Microcks (mock) », mémorisé en `localStorage`,
  avec un badge qui dit toujours quel backend a répondu.
- **Le conseiller au cœur** : c'est son poste de travail, pas une vitrine IA.
  - Choix de l'entreprise (les 5 SIREN, ou saisie libre) → « Ouvrir le dossier ». **Changer d'entreprise efface
    immédiatement le dossier affiché** (étapes, données, suggestion, schéma) et arrête le suivi du précédent.
  - Le pipeline en 6 phases montre les **deux points de contrôle humains** comme des étapes à part entière,
    mises en avant (icône personne, couleur dédiée) : ce sont eux qui font avancer le dossier.
  - **Validation des données** (`dataReview`) : une carte qui récapitule ce qui a été collecté (identité Sirene,
    effectif INSEE vs déclaré, bilan, annonces BODACC, sinistres ouverts, risques naturels) ; le conseiller
    confirme, corrige l'effectif déclaré s'il le faut, et commente.
  - **Décision** (`advisorDecision`) : le conseiller **choisit lui-même** la décision (pas de pré-remplissage),
    avec la surprime ; la suggestion des analyses est affichée **à côté**, en retrait, libellée
    « Éclairage des analyses — consultatif » (source LLM ou règle, confiance, justification). S'écarter de la
    suggestion exige un commentaire. Après validation : « Décision du conseiller enregistrée ».
  - Vocabulaire : « analyses », « éclairage », « suggestion » ; jamais « avis de l'IA » ni « verdict ».
  - **Onglets du dossier** (la « Vue 360 » existante reste l'onglet d'accueil, elle montre bien l'ensemble) :
    « Vue 360 », « Entreprise » (identité, effectifs, adresse + carte), « Risques » (carte + Géorisques +
    analyse climat), « Finances » (bilan + santé financière), « Sinistres & contrats », « Parcours »
    (couloirs dans le temps, avec les **flèches de dépendance** et la file d'attente LLM), « Tableau » (kanban),
    « Journal des appels ».
  - **Cartes de localisation fictives** : SVG dessiné par l'IHM, illustratif (pas de tuiles ni de service
    externe), libellé « Carte illustrative » : silhouette du lieu (littoral pour La Rochelle, fleuve pour Avignon,
    agglomération pour Lille et Clermont), punaise de l'entreprise, et zones de risque superposées d'après
    `geoRisks` (submersion, inondation, argiles, feux de forêt) avec une légende.
  - La collecte doit montrer que **`dataQuality` contrôle les données collectées** : flèches des étapes de
    collecte vers `dataQuality`, puis de `dataQuality` vers la validation du conseiller, avec ses alertes
    reprises dans la carte de validation.
- **Mode « Comprendre » synchronisé sur le direct** : le schéma n'est pas un rejeu après coup. À chaque poll
  (≤ 500 ms), une étape qui passe RUNNING lance son paquet de requête **et** met la cible en attente (pulsation)
  tant qu'elle travaille ; quand elle passe DONE, FAILED ou SKIPPED, le paquet de réponse revient. Les étapes
  parallèles partent ensemble, la légende suit la phase en cours, et le rejeu reste possible une fois le dossier fini.
  Il montre aussi les deux allers-retours du conseiller (IHM → orchestrateur).
- **Mode « Comprendre »** (interrupteur dans l'en-tête, comme la démo pilotée Arazzo) : sous le pipeline, un
  schéma animé montre **qui appelle qui** pendant le dossier. Le cadre « Microcks » contient les mocks des API
  (État, internes), le LLM mocké et le serveur MCP ; en dehors : l'IHM, l'orchestrateur .NET (ou, en mode flip,
  Microcks qui le remplace, dans le cadre). Des paquets circulent au fil des `calls` de chaque étape (bleu =
  requête, vert = OK, rouge = erreur, violet = MCP, orange = LLM), les appels parallèles partent en même temps, et
  une légende raconte chaque étape (« Phase 2 — 5 appels en parallèle… », « L'agent climat découvre ses outils
  via MCP… », « Procédure collective : l'orchestrateur coupe court, aucun LLM appelé »). Boutons Rejouer et
  vitesse ×0,5/×1/×2. Point de départ réutilisable : la classe `FlowDiagram` de
  `/private/tmp/claude-501/-Users-sebastiendegodez-Documents-source-nosync-microcks/56d5fa27-6a63-480b-bf8d-222788c8bf7b/scratchpad/demo/cockpit/index.html`
  (cadre Microcks, paquets, courbes, légende) — à copier et adapter, pas à référencer.
- Design **inspiré** d'un design system d'assureur (bleu profond `#00008F`, rouge d'accent `#FF1721` utilisé
  avec parcimonie, fonds gris clair, titres en serif, corps en sans-serif) ; **ni logo ni nom de marque réelle** :
  la marque de démo est « Souscription Pro ».

## Constaté (rempli par les agents)

> Les puces ci-dessous datent de la v1 (11 étapes, statut `DONE`). Chaque agent les remet à jour pour la v2.

- _MCP natif de Microcks (agent contrats, v2) :_ toujours disponible sur `http://localhost:8080/mcp/Georisques/1.0.0`
  (Streamable HTTP en JSON simple, **sans session** : `initialize` facultatif). La démo passe désormais par
  **reShapr** (puce suivante) ; même outil, mêmes arguments.
  - `tools/list` → un seul outil **`get_resultats_rapport_risque`**, `inputSchema` =
    `{type: object, properties: {code_insee: string, latlon: string}, required: [code_insee, latlon], additionalProperties: false}`.
  - `tools/call` : `{"name":"get_resultats_rapport_risque","arguments":{"code_insee":"17300","latlon":"-1.1520,46.1591"}}`
    (`latlon` = `"<lon>,<lat>"`, le mock ne dispatche que sur `code_insee`) → `result.content[0].text` = la
    **chaîne JSON** du corps REST, `result.isError == false`.
  - **Délai** : `tools/call` applique bien le délai de l'opération du contrat (mesuré 2 à 10 s pour
    `delay: 6000, random-80`) ; `tools/list` répond tout de suite.
  - Bug Microcks contourné : avec un dispatcher `URI_PARAMS`, `tools/call` ne trouve aucun exemple (la query string
    est ajoutée deux fois au calcul du critère : `BasicHttpServletRequest.getRequestURL()` la contient déjà et
    `RestInvocationProcessor` la rajoute). Géorisques utilise donc un dispatcher `SCRIPT` sur
    `getParameter("code_insee")`, qui marche en REST comme en MCP (et derrière reShapr).
- _MCP reShapr (variante, agent reShapr) :_ reShapr **1.1.0** sert le MCP ; **Microcks simule Géorisques derrière
  lui** (backend `http://host.docker.internal:8080/rest/Georisques/1.0.0`, vu depuis les conteneurs). Démarrage
  `scripts/start-reshapr.sh` (plateforme Docker + `reshapr login` + `reshapr import` idempotent : Service, Plan et
  Exposition `default` réutilisés), arrêt `scripts/stop-reshapr.sh` (`--purge` efface la base). CLI installée dans
  `tools/reshapr/` (pas d'installation globale). Conteneurs `reshapr-postgres`, `reshapr-control-plane` (5555),
  `reshapr-gateway-01`.
  - **URL MCP : `http://localhost:7778/mcp/reshapr/georisques-1-0-0-default`** (le slug est en minuscules, points
    remplacés par des tirets ; alias `http://localhost:7778/mcp/<expositionId>`). **Port 7778 et non 7777** : sur ce
    poste `127.0.0.1:7777` est déjà pris par un autre outil local ; le compose de reShapr est lancé avec
    `tools/reshapr/docker-compose.demo.yml` par-dessus (port publié via `RESHAPR_MCP_PORT`), car `reshapr run` ne
    sait pas changer de port. → **`Mcp:Georisques:Endpoint` = `http://localhost:7778/mcp/reshapr/georisques-1-0-0-default`**.
  - Transport Streamable HTTP, réponses **`application/json`** (pas de SSE constaté, même avec
    `Accept: application/json, text/event-stream`), HTTP 200 y compris pour les erreurs JSON-RPC.
  - **Session obligatoire** (différence avec Microcks) : `initialize` (`protocolVersion` `2025-06-18`) renvoie
    l'en-tête **`MCP-Session-Id`** ; tous les appels suivants doivent porter `Mcp-Session-Id` et
    `MCP-Protocol-Version: 2025-06-18`. Sans session → `error.code -32600` « Missing MCP session » (seul le mode
    sans état `2026-07-28` s'en passe). `notifications/initialized` → `error -32601` « Unsupported method »
    (comme Microcks, sans effet). Aucune authentification sur l'endpoint (pas de `--apiKey`).
  - `tools/list` → un seul outil, **même nom et même `inputSchema` que Microcks** : `get_resultats_rapport_risque`,
    `{type: object, properties: {code_insee: string, latlon: string}, required: [code_insee, latlon], additionalProperties: false}`
    (les descriptions viennent du contrat). `serverInfo` = `{name: "Georisques MCP server", version: "1.0.0"}`.
  - `tools/call` : mêmes arguments (`{"code_insee":"17300","latlon":"-1.1520,46.1591"}`, `latlon` = `"<lon>,<lat>"`).
    reShapr fait `GET <backend>/resultats_rapport_risque?latlon=-1.1520%2C46.1591&code_insee=17300` (chemin bien
    concaténé). Réponse identique à Microcks : `result.content[0].type == "text"`, `text` = **la chaîne JSON** du
    corps REST, `result.isError == false`. Si Microcks répond une erreur, `isError: true` et `text` = le corps
    d'erreur brut (ex. « The response unknown does not exist! »).
  - Constaté pour 17300, 63113, 59350, 84007 : 4 × 200 `isError: false` (La Rochelle, Clermont-Ferrand, Lille,
    Avignon), en 1,7 à 8,9 s ; côté Microcks, 4 `Servicing mock response for service [Georisques, 1.0.0] on uri
    /rest/Georisques/1.0.0/resultats_rapport_risque with verb GET` dans le log et `dailyCount` des métriques +4.
  - **Délais** : reShapr **transmet les en-têtes** du client au backend (dont `x-microcks-delay`), donc
    `Demo:MicrocksDelayOverride` s'applique à Géorisques via reShapr (constaté : `x-microcks-delay: 0` → 10 ms),
    alors que le MCP natif de Microcks les ignore. Le délai du contrat (6 s, `random-80`) dépasse le timeout backend
    par défaut de reShapr (3 s) : le compose de démo le monte à 15 s
    (`RESHAPR_GATEWAY_BACKEND_HTTP_DEFAULT_TIMEOUT`).
  - Pour l'IHM : les `calls[].url` de `geoRisks` pointent vers `localhost:7778` (reShapr, hors du cadre Microcks) ;
    l'appel REST réel vers le mock Géorisques est fait par reShapr et n'apparaît pas dans les `calls` de
    l'orchestrateur.
- _Contrats et mocks (agent contrats), v3 + plan .NET :_ tous les fichiers de `contracts/` sont **générés** par
  `scripts/generate-contracts.py` (source unique du tableau des 5 entreprises), importés par
  `scripts/import-contracts.sh` (idempotent), vérifiés par `scripts/verify-mocks.sh` (toutes les API, le MCP et le
  parcours complet du mock de l'orchestrateur pour les 5 SIREN, 87 contrôles, environ 2 min 30 à 4 min) et `scripts/run-arazzo.sh` (les
  9 exemples des 7 workflows, cible mocks, `validateSchema: true`, en 3 vagues, environ 7 min).
  - **Délais dans les contrats** (`x-microcks-operation`) : Customer accounts, Sirene, Georisques, Claims and
    contracts `6000 / random-80` ; BODACC `20000 / random-50` ; Company financials `45000 / random-33` ; LLM
    `12000 / random-50`. Le mock de l'orchestrateur n'a pas de délai (il est temporel). Les headers
    `x-microcks-delay` / `x-microcks-delay-strategy` surchargent bien le contrat (mesuré : `200 / fixed` → 0,2 s).
    Un LLM appelé avec un agent ou un SIREN sans exemple répond **400** au format d'erreur OpenAI (exemple `unsupported`).
  - **Mock temporel de l'orchestrateur** : un dispatcher `SCRIPT` Groovy **a accès à l'heure**
    (`System.currentTimeMillis()`) et à `java.util.Random` (pas de sandbox). Le POST tire les durées (mêmes
    fourchettes que Microcks ; `financialHealth` 40 à 60 s comme le header `50000 / random-20` ; `synthesis` en
    `RULE` 0,5 à 1,2 s) et un décalage de démarrage de 0,3 à 5 s par étape, et les garde dans le store **avec un TTL
    de 2 h** (le TTL par défaut du store est de **10 s**). Chaque GET recalcule le `Case` : `dependsOn`, 2 créneaux
    LLM avec la priorité `dataQuality`, `climateRisk`, `financialHealth`, `openItemsReview`, `synthesis` (`QUEUED`
    quand le créneau manque), `PENDING` pendant le décalage. Le `Case` est rendu par **templating** : le script pose
    `requestContext.caseJson` et l'exemple de réponse vaut `{{ caseJson }}` (les horodatages sont donc réels).
  - Un dossier dure 2 à 3 min dans le mock, comme dans l'orchestrateur (`DATA_REVIEW` vers 55 à 80 s, `DECISION`
    vers 130 à 150 s après le POST, avec une validation immédiate). `pendingAction` est **toujours présent**
    (`null` hors attente) ; `status` passe `WAITING_ADVISOR` seulement quand plus rien n'avance (constaté : à
    `DATA_REVIEW`, souvent `IN_PROGRESS` car `climateRisk` / `openItemsReview` tournent).
  - **Écarts et précisions à reprendre dans l'orchestrateur .NET** :
    - Pour `100000003` (procédure collective), le mock met **`dataQuality` en SKIPPED** dès que BODACC répond, avec
      `climateRisk` et `openItemsReview` (« aucun LLM appelé », et il n'y a pas d'exemple LLM pour ce SIREN) ;
      `financialHealth` passe SKIPPED à la validation des données. Le tableau `dependsOn` ne fait pas dépendre
      `dataQuality` de `legalEvents` : l'orchestrateur doit l'attendre ou la sauter de la même façon.
    - **v3** : 12 étapes, plus de `geoRisks`. `climateRisk` dépend de `companyIdentity` et `dataQuality` ; sa durée
      dans le mock = LLM + service + LLM (12 à 46 s), et elle occupe un créneau LLM pendant toute la boucle. Ses
      `calls`, dans l'ordre : `POST <reShapr>` MCP (`tools/list`), `POST <LLM gateway>` LLM, `POST <reShapr>` MCP
      (`tools/call`), `POST <LLM gateway>` LLM, avec `<reShapr>` =
      `http://localhost:7778/mcp/reshapr/georisques-1-0-0-default`. `climateRisk.result` = la sortie de l'agent +
      `naturalRisks` (le corps Géorisques, ex. `naturalRisks.commune == "La Rochelle"`).
    - **LLM gateway v3** : pour `metadata.agent == 'climate-risk'`, tant que `messages` ne contient aucun
      `role: tool`, la réponse est l'exemple `climate-risk-<siren>-tool-call` : `finish_reason: tool_calls`,
      `message.content: null`, `message.tool_calls[0] = {id: "call_georisques_<siren>", type: "function",
      function: {name: "get_resultats_rapport_risque", arguments: "{\"code_insee\":\"17300\",\"latlon\":\"-1.1520,46.1591\"}"}}`
      (`latlon` à 4 décimales). Avec un message `role: tool`, la réponse finale `climate-risk-<siren>`. Le délai LLM
      s'applique aux deux tours. Le schéma accepte `tools`, `tool_calls`, `tool_call_id` et `role: tool` ; le
      contenu du message `tool` n'est pas lu par le mock.
    - Les SIREN inconnus (9 chiffres) suivent le cas `999999999` avec leur propre `caseId` ; un SIREN invalide →
      400 `INVALID_SIREN` ; un `caseId` sans dossier (jamais posté, ou expiré après 2 h) → 404 `CASE_NOT_FOUND`.
    - `advisor-decision` : contrôles dans l'ordre 409 `NOT_EXPECTED` → 400 `INVALID_DECISION` (décision hors enum)
      → en `REINFORCED`, 400 `REASONS_NOT_ACKNOWLEDGED` puis 400 `COMMENT_REQUIRED` → hors suggestion sans
      commentaire, 400 `COMMENT_REQUIRED`. `surchargePercent` absent = la surprime suggérée si la décision est celle
      de la suggestion, 0 sinon ; `followsRecommendation` = même décision **et** même surprime. `advisorDecision`
      recopie `acknowledgedReasons` (champ ajouté au schéma). `data-review` : une correction de
      `declaredHeadcount` ajoute la raison `DATA_INCONSISTENT` si elle n'y est pas.
    - `escalation` et `recommendation` sont présents dès `pendingAction == DECISION`. Raisons constatées : 100000001
      `CLIMATE_HIGH` (STANDARD) ; 100000002 aucune (STANDARD) ; 100000003 `COLLECTIVE_PROCEDURE` ; 100000004
      `CLIMATE_HIGH`, `FINANCIAL_FRAGILE`, `OPEN_LITIGATION`, `DATA_INCONSISTENT` ; 999999999 `UNKNOWN_CUSTOMER`
      (les trois en REINFORCED). Ordre : celui du tableau des codes.
    - Schéma : `pendingAction` est `nullable` **avec `null` dans l'`enum`** ; sans cela, la validation de schéma
      d'Arazzo refuse `null` (constaté).
  - **Arazzo** : l'attente se fait par `retry` toutes les 2 s, 150 fois au plus, avec le critère
    `$response.body#/pendingAction != 'DATA_REVIEW'` (puis `!= 'DECISION'`) ; **la comparaison avec `null`
    fonctionne** (constaté sur le mock). À `DATA_REVIEW`, le workflow vérifie les 4 étapes de collecte DONE,
    `dataQuality` DONE (SKIPPED pour 100000003), `dataReview` WAITING et `financialHealth`, `synthesis`,
    `advisorDecision` PENDING. Le POST `data-review` envoie `{confirmed: true, corrections: {}, comment}`. Exemples
    de l'overlay nommés `siren-<SIREN>`. Les remplacements de payload acceptent un nombre
    (`surchargePercent`) et un tableau (`acknowledgedReasons`) venant des `inputs` ou des `outputs`. À `DECISION`
    (workflows avec analyses LLM), il vérifie `climateRisk.calls[0..3].via == MCP, LLM, MCP, LLM`. Constaté v3 :
    9 exemples sur 9 en `SUCCESS` / `MATCHES` contre le mock.
  - Le mock partage un seul dossier par SIREN (`case-<siren>`) : un POST depuis l'IHM en mode mock pendant un run
    Arazzo ou `verify-mocks.sh` sur le même SIREN relance le dossier (constaté une fois, le test a tout de même
    abouti).
  - **Plan .NET (sessions S15 à S17, `dependsOn` S30, Arazzo 1.1)** : `underwriting.arazzo.yaml` passe en
    `arazzo: 1.1.0`, avec 6 sources (`underwritingApi` + `customerAccounts`, `sirene`, `bodacc`,
    `companyFinancials`, `claimsAndContracts`, **sans** `llmGateway`). Avec plusieurs sources, Microcks refuse un
    `operationId` non qualifié (« Ambiguous operationId createUnderwritingCase ») : **tous les `operationId` sont
    qualifiés**, `$sourceDescriptions.<source>.<operationId>`. Deux workflows consommateurs s'ajoutent :
    `orchestratorCollectsCompanyData` (`checkAccount`, puis `companyIdentity`, `legalEvents`, `financials`,
    `openItems` avec `dependsOn: [checkAccount]` ; `openItems.customerId` ← `$steps.checkAccount.outputs.customerId`)
    et `customerUnknownStopsTheCase`. Le nouveau document `underwriting-guards.arazzo.yaml` (« Commercial
    underwriting guards » 1.0.0, Arazzo 1.1.0) lie les 5 API **et `LLM gateway`**, avec le workflow
    `collectiveProcedureStopsTheAnalyses` (les 5 mêmes étapes). Overlays : exemples `siren-100000002`
    (`customerId: C-1002`), `siren-999999999` (`steps.checkAccount.status: 404`) et `siren-100000003` pour les
    gardes. `import-contracts.sh` importe les deux nouveaux fichiers ; `run-arazzo.sh` ajoute une 4ᵉ vague (les
    workflows consommateurs joués sur les mocks, `timeout: 70000` par étape).
  - Noms d'exemples cités par le plan, présents : `siren-100000003` sur `searchAnnonces` (BODACC),
    `unknown-999999999` sur `getCustomerBySiren` (CRM). `operationId` du LLM : **`createChatCompletion`**.
  - Constaté en session sur la stack reconstruite : session verte sur `orchestratorCollectsCompanyData` avec la
    phase 2 reçue dans le désordre ; S16 : `GET /customers/100000002/open-items` répond 200 (corps avec
    `customerId: 100000002`) et la vérification dit `` `openItems` path `customerId` should come from
    `$steps.checkAccount.outputs.customerId` (C-1002), got 100000002`` ; S17 `failures: {checkAccount:
    unknown-999999999}` → CRM 404, et un appel Sirene ensuite → ``unexpected call `getUniteLegale` after
    `checkAccount` `` ; gardes avec `failures: {legalEvents: siren-100000003}` → annonces de procédure collective,
    et un appel LLM → ``unexpected call `createChatCompletion` after `legalEvents` ``.
  - **Point 9.7 (S16 avec un SIREN inconnu)** : les dispatchers sont `URI_PARTS` (CRM, Sirene, bilans, sinistres)
    et `URI_PARAMS` (BODACC), **sans `fallback`**, et chaque exemple porte la valeur dans sa requête et sa réponse,
    **sauf le BODACC**, dont la réponse (`{total, records}`) ne contient pas le SIREN : rien n'y est reflété, et
    l'orchestrateur ne peut pas vérifier le SIREN des annonces (point 9.4). Attention : le « premier exemple de
    succès » suit **l'ordre de stockage de Microcks, pas celui du YAML**, et il change d'un import à l'autre
    (constaté : CRM → `siren-100000003`, donc `C-1003` Transports Express Nord ; Sirene → Boulangerie ; BODACC →
    `siren-100000004` ; bilans → `siren-100000001` ; sinistres → `customer-C-1004`). Un dossier pour `123456789`
    mélange donc plusieurs entreprises ; la vérification reste verte (le `customerId` rendu par le CRM est bien
    celui attendu par `openItems`). Pour une option scénique cohérente, il faudrait un `fallback` vers
    `siren-100000002` sur ces dispatchers, mais il changerait aussi le comportement hors session (tout SIREN inconnu
    deviendrait un client connu) : non fait, à décider.
- _Orchestrateur .NET (agent orchestrateur), v2 :_ `orchestrator/`, `dotnet run` sur 5180, log `.run/logs/orchestrator.log`.
  - `caseId` = **`case-<siren>`** (comme le mock et les exemples Arazzo) : un seul dossier vivant par SIREN, un
    nouveau POST remplace le précédent. Un SIREN qui n'a pas 9 chiffres → 400 `INVALID_SIREN`.
  - **Ordonnancement par `dependsOn`** (déclaré une seule fois dans `StepCatalog`, exposé dans chaque Step et utilisé
    tel quel par le workflow). `status` est **dérivé** à chaque changement : `WAITING_ADVISOR` quand toutes les étapes
    automatiques non terminées dépendent (transitivement) d'une étape HUMAN non validée, sinon `IN_PROGRESS`.
    `pendingAction` est **toujours présent** (`null` sinon) et posé dès que l'action est possible.
  - **Démarrage décalé** `Orchestration:StartJitterMilliseconds` 300–5000 (l'étape reste `PENDING`), puis pour un LLM
    **file `Llm:MaxConcurrency` = 2 par dossier** (pas globale, pour que chaque dossier montre sa file), priorité
    `dataQuality` > `climateRisk` > `financialHealth` > `openItemsReview` > `synthesis` ; `startedAt` = passage à
    `RUNNING` (le temps en file n'est pas compté). Constaté : avec ces `dependsOn`, **la file n'apparaît que si le
    conseiller valide pendant que `climateRisk` et `openItemsReview` tournent** (alors `financialHealth` passe
    `QUEUED`) ; quand on attend `WAITING_ADVISOR` pour valider (comme Arazzo), jamais plus de 2 LLM ne sont prêts à la fois.
  - **Aucun LLM pour une procédure collective** : toute étape LLM attend aussi la réponse BODACC avant d'appeler le
    LLM (garde de règle, hors `dependsOn`) ; `dataQuality`, les 3 analyses sont `SKIPPED`, `synthesis` en `RULE`
    (`REFUSE`, après `dataReview`).
  - **Latence portée par Microcks**, mesurée par `startedAt`/`endedAt` (constaté : `financials` 38–60 s, `legalEvents`
    12–28 s, `financialHealth` 44–54 s, autres LLM 7–17 s). Surcharge par agent `LlmGateway:DelayOverrides`
    (défaut `financial-health` → `x-microcks-delay: 50000`, `random-20`) et globale `Demo:MicrocksDelayOverride`
    (vide). Délais artificiels `Orchestration:{Service,Llm}DelayMilliseconds` à 0. Un dossier complet dure
    ~2 min 30 à 3 min 10 (conseiller instantané), ~60–80 s jusqu'à `DATA_REVIEW`.
  - `advisor-decision` : contrôles dans l'ordre 409 `NOT_EXPECTED` → 400 `INVALID_DECISION` (absente ou hors enum)
    → 400 `REASONS_NOT_ACKNOWLEDGED` (REINFORCED) → 400 `COMMENT_REQUIRED` (REINFORCED, ou décision différente de la
    suggestion). `advisorDecision` recopie `acknowledgedReasons` (`[]` si absent) ; `comment` vaut `""` s'il est
    absent (champ requis par le schéma), de même pour `dataReview.comment`. `surchargePercent` omis = celui de la suggestion si même décision, sinon 0 ; `followsRecommendation`
    = même décision **et** même surprime. `escalation` constatée : 100000001 STANDARD `[CLIMATE_HIGH]`, 100000002
    STANDARD `[]`, 100000003 REINFORCED `[COLLECTIVE_PROCEDURE]`, 100000004 REINFORCED `[CLIMATE_HIGH,
    FINANCIAL_FRAGILE, OPEN_LITIGATION, DATA_INCONSISTENT]`, 999999999 REINFORCED `[UNKNOWN_CUSTOMER]`.
  - **v3 — l'agent climat appelle le MCP** (`Agents/ToolUsingAgent.cs`, boucle générique, `Llm:MaxToolRounds` = 3) :
    `tools/list` sur reShapr → `tools` OpenAI (`type: function`, `parameters` = `inputSchema` MCP) → LLM →
    `tool_calls` exécutés par `tools/call` → message `role: tool` (`tool_call_id`) → LLM → sortie structurée. Plus
    d'étape `geoRisks` (12 étapes). `climateRisk.calls` constaté = MCP, LLM, MCP, LLM (URL reShapr
    `http://localhost:7778/mcp/reshapr/georisques-1-0-0-default`) ; **l'`initialize` de session n'est pas listé dans
    `calls`** (plomberie de transport, pour coller à l'ordre normatif), et `notifications/initialized` n'est plus
    envoyé (reShapr et Microcks le refusaient). `result.naturalRisks` = le rapport renvoyé par l'outil (dernier appel).
    Aucun nom d'outil en dur : le modèle choisit. `Mcp:Georisques:Endpoint` (reShapr par défaut, MCP natif Microcks
    en variante) ; session `Mcp-Session-Id` + `MCP-Protocol-Version` gérées, réponses JSON ou SSE.
  - Une dépendance en erreur met l'étape en `FAILED` (« Échec : … ») sans arrêter le dossier ; un appel injoignable
    est tracé avec `status: 0`. Synthèse LLM indisponible → suggestion `REVIEW` en `source: RULE`.
- _Plan .NET (orchestrateur), relevé le 2026-10-24 sur le code de `orchestrator/` (pour le projet de tests) :_
  - **Aucun retry, aucun appel en double** : pas de `AddStandardResilienceHandler` ni de Polly ; une étape échouée
    passe `FAILED` sans nouvel essai (timeout `HttpClient` 120 s). Chacune des 5 API est appelée **une fois** par
    dossier, le CRM en premier et une seule fois ; `data-review` et `advisor-decision` n'appellent aucune API (seuls
    `financialHealth` et `synthesis`, des LLM, partent après la validation). Seul cas de double : reposter le même
    SIREN dans le même orchestrateur pendant qu'un dossier tourne (`case-<siren>` est remplacé, mais les appels déjà
    lancés de l'ancien dossier vont au bout).
  - **Dépendances** (`Cases/StepCatalog.cs`, exposées dans `steps.*.dependsOn`) : `companyIdentity`, `legalEvents`,
    `financials`, `openItems` ← `checkAccount` seulement (`openItems` reçoit le `customerId` du CRM) ;
    `dataQuality` ← `checkAccount`, `companyIdentity`, `financials` ; `climateRisk` ← `companyIdentity`,
    `dataQuality` ; `openItemsReview` ← `openItems`, `dataQuality` ; `financialHealth` ← `financials`,
    `legalEvents`, `dataReview`. Garde hors `dependsOn` : toute étape LLM attend la réponse BODACC avant d'appeler
    le modèle (conforme au pointillé de 2.2).
  - **Chemins exacts** (base = la valeur de configuration, se termine par `/`) : CRM `customers/by-siren/{siren}`,
    **Sirene `siren/{siren}`** (sans suffixe ni query : `…/rest/Sirene/1.0.0/siren/100000002`), BODACC
    `annonces?siren={siren}`, bilans `companies/{siren}/financials`, sinistres `customers/{customerId}/open-items`,
    LLM `v1/chat/completions` (POST). `operationId` : `getCustomerBySiren`, `getUniteLegale`, `searchAnnonces`,
    `getFinancials`, `getOpenItems`, LLM **`createChatCompletion`**, Géorisques `getRapportRisque` (appelé par
    reShapr, ou par le MCP natif qui n'enregistre pas). Appels LLM d'un dossier normal : **6** (dataQuality,
    climateRisk ×2 avec l'appel d'outil, financialHealth, openItemsReview, synthesis).
  - **Pannes** : CRM 404 (y compris injecté pour un SIREN connu) → le dossier s'arrête après ce seul appel : les 10
    étapes suivantes `SKIPPED`, suggestion `NOT_ELIGIBLE` (`RULE`), `status: WAITING_ADVISOR`,
    `pendingAction: DECISION` (aucun statut `NOT_ELIGIBLE`/`REFUSED` n'existe : `UnderwritingDesk.StoppedStatuses`
    doit se limiter à `DECIDED`, ou se fier à `pendingAction`). Procédure collective → la collecte va au bout (les
    5 appels), `dataQuality`, `climateRisk`, `openItemsReview` `SKIPPED` dès la réponse BODACC, **aucun appel LLM ni
    MCP** ; `status: WAITING_ADVISOR`, `pendingAction: DATA_REVIEW` ; après `data-review`, `financialHealth`
    `SKIPPED`, `synthesis` en `RULE` (`REFUSE`), `pendingAction: DECISION`. Aucune lettre de refus par LLM.
    **Les annonces BODACC ne sont pas rapprochées du SIREN** (les `records` n'en portent pas) : la réponse injectée
    `siren-100000003` est prise telle quelle pour un dossier `100000002` (la détection lit `type`/`nature` :
    collective, redressement, liquidation, sauvegarde).
  - **Clés de configuration réelles** : `Services:{CustomerAccounts,Sirene,Bodacc,CompanyFinancials,ClaimsAndContracts}`,
    `LlmGateway:BaseUrl` (sans `/v1`), `Mcp:Georisques:Endpoint`, `Demo:MicrocksDelayOverride:{Delay,Strategy}` (vide
    par défaut ; `Delay=0` est bien envoyé), `LlmGateway:DelayOverrides:financial-health:{Delay,Strategy}` (défaut
    50000 / `random-20` ; il **l'emporte** sur l'override global, donc le mettre à 0 aussi),
    `Orchestration:StartJitterMilliseconds:{Min,Max}` (défaut 300 / 5000, dans `appsettings.json` et dans le code ;
    `0`/`300` accepté), `Llm:{MaxConcurrency,MaxToolRounds}` (2, 3), `Urls`. Clients typés `CompanyDataApis`,
    `McpClient`, `LlmGatewayClient` : nom de client = nom court du type, donc
    `services.AddHttpClient(nameof(CompanyDataApis)).AddHttpMessageHandler(...)` (Sabotage, 4.9) les atteint.
  - **Propagation de session (4.5) : aucune modification de l'orchestrateur nécessaire, vérifié.** Sonde
    `WebApplicationFactory<Program>` + `IStartupFilter` (`AsyncLocal`) + `ConfigureHttpClientDefaults(...
    AddHttpMessageHandler<SessionHandler>())`, avec un faux amont qui enregistre les en-têtes : dossier `100000002`
    ouvert avec `x-microcks-session: S-1`, `data-review` et décision postés **sans** en-tête → les 15 appels sortants
    (CRM ×1, Sirene ×1, BODACC ×1, bilans ×1, sinistres ×1, LLM ×5, MCP ×2) portent tous `S-1`, y compris après le
    `TaskCompletionSource` du `data-review` et la file LLM. `Program` est bien `public partial` (SDK 10). Hors
    projet de test (console), `WebApplicationFactory` réclame
    `ASPNETCORE_TEST_CONTENTROOT_UNDERWRITINGORCHESTRATOR=<chemin de orchestrator/>` ; un projet de test qui
    référence `Microsoft.AspNetCore.Mvc.Testing` l'obtient par l'attribut généré.

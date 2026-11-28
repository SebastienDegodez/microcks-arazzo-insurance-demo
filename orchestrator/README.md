# Orchestrateur de souscription (`Underwriting cases`)

ASP.NET Core minimal API, .NET 10, port **5180**. Elle implémente `contracts/underwriting-cases.openapi.yaml`.

| Endpoint | Réponse |
|---|---|
| `POST /underwriting-cases` `{siren, product}` | 202 `{caseId: "case-<siren>", status: "IN_PROGRESS"}` |
| `GET /underwriting-cases/{caseId}` | le dossier : `status`, `pendingAction`, `steps` (avec `dependsOn`), `recommendation`, `escalation`… |
| `POST /underwriting-cases/{caseId}/data-review` `{confirmed, corrections: {declaredHeadcount?}, comment}` | 200 le dossier ; 409 `NOT_EXPECTED` hors `DATA_REVIEW` |
| `POST /underwriting-cases/{caseId}/advisor-decision` `{finalDecision, surchargePercent?, comment, acknowledgedReasons?}` | 200 le dossier `DECIDED` ; 400 `REASONS_NOT_ACKNOWLEDGED` ou `COMMENT_REQUIRED` ; 409 `NOT_EXPECTED` hors `DECISION` |

```bash
cd orchestrator && dotnet run
```

Le stockage est en mémoire, avec un seul dossier vivant par SIREN. Le CORS est ouvert.

## Ordonnancement par dépendances, avec le conseiller au cœur

Chaque étape démarre **dès que les étapes de son `dependsOn` sont terminées** : il n'y a pas de phases bloquantes, et le numéro de phase ne sert qu'à l'affichage. Les dépendances sont déclarées dans `Cases/StepCatalog.cs` et exposées dans le JSON. `Underwriting/UnderwritingWorkflow.cs` attend exactement celles-là.

| Étape | Attend |
|---|---|
| `checkAccount` | rien. En cas de 404, tout est `SKIPPED` jusqu'à la décision, et la suggestion est `NOT_ELIGIBLE` (règle). |
| `companyIdentity`, `legalEvents`, `financials`, `openItems` | `checkAccount` |
| `dataQuality` (LLM) | `checkAccount`, `companyIdentity`, `financials` |
| `dataReview` (HUMAN) | les 4 étapes de collecte et `dataQuality` ; le conseiller voit les alertes |
| `climateRisk` (LLM **avec outils MCP**) | `companyIdentity`, `dataQuality`, **pas le conseiller** |
| `openItemsReview` (LLM) | `openItems`, `dataQuality`, **pas le conseiller** |
| `financialHealth` (LLM) | `financials`, `legalEvents` et **`dataReview`** (les données financières sont sensibles) |
| `synthesis` (LLM, ou règle) | les 3 analyses et `dataReview` : une suggestion **consultative** (agent `verdict`) |
| `advisorDecision` (HUMAN) | `synthesis` ; `POST advisor-decision` fait passer le dossier à `DECIDED` |

Le `status` du dossier est recalculé à chaque changement :
- `IN_PROGRESS` tant qu'une étape automatique tourne, est en file ou peut encore partir ;
- `WAITING_ADVISOR` quand toutes les étapes restantes attendent le conseiller.

`pendingAction` (`DATA_REVIEW`, `DECISION` ou `null`) apparaît **dès que** l'action est possible, même si d'autres étapes tournent encore.

Plusieurs mécanismes rendent le déroulé réaliste :
- **Démarrages décalés** : une étape prête attend 0,3 à 5 s avant de partir (`Orchestration:StartJitterMilliseconds`). Elle reste `PENDING` pendant ce temps.
- **File LLM** : au plus 2 appels LLM en même temps par dossier (`Llm:MaxConcurrency`). Au-delà, une étape passe `QUEUED`. La priorité va à `dataQuality`, puis `climateRisk`, `financialHealth`, `openItemsReview` et enfin `synthesis`. La file se voit quand le conseiller valide les données pendant que `climateRisk` et `openItemsReview` tournent : `financialHealth` passe alors `QUEUED`.
- **Procédure collective au BODACC** : aucun LLM n'est appelé. Les étapes LLM sont `SKIPPED` et `synthesis` devient une règle `REFUSE`. Une étape LLM consulte toujours le BODACC avant d'appeler le LLM.

## Les agents à outils MCP : deux exemples

Le modèle n'appelle jamais un outil : il répond par des `tool_calls`, et l'orchestrateur les exécute via MCP. La boucle vient de librairies standard : **Microsoft Agent Framework** (`ChatClientAgent`, dans `Agents/UnderwritingAgents.cs`) sur le client OpenAI Chat Completions de `Microsoft.Extensions.AI`, qui fait tourner la boucle d'outils (`FunctionInvokingChatClient`, au plus `Llm:MaxToolRounds` = 3 tours ; une erreur d'outil fait échouer l'étape), et le **SDK MCP C# officiel** (`Dependencies/McpTools.cs`) : `initialize`, `notifications/initialized`, `Mcp-Session-Id`, `MCP-Protocol-Version`, fermeture de session. Chaque outil MCP devient une fonction OpenAI (`parameters` = son `inputSchema`).

| Étape | Agent | Serveurs MCP | `calls` dans l'ordre |
|---|---|---|---|
| `financialHealth` (exemple 1, Microcks pur) | `financial-health` | `Mcp:CompanyFinancials`, l'endpoint MCP natif de Microcks | MCP `tools/list`, LLM, MCP `tools/call`, LLM |
| `climateRisk` (exemple 2, via reShapr) | `climate-risk` | `Mcp:Georisques`, `Mcp:Bodacc`, exposés par reShapr | MCP `tools/list` ×2, LLM, MCP `tools/call` ×2, LLM |

Les `calls` sont relevés sous les SDK, par un `DelegatingHandler` (`Dependencies/StepCallHandlers.cs`) : on y voit les vrais appels HTTP. Pour MCP, seuls `tools/list` et `tools/call` y figurent, pas la plomberie de session. `result.naturalRisks` de `climateRisk` contient le rapport Géorisques renvoyé par l'outil.

**Décision renforcée** (`RiskEscalation`, une règle déterministe et non un LLM) :
- Elle relève les raisons de risque : `UNKNOWN_CUSTOMER`, `COLLECTIVE_PROCEDURE`, `CLIMATE_HIGH`, `FINANCIAL_FRAGILE`, `OPEN_LITIGATION` et `DATA_INCONSISTENT`.
- Le niveau est `REINFORCED` à partir de 2 raisons, ou dès qu'il y a un client inconnu ou une procédure collective. La décision exige alors chaque raison dans `acknowledgedReasons` et un commentaire.
- Sinon, le commentaire n'est exigé que si le conseiller s'écarte de la suggestion.

| Dossier | Contenu |
|---|---|
| `Cases/` | le modèle du dossier (statut dérivé), les 12 étapes et leurs `dependsOn`, le stockage en mémoire |
| `Underwriting/` | le workflow ; `StepRunner` (décalage, file LLM, statuts, horodatages, appels) ; `LlmSlots` ; `AdvisorDesk` (les deux endpoints du conseiller) ; `RiskEscalation` ; les règles et les résumés en français |
| `Dependencies/` | les API REST, les outils MCP (`McpTools`, SDK MCP officiel), le journal des appels de chaque étape, les en-têtes de latence Microcks |
| `Agents/` | `UnderwritingAgents` (Microsoft Agent Framework sur OpenAI Chat Completions) et les prompts consultatifs : ils doivent « éclairer le conseiller », jamais décider |

## La latence vient de Microcks

Chaque opération mockée déclare `delay` et `delayStrategy` dans son contrat. Les comptes annuels, par exemple, prennent 30 à 60 s. `startedAt` et `endedAt` mesurent donc la vraie latence des appels.

L'orchestrateur peut aussi demander une latence **par requête** avec les en-têtes `x-microcks-delay` et `x-microcks-delay-strategy` :
- `LlmGateway:DelayOverrides:<agent>` vise un agent, par exemple `financial-health` : `{Delay: 50000, Strategy: random-20}`. Vide par défaut.
- `Demo:MicrocksDelayOverride`, vide par défaut, vise tous les appels REST, MCP et LLM.

reShapr transmet ces en-têtes aux mocks Géorisques et BODACC. Le MCP natif de Microcks, lui, les ignore et applique le délai du contrat.

`Orchestration:ServiceDelayMilliseconds` et `Orchestration:LlmDelayMilliseconds` (`{Min, Max}`, 0 par défaut) ajoutent un délai artificiel côté orchestrateur. Ils ne servent qu'en face de vraies API.

## Configuration (`appsettings.json`)

| Clé | Défaut |
|---|---|
| `Services:CustomerAccounts`, `Sirene`, `Bodacc`, `CompanyFinancials`, `ClaimsAndContracts` | mocks Microcks `http://localhost:8080/rest/<Nom>/1.0.0/` |
| `Mcp:Georisques`, `Mcp:Bodacc` | **reShapr** `http://localhost:7778/mcp/reshapr/georisques-1-0-0-default`, `…/bodacc-1-0-0-default` |
| `Mcp:CompanyFinancials` | **MCP natif de Microcks** `http://localhost:8080/mcp/Company%20financials/1.0.0` |
| `LlmGateway:BaseUrl`, `ApiKey`, `Model`, `SendMetadata`, `TimeoutSeconds`, `DelayOverrides` | le LLM mocké `http://localhost:8080/rest/LLM+gateway/1.0.0/` |
| `Llm:MaxConcurrency`, `Llm:MaxToolRounds` | 2, 3 |
| `Orchestration:StartJitterMilliseconds:{Min,Max}` | 300 à 5000 |
| `Orchestration:ServiceDelayMilliseconds`, `LlmDelayMilliseconds` | 0 |
| `Demo:MicrocksDelayOverride:{Delay,Strategy}` | vide |

Toute clé se surcharge par variable d'environnement, par exemple `Llm__MaxConcurrency=1`.

### MCP : reShapr ou Microcks

L'agent climat utilise **reShapr** (Géorisques et BODACC exposés en MCP, Microcks simule les API derrière lui) ; l'agent santé financière utilise **le MCP natif de Microcks**. Chaque endpoint se change par configuration, par exemple pour passer l'agent climat sur le MCP natif de Microcks :

```bash
Mcp__Georisques=http://localhost:8080/mcp/Georisques/1.0.0 Mcp__Bodacc=http://localhost:8080/mcp/BODACC/1.0.0 dotnet run
```

Aucun nom d'outil n'est en dur : le modèle choisit les outils parmi ceux de `tools/list`. `calls[].url` donne l'endpoint MCP réellement appelé.

## Brancher un vrai LLM

Le client appelle `{BaseUrl}/v1/chat/completions`. Indiquez donc `BaseUrl` **sans** `/v1` :

```bash
LlmGateway__BaseUrl=https://api.openai.com \
LlmGateway__ApiKey=sk-... \
LlmGateway__Model=gpt-4o-mini \
dotnet run
```

Le champ `metadata: {agent, siren}` sert au dispatch du mock Microcks. Si un fournisseur le refuse, mettez `LlmGateway__SendMetadata=false`. `LlmGateway:DelayOverrides` ne sert qu'avec Microcks. Chaque agent rend un objet JSON (`response_format: json_object`), lu dans `choices[0].message.content`.

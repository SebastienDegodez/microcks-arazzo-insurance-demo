# UnderwritingOrchestrator.WorkflowTests

Le vrai orchestrateur .NET tourne dans le process du test (`WebApplicationFactory<Program>`), avec chaque
dépendance pointée sur un mock Microcks. Chaque test ouvre une session Arazzo, joue un dossier, puis demande à
Microcks de vérifier que les appels sortants suivent un workflow (`orchestratorCollectsCompanyData`,
`customerUnknownStopsTheCase`, `collectiveProcedureStopsTheAnalyses`). La session est propagée par le test lui-même
(`Infrastructure/MicrocksSessionPropagation.cs`) : aucune ligne n'est ajoutée à l'orchestrateur.

Prérequis : SDK .NET 10. Pour le mode Testcontainers, Docker et l'image `microcks-uber:feature-arazzo`, construite
depuis `feature/arazzo`.

## Commandes

```bash
cd tests/UnderwritingOrchestrator.WorkflowTests

# Testcontainers (pas besoin de minion ; les contrats de ../../contracts sont importés au démarrage)
MICROCKS_IMAGE=microcks-uber:feature-arazzo dotnet test --logger "console;verbosity=detailed"

# Un seul test, pour la scène
MICROCKS_IMAGE=microcks-uber:feature-arazzo dotnet test --logger "console;verbosity=detailed" \
  --filter "FullyQualifiedName~TheUnderwritingOrchestratorFollowsTheWorkflow"

# Repli : la stack de démo déjà démarrée (Microcks :8080, minion :8082, contrats importés)
../../scripts/import-contracts.sh
MICROCKS_URL=http://localhost:8080 dotnet test --logger "console;verbosity=detailed"

# Côté fournisseur (acte 4) : seulement avec la stack de démo, car le minion n'a pas d'image
MICROCKS_URL=http://localhost:8080 dotnet test --logger "console;verbosity=detailed" \
  --filter "FullyQualifiedName~TheOrchestratorApiHonoursTheAdvisorJourney"
```

Chaque test imprime le verdict de Microcks : les étapes, puis les appels reçus dans la session.

## Ce qui passe (relevé le 2026-10-24)

| Test | Acte | Stack de démo | Testcontainers |
|---|---|---|---|
| `TheUnderwritingOrchestratorFollowsTheWorkflow` | 2 | vert | vert |
| `AnOrchestratorThatSendsTheSirenToClaimsIsCaught` | 3a | vert (verdict rouge attendu sur `openItems`) | vert |
| `AnOrchestratorThatSkipsBodaccIsCaught` | 3b | vert (``step `legalEvents` missing``) | vert |
| `AnOrchestratorThatSendsTheSiretToSireneIsCaught` | 3c | vert (`companyIdentity` reçoit le SIRET) | vert |
| `TheOrchestratorApiHonoursTheAdvisorJourney` | 4 | vert (run S14 `SUCCESS`, session verte) | sauté (pas d'image de minion) |
| `AnUnknownCustomerStopsTheCase` | 5 | vert | vert |
| `ACollectiveProcedureStopsTheAnalyses` | 5 | vert | vert |
| `TwoCasesInParallelStayIsolated` | 5 | vert | vert |

La suite complète passe aussi en parallèle, en environ 15 s, dans les deux modes. Le test de l'acte 2 lancé deux
fois reçoit les 4 appels de collecte dans un ordre différent, et reste vert.

À savoir :

- Acte 4 : Microcks demande une URL de base pour **chaque** source du document, même celles que le workflow
  n'appelle pas. Sans elles, il répond ``400 … no base URL for source customerAccounts``. Le test passe donc les
  mocks des 5 sources REST en plus de l'orchestrateur.
- Acte 4 : `Explain()` affiche aussi les tentatives d'un `retry` (`FAILED` puis `PASSED` pour la même étape).
  Le run est quand même `SUCCESS`.
- Propagation .NET 10 « sans code » (test de fumée de la section 5, étape 7) : un orchestrateur lancé seul, sans le
  handler, et un dossier posté avec `baggage: microcks-session=<id>`. Verdict vert : les 11 appels (5 REST et
  6 LLM, y compris ceux qui partent après le `data-review`) portent la session. L'en-tête `x-microcks-session`
  seul ne se propage pas sans le handler : 0 appel enregistré.

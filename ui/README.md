# Souscription Pro — IHM (port 5190)

Le poste du conseiller décrit dans `../SCENARIO.md` (v2, puis v3 : 12 étapes, sans `geoRisks`). Un hôte ASP.NET Core minimal (.NET 10) sert `wwwroot/`
(HTML, CSS et modules ES, sans build) et porte un BFF.

```bash
dotnet run                     # http://localhost:5190
node tests/e2e.cjs             # Playwright : 2 backends × 5 SIREN, captures dans ../.run/shots/
node tests/e2e.cjs --skip=microcks:100000001   # écarte un dossier qu'un autre run utilise
```

## BFF

| Route | Cible |
|---|---|
| `/bff/orchestrator/{**path}` | `http://localhost:5180/{path}` |
| `/bff/microcks/{**path}` | `http://localhost:8080/rest/Underwriting+cases/1.0.0/{path}` |
| `/bff/fake/{**path}` | doublure en mémoire `FakeOrchestrator.cs`, pour le développement seulement (`?backend=fake`) |
| `/bff/health` | dit si chaque backend répond, et si le mock `Underwriting cases` est importé |

La méthode, le corps, le Content-Type et le statut passent tels quels. `X-Backend` indique qui a répondu. Un
backend injoignable renvoie 502 avec `X-Bff-Error: unreachable`.

## Écran

- **En-tête** : le flip « Orchestrateur .NET ⇄ Microcks (mock) » (gardé en `localStorage`), le badge du backend
  qui a répondu, l'interrupteur Comprendre et le thème (auto, clair ou sombre).
- **Bandeau d'état** : la phase en cours, ce qui tourne, attend en file ou attend le conseiller, la durée, les
  13 étapes, et l'appel à l'action du conseiller.
- **Points de contrôle du conseiller** :
  - la validation des données : récapitulatif, alertes de `dataQuality`, correction de l'effectif ;
  - la décision : le conseiller choisit lui-même, et la suggestion reste à côté, en retrait. En `REINFORCED`, il
    reconnaît chaque raison une à une, et la suggestion est masquée derrière « Voir l'éclairage des analyses ».
- **Onglets** :
  - Vue 360 (l'accueil), Entreprise, Risques, Finances, Sinistres & contrats ;
  - Parcours : couloirs dans le temps, flèches `dependsOn`, file d'attente LLM, jalons du conseiller ;
  - Tableau (kanban) et Journal des appels.
- **Comprendre** : un panneau latéral droit, sticky et repliable. Il suit chaque poll (450 ms) :
  - un paquet de requête part quand une étape passe RUNNING, et sa cible pulse tant qu'elle travaille ;
  - la réponse revient quand l'étape se termine ;
  - les POST du conseiller apparaissent aussi, et le dossier peut être rejoué à la fin.
  - Le serveur MCP est toujours « reShapr (MCP) », hors du cadre Microcks. L'agent climat suit ses `calls` : MCP
    `tools/list`, le modèle qui demande l'outil, l'outil exécuté pour lui via reShapr → Géorisques (mock Microcks),
    puis le modèle avec le résultat.
  - En mode « Microcks (mock) », seul l'échange IHM ⇄ Microcks est animé : aucun appel réel n'est fait en aval.
    Les nœuds restent au repos, et seul l'orchestrateur, hors circuit, est grisé. reShapr est relié au LLM par un
    lien pointillé « outil du modèle » : il est référencé par l'orchestrateur réel.
- **Cartes** : un SVG dessiné par la page, libellé « Carte illustrative », sans tuile ni service externe. Les
  risques naturels viennent de `climateRisk.result.naturalRisks`.

Le poll ne remplace jamais une zone : `js/morph.js` corrige le DOM en place. La page ne bouge donc pas, le focus
et les saisies restent, et les `<details>` restent ouverts. Les tests e2e le vérifient.

Paramètres d'URL : `?backend=fake|orchestrator|microcks` (backend forcé), `&fakeScale=0.25` (doublure accélérée),
`&comprendre=1`, `&tab=timeline`.

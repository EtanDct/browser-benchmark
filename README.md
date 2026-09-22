# Benchmark de navigateurs headless

Outil de benchmark comparant plusieurs navigateurs/frameworks headless sur trois axes :

1. **Contournement anti-bot** (Cloudflare Challenge/Turnstile, détection de fingerprinting)
2. **Performance brute** (temps de chargement, utilisation RAM/CPU dans le temps)
3. **Fidélité de rendu** (rendu correct de pages JS/CSS complexes)

Architecture en **adapters** : chaque navigateur implémente l'interface commune définie dans [src/adapters/base.ts](src/adapters/base.ts). Ajouter un nouveau candidat = créer un fichier `src/adapters/<nom>.ts` implémentant `BrowserAdapter` et l'enregistrer dans le registre, sans toucher au moteur de benchmark.

## Stack

- Node.js + TypeScript
- `pidusage` pour le monitoring RAM/CPU par PID
- Résultats bruts en JSON (`results/raw/`), agrégation en JSON (`results/aggregated.json`)
- Dashboard HTML statique (Chart.js via CDN), généré depuis `results/aggregated.json`

## Navigateurs/frameworks (v1)

| Nom | Type de pilotage |
|---|---|
| Puppeteer | Chromium via CDP |
| Playwright (Chromium) | via Playwright API |
| Playwright (Firefox) | via Playwright API |
| Playwright (WebKit) | via Playwright API |
| Lightpanda | via son propre CDP-like ou API native ([repo](https://github.com/lightpanda-io/browser)) |
| Selenium WebDriver (Chrome) | via `selenium-webdriver` npm |

## Cibles de test

Définies dans [config/targets.json](config/targets.json) (pas codées en dur) :

- Anti-bot / fingerprinting : `bot.sannysoft.com`, `nowsecure.nl`, pages Cloudflare Challenge réelles (à configurer)
- Performance / rendu : page statique (baseline), SPA riche en JS, page riche en médias

## Métriques collectées

Par run (1 navigateur × 1 cible × 1 itération) :

- Temps de chargement (navigation start → `load`, timeout 30s)
- RAM min/max/moyenne (échantillonnage toutes les 200ms, process + sous-process)
- CPU min/max/moyenne
- Succès anti-bot (booléen + détail)
- Fidélité de rendu (hash du DOM final)
- Erreurs/timeouts (capturés sans interrompre la campagne)

## Protocole

- 10 itérations par couple (navigateur, cible), exécutées **séquentiellement**
- Chaque run → `results/raw/{browser}_{target}_{run}.json`
- Agrégation → `results/aggregated.json` (moyennes/médianes/écarts-types)

## Structure du projet

```
browser-benchmark/
├── src/
│   ├── adapters/          # un fichier par navigateur, implémente BrowserAdapter
│   │   └── base.ts        # interface commune
│   ├── monitor/           # échantillonnage RAM/CPU (pidusage)
│   ├── runner/             # orchestrateur de campagne
│   ├── aggregate/          # calcul moyennes/médianes/écarts-types
│   └── cli.ts
├── config/
│   └── targets.json
├── results/
│   ├── raw/
│   └── aggregated.json
├── dashboard/
│   ├── template.html
│   └── generate-dashboard.ts
└── package.json
```

## Commandes

```bash
npm run bench -- --browsers=all --targets=all --runs=10
npm run bench -- --browsers=puppeteer,lightpanda --targets=antibot --runs=5
npm run dashboard   # régénère dashboard/index.html depuis results/aggregated.json
```

## Points d'attention

- **Lightpanda** : vérifier son mode d'intégration exact (CDP-compatible ou API custom) avant de coder l'adapter.
- Timeouts robustes : un navigateur bloqué sur un challenge Cloudflare ne doit jamais bloquer toute la campagne.
- Isoler chaque run dans un contexte/profil propre pour éviter les biais de cache entre itérations.
- Le monitoring RAM/CPU doit cibler le bon PID en tenant compte des sous-process (ex: Chromium = process principal + renderers).

## Hors scope v1

- Exécution distribuée/cloud
- Diff visuel pixel-à-pixel automatisé (v1 = hash DOM)
- Dashboard interactif avec backend (reste un fichier HTML statique généré)

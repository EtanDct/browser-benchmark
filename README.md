# Benchmark de navigateurs headless

Compare des navigateurs/frameworks headless sur trois axes :

1. **Contournement anti-bot** : fingerprinting (bot.sannysoft.com), challenges Cloudflare
2. **Performance brute** : temps de chargement, RAM/CPU de tout l'arbre de process dans le temps
3. **Fidélité de rendu** : structure du DOM final comparée entre navigateurs

Chaque navigateur est un **adapter** derrière une interface commune : en ajouter un ne touche pas au moteur.

## Démarrage rapide

```bash
npm install                                   # installe aussi Chrome for Testing (Puppeteer)
npx playwright install chromium firefox webkit
npm run list                                  # navigateurs disponibles + cibles
npm run bench -- --browsers=all --targets=local --runs=3
```

À la fin d'une campagne, les résultats sont agrégés et le dashboard est régénéré : ouvrir `dashboard/index.html` dans un navigateur (aucun serveur nécessaire).

## Commandes

```bash
npm run bench -- --browsers=all --targets=all --runs=10
npm run bench -- --browsers=puppeteer,lightpanda --targets=antibot --runs=5
npm run aggregate     # reconstruit results/aggregated.json depuis results/raw
npm run dashboard     # régénère dashboard/index.html depuis results/aggregated.json
npm run list          # disponibilité des navigateurs et liste des cibles
npm test              # tests unitaires
npm run typecheck
```

| Option | Défaut | Rôle |
|---|---|---|
| `--browsers` | `all` | noms d'adapters, alias (`playwright`, `selenium`) ou `all` |
| `--targets` | `all` | noms de cibles, groupes (`antibot`, `performance`, `local`) ou `all` |
| `--runs` | `10` | itérations par couple (navigateur, cible) |
| `--pause` | `2000` | pause entre deux runs (ms) |
| `--interval` | `200` | intervalle d'échantillonnage RAM/CPU (ms) |
| `--timeout` | par cible | remplace le timeout de navigation de toutes les cibles |
| `--config` | `config/targets.json` | fichier de cibles |
| `--results` | `results` | dossier des résultats |
| `--clean` | non | supprime les résultats bruts précédents avant la campagne |

Sans `--clean`, les résultats bruts s'accumulent : on peut lancer Lightpanda un jour et Puppeteer le lendemain, l'agrégation couvre tout. Un run relancé écrase le fichier du même `{browser}_{target}_{run}`.

## Navigateurs

| Adapter | Pilotage | Process surveillé |
|---|---|---|
| `puppeteer` | Chrome for Testing via CDP | navigateur + renderers/GPU/utilitaires |
| `playwright-chromium` | Playwright (`chromium-headless-shell`) | idem |
| `playwright-firefox` | Playwright | Firefox + content processes |
| `playwright-webkit` | Playwright | WebKit + WebContent/Network |
| `lightpanda` | serveur CDP `lightpanda serve` + `puppeteer.connect()` | process Lightpanda |
| `selenium-chrome` | Selenium WebDriver + chromedriver | chromedriver + Chrome |

Chaque run lance un navigateur neuf (profil vierge), sans plugin furtif : on mesure le comportement **par défaut** de chaque outil.

### Lightpanda

Lightpanda expose un serveur compatible CDP ; il est piloté par Puppeteer. **Il n'existe pas de build Windows natif.**

- Linux/macOS : télécharger le binaire depuis les [releases](https://github.com/lightpanda-io/browser/releases), puis le mettre dans le `PATH` ou définir `LIGHTPANDA_BIN=/chemin/lightpanda`.
- Windows : le lancer dans Docker ou WSL2 puis définir `LIGHTPANDA_WS_ENDPOINT=ws://127.0.0.1:9222`. Dans ce mode, le process ne nous appartient pas : **RAM/CPU ne sont pas mesurés**, et les fixtures `local://` ne sont pas joignables depuis le conteneur.

```bash
docker run -d --name lightpanda -p 127.0.0.1:9222:9222 lightpanda/browser:nightly
```

La télémétrie de Lightpanda est désactivée (`LIGHTPANDA_DISABLE_TELEMETRY=true`) quand le benchmark le lance lui-même.

## Cibles

Définies dans [`config/targets.json`](config/targets.json) :

```json
{
  "name": "sannysoft",
  "group": "antibot",
  "url": "https://bot.sannysoft.com",
  "settleMs": 3000,
  "antiBot": { "evaluator": "sannysoft" }
}
```

| Champ | Rôle |
|---|---|
| `group` | utilisé par `--targets=<groupe>` |
| `url` | `http(s)://…` ou `local://<page>?params` (fixtures servies localement) |
| `timeoutMs` | timeout de navigation jusqu'à `load` (défaut 30 s) |
| `settleMs` | attente après `load` avant capture du DOM (défaut 1 s) |
| `challengeWaitMs` | temps laissé à un challenge anti-bot pour se résoudre, en sondant toutes les 500 ms (défaut 15 s) |
| `antiBot.evaluator` | `cloudflare`, `sannysoft` ou `generic` |
| `antiBot.successText` / `failureTexts` | textes attendus/interdits sur la page servie |

**Pages privées** (vos propres pages derrière Cloudflare) : copier [`config/targets.local.example.json`](config/targets.local.example.json) vers `config/targets.local.json` (ignoré par git). Ses cibles s'ajoutent à la config principale, et remplacent celles qui portent le même nom.

> `nowsecure.nl` ne sert plus de challenge Cloudflare depuis 2026 (même `curl` reçoit la page) : ajoutez de vraies pages protégées dans `targets.local.json` pour tester le contournement.

### Fixtures locales

Les cibles `local://` sont servies par un serveur intégré sur `127.0.0.1`, démarré automatiquement. Le contenu est identique d'un run et d'un navigateur à l'autre. On isole ainsi une variable à la fois, et la comparaison de DOM reste significative.

| Page | Paramètres | Contenu |
|---|---|---|
| `local://static` | — | texte + tableau (baseline) |
| `local://heavy-js` | `kb` | JS généré de ~`kb` Ko qui construit le DOM |
| `local://images` | `count`, `size` | `count` PNG `size`×`size` générés (bruit, non triviaux à décoder) |
| `local://spa` | `items` | liste rendue côté client depuis une API JSON |

## Métriques

Pour chaque run (1 navigateur × 1 cible × 1 itération), un fichier `results/raw/{browser}_{target}_{run}.json` contient :

- **Temps de chargement** : de `goto()` à l'événement `load`, mesuré par l'orchestrateur. La valeur Navigation Timing (`loadEventEnd`) est aussi conservée quand le navigateur l'expose.
- **Temps de lancement** : jusqu'à ce que le navigateur soit prêt à naviguer.
- **RAM / CPU** : échantillonnage de **tout l'arbre de process** du navigateur toutes les 200 ms, du navigateur prêt jusqu'à la capture du DOM → min / max / moyenne + série temporelle.
  - Windows : *private working set* (mémoire propre de chaque process, sans double-compter les DLL partagées entre renderers Chromium), lu via `NtQuerySystemInformation` depuis un process PowerShell persistant. `wmic` a disparu de Windows 11, et `pidusage` ne fonctionne plus sous Windows.
  - Linux/macOS : RSS via `pidusage`, arbre via `ps`. Le RSS additionne les pages partagées : ne pas comparer des chiffres absolus entre OS.
  - CPU en % **d'un cœur**, additionné sur l'arbre (peut dépasser 100 %). Le premier échantillon sert de référence (`null`).
  - La fenêtre commence juste après le lancement : elle inclut donc le travail de démarrage que certains navigateurs font encore en tâche de fond.
- **Anti-bot** : verdict `passed` / `challenge` / `blocked` / `detected` / `unknown`, avec le détail (ex. `27 passed, 0 warn, 4 failed` sur sannysoft).
- **Fidélité** : hash SHA-256 (tronqué) de la séquence des balises du DOM final, plus le nombre d'éléments et la longueur du texte.
- **Erreurs / timeouts** : capturés sans interrompre la campagne. Un navigateur qui ne se ferme pas à temps voit tout son arbre de process tué (`forcedKill`), pour ne pas fausser le run suivant.

`results/aggregated.json` calcule, par (navigateur × cible), moyenne, médiane, écart-type, min, max et p95 ; taux de succès et taux de passage anti-bot (un chargement raté compte comme un échec) ; et **fidélité** = part des runs dont le hash DOM égale le hash majoritaire tous navigateurs confondus pour cette cible. Plusieurs variantes pour un même navigateur signalent une page non déterministe (pub, A/B test…).

## Dashboard

`dashboard/index.html` est un fichier unique, avec les données embarquées et Chart.js chargé depuis un CDN :

- tableau de synthèse par navigateur ;
- matrice anti-bot navigateur × cible, avec code couleur et icône (✓ ≥ 80 %, ! 40–80 %, ✕ < 40 %) ;
- temps de chargement médian par cible et par navigateur ;
- mémoire moyenne et pic par navigateur ;
- drill-down RAM et CPU dans le temps pour un run choisi, avec le moment de l'événement `load` ;
- tableau détaillé navigateur × cible ;
- filtres par navigateur et par cible, qui s'appliquent à toute la page. Mode sombre automatique.

## Architecture

```
src/
├── adapters/
│   ├── base.ts          # interfaces BrowserAdapter / NavigationResult / AdapterDefinition
│   ├── common.ts        # post-chargement partagé : attente, sondage du challenge, snapshot + hash DOM
│   ├── registry.ts      # liste des adapters + alias
│   ├── puppeteer.ts     # (+ navigatePuppeteerPage, réutilisé par Lightpanda)
│   ├── playwright.ts    # chromium / firefox / webkit
│   ├── lightpanda.ts
│   └── selenium.ts
├── antibot/evaluators.ts  # cloudflare, sannysoft, generic
├── monitor/
│   ├── resource-sampler.ts  # API + backend Unix (pidusage)
│   └── windows-probe.ts     # backend Windows (NtQuerySystemInformation)
├── runner/                # campagne séquentielle, timeouts, kill d'arbre, JSON brut
├── aggregate/aggregator.ts
├── fixtures/server.ts     # pages local://
├── config/targets.ts
└── cli.ts
dashboard/
├── template.html
└── generate-dashboard.ts
```

### Ajouter un navigateur

1. Créer `src/adapters/<nom>.ts` qui implémente `BrowserAdapter` :
   - `launch()` démarre un navigateur neuf et renvoie le PID racine de son arbre (ou `null` s'il tourne hors de notre contrôle) ;
   - `navigate(url, options)` mesure jusqu'à `load` puis délègue à `completeNavigation()` (snapshot, hash, anti-bot), avec un `evaluate(expression)` propre au driver ;
   - `close()`, et `version()` en option.
2. Exporter une `AdapterDefinition` (`create`, `checkAvailability`) et l'ajouter à `ADAPTERS` dans `registry.ts`.

Rien d'autre à modifier : le runner, le monitoring, l'agrégation et le dashboard le prennent en charge. Un navigateur compatible CDP peut réutiliser `navigatePuppeteerPage()`, comme Lightpanda.

## Dépannage

- **`playwright-firefox` échoue avec `spawn UNKNOWN`** sur certaines builds de Windows 11 : Windows refuse de démarrer `firefox.exe` (« Assembly dépendant mozglue introuvable » dans l'Observateur d'événements). Le binaire téléchargé est complet ; le problème vient de la compatibilité entre le build Firefox de Playwright et ce Windows. Les runs sont comptés en échec sans bloquer la campagne.
- **Selenium** : Selenium Manager résout (et télécharge si besoin) chromedriver et Chrome au premier lancement. Ce délai n'est pas compté dans le temps de lancement.

## Hors scope v1

- Exécution distribuée / cloud
- Diff visuel pixel à pixel (v1 = hash de structure DOM)
- Dashboard avec backend

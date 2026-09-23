# Benchmark de navigateurs headless

Compare des navigateurs et frameworks headless, dans leur configuration par défaut et en variantes anti-détection :

1. **Contournement anti-bot** : fingerprinting (sannysoft, CreepJS, deviceandbrowserinfo, BrowserScan), vrai challenge Cloudflare
2. **Performance** : temps de chargement et de lancement, RAM/CPU de tout l'arbre de process, octets réseau, **débit en parallèle**
3. **Fidélité** : similarité du DOM final entre navigateurs, **comparaison pixel à pixel** des captures

Chaque navigateur est un **adapter** derrière une interface commune : en ajouter un ne touche pas au moteur.

## Démarrage rapide

```bash
npm install                                   # installe aussi Chrome for Testing (Puppeteer)
npm run install-browsers                      # Chromium, Firefox et WebKit de Playwright
npx camoufox-js fetch                         # Camoufox (~500 Mo), optionnel
npm run list                                  # navigateurs disponibles + cibles
npm run bench -- --targets=local --runs=3
```

À la fin d'une campagne, les résultats sont agrégés, un résumé est ajouté à l'historique et le dashboard est régénéré : ouvrir `dashboard/index.html` (aucun serveur nécessaire).

**Configuration locale** : les variables d'environnement peuvent être placées dans un fichier `.env` à la racine (ignoré par git, voir [`.env.example`](.env.example)), chargé par chaque commande `npm run` : `PLAYWRIGHT_BROWSERS_PATH`, `CAMOUFOX_INSTALL_DIR`, `LIGHTPANDA_*`.

## Commandes

```bash
npm run bench -- --browsers=all --targets=all --runs=10
npm run bench -- --browsers=stealth,puppeteer --targets=antibot
npm run bench -- --browsers=vanilla --targets=local,performance --modes=full,lite
npm run throughput -- --target=local-heavy-js --concurrency=1,2,4,8
npm run aggregate           # reconstruit results/aggregated.json (runs, captures, débit)
npm run dashboard           # régénère dashboard/index.html
npm run dashboard:artifact  # même page, sans enveloppe HTML, pour une publication en Artifact
npm run list                # disponibilité des navigateurs et liste des cibles
npm run install-browsers    # installe les navigateurs Playwright (respecte PLAYWRIGHT_BROWSERS_PATH)
npm test && npm run typecheck
```

### Options de `bench`

| Option | Défaut | Rôle |
|---|---|---|
| `--browsers` | `all` | noms d'adapters, alias (`playwright`, `selenium`, `stealth`, `vanilla`) ou `all` |
| `--targets` | `all` | noms de cibles, groupes (`antibot`, `performance`, `local`) ou `all` |
| `--runs` | `10` | runs mesurés par couple (navigateur, cible) |
| `--warmup` | `1` | runs de chauffe par couple, non enregistrés (cache disque, DNS, VM WSL) |
| `--order` | `interleaved` | `interleaved` : chaque tour fait passer chaque navigateur sur chaque cible, en changeant de navigateur de départ d'un tour à l'autre ; `sequential` : un navigateur après l'autre |
| `--modes` | `full` | `full` (page normale) et/ou `lite` (images, CSS, polices et médias bloqués) |
| `--no-bytes` | — | ne pas faire passer le trafic par le proxy de comptage |
| `--no-screenshots` | — | pas de captures pour la comparaison visuelle |
| `--pause` | `2000` | pause entre deux runs (ms) |
| `--interval` | `200` | intervalle d'échantillonnage RAM/CPU (ms) |
| `--timeout` | par cible | remplace le timeout de navigation de toutes les cibles |
| `--config` / `--results` | `config/targets.json` / `results` | fichier de cibles / dossier des résultats |
| `--clean` | — | supprime les résultats bruts et captures précédents |

### Options de `throughput`

| Option | Défaut | Rôle |
|---|---|---|
| `--browsers` | `all` | Selenium est ignoré (une seule page par session WebDriver) |
| `--target` | `local-heavy-js` | page chargée en boucle |
| `--concurrency` | `1,2,4,8` | nombre de pages en parallèle, une mesure par valeur |
| `--pages` | `24` | chargements par niveau de parallélisme |

## Navigateurs

| Adapter | Pilotage | Type |
|---|---|---|
| `puppeteer` | Chrome for Testing via CDP | par défaut |
| `playwright-chromium` | Playwright (`chromium-headless-shell`) | par défaut |
| `playwright-firefox` | Playwright | par défaut |
| `playwright-webkit` | Playwright | par défaut |
| `lightpanda` | serveur CDP `lightpanda serve` + `puppeteer.connect()` | par défaut, sans moteur de rendu |
| `selenium-chrome` | Selenium WebDriver + chromedriver | par défaut |
| `puppeteer-stealth` | Puppeteer + `puppeteer-extra-plugin-stealth` | **furtif** : masque les fuites headless classiques |
| `patchright` | fork de Playwright sans fuites CDP, sur le Google Chrome installé | **furtif** |
| `camoufox` | Firefox anti-détection (patché en C++), via `camoufox-js` | **furtif** |

Chaque run lance un navigateur neuf (profil vierge). En mode `lite`, chaque navigateur qui a un moteur de rendu bloque les images, feuilles de style, polices et médias : c'est la comparaison à armes égales avec Lightpanda, qui ne les charge jamais. Les résultats portent alors le suffixe `+lite`.

### Lightpanda

Lightpanda expose un serveur compatible CDP ; il est piloté par Puppeteer. Il n'existe pas de build Windows natif. Le mode est choisi automatiquement :

| Plateforme | Mode | RAM/CPU |
|---|---|---|
| Linux / macOS | binaire natif (`LIGHTPANDA_BIN` ou `lightpanda` dans le `PATH`) | oui (RSS) |
| Windows | **build Linux lancé dans WSL2** : CDP joint via la redirection localhost de WSL | oui : échantillonné **dans** WSL (USS) |
| partout | `LIGHTPANDA_WS_ENDPOINT=ws://…` : instance externe (Docker…) | non |

**Installation sous Windows (WSL2)**, dans la distribution WSL par défaut :

```bash
wsl -e sh -c "mkdir -p ~/.local/bin && curl -fsSL -o ~/.local/bin/lightpanda https://github.com/lightpanda-io/browser/releases/download/0.4.1/lightpanda-x86_64-linux && chmod a+x ~/.local/bin/lightpanda"
```

Variables optionnelles : `LIGHTPANDA_WSL_BIN` et `LIGHTPANDA_WSL_DISTRO`. `python3` doit être présent dans WSL (échantillonneur de ressources). En mode WSL, les fixtures `local://` et le proxy de comptage sont aussi servis sur l'adresse de Windows vue depuis WSL, et l'échantillonneur WSL garde la VM allumée pendant toute la campagne : son démarrage n'est jamais compté dans un temps de lancement. La version enregistrée est la vraie (`Lightpanda 0.4.1`), pas la version Chrome annoncée via CDP.

### Variantes furtives

- **puppeteer-stealth** utilise le même Chrome for Testing que `puppeteer`.
- **patchright** pilote le Google Chrome installé (`channel: 'chrome'`) : rien à télécharger.
- **camoufox** : `npx camoufox-js fetch` télécharge le navigateur (~500 Mo) et une base GeoIP (66 Mo). `camoufox-js` embarque sa propre version de Playwright, alignée sur Camoufox, et l'adapter s'y connecte avec cette même version. Sous Windows, le placer hors d'`AppData` (voir Dépannage) : `CAMOUFOX_INSTALL_DIR=C:/Users/<vous>/.cache/camoufox` dans `.env`.

## Cibles

Définies dans [`config/targets.json`](config/targets.json) :

| Champ | Rôle |
|---|---|
| `group` | utilisé par `--targets=<groupe>` |
| `url` | `http(s)://…` ou `local://<page>?params` (fixtures servies localement) |
| `timeoutMs` | timeout de navigation jusqu'à `load` (défaut 30 s) |
| `settleMs` | attente après `load` avant capture du DOM (défaut 1 s) |
| `challengeWaitMs` | temps laissé à un challenge anti-bot pour se résoudre, sondé toutes les 500 ms (défaut 15 s ; un verdict qui ne s'affiche jamais n'est attendu que 8 s) |
| `visual` | capture d'écran pour la comparaison visuelle (défaut : pages `local://` seulement, les sites réels changeant d'un chargement à l'autre) |
| `antiBot.evaluator` | `cloudflare`, `sannysoft`, `creepjs`, `deviceandbrowserinfo` ou `generic` |
| `antiBot.successText` / `failureTexts` | textes attendus/interdits dans le texte visible de la page |
| `antiBot.passedPattern` / `detectedPattern` | (`generic`) regex sur le texte visible pour lire un verdict |

Les verdicts anti-bot sont lus dans le **texte visible** : les pages de détection embarquent souvent les deux messages dans leur JavaScript.

### Cibles anti-bot

Toutes sont des pages **conçues pour tester la détection** :

| Cible | Famille | Ce qui est testé | Verdict lu |
|---|---|---|---|
| `sannysoft` | fingerprinting classique | webdriver, plugins, WebGL, permissions… | nombre de contrôles `failed` |
| `creepjs` | fingerprinting avancé | signaux headless + API falsifiées (plugins stealth) | scores `headless` / `stealth` |
| `deviceandbrowserinfo` | signaux de niveau commercial | pilotage CDP, webdriver, incohérences client hints/workers | JSON `isBot` + signaux déclenchés |
| `browserscan` | scanner d'anti-detect | webdriver, user-agent, CDP, navigator | `Test Results: Robot / Normal` |
| `cloudflare-challenge` | WAF commercial | vrai challenge géré Cloudflare (bac à sable scrapingcourse.com) | page réelle servie |
| `cloudflare-antibot` | WAF commercial | configuration Cloudflare plus stricte | idem |

Chaque verdict porte aussi un **score gradué**, la part des contrôles réussis, qui départage les navigateurs même quand aucun ne passe. `unknown` signifie que le script de détection n'a pas abouti dans ce navigateur : c'est compté comme un échec, car un vrai site protégé ne laisse pas passer un client qui ne renvoie pas son empreinte. Pour des sites de production protégés (DataDome, Akamai…) que vous êtes autorisé à tester : `config/targets.local.json`, sur le modèle de [`config/targets.local.example.json`](config/targets.local.example.json).

### Fixtures locales

| Page | Paramètres | Contenu |
|---|---|---|
| `local://static` | — | texte + tableau (baseline) |
| `local://heavy-js` | `kb` | JS généré de ~`kb` Ko qui construit le DOM |
| `local://images` | `count`, `size` | `count` PNG `size`×`size` générés |
| `local://spa` | `items` | liste rendue côté client depuis une API JSON |

Contenu identique d'un run et d'un navigateur à l'autre : on isole une variable à la fois, et la comparaison DOM ou visuelle est significative.

## Métriques

Pour chaque run, `results/raw/{navigateur}_{cible}_{run}.json` contient :

- **Temps de chargement** (de `goto()` à `load`) et **de lancement**.
- **RAM / CPU** de **tout l'arbre de process**, échantillonnés toutes les 200 ms : *private working set* sous Windows (`NtQuerySystemInformation`), *USS* dans WSL, RSS sous Linux/macOS natif (qui compte en double les pages partagées : ne pas comparer des chiffres absolus entre OS). CPU en % d'un cœur, additionné sur l'arbre.
- **Octets réseau** : tout le trafic passe par un petit proxy local (HTTP + tunnels `CONNECT`) qui compte les octets reçus et envoyés pendant la navigation, TLS compris. C'est ce que facturerait un proxy payant. Le compte est fait de la même façon pour tous les navigateurs, Lightpanda et Selenium compris. Il n'est mesuré que sur les pages distantes : la plupart des navigateurs contournent le proxy pour `127.0.0.1`.
- **Anti-bot** : verdict, score gradué, extrait de la page en cas d'échec.
- **DOM** : hash de la séquence des balises et **nombre d'éléments par balise**.
- **Capture d'écran** (premier run, pages `visual`, mode full), en 1280×800, dans `results/screens/`.

### Agrégation (`results/aggregated.json`)

Par (navigateur × cible) : moyenne, médiane, écart-type, p95 et **intervalle de confiance à 95 %** de la moyenne (Student). Également :
- taux de passage et score anti-bot ;
- **fidélité DOM graduée** : similarité (Jaccard pondéré des nombres d'éléments par balise) avec le DOM de consensus, qui est la médiane de chaque balise sur tous les navigateurs. Un seul élément différent ne met plus le score à 0 ;
- **rendu visuel** : part des pixels identiques à la capture du navigateur de référence (Playwright Chromium à défaut d'un autre), via pixelmatch, les tailles différentes étant recadrées ;
- les valeurs **run par run**, qui servent au bootstrap du classement.

## Dashboard

Un fichier unique, les données embarquées. Chart.js est chargé depuis un CDN. Quatre onglets partagent les mêmes filtres :

- **Classement** : 9 axes notés sur 100 (anti-bot, vitesse, démarrage, mémoire, CPU, réseau, fidélité DOM, rendu visuel, fiabilité), un score global pondéré, des préréglages (*Équilibré*, *Scraping discret*, *Performance / volume*, *Rendu fidèle*).
  - La **robustesse du classement** est testée par **bootstrap** : le classement est refait 200 fois en tirant au sort, avec remise, les runs de chaque case. On obtient ainsi, pour chaque navigateur, la part des tirages où il finit 1er et la plage de rangs où il tombe dans 90 % des cas. Une avance « fragile » signale un écart que les runs ne permettent pas d'affirmer.
- **Détails** : synthèse par navigateur, matrice anti-bot, graphiques de chargement et de mémoire, RAM/CPU dans le temps pour un run, tableau navigateur × cible paginé et triable (IC 95 %, réseau, similarité DOM, rendu visuel).
- **Débit** : pages par minute et mémoire au pic selon le nombre de pages en parallèle, mémoire par page supplémentaire (pente).
- **Historique** : une courbe par navigateur, campagne après campagne, avec la version au survol.

La couleur identifie la **famille de moteur** (par exemple Chromium pour `playwright-chromium` et `patchright`) et reste la même quels que soient les filtres. Le **motif** identifie la variante : hachuré pour furtif, estompé pour lite ; en pointillés sur les courbes.

## Débit en parallèle

`npm run throughput` ouvre N pages dans **un seul** navigateur, chaque page dans son propre contexte isolé, comme un scraper qui garde ses sessions séparées. Les N pages se partagent une file de chargements. Pour chaque N, on mesure les pages par minute, les échecs et la mémoire moyenne et au pic. La **mémoire par page supplémentaire** est la pente de la mémoire au pic selon N. Résultats : `results/throughput/`, intégrés à l'agrégat et au dashboard.

## Historique et campagne planifiée

Chaque `npm run bench` ajoute un résumé daté dans `results/history/`, avec les versions des navigateurs.

Le workflow [`campaign.yml`](.github/workflows/campaign.yml) lance chaque lundi une campagne complète et un test de débit. Il peut aussi être déclenché à la main avec des paramètres. Il :
- publie le dashboard et les résultats en artefact ;
- ajoute l'historique à la branche `bench-history`, relue à la campagne suivante.

Les runners GitHub partagés sont bruyants : pour des chiffres comparables d'une semaine à l'autre, enregistrer un runner auto-hébergé dédié et mettre son label dans la variable de dépôt `BENCH_RUNNER`.

## Architecture

```
src/
├── adapters/
│   ├── base.ts              # BrowserAdapter / AdapterDefinition / PageHandle…
│   ├── common.ts            # post-chargement partagé : attente, sondage anti-bot, snapshot + hash DOM
│   ├── registry.ts          # liste des adapters + alias (playwright, selenium, stealth, vanilla)
│   ├── puppeteer.ts         # (+ helpers réutilisés par puppeteer-stealth et Lightpanda)
│   ├── puppeteer-stealth.ts
│   ├── playwright.ts        # PlaywrightAdapter générique (moteur = lancement + connexion)
│   ├── patchright.ts
│   ├── camoufox.ts
│   ├── lightpanda.ts
│   └── selenium.ts
├── antibot/evaluators.ts    # cloudflare, sannysoft, creepjs, deviceandbrowserinfo, generic
├── monitor/                 # échantillonnage RAM/CPU : Unix (pidusage), Windows (NtQuerySystemInformation), WSL (/proc)
├── network/byte-proxy.ts    # proxy de comptage d'octets
├── runner/
│   ├── benchmark-runner.ts  # campagne : ordre entrelacé, chauffe, modes, timeouts, kill d'arbre
│   └── throughput-runner.ts # débit en parallèle
├── aggregate/
│   ├── aggregator.ts        # statistiques, IC 95 %, fidélité graduée, séries par run
│   ├── visual.ts            # comparaison pixel à pixel des captures
│   └── history.ts           # résumé par campagne
├── fixtures/server.ts       # pages local://
├── config/targets.ts
└── cli.ts
dashboard/
├── template.html
└── generate-dashboard.ts
```

### Ajouter un navigateur

1. Créer `src/adapters/<nom>.ts` qui implémente `BrowserAdapter` :
   - `launch({ proxyUrl })` démarre un navigateur neuf, qui passe par le proxy donné, et renvoie le PID racine de son arbre (`location: 'wsl'` si c'est un process de WSL) ;
   - `navigate(url, options)` mesure jusqu'à `load` puis délègue à `completeNavigation()`, et bloque les ressources si `options.blockResources` ;
   - `close()`, et en option `version()`, `screenshot(width, height)` et `openPages(count)` pour le test de débit.
2. Exporter une `AdapterDefinition` (`create`, `checkAvailability`, `supportsLite`, `stealth`) et l'ajouter à `ADAPTERS` dans `registry.ts`.

Un navigateur compatible CDP peut réutiliser les helpers Puppeteer, comme Lightpanda. Un fork ou un wrapper de Playwright n'a qu'à fournir un `PlaywrightEngine`, comme patchright et camoufox.

## Dépannage

- **Un navigateur basé sur Firefox (`playwright-firefox`, `camoufox`) échoue avec `spawn UNKNOWN`** sous Windows : ses fichiers ont été installés depuis une **application Windows empaquetée** (MSIX), par exemple le terminal de l'app de bureau Claude. Ces applications redirigent `AppData` vers leur cache privé (`AppData\Local\Packages\<app>\LocalCache`), et le chargeur de Windows n'y retrouve pas la DLL `mozglue` de Firefox. Il faut les installer hors d'`AppData` : `PLAYWRIGHT_BROWSERS_PATH` et `CAMOUFOX_INSTALL_DIR` dans `.env`, puis `npm run install-browsers` et `npx camoufox-js fetch`.
- **Camoufox et le parallélisme** : dans nos essais, les chargements concurrents de Camoufox finissent en timeout dès 2 pages en parallèle, même en contextes séparés. Le tableau de débit l'indique.
- **Selenium** : Selenium Manager résout, et télécharge si besoin, chromedriver et Chrome au premier lancement. Ce délai n'est pas compté dans le temps de lancement.

## Hors scope

- Exécution distribuée
- Dashboard avec backend (la page reste un fichier statique généré)

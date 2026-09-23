import './env.js';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ADAPTERS, resolveAdapters } from './adapters/registry.js';
import { aggregate, loadRawRecords, loadThroughputRecords, type AggregatedReport } from './aggregate/aggregator.js';
import { appendHistory } from './aggregate/history.js';
import { computeVisualScores } from './aggregate/visual.js';
import { loadTargets, selectTargets } from './config/targets.js';
import { generateDashboard } from '../dashboard/generate-dashboard.js';
import { runCampaign, type RunOrder } from './runner/benchmark-runner.js';
import { runThroughput } from './runner/throughput-runner.js';
import type { RunMode } from './runner/types.js';
import { errorMessage } from './util/time.js';

const HELP = `Usage:
  npm run bench -- [options]        run a campaign, then aggregate, record history and regenerate the dashboard
  npm run throughput -- [options]   pages/minute and memory per page with N pages in one browser
  npm run aggregate                 rebuild results/aggregated.json from results/raw (+ screens, throughput)
  npm run dashboard                 rebuild dashboard/index.html from results/aggregated.json
  npm run list                      list browsers (with availability) and targets
  npm run install-browsers          install Playwright's Chromium, Firefox and WebKit (honours PLAYWRIGHT_BROWSERS_PATH / .env)

Bench options:
  --browsers=<list>     adapter names, aliases (playwright, selenium, stealth, vanilla) or "all"  [all]
  --targets=<list>      target names, groups (antibot, performance, local) or "all"                [all]
  --runs=<n>            measured iterations per (browser, target)                                  [10]
  --warmup=<n>          unrecorded warm-up iterations per (browser, target)                        [1]
  --order=<o>           interleaved (browsers alternate every round) or sequential               [interleaved]
  --modes=<list>        full (normal pages) and/or lite (images, CSS, fonts, media blocked)        [full]
  --no-bytes            do not route traffic through the byte-counting proxy
  --no-screenshots      do not capture screenshots for the visual comparison
  --no-history          do not add this campaign to results/history (for a campaign split in several commands)
  --pause=<ms>          pause between runs                                                         [2000]
  --interval=<ms>       RAM/CPU sampling interval                                                  [200]
  --timeout=<ms>        override every target's navigation timeout
  --config=<file>       targets file                                                   [config/targets.json]
  --results=<dir>       results directory                                                          [results]
  --clean               delete previous raw results and screenshots before running

Throughput options:
  --browsers=<list>     as above (browsers that cannot run several pages are skipped)            [all]
  --target=<name>       page to load repeatedly                                          [local-heavy-js]
  --concurrency=<list>  pages kept busy at once, one measurement per value                         [1,2,4,8]
  --pages=<n>           page loads per concurrency level                                           [24]
`;

function list(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function positiveInt(name: string, value: string, allowZero = false): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1)) throw new Error(`--${name} must be a ${allowZero ? 'non-negative' : 'positive'} integer (got "${value}")`);
  return n;
}

async function clearJson(dir: string, extension: string): Promise<void> {
  const files = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(files.filter((f) => f.endsWith(extension)).map((f) => rm(path.join(dir, f))));
}

async function aggregateResults(resultsDir: string): Promise<{ file: string; report: AggregatedReport }> {
  const records = await loadRawRecords(path.join(resultsDir, 'raw'));
  if (!records.length) throw new Error(`No raw results in ${path.join(resultsDir, 'raw')}`);
  const visual = await computeVisualScores(records, path.join(resultsDir, 'screens'));
  const throughput = await loadThroughputRecords(path.join(resultsDir, 'throughput'));
  const report = aggregate(records, { visual: visual.scores, visualReferences: visual.references, throughput });
  const file = path.join(resultsDir, 'aggregated.json');
  await mkdir(resultsDir, { recursive: true });
  await writeFile(file, JSON.stringify(report, null, 1));
  console.log(`Aggregated ${records.length} runs${throughput.length ? ` + ${throughput.length} throughput tests` : ''} -> ${file}`);
  return { file, report };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      browsers: { type: 'string', default: 'all' },
      targets: { type: 'string', default: 'all' },
      target: { type: 'string', default: 'local-heavy-js' },
      runs: { type: 'string', default: '10' },
      warmup: { type: 'string', default: '1' },
      order: { type: 'string', default: 'interleaved' },
      modes: { type: 'string', default: 'full' },
      'no-bytes': { type: 'boolean', default: false },
      'no-screenshots': { type: 'boolean', default: false },
      'no-history': { type: 'boolean', default: false },
      concurrency: { type: 'string', default: '1,2,4,8' },
      pages: { type: 'string', default: '24' },
      pause: { type: 'string', default: '2000' },
      interval: { type: 'string', default: '200' },
      timeout: { type: 'string' },
      config: { type: 'string', default: 'config/targets.json' },
      results: { type: 'string', default: 'results' },
      clean: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const command = positionals[0] ?? 'bench';
  if (values.help) {
    console.log(HELP);
    return;
  }
  const resultsDir = path.resolve(values.results);
  const dashboardFile = path.resolve('dashboard/index.html');
  const historyDir = path.join(resultsDir, 'history');

  if (command === 'list') {
    for (const definition of ADAPTERS) {
      const availability = await definition.checkAvailability();
      const status = availability.available ? 'available' : 'unavailable';
      console.log(`${definition.name.padEnd(22)}${status.padEnd(13)}${definition.description}${availability.reason ? `\n${' '.repeat(35)}${availability.reason}` : ''}`);
    }
    console.log('');
    for (const target of loadTargets(values.config)) {
      console.log(`${target.group.padEnd(13)}${target.name.padEnd(22)}${target.url}`);
    }
    return;
  }

  if (command === 'install-browsers') {
    const playwrightCli = path.join(path.dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
    console.log(`Installing into ${process.env.PLAYWRIGHT_BROWSERS_PATH ?? "Playwright's default location"}`);
    const { status } = spawnSync(process.execPath, [playwrightCli, 'install', 'chromium', 'firefox', 'webkit'], { stdio: 'inherit' });
    process.exitCode = status ?? 1;
    return;
  }

  if (command === 'aggregate') {
    await aggregateResults(resultsDir);
    return;
  }

  if (command === 'throughput') {
    const [target] = selectTargets(loadTargets(values.config), [values.target]);
    const concurrencies = list(values.concurrency).map((c) => positiveInt('concurrency', c));
    const pagesPerLevel = positiveInt('pages', values.pages);
    console.log(`Throughput: ${target.name}, concurrency ${concurrencies.join('/')}, ${pagesPerLevel} pages per level\n`);
    await runThroughput({
      adapters: resolveAdapters(list(values.browsers)),
      target,
      concurrencies,
      pagesPerLevel,
      sampleIntervalMs: positiveInt('interval', values.interval),
      outDir: path.join(resultsDir, 'throughput'),
      log: (line) => console.log(line),
    });
    const { file } = await aggregateResults(resultsDir).catch(async (err) => {
      console.log(`(no campaign results to aggregate with: ${errorMessage(err)})`);
      return { file: null };
    });
    if (file) console.log(`Dashboard -> ${await generateDashboard(file, dashboardFile, { historyDir })}`);
    return;
  }

  if (command !== 'bench') throw new Error(`Unknown command "${command}"\n\n${HELP}`);

  const adapters = resolveAdapters(list(values.browsers));
  let targets = selectTargets(loadTargets(values.config), list(values.targets));
  if (values.timeout) {
    const timeoutMs = positiveInt('timeout', values.timeout);
    targets = targets.map((t) => ({ ...t, timeoutMs }));
  }
  if (values.order !== 'interleaved' && values.order !== 'sequential') throw new Error('--order must be interleaved or sequential');
  const modes = list(values.modes);
  if (!modes.length || modes.some((m) => m !== 'full' && m !== 'lite')) throw new Error('--modes accepts full and/or lite');
  const runs = positiveInt('runs', values.runs);
  const warmup = positiveInt('warmup', values.warmup, true);
  const rawDir = path.join(resultsDir, 'raw');
  const screensDir = path.join(resultsDir, 'screens');

  if (values.clean) {
    await clearJson(rawDir, '.json');
    await clearJson(screensDir, '.png');
  }

  const variants = adapters.length * modes.length;
  console.log(`Campaign: ${variants} browser variant(s) x ${targets.length} target(s) x (${warmup} warm-up + ${runs} run(s)), ${values.order}\n`);
  const startedAt = Date.now();
  const summary = await runCampaign({
    adapters,
    targets,
    runs,
    warmup,
    order: values.order as RunOrder,
    modes: modes as RunMode[],
    measureBytes: !values['no-bytes'],
    screenshots: !values['no-screenshots'],
    pauseMs: Number(values.pause),
    sampleIntervalMs: positiveInt('interval', values.interval),
    rawDir,
    screensDir,
    launchTimeoutMs: 60_000,
    closeTimeoutMs: 10_000,
    log: (line) => console.log(line),
  });
  const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1);
  console.log(`\n${summary.runs} runs (${summary.failures} failed) in ${minutes} min${summary.skippedBrowsers.length ? `, skipped: ${summary.skippedBrowsers.join(', ')}` : ''}`);
  if (!summary.runs) return;

  const { file, report } = await aggregateResults(resultsDir);
  if (!values['no-history']) console.log(`History -> ${await appendHistory(report, historyDir)}`);
  console.log(`Dashboard -> ${await generateDashboard(file, dashboardFile, { historyDir })}`);
}

// A browser killed mid-command can reject promises nobody awaits anymore; that must not end the campaign.
process.on('unhandledRejection', (reason) => {
  console.error(`(ignored late rejection: ${errorMessage(reason)})`);
});

main().catch((err) => {
  console.error(`Error: ${errorMessage(err)}`);
  process.exitCode = 1;
});

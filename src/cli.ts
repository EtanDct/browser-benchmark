import './env.js';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ADAPTERS, resolveAdapters } from './adapters/registry.js';
import { aggregate, campaignOf, latestCampaign, loadRawRecords, loadThroughputRecords, type AggregatedReport } from './aggregate/aggregator.js';
import { appendHistory } from './aggregate/history.js';
import { computeVisualScores } from './aggregate/visual.js';
import { loadTargets, selectTargets } from './config/targets.js';
import { generateDashboard } from '../dashboard/generate-dashboard.js';
import { runCampaign, type RunOrder } from './runner/benchmark-runner.js';
import { runThroughput } from './runner/throughput-runner.js';
import type { RunMode, RunRecord } from './runner/types.js';
import { errorMessage } from './util/time.js';

const HELP = `Usage:
  npm run bench -- [options]        run a campaign, then aggregate, record history and regenerate the dashboard
  npm run throughput -- [options]   pages/minute and memory per page with N pages in one browser
  npm run aggregate                 rebuild results/aggregated.json from results/raw (+ screens, throughput)
  npm run dashboard                 rebuild dashboard/index.html from results/aggregated.json
  npm run list                      list browsers (with availability) and targets
  npm run install-browsers          install Chrome for Testing (all Chromium drivers) and Playwright's Firefox and WebKit

Bench options:
  --browsers=<list>     adapter names, aliases (playwright, selenium, stealth, vanilla) or "all"  [all]
  --targets=<list>      target names, groups (antibot, performance, local) or "all"                [all]
  --runs=<n>            measured runs per (browser, target), for every target      [each target's "runs"]
  --warmup=<n>          unrecorded warm-up runs per browser, on a local page                       [1]
  --order=<o>           interleaved (browsers alternate every round) or sequential               [interleaved]
  --modes=<list>        full (normal pages) and/or lite (images, CSS, fonts, media blocked)        [full]
  --campaign=<id>       campaign id stored in every run; reuse it to split a campaign in several
                        commands (one history entry per id)                            [date and time]
  --resume              keep the runs already in results/raw and run only the missing ones
  --no-bytes            do not route remote pages through the byte-counting proxy
  --no-screenshots      do not capture screenshots for the visual comparison
  --no-history          do not add this campaign to results/history
  --pause=<ms>          pause between runs                                                         [2000]
  --interval=<ms>       RAM/CPU sampling interval                                                  [200]
  --timeout=<ms>        override every target's navigation timeout
  --config=<file>       targets file                                                   [config/targets.json]
  --results=<dir>       results directory                                                          [results]
  --clean               delete every previous result (raw runs, screenshots, throughput) first

  Without --resume, the (browser, target) pairs of the campaign replace their previous runs; other
  pairs stay in results/raw and in the dashboard.

Throughput options:
  --browsers=<list>     as above (browsers that cannot run several pages are skipped)            [all]
  --target=<list>       pages to load repeatedly                                  [local-heavy-js,local-spa]
  --concurrency=<list>  pages kept busy at once, one measurement per value                         [1,2,4,8]
  --pages=<n>           page loads per concurrency level                        [6 per page, at least 24]
`;

function list(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function newCampaignId(): string {
  return new Date().toISOString().slice(0, 16).replace(/:/g, '-');
}

function positiveInt(name: string, value: string, allowZero = false): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1)) throw new Error(`--${name} must be a ${allowZero ? 'non-negative' : 'positive'} integer (got "${value}")`);
  return n;
}

async function clearFiles(dir: string, extension: string): Promise<void> {
  const files = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(files.filter((f) => f.endsWith(extension)).map((f) => rm(path.join(dir, f))));
}

async function aggregateResults(resultsDir: string): Promise<{ file: string; report: AggregatedReport; records: RunRecord[] }> {
  const records = await loadRawRecords(path.join(resultsDir, 'raw'));
  if (!records.length) throw new Error(`No raw results in ${path.join(resultsDir, 'raw')}`);
  const visual = await computeVisualScores(records, path.join(resultsDir, 'screens'));
  const throughput = await loadThroughputRecords(path.join(resultsDir, 'throughput'));
  const report = aggregate(records, { visual: visual.scores, visualReferences: visual.references, throughput });
  const file = path.join(resultsDir, 'aggregated.json');
  await mkdir(resultsDir, { recursive: true });
  await writeFile(file, JSON.stringify(report, null, 1));
  console.log(`Aggregated ${records.length} runs${throughput.length ? ` + ${throughput.length} throughput tests` : ''} -> ${file}`);
  return { file, report, records };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      browsers: { type: 'string', default: 'all' },
      targets: { type: 'string', default: 'all' },
      target: { type: 'string', default: 'local-heavy-js,local-spa' },
      runs: { type: 'string' },
      warmup: { type: 'string', default: '1' },
      order: { type: 'string', default: 'interleaved' },
      modes: { type: 'string', default: 'full' },
      'no-bytes': { type: 'boolean', default: false },
      'no-screenshots': { type: 'boolean', default: false },
      'no-history': { type: 'boolean', default: false },
      campaign: { type: 'string' },
      resume: { type: 'boolean', default: false },
      concurrency: { type: 'string', default: '1,2,4,8' },
      pages: { type: 'string' },
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
    const require = createRequire(import.meta.url);
    const puppeteerCli = path.join(path.dirname(require.resolve('puppeteer/package.json')), 'lib', 'puppeteer', 'node', 'cli.js');
    const playwrightCli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
    console.log('Chrome for Testing (every Chromium driver launches this build):');
    const chrome = spawnSync(process.execPath, [puppeteerCli, 'browsers', 'install', 'chrome'], { stdio: 'inherit' });
    console.log(`Firefox and WebKit, into ${process.env.PLAYWRIGHT_BROWSERS_PATH ?? "Playwright's default location"}:`);
    const playwright = spawnSync(process.execPath, [playwrightCli, 'install', 'firefox', 'webkit'], { stdio: 'inherit' });
    process.exitCode = chrome.status || playwright.status || 0;
    return;
  }

  if (command === 'aggregate') {
    await aggregateResults(resultsDir);
    return;
  }

  if (command === 'throughput') {
    const targets = selectTargets(loadTargets(values.config), list(values.target));
    const concurrencies = list(values.concurrency).map((c) => positiveInt('concurrency', c));
    const pagesPerLevel = values.pages === undefined ? undefined : positiveInt('pages', values.pages);
    console.log(`Throughput: ${targets.map((t) => t.name).join(', ')}, concurrency ${concurrencies.join('/')}, ${pagesPerLevel ?? '6 x concurrency (min 24)'} pages per level\n`);
    await runThroughput({
      adapters: resolveAdapters(list(values.browsers)),
      targets,
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
  if (values.runs !== undefined) {
    const runs = positiveInt('runs', values.runs);
    targets = targets.map((t) => ({ ...t, runs }));
  }
  if (values.resume && values.clean) throw new Error('--resume keeps previous results, --clean deletes them: pick one');
  if (values.order !== 'interleaved' && values.order !== 'sequential') throw new Error('--order must be interleaved or sequential');
  const modes = list(values.modes);
  if (!modes.length || modes.some((m) => m !== 'full' && m !== 'lite')) throw new Error('--modes accepts full and/or lite');
  const warmup = positiveInt('warmup', values.warmup, true);
  const pauseMs = positiveInt('pause', values.pause, true);
  const rawDir = path.join(resultsDir, 'raw');
  const screensDir = path.join(resultsDir, 'screens');

  if (values.clean) {
    await clearFiles(rawDir, '.json');
    await clearFiles(screensDir, '.png');
    await clearFiles(path.join(resultsDir, 'throughput'), '.json');
  }
  const campaign = values.campaign
    ?? (values.resume ? latestCampaign(await loadRawRecords(rawDir)) : null)
    ?? newCampaignId();

  const variants = adapters.length * modes.length;
  const runsPerTarget = [...new Set(targets.map((t) => t.runs))].join('/');
  console.log(`Campaign ${campaign}: ${variants} browser variant(s) x ${targets.length} target(s) x ${runsPerTarget} run(s) + ${warmup} warm-up per browser, ${values.order}${values.resume ? ', resumed' : ''}\n`);
  const startedAt = Date.now();
  const summary = await runCampaign({
    adapters,
    targets,
    warmup,
    order: values.order as RunOrder,
    modes: modes as RunMode[],
    measureBytes: !values['no-bytes'],
    screenshots: !values['no-screenshots'],
    campaign,
    resume: values.resume,
    pauseMs,
    sampleIntervalMs: positiveInt('interval', values.interval),
    rawDir,
    screensDir,
    launchTimeoutMs: 60_000,
    closeTimeoutMs: 10_000,
    log: (line) => console.log(line),
  });
  const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1);
  console.log(`\n${summary.runs} runs (${summary.failures} failed) in ${minutes} min${summary.resumed ? `, ${summary.resumed} kept from before` : ''}${summary.skippedBrowsers.length ? `, skipped: ${summary.skippedBrowsers.join(', ')}` : ''}`);
  if (!summary.runs && !summary.resumed) return;

  const { file, records } = await aggregateResults(resultsDir);
  if (!values['no-history']) {
    // The history entry covers this campaign only, not every run left in results/raw.
    const own = records.filter((r) => campaignOf(r) === campaign);
    console.log(`History -> ${await appendHistory(aggregate(own), historyDir, campaign)}`);
  }
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

import './env.js';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ADAPTERS, resolveAdapters } from './adapters/registry.js';
import { aggregate, loadRawRecords } from './aggregate/aggregator.js';
import { loadTargets, selectTargets } from './config/targets.js';
import { generateDashboard } from '../dashboard/generate-dashboard.js';
import { runCampaign } from './runner/benchmark-runner.js';
import { errorMessage } from './util/time.js';

const HELP = `Usage:
  npm run bench -- [options]        run a campaign, then aggregate and regenerate the dashboard
  npm run aggregate                 rebuild results/aggregated.json from results/raw
  npm run dashboard                 rebuild dashboard/index.html from results/aggregated.json
  npm run list                      list browsers (with availability) and targets
  npm run install-browsers          install Playwright's Chromium, Firefox and WebKit (honours PLAYWRIGHT_BROWSERS_PATH / .env)

Bench options:
  --browsers=<list>     comma-separated adapter names, aliases (playwright, selenium) or "all"   [all]
  --targets=<list>      comma-separated target names, groups (antibot, performance, local) or "all" [all]
  --runs=<n>            iterations per (browser, target)                                        [10]
  --pause=<ms>          pause between runs                                                       [2000]
  --interval=<ms>       RAM/CPU sampling interval                                                [200]
  --timeout=<ms>        override every target's navigation timeout
  --config=<file>       targets file                                                  [config/targets.json]
  --results=<dir>       results directory                                                        [results]
  --clean               delete previous raw results before running
`;

function list(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function positiveInt(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer (got "${value}")`);
  return n;
}

async function aggregateResults(resultsDir: string): Promise<string> {
  const records = await loadRawRecords(path.join(resultsDir, 'raw'));
  if (!records.length) throw new Error(`No raw results in ${path.join(resultsDir, 'raw')}`);
  const report = aggregate(records);
  const file = path.join(resultsDir, 'aggregated.json');
  await mkdir(resultsDir, { recursive: true });
  await writeFile(file, JSON.stringify(report, null, 1));
  console.log(`Aggregated ${records.length} runs -> ${file}`);
  return file;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      browsers: { type: 'string', default: 'all' },
      targets: { type: 'string', default: 'all' },
      runs: { type: 'string', default: '10' },
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

  if (command === 'list') {
    for (const definition of ADAPTERS) {
      const availability = await definition.checkAvailability();
      const status = availability.available ? 'available' : 'unavailable';
      console.log(`${definition.name.padEnd(22)}${status.padEnd(13)}${definition.description}${availability.reason ? `\n${' '.repeat(35)}${availability.reason}` : ''}`);
    }
    console.log('');
    for (const target of loadTargets(values.config)) {
      console.log(`${target.group.padEnd(13)}${target.name.padEnd(20)}${target.url}`);
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

  if (command !== 'bench') throw new Error(`Unknown command "${command}"\n\n${HELP}`);

  const adapters = resolveAdapters(list(values.browsers));
  let targets = selectTargets(loadTargets(values.config), list(values.targets));
  if (values.timeout) {
    const timeoutMs = positiveInt('timeout', values.timeout);
    targets = targets.map((t) => ({ ...t, timeoutMs }));
  }
  const runs = positiveInt('runs', values.runs);
  const rawDir = path.join(resultsDir, 'raw');

  if (values.clean) {
    const files = await readdir(rawDir).catch(() => [] as string[]);
    await Promise.all(files.filter((f) => f.endsWith('.json')).map((f) => rm(path.join(rawDir, f))));
  }

  console.log(`Campaign: ${adapters.length} browser(s) x ${targets.length} target(s) x ${runs} run(s), sequential\n`);
  const startedAt = Date.now();
  const summary = await runCampaign({
    adapters,
    targets,
    runs,
    pauseMs: Number(values.pause),
    sampleIntervalMs: positiveInt('interval', values.interval),
    rawDir,
    launchTimeoutMs: 60_000,
    closeTimeoutMs: 10_000,
    log: (line) => console.log(line),
  });
  const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1);
  console.log(`\n${summary.runs} runs (${summary.failures} failed) in ${minutes} min${summary.skippedBrowsers.length ? `, skipped: ${summary.skippedBrowsers.join(', ')}` : ''}`);
  if (!summary.runs) return;

  const aggregatedFile = await aggregateResults(resultsDir);
  const dashboardFile = await generateDashboard(aggregatedFile, path.resolve('dashboard/index.html'));
  console.log(`Dashboard -> ${dashboardFile}`);
}

// A browser killed mid-command can reject promises nobody awaits anymore; that must not end the campaign.
process.on('unhandledRejection', (reason) => {
  console.error(`(ignored late rejection: ${errorMessage(reason)})`);
});

main().catch((err) => {
  console.error(`Error: ${errorMessage(err)}`);
  process.exitCode = 1;
});

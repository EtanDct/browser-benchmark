import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AdapterDefinition, ProcessLocation } from '../adapters/base.js';
import { isAntiBotTarget, type Target } from '../config/targets.js';
import { summarizeSamples, type ResourceSampler } from '../monitor/resource-sampler.js';
import { killTree } from '../util/proc.js';
import { errorMessage, sleep, TimeoutError, withTimeout } from '../util/time.js';
import { wslKill } from '../util/wsl.js';
import { prepareRuntime, type Runtime } from './runtime.js';
import { RUN_SCHEMA_VERSION, type EnvironmentInfo, type RunMode, type RunRecord } from './types.js';

export type RunOrder = 'interleaved' | 'sequential';

export interface CampaignOptions {
  adapters: AdapterDefinition[];
  /** Each target carries its own number of measured runs (Target.runs). */
  targets: Target[];
  /**
   * Unrecorded runs per browser variant before its measured ones, on one local page: they warm the
   * disk cache and the WSL VM, which is per browser, not per page.
   */
  warmup: number;
  /**
   * interleaved: every round runs each browser once on each target, with the starting browser rotating
   * from round to round, so network or machine drift spreads over all browsers instead of hitting one.
   */
  order: RunOrder;
  modes: RunMode[];
  /** Route remote pages through the byte-counting proxy. */
  measureBytes: boolean;
  /** Capture a screenshot on the first successful measured run of targets marked visual. */
  screenshots: boolean;
  /** Stored in every record: a history entry aggregates the runs of one campaign only. */
  campaign: string;
  /** Keep the raw results already on disk and only run what is missing (after an interruption). */
  resume: boolean;
  pauseMs: number;
  sampleIntervalMs: number;
  rawDir: string;
  screensDir: string;
  launchTimeoutMs: number;
  closeTimeoutMs: number;
  log: (line: string) => void;
}

export interface CampaignSummary {
  runs: number;
  failures: number;
  /** Measured runs found on disk and skipped by --resume. */
  resumed: number;
  skippedBrowsers: string[];
  files: string[];
}

export function environmentInfo(): EnvironmentInfo {
  const cpus = os.cpus();
  return {
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    cpuModel: cpus[0]?.model.trim() ?? 'unknown',
    cpuCount: cpus.length,
    totalMemBytes: os.totalmem(),
    nodeVersion: process.version,
  };
}

/** Margin on top of the navigation budget before the runner gives up on a stuck adapter. */
const HARD_TIMEOUT_MARGIN_MS = 15_000;
export const SCREENSHOT_SIZE = { width: 1280, height: 800 };

export interface Variant {
  definition: AdapterDefinition;
  mode: RunMode;
  /** Row key in reports. */
  key: string;
}

export interface Job {
  variant: Variant;
  target: Target;
  /** 1..target.runs for measured runs; <= 0 for warm-up runs. */
  run: number;
}

interface RunContext {
  job: Job;
  url: string;
  runtime: Runtime;
  wantsScreenshot: boolean;
  options: CampaignOptions;
  environment: EnvironmentInfo;
}

const isLocal = (target: Target) => target.url.startsWith('local://');

export function rawFileName(key: string, target: string, run: number): string {
  return `${key}_${target}_${run}.json`;
}

/** A local page if there is one (no network noise, no challenge wait), else the first performance page. */
export function warmupTarget(targets: Target[]): Target | undefined {
  return targets.find(isLocal) ?? targets.find((t) => !isAntiBotTarget(t)) ?? targets[0];
}

export function buildJobs(variants: Variant[], targets: Target[], warmup: number, order: RunOrder): Job[] {
  const jobs: Job[] = [];
  const warm = warmupTarget(targets);
  const warmups = (variant: Variant) => {
    if (warm) for (let w = 1; w <= warmup; w++) jobs.push({ variant, target: warm, run: w - warmup });
  };
  if (order === 'sequential') {
    for (const variant of variants) {
      warmups(variant);
      for (const target of targets) for (let run = 1; run <= target.runs; run++) jobs.push({ variant, target, run });
    }
    return jobs;
  }
  variants.forEach(warmups);
  const rounds = Math.max(0, ...targets.map((t) => t.runs));
  for (let run = 1; run <= rounds; run++) {
    const shift = (run - 1) % variants.length;
    const rotated = [...variants.slice(shift), ...variants.slice(0, shift)];
    for (const target of targets) {
      if (run > target.runs) continue;
      for (const variant of rotated) jobs.push({ variant, target, run });
    }
  }
  return jobs;
}

/** --resume: drop measured runs already on disk, and the warm-ups of browsers left with nothing to run. */
export function pendingJobs(jobs: Job[], done: Set<string>): Job[] {
  const measured = new Set(jobs.filter((j) => j.run > 0 && !done.has(rawFileName(j.variant.key, j.target.name, j.run))));
  const busy = new Set([...measured].map((j) => j.variant.key));
  return jobs.filter((j) => (j.run > 0 ? measured.has(j) : busy.has(j.variant.key)));
}

/**
 * A new campaign replaces the cells it measures: runs left from an older campaign with more runs
 * (run 6..10 after --runs=5) would otherwise be aggregated with the new ones.
 */
async function clearCells(variants: Variant[], targets: Target[], rawDir: string, screensDir: string): Promise<void> {
  const prefixes = new Set(variants.flatMap((v) => targets.map((t) => `${v.key}_${t.name}_`)));
  const files = await readdir(rawDir).catch(() => [] as string[]);
  await Promise.all(files
    .filter((f) => /_-?\d+\.json$/.test(f) && prefixes.has(f.replace(/-?\d+\.json$/, '')))
    .map((f) => rm(path.join(rawDir, f))));
  await Promise.all(variants.flatMap((v) => targets.map((t) => rm(path.join(screensDir, `${v.key}_${t.name}.png`), { force: true }))));
}

/** Resolves every remote host once, so the first browser to reach a site does not pay its DNS lookup alone. */
async function prewarmDns(targets: Target[]): Promise<void> {
  const hosts = new Set(targets.filter((t) => !isLocal(t)).map((t) => new URL(t.url).hostname));
  await Promise.allSettled([...hosts].map((host) => lookup(host)));
}

async function executeRun(ctx: RunContext): Promise<RunRecord> {
  const { job, options, runtime } = ctx;
  const { variant, target } = job;
  const record: RunRecord = {
    schemaVersion: RUN_SCHEMA_VERSION,
    browser: variant.key,
    adapter: variant.definition.name,
    mode: variant.mode,
    stealth: variant.definition.stealth || undefined,
    engine: variant.definition.engine,
    campaign: options.campaign,
    target: target.name,
    targetGroup: target.group,
    url: target.url,
    run: job.run,
    startedAt: new Date().toISOString(),
    navigation: { success: false, loadTimeMs: 0 },
    resources: null,
    environment: ctx.environment,
  };

  // Local pages bypass the proxy: Playwright would route loopback through it, Chrome would not, and
  // their bytes are not reported anyway. A new browser is launched per run, so this is per page.
  const proxy = isLocal(target) ? null : runtime.proxy;
  const adapter = variant.definition.create();
  let pid: number | null = null;
  let location: ProcessLocation = 'host';
  let sampler: ResourceSampler | undefined;

  try {
    const launchStart = Date.now();
    const launched = await withTimeout(adapter.launch({ proxyUrl: proxy?.url }), options.launchTimeoutMs, 'launch');
    pid = launched.pid;
    location = launched.location ?? 'host';
    record.launchTimeMs = Date.now() - launchStart;
    record.browserVersion = await withTimeout(adapter.version?.() ?? Promise.resolve('unknown'), 5_000, 'version').catch(() => 'unknown');

    if (pid !== null) {
      sampler = await runtime.samplerFor(location);
      sampler?.begin(pid);
    }
    const navOptions = {
      timeoutMs: target.timeoutMs,
      settleMs: target.settleMs,
      challengeWaitMs: target.antiBot ? target.challengeWaitMs : 0,
      antiBot: target.antiBot,
      blockResources: variant.mode === 'lite',
    };
    const hardLimit = target.timeoutMs + target.settleMs + navOptions.challengeWaitMs + HARD_TIMEOUT_MARGIN_MS;
    proxy?.reset();
    record.navigation = await withTimeout(adapter.navigate(ctx.url, navOptions), hardLimit, 'navigation');
    if (proxy) record.network = proxy.read();
  } catch (err) {
    record.error = errorMessage(err);
    record.timedOut = err instanceof TimeoutError;
    record.navigation = { ...record.navigation, success: false, errorMessage: record.navigation.errorMessage ?? record.error };
  } finally {
    if (sampler) {
      const samples = sampler.end();
      record.resources = {
        memoryMetric: sampler.memoryMetric,
        sampleIntervalMs: options.sampleIntervalMs,
        summary: summarizeSamples(samples, sampler.memoryMetric),
        samples,
      };
    }
    // Outside the monitoring window: the resize and capture are not part of loading the page.
    if (ctx.wantsScreenshot && record.navigation.success && adapter.screenshot) {
      try {
        const png = await withTimeout(adapter.screenshot(SCREENSHOT_SIZE.width, SCREENSHOT_SIZE.height), 20_000, 'screenshot');
        const file = `${record.browser}_${record.target}.png`;
        await writeFile(path.join(options.screensDir, file), png);
        record.screenshot = file;
      } catch {
        // A missing screenshot only removes this browser from the visual comparison.
      }
    }
    try {
      await withTimeout(adapter.close(), options.closeTimeoutMs, 'close');
    } catch {
      record.forcedKill = true;
    }
    // Kill whatever survived close(): a leaked renderer would skew the next run's measurements.
    if (pid !== null && (record.forcedKill || record.timedOut)) await (location === 'wsl' ? wslKill(pid) : killTree(pid));
  }
  return record;
}

function formatRunLine(record: RunRecord, position: string): string {
  const nav = record.navigation;
  const head = `${position} [${record.browser}] ${record.target} ${record.run > 0 ? `#${record.run}` : '(chauffe)'}`;
  if (!nav.success) return `${head}  FAIL  ${record.error ?? nav.errorMessage ?? 'unknown error'}`;
  const parts = [`${head}  ok  ${nav.loadTimeMs}ms`];
  if (nav.httpStatus) parts.push(`HTTP ${nav.httpStatus}`);
  const summary = record.resources?.summary;
  if (summary?.memBytes) parts.push(`mem avg ${(summary.memBytes.avg / 2 ** 20).toFixed(0)}MB peak ${(summary.memBytes.max / 2 ** 20).toFixed(0)}MB`);
  if (summary?.cpuSeconds !== undefined && summary.cpuSeconds !== null) parts.push(`cpu ${summary.cpuSeconds.toFixed(2)}s`);
  if (record.network) parts.push(`net ${(record.network.bytesDown / 2 ** 20).toFixed(2)}MB`);
  if (nav.content && nav.content.score < 1) parts.push(`content ${nav.content.checks.map((c) => `${c.found}/${c.expected} ${c.selector}`).join(', ')}`);
  if (nav.antiBot) parts.push(`antibot ${nav.antiBot.outcome} (${nav.antiBot.detail})`);
  return parts.join('  ');
}

export async function runCampaign(options: CampaignOptions): Promise<CampaignSummary> {
  const { log } = options;
  const summary: CampaignSummary = { runs: 0, failures: 0, resumed: 0, skippedBrowsers: [], files: [] };

  const runtime = await prepareRuntime({
    adapters: options.adapters,
    fixtures: options.targets.some(isLocal),
    byteProxy: options.measureBytes && options.targets.some((t) => !isLocal(t)),
    sampleIntervalMs: options.sampleIntervalMs,
    log,
  });
  summary.skippedBrowsers = runtime.skipped;
  try {
    const variants: Variant[] = options.modes.flatMap((mode) => runtime.available
      .filter((d) => mode === 'full' || d.supportsLite)
      .map((definition) => ({ definition, mode, key: mode === 'lite' ? `${definition.name}+lite` : definition.name })));
    if (!variants.length) {
      log('No available browser to benchmark.');
      return summary;
    }

    await mkdir(options.rawDir, { recursive: true });
    if (options.screenshots) await mkdir(options.screensDir, { recursive: true });
    let jobs = buildJobs(variants, options.targets, options.warmup, options.order);
    const measuredTotal = jobs.filter((j) => j.run > 0).length;
    if (options.resume) {
      jobs = pendingJobs(jobs, new Set(await readdir(options.rawDir).catch(() => [] as string[])));
      summary.resumed = measuredTotal - jobs.filter((j) => j.run > 0).length;
      log(`resume: ${summary.resumed} of ${measuredTotal} measured runs already done`);
    } else {
      await clearCells(variants, options.targets, options.rawDir, options.screensDir);
    }
    const shotTaken = new Set(variants.flatMap((v) => options.targets
      .filter((t) => existsSync(path.join(options.screensDir, `${v.key}_${t.name}.png`)))
      .map((t) => `${v.key}\u0000${t.name}`)));

    await prewarmDns(options.targets);
    const environment = environmentInfo();
    for (const [index, job] of jobs.entries()) {
      const url = runtime.fixtures && isLocal(job.target) ? runtime.fixtures.resolve(job.target.url) : job.target.url;
      const cell = `${job.variant.key}\u0000${job.target.name}`;
      const wantsScreenshot = options.screenshots && job.run > 0 && job.target.visual && job.variant.mode === 'full' && !shotTaken.has(cell);
      const record = await executeRun({ job, url, runtime, wantsScreenshot, options, environment });
      if (record.screenshot) shotTaken.add(cell);
      const position = `${String(index + 1).padStart(String(jobs.length).length)}/${jobs.length}`;
      log(formatRunLine(record, position));
      if (job.run > 0) {
        const file = path.join(options.rawDir, rawFileName(record.browser, record.target, record.run));
        await writeFile(file, JSON.stringify(record, null, 1));
        summary.runs++;
        if (!record.navigation.success) summary.failures++;
        summary.files.push(file);
      }
      if (index < jobs.length - 1) await sleep(options.pauseMs);
    }
  } finally {
    await runtime.dispose();
  }
  return summary;
}

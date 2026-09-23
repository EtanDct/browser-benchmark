import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AdapterDefinition, ProcessLocation } from '../adapters/base.js';
import type { Target } from '../config/targets.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server.js';
import { ResourceSampler, summarizeSamples } from '../monitor/resource-sampler.js';
import { startByteProxy, type ByteProxy } from '../network/byte-proxy.js';
import { killTree } from '../util/proc.js';
import { errorMessage, sleep, TimeoutError, withTimeout } from '../util/time.js';
import { wslKill } from '../util/wsl.js';
import { RUN_SCHEMA_VERSION, type EnvironmentInfo, type RunMode, type RunRecord } from './types.js';

export type RunOrder = 'interleaved' | 'sequential';

export interface CampaignOptions {
  adapters: AdapterDefinition[];
  targets: Target[];
  runs: number;
  /** Unrecorded runs per (browser, target) before the measured ones: disk cache, DNS, WSL VM. */
  warmup: number;
  /**
   * interleaved: every round runs each browser once on each target, with the starting browser rotating
   * from round to round, so network or machine drift spreads over all browsers instead of hitting one.
   */
  order: RunOrder;
  modes: RunMode[];
  /** Route traffic through the byte-counting proxy. */
  measureBytes: boolean;
  /** Capture a screenshot on the first measured run of targets marked visual. */
  screenshots: boolean;
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

interface Variant {
  definition: AdapterDefinition;
  mode: RunMode;
  /** Row key in reports. */
  key: string;
}

interface Job {
  variant: Variant;
  target: Target;
  /** 1..runs for measured runs; <= 0 for warm-up runs. */
  run: number;
}

interface RunContext {
  job: Job;
  url: string;
  samplers: Partial<Record<ProcessLocation, ResourceSampler>>;
  proxy: ByteProxy | null;
  options: CampaignOptions;
  environment: EnvironmentInfo;
}

export function buildJobs(variants: Variant[], targets: Target[], runs: number, warmup: number, order: RunOrder): Job[] {
  const jobs: Job[] = [];
  const firstRun = 1 - warmup;
  if (order === 'sequential') {
    for (const variant of variants) for (const target of targets) for (let run = firstRun; run <= runs; run++) jobs.push({ variant, target, run });
    return jobs;
  }
  for (let run = firstRun; run <= runs; run++) {
    const shift = ((run - firstRun) % variants.length + variants.length) % variants.length;
    const rotated = [...variants.slice(shift), ...variants.slice(0, shift)];
    for (const target of targets) for (const variant of rotated) jobs.push({ variant, target, run });
  }
  return jobs;
}

async function executeRun(ctx: RunContext): Promise<RunRecord> {
  const { job, options, proxy } = ctx;
  const { variant, target } = job;
  const record: RunRecord = {
    schemaVersion: RUN_SCHEMA_VERSION,
    browser: variant.key,
    adapter: variant.definition.name,
    mode: variant.mode,
    stealth: variant.definition.stealth || undefined,
    target: target.name,
    targetGroup: target.group,
    url: target.url,
    run: job.run,
    startedAt: new Date().toISOString(),
    navigation: { success: false, loadTimeMs: 0 },
    resources: null,
    environment: ctx.environment,
  };

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

    const locationSampler = ctx.samplers[location];
    if (pid !== null && locationSampler) {
      sampler = locationSampler;
      locationSampler.begin(pid);
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
    // Local fixtures bypass the proxy in most browsers (loopback), so bytes are only comparable on remote pages.
    if (proxy && !target.url.startsWith('local://')) record.network = proxy.read();
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
    const wantsShot = options.screenshots && job.run === 1 && target.visual && variant.mode === 'full' && record.navigation.success;
    if (wantsShot && adapter.screenshot) {
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
  if (summary?.cpuPercent) parts.push(`cpu avg ${summary.cpuPercent.avg.toFixed(0)}%`);
  if (record.network) parts.push(`net ${(record.network.bytesDown / 2 ** 20).toFixed(2)}MB`);
  if (nav.antiBot) parts.push(`antibot ${nav.antiBot.outcome} (${nav.antiBot.detail})`);
  return parts.join('  ');
}

export async function runCampaign(options: CampaignOptions): Promise<CampaignSummary> {
  const { log } = options;
  const summary: CampaignSummary = { runs: 0, failures: 0, skippedBrowsers: [], files: [] };

  const available: AdapterDefinition[] = [];
  const wslHostIps = new Set<string>();
  for (const definition of options.adapters) {
    const availability = await definition.checkAvailability();
    if (!availability.available) {
      log(`skip ${definition.name}: ${availability.reason}`);
      summary.skippedBrowsers.push(definition.name);
      continue;
    }
    if (availability.reason) log(`note ${definition.name}: ${availability.reason}`);
    if (availability.wslHostIp) wslHostIps.add(availability.wslHostIp);
    available.push(definition);
  }
  const variants: Variant[] = options.modes.flatMap((mode) => available
    .filter((d) => mode === 'full' || d.supportsLite)
    .map((definition) => ({ definition, mode, key: mode === 'lite' ? `${definition.name}+lite` : definition.name })));
  if (!variants.length) {
    log('No available browser to benchmark.');
    return summary;
  }

  await mkdir(options.rawDir, { recursive: true });
  if (options.screenshots) await mkdir(options.screensDir, { recursive: true });
  let fixtures: FixtureServer | null = null;
  if (options.targets.some((t) => t.url.startsWith('local://'))) fixtures = await startFixtureServer([...wslHostIps]);
  const proxy = options.measureBytes ? await startByteProxy([...wslHostIps]) : null;

  // The WSL sampler is started up front: it also keeps the WSL VM running, so a VM boot never
  // lands inside a measured launch.
  const samplers: Partial<Record<ProcessLocation, ResourceSampler>> = {};
  const locations: ProcessLocation[] = wslHostIps.size ? ['host', 'wsl'] : ['host'];
  for (const location of locations) {
    try {
      samplers[location] = await ResourceSampler.create(options.sampleIntervalMs, location);
    } catch (err) {
      log(`warning: ${location} resource monitoring disabled (${errorMessage(err)})`);
    }
  }

  const jobs = buildJobs(variants, options.targets, options.runs, options.warmup, options.order);
  const environment = environmentInfo();
  try {
    for (const [index, job] of jobs.entries()) {
      const url = fixtures ? fixtures.resolve(job.target.url) : job.target.url;
      const record = await executeRun({ job, url, samplers, proxy, options, environment });
      const position = `${String(index + 1).padStart(String(jobs.length).length)}/${jobs.length}`;
      log(formatRunLine(record, position));
      if (job.run > 0) {
        const file = path.join(options.rawDir, `${record.browser}_${record.target}_${record.run}.json`);
        await writeFile(file, JSON.stringify(record, null, 1));
        summary.runs++;
        if (!record.navigation.success) summary.failures++;
        summary.files.push(file);
      }
      await sleep(options.pauseMs);
    }
  } finally {
    await Promise.all(Object.values(samplers).map((s) => s.dispose()));
    await proxy?.close();
    await fixtures?.close();
  }
  return summary;
}

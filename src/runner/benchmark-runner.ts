import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AdapterDefinition, ProcessLocation } from '../adapters/base.js';
import type { Target } from '../config/targets.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server.js';
import { ResourceSampler, summarizeSamples } from '../monitor/resource-sampler.js';
import { killTree } from '../util/proc.js';
import { errorMessage, sleep, TimeoutError, withTimeout } from '../util/time.js';
import { wslKill } from '../util/wsl.js';
import { RUN_SCHEMA_VERSION, type EnvironmentInfo, type RunRecord } from './types.js';

export interface CampaignOptions {
  adapters: AdapterDefinition[];
  targets: Target[];
  runs: number;
  pauseMs: number;
  sampleIntervalMs: number;
  rawDir: string;
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

interface RunContext {
  definition: AdapterDefinition;
  target: Target;
  url: string;
  run: number;
  samplers: Partial<Record<ProcessLocation, ResourceSampler>>;
  options: CampaignOptions;
  environment: EnvironmentInfo;
}

async function executeRun(ctx: RunContext): Promise<RunRecord> {
  const { definition, target, options } = ctx;
  const record: RunRecord = {
    schemaVersion: RUN_SCHEMA_VERSION,
    browser: definition.name,
    target: target.name,
    targetGroup: target.group,
    url: target.url,
    run: ctx.run,
    startedAt: new Date().toISOString(),
    navigation: { success: false, loadTimeMs: 0 },
    resources: null,
    environment: ctx.environment,
  };

  const adapter = definition.create();
  let pid: number | null = null;
  let location: ProcessLocation = 'host';
  let sampler: ResourceSampler | undefined;

  try {
    const launchStart = Date.now();
    const launched = await withTimeout(adapter.launch(), options.launchTimeoutMs, 'launch');
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
    };
    const hardLimit = target.timeoutMs + target.settleMs + navOptions.challengeWaitMs + HARD_TIMEOUT_MARGIN_MS;
    record.navigation = await withTimeout(adapter.navigate(ctx.url, navOptions), hardLimit, 'navigation');
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

function formatRunLine(record: RunRecord, total: number): string {
  const nav = record.navigation;
  const head = `[${record.browser}] ${record.target} #${record.run}/${total}`;
  if (!nav.success) return `${head}  FAIL  ${record.error ?? nav.errorMessage ?? 'unknown error'}`;
  const parts = [`${head}  ok  ${nav.loadTimeMs}ms`];
  if (nav.httpStatus) parts.push(`HTTP ${nav.httpStatus}`);
  const summary = record.resources?.summary;
  if (summary?.memBytes) parts.push(`mem avg ${(summary.memBytes.avg / 2 ** 20).toFixed(0)}MB peak ${(summary.memBytes.max / 2 ** 20).toFixed(0)}MB`);
  if (summary?.cpuPercent) parts.push(`cpu avg ${summary.cpuPercent.avg.toFixed(0)}%`);
  if (nav.antiBot) parts.push(`antibot ${nav.antiBot.outcome} (${nav.antiBot.detail})`);
  return parts.join('  ');
}

export async function runCampaign(options: CampaignOptions): Promise<CampaignSummary> {
  const { log } = options;
  const summary: CampaignSummary = { runs: 0, failures: 0, skippedBrowsers: [], files: [] };

  const adapters: AdapterDefinition[] = [];
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
    adapters.push(definition);
  }
  if (!adapters.length) {
    log('No available browser to benchmark.');
    return summary;
  }

  await mkdir(options.rawDir, { recursive: true });
  let fixtures: FixtureServer | null = null;
  if (options.targets.some((t) => t.url.startsWith('local://'))) fixtures = await startFixtureServer([...wslHostIps]);

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

  const environment = environmentInfo();
  try {
    for (const definition of adapters) {
      for (const target of options.targets) {
        const url = fixtures ? fixtures.resolve(target.url) : target.url;
        for (let run = 1; run <= options.runs; run++) {
          const record = await executeRun({ definition, target, url, run, samplers, options, environment });
          const file = path.join(options.rawDir, `${record.browser}_${record.target}_${record.run}.json`);
          await writeFile(file, JSON.stringify(record, null, 1));
          summary.runs++;
          if (!record.navigation.success) summary.failures++;
          summary.files.push(file);
          log(formatRunLine(record, options.runs));
          await sleep(options.pauseMs);
        }
      }
    }
  } finally {
    await Promise.all(Object.values(samplers).map((s) => s.dispose()));
    await fixtures?.close();
  }
  return summary;
}

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AdapterDefinition, NavigateOptions, ProcessLocation } from '../adapters/base.js';
import type { Target } from '../config/targets.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server.js';
import { ResourceSampler, summarizeSamples } from '../monitor/resource-sampler.js';
import { killTree } from '../util/proc.js';
import { errorMessage, withTimeout } from '../util/time.js';
import { wslKill } from '../util/wsl.js';
import { environmentInfo } from './benchmark-runner.js';
import type { ThroughputLevel, ThroughputRecord } from './throughput-types.js';

export interface ThroughputOptions {
  adapters: AdapterDefinition[];
  target: Target;
  /** Pages kept busy at once, one measurement per value. */
  concurrencies: number[];
  /** Page loads processed at each concurrency level. */
  pagesPerLevel: number;
  sampleIntervalMs: number;
  outDir: string;
  log: (line: string) => void;
}

const MB = 2 ** 20;
const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Scraping at scale: one browser, N pages pulling from a shared queue of page loads. Measures pages
 * per minute and the memory each extra page costs, which single-page runs cannot show.
 */
export async function runThroughput(options: ThroughputOptions): Promise<ThroughputRecord[]> {
  const { log, target } = options;
  const eligible: AdapterDefinition[] = [];
  const wslHostIps = new Set<string>();
  for (const definition of options.adapters) {
    const availability = await definition.checkAvailability();
    if (!availability.available) {
      log(`skip ${definition.name}: ${availability.reason}`);
      continue;
    }
    if (!definition.create().openPages) {
      log(`skip ${definition.name}: cannot run several pages in one browser`);
      continue;
    }
    if (availability.wslHostIp) wslHostIps.add(availability.wslHostIp);
    eligible.push(definition);
  }

  await mkdir(options.outDir, { recursive: true });
  let fixtures: FixtureServer | null = null;
  if (target.url.startsWith('local://')) fixtures = await startFixtureServer([...wslHostIps]);
  const url = fixtures ? fixtures.resolve(target.url) : target.url;
  const samplers: Partial<Record<ProcessLocation, ResourceSampler>> = {};
  for (const location of (wslHostIps.size ? ['host', 'wsl'] : ['host']) as ProcessLocation[]) {
    try {
      samplers[location] = await ResourceSampler.create(options.sampleIntervalMs, location);
    } catch (err) {
      log(`warning: ${location} resource monitoring disabled (${errorMessage(err)})`);
    }
  }

  const navOptions: NavigateOptions = { timeoutMs: target.timeoutMs, settleMs: 0, challengeWaitMs: 0 };
  const records: ThroughputRecord[] = [];
  try {
    for (const definition of eligible) {
      const record: ThroughputRecord = {
        schemaVersion: 1,
        browser: definition.name,
        stealth: definition.stealth || undefined,
        target: target.name,
        url: target.url,
        startedAt: new Date().toISOString(),
        memoryMetric: null,
        levels: [],
        environment: environmentInfo(),
      };
      const adapter = definition.create();
      let pid: number | null = null;
      let location: ProcessLocation = 'host';
      try {
        const launched = await withTimeout(adapter.launch(), 60_000, 'launch');
        pid = launched.pid;
        location = launched.location ?? 'host';
        record.browserVersion = await adapter.version?.().catch(() => 'unknown');
        const sampler = pid !== null ? samplers[location] : undefined;
        record.memoryMetric = sampler?.memoryMetric ?? null;

        for (const concurrency of options.concurrencies) {
          const pages = await withTimeout(adapter.openPages!(concurrency), 60_000, 'open pages');
          if (sampler && pid !== null) sampler.begin(pid);
          let next = 0;
          let successes = 0;
          const errors = new Set<string>();
          const startedAt = Date.now();
          const worker = async (page: (typeof pages)[number]) => {
            while (next < options.pagesPerLevel) {
              next++;
              const result = await page.navigate(url, navOptions).catch((err) => ({ success: false, errorMessage: errorMessage(err) }));
              if (result.success) successes++;
              else if (result.errorMessage && errors.size < 3) errors.add(result.errorMessage);
            }
          };
          const budget = Math.ceil(options.pagesPerLevel / concurrency) * (target.timeoutMs + 5_000) + 30_000;
          await withTimeout(Promise.all(pages.map(worker)), budget, `throughput x${concurrency}`);
          const durationMs = Date.now() - startedAt;
          const summary = sampler ? summarizeSamples(sampler.end(), sampler.memoryMetric) : null;
          await Promise.all(pages.map((p) => p.close()));

          const level: ThroughputLevel = {
            concurrency,
            pages: options.pagesPerLevel,
            successes,
            durationMs,
            pagesPerMinute: round1(successes / (durationMs / 60_000)),
            memAvgMB: summary?.memBytes ? round1(summary.memBytes.avg / MB) : null,
            memPeakMB: summary?.memBytes ? round1(summary.memBytes.max / MB) : null,
            cpuAvgPercent: summary?.cpuPercent ? round1(summary.cpuPercent.avg) : null,
            errors: errors.size ? [...errors] : undefined,
          };
          record.levels.push(level);
          log(`[${definition.name}] x${concurrency}  ${level.pagesPerMinute} pages/min  ${successes}/${level.pages} ok` +
            (level.memPeakMB !== null ? `  mem peak ${level.memPeakMB}MB` : '') + (errors.size ? `  (${[...errors][0]})` : ''));
        }
      } catch (err) {
        record.error = errorMessage(err);
        log(`[${definition.name}] FAIL  ${record.error}`);
        for (const sampler of Object.values(samplers)) sampler.end();
      } finally {
        try {
          await withTimeout(adapter.close(), 15_000, 'close');
        } catch {
          if (pid !== null) await (location === 'wsl' ? wslKill(pid) : killTree(pid));
        }
      }
      records.push(record);
      await writeFile(path.join(options.outDir, `${record.browser}_${record.target}.json`), JSON.stringify(record, null, 1));
    }
  } finally {
    await Promise.all(Object.values(samplers).map((s) => s.dispose()));
    await fixtures?.close();
  }
  return records;
}

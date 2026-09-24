import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AdapterDefinition, NavigateOptions, PageHandle, ProcessLocation } from '../adapters/base.js';
import type { Target } from '../config/targets.js';
import { summarizeSamples } from '../monitor/resource-sampler.js';
import { killTree } from '../util/proc.js';
import { errorMessage, withTimeout } from '../util/time.js';
import { wslKill } from '../util/wsl.js';
import { environmentInfo } from './benchmark-runner.js';
import { prepareRuntime } from './runtime.js';
import type { ThroughputLevel, ThroughputRecord } from './throughput-types.js';

export interface ThroughputOptions {
  adapters: AdapterDefinition[];
  targets: Target[];
  /** Pages kept busy at once, one measurement per value. */
  concurrencies: number[];
  /** Page loads per level; by default 6 per page kept busy (24 at least), so every level runs long enough. */
  pagesPerLevel?: number;
  sampleIntervalMs: number;
  outDir: string;
  log: (line: string) => void;
}

const MB = 2 ** 20;
const round1 = (v: number) => Math.round(v * 10) / 10;
const CLOSE_TIMEOUT_MS = 15_000;

export function pagesForLevel(concurrency: number, pagesPerLevel?: number): number {
  return pagesPerLevel ?? Math.max(24, 6 * concurrency);
}

/** Closing a stalled page (Camoufox) can hang: give up on it rather than on the whole test. */
async function closePages(pages: PageHandle[]): Promise<void> {
  await Promise.all(pages.map((p) => withTimeout(p.close(), CLOSE_TIMEOUT_MS, 'page close').catch(() => undefined)));
}

/**
 * Scraping at scale: one browser, N pages pulling from a shared queue of page loads. Measures pages
 * per minute and the memory each extra page costs, which single-page runs cannot show.
 */
export async function runThroughput(options: ThroughputOptions): Promise<ThroughputRecord[]> {
  const { log } = options;
  const runtime = await prepareRuntime({
    adapters: options.adapters,
    exclude: (definition) => (definition.create().openPages ? null : 'cannot run several pages in one browser'),
    fixtures: options.targets.some((t) => t.url.startsWith('local://')),
    byteProxy: false,
    sampleIntervalMs: options.sampleIntervalMs,
    log,
  });

  await mkdir(options.outDir, { recursive: true });
  const records: ThroughputRecord[] = [];
  try {
    for (const target of options.targets) {
      const url = runtime.fixtures && target.url.startsWith('local://') ? runtime.fixtures.resolve(target.url) : target.url;
      const navOptions: NavigateOptions = { timeoutMs: target.timeoutMs, settleMs: 0, challengeWaitMs: 0 };
      for (const definition of runtime.available) {
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
          record.browserVersion = await withTimeout(adapter.version?.() ?? Promise.resolve('unknown'), 5_000, 'version').catch(() => 'unknown');
          // One unmeasured load: the first page of a fresh browser (renderer start, caches) would
          // otherwise weigh on the first level only and exaggerate the gain of the next ones.
          await withTimeout(adapter.navigate(url, navOptions), target.timeoutMs + 5_000, 'warm-up').catch(() => undefined);

          for (const concurrency of options.concurrencies) {
            const pageCount = pagesForLevel(concurrency, options.pagesPerLevel);
            const pages = await withTimeout(adapter.openPages!(concurrency), 60_000, 'open pages');
            const sampler = pid !== null ? await runtime.samplerFor(location) : undefined;
            record.memoryMetric ??= sampler?.memoryMetric ?? null;
            if (sampler && pid !== null) sampler.begin(pid);
            let next = 0;
            let successes = 0;
            const errors = new Set<string>();
            const startedAt = Date.now();
            const worker = async (page: PageHandle) => {
              while (next < pageCount) {
                next++;
                const result = await page.navigate(url, navOptions).catch((err) => ({ success: false, errorMessage: errorMessage(err) }));
                if (result.success) successes++;
                else if (result.errorMessage && errors.size < 3) errors.add(result.errorMessage);
              }
            };
            const budget = Math.ceil(pageCount / concurrency) * (target.timeoutMs + 5_000) + 30_000;
            try {
              await withTimeout(Promise.all(pages.map(worker)), budget, `throughput x${concurrency}`);
            } finally {
              // Stop the queue even when the level timed out: leftover workers would load pages into the next level.
              next = pageCount;
            }
            const durationMs = Date.now() - startedAt;
            const summary = sampler ? summarizeSamples(sampler.end(), sampler.memoryMetric) : null;
            await closePages(pages);

            const level: ThroughputLevel = {
              concurrency,
              pages: pageCount,
              successes,
              durationMs,
              pagesPerMinute: round1(successes / (durationMs / 60_000)),
              memAvgMB: summary?.memBytes ? round1(summary.memBytes.avg / MB) : null,
              memPeakMB: summary?.memBytes ? round1(summary.memBytes.max / MB) : null,
              cpuAvgPercent: summary?.cpuPercent ? round1(summary.cpuPercent.avg) : null,
              cpuSecondsPerPage: summary?.cpuSeconds != null && successes ? Math.round((summary.cpuSeconds / successes) * 1000) / 1000 : null,
              errors: errors.size ? [...errors] : undefined,
            };
            record.levels.push(level);
            log(`[${definition.name}] ${target.name} x${concurrency}  ${level.pagesPerMinute} pages/min  ${successes}/${level.pages} ok` +
              (level.memPeakMB !== null ? `  mem peak ${level.memPeakMB}MB` : '') + (errors.size ? `  (${[...errors][0]})` : ''));
          }
        } catch (err) {
          record.error = errorMessage(err);
          log(`[${definition.name}] ${target.name} FAIL  ${record.error}`);
          for (const sampler of Object.values(runtime.samplers)) sampler.end();
        } finally {
          try {
            await withTimeout(adapter.close(), CLOSE_TIMEOUT_MS, 'close');
          } catch {
            if (pid !== null) await (location === 'wsl' ? wslKill(pid) : killTree(pid));
          }
        }
        records.push(record);
        await writeFile(path.join(options.outDir, `${record.browser}_${record.target}.json`), JSON.stringify(record, null, 1));
      }
    }
  } finally {
    await runtime.dispose();
  }
  return records;
}

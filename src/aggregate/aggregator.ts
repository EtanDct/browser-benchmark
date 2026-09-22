import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AntiBotOutcome } from '../antibot/evaluators.js';
import type { MemoryMetric } from '../monitor/resource-sampler.js';
import type { EnvironmentInfo, RunRecord } from '../runner/types.js';

export interface Stats {
  n: number;
  mean: number;
  median: number;
  stddev: number;
  min: number;
  max: number;
  p95: number;
}

export interface RunSeries {
  run: number;
  success: boolean;
  loadTimeMs: number;
  /** [t ms, memory MB, cpu % | null] */
  samples: Array<[number, number, number | null]>;
}

export interface Cell {
  browser: string;
  browserVersion?: string;
  target: string;
  group: string;
  url: string;
  runs: number;
  successes: number;
  successRate: number;
  timeouts: number;
  loadTimeMs: Stats | null;
  launchTimeMs: Stats | null;
  memAvgMB: Stats | null;
  memPeakMB: Stats | null;
  cpuAvgPercent: Stats | null;
  cpuPeakPercent: Stats | null;
  antiBot: { evaluated: number; passed: number; passRate: number; outcomes: Partial<Record<AntiBotOutcome, number>> } | null;
  fidelity: {
    /** Share of this browser's successful runs whose DOM structure hash equals the cross-browser consensus. */
    matchRate: number;
    /** Distinct hashes across this browser's runs (>1 means the page itself is not deterministic). */
    distinctHashes: number;
    elementCountMedian: number;
    consensusElementCount: number;
  } | null;
  errors: string[];
  series: RunSeries[];
}

export interface BrowserSummary {
  browser: string;
  browserVersion?: string;
  runs: number;
  successRate: number;
  antiBotPassRate: number | null;
  meanLoadTimeMs: number | null;
  memAvgMB: number | null;
  memPeakMB: number | null;
  cpuAvgPercent: number | null;
  fidelityMatchRate: number | null;
}

export interface AggregatedReport {
  schemaVersion: 1;
  generatedAt: string;
  runCount: number;
  memoryMetric: MemoryMetric | null;
  environment: EnvironmentInfo | null;
  browsers: string[];
  targets: Array<{ name: string; group: string; url: string }>;
  cells: Cell[];
  browserSummaries: BrowserSummary[];
}

const MB = 2 ** 20;
const MAX_SERIES_POINTS = 400;

export function computeStats(values: number[]): Stats | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((sum, v) => sum + v, 0) / n;
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const variance = n > 1 ? sorted.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1) : 0;
  const p95 = sorted[Math.min(n - 1, Math.ceil(0.95 * n) - 1)];
  const round = (v: number) => Math.round(v * 100) / 100;
  return { n, mean: round(mean), median: round(median), stddev: round(Math.sqrt(variance)), min: round(sorted[0]), max: round(sorted[n - 1]), p95: round(p95) };
}

function mostFrequent(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  // Ties resolve alphabetically so the report is stable across regenerations.
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

function median(values: number[]): number {
  return computeStats(values)?.median ?? 0;
}

function downsample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const step = items.length / max;
  return Array.from({ length: max }, (_, i) => items[Math.floor(i * step)]);
}

function meanOf(values: Array<number | null | undefined>): number | null {
  const present = values.filter((v): v is number => typeof v === 'number');
  return present.length ? Math.round((present.reduce((a, b) => a + b, 0) / present.length) * 100) / 100 : null;
}

export function aggregate(records: RunRecord[]): AggregatedReport {
  const successful = records.filter((r) => r.navigation.success);

  const consensusByTarget = new Map<string, { hash?: string; elementCount: number }>();
  for (const target of new Set(records.map((r) => r.target))) {
    const runs = successful.filter((r) => r.target === target && r.navigation.domSnapshotHash);
    consensusByTarget.set(target, {
      hash: mostFrequent(runs.map((r) => r.navigation.domSnapshotHash!)),
      elementCount: median(runs.map((r) => r.navigation.domStats?.elementCount ?? 0)),
    });
  }

  const groups = new Map<string, RunRecord[]>();
  for (const record of records) {
    const key = `${record.browser}\u0000${record.target}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }

  const cells: Cell[] = [...groups.values()].map((runs) => {
    runs.sort((a, b) => a.run - b.run);
    const ref = runs[0];
    const ok = runs.filter((r) => r.navigation.success);
    const summaries = runs.map((r) => r.resources?.summary).filter((s) => s !== undefined);

    const antiBotRuns = runs.filter((r) => r.navigation.antiBot);
    const outcomes: Partial<Record<AntiBotOutcome, number>> = {};
    for (const r of antiBotRuns) outcomes[r.navigation.antiBot!.outcome] = (outcomes[r.navigation.antiBot!.outcome] ?? 0) + 1;
    const passed = antiBotRuns.filter((r) => r.navigation.antiBot!.passed).length;
    // A run that never got a page counts as a failed anti-bot attempt for antibot targets.
    const antiBotAttempts = runs.some((r) => r.targetGroup === 'antibot') || antiBotRuns.length ? runs.length : 0;

    const hashed = ok.filter((r) => r.navigation.domSnapshotHash);
    const consensus = consensusByTarget.get(ref.target)!;

    return {
      browser: ref.browser,
      browserVersion: runs.map((r) => r.browserVersion).find((v) => v && v !== 'unknown'),
      target: ref.target,
      group: ref.targetGroup,
      url: ref.url,
      runs: runs.length,
      successes: ok.length,
      successRate: ok.length / runs.length,
      timeouts: runs.filter((r) => r.timedOut).length,
      loadTimeMs: computeStats(ok.map((r) => r.navigation.loadTimeMs)),
      launchTimeMs: computeStats(runs.flatMap((r) => (r.launchTimeMs === undefined ? [] : [r.launchTimeMs]))),
      memAvgMB: computeStats(summaries.flatMap((s) => (s.memBytes ? [s.memBytes.avg / MB] : []))),
      memPeakMB: computeStats(summaries.flatMap((s) => (s.memBytes ? [s.memBytes.max / MB] : []))),
      cpuAvgPercent: computeStats(summaries.flatMap((s) => (s.cpuPercent ? [s.cpuPercent.avg] : []))),
      cpuPeakPercent: computeStats(summaries.flatMap((s) => (s.cpuPercent ? [s.cpuPercent.max] : []))),
      antiBot: antiBotAttempts
        ? { evaluated: antiBotAttempts, passed, passRate: passed / antiBotAttempts, outcomes }
        : null,
      fidelity: hashed.length && consensus.hash
        ? {
            matchRate: hashed.filter((r) => r.navigation.domSnapshotHash === consensus.hash).length / hashed.length,
            distinctHashes: new Set(hashed.map((r) => r.navigation.domSnapshotHash)).size,
            elementCountMedian: median(hashed.map((r) => r.navigation.domStats?.elementCount ?? 0)),
            consensusElementCount: consensus.elementCount,
          }
        : null,
      errors: [...new Set(runs.flatMap((r) => (r.navigation.success ? [] : [r.error ?? r.navigation.errorMessage ?? 'unknown error'])))].slice(0, 5),
      series: runs.map((r) => ({
        run: r.run,
        success: r.navigation.success,
        loadTimeMs: r.navigation.loadTimeMs,
        samples: downsample(r.resources?.samples ?? [], MAX_SERIES_POINTS).map(
          (s): [number, number, number | null] => [s.t, Math.round((s.memBytes / MB) * 10) / 10, s.cpuPercent === null ? null : Math.round(s.cpuPercent * 10) / 10],
        ),
      })),
    };
  });

  cells.sort((a, b) => a.browser.localeCompare(b.browser) || a.target.localeCompare(b.target));
  const browsers = [...new Set(cells.map((c) => c.browser))];

  const browserSummaries: BrowserSummary[] = browsers.map((browser) => {
    const own = cells.filter((c) => c.browser === browser);
    const runs = own.reduce((sum, c) => sum + c.runs, 0);
    const antiBot = own.filter((c) => c.antiBot);
    const antiBotEvaluated = antiBot.reduce((sum, c) => sum + c.antiBot!.evaluated, 0);
    return {
      browser,
      browserVersion: own.map((c) => c.browserVersion).find(Boolean),
      runs,
      successRate: own.reduce((sum, c) => sum + c.successes, 0) / runs,
      antiBotPassRate: antiBotEvaluated ? antiBot.reduce((sum, c) => sum + c.antiBot!.passed, 0) / antiBotEvaluated : null,
      meanLoadTimeMs: meanOf(own.map((c) => c.loadTimeMs?.median)),
      memAvgMB: meanOf(own.map((c) => c.memAvgMB?.mean)),
      memPeakMB: own.reduce<number | null>((max, c) => (c.memPeakMB ? Math.max(max ?? 0, c.memPeakMB.max) : max), null),
      cpuAvgPercent: meanOf(own.map((c) => c.cpuAvgPercent?.mean)),
      fidelityMatchRate: meanOf(own.map((c) => c.fidelity?.matchRate)),
    };
  });

  const targets = [...new Map(cells.map((c) => [c.target, { name: c.target, group: c.group, url: c.url }])).values()];
  const latest = [...records].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runCount: records.length,
    memoryMetric: records.find((r) => r.resources)?.resources?.memoryMetric ?? null,
    environment: latest?.environment ?? null,
    browsers,
    targets,
    cells,
    browserSummaries,
  };
}

export async function loadRawRecords(rawDir: string): Promise<RunRecord[]> {
  let files: string[];
  try {
    files = (await readdir(rawDir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const records: RunRecord[] = [];
  for (const file of files) {
    const record = JSON.parse(await readFile(path.join(rawDir, file), 'utf8')) as RunRecord;
    if (record.schemaVersion === 1) records.push(record);
  }
  return records;
}

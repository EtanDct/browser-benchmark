import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Engine } from '../adapters/base.js';
import type { AntiBotOutcome } from '../antibot/evaluators.js';
import { cpuSecondsOf, type MemoryMetric } from '../monitor/resource-sampler.js';
import type { ThroughputLevel, ThroughputRecord } from '../runner/throughput-types.js';
import type { EnvironmentInfo, RunMode, RunRecord } from '../runner/types.js';
import type { VisualScore } from './visual.js';

export interface Stats {
  n: number;
  mean: number;
  median: number;
  stddev: number;
  min: number;
  max: number;
  p95: number;
  /** 95 % confidence interval of the mean (Student t), [mean, mean] with a single run. */
  ci95: [number, number];
}

/**
 * One run, reduced to the values the dashboard's bootstrap needs to recompute the ranking on
 * resampled runs. null = not measured for this run.
 */
export interface RunSeries {
  run: number;
  success: boolean;
  loadTimeMs: number;
  launchMs: number | null;
  memAvgMB: number | null;
  memPeakMB: number | null;
  cpuAvg: number | null;
  /** CPU time the browser tree consumed during the run, in seconds. */
  cpuSec: number | null;
  /** Graded anti-bot score; 0 when the page never delivered a verdict; null outside anti-bot targets. */
  abScore: number | null;
  /** Similarity of this run's DOM to the cross-engine consensus (0-1); null on anti-bot pages. */
  domSimilarity: number | null;
  /** Share of the content the page declares it should end up with (local fixtures), 0-1. */
  contentScore: number | null;
  bytesDownMB: number | null;
  /** [t ms, memory MB, cpu % | null] */
  samples: Array<[number, number, number | null]>;
}

export interface Cell {
  browser: string;
  adapter: string;
  engine: Engine | null;
  mode: RunMode;
  stealth: boolean;
  browserVersion?: string;
  target: string;
  group: string;
  url: string;
  runs: number;
  successes: number;
  successRate: number;
  timeouts: number;
  memoryMetric: MemoryMetric | null;
  loadTimeMs: Stats | null;
  launchTimeMs: Stats | null;
  memAvgMB: Stats | null;
  memPeakMB: Stats | null;
  cpuAvgPercent: Stats | null;
  cpuPeakPercent: Stats | null;
  /** CPU seconds per run: unlike the average %, independent of how long the run stayed open. */
  cpuSeconds: Stats | null;
  /** Downloaded MB per navigation, through the counting proxy (remote targets). */
  networkMB: Stats | null;
  antiBot: {
    evaluated: number;
    passed: number;
    passRate: number;
    /** Mean graded stealth score (0-1); runs that never got a page count as 0. */
    meanScore: number;
    outcomes: Partial<Record<AntiBotOutcome, number>>;
  } | null;
  /** Expected content declared by the page (local fixtures): mean score and the median count found per selector. */
  content: { score: number; checks: Array<{ selector: string; expected: number; foundMedian: number }> } | null;
  /** Null on anti-bot pages: a browser that gets past a challenge sees another page than the others. */
  fidelity: {
    /** Mean similarity of the DOM (tag counts, weighted Jaccard) to the cross-engine consensus. */
    similarity: number;
    /** Share of runs whose exact DOM structure hash equals the consensus hash. */
    matchRate: number;
    /** Distinct hashes across this browser's runs (>1 means the page itself is not deterministic). */
    distinctHashes: number;
    elementCountMedian: number;
    consensusElementCount: number;
  } | null;
  /** Screenshot compared to the reference browser's, pixel by pixel. */
  visual: VisualScore | null;
  errors: string[];
  series: RunSeries[];
}

export interface BrowserSummary {
  browser: string;
  browserVersion?: string;
  stealth: boolean;
  mode: RunMode;
  runs: number;
  successRate: number;
  antiBotPassRate: number | null;
  meanLoadTimeMs: number | null;
  memAvgMB: number | null;
  memPeakMB: number | null;
  cpuAvgPercent: number | null;
  cpuSeconds: number | null;
  fidelitySimilarity: number | null;
  contentScore: number | null;
  networkMB: number | null;
}

export interface ThroughputSummary extends Omit<ThroughputRecord, 'schemaVersion' | 'environment'> {
  bestPagesPerMinute: number | null;
  /** Least-squares slope of peak memory against concurrency: memory cost of one more page. */
  memPerPageMB: number | null;
}

export interface AggregatedReport {
  schemaVersion: 1;
  generatedAt: string;
  runCount: number;
  /** Distinct memory metrics in the report (Windows browsers vs browsers hosted in WSL...). */
  memoryMetrics: MemoryMetric[];
  environment: EnvironmentInfo | null;
  browsers: string[];
  targets: Array<{
    name: string;
    group: string;
    url: string;
    /** Anti-bot page: counted for detection only, left out of performance and fidelity figures. */
    antiBot: boolean;
    /** The page exposes individual checks, so its anti-bot score is graded rather than pass/fail only. */
    gradedAntiBot: boolean;
    /** Browser whose screenshot the others are compared to, when screenshots exist. */
    visualReference: string | null;
  }>;
  cells: Cell[];
  browserSummaries: BrowserSummary[];
  throughput: ThroughputSummary[];
}

const MB = 2 ** 20;
const MAX_SERIES_POINTS = 400;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Two-sided 95 % Student t critical values by degrees of freedom. */
const T95: Array<[number, number]> = [
  [1, 12.706], [2, 4.303], [3, 3.182], [4, 2.776], [5, 2.571], [6, 2.447], [7, 2.365], [8, 2.306], [9, 2.262],
  [10, 2.228], [12, 2.179], [15, 2.131], [20, 2.086], [25, 2.06], [30, 2.042], [40, 2.021], [60, 2.0], [120, 1.98],
];

/** Between table rows, uses the next smaller tabulated df: a larger t, so a slightly wider (conservative) interval. */
export function tCritical(df: number): number {
  let t = T95[0][1];
  for (const [d, value] of T95) if (d <= df) t = value;
  return t;
}

export function computeStats(values: number[]): Stats | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((sum, v) => sum + v, 0) / n;
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const variance = n > 1 ? sorted.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1) : 0;
  const stddev = Math.sqrt(variance);
  const halfWidth = n > 1 ? tCritical(n - 1) * stddev / Math.sqrt(n) : 0;
  const p95 = sorted[Math.min(n - 1, Math.ceil(0.95 * n) - 1)];
  return {
    n,
    mean: round2(mean),
    median: round2(median),
    stddev: round2(stddev),
    min: round2(sorted[0]),
    max: round2(sorted[n - 1]),
    p95: round2(p95),
    ci95: [round2(mean - halfWidth), round2(mean + halfWidth)],
  };
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
  return present.length ? round2(present.reduce((a, b) => a + b, 0) / present.length) : null;
}

/** Weighted Jaccard of two tag-count vectors: 1 = same number of every element type. */
export function tagSimilarity(a: Record<string, number>, b: Record<string, number>): number {
  let intersection = 0;
  let union = 0;
  for (const tag of new Set([...Object.keys(a), ...Object.keys(b)])) {
    intersection += Math.min(a[tag] ?? 0, b[tag] ?? 0);
    union += Math.max(a[tag] ?? 0, b[tag] ?? 0);
  }
  return union ? intersection / union : 1;
}

/** Engine of records written before RunRecord.engine existed. */
const ENGINE_OF: Record<string, Engine> = {
  puppeteer: 'chromium',
  'puppeteer-stealth': 'chromium',
  patchright: 'chromium',
  'playwright-chromium': 'chromium',
  'selenium-chrome': 'chromium',
  'playwright-firefox': 'gecko',
  camoufox: 'gecko',
  'playwright-webkit': 'webkit',
  lightpanda: 'lightpanda',
};

export function engineOf(r: Pick<RunRecord, 'engine' | 'adapter' | 'browser'>): Engine | null {
  return r.engine ?? ENGINE_OF[r.adapter ?? r.browser.replace(/\+lite$/, '')] ?? null;
}

function perTagMedian(counts: Array<Record<string, number>>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const tag of new Set(counts.flatMap((c) => Object.keys(c)))) {
    const value = median(counts.map((c) => c[tag] ?? 0));
    if (value > 0) result[tag] = value;
  }
  return result;
}

/**
 * The DOM "the engines agree on": per-tag median within each engine, then across engines, full mode
 * only. One vote per engine: five Chromium drivers and their lite variants would otherwise make the
 * consensus Chromium's DOM, and blocking CSS/images can change what scripts build.
 */
export function consensusTagCounts(runs: RunRecord[]): Record<string, number> | null {
  const byEngine = new Map<string, Array<Record<string, number>>>();
  for (const r of runs) {
    if (!r.navigation.domTagCounts || (r.mode ?? 'full') !== 'full') continue;
    const engine = engineOf(r) ?? r.browser;
    byEngine.set(engine, [...(byEngine.get(engine) ?? []), r.navigation.domTagCounts]);
  }
  if (!byEngine.size) return null;
  return perTagMedian([...byEngine.values()].map(perTagMedian));
}

function isAntiBotRun(r: RunRecord): boolean {
  return r.targetGroup === 'antibot' || !!r.navigation.antiBot;
}

/** CPU seconds of a run; computed from its samples for records written before the summary had it. */
function runCpuSeconds(r: RunRecord): number | null {
  const summary = r.resources?.summary;
  if (!summary) return null;
  if (summary.cpuSeconds !== undefined) return summary.cpuSeconds;
  return cpuSecondsOf(r.resources!.samples);
}

/** Records of one campaign; records written before campaign ids existed form the "legacy" campaign. */
export function campaignOf(r: RunRecord): string {
  return r.campaign ?? 'legacy';
}

/** Campaign of the most recently started run. */
export function latestCampaign(records: RunRecord[]): string | null {
  const latest = records.reduce<RunRecord | null>((a, r) => (!a || r.startedAt > a.startedAt ? r : a), null);
  return latest ? campaignOf(latest) : null;
}

function summarizeThroughput(record: ThroughputRecord): ThroughputSummary {
  // Levels with failures idle part of the time, which would bend the memory slope.
  const levels = record.levels.filter((l) => l.memPeakMB !== null && l.successes === l.pages);
  let memPerPageMB: number | null = null;
  if (levels.length >= 2) {
    const xs = levels.map((l) => l.concurrency);
    const ys = levels.map((l) => l.memPeakMB!);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    memPerPageMB = sxx ? round2(xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / sxx) : null;
  }
  const { schemaVersion: _schema, environment: _env, ...rest } = record;
  const best = record.levels.reduce<number | null>((max, l: ThroughputLevel) => (max === null || l.pagesPerMinute > max ? l.pagesPerMinute : max), null);
  return { ...rest, bestPagesPerMinute: best, memPerPageMB };
}

export interface AggregateInputs {
  visual?: Map<string, VisualScore>;
  visualReferences?: Map<string, string>;
  throughput?: ThroughputRecord[];
}

export function aggregate(records: RunRecord[], inputs: AggregateInputs = {}): AggregatedReport {
  const successful = records.filter((r) => r.navigation.success);
  const antiBotTargets = new Set(records.filter(isAntiBotRun).map((r) => r.target));

  const consensusByTarget = new Map<string, { hash?: string; elementCount: number; tags: Record<string, number> | null }>();
  for (const target of new Set(records.map((r) => r.target))) {
    if (antiBotTargets.has(target)) continue;
    const runs = successful.filter((r) => r.target === target && r.navigation.domSnapshotHash && (r.mode ?? 'full') === 'full');
    consensusByTarget.set(target, {
      hash: mostFrequent(runs.map((r) => r.navigation.domSnapshotHash!)),
      elementCount: median(runs.map((r) => r.navigation.domStats?.elementCount ?? 0)),
      tags: consensusTagCounts(runs),
    });
  }

  const similarityOf = (r: RunRecord): number | null => {
    if (!r.navigation.success || antiBotTargets.has(r.target)) return null;
    const consensus = consensusByTarget.get(r.target);
    if (consensus?.tags && r.navigation.domTagCounts) return tagSimilarity(r.navigation.domTagCounts, consensus.tags);
    // Records written before tag counts existed: exact structure match or not.
    if (consensus?.hash && r.navigation.domSnapshotHash) return r.navigation.domSnapshotHash === consensus.hash ? 1 : 0;
    return null;
  };

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
    // Records written before graded scores existed only carry pass/fail.
    const scoreOf = (r: RunRecord) => r.navigation.antiBot ? (r.navigation.antiBot.score ?? (r.navigation.antiBot.passed ? 1 : 0)) : 0;
    const scoreSum = antiBotRuns.reduce((sum, r) => sum + scoreOf(r), 0);
    // A run that never got a page counts as a failed anti-bot attempt for antibot targets.
    const antiBotAttempts = runs.some(isAntiBotRun) ? runs.length : 0;

    const hashed = ok.filter((r) => r.navigation.domSnapshotHash);
    const consensus = consensusByTarget.get(ref.target);
    const similarities = ok.map(similarityOf).filter((s): s is number => s !== null);
    const contents = ok.flatMap((r) => (r.navigation.content ? [r.navigation.content] : []));

    return {
      browser: ref.browser,
      adapter: ref.adapter ?? ref.browser,
      engine: engineOf(ref),
      mode: ref.mode ?? 'full',
      stealth: !!ref.stealth,
      browserVersion: runs.map((r) => r.browserVersion).find((v) => v && v !== 'unknown'),
      target: ref.target,
      group: ref.targetGroup,
      url: ref.url,
      runs: runs.length,
      successes: ok.length,
      successRate: ok.length / runs.length,
      timeouts: runs.filter((r) => r.timedOut).length,
      memoryMetric: runs.find((r) => r.resources)?.resources?.memoryMetric ?? null,
      loadTimeMs: computeStats(ok.map((r) => r.navigation.loadTimeMs)),
      launchTimeMs: computeStats(runs.flatMap((r) => (r.launchTimeMs === undefined ? [] : [r.launchTimeMs]))),
      memAvgMB: computeStats(summaries.flatMap((s) => (s.memBytes ? [s.memBytes.avg / MB] : []))),
      memPeakMB: computeStats(summaries.flatMap((s) => (s.memBytes ? [s.memBytes.max / MB] : []))),
      cpuAvgPercent: computeStats(summaries.flatMap((s) => (s.cpuPercent ? [s.cpuPercent.avg] : []))),
      cpuPeakPercent: computeStats(summaries.flatMap((s) => (s.cpuPercent ? [s.cpuPercent.max] : []))),
      cpuSeconds: computeStats(runs.flatMap((r) => { const s = runCpuSeconds(r); return s === null ? [] : [s]; })),
      networkMB: computeStats(ok.flatMap((r) => (r.network ? [r.network.bytesDown / MB] : []))),
      antiBot: antiBotAttempts
        ? { evaluated: antiBotAttempts, passed, passRate: passed / antiBotAttempts, meanScore: Math.round((scoreSum / antiBotAttempts) * 1000) / 1000, outcomes }
        : null,
      content: contents.length
        ? {
            score: Math.round((contents.reduce((sum, c) => sum + c.score, 0) / contents.length) * 1000) / 1000,
            checks: contents[0].checks.map((check, i) => ({
              selector: check.selector,
              expected: check.expected,
              foundMedian: median(contents.map((c) => c.checks[i]?.found ?? 0)),
            })),
          }
        : null,
      fidelity: similarities.length && consensus
        ? {
            similarity: Math.round((similarities.reduce((a, b) => a + b, 0) / similarities.length) * 1000) / 1000,
            matchRate: hashed.length ? hashed.filter((r) => r.navigation.domSnapshotHash === consensus.hash).length / hashed.length : 0,
            distinctHashes: new Set(hashed.map((r) => r.navigation.domSnapshotHash)).size,
            elementCountMedian: median(hashed.map((r) => r.navigation.domStats?.elementCount ?? 0)),
            consensusElementCount: consensus.elementCount,
          }
        : null,
      visual: inputs.visual?.get(`${ref.browser}\u0000${ref.target}`) ?? null,
      errors: [...new Set(runs.flatMap((r) => (r.navigation.success ? [] : [r.error ?? r.navigation.errorMessage ?? 'unknown error'])))].slice(0, 5),
      series: runs.map((r) => {
        const summary = r.resources?.summary;
        return {
          run: r.run,
          success: r.navigation.success,
          loadTimeMs: r.navigation.loadTimeMs,
          launchMs: r.launchTimeMs ?? null,
          memAvgMB: summary?.memBytes ? round2(summary.memBytes.avg / MB) : null,
          memPeakMB: summary?.memBytes ? round2(summary.memBytes.max / MB) : null,
          cpuAvg: summary?.cpuPercent ? round2(summary.cpuPercent.avg) : null,
          cpuSec: runCpuSeconds(r),
          abScore: isAntiBotRun(r) ? scoreOf(r) : null,
          domSimilarity: similarityOf(r),
          contentScore: r.navigation.success && r.navigation.content ? r.navigation.content.score : null,
          bytesDownMB: r.network ? round2(r.network.bytesDown / MB) : null,
          samples: downsample(r.resources?.samples ?? [], MAX_SERIES_POINTS).map(
            (s): [number, number, number | null] => [s.t, Math.round((s.memBytes / MB) * 10) / 10, s.cpuPercent === null ? null : Math.round(s.cpuPercent * 10) / 10],
          ),
        };
      }),
    };
  });

  cells.sort((a, b) => a.browser.localeCompare(b.browser) || a.target.localeCompare(b.target));
  const browsers = [...new Set(cells.map((c) => c.browser))];

  const browserSummaries: BrowserSummary[] = browsers.map((browser) => {
    const own = cells.filter((c) => c.browser === browser);
    // Speed, resources and fidelity on anti-bot pages would reward being blocked early.
    const perf = own.filter((c) => !antiBotTargets.has(c.target));
    const runs = own.reduce((sum, c) => sum + c.runs, 0);
    const antiBot = own.filter((c) => c.antiBot);
    const antiBotEvaluated = antiBot.reduce((sum, c) => sum + c.antiBot!.evaluated, 0);
    return {
      browser,
      browserVersion: own.map((c) => c.browserVersion).find(Boolean),
      stealth: own[0].stealth,
      mode: own[0].mode,
      runs,
      successRate: own.reduce((sum, c) => sum + c.successes, 0) / runs,
      antiBotPassRate: antiBotEvaluated ? antiBot.reduce((sum, c) => sum + c.antiBot!.passed, 0) / antiBotEvaluated : null,
      meanLoadTimeMs: meanOf(perf.map((c) => c.loadTimeMs?.median)),
      memAvgMB: meanOf(perf.map((c) => c.memAvgMB?.mean)),
      memPeakMB: perf.reduce<number | null>((max, c) => (c.memPeakMB ? Math.max(max ?? 0, c.memPeakMB.max) : max), null),
      cpuAvgPercent: meanOf(perf.map((c) => c.cpuAvgPercent?.mean)),
      cpuSeconds: meanOf(perf.map((c) => c.cpuSeconds?.median)),
      fidelitySimilarity: meanOf(perf.map((c) => c.fidelity?.similarity)),
      contentScore: meanOf(perf.map((c) => c.content?.score)),
      networkMB: meanOf(perf.map((c) => c.networkMB?.mean)),
    };
  });

  // Pass/fail pages only ever score 0 or 1; any run in between proves the page grades its checks.
  const gradedTargets = new Set(
    records.filter((r) => { const s = r.navigation.antiBot?.score; return s !== undefined && s > 0 && s < 1; }).map((r) => r.target),
  );
  const targets = [...new Map(cells.map((c) => [c.target, {
    name: c.target,
    group: c.group,
    url: c.url,
    antiBot: antiBotTargets.has(c.target),
    gradedAntiBot: gradedTargets.has(c.target),
    visualReference: inputs.visualReferences?.get(c.target) ?? null,
  }])).values()];
  const latest = [...records].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runCount: records.length,
    memoryMetrics: [...new Set(cells.flatMap((c) => (c.memoryMetric ? [c.memoryMetric] : [])))],
    environment: latest?.environment ?? null,
    browsers,
    targets,
    cells,
    browserSummaries,
    throughput: (inputs.throughput ?? []).map(summarizeThroughput).sort((a, b) => a.browser.localeCompare(b.browser)),
  };
}

async function readJsonDir<T>(dir: string, accept: (value: T) => boolean): Promise<T[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const values: T[] = [];
  for (const file of files) {
    const value = JSON.parse(await readFile(path.join(dir, file), 'utf8')) as T;
    if (accept(value)) values.push(value);
  }
  return values;
}

export function loadRawRecords(rawDir: string): Promise<RunRecord[]> {
  return readJsonDir<RunRecord>(rawDir, (r) => r.schemaVersion === 1);
}

export function loadThroughputRecords(dir: string): Promise<ThroughputRecord[]> {
  return readJsonDir<ThroughputRecord>(dir, (r) => r.schemaVersion === 1);
}

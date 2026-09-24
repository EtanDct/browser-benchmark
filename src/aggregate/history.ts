import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EnvironmentInfo, RunMode } from '../runner/types.js';
import type { AggregatedReport } from './aggregator.js';

/** One campaign, reduced to a few numbers per browser, to follow versions over time. */
export interface HistoryEntry {
  schemaVersion: 1;
  campaignAt: string;
  /** --campaign id: the entry aggregates this campaign's runs only. */
  campaign?: string;
  runCount: number;
  environment: EnvironmentInfo | null;
  browsers: Array<{
    browser: string;
    /** Adapter, mode and stealth let the History tab style browsers that are not in the current report. */
    adapter?: string;
    mode?: RunMode;
    stealth?: boolean;
    version?: string;
    successRate: number;
    meanLoadTimeMs: number | null;
    memAvgMB: number | null;
    memPeakMB?: number | null;
    cpuAvgPercent: number | null;
    cpuSeconds?: number | null;
    contentScore?: number | null;
    /** Mean graded anti-bot score (share of detection checks passed). */
    antiBotScore: number | null;
    antiBotPassRate: number | null;
    fidelitySimilarity: number | null;
  }>;
}

/** `report` must aggregate a single campaign's runs (see campaignOf), or the entry mixes campaigns. */
export function historyEntry(report: AggregatedReport, campaign?: string): HistoryEntry {
  return {
    schemaVersion: 1,
    campaignAt: report.generatedAt,
    campaign,
    runCount: report.runCount,
    environment: report.environment,
    browsers: report.browserSummaries.map((s) => {
      const antiBot = report.cells.filter((c) => c.browser === s.browser && c.antiBot);
      const evaluated = antiBot.reduce((sum, c) => sum + c.antiBot!.evaluated, 0);
      const cell = report.cells.find((c) => c.browser === s.browser);
      return {
        browser: s.browser,
        adapter: cell?.adapter,
        mode: s.mode,
        stealth: s.stealth || undefined,
        version: s.browserVersion,
        successRate: s.successRate,
        meanLoadTimeMs: s.meanLoadTimeMs,
        memAvgMB: s.memAvgMB,
        memPeakMB: s.memPeakMB,
        cpuAvgPercent: s.cpuAvgPercent,
        cpuSeconds: s.cpuSeconds,
        contentScore: s.contentScore,
        antiBotScore: evaluated ? antiBot.reduce((sum, c) => sum + c.antiBot!.meanScore * c.antiBot!.evaluated, 0) / evaluated : null,
        antiBotPassRate: s.antiBotPassRate,
        fidelitySimilarity: s.fidelitySimilarity,
      };
    }),
  };
}

export async function appendHistory(report: AggregatedReport, historyDir: string, campaign?: string): Promise<string> {
  await mkdir(historyDir, { recursive: true });
  const file = path.join(historyDir, `${report.generatedAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(file, JSON.stringify(historyEntry(report, campaign), null, 1));
  return file;
}

export async function loadHistory(historyDir: string): Promise<HistoryEntry[]> {
  let files: string[];
  try {
    files = (await readdir(historyDir)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const entries: HistoryEntry[] = [];
  for (const file of files) {
    const entry = JSON.parse(await readFile(path.join(historyDir, file), 'utf8')) as HistoryEntry;
    if (entry.schemaVersion === 1) entries.push(entry);
  }
  return entries.sort((a, b) => a.campaignAt.localeCompare(b.campaignAt));
}

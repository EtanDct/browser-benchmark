import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EnvironmentInfo } from '../runner/types.js';
import type { AggregatedReport } from './aggregator.js';

/** One campaign, reduced to a few numbers per browser, to follow versions over time. */
export interface HistoryEntry {
  schemaVersion: 1;
  campaignAt: string;
  runCount: number;
  environment: EnvironmentInfo | null;
  browsers: Array<{
    browser: string;
    version?: string;
    successRate: number;
    meanLoadTimeMs: number | null;
    memAvgMB: number | null;
    cpuAvgPercent: number | null;
    /** Mean graded anti-bot score (share of detection checks passed). */
    antiBotScore: number | null;
    antiBotPassRate: number | null;
    fidelitySimilarity: number | null;
  }>;
}

export function historyEntry(report: AggregatedReport): HistoryEntry {
  return {
    schemaVersion: 1,
    campaignAt: report.generatedAt,
    runCount: report.runCount,
    environment: report.environment,
    browsers: report.browserSummaries.map((s) => {
      const antiBot = report.cells.filter((c) => c.browser === s.browser && c.antiBot);
      const evaluated = antiBot.reduce((sum, c) => sum + c.antiBot!.evaluated, 0);
      return {
        browser: s.browser,
        version: s.browserVersion,
        successRate: s.successRate,
        meanLoadTimeMs: s.meanLoadTimeMs,
        memAvgMB: s.memAvgMB,
        cpuAvgPercent: s.cpuAvgPercent,
        antiBotScore: evaluated ? antiBot.reduce((sum, c) => sum + c.antiBot!.meanScore * c.antiBot!.evaluated, 0) / evaluated : null,
        antiBotPassRate: s.antiBotPassRate,
        fidelitySimilarity: s.fidelitySimilarity,
      };
    }),
  };
}

export async function appendHistory(report: AggregatedReport, historyDir: string): Promise<string> {
  await mkdir(historyDir, { recursive: true });
  const file = path.join(historyDir, `${report.generatedAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(file, JSON.stringify(historyEntry(report), null, 1));
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

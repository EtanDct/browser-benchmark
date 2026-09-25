import type { MemoryMetric } from '../monitor/resource-sampler.js';
import type { EnvironmentInfo } from './types.js';

/** One concurrency level: N pages kept busy on a queue of page loads in a single browser. */
export interface ThroughputLevel {
  concurrency: number;
  pages: number;
  successes: number;
  durationMs: number;
  pagesPerMinute: number;
  memAvgMB: number | null;
  memPeakMB: number | null;
  cpuAvgPercent: number | null;
  /** CPU time the browser spent per successful page load. */
  cpuSecondsPerPage?: number | null;
  /** First distinct failure messages at this level. */
  errors?: string[];
}

export interface ThroughputRecord {
  schemaVersion: 1;
  browser: string;
  browserVersion?: string;
  stealth?: boolean;
  target: string;
  url: string;
  startedAt: string;
  memoryMetric: MemoryMetric | null;
  levels: ThroughputLevel[];
  /** Concurrency after which higher levels were skipped because most loads failed. */
  stoppedAfter?: number;
  error?: string;
  environment: EnvironmentInfo;
}

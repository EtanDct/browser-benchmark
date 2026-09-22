import type { NavigationResult } from '../adapters/base.js';
import type { MemoryMetric, ResourceSample, ResourceSummary } from '../monitor/resource-sampler.js';

export const RUN_SCHEMA_VERSION = 1;

export interface EnvironmentInfo {
  platform: string;
  osRelease: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  totalMemBytes: number;
  nodeVersion: string;
}

export interface RunRecord {
  schemaVersion: number;
  browser: string;
  browserVersion?: string;
  target: string;
  targetGroup: string;
  url: string;
  run: number;
  startedAt: string;
  launchTimeMs?: number;
  navigation: NavigationResult;
  resources: {
    memoryMetric: MemoryMetric;
    sampleIntervalMs: number;
    summary: ResourceSummary;
    samples: ResourceSample[];
  } | null;
  /** Set when the run failed outside navigation (launch error, hard timeout...). */
  error?: string;
  timedOut?: boolean;
  /** The browser did not close in time and its process tree was killed. */
  forcedKill?: boolean;
  environment: EnvironmentInfo;
}

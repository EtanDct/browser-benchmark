import type { Engine, NavigationResult } from '../adapters/base.js';
import type { MemoryMetric, ResourceSample, ResourceSummary } from '../monitor/resource-sampler.js';
import type { ByteCounts } from '../network/byte-proxy.js';

export const RUN_SCHEMA_VERSION = 1;

/** full: the page as a user sees it. lite: images, stylesheets, fonts and media blocked, like a DOM scraper. */
export type RunMode = 'full' | 'lite';

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
  /** Row key in reports: the adapter name, suffixed with "+lite" in lite mode. */
  browser: string;
  adapter?: string;
  mode?: RunMode;
  /** Anti-detection variant (stealth plugin, patched driver, anti-detect build). */
  stealth?: boolean;
  engine?: Engine;
  /** Campaign this run belongs to (--campaign): history entries only aggregate their own campaign. */
  campaign?: string;
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
  /** Bytes moved through the counting proxy during navigation (remote targets only). */
  network?: ByteCounts | null;
  /** File name in results/screens, for visual comparison. */
  screenshot?: string;
  /** Set when the run failed outside navigation (launch error, hard timeout...). */
  error?: string;
  timedOut?: boolean;
  /** The browser did not close in time and its process tree was killed. */
  forcedKill?: boolean;
  environment: EnvironmentInfo;
}

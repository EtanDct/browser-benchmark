import type { AntiBotRule, AntiBotVerdict } from '../antibot/evaluators.js';

export interface LaunchOptions {
  /** HTTP proxy every request must go through (the runner's byte counter). */
  proxyUrl?: string;
}

export interface NavigateOptions {
  timeoutMs: number;
  /** Always waited after `load` before capturing the DOM, so late JS can run. */
  settleMs: number;
  /** Extra time allowed for an anti-bot challenge to clear itself (polled, exits early). */
  challengeWaitMs: number;
  antiBot?: AntiBotRule;
  /** "Lite" mode: abort images, stylesheets, fonts and media, like a scraper that only wants the DOM. */
  blockResources?: boolean;
}

export interface DomStats {
  elementCount: number;
  textLength: number;
}

export interface NavigationResult {
  success: boolean;
  httpStatus?: number;
  /** navigation start -> `load` event, wall-clock measured by the adapter. */
  loadTimeMs: number;
  antiBotPassed?: boolean;
  antiBot?: AntiBotVerdict;
  /** sha256 of the element tag sequence: compares DOM structure across browsers. */
  domSnapshotHash?: string;
  /** Element count per tag name, for a graded DOM similarity instead of all-or-nothing hash equality. */
  domTagCounts?: Record<string, number>;
  domStats?: DomStats;
  finalUrl?: string;
  title?: string;
  /** loadEventEnd from the Navigation Timing API, when the browser exposes it. */
  navTimingLoadMs?: number;
  errorMessage?: string;
}

/** Where a browser process lives: on this machine, or inside the WSL2 VM (Linux-only browsers on Windows). */
export type ProcessLocation = 'host' | 'wsl';

export interface LaunchResult {
  /** Root PID of the browser process tree, or null when the browser runs outside our control (remote endpoint). */
  pid: number | null;
  /** Namespace of `pid`; defaults to 'host'. */
  location?: ProcessLocation;
}

export interface Availability {
  available: boolean;
  reason?: string;
  /**
   * Set when the browser runs inside WSL: address of this machine as seen from there.
   * The runner then also serves local:// fixtures and the proxy on it, and keeps a WSL sampler warm.
   */
  wslHostIp?: string;
}

/** One more tab/page of an already launched browser (throughput tests). */
export interface PageHandle {
  navigate(url: string, options: NavigateOptions): Promise<NavigationResult>;
  close(): Promise<void>;
}

export interface BrowserAdapter {
  /** ex: "puppeteer" */
  name: string;
  launch(options?: LaunchOptions): Promise<LaunchResult>;
  navigate(url: string, options: NavigateOptions): Promise<NavigationResult>;
  close(): Promise<void>;
  version?(): Promise<string>;
  /** Viewport capture at a fixed size, for visual comparison. Absent for browsers without rendering. */
  screenshot?(width: number, height: number): Promise<Buffer>;
  /** Additional pages in the same browser. Absent when the driver cannot run pages concurrently. */
  openPages?(count: number): Promise<PageHandle[]>;
}

export interface AdapterDefinition {
  name: string;
  description: string;
  create(): BrowserAdapter;
  /** Cheap pre-flight check so a campaign can skip a browser that is not installed. */
  checkAvailability(): Promise<Availability>;
  /** Can run in "lite" mode (resource blocking). False for browsers that never load those resources. */
  supportsLite: boolean;
  /** Anti-detection variant of another adapter (stealth plugin, patched driver...). */
  stealth?: boolean;
}

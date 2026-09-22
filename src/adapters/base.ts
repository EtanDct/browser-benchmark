import type { AntiBotRule, AntiBotVerdict } from '../antibot/evaluators.js';

export interface NavigateOptions {
  timeoutMs: number;
  /** Always waited after `load` before capturing the DOM, so late JS can run. */
  settleMs: number;
  /** Extra time allowed for an anti-bot challenge to clear itself (polled, exits early). */
  challengeWaitMs: number;
  antiBot?: AntiBotRule;
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
   * The runner then also serves local:// fixtures on it and keeps a WSL sampler warm.
   */
  wslHostIp?: string;
}

export interface BrowserAdapter {
  /** ex: "puppeteer" */
  name: string;
  launch(): Promise<LaunchResult>;
  navigate(url: string, options: NavigateOptions): Promise<NavigationResult>;
  close(): Promise<void>;
  version?(): Promise<string>;
}

export interface AdapterDefinition {
  name: string;
  description: string;
  create(): BrowserAdapter;
  /** Cheap pre-flight check so a campaign can skip a browser that is not installed. */
  checkAvailability(): Promise<Availability>;
}

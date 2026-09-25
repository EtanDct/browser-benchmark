import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pidusage from 'pidusage';
import type { ProcessLocation } from '../adapters/base.js';
import { descendantsOf, unixProcessTable } from '../util/proc.js';
import { toWslPath, wslDistroArgs } from '../util/wsl.js';
import { LineProtocolProbe } from './line-probe.js';
import { createWindowsProbe } from './windows-probe.js';

export interface RawSample {
  epochMs: number;
  memBytes: number;
  /** % of one core summed over the tree (can exceed 100). null for the first, baseline sample. */
  cpuPercent: number | null;
  processCount: number;
}

export interface ResourceSample {
  /** ms since monitoring started for this run */
  t: number;
  memBytes: number;
  cpuPercent: number | null;
  processCount: number;
}

/** private-working-set (Windows) and uss (Linux, WSL) both exclude shared pages; rss (macOS) does not. */
export type MemoryMetric = 'private-working-set' | 'uss' | 'rss';

export interface TreeProbe {
  readonly memoryMetric: MemoryMetric;
  /** False once a long-lived sampler process has died: its runs would silently get no samples. */
  readonly alive: boolean;
  start(): Promise<void>;
  restart(): Promise<void>;
  track(pid: number, onSample: (sample: RawSample) => void): void;
  untrack(): void;
  dispose(): Promise<void>;
}

export interface MinMaxAvg { min: number; max: number; avg: number }

export interface ResourceSummary {
  memoryMetric: MemoryMetric;
  sampleCount: number;
  memBytes: MinMaxAvg | null;
  cpuPercent: MinMaxAvg | null;
  peakProcessCount: number;
  /** CPU time consumed by the tree during the window (sum over samples of cpu% x interval), in seconds. Absent in older records. */
  cpuSeconds?: number | null;
}

/** macOS (no /proc), or Linux without python3: process tree from `ps`, per-process RSS/CPU from pidusage. */
class UnixTreeProbe implements TreeProbe {
  readonly memoryMetric = 'rss' as const;
  readonly alive = true;
  private generation = 0;

  constructor(private intervalMs: number) {}

  async start(): Promise<void> {}

  async restart(): Promise<void> {}

  track(pid: number, onSample: (sample: RawSample) => void): void {
    const generation = ++this.generation;
    let first = true;
    const tick = async () => {
      if (generation !== this.generation) return;
      const startedAt = Date.now();
      try {
        const table = await unixProcessTable();
        const pids = table.has(pid) ? descendantsOf(pid, table) : [];
        // One call per PID: pidusage rejects the whole batch if a single process has exited.
        const stats = await Promise.allSettled(pids.map((p) => pidusage(p)));
        let memBytes = 0;
        let cpu = 0;
        let processCount = 0;
        for (const s of stats) {
          if (s.status !== 'fulfilled') continue;
          memBytes += s.value.memory;
          cpu += s.value.cpu;
          processCount++;
        }
        if (generation === this.generation) {
          onSample({ epochMs: Date.now(), memBytes, cpuPercent: first ? null : cpu, processCount });
          first = false;
        }
      } catch {
        // A failed tick is skipped; the next one retries.
      }
      if (generation === this.generation) {
        setTimeout(tick, Math.max(0, this.intervalMs - (Date.now() - startedAt)));
      }
    };
    void tick();
  }

  untrack(): void {
    this.generation++;
    pidusage.clear();
  }

  async dispose(): Promise<void> {
    this.untrack();
  }
}

const LINUX_SAMPLER = fileURLToPath(new URL('./linux-sampler.py', import.meta.url));

/** Same sampler on a Linux host: USS, comparable with Windows' private working set. */
function createLinuxProbe(intervalMs: number): TreeProbe {
  return new LineProtocolProbe('uss', 'Linux', () =>
    spawn('python3', [LINUX_SAMPLER, String(intervalMs)], { stdio: ['pipe', 'pipe', 'pipe'] }),
  );
}

/** Browsers hosted in WSL are invisible from Windows (only wsl.exe shows): sample them from inside. */
async function createWslProbe(intervalMs: number): Promise<TreeProbe> {
  const script = await toWslPath(LINUX_SAMPLER);
  return new LineProtocolProbe('uss', 'WSL', () =>
    spawn('wsl.exe', [...wslDistroArgs(), '-e', 'python3', script, String(intervalMs)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }),
  );
}

/**
 * Samples memory/CPU of a browser's whole process tree (Chromium = browser + GPU + renderers...)
 * at a fixed interval. One sampler lives for the whole campaign; begin()/end() delimit each run.
 */
export class ResourceSampler {
  private samples: ResourceSample[] = [];
  private startedAt = 0;

  private constructor(private probe: TreeProbe) {}

  static async create(intervalMs: number, location: ProcessLocation = 'host'): Promise<ResourceSampler> {
    if (location === 'wsl') return ResourceSampler.started(await createWslProbe(intervalMs));
    if (process.platform === 'win32') return ResourceSampler.started(createWindowsProbe(intervalMs));
    if (process.platform === 'linux') {
      try {
        return await ResourceSampler.started(createLinuxProbe(intervalMs));
      } catch {
        // No python3: fall back to ps + pidusage (RSS).
      }
    }
    return ResourceSampler.started(new UnixTreeProbe(intervalMs));
  }

  private static async started(probe: TreeProbe): Promise<ResourceSampler> {
    await probe.start();
    return new ResourceSampler(probe);
  }

  /** Restarts a sampler process that died mid-campaign. Returns true when it had to. */
  async ensureAlive(): Promise<boolean> {
    if (this.probe.alive) return false;
    await this.probe.restart();
    return true;
  }

  get memoryMetric(): MemoryMetric {
    return this.probe.memoryMetric;
  }

  begin(pid: number): void {
    this.samples = [];
    this.startedAt = Date.now();
    this.probe.track(pid, (s) => {
      this.samples.push({ t: s.epochMs - this.startedAt, memBytes: s.memBytes, cpuPercent: s.cpuPercent, processCount: s.processCount });
    });
  }

  end(): ResourceSample[] {
    this.probe.untrack();
    const samples = this.samples;
    this.samples = [];
    return samples;
  }

  dispose(): Promise<void> {
    return this.probe.dispose();
  }
}

function minMaxAvg(values: number[]): MinMaxAvg | null {
  if (!values.length) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, max, avg: sum / values.length };
}

/**
 * CPU time the tree consumed: each sample's cpu% covers the interval since the previous sample.
 * Unlike an average %, it does not depend on how long the window stays open after the work is done.
 */
export function cpuSecondsOf(samples: Array<Pick<ResourceSample, 't' | 'cpuPercent'>>): number | null {
  let seconds = 0;
  let measured = false;
  for (let i = 1; i < samples.length; i++) {
    const cpu = samples[i].cpuPercent;
    if (cpu === null) continue;
    seconds += ((cpu / 100) * (samples[i].t - samples[i - 1].t)) / 1000;
    measured = true;
  }
  return measured ? Math.round(seconds * 1000) / 1000 : null;
}

export function summarizeSamples(samples: ResourceSample[], memoryMetric: MemoryMetric): ResourceSummary {
  // Samples taken after the tree died (processCount 0) would drag the averages down.
  const alive = samples.filter((s) => s.processCount > 0);
  return {
    memoryMetric,
    sampleCount: alive.length,
    memBytes: minMaxAvg(alive.map((s) => s.memBytes)),
    cpuPercent: minMaxAvg(alive.flatMap((s) => (s.cpuPercent === null ? [] : [s.cpuPercent]))),
    peakProcessCount: alive.reduce((max, s) => Math.max(max, s.processCount), 0),
    cpuSeconds: cpuSecondsOf(samples),
  };
}

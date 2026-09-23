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

/** private-working-set (Windows) and uss (Linux in WSL) both exclude shared pages; rss does not. */
export type MemoryMetric = 'private-working-set' | 'uss' | 'rss';

export interface TreeProbe {
  readonly memoryMetric: MemoryMetric;
  start(): Promise<void>;
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
}

/** Linux/macOS: process tree from `ps`, per-process RSS/CPU from pidusage. */
class UnixTreeProbe implements TreeProbe {
  readonly memoryMetric = 'rss' as const;
  private generation = 0;

  constructor(private intervalMs: number) {}

  async start(): Promise<void> {}

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

/** Browsers hosted in WSL are invisible from Windows (only wsl.exe shows): sample them from inside. */
async function createWslProbe(intervalMs: number): Promise<TreeProbe> {
  const script = await toWslPath(fileURLToPath(new URL('./wsl-sampler.py', import.meta.url)));
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
    let probe: TreeProbe;
    if (location === 'wsl') probe = await createWslProbe(intervalMs);
    else if (process.platform === 'win32') probe = createWindowsProbe(intervalMs);
    else probe = new UnixTreeProbe(intervalMs);
    await probe.start();
    return new ResourceSampler(probe);
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

export function summarizeSamples(samples: ResourceSample[], memoryMetric: MemoryMetric): ResourceSummary {
  // Samples taken after the tree died (processCount 0) would drag the averages down.
  const alive = samples.filter((s) => s.processCount > 0);
  return {
    memoryMetric,
    sampleCount: alive.length,
    memBytes: minMaxAvg(alive.map((s) => s.memBytes)),
    cpuPercent: minMaxAvg(alive.flatMap((s) => (s.cpuPercent === null ? [] : [s.cpuPercent]))),
    peakProcessCount: alive.reduce((max, s) => Math.max(max, s.processCount), 0),
  };
}

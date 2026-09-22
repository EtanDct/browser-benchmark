import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { MemoryMetric, RawSample, TreeProbe } from './resource-sampler.js';

/**
 * Drives a long-lived sampler process (PowerShell on Windows, Python inside WSL) that speaks a
 * line protocol: we write a root PID on stdin ("0" pauses), it prints "READY" once, then one
 * JSON line per tick: {"root", "t" (epoch ms), "mem" (bytes), "cpu" (% of one core | null), "n"}.
 */
export class LineProtocolProbe implements TreeProbe {
  private child?: ChildProcess;
  private current?: { pid: number; onSample: (sample: RawSample) => void };

  constructor(readonly memoryMetric: MemoryMetric, private label: string, private spawnSampler: () => ChildProcess) {}

  async start(): Promise<void> {
    const child = this.spawnSampler();
    this.child = child;
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk; });

    await new Promise<void>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout! });
      const failTimer = setTimeout(() => reject(new Error(`${this.label} sampler did not start within 60s`)), 60_000);
      child.once('exit', (code) => {
        clearTimeout(failTimer);
        reject(new Error(`${this.label} sampler exited (code ${code}): ${stderr.trim().slice(0, 500)}`));
      });
      lines.on('line', (line) => {
        if (line === 'READY') {
          clearTimeout(failTimer);
          resolve();
          return;
        }
        const current = this.current;
        if (!current || !line.startsWith('{')) return;
        const parsed = JSON.parse(line) as { root: number; t: number; mem: number; cpu: number | null; n: number };
        if (parsed.root !== current.pid) return;
        current.onSample({ epochMs: parsed.t, memBytes: parsed.mem, cpuPercent: parsed.cpu, processCount: parsed.n });
      });
    });
  }

  track(pid: number, onSample: (sample: RawSample) => void): void {
    this.current = { pid, onSample };
    this.child?.stdin?.write(`${pid}\n`);
  }

  untrack(): void {
    this.current = undefined;
    this.child?.stdin?.write('0\n');
  }

  async dispose(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    child.removeAllListeners('exit');
    child.stdin?.end();
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const killTimer = setTimeout(() => child.kill(), 2000);
    await exited;
    clearTimeout(killTimer);
  }
}

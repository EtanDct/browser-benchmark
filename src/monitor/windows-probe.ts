import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { RawSample, TreeProbe } from './resource-sampler.js';

/**
 * wmic is gone from recent Windows 11 builds (so pidusage fails) and CIM queries take ~200ms each.
 * Instead a single long-lived PowerShell process runs this C# loop: one NtQuerySystemInformation call
 * (what Task Manager uses) returns pid, parent pid, private working set and CPU times of every process,
 * in a few ms and without opening handles on sandboxed renderer processes.
 *
 * Protocol: write a root PID on stdin to start tracking its tree, "0" to pause; one JSON line per tick.
 * Offsets are for the x64 SYSTEM_PROCESS_INFORMATION layout.
 */
const CSHARP_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

public static class BenchSampler {
  [DllImport("ntdll.dll")]
  static extern int NtQuerySystemInformation(int infoClass, IntPtr buffer, int length, out int returnLength);

  struct Proc { public long Pid; public long ParentPid; public long CreateTime; public long Cpu; public long PrivateWs; }

  static volatile int root = 0;
  static IntPtr buffer = IntPtr.Zero;
  static int bufferSize = 0;

  static List<Proc> Snapshot() {
    if (buffer == IntPtr.Zero) { bufferSize = 1 << 21; buffer = Marshal.AllocHGlobal(bufferSize); }
    while (true) {
      int needed;
      int status = NtQuerySystemInformation(5, buffer, bufferSize, out needed);
      if (status == unchecked((int)0xC0000004)) {
        Marshal.FreeHGlobal(buffer);
        bufferSize = Math.Max(bufferSize * 2, needed + 65536);
        buffer = Marshal.AllocHGlobal(bufferSize);
        continue;
      }
      if (status != 0) throw new Exception("NtQuerySystemInformation failed: 0x" + status.ToString("X"));
      break;
    }
    List<Proc> list = new List<Proc>();
    long offset = 0;
    while (true) {
      IntPtr entry = new IntPtr(buffer.ToInt64() + offset);
      Proc p = new Proc();
      p.PrivateWs = Marshal.ReadInt64(entry, 0x08);
      p.CreateTime = Marshal.ReadInt64(entry, 0x20);
      p.Cpu = Marshal.ReadInt64(entry, 0x28) + Marshal.ReadInt64(entry, 0x30);
      p.Pid = Marshal.ReadIntPtr(entry, 0x50).ToInt64();
      p.ParentPid = Marshal.ReadIntPtr(entry, 0x58).ToInt64();
      list.Add(p);
      int next = Marshal.ReadInt32(entry, 0);
      if (next == 0) break;
      offset += next;
    }
    return list;
  }

  public static void Run(int intervalMs) {
    if (IntPtr.Size != 8) throw new Exception("64-bit PowerShell required");
    Thread reader = new Thread(delegate() {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        int value;
        if (int.TryParse(line.Trim(), out value)) root = value;
      }
      Environment.Exit(0);
    });
    reader.IsBackground = true;
    reader.Start();

    Dictionary<long, long> prevCpu = new Dictionary<long, long>();
    long prevTicks = 0;
    int prevRoot = 0;
    System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
    Console.Out.WriteLine("READY");
    Console.Out.Flush();

    while (true) {
      int r = root;
      if (r <= 0) { prevRoot = 0; prevCpu.Clear(); Thread.Sleep(10); continue; }
      long tickStartMs = clock.ElapsedMilliseconds;
      List<Proc> procs = Snapshot();
      long nowTicks = clock.Elapsed.Ticks;

      Dictionary<long, Proc> byPid = new Dictionary<long, Proc>();
      Dictionary<long, List<long>> children = new Dictionary<long, List<long>>();
      foreach (Proc p in procs) byPid[p.Pid] = p;
      foreach (Proc p in procs) {
        Proc parent;
        // A reused parent PID is not our parent: a child is always created after its parent.
        if (p.Pid == p.ParentPid || !byPid.TryGetValue(p.ParentPid, out parent) || p.CreateTime < parent.CreateTime) continue;
        List<long> list;
        if (!children.TryGetValue(p.ParentPid, out list)) { list = new List<long>(); children[p.ParentPid] = list; }
        list.Add(p.Pid);
      }

      bool baseline = r != prevRoot;
      long mem = 0, cpuDelta = 0;
      int count = 0;
      Dictionary<long, long> curCpu = new Dictionary<long, long>();
      HashSet<long> seen = new HashSet<long>();
      Stack<long> stack = new Stack<long>();
      if (byPid.ContainsKey(r)) stack.Push(r);
      while (stack.Count > 0) {
        long pid = stack.Pop();
        if (!seen.Add(pid)) continue;
        Proc p = byPid[pid];
        count++;
        mem += p.PrivateWs;
        curCpu[pid] = p.Cpu;
        long prev;
        if (prevCpu.TryGetValue(pid, out prev)) cpuDelta += p.Cpu - prev;
        else if (!baseline) cpuDelta += p.Cpu; // born during this interval
        List<long> kids;
        if (children.TryGetValue(pid, out kids)) foreach (long kid in kids) stack.Push(kid);
      }

      string cpu = (baseline || nowTicks <= prevTicks)
        ? "null"
        : (cpuDelta * 100.0 / (nowTicks - prevTicks)).ToString("F2", CultureInfo.InvariantCulture);
      prevCpu = curCpu;
      prevTicks = nowTicks;
      prevRoot = r;

      long epochMs = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
      Console.Out.WriteLine("{\"root\":" + r + ",\"t\":" + epochMs + ",\"mem\":" + mem + ",\"cpu\":" + cpu + ",\"n\":" + count + "}");
      Console.Out.Flush();

      int wait = intervalMs - (int)(clock.ElapsedMilliseconds - tickStartMs);
      if (wait > 0) Thread.Sleep(wait);
    }
  }
}
`;

export class WindowsTreeProbe implements TreeProbe {
  readonly memoryMetric = 'private-working-set' as const;
  private ps?: ChildProcess;
  private current?: { pid: number; onSample: (sample: RawSample) => void };

  constructor(private intervalMs: number) {}

  async start(): Promise<void> {
    const script = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${CSHARP_SOURCE}\n'@\n[BenchSampler]::Run(${this.intervalMs})`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.ps = ps;
    let stderr = '';
    ps.stderr!.on('data', (chunk) => { stderr += chunk; });

    await new Promise<void>((resolve, reject) => {
      const lines = createInterface({ input: ps.stdout! });
      const failTimer = setTimeout(() => reject(new Error('Windows sampler did not start within 30s')), 30_000);
      ps.once('exit', (code) => {
        clearTimeout(failTimer);
        reject(new Error(`Windows sampler exited (code ${code}): ${stderr.trim().slice(0, 500)}`));
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
    this.ps?.stdin?.write(`${pid}\n`);
  }

  untrack(): void {
    this.current = undefined;
    this.ps?.stdin?.write('0\n');
  }

  async dispose(): Promise<void> {
    const ps = this.ps;
    if (!ps || ps.exitCode !== null) return;
    ps.removeAllListeners('exit');
    ps.stdin?.end();
    const exited = new Promise((resolve) => ps.once('exit', resolve));
    const killTimer = setTimeout(() => ps.kill(), 2000);
    await exited;
    clearTimeout(killTimer);
  }
}

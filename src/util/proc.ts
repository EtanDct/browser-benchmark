import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { sleep } from './time.js';

const execFileAsync = promisify(execFile);
const isWindows = process.platform === 'win32';

export function findOnPath(binary: string): string | null {
  const names = isWindows ? [`${binary}.exe`, binary] : [binary];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (dir && existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export async function waitForPort(port: number, timeoutMs: number, isAlive: () => boolean = () => true): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive()) throw new Error('process exited before its port opened');
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (open) return;
    await sleep(100);
  }
  throw new Error(`port ${port} did not open within ${timeoutMs}ms`);
}

/** Parent map of every process on a Unix host (`ps` is available on Linux and macOS). */
export async function unixProcessTable(): Promise<Map<number, number>> {
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=']);
  const parents = new Map<number, number>();
  for (const line of stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid) parents.set(pid, ppid);
  }
  return parents;
}

export function descendantsOf(rootPid: number, parents: Map<number, number>): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of parents) {
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const result: number[] = [];
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop()!;
    result.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return result;
}

/** Last-resort cleanup when a browser hangs: kill the whole tree so no renderer leaks into the next run. */
export async function killTree(rootPid: number): Promise<void> {
  try {
    if (isWindows) {
      await execFileAsync('taskkill', ['/PID', String(rootPid), '/T', '/F']);
      return;
    }
    const pids = descendantsOf(rootPid, await unixProcessTable()).reverse();
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  } catch {
    // The tree is already gone.
  }
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Distro used for WSL-hosted browsers; defaults to the WSL default distro. */
export function wslDistroArgs(): string[] {
  return process.env.LIGHTPANDA_WSL_DISTRO ? ['-d', process.env.LIGHTPANDA_WSL_DISTRO] : [];
}

/** Runs a POSIX shell snippet inside WSL. The snippet must not contain double quotes (Windows argv quoting). */
export async function wslShell(script: string, timeoutMs = 60_000): Promise<string> {
  const { stdout } = await execFileAsync('wsl.exe', [...wslDistroArgs(), '-e', 'sh', '-c', script], { timeout: timeoutMs, windowsHide: true });
  return stdout.trim();
}

export async function wslAvailable(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    return (await wslShell('echo ok')) === 'ok';
  } catch {
    return false;
  }
}

/** Absolute path of an executable inside WSL: explicit path, then ~/.local/bin, then the WSL PATH. */
export async function findWslBinary(name: string, explicit?: string): Promise<string | null> {
  const candidates = explicit ? [explicit] : [`$HOME/.local/bin/${name}`];
  const script = `for c in ${candidates.join(' ')}; do [ -x $c ] && echo $c && exit 0; done; command -v ${name} || true`;
  try {
    return (await wslShell(script)) || null;
  } catch {
    return null;
  }
}

/**
 * Address of the Windows host as seen from WSL2 (NAT mode): its default gateway.
 * Windows-side servers must also listen on it to be reachable from WSL.
 */
export async function wslHostIp(): Promise<string | null> {
  try {
    const route = await wslShell('ip route show default');
    return /via (\d+\.\d+\.\d+\.\d+)/.exec(route)?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function toWslPath(windowsPath: string): Promise<string> {
  const { stdout } = await execFileAsync('wsl.exe', [...wslDistroArgs(), '-e', 'wslpath', '-a', windowsPath], { windowsHide: true });
  return stdout.trim();
}

export async function wslKill(pid: number): Promise<void> {
  try {
    await wslShell(`kill -9 ${pid} 2>/dev/null || true`, 10_000);
  } catch {
    // Already gone.
  }
}

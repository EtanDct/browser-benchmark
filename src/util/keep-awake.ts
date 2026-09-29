import { spawn, type ChildProcess } from 'node:child_process';
import { insideWsl } from './wsl.js';

/**
 * ES_CONTINUOUS | ES_SYSTEM_REQUIRED, held until stdin closes, i.e. until the benchmark process exits.
 * From WSL the request must come from a Windows process: systemd-inhibit would only reach the VM.
 */
const WINDOWS_HOLD = [
  "Add-Type -Namespace Bench -Name Power -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint flags);'",
  '[Bench.Power]::SetThreadExecutionState([uint32]2147483649) | Out-Null',
  '[Console]::In.ReadToEnd() | Out-Null',
].join('\n');

/**
 * Keeps the machine from idle-sleeping during a campaign: a sleep freezes runs mid-measurement.
 * Windows is handled by the resource sampler (windows-probe.ts), which runs for the whole campaign.
 * No setting is changed; closing the lid still sleeps. Best effort: a missing tool is ignored.
 */
export function keepAwake(): () => void {
  let child: ChildProcess | undefined;
  if (process.platform === 'darwin') {
    child = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
  } else if (insideWsl()) {
    const encoded = Buffer.from(WINDOWS_HOLD, 'utf16le').toString('base64');
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin?.on('error', () => undefined);
  } else if (process.platform === 'linux') {
    // Exits with this process, like caffeinate -w, even if it is killed without cleanup.
    child = spawn('systemd-inhibit', [
      '--what=idle:sleep', '--who=browser-benchmark', '--why=benchmark campaign', '--mode=block',
      'sh', '-c', `while kill -0 ${process.pid} 2>/dev/null; do sleep 5; done`,
    ], { stdio: 'ignore' });
  }
  if (!child) return () => undefined;
  child.on('error', () => undefined);
  child.unref();
  (child.stdin as { unref?: () => void } | null)?.unref?.();
  return () => {
    child.stdin?.end();
    child.kill();
  };
}

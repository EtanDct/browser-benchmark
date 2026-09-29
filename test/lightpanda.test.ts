import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { describe, it } from 'node:test';
import { wslServeScript } from '../src/adapters/lightpanda.js';
import { getFreePort } from '../src/util/proc.js';

describe('Lightpanda launch script in WSL', () => {
  it('has no double quotes, which do not survive Windows argv quoting', () => {
    const script = wslServeScript('/home/me/.local/bin/lightpanda', ['serve', '--port', '9222', '--load-resources', 'worker'], 9222);
    assert.ok(!script.includes('"'), script);
  });

  // Same bash script, with a small HTTP server standing in for Lightpanda.
  it('prints the server PID, then its startup time once its port accepts connections', { skip: process.platform !== 'linux' && 'needs bash 5 and /dev/tcp' }, async () => {
    const port = await getFreePort();
    const child = spawn('bash', ['-c', wslServeScript('python3', ['-m', 'http.server', '--bind', '127.0.0.1', String(port)], port)], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let serverPid = 0;
    try {
      const lines: string[] = [];
      for await (const line of createInterface({ input: child.stdout })) {
        lines.push(line);
        if (line.startsWith('READY:')) break;
      }
      assert.match(lines[0], /^PID:\d+$/);
      serverPid = Number(lines[0].slice(4));
      const ready = /^READY:(\d+)$/.exec(lines.at(-1) ?? '');
      assert.ok(ready, `no READY line in ${JSON.stringify(lines)}`);
      assert.ok(Number(ready[1]) < 10_000);
    } finally {
      if (serverPid) process.kill(serverPid);
      child.kill();
    }
  });
});

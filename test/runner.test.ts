import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import type { AdapterDefinition } from '../src/adapters/base.js';
import type { Target } from '../src/config/targets.js';
import { startByteProxy } from '../src/network/byte-proxy.js';
import { buildJobs } from '../src/runner/benchmark-runner.js';

const variant = (name: string) => ({ definition: { name } as AdapterDefinition, mode: 'full' as const, key: name });
const target = (name: string) => ({ name } as Target);

describe('buildJobs', () => {
  it('interleaves browsers every round and rotates who starts', () => {
    const jobs = buildJobs([variant('a'), variant('b'), variant('c')], [target('t')], 3, 0, 'interleaved');
    assert.deepEqual(jobs.map((j) => `${j.run}${j.variant.key}`), ['1a', '1b', '1c', '2b', '2c', '2a', '3c', '3a', '3b']);
  });

  it('adds unrecorded warm-up rounds numbered <= 0', () => {
    const jobs = buildJobs([variant('a')], [target('t'), target('u')], 2, 1, 'interleaved');
    assert.deepEqual(jobs.map((j) => `${j.target.name}${j.run}`), ['t0', 'u0', 't1', 'u1', 't2', 'u2']);
  });

  it('keeps the sequential order when asked', () => {
    const jobs = buildJobs([variant('a'), variant('b')], [target('t')], 2, 0, 'sequential');
    assert.deepEqual(jobs.map((j) => `${j.variant.key}${j.run}`), ['a1', 'a2', 'b1', 'b2']);
  });
});

describe('byte-counting proxy', () => {
  it('forwards plain HTTP and counts the bytes both ways', async () => {
    const body = 'x'.repeat(10_000);
    const origin = http.createServer((_req, res) => res.end(body));
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
    const proxy = await startByteProxy();
    try {
      const proxyPort = Number(new URL(proxy.url).port);
      const originPort = (origin.address() as AddressInfo).port;
      const received = await new Promise<string>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: proxyPort, path: `http://127.0.0.1:${originPort}/page` }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => resolve(data));
        }).on('error', reject);
      });
      assert.equal(received, body);
      const counts = proxy.read();
      assert.ok(counts.bytesDown >= 10_000, `bytesDown ${counts.bytesDown}`);
      assert.ok(counts.bytesUp > 0);
      proxy.reset();
      assert.deepEqual(proxy.read(), { bytesDown: 0, bytesUp: 0 });
    } finally {
      await proxy.close();
      origin.close();
    }
  });
});

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import type { AdapterDefinition } from '../src/adapters/base.js';
import type { Target } from '../src/config/targets.js';
import { connectTarget, startByteProxy } from '../src/network/byte-proxy.js';
import { buildJobs, pendingJobs, rawFileName } from '../src/runner/benchmark-runner.js';

const variant = (name: string) => ({ definition: { name } as AdapterDefinition, mode: 'full' as const, key: name });
const target = (name: string, runs = 1, url = 'https://x.test', group = 'performance') => ({ name, runs, url, group } as Target);
const label = (j: { variant: { key: string }; target: { name: string }; run: number }) => `${j.target.name}${j.run}${j.variant.key}`;

describe('buildJobs', () => {
  it('interleaves browsers every round and rotates who starts', () => {
    const jobs = buildJobs([variant('a'), variant('b'), variant('c')], [target('t', 3)], 0, 'interleaved');
    assert.deepEqual(jobs.map((j) => `${j.run}${j.variant.key}`), ['1a', '1b', '1c', '2b', '2c', '2a', '3c', '3a', '3b']);
  });

  it('warms each browser up once, on a local page, before any measured run', () => {
    const targets = [target('cf', 1, 'https://cf.test', 'antibot'), target('loc', 1, 'local://static', 'local')];
    const jobs = buildJobs([variant('a'), variant('b')], targets, 1, 'interleaved');
    assert.deepEqual(jobs.map(label), ['loc0a', 'loc0b', 'cf1a', 'cf1b', 'loc1a', 'loc1b']);
  });

  it('gives each target its own number of runs', () => {
    const jobs = buildJobs([variant('a')], [target('t', 3), target('u', 1)], 0, 'interleaved');
    assert.deepEqual(jobs.map(label), ['t1a', 'u1a', 't2a', 't3a']);
  });

  it('keeps the sequential order, warm-up first for each browser', () => {
    const jobs = buildJobs([variant('a'), variant('b')], [target('t', 2)], 1, 'sequential');
    assert.deepEqual(jobs.map(label), ['t0a', 't1a', 't2a', 't0b', 't1b', 't2b']);
  });
});

describe('pendingJobs (--resume)', () => {
  it('skips runs already on disk and the warm-up of browsers that are done', () => {
    const jobs = buildJobs([variant('a'), variant('b')], [target('t', 2)], 1, 'interleaved');
    const done = new Set([rawFileName('a', 't', 1), rawFileName('a', 't', 2), rawFileName('b', 't', 1)]);
    assert.deepEqual(pendingJobs(jobs, done).map(label), ['t0b', 't2b']);
  });
});

describe('connectTarget', () => {
  it('parses host:port, IPv6 literals and a missing port', () => {
    assert.deepEqual(connectTarget('example.com:8443'), { host: 'example.com', port: 8443 });
    assert.deepEqual(connectTarget('[2001:db8::1]:443'), { host: '2001:db8::1', port: 443 });
    assert.deepEqual(connectTarget('example.com'), { host: 'example.com', port: 443 });
    assert.equal(connectTarget('a:b:c'), null);
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

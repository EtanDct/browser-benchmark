import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startFixtureServer, type FixtureServer } from '../src/fixtures/server.js';

describe('fixture server', () => {
  let server: FixtureServer;
  before(async () => { server = await startFixtureServer(); });
  after(() => server.close());

  it('resolves local:// URLs and serves each page', async () => {
    for (const page of ['static', 'heavy-js?kb=10', 'images?count=3&size=16', 'spa?items=5']) {
      const response = await fetch(server.resolve(`local://${page}`));
      assert.equal(response.status, 200, page);
      assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    }
  });

  it('serves valid, deterministic PNGs', async () => {
    const url = server.resolve('local://assets/img/1.png?size=32');
    const [a, b] = await Promise.all([fetch(url), fetch(url)].map(async (p) => Buffer.from(await (await p).arrayBuffer())));
    assert.deepEqual([...a.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(a.readUInt32BE(16), 32);
    assert.ok(a.equals(b));
  });

  it('generates JS of roughly the requested weight', async () => {
    const js = await (await fetch(server.resolve('local://assets/heavy.js?kb=50'))).text();
    assert.ok(js.length >= 50 * 1024 && js.length < 52 * 1024, `got ${js.length} bytes`);
  });

  it('declares the content a correct browser ends up with', async () => {
    const expectOf = async (page: string) => {
      const html = await (await fetch(server.resolve(`local://${page}`))).text();
      const content = /<meta name="bench-expect" content="([^"]*)">/.exec(html)?.[1];
      assert.ok(content, `${page} declares no expectation`);
      return JSON.parse(content.replace(/&quot;/g, '"')) as Record<string, number>;
    };
    const js = await (await fetch(server.resolve('local://assets/heavy.js?kb=10'))).text();
    assert.deepEqual(await expectOf('heavy-js?kb=10'), { '#root > div': js.split('F.push(').length - 1 });
    assert.deepEqual(await expectOf('spa?items=5'), { '#app tr': 5 });
    assert.deepEqual(await expectOf('images?count=3&size=16'), { '.grid img': 3 });
    assert.deepEqual(await expectOf('static'), { p: 20, 'table tr': 51 });
  });

  it('returns JSON items for the SPA', async () => {
    const items = await (await fetch(server.resolve('local://api/items?n=4'))).json() as unknown[];
    assert.equal(items.length, 4);
  });
});

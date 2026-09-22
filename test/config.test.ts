import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { resolveAdapters } from '../src/adapters/registry.js';
import { loadTargets, selectTargets } from '../src/config/targets.js';

function writeConfig(main: unknown, local?: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bench-config-'));
  writeFileSync(path.join(dir, 'targets.json'), JSON.stringify(main));
  if (local) writeFileSync(path.join(dir, 'targets.local.json'), JSON.stringify(local));
  return path.join(dir, 'targets.json');
}

describe('targets config', () => {
  it('applies defaults and merges targets.local.json by name', () => {
    const file = writeConfig(
      { defaults: { timeoutMs: 5000 }, targets: [{ name: 'a', group: 'perf', url: 'https://a.test' }, { name: 'b', group: 'perf', url: 'https://b.test' }] },
      { targets: [{ name: 'b', group: 'antibot', url: 'https://private.test', antiBot: { evaluator: 'cloudflare' } }] },
    );
    const targets = loadTargets(file);
    assert.equal(targets.length, 2);
    assert.equal(targets[0].timeoutMs, 5000);
    assert.equal(targets[0].settleMs, 1000);
    assert.equal(targets[1].url, 'https://private.test');
    assert.equal(targets[1].antiBot?.evaluator, 'cloudflare');
  });

  it('rejects names that are unsafe in file names and unknown evaluators', () => {
    assert.throws(() => loadTargets(writeConfig({ targets: [{ name: 'a/b', group: 'g', url: 'https://x.test' }] })), /Invalid target name/);
    assert.throws(
      () => loadTargets(writeConfig({ targets: [{ name: 'a', group: 'g', url: 'https://x.test', antiBot: { evaluator: 'nope' } }] })),
      /unknown anti-bot evaluator/,
    );
  });

  it('selects by group, by name or all', () => {
    const targets = loadTargets(writeConfig({
      targets: [
        { name: 'a', group: 'antibot', url: 'https://a.test' },
        { name: 'b', group: 'perf', url: 'https://b.test' },
        { name: 'c', group: 'perf', url: 'local://static' },
      ],
    }));
    assert.deepEqual(selectTargets(targets, ['perf']).map((t) => t.name), ['b', 'c']);
    assert.deepEqual(selectTargets(targets, ['a', 'c']).map((t) => t.name), ['a', 'c']);
    assert.equal(selectTargets(targets, ['all']).length, 3);
    assert.throws(() => selectTargets(targets, ['zzz']), /Unknown target/);
  });
});

describe('adapter registry', () => {
  it('resolves names, aliases and all', () => {
    assert.deepEqual(resolveAdapters(['playwright']).map((a) => a.name), ['playwright-chromium', 'playwright-firefox', 'playwright-webkit']);
    assert.deepEqual(resolveAdapters(['lightpanda', 'puppeteer']).map((a) => a.name), ['puppeteer', 'lightpanda']);
    assert.equal(resolveAdapters(['all']).length, 6);
    assert.throws(() => resolveAdapters(['netscape']), /Unknown browser/);
  });
});

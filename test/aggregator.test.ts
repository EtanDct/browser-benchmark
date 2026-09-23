import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aggregate, computeStats } from '../src/aggregate/aggregator.js';
import type { RunRecord } from '../src/runner/types.js';

const environment = { platform: 'linux', osRelease: '6', arch: 'x64', cpuModel: 'cpu', cpuCount: 4, totalMemBytes: 8e9, nodeVersion: 'v22' };

function record(browser: string, target: string, run: number, overrides: Partial<RunRecord['navigation']> = {}, group = 'local'): RunRecord {
  return {
    schemaVersion: 1,
    browser,
    target,
    targetGroup: group,
    url: `local://${target}`,
    run,
    startedAt: `2026-01-01T00:00:0${run}Z`,
    launchTimeMs: 300,
    navigation: { success: true, loadTimeMs: 100 * run, domSnapshotHash: 'aaa', domStats: { elementCount: 10, textLength: 5 }, ...overrides },
    resources: {
      memoryMetric: 'rss',
      sampleIntervalMs: 200,
      summary: { memoryMetric: 'rss', sampleCount: 2, memBytes: { min: 2 ** 20, max: 3 * 2 ** 20, avg: 2 * 2 ** 20 }, cpuPercent: { min: 0, max: 50, avg: 25 }, peakProcessCount: 3 },
      samples: [{ t: 0, memBytes: 2 ** 20, cpuPercent: null, processCount: 3 }, { t: 200, memBytes: 3 * 2 ** 20, cpuPercent: 50, processCount: 3 }],
    },
    environment,
  };
}

describe('computeStats', () => {
  it('computes mean, median, sample stddev and p95', () => {
    const stats = computeStats([1, 2, 3, 4, 10])!;
    assert.equal(stats.mean, 4);
    assert.equal(stats.median, 3);
    assert.equal(stats.stddev, 3.54);
    assert.equal(stats.p95, 10);
    assert.equal(computeStats([]), null);
  });
});

describe('aggregate', () => {
  it('groups by browser x target with load, memory and cpu stats', () => {
    const report = aggregate([record('a', 'page', 1), record('a', 'page', 2), record('a', 'page', 3)]);
    const cell = report.cells[0];
    assert.equal(cell.runs, 3);
    assert.equal(cell.loadTimeMs?.median, 200);
    assert.equal(cell.memAvgMB?.mean, 2);
    assert.equal(cell.memPeakMB?.mean, 3);
    assert.equal(cell.cpuAvgPercent?.mean, 25);
    assert.deepEqual(cell.series[1].samples[1], [200, 3, 50]);
  });

  it('scores DOM fidelity against the cross-browser consensus', () => {
    const report = aggregate([
      record('a', 'page', 1), record('a', 'page', 2),
      record('b', 'page', 1), record('b', 'page', 2, { domSnapshotHash: 'bbb', domStats: { elementCount: 4, textLength: 1 } }),
      record('c', 'page', 1, { domSnapshotHash: 'ccc' }),
    ]);
    const byBrowser = Object.fromEntries(report.cells.map((c) => [c.browser, c.fidelity]));
    assert.equal(byBrowser.a?.matchRate, 1);
    assert.equal(byBrowser.b?.matchRate, 0.5);
    assert.equal(byBrowser.b?.distinctHashes, 2);
    assert.equal(byBrowser.c?.matchRate, 0);
  });

  it('counts failed page loads as failed anti-bot attempts', () => {
    const passed = { antiBot: { outcome: 'passed' as const, passed: true, detail: '', score: 1 } };
    const challenged = { antiBot: { outcome: 'challenge' as const, passed: false, detail: '', score: 0.5 } };
    const report = aggregate([
      record('a', 'cf', 1, passed, 'antibot'),
      record('a', 'cf', 2, challenged, 'antibot'),
      record('a', 'cf', 3, { success: false, errorMessage: 'timeout' }, 'antibot'),
    ]);
    const cell = report.cells[0];
    assert.equal(cell.antiBot?.evaluated, 3);
    assert.equal(cell.antiBot?.passed, 1);
    assert.equal(cell.antiBot?.meanScore, 0.5);
    assert.equal(report.targets[0].gradedAntiBot, true);
    assert.deepEqual(cell.antiBot?.outcomes, { passed: 1, challenge: 1 });
    assert.equal(report.browserSummaries[0].antiBotPassRate, 1 / 3);
    assert.deepEqual(cell.errors, ['timeout']);
  });
});

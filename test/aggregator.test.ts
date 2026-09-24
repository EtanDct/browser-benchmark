import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aggregate, campaignOf, computeStats, consensusTagCounts, latestCampaign, tagSimilarity, tCritical } from '../src/aggregate/aggregator.js';
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
    // mean 4, sd 3.54, t(4) = 2.776 -> 4 ± 4.39
    assert.deepEqual(stats.ci95, [-0.39, 8.39]);
    assert.deepEqual(computeStats([5])!.ci95, [5, 5]);
    assert.equal(computeStats([]), null);
  });

  it('uses the next smaller tabulated df between rows, for a slightly wider interval', () => {
    assert.equal(tCritical(9), 2.262);
    assert.equal(tCritical(11), 2.228);
    assert.equal(tCritical(500), 1.98);
  });
});

describe('tagSimilarity', () => {
  it('is 1 for identical DOMs and drops with missing or extra elements', () => {
    assert.equal(tagSimilarity({ DIV: 10, P: 5 }, { DIV: 10, P: 5 }), 1);
    assert.equal(tagSimilarity({ DIV: 10, P: 5 }, { DIV: 10 }), 10 / 15);
    assert.equal(tagSimilarity({ DIV: 8, IMG: 2 }, { DIV: 10 }), 8 / 12);
  });
});

describe('throughput summary', () => {
  it('derives the memory cost of one more page from the levels', () => {
    const level = (concurrency: number, memPeakMB: number) => ({ concurrency, pages: 8, successes: 8, durationMs: 1000, pagesPerMinute: 60 * concurrency, memAvgMB: memPeakMB, memPeakMB, cpuAvgPercent: 10 });
    const report = aggregate([record('a', 'page', 1)], {
      throughput: [{ schemaVersion: 1, browser: 'a', target: 'page', url: 'local://page', startedAt: '', memoryMetric: 'rss', levels: [level(1, 100), level(2, 120), level(4, 160)], environment }],
    });
    assert.equal(report.throughput[0].memPerPageMB, 20);
    assert.equal(report.throughput[0].bestPagesPerMinute, 240);
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
    // 50 % of one core over 200 ms, computed from the samples of records without cpuSeconds.
    assert.equal(cell.cpuSeconds?.median, 0.1);
    assert.equal(cell.series[0].cpuSec, 0.1);
    assert.deepEqual(cell.series[1].samples[1], [200, 3, 50]);
  });

  it('keeps anti-bot pages out of performance and fidelity figures', () => {
    const report = aggregate([
      record('a', 'page', 1),
      record('a', 'cf', 5, { antiBot: { outcome: 'challenge', passed: false, detail: '', score: 0 } }, 'antibot'),
    ]);
    assert.equal(report.browserSummaries[0].meanLoadTimeMs, 100);
    assert.equal(report.cells.find((c) => c.target === 'cf')?.fidelity, null);
    assert.equal(report.targets.find((t) => t.name === 'cf')?.antiBot, true);
  });

  it('reports the expected-content score of local pages', () => {
    const content = { score: 0.5, checks: [{ selector: '#app tr', expected: 500, found: 250 }] };
    const cell = aggregate([record('a', 'spa', 1, { content }), record('a', 'spa', 2, { content })]).cells[0];
    assert.deepEqual(cell.content, { score: 0.5, checks: [{ selector: '#app tr', expected: 500, foundMedian: 250 }] });
    assert.equal(cell.series[0].contentScore, 0.5);
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

  it('builds the DOM consensus from one vote per engine, full mode only', () => {
    const chromiumDom = { DIV: 10, P: 2 };
    const otherDom = { DIV: 10, P: 4 };
    const run = (browser: string, domTagCounts: Record<string, number>, mode: 'full' | 'lite' = 'full') =>
      ({ ...record(browser, 'page', 1, { domTagCounts }), mode });
    const runs = [
      run('puppeteer', chromiumDom), run('puppeteer-stealth', chromiumDom), run('patchright', chromiumDom),
      run('playwright-chromium', chromiumDom), run('puppeteer+lite', chromiumDom, 'lite'),
      run('playwright-firefox', otherDom), run('playwright-webkit', otherDom),
    ];
    assert.deepEqual(consensusTagCounts(runs), otherDom);
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

describe('campaigns', () => {
  it('groups records by campaign id, older records as "legacy"', () => {
    const older = { ...record('a', 'page', 1), campaign: 'w1' };
    const newer = { ...record('a', 'page', 2), campaign: 'w2' };
    assert.equal(latestCampaign([older, newer]), 'w2');
    assert.equal(campaignOf(record('a', 'page', 3)), 'legacy');
  });
});

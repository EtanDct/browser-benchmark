import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cpuSecondsOf, summarizeSamples } from '../src/monitor/resource-sampler.js';

describe('cpuSecondsOf', () => {
  it('integrates each cpu% over the interval since the previous sample', () => {
    const samples = [
      { t: 0, cpuPercent: null },
      { t: 200, cpuPercent: 100 },
      { t: 600, cpuPercent: 50 },
    ];
    // 1 core for 0.2 s + half a core for 0.4 s
    assert.equal(cpuSecondsOf(samples), 0.4);
    assert.equal(cpuSecondsOf([{ t: 0, cpuPercent: null }]), null);
  });

  it('is part of the run summary', () => {
    const summary = summarizeSamples([
      { t: 0, memBytes: 10, cpuPercent: null, processCount: 2 },
      { t: 1000, memBytes: 20, cpuPercent: 30, processCount: 2 },
    ], 'uss');
    assert.equal(summary.cpuSeconds, 0.3);
    assert.equal(summary.memBytes?.max, 20);
  });
});

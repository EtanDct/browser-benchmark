import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { completeNavigation, hashDomStructure, scoreContent, type PageSnapshot } from '../src/adapters/common.js';

const snapshot = (overrides: Partial<PageSnapshot> = {}): PageSnapshot => ({
  title: 'Home',
  url: 'https://example.org/',
  html: '<html><body>ok</body></html>',
  text: 'ok',
  tags: 'HTML,HEAD,BODY',
  tagCounts: { HTML: 1, HEAD: 1, BODY: 1 },
  elementCount: 3,
  textLength: 2,
  ...overrides,
});

const options = { timeoutMs: 1000, settleMs: 0, challengeWaitMs: 5000 };

describe('completeNavigation', () => {
  it('hashes the DOM structure and keeps the adapter load time', async () => {
    const result = await completeNavigation(async () => snapshot({ responseStatus: 200 }), { loadTimeMs: 123 }, options);
    assert.equal(result.success, true);
    assert.equal(result.loadTimeMs, 123);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.domSnapshotHash, hashDomStructure('HTML,HEAD,BODY'));
    assert.equal(result.antiBot, undefined);
  });

  it('scores the content the page declares it should end up with', async () => {
    const expected = [{ selector: '#app tr', expected: 500, found: 250 }, { selector: 'h1', expected: 1, found: 1 }];
    const result = await completeNavigation(async () => snapshot({ expected }), { loadTimeMs: 10 }, options);
    assert.equal(result.content?.score, 0.75);
    assert.equal(scoreContent([{ selector: 'p', expected: 0, found: 0 }]).score, 1);
    assert.equal(scoreContent([{ selector: 'p', expected: 4, found: 8 }]).score, 0.5);
  });

  it('polls while a challenge is displayed and reports when it clears', async () => {
    let calls = 0;
    const evaluate = async () => (++calls < 3 ? snapshot({ title: 'Just a moment...' }) : snapshot());
    const result = await completeNavigation(evaluate, { loadTimeMs: 50 }, { ...options, antiBot: { evaluator: 'cloudflare' } });
    assert.equal(result.antiBot?.outcome, 'passed');
    assert.equal(calls, 3);
    assert.ok((result.antiBot?.resolveMs ?? 0) >= 900);
  });

  it('gives up on a challenge after challengeWaitMs', async () => {
    const evaluate = async () => snapshot({ title: 'Just a moment...' });
    const result = await completeNavigation(evaluate, { loadTimeMs: 50 }, { ...options, challengeWaitMs: 600, antiBot: { evaluator: 'cloudflare' } });
    assert.equal(result.antiBot?.outcome, 'challenge');
    assert.equal(result.antiBotPassed, false);
  });

  it('keeps polling until a detection page has computed its verdict', async () => {
    let calls = 0;
    const evaluate = async () => snapshot({ text: ++calls < 3 ? 'Running checks...' : '{ "isBot": true, "details": { "isAutomatedWithCDP": true } }' });
    const result = await completeNavigation(evaluate, { loadTimeMs: 50 }, { ...options, antiBot: { evaluator: 'deviceandbrowserinfo' } });
    assert.equal(result.antiBot?.outcome, 'detected');
    assert.equal(calls, 3);
  });

  it('stops waiting for a verdict that never comes sooner than for a challenge', async () => {
    const evaluate = async () => snapshot({ text: 'Are you a bot?' });
    const started = Date.now();
    const result = await completeNavigation(evaluate, { loadTimeMs: 50 }, { ...options, challengeWaitMs: 20_000, antiBot: { evaluator: 'deviceandbrowserinfo' } });
    assert.equal(result.antiBot?.outcome, 'unknown');
    assert.ok(Date.now() - started < 10_000);
  });

  it('retries a snapshot interrupted by a navigation', async () => {
    let calls = 0;
    const evaluate = async () => {
      if (++calls === 1) throw new Error('Execution context was destroyed');
      return snapshot();
    };
    const result = await completeNavigation(evaluate, { loadTimeMs: 50 }, options);
    assert.equal(result.success, true);
  });

  it('fails the navigation when the page cannot be read', async () => {
    const result = await completeNavigation(async () => { throw new Error('boom'); }, { loadTimeMs: 50 }, options);
    assert.equal(result.success, false);
    assert.match(result.errorMessage ?? '', /boom/);
  });
});

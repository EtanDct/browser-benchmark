import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateAntiBot, type PageEvidence } from '../src/antibot/evaluators.js';

const page = (overrides: Partial<PageEvidence>): PageEvidence => ({
  html: '<html><body><h1>Welcome</h1></body></html>',
  text: 'Welcome',
  title: 'Welcome',
  url: 'https://example.org/',
  httpStatus: 200,
  ...overrides,
});

describe('cloudflare evaluator', () => {
  const rule = { evaluator: 'cloudflare' as const };

  it('passes a normal page', () => {
    assert.equal(evaluateAntiBot(rule, page({})).outcome, 'passed');
  });

  it('detects the interstitial by title, including the French locale', () => {
    assert.equal(evaluateAntiBot(rule, page({ title: 'Just a moment...' })).outcome, 'challenge');
    assert.equal(evaluateAntiBot(rule, page({ title: 'Un instant…', httpStatus: 403 })).outcome, 'challenge');
  });

  it('detects the interstitial by its challenge script options', () => {
    const html = '<html><script>window._cf_chl_opt={cvId:"3"}</script></html>';
    assert.equal(evaluateAntiBot(rule, page({ title: 'example.org', html })).outcome, 'challenge');
  });

  it('does not mistake the bot-management script injected on normal pages for a challenge', () => {
    const html = '<html><body>ok<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></body></html>';
    assert.equal(evaluateAntiBot(rule, page({ html })).outcome, 'passed');
  });

  it('reports block pages and 4xx as blocked', () => {
    assert.equal(evaluateAntiBot(rule, page({ text: 'Sorry, you have been blocked' })).outcome, 'blocked');
    assert.equal(evaluateAntiBot(rule, page({ httpStatus: 403 })).outcome, 'blocked');
  });

  it('requires successText in the visible text, not in scripts', () => {
    const withText = { ...rule, successText: 'You bypassed' };
    const html = '<script>const msg = "You bypassed the challenge"</script>';
    assert.equal(evaluateAntiBot(withText, page({ html })).outcome, 'unknown');
    assert.equal(evaluateAntiBot(withText, page({ text: 'You bypassed the Cloudflare challenge! :D' })).outcome, 'passed');
  });
});

describe('sannysoft evaluator', () => {
  const rule = { evaluator: 'sannysoft' as const };
  const row = (cls: string) => `<tr><td>check</td><td class="${cls}">x</td></tr>`;

  it('passes when no check failed', () => {
    const verdict = evaluateAntiBot(rule, page({ html: row('passed') + row('result passed') + row('warn') }));
    assert.equal(verdict.outcome, 'passed');
    assert.equal(verdict.detail, '2 passed, 1 warn, 0 failed');
  });

  it('reports detection when a check failed', () => {
    const verdict = evaluateAntiBot(rule, page({ html: row('passed') + row('passed') + row('passed') + row('failed') }));
    assert.equal(verdict.outcome, 'detected');
    assert.equal(verdict.passed, false);
    assert.equal(verdict.score, 0.75);
  });

  it('is unknown when the result table is missing', () => {
    assert.equal(evaluateAntiBot(rule, page({})).outcome, 'unknown');
  });
});

describe('deviceandbrowserinfo evaluator', () => {
  const rule = { evaluator: 'deviceandbrowserinfo' as const };

  it('lists the signals that flagged the browser', () => {
    const text = 'Are you a bot? ❌ You are a bot! { "isBot": true, "details": { "hasBotUserAgent": true, "isPlaywright": false, "isAutomatedWithCDP": true } }';
    const verdict = evaluateAntiBot(rule, page({ text }));
    assert.equal(verdict.outcome, 'detected');
    assert.equal(verdict.detail, 'isBot: true (hasBotUserAgent, isAutomatedWithCDP)');
    assert.equal(verdict.score, 0.333);
  });

  it('passes on isBot false and waits when the verdict is not computed yet', () => {
    assert.equal(evaluateAntiBot(rule, page({ text: '{ "isBot": false, "details": {} }' })).outcome, 'passed');
    assert.equal(evaluateAntiBot(rule, page({ text: 'Loading...' })).outcome, 'unknown');
  });
});

describe('creepjs evaluator', () => {
  const rule = { evaluator: 'creepjs' as const };
  const ratings = (headless: number, like: number, stealth: number) =>
    `<div class="like-headless-rating">${like}% like headless: </div><div class="headless-rating">${headless}% headless: </div><div class="stealth-rating">${stealth}% stealth: </div>`;

  it('flags headless or stealth signals', () => {
    const verdict = evaluateAntiBot(rule, page({ html: ratings(100, 38, 0) }));
    assert.equal(verdict.outcome, 'detected');
    assert.equal(verdict.detail, 'headless 100%, like-headless 38%, stealth 0%');
    assert.equal(verdict.score, 0);
    const stealthy = evaluateAntiBot(rule, page({ html: ratings(0, 20, 40) }));
    assert.equal(stealthy.outcome, 'detected');
    assert.equal(stealthy.score, 0.6);
  });

  it('passes with no headless nor stealth signal, unknown before rendering', () => {
    assert.equal(evaluateAntiBot(rule, page({ html: ratings(0, 20, 0) })).outcome, 'passed');
    assert.equal(evaluateAntiBot(rule, page({})).outcome, 'unknown');
  });
});

describe('generic evaluator', () => {
  it('uses status and failure texts', () => {
    const rule = { evaluator: 'generic' as const, failureTexts: ['Access Denied'] };
    assert.equal(evaluateAntiBot(rule, page({})).outcome, 'passed');
    assert.equal(evaluateAntiBot(rule, page({ text: 'access denied' })).outcome, 'blocked');
    assert.equal(evaluateAntiBot(rule, page({ httpStatus: 429 })).outcome, 'blocked');
  });

  it('reads verdicts with patterns', () => {
    const rule = { evaluator: 'generic' as const, detectedPattern: 'Test Results:\\s*Robot', passedPattern: 'Test Results:\\s*Normal' };
    assert.equal(evaluateAntiBot(rule, page({ text: 'Home>Bot DetectionTest Results:Robot Webdriver' })).outcome, 'detected');
    assert.equal(evaluateAntiBot(rule, page({ text: 'Test Results: Normal' })).outcome, 'passed');
    assert.equal(evaluateAntiBot(rule, page({ text: 'Scanning...' })).outcome, 'unknown');
  });
});

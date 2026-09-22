import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateAntiBot, type PageEvidence } from '../src/antibot/evaluators.js';

const page = (overrides: Partial<PageEvidence>): PageEvidence => ({
  html: '<html><body><h1>Welcome</h1></body></html>',
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
    assert.equal(evaluateAntiBot(rule, page({ title: 'Un instant…' })).outcome, 'challenge');
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
    assert.equal(evaluateAntiBot(rule, page({ html: '<h1>Sorry, you have been blocked</h1>' })).outcome, 'blocked');
    assert.equal(evaluateAntiBot(rule, page({ httpStatus: 403 })).outcome, 'blocked');
  });

  it('requires successText when configured', () => {
    const withText = { ...rule, successText: 'Dashboard' };
    assert.equal(evaluateAntiBot(withText, page({})).outcome, 'unknown');
    assert.equal(evaluateAntiBot(withText, page({ html: '<h1>Dashboard</h1>' })).outcome, 'passed');
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
    const verdict = evaluateAntiBot(rule, page({ html: row('passed') + row('failed') }));
    assert.equal(verdict.outcome, 'detected');
    assert.equal(verdict.passed, false);
  });

  it('is unknown when the result table is missing', () => {
    assert.equal(evaluateAntiBot(rule, page({})).outcome, 'unknown');
  });
});

describe('generic evaluator', () => {
  it('uses status and failure texts', () => {
    const rule = { evaluator: 'generic' as const, failureTexts: ['Access Denied'] };
    assert.equal(evaluateAntiBot(rule, page({})).outcome, 'passed');
    assert.equal(evaluateAntiBot(rule, page({ html: '<p>access denied</p>' })).outcome, 'blocked');
    assert.equal(evaluateAntiBot(rule, page({ httpStatus: 429 })).outcome, 'blocked');
  });
});

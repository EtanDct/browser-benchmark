import { createHash } from 'node:crypto';
import { evaluateAntiBot, type AntiBotVerdict } from '../antibot/evaluators.js';
import { errorMessage, sleep } from '../util/time.js';
import type { NavigateOptions, NavigationResult } from './base.js';

export interface PageSnapshot {
  title: string;
  url: string;
  html: string;
  tags: string;
  elementCount: number;
  textLength: number;
  navLoadMs?: number;
  responseStatus?: number;
}

/**
 * Evaluated in the page as a plain expression, so it works with every driver
 * (Puppeteer/Playwright `evaluate(string)`, Selenium `executeScript("return " + expr)`, Lightpanda via CDP).
 * textContent (not innerText) is used on purpose: it does not depend on a layout engine.
 */
export const SNAPSHOT_EXPRESSION = `(() => {
  const d = document;
  const els = d.getElementsByTagName('*');
  const tags = new Array(els.length);
  for (let i = 0; i < els.length; i++) tags[i] = String(els[i].tagName).toUpperCase();
  let navLoadMs, responseStatus;
  try {
    const n = performance.getEntriesByType('navigation')[0];
    if (n) {
      if (n.loadEventEnd > 0) navLoadMs = n.loadEventEnd;
      if (n.responseStatus) responseStatus = n.responseStatus;
    }
  } catch (e) {}
  return {
    title: d.title || '',
    url: String(location.href),
    html: d.documentElement ? d.documentElement.outerHTML : '',
    tags: tags.join(','),
    elementCount: els.length,
    textLength: d.body ? (d.body.textContent || '').trim().length : 0,
    navLoadMs: navLoadMs,
    responseStatus: responseStatus
  };
})()`;

export type Evaluator = (expression: string) => Promise<unknown>;

const SNAPSHOT_ATTEMPTS = 3;

/** A challenge redirect can destroy the execution context mid-evaluation, so retry briefly. */
async function takeSnapshot(evaluate: Evaluator): Promise<PageSnapshot> {
  let lastError: unknown;
  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt++) {
    try {
      const raw = (await evaluate(SNAPSHOT_EXPRESSION)) as PageSnapshot | null;
      if (raw && typeof raw.html === 'string') {
        return {
          ...raw,
          navLoadMs: raw.navLoadMs ?? undefined,
          responseStatus: raw.responseStatus ?? undefined,
        };
      }
      lastError = new Error('snapshot returned an empty result');
    } catch (err) {
      lastError = err;
    }
    await sleep(500);
  }
  throw lastError;
}

export function hashDomStructure(tags: string): string {
  return createHash('sha256').update(tags).digest('hex').slice(0, 16);
}

export interface LoadedPage {
  loadTimeMs: number;
  httpStatus?: number;
}

/** Shared post-load logic: settle, poll anti-bot challenge, snapshot and hash the DOM. */
export async function completeNavigation(
  evaluate: Evaluator,
  loaded: LoadedPage,
  options: NavigateOptions,
): Promise<NavigationResult> {
  try {
    await sleep(options.settleMs);
    let snapshot = await takeSnapshot(evaluate);
    let antiBot: AntiBotVerdict | undefined;

    if (options.antiBot) {
      const rule = options.antiBot;
      const pollStart = Date.now();
      const evidence = () => ({
        html: snapshot.html,
        title: snapshot.title,
        url: snapshot.url,
        httpStatus: snapshot.responseStatus ?? loaded.httpStatus,
      });
      antiBot = evaluateAntiBot(rule, evidence());
      while (antiBot.outcome === 'challenge' && Date.now() - pollStart < options.challengeWaitMs) {
        await sleep(500);
        snapshot = await takeSnapshot(evaluate);
        antiBot = evaluateAntiBot(rule, evidence());
      }
      antiBot.resolveMs = Date.now() - pollStart;
    }

    return {
      success: true,
      httpStatus: snapshot.responseStatus ?? loaded.httpStatus,
      loadTimeMs: loaded.loadTimeMs,
      antiBotPassed: antiBot?.passed,
      antiBot,
      domSnapshotHash: hashDomStructure(snapshot.tags),
      domStats: { elementCount: snapshot.elementCount, textLength: snapshot.textLength },
      finalUrl: snapshot.url,
      title: snapshot.title,
      navTimingLoadMs: snapshot.navLoadMs !== undefined ? Math.round(snapshot.navLoadMs) : undefined,
    };
  } catch (err) {
    return {
      success: false,
      httpStatus: loaded.httpStatus,
      loadTimeMs: loaded.loadTimeMs,
      errorMessage: `page loaded but snapshot failed: ${errorMessage(err)}`,
    };
  }
}

export function failedNavigation(startedAt: number, err: unknown): NavigationResult {
  return { success: false, loadTimeMs: Date.now() - startedAt, errorMessage: errorMessage(err) };
}

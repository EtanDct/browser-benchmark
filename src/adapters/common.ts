import { createHash } from 'node:crypto';
import { evaluateAntiBot, type AntiBotVerdict } from '../antibot/evaluators.js';
import { errorMessage, sleep } from '../util/time.js';
import type { NavigateOptions, NavigationResult } from './base.js';

export interface PageSnapshot {
  title: string;
  url: string;
  html: string;
  /** Visible text: body without script/style/noscript/template, whitespace collapsed. */
  text: string;
  tags: string;
  tagCounts: Record<string, number>;
  elementCount: number;
  textLength: number;
  navLoadMs?: number;
  responseStatus?: number;
}

/**
 * Evaluated in the page as a plain expression, so it works with every driver
 * (Puppeteer/Playwright `evaluate(string)`, Selenium `executeScript("return " + expr)`, Lightpanda via CDP).
 * Text comes from textContent on a script-free clone rather than innerText: innerText needs a layout
 * engine (Lightpanda has none), and verdict strings often also appear inside the page's scripts.
 */
export const SNAPSHOT_EXPRESSION = `(() => {
  const d = document;
  const els = d.getElementsByTagName('*');
  const tags = new Array(els.length);
  const tagCounts = {};
  for (let i = 0; i < els.length; i++) {
    const tag = String(els[i].tagName).toUpperCase();
    tags[i] = tag;
    tagCounts[tag] = (tagCounts[tag] || 0) + 1;
  }
  let text = '';
  if (d.body) {
    try {
      const clone = d.body.cloneNode(true);
      const junk = clone.querySelectorAll('script,style,noscript,template');
      for (let i = 0; i < junk.length; i++) junk[i].remove();
      text = clone.textContent || '';
    } catch (e) {
      text = d.body.textContent || '';
    }
    text = text.replace(/\\s+/g, ' ').trim().slice(0, 200000);
  }
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
    text: text,
    tags: tags.join(','),
    tagCounts: tagCounts,
    elementCount: els.length,
    textLength: text.length,
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
          text: raw.text ?? '',
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

/** Longest wait for a detection page to display its verdict (CreepJS, the slowest, needs ~5 s). */
const VERDICT_WAIT_MS = 8_000;

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
        text: snapshot.text,
        title: snapshot.title,
        url: snapshot.url,
        httpStatus: snapshot.responseStatus ?? loaded.httpStatus,
      });
      antiBot = evaluateAntiBot(rule, evidence());
      // A challenge may clear itself; detection pages compute their verdict a few seconds after load,
      // but when their script cannot run in a browser the verdict never comes, so that wait is shorter.
      const stillWaiting = (verdict: AntiBotVerdict) => {
        const elapsed = Date.now() - pollStart;
        if (verdict.outcome === 'challenge') return elapsed < options.challengeWaitMs;
        return verdict.outcome === 'unknown' && elapsed < Math.min(options.challengeWaitMs, VERDICT_WAIT_MS);
      };
      while (stillWaiting(antiBot)) {
        await sleep(500);
        snapshot = await takeSnapshot(evaluate);
        antiBot = evaluateAntiBot(rule, evidence());
      }
      antiBot.resolveMs = Date.now() - pollStart;
      if (!antiBot.passed) antiBot.excerpt = snapshot.text.slice(0, 400);
    }

    return {
      success: true,
      httpStatus: snapshot.responseStatus ?? loaded.httpStatus,
      loadTimeMs: loaded.loadTimeMs,
      antiBotPassed: antiBot?.passed,
      antiBot,
      domSnapshotHash: hashDomStructure(snapshot.tags),
      domTagCounts: snapshot.tagCounts ?? undefined,
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

/** Resource types a "lite" scraper skips: everything a DOM extraction does not need. */
export const BLOCKED_RESOURCE_TYPES = new Set(['image', 'stylesheet', 'font', 'media']);

/** Same intent for drivers that can only block by URL (Selenium via CDP Network.setBlockedURLs). */
export const BLOCKED_URL_PATTERNS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'css', 'woff', 'woff2', 'ttf', 'otf', 'mp4', 'webm', 'mp3']
  .map((ext) => `*.${ext}*`);

export function failedNavigation(startedAt: number, err: unknown): NavigationResult {
  return { success: false, loadTimeMs: Date.now() - startedAt, errorMessage: errorMessage(err) };
}

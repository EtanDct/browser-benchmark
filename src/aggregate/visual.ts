import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { RunRecord } from '../runner/types.js';

export interface VisualScore {
  /** Share of pixels that match the reference screenshot (pixelmatch, anti-aliasing tolerant). */
  similarity: number;
  reference: string;
  isReference: boolean;
}

/** Preferred reference renderers, most common engine first. */
const REFERENCE_ORDER = ['playwright-chromium', 'puppeteer', 'selenium-chrome'];

function crop(png: PNG, width: number, height: number): Buffer {
  if (png.width === width && png.height === height) return png.data;
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) png.data.copy(out, y * width * 4, y * png.width * 4, y * png.width * 4 + width * 4);
  return out;
}

/**
 * Compares every browser's screenshot of a page to one reference browser's. Only meaningful on
 * deterministic pages (local fixtures): live sites differ between two loads of the same browser.
 */
export async function computeVisualScores(records: RunRecord[], screensDir: string): Promise<{
  scores: Map<string, VisualScore>;
  references: Map<string, string>;
}> {
  const scores = new Map<string, VisualScore>();
  const references = new Map<string, string>();
  const shots = records.filter((r) => r.screenshot);

  for (const target of new Set(shots.map((r) => r.target))) {
    const own = shots.filter((r) => r.target === target);
    const byBrowser = new Map(own.map((r) => [r.browser, r.screenshot!]));
    const reference = REFERENCE_ORDER.find((b) => byBrowser.has(b)) ?? [...byBrowser.keys()].sort()[0];
    let referencePng: PNG;
    try {
      referencePng = PNG.sync.read(await readFile(path.join(screensDir, byBrowser.get(reference)!)));
    } catch {
      continue;
    }
    references.set(target, reference);

    for (const [browser, file] of byBrowser) {
      if (browser === reference) {
        scores.set(`${browser}\u0000${target}`, { similarity: 1, reference, isReference: true });
        continue;
      }
      try {
        const png = PNG.sync.read(await readFile(path.join(screensDir, file)));
        const width = Math.min(png.width, referencePng.width);
        const height = Math.min(png.height, referencePng.height);
        const diff = pixelmatch(crop(referencePng, width, height), crop(png, width, height), undefined, width, height, { threshold: 0.1 });
        scores.set(`${browser}\u0000${target}`, { similarity: Math.round((1 - diff / (width * height)) * 1000) / 1000, reference, isReference: false });
      } catch {
        // Unreadable screenshot: this browser simply has no visual score for the page.
      }
    }
  }
  return { scores, references };
}

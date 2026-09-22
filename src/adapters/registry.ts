import type { AdapterDefinition } from './base.js';
import { lightpandaDefinition } from './lightpanda.js';
import { playwrightDefinition } from './playwright.js';
import { puppeteerDefinition } from './puppeteer.js';
import { seleniumChromeDefinition } from './selenium.js';

/** Adding a browser = implement BrowserAdapter in its own file and add its definition here. */
export const ADAPTERS: AdapterDefinition[] = [
  puppeteerDefinition,
  playwrightDefinition('chromium'),
  playwrightDefinition('firefox'),
  playwrightDefinition('webkit'),
  lightpandaDefinition,
  seleniumChromeDefinition,
];

/** Shorthands accepted by --browsers, besides adapter names and "all". */
const ALIASES: Record<string, string[]> = {
  playwright: ['playwright-chromium', 'playwright-firefox', 'playwright-webkit'],
  selenium: ['selenium-chrome'],
};

export function resolveAdapters(selection: string[]): AdapterDefinition[] {
  if (selection.includes('all')) return [...ADAPTERS];
  const names = new Set(selection.flatMap((name) => ALIASES[name] ?? [name]));
  const unknown = [...names].filter((name) => !ADAPTERS.some((a) => a.name === name));
  if (unknown.length) {
    const known = [...ADAPTERS.map((a) => a.name), ...Object.keys(ALIASES), 'all'].join(', ');
    throw new Error(`Unknown browser(s): ${unknown.join(', ')}. Known: ${known}`);
  }
  return ADAPTERS.filter((a) => names.has(a.name));
}

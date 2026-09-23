import type { AdapterDefinition } from './base.js';
import { camoufoxDefinition } from './camoufox.js';
import { lightpandaDefinition } from './lightpanda.js';
import { patchrightDefinition } from './patchright.js';
import { playwrightDefinition } from './playwright.js';
import { puppeteerStealthDefinition } from './puppeteer-stealth.js';
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
  puppeteerStealthDefinition,
  patchrightDefinition,
  camoufoxDefinition,
];

/** Shorthands accepted by --browsers, besides adapter names and "all". */
const ALIASES: Record<string, string[]> = {
  playwright: ['playwright-chromium', 'playwright-firefox', 'playwright-webkit'],
  selenium: ['selenium-chrome'],
  stealth: ADAPTERS.filter((a) => a.stealth).map((a) => a.name),
  vanilla: ADAPTERS.filter((a) => !a.stealth).map((a) => a.name),
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

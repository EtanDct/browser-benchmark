import puppeteer from 'puppeteer';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { AdapterDefinition } from './base.js';
import { benchChromeAvailability } from './chrome.js';
import { PuppeteerAdapter, type PuppeteerLauncher } from './puppeteer.js';

/**
 * Same Chrome for Testing as `puppeteer`, with puppeteer-extra's stealth plugin: it patches the
 * classic headless leaks (navigator.webdriver, HeadlessChrome user agent, missing plugins, chrome.runtime...).
 * The plugin has had no release since 2023: it stands for the widely used, dated evasion set.
 */
let launcher: PuppeteerLauncher | undefined;

function stealthLauncher(): PuppeteerLauncher {
  if (!launcher) {
    // puppeteer-extra is typed against an older Puppeteer; the runtime API it wraps is unchanged.
    const extra = addExtra(puppeteer as never);
    extra.use(StealthPlugin());
    launcher = extra as unknown as PuppeteerLauncher;
  }
  return launcher;
}

export const puppeteerStealthDefinition: AdapterDefinition = {
  name: 'puppeteer-stealth',
  description: 'Puppeteer + puppeteer-extra-plugin-stealth (headless leaks patched)',
  engine: 'chromium',
  create: () => new PuppeteerAdapter('puppeteer-stealth', async () => stealthLauncher()),
  checkAvailability: benchChromeAvailability,
  supportsLite: true,
  stealth: true,
};

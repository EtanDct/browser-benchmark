import { chromium } from 'patchright';
import type { Browser, BrowserServer } from 'playwright';
import type { AdapterDefinition } from './base.js';
import { benchChromeAvailability, benchChromePath } from './chrome.js';
import { PlaywrightAdapter, proxyOption, type PlaywrightEngine } from './playwright.js';

/**
 * Patchright: a Playwright fork that removes the CDP leaks detection pages look for (Runtime.enable,
 * console domain, automation flags). It drives the same Chrome build as every other Chromium adapter,
 * so the comparison with puppeteer-stealth is about the driver patches, not about the browser.
 */
const engine: PlaywrightEngine = {
  launchServer: async (options) =>
    (await chromium.launchServer({ executablePath: await benchChromePath(), headless: true, proxy: proxyOption(options) })) as unknown as BrowserServer,
  connect: async (wsEndpoint) => (await chromium.connect(wsEndpoint)) as unknown as Browser,
};

export const patchrightDefinition: AdapterDefinition = {
  name: 'patchright',
  description: 'Patchright (Playwright fork without CDP leaks) driving the benchmark Chrome build',
  engine: 'chromium',
  create: () => new PlaywrightAdapter('patchright', async () => engine),
  checkAvailability: benchChromeAvailability,
  supportsLite: true,
  stealth: true,
};

import { chromium } from 'patchright';
import type { Browser, BrowserServer } from 'playwright';
import { errorMessage } from '../util/time.js';
import type { AdapterDefinition } from './base.js';
import { PlaywrightAdapter, proxyOption, type PlaywrightEngine } from './playwright.js';

/**
 * Patchright: a Playwright fork that removes the CDP leaks detection pages look for (Runtime.enable,
 * console domain, automation flags). It drives the installed Google Chrome rather than a bundled
 * Chromium, as its authors recommend, so there is nothing extra to download.
 */
const engine: PlaywrightEngine = {
  launchServer: async (options) =>
    (await chromium.launchServer({ channel: 'chrome', headless: true, proxy: proxyOption(options) })) as unknown as BrowserServer,
  connect: async (wsEndpoint) => (await chromium.connect(wsEndpoint)) as unknown as Browser,
};

export const patchrightDefinition: AdapterDefinition = {
  name: 'patchright',
  description: 'Patchright (Playwright fork without CDP leaks) driving the installed Google Chrome',
  create: () => new PlaywrightAdapter('patchright', async () => engine),
  async checkAvailability() {
    try {
      const browser = await chromium.launch({ channel: 'chrome', headless: true });
      await browser.close();
      return { available: true };
    } catch (err) {
      return { available: false, reason: `Google Chrome not found for patchright: ${errorMessage(err)}` };
    }
  },
  supportsLite: true,
  stealth: true,
};

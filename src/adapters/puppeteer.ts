import { existsSync } from 'node:fs';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import type { AdapterDefinition, BrowserAdapter, LaunchResult, NavigateOptions, NavigationResult } from './base.js';
import { completeNavigation, failedNavigation } from './common.js';

/** Shared by every adapter that drives a CDP browser through Puppeteer (Chromium, Lightpanda). */
export async function navigatePuppeteerPage(page: Page, url: string, options: NavigateOptions): Promise<NavigationResult> {
  const startedAt = Date.now();
  let status: number | undefined;
  try {
    const response = await page.goto(url, { waitUntil: 'load', timeout: options.timeoutMs });
    status = response?.status();
  } catch (err) {
    return failedNavigation(startedAt, err);
  }
  return completeNavigation((expr) => page.evaluate(expr), { loadTimeMs: Date.now() - startedAt, httpStatus: status }, options);
}

class PuppeteerAdapter implements BrowserAdapter {
  name = 'puppeteer';
  private browser?: Browser;
  private page?: Page;

  async launch(): Promise<LaunchResult> {
    this.browser = await puppeteer.launch({ headless: true });
    this.page = await this.browser.newPage();
    const pid = this.browser.process()?.pid;
    if (!pid) throw new Error('Puppeteer did not expose the browser PID');
    return { pid };
  }

  navigate(url: string, options: NavigateOptions): Promise<NavigationResult> {
    if (!this.page) throw new Error('launch() must be called before navigate()');
    return navigatePuppeteerPage(this.page, url, options);
  }

  async close(): Promise<void> {
    await this.browser?.close();
  }

  async version(): Promise<string> {
    return this.browser ? this.browser.version() : 'unknown';
  }
}

export const puppeteerDefinition: AdapterDefinition = {
  name: 'puppeteer',
  description: 'Chrome for Testing (headless) driven by Puppeteer over CDP',
  create: () => new PuppeteerAdapter(),
  async checkAvailability() {
    const executable = await puppeteer.executablePath();
    return existsSync(executable)
      ? { available: true }
      : { available: false, reason: `Chrome for Testing not found at ${executable} (run "npx puppeteer browsers install chrome")` };
  },
};

import puppeteer, { type Browser, type LaunchOptions as PuppeteerLaunchOptions, type Page } from 'puppeteer';
import { sleep } from '../util/time.js';
import type {
  AdapterDefinition,
  BrowserAdapter,
  LaunchOptions,
  LaunchResult,
  NavigateOptions,
  NavigationResult,
  PageHandle,
} from './base.js';
import { benchChromeAvailability, benchChromePath } from './chrome.js';
import { BLOCKED_RESOURCE_TYPES, completeNavigation, failedNavigation } from './common.js';

const blockingPages = new WeakSet<Page>();

async function enableResourceBlocking(page: Page): Promise<void> {
  if (blockingPages.has(page)) return;
  blockingPages.add(page);
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (request.isInterceptResolutionHandled()) return;
    if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) void request.abort();
    else void request.continue();
  });
}

/** Shared by every adapter that drives a CDP browser through Puppeteer (Chromium, stealth Chromium, Lightpanda). */
export async function navigatePuppeteerPage(page: Page, url: string, options: NavigateOptions): Promise<NavigationResult> {
  if (options.blockResources) await enableResourceBlocking(page);
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

export async function puppeteerScreenshot(page: Page, width: number, height: number): Promise<Buffer> {
  await page.setViewport({ width, height });
  await sleep(300);
  return Buffer.from(await page.screenshot({ type: 'png' }));
}

export function puppeteerPageHandle(page: Page, onClose?: () => Promise<void>): PageHandle {
  return {
    navigate: (url, options) => navigatePuppeteerPage(page, url, options),
    close: async () => {
      await page.close().catch(() => undefined);
      await onClose?.();
    },
  };
}

/** Anything that launches a Puppeteer Browser: puppeteer itself, or puppeteer-extra with plugins. */
export interface PuppeteerLauncher {
  launch(options: PuppeteerLaunchOptions): Promise<Browser>;
}

export class PuppeteerAdapter implements BrowserAdapter {
  private browser?: Browser;
  private page?: Page;

  constructor(public name: string, private launcher: () => Promise<PuppeteerLauncher>) {}

  async launch(options: LaunchOptions = {}): Promise<LaunchResult> {
    const launcher = await this.launcher();
    this.browser = await launcher.launch({
      headless: true,
      executablePath: await benchChromePath(),
      args: options.proxyUrl ? [`--proxy-server=${options.proxyUrl}`] : [],
    });
    this.page = await this.browser.newPage();
    const pid = this.browser.process()?.pid;
    if (!pid) throw new Error('Puppeteer did not expose the browser PID');
    return { pid };
  }

  navigate(url: string, options: NavigateOptions): Promise<NavigationResult> {
    if (!this.page) throw new Error('launch() must be called before navigate()');
    return navigatePuppeteerPage(this.page, url, options);
  }

  screenshot(width: number, height: number): Promise<Buffer> {
    if (!this.page) throw new Error('launch() must be called before screenshot()');
    return puppeteerScreenshot(this.page, width, height);
  }

  async openPages(count: number): Promise<PageHandle[]> {
    const browser = this.browser;
    if (!browser) throw new Error('launch() must be called before openPages()');
    const pages = await Promise.all(Array.from({ length: count }, () => browser.newPage()));
    return pages.map((page) => puppeteerPageHandle(page));
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
  engine: 'chromium',
  create: () => new PuppeteerAdapter('puppeteer', async () => puppeteer),
  checkAvailability: benchChromeAvailability,
  supportsLite: true,
};

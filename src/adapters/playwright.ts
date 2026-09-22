import { existsSync } from 'node:fs';
import { chromium, firefox, webkit, type Browser, type BrowserServer, type BrowserType, type Page } from 'playwright';
import type { AdapterDefinition, BrowserAdapter, LaunchResult, NavigateOptions, NavigationResult } from './base.js';
import { completeNavigation, failedNavigation } from './common.js';

const ENGINES = { chromium, firefox, webkit } satisfies Record<string, BrowserType>;
type Engine = keyof typeof ENGINES;

/**
 * launchServer() + connect() instead of launch(): it is the public API that exposes the
 * browser process, which the resource sampler needs.
 */
class PlaywrightAdapter implements BrowserAdapter {
  private server?: BrowserServer;
  private browser?: Browser;
  private page?: Page;

  constructor(public name: string, private browserType: BrowserType) {}

  async launch(): Promise<LaunchResult> {
    this.server = await this.browserType.launchServer({ headless: true });
    const pid = this.server.process().pid;
    if (!pid) throw new Error('Playwright did not expose the browser PID');
    this.browser = await this.browserType.connect(this.server.wsEndpoint());
    const context = await this.browser.newContext();
    this.page = await context.newPage();
    return { pid };
  }

  async navigate(url: string, options: NavigateOptions): Promise<NavigationResult> {
    const page = this.page;
    if (!page) throw new Error('launch() must be called before navigate()');
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

  async close(): Promise<void> {
    try {
      await this.browser?.close();
    } finally {
      await this.server?.close();
    }
  }

  async version(): Promise<string> {
    return this.browser ? this.browser.version() : 'unknown';
  }
}

export function playwrightDefinition(engine: Engine): AdapterDefinition {
  const name = `playwright-${engine}`;
  const browserType = ENGINES[engine];
  return {
    name,
    description: `Playwright ${engine} (headless)`,
    create: () => new PlaywrightAdapter(name, browserType),
    async checkAvailability() {
      return existsSync(browserType.executablePath())
        ? { available: true }
        : { available: false, reason: `${engine} not installed (run "npx playwright install ${engine}")` };
    },
  };
}

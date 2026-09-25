import { existsSync } from 'node:fs';
import { chromium, firefox, webkit, type Browser, type BrowserContext, type BrowserServer, type BrowserType, type Page } from 'playwright';
import { sleep } from '../util/time.js';
import type {
  AdapterDefinition,
  BrowserAdapter,
  Engine,
  LaunchOptions,
  LaunchResult,
  NavigateOptions,
  NavigationResult,
  PageHandle,
} from './base.js';
import { benchChromeAvailability, benchChromePath } from './chrome.js';
import { BLOCKED_RESOURCE_TYPES, completeNavigation, failedNavigation } from './common.js';

/**
 * How to start and reach one Playwright-protocol browser. Forks (patchright) and wrappers (camoufox-js)
 * ship their own copy of Playwright, so the adapter only relies on this small surface.
 * launchServer() + connect() instead of launch(): it is the public API that exposes the browser process.
 */
export interface PlaywrightEngine {
  launchServer(options: LaunchOptions): Promise<BrowserServer>;
  connect(wsEndpoint: string): Promise<Browser>;
}

const routedPages = new WeakSet<Page>();

async function enableResourceBlocking(page: Page): Promise<void> {
  if (routedPages.has(page)) return;
  routedPages.add(page);
  await page.route('**/*', (route) =>
    BLOCKED_RESOURCE_TYPES.has(route.request().resourceType()) ? route.abort() : route.continue(),
  );
}

async function navigatePlaywrightPage(page: Page, url: string, options: NavigateOptions): Promise<NavigationResult> {
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

export class PlaywrightAdapter implements BrowserAdapter {
  private server?: BrowserServer;
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;

  constructor(public name: string, private engine: () => Promise<PlaywrightEngine>) {}

  async launch(options: LaunchOptions = {}): Promise<LaunchResult> {
    const engine = await this.engine();
    this.server = await engine.launchServer(options);
    const pid = this.server.process().pid;
    if (!pid) throw new Error(`${this.name} did not expose the browser PID`);
    this.browser = await engine.connect(this.server.wsEndpoint());
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
    return { pid };
  }

  navigate(url: string, options: NavigateOptions): Promise<NavigationResult> {
    if (!this.page) throw new Error('launch() must be called before navigate()');
    return navigatePlaywrightPage(this.page, url, options);
  }

  async screenshot(width: number, height: number): Promise<Buffer> {
    const page = this.page;
    if (!page) throw new Error('launch() must be called before screenshot()');
    await page.setViewportSize({ width, height });
    await sleep(300);
    return page.screenshot({ type: 'png' });
  }

  /**
   * One isolated context per page, as scrapers do to keep sessions apart. It also keeps every page in
   * its own window: Camoufox stalls background tabs of a shared window until they time out.
   */
  async openPages(count: number): Promise<PageHandle[]> {
    const browser = this.browser;
    if (!browser) throw new Error('launch() must be called before openPages()');
    return Promise.all(Array.from({ length: count }, async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      return {
        navigate: (url: string, options: NavigateOptions) => navigatePlaywrightPage(page, url, options),
        close: () => context.close().catch(() => undefined),
      };
    }));
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

export function proxyOption(options: LaunchOptions) {
  return options.proxyUrl ? { server: options.proxyUrl } : undefined;
}

/** Chromium runs the shared benchmark Chrome build (see chrome.ts), not Playwright's chrome-headless-shell. */
export function playwrightEngine(browserType: BrowserType): PlaywrightEngine {
  return {
    launchServer: async (options) => browserType.launchServer({
      headless: true,
      executablePath: browserType.name() === 'chromium' ? await benchChromePath() : undefined,
      proxy: proxyOption(options),
    }),
    connect: (wsEndpoint) => browserType.connect(wsEndpoint),
  };
}

const ENGINES = { chromium, firefox, webkit } satisfies Record<string, BrowserType>;
const ENGINE_FAMILY: Record<keyof typeof ENGINES, Engine> = { chromium: 'chromium', firefox: 'gecko', webkit: 'webkit' };

export function playwrightDefinition(engineName: keyof typeof ENGINES): AdapterDefinition {
  const name = `playwright-${engineName}`;
  const browserType = ENGINES[engineName];
  return {
    name,
    description: engineName === 'chromium' ? 'Playwright driving the benchmark Chrome build (headless)' : `Playwright ${engineName} (headless)`,
    engine: ENGINE_FAMILY[engineName],
    create: () => new PlaywrightAdapter(name, async () => playwrightEngine(browserType)),
    async checkAvailability() {
      if (engineName === 'chromium') return benchChromeAvailability();
      return existsSync(browserType.executablePath())
        ? { available: true }
        : { available: false, reason: `${engineName} not installed (run "npm run install-browsers")` };
    },
    supportsLite: true,
  };
}

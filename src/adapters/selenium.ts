import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { Builder, type WebDriver } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import { errorMessage, sleep } from '../util/time.js';
import { getFreePort, waitForPort } from '../util/proc.js';
import type { AdapterDefinition, BrowserAdapter, LaunchOptions, LaunchResult, NavigateOptions, NavigationResult } from './base.js';
import { benchChromeAvailability, benchChromePath } from './chrome.js';
import { BLOCKED_URL_PATTERNS, completeNavigation, failedNavigation } from './common.js';

interface BinaryPaths { driverPath: string; browserPath: string }

const require = createRequire(import.meta.url);
const { getBinaryPaths } = require('selenium-webdriver/common/driverFinder') as {
  getBinaryPaths(capabilities: unknown): BinaryPaths;
};

let cachedPaths: Promise<BinaryPaths> | undefined;

/**
 * Selenium Manager resolves (and downloads if needed) the chromedriver matching the benchmark Chrome
 * build, the same one the other Chromium drivers launch. Resolved once per campaign so its lookup
 * time does not pollute every run's launch time.
 */
function resolvePaths(): Promise<BinaryPaths> {
  cachedPaths ??= benchChromePath().then((browserPath) => {
    const { driverPath } = getBinaryPaths(new chrome.Options().setBinaryPath(browserPath));
    return { driverPath, browserPath };
  });
  return cachedPaths;
}

type DevTools = { sendDevToolsCommand(cmd: string, params: object): Promise<void> };

/**
 * chromedriver is spawned by us (instead of letting Selenium do it) so its PID is known:
 * Chrome is its child, so monitoring the chromedriver tree covers the whole Selenium footprint.
 */
class SeleniumChromeAdapter implements BrowserAdapter {
  name = 'selenium-chrome';
  private driverProcess?: ChildProcess;
  private driver?: WebDriver;
  private blocking = false;

  async launch(launchOptions: LaunchOptions = {}): Promise<LaunchResult> {
    const { driverPath, browserPath } = await resolvePaths();
    const port = await getFreePort();
    const driverProcess = spawn(driverPath, [`--port=${port}`], { stdio: 'ignore' });
    this.driverProcess = driverProcess;
    await waitForPort(port, 15_000, () => driverProcess.exitCode === null);

    const options = new chrome.Options();
    // --hide-scrollbars: Puppeteer and Playwright pass it by default in headless. Without it the page
    // lays out 15 px narrower and every capture differs from theirs, although the rendering is the same.
    options.addArguments('--headless=new', '--hide-scrollbars');
    if (launchOptions.proxyUrl) options.addArguments(`--proxy-server=${launchOptions.proxyUrl}`);
    options.setBinaryPath(browserPath);
    options.setPageLoadStrategy('normal');
    this.driver = await new Builder()
      .usingServer(`http://127.0.0.1:${port}`)
      .forBrowser('chrome')
      .setChromeOptions(options)
      .build();
    if (!driverProcess.pid) throw new Error('chromedriver PID unavailable');
    return { pid: driverProcess.pid };
  }

  async navigate(url: string, options: NavigateOptions): Promise<NavigationResult> {
    const driver = this.driver;
    if (!driver) throw new Error('launch() must be called before navigate()');
    if (options.blockResources && !this.blocking) {
      // WebDriver has no request interception; Chrome's DevTools can block by URL pattern instead.
      const cdp = driver as unknown as DevTools;
      await cdp.sendDevToolsCommand('Network.enable', {});
      await cdp.sendDevToolsCommand('Network.setBlockedURLs', { urls: BLOCKED_URL_PATTERNS });
      this.blocking = true;
    }
    await driver.manage().setTimeouts({ pageLoad: options.timeoutMs });
    const startedAt = Date.now();
    try {
      await driver.get(url);
    } catch (err) {
      return failedNavigation(startedAt, err);
    }
    // WebDriver has no access to the HTTP status; completeNavigation falls back to Navigation Timing.
    return completeNavigation((expr) => driver.executeScript(`return ${expr};`), { loadTimeMs: Date.now() - startedAt }, options);
  }

  async screenshot(width: number, height: number): Promise<Buffer> {
    const driver = this.driver;
    if (!driver) throw new Error('launch() must be called before screenshot()');
    // Viewport size, as the other adapters set it: the window size would include headless window chrome.
    await (driver as unknown as DevTools).sendDevToolsCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    return Buffer.from(await driver.takeScreenshot(), 'base64');
  }

  async close(): Promise<void> {
    try {
      await this.driver?.quit();
    } finally {
      this.driverProcess?.kill();
    }
  }

  async version(): Promise<string> {
    if (!this.driver) return 'unknown';
    return (await this.driver.getCapabilities()).getBrowserVersion() ?? 'unknown';
  }
}

export const seleniumChromeDefinition: AdapterDefinition = {
  name: 'selenium-chrome',
  description: 'Benchmark Chrome build (headless) driven by Selenium WebDriver + chromedriver',
  engine: 'chromium',
  create: () => new SeleniumChromeAdapter(),
  async checkAvailability() {
    const chromeAvailability = await benchChromeAvailability();
    if (!chromeAvailability.available) return chromeAvailability;
    try {
      await resolvePaths();
      return { available: true };
    } catch (err) {
      cachedPaths = undefined;
      return { available: false, reason: `Selenium Manager could not resolve chromedriver: ${errorMessage(err)}` };
    }
  },
  supportsLite: true,
};

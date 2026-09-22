import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { Builder, type WebDriver } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import { errorMessage } from '../util/time.js';
import { getFreePort, waitForPort } from '../util/proc.js';
import type { AdapterDefinition, BrowserAdapter, LaunchResult, NavigateOptions, NavigationResult } from './base.js';
import { completeNavigation, failedNavigation } from './common.js';

interface BinaryPaths { driverPath: string; browserPath: string }

const require = createRequire(import.meta.url);
const { getBinaryPaths } = require('selenium-webdriver/common/driverFinder') as {
  getBinaryPaths(capabilities: unknown): BinaryPaths;
};

let cachedPaths: BinaryPaths | undefined;

/**
 * Selenium Manager resolves (and downloads if needed) chromedriver + Chrome. Resolved once per
 * campaign so its lookup time does not pollute every run's launch time.
 */
function resolvePaths(): BinaryPaths {
  cachedPaths ??= getBinaryPaths(new chrome.Options());
  return cachedPaths;
}

/**
 * chromedriver is spawned by us (instead of letting Selenium do it) so its PID is known:
 * Chrome is its child, so monitoring the chromedriver tree covers the whole Selenium footprint.
 */
class SeleniumChromeAdapter implements BrowserAdapter {
  name = 'selenium-chrome';
  private driverProcess?: ChildProcess;
  private driver?: WebDriver;

  async launch(): Promise<LaunchResult> {
    const { driverPath, browserPath } = resolvePaths();
    const port = await getFreePort();
    const driverProcess = spawn(driverPath, [`--port=${port}`], { stdio: 'ignore' });
    this.driverProcess = driverProcess;
    await waitForPort(port, 15_000, () => driverProcess.exitCode === null);

    const options = new chrome.Options();
    options.addArguments('--headless=new');
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
  description: 'Chrome (headless) driven by Selenium WebDriver + chromedriver',
  create: () => new SeleniumChromeAdapter(),
  async checkAvailability() {
    try {
      resolvePaths();
      return { available: true };
    } catch (err) {
      return { available: false, reason: `Selenium Manager could not resolve chromedriver/Chrome: ${errorMessage(err)}` };
    }
  },
};

import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer';
import type { Availability } from './base.js';

/**
 * The one Chromium build every Chromium driver launches (Puppeteer, Playwright, Selenium, stealth
 * variants), so comparing drivers does not also compare browser builds: by default Playwright would
 * pick its chrome-headless-shell (the old, lighter headless mode) and Selenium the installed Chrome.
 * Defaults to Puppeteer's Chrome for Testing, pinned by the lockfile; BENCH_CHROME_PATH overrides it.
 */
export async function benchChromePath(): Promise<string> {
  return process.env.BENCH_CHROME_PATH || puppeteer.executablePath();
}

export async function benchChromeAvailability(): Promise<Availability> {
  const executable = await benchChromePath();
  if (existsSync(executable)) return { available: true };
  return {
    available: false,
    reason: process.env.BENCH_CHROME_PATH
      ? `BENCH_CHROME_PATH does not exist: ${executable}`
      : `Chrome for Testing not found at ${executable} (run "npm run install-browsers")`,
  };
}

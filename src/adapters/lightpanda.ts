import { spawn, type ChildProcess } from 'node:child_process';
import puppeteer, { type Browser, type BrowserContext, type Page } from 'puppeteer';
import { findOnPath, getFreePort, waitForPort } from '../util/proc.js';
import type { AdapterDefinition, BrowserAdapter, LaunchResult, NavigateOptions, NavigationResult } from './base.js';
import { navigatePuppeteerPage } from './puppeteer.js';

/**
 * Lightpanda exposes a CDP server (`lightpanda serve`), so it is driven through puppeteer.connect().
 * There is no native Windows build: either put the Linux/macOS binary on PATH / LIGHTPANDA_BIN,
 * or point LIGHTPANDA_WS_ENDPOINT at an instance running in Docker/WSL (RAM/CPU are then not measured).
 */
function resolveBinary(): string | null {
  return process.env.LIGHTPANDA_BIN || findOnPath('lightpanda');
}

class LightpandaAdapter implements BrowserAdapter {
  name = 'lightpanda';
  private server?: ChildProcess;
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;

  async launch(): Promise<LaunchResult> {
    let endpoint = process.env.LIGHTPANDA_WS_ENDPOINT;
    let pid: number | null = null;

    if (!endpoint) {
      const binary = resolveBinary();
      if (!binary) throw new Error('Lightpanda binary not found (set LIGHTPANDA_BIN or LIGHTPANDA_WS_ENDPOINT)');
      const port = await getFreePort();
      const server = spawn(binary, ['serve', '--host', '127.0.0.1', '--port', String(port)], {
        env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: 'true' },
        stdio: 'ignore',
      });
      this.server = server;
      await waitForPort(port, 10_000, () => server.exitCode === null);
      endpoint = `ws://127.0.0.1:${port}`;
      pid = server.pid ?? null;
    }

    this.browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
    this.context = await this.browser.createBrowserContext();
    this.page = await this.context.newPage();
    return { pid };
  }

  navigate(url: string, options: NavigateOptions): Promise<NavigationResult> {
    if (!this.page) throw new Error('launch() must be called before navigate()');
    return navigatePuppeteerPage(this.page, url, options);
  }

  async close(): Promise<void> {
    try {
      await this.page?.close();
      await this.context?.close();
      await this.browser?.disconnect();
    } finally {
      this.server?.kill();
    }
  }

  async version(): Promise<string> {
    return this.browser ? this.browser.version() : 'unknown';
  }
}

export const lightpandaDefinition: AdapterDefinition = {
  name: 'lightpanda',
  description: 'Lightpanda (Zig, no rendering engine) driven by Puppeteer over its CDP server',
  create: () => new LightpandaAdapter(),
  async checkAvailability() {
    if (process.env.LIGHTPANDA_WS_ENDPOINT) {
      return { available: true, reason: `external endpoint ${process.env.LIGHTPANDA_WS_ENDPOINT}: RAM/CPU not measured` };
    }
    if (resolveBinary()) return { available: true };
    const hint = process.platform === 'win32'
      ? 'no native Windows build: run it in Docker/WSL and set LIGHTPANDA_WS_ENDPOINT=ws://127.0.0.1:9222'
      : 'install it from https://github.com/lightpanda-io/browser/releases and put it on PATH or set LIGHTPANDA_BIN';
    return { available: false, reason: `Lightpanda not found (${hint})` };
  },
};

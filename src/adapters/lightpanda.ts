import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import puppeteer, { type Browser, type BrowserContext, type Page } from 'puppeteer';
import { findOnPath, getFreePort, waitForPort } from '../util/proc.js';
import { withTimeout } from '../util/time.js';
import { findWslBinary, wslAvailable, wslDistroArgs, wslHostIp, wslKill, wslNetworkingMode, wslShell } from '../util/wsl.js';
import type {
  AdapterDefinition,
  Availability,
  BrowserAdapter,
  LaunchOptions,
  LaunchResult,
  NavigateOptions,
  NavigationResult,
  PageHandle,
} from './base.js';
import { navigatePuppeteerPage, puppeteerPageHandle } from './puppeteer.js';

/**
 * Lightpanda exposes a CDP server (`lightpanda serve`), driven here through puppeteer.connect().
 * Three ways to run it, picked in this order:
 *  - LIGHTPANDA_WS_ENDPOINT: an instance we do not own (Docker...). RAM/CPU are not measured.
 *  - Windows: the Linux build runs inside WSL2. Lightpanda has no Windows build (upstream issue #2330:
 *    "not planned", blocked on linking V8's MSVC runtime with Zig's MinGW one). Its CDP port is reached
 *    through WSL localhost forwarding and its RAM/CPU are sampled from inside WSL. With WSL's mirrored
 *    networking (.wslconfig: networkingMode=mirrored) both sides share 127.0.0.1 and no NAT hop is added.
 *  - Linux/macOS: the native binary (LIGHTPANDA_BIN, `lightpanda` on PATH, or ~/.local/bin/lightpanda).
 */
const execFileAsync = promisify(execFile);

type Mode =
  | { kind: 'external'; endpoint: string }
  /** hostIp: this machine's address behind WSL's NAT, or null in mirrored networking (shared loopback). */
  | { kind: 'wsl'; binary: string; hostIp: string | null }
  | { kind: 'native'; binary: string };

let resolvedMode: Promise<Mode | { kind: 'missing'; reason: string }> | undefined;

function resolveMode(): Promise<Mode | { kind: 'missing'; reason: string }> {
  resolvedMode ??= (async () => {
    if (process.env.LIGHTPANDA_WS_ENDPOINT) return { kind: 'external', endpoint: process.env.LIGHTPANDA_WS_ENDPOINT };
    if (process.platform === 'win32') {
      if (!(await wslAvailable())) {
        return { kind: 'missing', reason: 'no native Windows build and WSL is not available (or set LIGHTPANDA_WS_ENDPOINT)' };
      }
      const binary = await findWslBinary('lightpanda', process.env.LIGHTPANDA_WSL_BIN);
      if (!binary) {
        return { kind: 'missing', reason: 'not found in WSL: install the Linux build to ~/.local/bin/lightpanda (see README)' };
      }
      if ((await wslNetworkingMode()) === 'mirrored') return { kind: 'wsl', binary, hostIp: null };
      const hostIp = await wslHostIp();
      if (!hostIp) return { kind: 'missing', reason: 'could not determine the Windows host address from WSL' };
      return { kind: 'wsl', binary, hostIp };
    }
    const userBin = path.join(os.homedir(), '.local', 'bin', 'lightpanda');
    const binary = process.env.LIGHTPANDA_BIN || findOnPath('lightpanda') || (existsSync(userBin) ? userBin : null);
    if (binary) return { kind: 'native', binary };
    return { kind: 'missing', reason: 'install it from https://github.com/lightpanda-io/browser/releases and put it on PATH or set LIGHTPANDA_BIN' };
  })();
  return resolvedMode;
}

/**
 * Starts Lightpanda inside WSL and times its startup there, from exec to an open CDP port: from Windows,
 * wsl.exe alone takes ~350 ms and the port forwarding lags behind, which would bury Lightpanda's ~40 ms.
 * Prints PID:<linux pid>, then READY:<ms>. No double quotes: they do not survive Windows argv quoting.
 */
export function wslServeScript(binary: string, args: string[], port: number): string {
  return [
    'export LIGHTPANDA_DISABLE_TELEMETRY=true',
    't0=${EPOCHREALTIME/./}',
    `${binary} ${args.join(' ')} & p=$!`,
    'echo PID:$p',
    `until true 2>/dev/null </dev/tcp/127.0.0.1/${port}; do kill -0 $p 2>/dev/null || exit 1; sleep 0.005; done`,
    'echo READY:$(( (${EPOCHREALTIME/./} - t0) / 1000 ))',
    'wait $p',
  ].join('; ');
}

function readWslStartup(child: ChildProcess, onPid: (pid: number) => void): Promise<{ pid: number; readyMs: number }> {
  return withTimeout(new Promise<{ pid: number; readyMs: number }>((resolve, reject) => {
    let pid = 0;
    // Lines are read until the process exits, so a chatty process never blocks on a full pipe.
    createInterface({ input: child.stdout! }).on('line', (line) => {
      const [, key, value] = /^(PID|READY):(\d+)$/.exec(line.trim()) ?? [];
      if (key === 'PID') onPid(pid = Number(value));
      else if (key === 'READY' && pid) resolve({ pid, readyMs: Number(value) });
    });
    child.once('exit', (code) => reject(new Error(`Lightpanda exited early (code ${code})`)));
  }), 30_000, 'Lightpanda start in WSL');
}

class LightpandaAdapter implements BrowserAdapter {
  name = 'lightpanda';
  private server?: ChildProcess;
  private wslPid?: number;
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private mode?: Mode;
  private endpoint?: string;

  async launch(options: LaunchOptions = {}): Promise<LaunchResult> {
    const mode = await resolveMode();
    if (mode.kind === 'missing') throw new Error(`Lightpanda unavailable: ${mode.reason}`);
    this.mode = mode;

    let endpoint: string;
    let result: LaunchResult;
    let startupMs: number | undefined;
    if (mode.kind === 'external') {
      endpoint = mode.endpoint;
      result = { pid: null };
    } else {
      const port = await getFreePort();
      // Workers and iframes are off by default: a page that computes in a worker or embeds a challenge
      // iframe (Cloudflare Turnstile) would never show its result.
      const serve = ['serve', '--host', '127.0.0.1', '--port', String(port), '--load-resources', 'worker', '--load-resources', 'iframe'];
      if (options.proxyUrl) serve.push('--http-proxy', this.reachable(options.proxyUrl));
      const server = mode.kind === 'wsl'
        ? spawn('wsl.exe', [...wslDistroArgs(), '-e', 'bash', '-c', wslServeScript(mode.binary, serve, port)], {
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
          })
        : spawn(mode.binary, serve, { env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: 'true' }, stdio: 'ignore' });
      this.server = server;
      if (mode.kind === 'wsl') {
        const started = await readWslStartup(server, (pid) => { this.wslPid = pid; });
        startupMs = started.readyMs;
      }
      await waitForPort(port, 30_000, () => server.exitCode === null);
      endpoint = `ws://127.0.0.1:${port}`;
      result = mode.kind === 'wsl' ? { pid: this.wslPid!, location: 'wsl' } : { pid: server.pid ?? null };
    }

    this.endpoint = endpoint;
    const connectStart = Date.now();
    this.browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
    this.context = await this.browser.createBrowserContext();
    this.page = await this.context.newPage();
    // In WSL: startup timed inside the VM, plus the CDP session setup timed here.
    if (startupMs !== undefined) result.launchTimeMs = startupMs + (Date.now() - connectStart);
    return result;
  }

  navigate(url: string, options: NavigateOptions): Promise<NavigationResult> {
    if (!this.page) throw new Error('launch() must be called before navigate()');
    return navigatePuppeteerPage(this.page, this.reachable(url), options);
  }

  /** Lightpanda serves one page per browser context, so each extra page gets its own CDP connection. */
  async openPages(count: number): Promise<PageHandle[]> {
    const endpoint = this.endpoint;
    if (!endpoint) throw new Error('launch() must be called before openPages()');
    return Promise.all(Array.from({ length: count }, async () => {
      const browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      const handle = puppeteerPageHandle(page, async () => {
        await context.close().catch(() => undefined);
        await browser.disconnect().catch(() => undefined);
      });
      return { navigate: (url: string, options: NavigateOptions) => handle.navigate(this.reachable(url), options), close: handle.close };
    }));
  }

  /** From WSL, this machine's loopback is the VM's own: local fixtures and the proxy are reached via the host address. */
  private reachable(url: string): string {
    if (this.mode?.kind !== 'wsl' || !this.mode.hostIp) return url;
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') return url;
    parsed.hostname = this.mode.hostIp;
    return parsed.toString();
  }

  async close(): Promise<void> {
    try {
      await this.page?.close();
      await this.context?.close();
      await this.browser?.disconnect();
    } finally {
      if (this.wslPid) await wslKill(this.wslPid);
      this.server?.kill();
    }
  }

  /** Over CDP Lightpanda impersonates a Chrome version; the binary reports its real one. */
  async version(): Promise<string> {
    const mode = this.mode;
    if (!mode || mode.kind === 'external') return this.browser ? this.browser.version() : 'unknown';
    realVersion ??= (mode.kind === 'wsl'
      ? wslShell(`${mode.binary} version`)
      : execFileAsync(mode.binary, ['version']).then(({ stdout }) => stdout.trim())
    ).then((v) => `Lightpanda ${v}`, () => 'unknown');
    return realVersion;
  }
}

let realVersion: Promise<string> | undefined;

export const lightpandaDefinition: AdapterDefinition = {
  name: 'lightpanda',
  description: 'Lightpanda (Zig, no rendering engine) driven by Puppeteer over its CDP server',
  engine: 'lightpanda',
  create: () => new LightpandaAdapter(),
  async checkAvailability(): Promise<Availability> {
    const mode = await resolveMode();
    switch (mode.kind) {
      case 'missing':
        return { available: false, reason: `Lightpanda not found (${mode.reason})` };
      case 'external':
        return { available: true, reason: `external endpoint ${mode.endpoint}: RAM/CPU not measured` };
      case 'wsl':
        return mode.hostIp
          ? { available: true, reason: `runs in WSL, NAT networking (${mode.binary})`, location: 'wsl', wslHostIp: mode.hostIp }
          : { available: true, reason: `runs in WSL, mirrored networking (${mode.binary})`, location: 'wsl' };
      case 'native':
        return { available: true };
    }
  },
  // No rendering engine: it never fetches images, stylesheets or fonts, so "lite" would change nothing.
  supportsLite: false,
};

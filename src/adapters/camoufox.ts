import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Browser, BrowserServer } from 'playwright';
import type { AdapterDefinition } from './base.js';
import { PlaywrightAdapter, type PlaywrightEngine } from './playwright.js';

/**
 * Camoufox: a Firefox build patched at the C++ level to spoof its fingerprint, driven through
 * camoufox-js. camoufox-js pins its own playwright-core (matching Camoufox's Juggler protocol),
 * so the connection goes through that same copy rather than this project's Playwright.
 * Binary location: CAMOUFOX_INSTALL_DIR, else camoufox-js's per-user cache (npx camoufox-js fetch).
 */
const require = createRequire(import.meta.url);

async function camoufoxEngine(): Promise<PlaywrightEngine> {
  const camoufox = await import('camoufox-js');
  const playwrightCore = createRequire(require.resolve('camoufox-js'))('playwright-core') as typeof import('playwright');
  return {
    launchServer: async (options) =>
      // The proxy is the local byte counter, not an exit node: camoufox-js's advice to match the
      // fingerprint's geolocation to the proxy IP (and its warning) does not apply.
      (await camoufox.launchServer({ headless: true, proxy: options.proxyUrl, i_know_what_im_doing: true })) as unknown as BrowserServer,
    connect: async (wsEndpoint) => (await playwrightCore.firefox.connect(wsEndpoint)) as unknown as Browser,
  };
}

async function installDir(): Promise<string> {
  const { INSTALL_DIR } = (await import('camoufox-js/dist/pkgman.js')) as { INSTALL_DIR: string };
  return INSTALL_DIR.toString();
}

export const camoufoxDefinition: AdapterDefinition = {
  name: 'camoufox',
  description: 'Camoufox (anti-detect Firefox) driven through camoufox-js',
  create: () => new PlaywrightAdapter('camoufox', camoufoxEngine),
  async checkAvailability() {
    const dir = await installDir();
    const binary = path.join(dir, process.platform === 'win32' ? 'camoufox.exe' : 'camoufox');
    return existsSync(binary)
      ? { available: true }
      : { available: false, reason: `Camoufox not found in ${dir} (run "npx camoufox-js fetch", optionally with CAMOUFOX_INSTALL_DIR)` };
  },
  supportsLite: true,
  stealth: true,
};

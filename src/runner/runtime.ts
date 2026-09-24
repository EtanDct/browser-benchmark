import { spawn } from 'node:child_process';
import type { AdapterDefinition, ProcessLocation } from '../adapters/base.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server.js';
import { ResourceSampler } from '../monitor/resource-sampler.js';
import { startByteProxy, type ByteProxy } from '../network/byte-proxy.js';
import { errorMessage } from '../util/time.js';

/** What both runners need around the browsers: availability, local pages, byte proxy, samplers. */
export interface Runtime {
  available: AdapterDefinition[];
  skipped: string[];
  fixtures: FixtureServer | null;
  proxy: ByteProxy | null;
  samplers: Partial<Record<ProcessLocation, ResourceSampler>>;
  /** Samples the browser's tree, restarting a sampler process that died (else its runs get no samples). */
  samplerFor(location: ProcessLocation): Promise<ResourceSampler | undefined>;
  dispose(): Promise<void>;
}

export interface RuntimeOptions {
  adapters: AdapterDefinition[];
  /** Extra eligibility test: returns why a browser cannot take part, or null. */
  exclude?: (definition: AdapterDefinition) => string | null;
  fixtures: boolean;
  byteProxy: boolean;
  sampleIntervalMs: number;
  log: (line: string) => void;
}

export async function prepareRuntime(options: RuntimeOptions): Promise<Runtime> {
  const { log } = options;
  const available: AdapterDefinition[] = [];
  const skipped: string[] = [];
  const wslHostIps = new Set<string>();
  const locations = new Set<ProcessLocation>(['host']);
  for (const definition of options.adapters) {
    const availability = await definition.checkAvailability();
    const excluded = availability.available ? options.exclude?.(definition) ?? null : null;
    if (!availability.available || excluded) {
      log(`skip ${definition.name}: ${excluded ?? availability.reason}`);
      skipped.push(definition.name);
      continue;
    }
    if (availability.reason) log(`note ${definition.name}: ${availability.reason}`);
    if (availability.wslHostIp) wslHostIps.add(availability.wslHostIp);
    locations.add(availability.location ?? 'host');
    available.push(definition);
  }

  // A sleep freezes runs mid-measurement. Windows: the sampler holds the request (windows-probe.ts).
  if (process.platform === 'darwin') {
    const caffeinate = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    caffeinate.on('error', () => undefined);
    caffeinate.unref();
  }

  const fixtures = options.fixtures && available.length ? await startFixtureServer([...wslHostIps]) : null;
  const proxy = options.byteProxy && available.length ? await startByteProxy([...wslHostIps]) : null;

  // The WSL sampler is started up front: it also keeps the WSL VM running, so a VM boot never
  // lands inside a measured launch.
  const samplers: Partial<Record<ProcessLocation, ResourceSampler>> = {};
  for (const location of locations) {
    try {
      samplers[location] = await ResourceSampler.create(options.sampleIntervalMs, location);
    } catch (err) {
      log(`warning: ${location} resource monitoring disabled (${errorMessage(err)})`);
    }
  }

  return {
    available,
    skipped,
    fixtures,
    proxy,
    samplers,
    async samplerFor(location) {
      const sampler = samplers[location];
      if (!sampler) return undefined;
      try {
        if (await sampler.ensureAlive()) log(`warning: ${location} resource sampler had stopped, restarted`);
        return sampler;
      } catch (err) {
        log(`warning: ${location} resource sampler could not be restarted (${errorMessage(err)})`);
        return undefined;
      }
    },
    async dispose() {
      await Promise.all(Object.values(samplers).map((s) => s.dispose()));
      await proxy?.close();
      await fixtures?.close();
    },
  };
}

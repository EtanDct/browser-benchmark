import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isKnownEvaluator, type AntiBotRule } from '../antibot/evaluators.js';

export interface TargetDefaults {
  timeoutMs: number;
  settleMs: number;
  challengeWaitMs: number;
  /** Measured runs per (browser, target); --runs overrides it for every target. */
  runs: number;
}

export interface Target {
  name: string;
  group: string;
  /** http(s) URL, or local://<fixture>?params for pages served by the built-in fixture server */
  url: string;
  description?: string;
  timeoutMs: number;
  settleMs: number;
  challengeWaitMs: number;
  /**
   * Measured runs per browser. Anti-bot verdicts barely vary from run to run while each run can wait
   * 20 s for a challenge, so those pages need fewer runs than timing measurements do.
   */
  runs: number;
  antiBot?: AntiBotRule;
  /** Screenshot it for visual comparison. Defaults to local:// pages only: live sites change between runs. */
  visual: boolean;
}

interface TargetsFile {
  defaults?: Partial<TargetDefaults>;
  targets: Array<Partial<Target> & { name: string; group: string; url: string }>;
}

const BUILTIN_DEFAULTS: TargetDefaults = { timeoutMs: 30_000, settleMs: 1_000, challengeWaitMs: 15_000, runs: 10 };
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;

function readTargetsFile(file: string): TargetsFile {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as TargetsFile;
  if (!Array.isArray(parsed.targets)) throw new Error(`${file}: "targets" must be an array`);
  return parsed;
}

/**
 * Loads config/targets.json plus the optional git-ignored config/targets.local.json
 * (private URLs such as the user's own Cloudflare-protected pages). Local entries override by name.
 */
export function loadTargets(configFile: string): Target[] {
  const main = readTargetsFile(configFile);
  const localFile = path.join(path.dirname(configFile), 'targets.local.json');
  const local = existsSync(localFile) ? readTargetsFile(localFile) : { targets: [] };
  const defaults = { ...BUILTIN_DEFAULTS, ...main.defaults, ...local.defaults };

  const byName = new Map<string, Target>();
  for (const raw of [...main.targets, ...local.targets]) {
    if (!raw.name || !NAME_PATTERN.test(raw.name)) {
      throw new Error(`Invalid target name "${raw.name}": use letters, digits and dashes (it is used in file names)`);
    }
    if (!raw.url || !/^(https?|local):\/\//.test(raw.url)) throw new Error(`Target "${raw.name}": url must be http(s):// or local://`);
    if (!raw.group) throw new Error(`Target "${raw.name}": missing "group"`);
    const runs = raw.runs ?? defaults.runs;
    if (!Number.isInteger(runs) || runs < 1) throw new Error(`Target "${raw.name}": runs must be a positive integer`);
    if (raw.antiBot && !isKnownEvaluator(raw.antiBot.evaluator)) {
      throw new Error(`Target "${raw.name}": unknown anti-bot evaluator "${raw.antiBot.evaluator}"`);
    }
    byName.set(raw.name, {
      name: raw.name,
      group: raw.group,
      url: raw.url,
      description: raw.description,
      timeoutMs: raw.timeoutMs ?? defaults.timeoutMs,
      settleMs: raw.settleMs ?? defaults.settleMs,
      challengeWaitMs: raw.challengeWaitMs ?? defaults.challengeWaitMs,
      runs,
      visual: raw.visual ?? raw.url.startsWith('local://'),
      antiBot: raw.antiBot,
    });
  }
  return [...byName.values()];
}

/** Anti-bot pages measure detection, not speed: they are left out of every performance and fidelity figure. */
export function isAntiBotTarget(target: Pick<Target, 'group' | 'antiBot'>): boolean {
  return target.group === 'antibot' || !!target.antiBot;
}

/** --targets accepts "all", group names (antibot, performance, local...) and target names. */
export function selectTargets(targets: Target[], selection: string[]): Target[] {
  if (selection.includes('all')) return targets;
  const unknown = selection.filter((s) => !targets.some((t) => t.name === s || t.group === s));
  if (unknown.length) {
    const groups = [...new Set(targets.map((t) => t.group))];
    throw new Error(`Unknown target(s): ${unknown.join(', ')}. Groups: ${groups.join(', ')}. Targets: ${targets.map((t) => t.name).join(', ')}`);
  }
  return targets.filter((t) => selection.includes(t.name) || selection.includes(t.group));
}

/** Options of src/cli.ts, shared with scripts/wsl.ts, which forwards them into WSL. */
export const CLI_OPTIONS = {
  browsers: { type: 'string', default: 'all' },
  targets: { type: 'string', default: 'all' },
  target: { type: 'string', default: 'local-heavy-js,local-spa' },
  runs: { type: 'string' },
  warmup: { type: 'string', default: '1' },
  order: { type: 'string', default: 'interleaved' },
  modes: { type: 'string', default: 'full' },
  'no-bytes': { type: 'boolean', default: false },
  'no-screenshots': { type: 'boolean', default: false },
  'no-history': { type: 'boolean', default: false },
  campaign: { type: 'string' },
  resume: { type: 'boolean', default: false },
  concurrency: { type: 'string', default: '1,2,4,8' },
  pages: { type: 'string' },
  pause: { type: 'string', default: '2000' },
  interval: { type: 'string', default: '200' },
  timeout: { type: 'string' },
  config: { type: 'string', default: 'config/targets.json' },
  results: { type: 'string', default: 'results' },
  dashboard: { type: 'string' },
  clean: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

/**
 * Options npm kept for itself instead of passing them on. Windows PowerShell drops the "--" of
 * `npm run bench -- --resume` (npm's npm.ps1 shim), so npm reads the options as its own config and
 * the command runs with its defaults: without --resume, a campaign then replaces the runs of all its
 * (browser, target) pairs. npm still exposes what it took as npm_config_<name> ("--no-x" as "x").
 */
export function swallowedByNpm(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(CLI_OPTIONS)
    .filter((name) => env[`npm_config_${name.replace(/^no-/, '').replace(/-/g, '_')}`] !== undefined)
    .map((name) => `--${name}`);
}

export function swallowedOptionsError(options: string[]): Error {
  return new Error(
    `npm kept ${options.join(', ')} for itself: the "--" before the options was lost (Windows PowerShell drops it).\n`
    + `Nothing was run. Use npm.cmd instead of npm, or quote the separator: npm run bench '--' --resume`,
  );
}

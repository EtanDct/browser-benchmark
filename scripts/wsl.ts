/**
 * Runs the benchmark under Linux, inside WSL, from this Windows working tree: every browser then runs
 * natively (Lightpanda included, which has no Windows build) and is measured the same way (USS).
 * The WSL copy lives on the VM's own disk (/mnt/c is too slow for node_modules) and keeps its own
 * node_modules, browsers, results and dashboard: Windows and Linux results are never mixed.
 */
import '../src/env.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toWslPath, wslDistroArgs, wslShell } from '../src/util/wsl.js';

const HELP = `Usage, from Windows:
  npm run wsl -- setup               install everything in WSL: Node.js, dependencies, browsers and their
                                     system libraries, Camoufox, Lightpanda (idempotent: rerun after an update)
  npm run wsl -- <script> [options]  copy this working tree to WSL, then run "npm run <script>" there
                                       e.g. npm run wsl -- bench --browsers=all
                                            npm run wsl -- throughput
                                            npm run wsl -- list
  npm run wsl -- open                open the dashboard of the WSL copy

WSL copy: BENCH_WSL_DIR (a Linux path)                                          [~/browser-benchmark]
Distribution: LIGHTPANDA_WSL_DISTRO                                                   [WSL default]`;

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORTING = new Set(['bench', 'throughput', 'aggregate', 'dashboard']);

/** Runs one step of scripts/wsl.sh inside WSL; its output streams through. */
function step(script: string, args: string[], options: { root?: boolean; input?: Buffer } = {}): void {
  const result = spawnSync('wsl.exe', [...wslDistroArgs(), ...(options.root ? ['-u', 'root'] : []), '-e', 'bash', script, ...args], {
    stdio: [options.input ? 'pipe' : 'inherit', 'inherit', 'inherit'],
    input: options.input,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`WSL step "${args[0]}" failed (exit code ${result.status})`);
}

/** Tracked and untracked files git does not ignore, plus the local targets file, which it does. */
function filesToSync(): Buffer {
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repo })
    .toString('utf8')
    .split('\0')
    .filter((f) => f && existsSync(path.join(repo, f)));
  if (existsSync(path.join(repo, 'config/targets.local.json'))) listed.push('config/targets.local.json');
  return Buffer.from(listed.join('\0'), 'utf8');
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }
  if (process.platform !== 'win32') throw new Error('npm run wsl is for Windows: under Linux, run npm run <script> directly');

  const home = await wslShell('echo $HOME');
  const dest = process.env.BENCH_WSL_DIR || `${home}/browser-benchmark`;
  const src = await toWslPath(repo);
  const script = `${src}/scripts/wsl.sh`;
  const dashboard = `\\\\wsl.localhost\\${await wslShell('echo $WSL_DISTRO_NAME')}${dest.replace(/\//g, '\\')}\\dashboard\\index.html`;

  if (command === 'open') {
    // explorer.exe hands the page to the default browser; it exits with 1 even when it succeeds.
    spawnSync('explorer.exe', [dashboard]);
    return;
  }

  if (command === 'setup') {
    console.log('== System packages (root) ==');
    step(script, ['system'], { root: true });
    console.log('\n== Node.js ==');
    step(script, ['node']);
  }
  step(script, ['sync', src, dest], { input: filesToSync() });
  step(script, ['deps', dest]);
  if (command === 'setup') {
    console.log('\n== System libraries and fonts of the browsers (root) ==');
    step(script, ['browser-deps', dest, `${home}/.local/lib/nodejs/bin/node`], { root: true });
    console.log('\n== Browsers ==');
    step(script, ['browsers', dest]);
    console.log('');
    step(script, ['run', dest, 'list']);
    console.log(`\nReady. Run a campaign with: npm run wsl -- bench`);
    return;
  }

  step(script, ['run', dest, command, ...(rest.length ? ['--', ...rest] : [])]);
  // With --results or --dashboard the page is elsewhere, and the command already printed where.
  if (REPORTING.has(command) && !rest.some((a) => /^--(results|dashboard)\b/.test(a))) {
    console.log(`\nDashboard (Linux): ${dashboard}\nOpen it with: npm run wsl -- open`);
  }
}

main().catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});

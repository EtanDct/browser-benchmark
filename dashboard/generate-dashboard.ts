import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEMPLATE = fileURLToPath(new URL('./template.html', import.meta.url));

export interface DashboardOptions {
  /** Emit page content only (no doctype/html/head/body): Artifact hosting wraps it in its own skeleton. */
  artifact?: boolean;
}

function stripDocumentShell(html: string): string {
  return html
    .replace(/<!doctype html>\s*/i, '')
    .replace(/<html[^>]*>\s*/i, '')
    .replace(/<\/html>\s*$/i, '')
    .replace(/<\/?head>\s*/gi, '')
    .replace(/<meta (charset|name="viewport")[^>]*>\s*/gi, '')
    .replace(/<\/?body>\s*/gi, '');
}

/** Inlines aggregated.json into the template: the result is a single file that opens without a server. */
export async function generateDashboard(aggregatedFile: string, outFile: string, options: DashboardOptions = {}): Promise<string> {
  const [template, json] = await Promise.all([readFile(TEMPLATE, 'utf8'), readFile(aggregatedFile, 'utf8')]);
  // Escaping "<" keeps "</script>" (or "</body>") inside the data from closing a tag.
  const payload = JSON.stringify(JSON.parse(json)).replace(/</g, '\\u003c');
  const page = template.replace('__BENCH_DATA__', () => payload);
  await writeFile(outFile, options.artifact ? stripDocumentShell(page) : page);
  return outFile;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const artifact = args.includes('--artifact');
  const [aggregated = 'results/aggregated.json', out = artifact ? 'dashboard/artifact.html' : 'dashboard/index.html'] = args.filter((a) => !a.startsWith('--'));
  generateDashboard(path.resolve(aggregated), path.resolve(out), { artifact })
    .then((file) => console.log(`Dashboard -> ${file}`))
    .catch((err: Error) => {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    });
}

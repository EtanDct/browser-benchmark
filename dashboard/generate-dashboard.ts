import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEMPLATE = fileURLToPath(new URL('./template.html', import.meta.url));

/** Inlines aggregated.json into the template: the result is a single file that opens without a server. */
export async function generateDashboard(aggregatedFile: string, outFile: string): Promise<string> {
  const [template, json] = await Promise.all([readFile(TEMPLATE, 'utf8'), readFile(aggregatedFile, 'utf8')]);
  // Escaping "<" keeps "</script>" inside the data from closing the tag.
  const payload = JSON.stringify(JSON.parse(json)).replace(/</g, '\\u003c');
  await writeFile(outFile, template.replace('__BENCH_DATA__', () => payload));
  return outFile;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const aggregated = path.resolve(process.argv[2] ?? 'results/aggregated.json');
  const out = path.resolve(process.argv[3] ?? 'dashboard/index.html');
  generateDashboard(aggregated, out)
    .then((file) => console.log(`Dashboard -> ${file}`))
    .catch((err: Error) => {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    });
}

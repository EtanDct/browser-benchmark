/**
 * Opens a generated dashboard in headless Chrome, visits every tab and fails on any script error or
 * empty table: the template's JavaScript has no other test. Usage: npm run check-dashboard [file]
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';
import { benchChromePath } from '../src/adapters/chrome.js';

const file = path.resolve(process.argv[2] ?? 'dashboard/index.html');
const problems: string[] = [];
const browser = await puppeteer.launch({ headless: true, executablePath: await benchChromePath() });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', (err) => problems.push(`page error: ${err instanceof Error ? err.message : String(err)}`));
  page.on('console', (msg) => { if (msg.type() === 'error') problems.push(`console error: ${msg.text()}`); });
  await page.goto(pathToFileURL(file).href, { waitUntil: 'networkidle0' });

  const rowCount = (selector: string) =>
    page.$$eval(`${selector} tbody tr`, (rows) => rows.filter((r) => !r.querySelector('td.empty')).length);
  for (const tab of ['ranking', 'details', 'throughput', 'history']) {
    await page.click(`#tab-${tab}`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (await page.$eval(`#view-${tab}`, (el) => (el as HTMLElement).hidden)) problems.push(`the ${tab} tab did not open`);
  }
  await page.click('#tab-ranking');
  if (!(await rowCount('#ranking-table'))) problems.push('the ranking table is empty');
  await page.click('#tab-details');
  for (const table of ['#summary-table', '#detail-table']) if (!(await rowCount(table))) problems.push(`${table} is empty`);
  const charts = await page.$$eval('canvas', (canvases) => canvases.filter((c) => (c as HTMLCanvasElement).width > 0).length);
  if (!charts) problems.push('no chart was drawn');
  console.log(`${path.basename(file)}: 4 tabs visited, ${charts} charts drawn`);
} finally {
  await browser.close();
}
if (problems.length) {
  console.error(problems.map((p) => `- ${p}`).join('\n'));
  process.exitCode = 1;
}

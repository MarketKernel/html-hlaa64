// Exercise instruction sugar in the actual offline workbench bundle and worker.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const chrome = process.env.CHROME ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find(p => existsSync(p));
if (!chrome) { console.log('Stack browser test skipped: set CHROME to a Chrome executable.'); process.exit(0); }
const browser = await puppeteer.launch({executablePath:chrome,headless:true,args:['--allow-file-access-from-files']});
const fixture = process.argv[2] ?? 'tests/cases/stack-pointer.hla';
const source = readFileSync(fixture, 'utf8'), expected = readFileSync(fixture.replace(/\.hla$/, '.expected'), 'utf8').trim();
const firstFunction = /naked fn (\w+)/.exec(source)?.[1];
assert.ok(firstFunction, 'fixture names a naked function');
try {
  const page = await browser.newPage(), errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.setOfflineMode(true);
  await page.goto(pathToFileURL(resolve('dist/hla64.html')).href);
  await page.waitForFunction(() => document.getElementById('v-run')?.textContent?.startsWith('exit'));
  await page.$eval('#src', (node, source) => {
    (node as HTMLTextAreaElement).value = source;
    node.dispatchEvent(new Event('input', {bubbles:true}));
  }, source);
  await page.waitForFunction((name: string) => document.querySelector('#asmView')?.textContent?.includes('_' + name), {}, firstFunction);
  await page.click('#run');
  await page.waitForFunction((out: string) => document.getElementById('console')?.textContent?.trim() === out, {}, expected);
  const output = await page.$eval('#console', node => node.textContent?.trim());
  assert.equal(output, expected);
  assert.deepEqual(errors, []);
  console.log(`Browser fixture passed: ${fixture} compiles and runs in the offline HLA64 bundle.`);
} finally { await browser.close(); }

// Opens dist/hla64.html in headless Chrome and goes through the examples of the toolchain written in
// HLA64 on both platforms: the translator writes the assembly into its project, the assembler makes an
// executable of its hello.s, which then runs from the console. Screenshots go to the directory given (default: .).
//   node tools/check-selfhost-web.ts [dir]
import puppeteer, { type Page } from 'puppeteer-core';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const out = process.argv[2] ?? '.';
const chrome = process.env.CHROME ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
].find((p) => existsSync(p));
if (!chrome) { console.log('Chrome not found: set CHROME=path/to/chrome'); process.exit(2); }
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--allow-file-access-from-files'] });
const page = await browser.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + (e as Error).message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(resolve('dist/hla64.html')).href);
let fails = 0;
const check = (what: string, ok: boolean, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ' ' + detail}`); if (!ok) fails++; };

/** run and wait for the run to finish; returns the console text */
async function runDone(p: Page, start: () => Promise<void>): Promise<string> {
  await p.evaluate(() => { document.getElementById('v-run')!.textContent = '…'; });
  await start();
  await p.waitForFunction(() => /^(exit|crashed|stopped)/.test(document.getElementById('v-run')?.textContent ?? ''), { timeout: 120000 });
  return p.$eval('#console', (e) => e.textContent ?? '');
}
const files = (p: Page) => p.$$eval('#file-list li .nm', (els) => els.map((e) => e.textContent));

for (const [plat, tools, asmName, exe] of [['mac', ['hlc-arm', 'hlas-arm'], 'hello.s', 'hello'], ['win', ['hlc-x64', 'hlas-x64'], 'hello-x64.s', 'hello.exe']] as const) {
  await page.click(`#plat-${plat}`);
  await new Promise((r) => setTimeout(r, 300));
  // the translator: hello.hla -> assembly, written into the project
  await page.evaluate(() => { localStorage.clear(); });
  const text = await runDone(page, () => page.click('#ex-list li[data-example="hlc"]'));
  check(`${plat}: ${tools[0]} runs on open`, (await page.$eval('#v-run', (e) => e.textContent)) === 'exit 0', text);
  check(`${plat}: ${asmName} added to the project`, (await files(page)).includes(asmName));
  check(`${plat}: arguments of ${tools[0]}`, (await page.$eval('#args', (e) => (e as HTMLInputElement).value)) === `hello.hla ${asmName}`);
  await page.screenshot({ path: `${out}/selfhost-${plat}-translated.png` });
  // the assembler: its own copy of the assembly -> an executable, which then runs
  const t2 = await runDone(page, () => page.click('#ex-list li[data-example="hlas"]'));
  check(`${plat}: the assembler example opens ${asmName}`, (await page.$eval('#filename', (e) => e.textContent)) === asmName);
  check(`${plat}: assembly is highlighted`, (await page.$$('#hl .t-mn')).length > 10);
  check(`${plat}: ${tools[1]} runs on open and writes ${exe}`, t2.includes(`${exe} · ${plat === 'mac' ? 'Mach-O' : 'PE'} executable`), t2);
  await page.screenshot({ path: `${out}/selfhost-${plat}-assembled.png` });
  const t3 = await runDone(page, () => page.$eval('#console .out button', (b) => (b as HTMLButtonElement).click()));
  check(`${plat}: ${exe} runs`, t3.includes('Hello from a toolchain written in HLA64!') && t3.includes('fib(10) = 55'), t3);
  await page.screenshot({ path: `${out}/selfhost-${plat}-ran.png` });
}
check('no page errors', errors.length === 0, errors.join('\n'));
await browser.close();
process.exit(fails ? 1 : 0);

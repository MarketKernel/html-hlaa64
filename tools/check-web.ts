// Opens dist/hla64.html in headless Chrome, waits for the auto-run, reports errors, saves screenshots;
// runs the examples of every platform and the program a WebAssembly download contains.
import puppeteer from 'puppeteer-core';
import { resolve, join, dirname } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const out = process.argv[2] ?? '.';
const chrome = process.env.CHROME ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
].find((p) => existsSync(p));
if (!chrome) { console.log('Chrome not found: set CHROME=path/to/chrome'); process.exit(2); }
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--allow-file-access-from-files'],
});
const page = await browser.newPage();
const errors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push('pageerror: ' + (e as Error).message));
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(resolve('dist/hla64.html')).href);
await page.waitForFunction(() => document.getElementById('v-run')?.textContent?.startsWith('exit') || document.querySelector('#st-run[data-state="err"]'), { timeout: 20000 });
const status = await page.$eval('#runStatus', (e) => (e as HTMLElement).innerText);
const stages = await page.$$eval('.stage', (els) => els.map((e) => (e as HTMLElement).innerText.replace(/\n/g, ' | ')));
console.log(stages.join('\n'));
console.log('status:', status);
console.log((await page.$eval('#console', (e) => e.textContent ?? '')).split('\n').slice(0, 6).join('\n'));
await page.screenshot({ path: `${out}/web-console.png` });
for (const tab of ['bin', 'macho']) {
  await page.click(`.tab[data-tab="${tab}"]`);
  await page.screenshot({ path: `${out}/web-${tab}.png` });
}
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
await page.click('.tab[data-tab="asm"]');
await page.screenshot({ path: `${out}/web-asm-dark.png` });
await page.setViewport({ width: 400, height: 860, deviceScaleFactor: 1 });
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
await page.screenshot({ path: `${out}/web-phone.png`, fullPage: false });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
console.log('horizontal overflow at 400px:', overflow);
// ---------------------------------------------------------------- Windows platform
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
const waitRun = () => page.waitForFunction(() => document.getElementById('v-run')?.textContent?.startsWith('exit') || document.querySelector('#st-run[data-state="err"]'), { timeout: 30000 });
await page.click('#plat-win');
await new Promise((r) => setTimeout(r, 1000));   // the platform's project opens asynchronously (IndexedDB)
await waitRun();
console.log('--- Windows');
console.log((await page.$$eval('.stage', (els) => els.map((e) => (e as HTMLElement).innerText.replace(/\n/g, ' | ')))).join('\n'));
await page.screenshot({ path: `${out}/web-win-console.png` });
for (const tab of ['bin', 'macho']) {
  await page.click(`.tab[data-tab="${tab}"]`);
  await page.screenshot({ path: `${out}/web-win-${tab}.png` });
}
const ids = await page.$$eval('#ex-list li[data-example]', (os) => os.map((o) => (o as HTMLElement).dataset.example!));
for (const id of ids) {
  await page.click(`#ex-list li[data-example="${id}"]`);
  await new Promise((r) => setTimeout(r, 150));
  const lib = await page.$eval('#mode-exe', (e) => !(e as HTMLInputElement).checked);
  if (lib) {
    const st = await page.$eval('#st-macho', (e) => (e as HTMLElement).innerText.replace(/\n/g, ' | '));
    console.log(`${id}: library: ${st}`);
    await page.click('.tab[data-tab="header"]');
    await page.screenshot({ path: `${out}/web-win-${id}-header.png` });
    await page.click('#mode-dynamic');
    console.log(`${id}: DLL: ${await page.$eval('#st-macho', (e) => (e as HTMLElement).innerText.replace(/\n/g, ' | '))}`);
    await page.click('.tab[data-tab="macho"]');
    await page.screenshot({ path: `${out}/web-win-${id}-dll.png` });
    await page.click('#mode-static');
    continue;
  }
  await page.waitForFunction(() => document.getElementById('v-run')?.textContent === 'running…' || true);
  await waitRun();
  const st = await page.$eval('#runStatus', (e) => (e as HTMLElement).innerText.replace(/\n/g, ' '));
  const first = (await page.$eval('#console', (e) => e.textContent ?? '')).split('\n').slice(-2).join(' / ');
  console.log(`${id}: ${st} :: ${first}`);
}
// ---------------------------------------------------------------- WebAssembly platform
await page.click('#plat-wasm');
await new Promise((r) => setTimeout(r, 1000));
await waitRun();
console.log('--- WebAssembly');
console.log((await page.$$eval('.stage', (els) => els.map((e) => (e as HTMLElement).innerText.replace(/\n/g, ' | ')))).join('\n'));
await page.screenshot({ path: `${out}/web-wasm-console.png` });
for (const tab of ['asm', 'bin', 'macho']) {
  await page.click(`.tab[data-tab="${tab}"]`);
  await page.screenshot({ path: `${out}/web-wasm-${tab}.png` });
}
const wasmIds = await page.$$eval('#ex-list li[data-example]', (os) => os.map((o) => (o as HTMLElement).dataset.example!));
for (const id of wasmIds) {
  await page.click(`#ex-list li[data-example="${id}"]`);
  await new Promise((r) => setTimeout(r, 300));
  await waitRun();
  const st = await page.$eval('#runStatus', (e) => (e as HTMLElement).innerText.replace(/\n/g, ' '));
  const last = (await page.$eval('#console', (e) => e.textContent ?? '')).trim().split('\n').slice(-2).join(' / ');
  console.log(`${id}: ${st} :: ${last}`);
  if (!/exit 0/.test(st)) errors.push(`wasm example ${id}: ${st}`);
}
// Download .zip: NAME.html + NAME.wasm + NAME.mjs; the Node script runs the module and prints the same
{
  const dl = mkdtempSync(join(tmpdir(), 'hla-web-dl-'));
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
  await page.click('#ex-list li[data-example="calls"]');
  await new Promise((r) => setTimeout(r, 300));
  await waitRun();
  await page.click('#download');
  const zip = join(dl, 'calls.zip');
  for (let i = 0; i < 100 && !existsSync(zip); i++) await new Promise((r) => setTimeout(r, 100));
  // a stored zip: local headers one after another
  const z = readFileSync(zip);
  const names: string[] = [];
  for (let o = 0; z.readUInt32LE(o) === 0x04034b50;) {
    const size = z.readUInt32LE(o + 18), nl = z.readUInt16LE(o + 26), xl = z.readUInt16LE(o + 28);
    const name = z.subarray(o + 30, o + 30 + nl).toString();
    mkdirSync(dirname(join(dl, name)), { recursive: true });
    writeFileSync(join(dl, name), z.subarray(o + 30 + nl + xl, o + 30 + nl + xl + size));
    names.push(name);
    o += 30 + nl + xl + size;
  }
  const r = spawnSync(process.execPath, ['calls.mjs'], { cwd: join(dl, 'calls'), encoding: 'utf8' });
  const same = r.stdout === readFileSync('tests/wasm/cases/calls.expected', 'utf8');
  console.log(`download: ${names.join(', ')}; node calls.mjs: ${same ? 'same output' : 'DIFFERENT'} (exit ${r.status})`);
  if (!same) errors.push(`downloaded calls.mjs printed:\n${r.stdout}${r.stderr}`);
}
await page.click('#plat-mac');
await new Promise((r) => setTimeout(r, 1000));
await waitRun();
console.log('back to macOS:', await page.$eval('#runStatus', (e) => (e as HTMLElement).innerText.replace(/\n/g, ' ')));

// ---------------------------------------------------------------- a project in two files (sidebar, include)
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inline = async (v: string) => {
  await page.waitForSelector('.tree input');
  await page.$eval('.tree input', (e) => { (e as HTMLInputElement).value = ''; });
  await page.type('.tree input', v);
  await page.keyboard.press('Enter');
  await pause(500);
};
const edit = async (t: string) => {
  await page.$eval('#src', (e, v) => { (e as HTMLTextAreaElement).value = v as string; e.dispatchEvent(new Event('input')); }, t);
  await pause(600);
};
await page.click('#proj-new');
await inline('check-web');
await page.click('#file-new');
await inline('util');
await edit('fn twice(v) { return v * 2 }\n');
await page.click('#file-list li:first-child');
await pause(300);
await edit('include "util.hla"\nextern printf(fmt, ...)\nfn main() { printf("twice(21) = %ld\\n", twice(21)) }\n');
await page.click('#run');
await waitRun();
const twice = (await page.$eval('#console', (e) => e.textContent ?? '')).trim();
console.log(`project in two files: ${await page.$eval('#v-src', (e) => e.textContent)}, ${await page.$eval('#n-src', (e) => e.textContent)} :: ${twice}`);
if (twice !== 'twice(21) = 42') errors.push(`project in two files printed "${twice}"`);
// std/file.hla: a file the program writes becomes a file of the project
await edit('include "std/file.hla"\nfn main() { write_file("out.txt", "written by the program", 22) }\n');
await page.click('#run');
await waitRun();
await pause(500);
const listed = await page.$$eval('#file-list li .nm', (es) => es.map((e) => e.textContent));
console.log(`std/file.hla: files after the run: ${listed.join(', ')}`);
if (!listed.includes('out.txt')) errors.push('out.txt written by the program is not in the project');
console.log(errors.length ? errors.join('\n') : 'no console errors');
await browser.close();

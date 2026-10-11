// Opens dist/hla64.html in headless Chrome, waits for the auto-run, reports errors, saves screenshots.
import puppeteer from 'puppeteer-core';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
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
await waitRun();
console.log('--- Windows');
console.log((await page.$$eval('.stage', (els) => els.map((e) => (e as HTMLElement).innerText.replace(/\n/g, ' | ')))).join('\n'));
await page.screenshot({ path: `${out}/web-win-console.png` });
for (const tab of ['bin', 'macho']) {
  await page.click(`.tab[data-tab="${tab}"]`);
  await page.screenshot({ path: `${out}/web-win-${tab}.png` });
}
const ids = await page.$$eval('#example option', (os) => os.map((o) => (o as HTMLOptionElement).value));
for (const id of ids) {
  await page.select('#example', id);
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
await page.click('#plat-mac');
await waitRun();
console.log('back to macOS:', await page.$eval('#runStatus', (e) => (e as HTMLElement).innerText.replace(/\n/g, ' ')));
console.log(errors.length ? errors.join('\n') : 'no console errors');
await browser.close();

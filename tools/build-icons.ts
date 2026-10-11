// Renders assets/icon.svg into the PNG icons of the PWA (assets/pwa/*.png) with headless Chrome.
// The PNGs are committed; run this again only after changing the SVG: node tools/build-icons.ts
import puppeteer from 'puppeteer-core';
import { existsSync, readFileSync } from 'node:fs';

const chrome = process.env.CHROME ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
].find((p) => existsSync(p));
if (!chrome) { console.log('Chrome not found: set CHROME=path/to/chrome'); process.exit(2); }

const svg = readFileSync('assets/icon.svg', 'utf8');
// maskable and Apple icons are cropped by the system: a full square, the drawing stays in the safe zone
const square = svg.replace(/ rx="112"/, '');
const icons: [string, number, string][] = [
  ['assets/pwa/icon-192.png', 192, svg],
  ['assets/pwa/icon-512.png', 512, svg],
  ['assets/pwa/icon-maskable-512.png', 512, square],
  ['assets/pwa/apple-touch-icon.png', 180, square],
];
const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage();
for (const [path, size, source] of icons) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${source}`);
  await page.screenshot({ path: path as `${string}.png`, omitBackground: true });
  console.log(path);
}
await browser.close();

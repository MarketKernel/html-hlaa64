// Serves dist/pages/ over http, opens it in headless Chrome, waits for the service worker,
// then reloads offline: the workbench must still come up and run its example.
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type { AddressInfo } from 'node:net';

const chrome = process.env.CHROME ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
].find((p) => existsSync(p));
if (!chrome) { console.log('Chrome not found: set CHROME=path/to/chrome'); process.exit(2); }

const root = 'dist/pages';
const types: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};
// under a /<repo>/ prefix, as on a project site
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  if (!path.startsWith('/hla64/')) { res.writeHead(404).end(); return; }
  let file = normalize(join(root, path.slice('/hla64/'.length)));
  if (path.endsWith('/')) file = join(file, 'index.html');
  if (!file.startsWith(normalize(root)) || !existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hla64/`;

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed = true; };

const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push((e as Error).message));
  const ran = () => page.waitForFunction(() => document.getElementById('v-run')?.textContent?.startsWith('exit') || document.querySelector('#st-run[data-state="err"]'), { timeout: 30000 });

  await page.goto(url);
  await ran();
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  check(scope === url, `service worker active, scope ${scope}`);
  const manifest = await page.evaluate(async () => {
    const href = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.href;
    return href ? (await fetch(href)).json() : null;
  }) as { start_url?: string; icons?: { src: string }[] } | null;
  check(!!manifest?.icons?.length, 'manifest with icons');
  for (const icon of manifest?.icons ?? []) {
    const status = await page.evaluate(async (src) => (await fetch(src)).status, icon.src);
    check(status === 200, `icon ${icon.src}`);
  }
  // the first load is not controlled yet; this one is, and fills the cache from the worker
  await page.reload();
  await ran();
  check(await page.evaluate(() => !!navigator.serviceWorker.controller), 'page controlled by the service worker');

  await page.setOfflineMode(true);
  await page.reload();
  await ran();
  const status = await page.$eval('#runStatus', (e) => (e as HTMLElement).innerText.replace(/\n/g, ' '));
  check(/exit/.test(await page.$eval('#v-run', (e) => e.textContent ?? '')), `offline reload runs the example: ${status}`);
  const single = await page.evaluate(async () => (await fetch('hla64.html')).status);
  check(single === 200, 'hla64.html available offline');
  check(errors.length === 0, errors.length ? `page errors: ${errors.join('; ')}` : 'no page errors');
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);

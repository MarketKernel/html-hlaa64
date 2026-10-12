// The page that comes with a downloaded WebAssembly program, in headless Chrome: served over http it
// loads NAME.wasm by itself; arguments, the exit code and a file the program writes; opened from disk
// it asks for the module, and runs it once it is chosen. Screenshots go to the directory given.
//   node tools/check-wasm-page.ts [out-dir]
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { compileWasm } from '../src/lang/wasm/codegen.ts';
import { assembleWasm } from '../src/asm/wasm/assembler.ts';
import { combineSources } from '../src/lang/include.ts';
import { runtimeSource } from '../src/wasm/bundle.ts';
import { wasmPage } from '../src/wasm/page.ts';

const out = resolve(process.argv[2] ?? '.');
const chrome = process.env.CHROME ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
].find((p) => existsSync(p));
if (!chrome) { console.log('Chrome not found: set CHROME=path/to/chrome'); process.exit(2); }

// two programs: the calls test, and one with arguments, an exit code and a file
const dir = mkdtempSync(join(tmpdir(), 'hla-wasm-page-'));
const runtime = await runtimeSource();
const programs: Record<string, string> = {
  calls: readFileSync('tests/wasm/cases/calls.hla', 'utf8'),
  argsw: 'include "std/file.hla"\nextern printf(fmt, ...)\nfn main(argc, argv) {\n'
    + '    for i in 0..argc { printf("argv[%ld] = %s\\n", i, ptr[argv + i * 8]) }\n'
    + '    write_file("out.txt", "hello file", 10)\n    return 3\n}\n',
};
for (const [name, src] of Object.entries(programs)) {
  const text = combineSources(`${name}.hla`, (f) => (f === `${name}.hla` ? src : null)).text;
  writeFileSync(join(dir, `${name}.wasm`), assembleWasm(compileWasm(text).asm).bytes);
  writeFileSync(join(dir, `${name}.html`), wasmPage(name, runtime));
}
const server = createServer((req, res) => {
  try {
    const f = readFileSync(join(dir, decodeURIComponent(req.url!.slice(1))));
    res.writeHead(200, { 'content-type': req.url!.endsWith('.wasm') ? 'application/wasm' : 'text/html; charset=utf-8' });
    res.end(f);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as { port: number }).port;

const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.setViewport({ width: 1000, height: 700 });
const done = () => page.waitForFunction(() => /exit|crashed/.test(document.getElementById('status')!.textContent!), { timeout: 15000 });
const status = () => page.$eval('#status', (e) => (e as HTMLElement).innerText.replace(/\n/g, ' '));
const consoleText = () => page.$eval('#out', (e) => e.textContent ?? '');
const expect = (what: string, ok: boolean, detail: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}: ${detail}`); if (!ok) errors.push(what); };

await page.goto(`http://localhost:${port}/calls.html`);
await done();
const calls = await consoleText();
expect('http: loads calls.wasm and runs it', /exit 0/.test(await status()) && calls === readFileSync('tests/wasm/cases/calls.expected', 'utf8'),
  `${await status()} :: ${calls.split('\n')[0]}`);
await page.screenshot({ path: join(out, 'wasm-page-http.png') });

await page.goto(`http://localhost:${port}/argsw.html`);
await done();
await page.type('#args', 'one "two words"');
await page.click('#run');
await page.waitForFunction(() => document.getElementById('out')!.textContent!.includes('two words'), { timeout: 15000 });
await done();
const argsOut = await consoleText();
const files = await page.$eval('#files', (e) => (e as HTMLElement).innerText);
expect('arguments, exit code, a written file', argsOut.includes('argv[2] = two words') && /exit 3/.test(await status()) && /out\.txt \(10 bytes\)/.test(files),
  `${argsOut.replace(/\n/g, ' / ')} | ${await status()} | ${files.replace(/\n/g, ' ')}`);
await page.screenshot({ path: join(out, 'wasm-page-args.png') });

await page.goto(pathToFileURL(join(dir, 'calls.html')).href);
await page.waitForFunction(() => !document.getElementById('picker')!.hidden, { timeout: 5000 });
expect('file://: asks for the module', true, 'the picker is shown');
const input = await page.$('#file');
await (input as unknown as { uploadFile(p: string): Promise<void> }).uploadFile(join(dir, 'calls.wasm'));
await done();
expect('file://: runs the chosen module', /exit 0/.test(await status()), await status());
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
await page.setViewport({ width: 390, height: 800 });
await page.screenshot({ path: join(out, 'wasm-page-phone-dark.png') });
expect('no horizontal scroll at 390px', !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), '390px');

await browser.close();
server.close();
console.log(errors.length ? errors.join('\n') : 'no console errors');
process.exit(errors.length ? 1 : 0);

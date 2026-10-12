// The files that come with a wasm32 program: NAME.html — a console page that loads NAME.wasm next to it
// and runs it with the runtime (src/wasm/runtime.ts) in a worker — and NAME.mjs to run it in Node.
// `runtime` is the runtime bundle (src/wasm/bundle.ts): a script that defines the global HLA.

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inScript = (js: string) => js.replace(/<\/script/gi, '<\\/script');

/** the worker: runs the module, streams the output, sends back the files the program wrote */
const WORKER = String.raw`
self.onmessage = (ev) => {
  let buf = '', last = Date.now();
  const flush = () => { if (buf) { postMessage({ type: 'out', text: buf }); buf = ''; } last = Date.now(); };
  const files = HLA.memoryFiles(ev.data.files || {});
  const t0 = performance.now();
  const r = HLA.runWasm(new Uint8Array(ev.data.bytes), {
    name: ev.data.name, args: ev.data.args, files,
    onOutput: (t) => { buf += t; if (buf.length > 4096 || Date.now() - last > 40) flush(); },
  });
  flush();
  const w = HLA.writtenFiles(files);
  postMessage({ type: 'done', exitCode: r.exitCode, error: r.error, ms: performance.now() - t0, text: w.text, binary: w.binary });
};`;

const APP = String.raw`
(() => {
  const NAME = __NAME__;
  const $ = (id) => document.getElementById(id);
  const out = $('out'), status = $('status'), runBtn = $('run'), stopBtn = $('stop');
  const runtimeSrc = $('hla-runtime').textContent;
  let bytes = null, worker = null, workerUrl = null;

  const pill = (cls, text) => '<span class="pill ' + cls + '">' + text + '</span>';
  const setStatus = (html) => { status.innerHTML = html; };

  function ready(b, from) {
    bytes = b;
    $('picker').hidden = true;
    runBtn.disabled = false;
    setStatus('<span>' + NAME + '.wasm · ' + b.length.toLocaleString('en-US') + ' bytes' + (from ? ' · ' + from : '') + '</span>');
    run();
  }

  async function load() {
    try {
      if (location.protocol === 'file:') throw new Error('a page from disk cannot read other files');
      const r = await fetch(NAME + '.wasm');
      if (!r.ok) throw new Error(r.statusText);
      ready(new Uint8Array(await r.arrayBuffer()));
    } catch {
      // file:// pages may not read other files: the user picks the module once
      $('picker').hidden = false;
      setStatus('<span>Choose ' + NAME + '.wasm to run it.</span>');
    }
  }

  const pick = async (file) => { if (file) ready(new Uint8Array(await file.arrayBuffer()), file.name); };
  $('file').addEventListener('change', () => pick($('file').files[0]));
  document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drop'); });
  document.addEventListener('dragleave', () => document.body.classList.remove('drop'));
  document.addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('drop'); pick(e.dataTransfer.files[0]); });

  const splitArgs = (t) => [...t.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);

  function finish(r) {
    if (worker) { worker.terminate(); worker = null; }
    stopBtn.hidden = true;
    runBtn.disabled = false;
    if (r.error) {
      const e = document.createElement('span');
      e.className = 'err';
      e.textContent = (out.textContent && !out.textContent.endsWith('\n') ? '\n' : '') + '⚠ ' + r.error + '\n';
      out.appendChild(e);
    }
    const written = Object.entries(r.text || {}).map(([n, t]) => [n, new TextEncoder().encode(t)]).concat(Object.entries(r.binary || {}));
    const box = $('files');
    box.textContent = '';
    for (const [n, data] of written) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([data]));
      a.download = n.replace(/^.*\//, '');
      a.textContent = n + ' (' + data.length.toLocaleString('en-US') + ' bytes)';
      box.appendChild(a);
    }
    box.hidden = !written.length;
    const ok = r.exitCode === 0 && !r.error;
    setStatus((r.error ? pill('bad', r.error === 'stopped' ? 'stopped' : 'crashed') : pill(ok ? 'ok' : 'bad', 'exit ' + r.exitCode))
      + '<span>' + (r.ms || 0).toFixed(0) + ' ms</span>' + (written.length ? '<span>wrote ' + written.length + ' file(s)</span>' : ''));
  }

  function run() {
    if (!bytes) return;
    if (worker) worker.terminate();
    out.textContent = '';
    const args = splitArgs($('args').value);
    if (args.length) {
      const c = document.createElement('span');
      c.className = 'cmd';
      c.textContent = '$ ' + [NAME, ...args].join(' ') + '\n';
      out.appendChild(c);
    }
    const body = out.appendChild(document.createTextNode(''));
    runBtn.disabled = true;
    stopBtn.hidden = false;
    setStatus(pill('busy', 'running'));
    try {
      workerUrl = workerUrl || URL.createObjectURL(new Blob([runtimeSrc, ${JSON.stringify(WORKER)}], { type: 'text/javascript' }));
      worker = new Worker(workerUrl);
    } catch { worker = null; }
    if (worker) {
      worker.onmessage = (ev) => { if (ev.data.type === 'out') body.data += ev.data.text; else finish(ev.data); };
      worker.onerror = (ev) => { ev.preventDefault(); worker = null; inPage(); };
      worker.postMessage({ bytes: bytes.slice().buffer, name: NAME, args });
    } else inPage();

    async function inPage() {
      const files = HLA.memoryFiles({});
      const t0 = performance.now();
      const r = await HLA.runWasmAsync(bytes, { name: NAME, args, files, onOutput: (t) => { body.data += t; } });
      const w = HLA.writtenFiles(files);
      finish({ exitCode: r.exitCode, error: r.error, ms: performance.now() - t0, text: w.text, binary: w.binary });
    }
  }

  runBtn.addEventListener('click', run);
  stopBtn.addEventListener('click', () => finish({ exitCode: null, error: 'stopped', ms: 0 }));
  $('args').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  load();
})();`;

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#5b4fd6"/><path d="M7 11l3 10 3-7 3 7 3-10M22 21l2.5-10 2.5 10M23 18h3" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const CSS = `
:root { color-scheme: light dark; --bg: #eef1f4; --panel: #ffffff; --ink: #15202b; --muted: #5d6b78; --line: #d5dce3;
  --console: #0d1217; --console-ink: #d7e0e8; --accent: #5b4fd6; --link: #4338b8; --ok: #1f8a4c; --bad: #c0392b; --busy: #b7791f; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1217; --panel: #151d25; --ink: #e3e9ef; --muted: #8b99a6; --line: #26323d; --console: #080c10; --link: #a9a2ff; } }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
body { display: flex; flex-direction: column; padding: 16px; gap: 12px; max-width: 1100px; margin: 0 auto; }
body.drop { outline: 3px dashed var(--accent); outline-offset: -8px; }
header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
h1 { font-size: 18px; margin: 0; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
header small { color: var(--muted); }
.bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.bar label { color: var(--muted); font-size: 13px; }
.bar code { font: 13px ui-monospace, Menlo, Consolas, monospace; color: var(--muted); }
input#args { flex: 1; min-width: 160px; padding: 6px 9px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--ink); font: 13px ui-monospace, Menlo, Consolas, monospace; }
button { padding: 6px 14px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); font: inherit; cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
button:disabled { opacity: .5; cursor: default; }
pre#out { flex: 1; min-height: 240px; margin: 0; padding: 12px 14px; overflow: auto; background: var(--console); color: var(--console-ink);
  border-radius: 8px; font: 13px/1.4 ui-monospace, "SF Mono", Menlo, Consolas, monospace; white-space: pre-wrap; word-break: break-all; }
pre#out .cmd { color: #8fb4d8; } pre#out .err { color: #ff8a80; }
#status { display: flex; gap: 12px; align-items: center; color: var(--muted); font-size: 13px; min-height: 22px; flex-wrap: wrap; }
.pill { padding: 1px 9px; border-radius: 999px; font-weight: 600; color: #fff; }
.pill.ok { background: var(--ok); } .pill.bad { background: var(--bad); } .pill.busy { background: var(--busy); }
#picker { padding: 14px; border: 1px dashed var(--line); border-radius: 8px; background: var(--panel); }
#picker p { margin: 0 0 8px; }
#files { display: flex; gap: 10px; flex-wrap: wrap; font-size: 13px; }
#files[hidden] { display: none; }
#files::before { content: "Files the program wrote:"; color: var(--muted); }
#files a { color: var(--link); }
footer { color: var(--muted); font-size: 12px; }
`;

/** NAME.html: the console page */
export function wasmPage(name: string, runtime: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} · HLA64 wasm32</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(ICON)}">
<style>${CSS}</style>
</head>
<body>
<header><h1>${esc(name)}</h1><small>WebAssembly (wasm32) program built by HLA64</small></header>
<div class="bar">
  <label for="args">Arguments</label><code>${esc(name)}</code>
  <input id="args" spellcheck="false" autocomplete="off" placeholder="the command line after the program name">
  <button class="primary" id="run" type="button" disabled>Run</button>
  <button id="stop" type="button" hidden>Stop</button>
</div>
<div id="picker" hidden>
  <p>This page could not read <b>${esc(name)}.wasm</b> by itself (browsers do not let a page opened from disk read other files).
  Choose the file or drop it here — or serve the folder: <code>python3 -m http.server</code>, or run it in Node: <code>node ${esc(name)}.mjs</code>.</p>
  <input type="file" id="file" accept=".wasm,application/wasm">
</div>
<pre id="out" aria-live="polite"></pre>
<div id="status"></div>
<div id="files" hidden></div>
<footer>The program runs in this page: WebAssembly in your browser, with a small JavaScript runtime as its C library (printf, malloc, fopen…). Files it writes stay in memory and are offered for download.</footer>
<script id="hla-runtime">${inScript(runtime)}</script>
<script>${inScript(APP.replace('__NAME__', JSON.stringify(name)))}</script>
</body>
</html>
`;
}

/** NAME.mjs: the same program in Node (node NAME.mjs args…): real stdout, files on disk */
export function wasmNodeRunner(name: string, runtime: string): string {
  return `// ${name}: a WebAssembly (wasm32) program built by HLA64. Run it with Node 18 or newer:
//   node ${name}.mjs [arguments]
// The program sees the files of the current directory (fopen) and prints to this console.
import { readFileSync, writeFileSync } from 'node:fs';
${runtime}
const r = HLA.runWasm(readFileSync(new URL(${JSON.stringify(`./${name}.wasm`)}, import.meta.url)), {
  name: ${JSON.stringify(name)},
  args: process.argv.slice(2),
  files: {
    read: (p) => { try { return new Uint8Array(readFileSync(p)); } catch { return null; } },
    write: (p, d) => writeFileSync(p, d),
  },
  onOutput: (t, s) => (s === 2 ? process.stderr : process.stdout).write(t),
});
if (r.error) console.error('error: ' + r.error);
process.exitCode = r.exitCode ?? 1;
`;
}

/** the files of a downloaded program, in a folder NAME/ */
export function wasmProgramFiles(name: string, wasm: Uint8Array, runtime: string): { name: string; data: Uint8Array | string }[] {
  return [
    { name: `${name}/${name}.html`, data: wasmPage(name, runtime) },
    { name: `${name}/${name}.wasm`, data: wasm },
    { name: `${name}/${name}.mjs`, data: wasmNodeRunner(name, runtime) },
  ];
}

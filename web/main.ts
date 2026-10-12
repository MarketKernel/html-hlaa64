// HLA64 Workbench: editor + translator + assembler/linker + emulator, all in the page.
// Three platforms: macOS on ARM64 (Mach-O), Windows on x86-64 (PE/COFF) and WebAssembly (wasm32),
// which the browser runs natively with a JavaScript runtime as its system.
import { compile, compileLibrary } from '../src/lang/codegen.ts';
import { compileX64, compileLibraryX64 } from '../src/lang/x64/codegen.ts';
import { CompileError } from '../src/lang/lexer.ts';
import { assemble, assembleAndLink, link, writeObject, writeArchive, AsmError, type LinkResult } from '../src/asm/index.ts';
import { assembleAndLinkX, assembleX, writeCoffObject, buildWindowsLibrary, linkPE, type PeResult, type WindowsLibrary } from '../src/asm/x64/index.ts';
import { runMachO } from '../src/emu/macho-loader.ts';
import { runPE } from '../src/emu/x64/pe-loader.ts';
import { compileWasm } from '../src/lang/wasm/codegen.ts';
import { assembleWasm, WASM_MNEMONICS, type WasmModule } from '../src/asm/wasm/assembler.ts';
import { runWasmAsync } from '../src/wasm/runtime.ts';
import { wasmProgramFiles } from '../src/wasm/page.ts';
import { zipFiles, type ZipEntry } from './zip.ts';
import { memoryFiles, writtenFiles } from '../src/emu/files.ts';
import { combineSources, errorOrigin, normalizePath, type Combined } from '../src/lang/include.ts';
import { TRANSLATOR, ASSEMBLER } from './selfhost.ts';
import { listProjects, getProject, saveProject, deleteProject, newId, freeName, persistent, type Project, type Mode, type Platform } from './projects.ts';

import exMandelbrot from '../examples/mandelbrot.hla';
import exShowcase from '../examples/showcase.hla';
import exHello from '../examples/hello.hla';
import exFizz from '../examples/fizzbuzz.hla';
import exBare from '../examples/bare-metal.hla';
import exMixed from '../examples/mixed.hla';
import exArith from '../tests/cases/arith.hla';
import exMemory from '../tests/cases/memory.hla';
import exMathlib from '../docs/lessons/14-library/mathlib.hla';
import exMathlibMain from '../docs/lessons/14-library/main.c';
import wxMandelbrot from '../tests/x64/cases/mandelbrot.hla';
import wxShowcase from '../tests/x64/cases/showcase.hla';
import wxArith from '../tests/x64/cases/arith.hla';
import wxMemory from '../tests/x64/cases/memory.hla';
import wxMixed from '../tests/x64/cases/mixed.hla';
import wxMathlib from '../tests/x64/lib/mathlib.hla';
import waMixed from '../tests/wasm/cases/mixed.hla';
import waMandelbrot from '../tests/wasm/cases/mandelbrot.hla';
import waCalls from '../tests/wasm/cases/calls.hla';
import waGoto from '../tests/wasm/cases/goto.hla';
import exFiles from '../tests/cases/files.hla';
import exSwitch from '../tests/cases/switch.hla';

declare const __WORKER_SRC__: string;
declare const __WASM_RUNTIME__: string;
declare const __ARTIFACT__: boolean;

interface Example {
  id: string; title: string; src: string; mode?: Mode; cMain?: string;
  // a project of several files: `src` is the main file among `files`; `open` is shown first, `args` per main file
  files?: Record<string, string>; main?: string; open?: string; args?: Record<string, string>;
}
// the toolchain written in HLA64 (selfhost/): the translator and the assembler, each a project of its own
const hlc = (main: string): Example => ({
  id: 'hlc', title: 'Translator in HLA64 (hla → s)', src: TRANSLATOR.files[main],
  files: TRANSLATOR.files, main, open: 'hello.hla', args: TRANSLATOR.args,
});
const hlas = (main: string, open: string): Example => ({
  id: 'hlas', title: 'Assembler in HLA64 (s → executable)', src: ASSEMBLER.files[main],
  files: ASSEMBLER.files, main, open, args: ASSEMBLER.args,
});

const MAC_EXAMPLES: Example[] = [
  { id: 'mixed', title: 'Assembler + sugar in one function', src: exMixed },
  { id: 'mandelbrot', title: 'Mandelbrot set (floating point)', src: exMandelbrot },
  { id: 'mathlib', title: 'Library for C: mathlib (lesson 14)', src: exMathlib, mode: 'static', cMain: exMathlibMain },
  { id: 'showcase', title: 'Language tour (everything)', src: exShowcase },
  hlc('hlc-arm.hla'),
  hlas('hlas-arm.hla', 'hello.s'),
  { id: 'hello', title: 'Hello, world', src: exHello },
  { id: 'fizzbuzz', title: 'FizzBuzz', src: exFizz },
  { id: 'bare-metal', title: 'Bare metal: syscalls + inline asm', src: exBare },
  { id: 'arith', title: 'Self-test: arithmetic', src: exArith },
  { id: 'memory', title: 'Self-test: memory & calls', src: exMemory },
];
// the same programs with x86-64 register names (hello and fizzbuzz are portable as they are)
const WIN_EXAMPLES: Example[] = [
  { id: 'mixed', title: 'Assembler + sugar in one function', src: wxMixed },
  { id: 'mandelbrot', title: 'Mandelbrot set (floating point)', src: wxMandelbrot },
  { id: 'mathlib', title: 'Library for C: mathlib (lesson 14)', src: wxMathlib, mode: 'static', cMain: exMathlibMain },
  { id: 'showcase', title: 'Language tour (everything)', src: wxShowcase },
  hlc('hlc-x64.hla'),
  hlas('hlas-x64.hla', 'hello-x64.s'),
  { id: 'hello', title: 'Hello, world', src: exHello },
  { id: 'fizzbuzz', title: 'FizzBuzz', src: exFizz },
  { id: 'arith', title: 'Self-test: arithmetic', src: wxArith },
  { id: 'memory', title: 'Self-test: memory & calls', src: wxMemory },
];

// WebAssembly: r/f registers and wasm instructions; the self-hosted toolchain runs here as it is
const WASM_EXAMPLES: Example[] = [
  { id: 'mixed', title: 'Assembler + sugar in one function', src: waMixed },
  { id: 'mandelbrot', title: 'Mandelbrot set (floating point)', src: waMandelbrot },
  { id: 'calls', title: 'Calls: function pointers, qsort, doubles', src: waCalls },
  hlc('hlc-arm.hla'),
  hlas('hlas-arm.hla', 'hello.s'),
  { id: 'hello', title: 'Hello, world', src: exHello },
  { id: 'fizzbuzz', title: 'FizzBuzz', src: exFizz },
  { id: 'goto', title: 'goto as blocks and loops', src: waGoto },
  { id: 'switch', title: 'switch', src: exSwitch },
  { id: 'files', title: 'Files: std/file.hla', src: exFiles },
];

const PLATFORMS: Record<Platform, { examples: Example[]; sub: string; emulator: string; image: string; tab: string; lib: { static: string; dynamic: string } }> = {
  mac: { examples: MAC_EXAMPLES, sub: 'AArch64 · macOS · offline workbench', emulator: 'ARM64 emulator', image: 'Mach-O executable', tab: 'Mach-O', lib: { static: '.a', dynamic: '.dylib' } },
  win: { examples: WIN_EXAMPLES, sub: 'x86-64 · Windows · offline workbench', emulator: 'x64 emulator', image: 'PE executable', tab: 'PE / COFF', lib: { static: '.lib', dynamic: '.dll' } },
  wasm: { examples: WASM_EXAMPLES, sub: 'wasm32 · WebAssembly · offline workbench', emulator: 'WebAssembly engine', image: 'WebAssembly module', tab: 'Module', lib: { static: '—', dynamic: '—' } },
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const src = $<HTMLTextAreaElement>('src');
const hl = $('hl');
const gutter = $('gutter');
const diag = $('diag');
const isWindowsHost = /Windows/i.test(navigator.userAgent);
const store = {
  get(k: string): string | null { try { return localStorage.getItem('hla64:' + k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem('hla64:' + k, v); } catch { /* storage unavailable */ } },
  del(k: string) { try { localStorage.removeItem('hla64:' + k); } catch { /* storage unavailable */ } },
};

// ---------------------------------------------------------------------------
// syntax highlighting
// ---------------------------------------------------------------------------
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const KW = new Set(['fn', 'function', 'export', 'naked', 'extern', 'const', 'data', 'rodata', 'struct', 'enum', 'alias', 'let',
  'var', 'if', 'else', 'elif', 'while', 'do', 'loop', 'for', 'in', 'step', 'break', 'continue', 'return', 'goto', 'asm',
  'push', 'pop', 'local', 'unsigned', 'auto', 'set', 'call', 'include', 'switch', 'case', 'default']);
const TYPES = new Set(['i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64', 'ptr', 'f32', 'f64', 'string']);
const REG_ARM = /^(?:[xw](?:[12]?\d|30)|[dsqhb](?:[12]?\d|3[01])|sp|wsp|xzr|wzr|fp|lr)$/i;
const REG_X64 = /^(?:[re]?(?:ax|bx|cx|dx|si|di|sp|bp)|[abcd][lh]|(?:si|di|sp|bp)l|r(?:[89]|1[0-5])[dwb]?|xmm(?:\d|1[0-5])|rip)$/i;
const REG_WASM = /^\$?[rf](?:[12]?\d|3[01])$/;
const REG = { test: (w: string) => (platform === 'win' ? REG_X64 : platform === 'wasm' ? REG_WASM : REG_ARM).test(w) };

function hlHla(text: string): string {
  let out = '';
  const re = /(\/\/[^\n]*)|(\/\*[\s\S]*?(?:\*\/|$))|("(?:\\.|[^"\\\n])*"?)|('(?:\\.|[^'\\\n])*'?)|(\b0[xXbBoO][\w]+|\b\d[\d_]*(?:\.\d+)?)|([A-Za-z_$][\w$]*)(:?)|(\n)|([^\w"'/\n]+|\/)/g;
  let m: RegExpExecArray | null;
  let lineStart = true;
  while ((m = re.exec(text))) {
    if (m[1] || m[2]) out += `<span class="t-com">${esc(m[0])}</span>`;
    else if (m[3] || m[4]) out += `<span class="t-str">${esc(m[0])}</span>`;
    else if (m[5]) out += `<span class="t-num">${esc(m[0])}</span>`;
    else if (m[6]) {
      const w = m[6];
      if (m[7] && lineStart) out += `<span class="t-label">${esc(w)}:</span>`;
      else {
        const cls = KW.has(w) ? 't-kw' : TYPES.has(w) ? 't-type' : REG.test(w) ? 't-reg' : '';
        out += (cls ? `<span class="${cls}">${w}</span>` : w) + (m[7] ?? '');
      }
    } else out += esc(m[0]);
    if (m[8]) lineStart = true;
    else if (!/^\s+$/.test(m[0])) lineStart = false;
  }
  return out;
}

function hlAsmLine(line: string): string {
  const ci = line.indexOf('//');
  const code = ci >= 0 ? line.slice(0, ci) : line;
  const com = ci >= 0 ? `<span class="t-com">${esc(line.slice(ci))}</span>` : '';
  const lm = /^(\s*)([\w.$]+:)(.*)$/.exec(code);
  if (lm) return `${lm[1]}<span class="t-label">${esc(lm[2])}</span>${esc(lm[3])}${com}`;
  const m = /^(\s*)(\S+)(.*)$/.exec(code);
  if (!m) return esc(code) + com;
  const head = m[2].startsWith('.') ? `<span class="t-dir">${esc(m[2])}</span>` : `<span class="t-mn">${esc(m[2])}</span>`;
  const rest = m[3].replace(/("(?:\\.|[^"\\])*")|(#-?[\w.]+|\b0x[\da-fA-F]+\b|(?<![\w.$])-?\d+\b)|([A-Za-z_.$][\w.$]*)|([^"#A-Za-z_.$\d-]+|[\d-])/g, (t, s, n, w) => {
    if (s) return `<span class="t-str">${esc(s)}</span>`;
    if (n) return `<span class="t-num">${esc(n)}</span>`;
    if (w) return REG.test(w) ? `<span class="t-reg">${w}</span>` : /^(PAGE|PAGEOFF|GOTPAGE|GOTPAGEOFF|byte|word|dword|qword|xmmword|ptr)$/.test(w) ? `<span class="t-dir">${w}</span>` : esc(w);
    return esc(t);
  });
  return m[1] + head + rest + com;
}

/** a line of WebAssembly text: instructions, $names (registers r0..r31/f0..f31), module keywords, ;; comments */
const WAT_KW = /^(module|func|param|result|local|import|export|memory|global|data|table|elem|type|mut|funcref|start)$/;
function hlWatLine(line: string): string {
  const ci = line.indexOf(';;');
  const code = ci >= 0 ? line.slice(0, ci) : line;
  const com = ci >= 0 ? `<span class="t-com">${esc(line.slice(ci))}</span>` : '';
  return code.replace(/("(?:\\.|[^"\\])*")|(\$[\w.$:]+)|((?:offset|align)=\S+)|([A-Za-z_][\w.]*)|(-?(?:0x[\da-fA-F]+|\d[\d.]*(?:e[+-]?\d+)?))|([^"$A-Za-z_\d-]+|-)/g,
    (t, str, id, mem, word, num) => {
      if (str) return `<span class="t-str">${esc(str)}</span>`;
      if (id) return `<span class="${REG_WASM.test(id) ? 't-reg' : 't-label'}">${esc(id)}</span>`;
      if (mem) return `<span class="t-dir">${esc(mem)}</span>`;
      if (word) return WASM_MNEMONICS.has(word) ? `<span class="t-mn">${word}</span>` : WAT_KW.test(word) ? `<span class="t-dir">${word}</span>`
        : TYPES.has(word) ? `<span class="t-type">${word}</span>` : esc(word);
      if (num) return `<span class="t-num">${num}</span>`;
      return esc(t);
    }) + com;
}

// ---------------------------------------------------------------------------
// editor
// ---------------------------------------------------------------------------
let errLine = 0;

function renderEditor(): void {
  const text = src.value;
  let html = /\.[ch]$/i.test(project.open) ? hlC(text) : /\.s$/i.test(project.open) ? text.split('\n').map(hlAsmLine).join('\n')
    : /\.wat$/i.test(project.open) ? text.split('\n').map(hlWatLine).join('\n') : hlHla(text);
  const lines = text.split('\n').length;
  if (errLine > 0 && errLine <= lines) {
    const parts = html.split('\n');
    parts[errLine - 1] = `<span class="errline">${parts[errLine - 1] || ' '}</span>`;
    html = parts.join('\n');
  }
  hl.innerHTML = html + '\n';
  let g = '';
  for (let i = 1; i <= lines; i++) g += i === errLine ? `<div class="bad">${i}</div>` : `<div>${i}</div>`;
  gutter.innerHTML = g;
  syncScroll();
}

function syncScroll(): void {
  hl.scrollTop = src.scrollTop;
  hl.scrollLeft = src.scrollLeft;
  gutter.style.transform = `translateY(${-src.scrollTop}px)`;
}

function insertText(t: string): void {
  // execCommand keeps the native undo stack; fall back to setRangeText
  if (!document.execCommand('insertText', false, t)) {
    src.setRangeText(t, src.selectionStart, src.selectionEnd, 'end');
    onEdit();
  }
}

src.addEventListener('scroll', syncScroll);
src.addEventListener('input', onEdit);
src.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); return; }
  if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); insertText('    '); return; }
  if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
    const before = src.value.slice(0, src.selectionStart);
    const line = before.slice(before.lastIndexOf('\n') + 1);
    const indent = /^\s*/.exec(line)![0] + (/\{\s*$/.test(line) ? '    ' : '');
    e.preventDefault();
    insertText('\n' + indent);
  }
});
const updateCursor = () => {
  const before = src.value.slice(0, src.selectionStart);
  const ln = before.split('\n').length;
  const col = before.length - before.lastIndexOf('\n');
  $('cursor').textContent = `Ln ${ln}, Col ${col}`;
};
src.addEventListener('keyup', updateCursor);
src.addEventListener('click', updateCursor);

// ---------------------------------------------------------------------------
// build pipeline
// ---------------------------------------------------------------------------
interface Listing { addr: number; bytes: number[]; line: number; sect: string }

interface Build {
  platform: Platform;
  mode: Mode;
  asm: string | null;
  link: (LinkResult & { instructions: number }) | null;      // macOS: executable or dylib
  object: ReturnType<typeof writeObject> | null;             // macOS static library: the object inside the archive
  archive: Uint8Array | null;
  pe: (PeResult & { instructions: number }) | null;          // Windows: .exe or .dll
  wasm: WasmModule | null;                                   // WebAssembly: the module
  coff: ReturnType<typeof writeCoffObject> | null;           // Windows static library: the .obj inside the .lib
  winlib: WindowsLibrary | null;
  header: string | null;
  listing: Listing[];
  instructions: number;
  warnings: string[];
  error: { stage: 'src' | 'asm'; line: number; col: number; message: string; file?: string } | null;
  combined: Combined | null;
  tCompile: number;
  tAsm: number;
}

let current: Build | null = null;
let platform: Platform = (store.get('platform') as Platform | null) ?? (isWindowsHost ? 'win' : 'mac');
const examples = () => PLATFORMS[platform].examples;
let mode: Mode = 'exe';
// the open project: its files, main file and mode (see the projects section at the end)
let project: Project = exampleProject(examples()[0]);
// storage keys: macOS keeps the original names, Windows gets its own namespace
const key = (k: string) => (platform === 'mac' ? k : 'win:' + k);
const wordBytes = (w: number) => [w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, w >>> 24];

const stem = (f: string) => f.replace(/^.*\//, '').replace(/\.[^.]*$/, '');
/** library name: the main file's (mathlib.hla -> mathlib.h, mathlib_static.lib, ...) */
const libName = () => stem(project.main).replace(/[^\w]/g, '_') || 'mylib';
const fileText = (name: string): string | null => project.files.find((f) => f.name === name)?.text ?? null;
/** the C program of a library project (lesson 14 has one) */
const cMain = (): string | null => fileText('main.c');

function build(): Build {
  const b: Build = {
    platform, mode, asm: null, link: null, object: null, archive: null, pe: null, wasm: null, coff: null, winlib: null,
    header: null, listing: [], instructions: 0, warnings: [], error: null, tCompile: 0, tAsm: 0, combined: null,
  };
  const win = platform === 'win', wa = platform === 'wasm';
  const t0 = performance.now();
  let c: Combined | null = null;
  try {
    // the main file with everything it includes, as one program
    c = combineSources(project.main, fileText);
    b.combined = c;
    if (mode === 'exe') {
      const r = wa ? compileWasm(c.text) : win ? compileX64(c.text) : compile(c.text);
      b.asm = r.asm;
      b.warnings = r.warnings.map(c.warning);
    } else {
      const r = win ? compileLibraryX64(c.text, libName()) : compileLibrary(c.text, libName());
      b.asm = r.asm;
      b.header = r.header;
      b.warnings = r.warnings.map(c.warning);
    }
  } catch (e) {
    if (e instanceof CompileError) {
      const o = errorOrigin(e, c, project.main);
      b.error = { stage: 'src', line: o.line, col: e.col, message: e.message, file: o.file };
    }
    else b.error = { stage: 'src', line: 0, col: 0, message: 'internal compiler error: ' + (e as Error).message };
  }
  b.tCompile = performance.now() - t0;
  if (b.asm) {
    const t1 = performance.now();
    try {
      if (wa) {
        b.wasm = assembleWasm(b.asm);
        b.listing = b.wasm.listing;
        b.instructions = b.wasm.instructions;
      } else if (win) {
        if (mode === 'exe') {
          b.pe = assembleAndLinkX(b.asm);
          b.listing = b.pe.listing;
          b.instructions = b.pe.instructions;
        } else {
          b.winlib = buildWindowsLibrary(b.asm, libName());
          if (mode === 'static') {
            const a = assembleX(b.asm);
            b.instructions = a.sections.reduce((n, x) => n + x.insns.length, 0);
            b.coff = writeCoffObject(a);
            b.listing = b.coff.listing;
          } else {
            const a = assembleX(b.asm);
            b.pe = { ...linkPE(a, { kind: 'dll', dllName: `${libName()}.dll` }), instructions: a.sections.reduce((n, x) => n + x.insns.length, 0) };
            b.listing = b.pe.listing;
            b.instructions = b.pe.instructions;
          }
        }
      } else if (mode === 'exe') {
        b.link = assembleAndLink(b.asm, { name: progName() });
        b.listing = b.link.listing.map((l) => ({ ...l, bytes: wordBytes(l.word) }));
        b.instructions = b.link.instructions;
      } else if (mode === 'dynamic') {
        const a = assemble(b.asm);
        b.link = { ...link(a, { kind: 'dylib', name: libName(), installName: `@rpath/lib${libName()}.dylib` }), instructions: a.lines };
        b.listing = b.link.listing.map((l) => ({ ...l, bytes: wordBytes(l.word) }));
        b.instructions = a.lines;
      } else {
        const a = assemble(b.asm);
        b.object = writeObject(a);
        b.archive = writeArchive([{ name: `${libName()}.o`, data: b.object.bytes, symbols: b.object.exports }]);
        b.listing = b.object.listing.map((l) => ({ ...l, bytes: wordBytes(l.word) }));
        b.instructions = a.lines;
      }
      const exported = mode === 'exe' ? [] : win ? b.winlib!.exports : (b.object?.exports ?? b.link?.symbols.filter((x) => /^_/.test(x.name)) ?? []);
      if (mode !== 'exe' && exported.length === 0) b.warnings.push('nothing is exported: mark functions with `export fn` to make them callable from C');
    } catch (e) {
      if (e instanceof AsmError) b.error = { stage: 'asm', line: e.line, col: 0, message: e.message };
      else b.error = { stage: 'asm', line: 0, col: 0, message: 'internal assembler error: ' + (e as Error).message };
    }
    b.tAsm = performance.now() - t1;
  }
  return b;
}

/** Bytes of the main output for the current mode. */
const outputBytes = (b: Build): Uint8Array | null => {
  if (b.platform === 'wasm') return b.wasm?.bytes ?? null;
  if (b.platform === 'win') return b.mode === 'exe' ? b.pe?.bytes ?? null : b.mode === 'static' ? b.winlib?.staticLib ?? null : b.winlib?.dll ?? null;
  return b.mode === 'static' ? b.archive : b.link?.bytes ?? null;
};
/** file names of the outputs */
const outName = (b: Build): string => {
  const n = libName();
  if (b.platform === 'wasm') return `${progName()}.wasm`;
  if (b.platform === 'win') return b.mode === 'exe' ? `${progName()}.exe` : b.mode === 'static' ? `${n}_static.lib` : `${n}.dll`;
  return b.mode === 'exe' ? progName() : b.mode === 'static' ? `lib${n}.a` : `lib${n}.dylib`;
};
/** program name: the example's id or the project's name */
// an example of several programs (the self-hosted toolchain) is named after the one being built
const progName = () => (project.example && project.main !== `${project.example}.hla` ? stem(project.main) : project.example ?? project.name)
  .replace(/[^\w-]/g, '_') || 'program';

const fmtN = (n: number) => n.toLocaleString('en-US');
const fmtB = (n: number) => (n >= 10240 ? `${(n / 1024).toFixed(1)} KB` : `${fmtN(n)} B`);
const hex = (n: number, w = 0) => n.toString(16).padStart(w, '0');

function setStage(id: string, state: 'ok' | 'err' | 'busy' | '', val: string, note: string): void {
  const el = $(`st-${id}`);
  if (state) el.dataset.state = state; else delete el.dataset.state;
  $(`v-${id}`).textContent = val;
  $(`n-${id}`).innerHTML = note || '&nbsp;';
}

function rebuild(): void {
  const b = build();
  current = b;
  const used = b.combined?.files ?? [project.main];
  const lines = project.files.filter((f) => used.includes(f.name)).reduce((n, f) => n + f.text.split('\n').length, 0);
  errLine = b.error?.stage === 'src' && b.error.file === project.open ? b.error.line : 0;
  renderEditor();
  renderFiles();

  renderDiag(b);
  setStage('src', b.error?.stage === 'src' ? 'err' : 'ok', `${fmtN(lines)} lines`,
    used.length > 1 ? `${used.length} files` : fmtB(new TextEncoder().encode(fileText(project.main) ?? '').length));
  if (b.asm) {
    const asmLines = b.asm.split('\n').length;
    setStage('asm', 'ok', `${fmtN(asmLines)} lines`, `translated in ${b.tCompile.toFixed(1)} ms`);
  } else setStage('asm', b.error ? 'err' : '', '—', b.error ? 'fix the source error' : '');
  const P = PLATFORMS[b.platform];
  const win = b.platform === 'win';
  $('st-macho').querySelector('.st-name')!.textContent = { exe: P.image, static: 'Static library', dynamic: win ? 'DLL' : 'Dynamic library' }[b.mode];
  $('st-run').querySelector('.st-name')!.textContent = b.mode === 'exe' ? P.emulator : 'C header';
  $('st-run').dataset.tab = b.mode === 'exe' ? 'run' : 'header';
  const out = outputBytes(b);
  if (out) {
    const code = b.listing.filter((l) => l.line > 0);
    const textBytes = code.reduce((a, l) => a + l.bytes.length, 0);
    setStage('bin', 'ok', `${fmtN(b.instructions)} instructions`, `${fmtB(textBytes)} of ${b.platform === 'wasm' ? 'code' : win ? '.text' : '__text'}`);
    if (b.platform === 'wasm') {
      setStage('macho', 'ok', `${outName(b)} · ${fmtB(out.length)}`, `${b.wasm!.imports.length} imports · ${b.wasm!.functions.length} functions · ${b.tAsm.toFixed(1)} ms`);
    } else if (win) {
      if (b.mode === 'exe') setStage('macho', 'ok', `${outName(b)} · ${fmtB(out.length)}`, `${b.pe!.imports.reduce((a, d) => a + d.names.length, 0)} imports · ${b.tAsm.toFixed(1)} ms`);
      else if (b.mode === 'static') setStage('macho', 'ok', `${outName(b)} · ${fmtB(out.length)}`, `${b.coff!.exports.length} exports · ${b.coff!.sections.reduce((a, x) => a + x.relocs, 0)} relocations`);
      else setStage('macho', 'ok', `${outName(b)} · ${fmtB(out.length)}`, `${b.winlib!.exports.length} exports · import lib ${libName()}.lib`);
    } else if (b.mode === 'exe') setStage('macho', 'ok', fmtB(out.length), `signed · ${b.link!.imports.length} imports · ${b.tAsm.toFixed(1)} ms`);
    else if (b.mode === 'static') setStage('macho', 'ok', `lib${libName()}.a · ${fmtB(out.length)}`, `${b.object!.exports.length} exports · ${b.object!.sections.reduce((a, x) => a + x.relocs, 0)} relocations`);
    else setStage('macho', 'ok', `lib${libName()}.dylib · ${fmtB(out.length)}`, `signed · ${exportedNames(b).length} exports`);
    if (b.mode !== 'exe') {
      const decls = (b.header ?? '').split('\n').filter((l) => /^(\w[\w\s*]*\(|extern |typedef |enum |#define )/.test(l)).length;
      setStage('run', 'ok', `${libName()}.h`, `${decls} declarations`);
    }
  } else {
    setStage('bin', b.error?.stage === 'asm' ? 'err' : '', '—', b.error?.stage === 'asm' ? 'assembler error' : '');
    setStage('macho', '', '—', '');
    if (b.mode !== 'exe') setStage('run', '', '—', '');
  }
  ($<HTMLButtonElement>('run')).disabled = !out || b.mode !== 'exe';
  $('run').title = b.mode === 'exe' ? '' : 'A library has no main: download it and link it from C';
  ($<HTMLButtonElement>('download')).disabled = !out;
  if (!__ARTIFACT__) $('download').textContent = b.mode === 'exe' && b.platform !== 'wasm' ? (win ? 'Download .exe' : 'Download executable') : 'Download .zip';
  $('download').title = b.platform === 'wasm' ? 'A .zip with the module, a page that runs it in the browser, and a script that runs it in Node' : '';
  const zb = document.getElementById('zipbtn');
  if (zb) zb.hidden = b.mode !== 'exe' || __ARTIFACT__ || b.platform !== 'mac';
  ($<HTMLButtonElement>('copycmd')).disabled = !out;
  $('tab-btn-header').hidden = b.mode === 'exe';
  $('tab-btn-run').hidden = b.mode !== 'exe';
  renderHeader(b);
  renderAsm(b);
  renderListing(b);
  renderMacho(b);
}

/** the error (with a link to its file when another one is open) or the warnings under the editor */
function renderDiag(b: Build): void {
  if (b.error) {
    const e = b.error;
    const where = e.stage === 'src' ? `${e.file}:${e.line}:${e.col}` : e.line ? `assembly line ${e.line}` : 'linker';
    const jump = e.stage === 'src' && e.file && e.file !== project.open && fileText(e.file) !== null
      ? ` <button class="link" type="button" data-open="${esc(e.file)}">open ${esc(e.file)}</button>` : '';
    diag.innerHTML = `<strong>error</strong> ${esc(where)}: ${esc(e.message)}${jump}`;
    diag.hidden = false;
  } else if (b.warnings.length) {
    diag.innerHTML = b.warnings.map((w) => `<span class="warn">warning ${esc(w)}</span>`).join('\n');
    diag.hidden = false;
  } else diag.hidden = true;
}

let editTimer = 0;
function onEdit(): void {
  runNote = '';
  const f = project.files.find((x) => x.name === project.open);
  if (f) f.text = src.value;
  renderEditor();
  updateCursor();
  clearTimeout(editTimer);
  editTimer = window.setTimeout(() => {
    rebuild();
    persist();
  }, 220);
}

// ---------------------------------------------------------------------------
// output views
// ---------------------------------------------------------------------------
function renderAsm(b: Build): void {
  const v = $('asmView');
  if (!b.asm) { v.innerHTML = `<span class="t-com">// fix the error in the source to see the generated assembly</span>`; return; }
  const errAt = b.error?.stage === 'asm' ? b.error.line : 0;
  const hl = b.platform === 'wasm' ? hlWatLine : hlAsmLine;
  v.innerHTML = b.asm.split('\n').map((l, i) => (i + 1 === errAt ? `<span class="hl">${hl(l) || ' '}</span>` : hl(l))).join('\n');
}

let selectedRow = -1;
function renderListing(b: Build): void {
  const v = $('binView');
  if (!b.listing.length || !b.asm) { v.innerHTML = ''; $('bits').innerHTML = '<span class="idx">no machine code yet</span>'; return; }
  const asmLines = b.asm.split('\n');
  const out: string[] = [];
  let prev = 0;
  const win = b.platform !== 'mac';     // x64 and WebAssembly: instructions of 1..n bytes
  const wa = b.platform === 'wasm';
  const hl = wa ? hlWatLine : hlAsmLine;
  if (b.mode === 'static') out.push(`<span class="t-com">// object file: addresses are offsets; fields the linker fills in (${win ? 'calls, rip-relative addresses' : 'calls, adrp, @PAGEOFF'}) are still zero</span>`);
  // ARM: one 32-bit word per instruction; x64: 1..15 bytes
  const width = win ? Math.min(15, Math.max(...b.listing.map((l) => l.bytes.length))) * 3 - 1 : 8;
  const code = (ins: Listing) => (win ? ins.bytes.map((x) => hex(x, 2)).join(' ') : hex((ins.bytes[0] | (ins.bytes[1] << 8) | (ins.bytes[2] << 16) | (ins.bytes[3] << 24)) >>> 0, 8)).padEnd(width);
  b.listing.forEach((ins, i) => {
    if (ins.line) {
      for (let k = prev + 1; k < ins.line; k++) {
        const t = asmLines[k - 1]?.trim() ?? '';
        if (/^[\w.$]+:$/.test(t)) out.push(`<span class="lbl">${esc(t)}</span>`);
        const fm = wa ? /^\(func (\$\S+)/.exec(t) : null;
        if (fm) out.push(`<span class="lbl">${esc(fm[1])}:</span>${i === 0 ? '   <span class="t-com">;; addresses are offsets in the .wasm file</span>' : ''}`);
      }
      prev = ins.line;
    } else if (!win && (i === 0 || b.listing[i - 1].sect !== '__stubs')) out.push(`<span class="lbl">__stubs:</span>   <span class="t-com">// trampolines into libSystem through the GOT</span>`);
    else if (win && (i === 0 || b.listing[i - 1].line !== 0)) out.push(`<span class="lbl">import thunks:</span>   <span class="t-com">// jmp qword ptr [rip + __imp_name]: through the import address table</span>`);
    const text = ins.line ? hl(asmLines[ins.line - 1].trim()) : win ? `<span class="t-com">jmp [__imp_${esc(ins.sect.replace(/^stub /, ''))}]</span>` : '<span class="t-com">stub</span>';
    out.push(`<span class="row${i === selectedRow ? ' on' : ''}" data-i="${i}">  <span class="addr">${hex(ins.addr, 9)}</span>  <span class="word">${code(ins)}</span>  ${text}</span>`);
  });
  v.innerHTML = out.join('\n');
  showBits(selectedRow >= 0 && selectedRow < b.listing.length ? selectedRow : 0);
}

function showBits(i: number): void {
  const ins = current?.listing[i];
  if (!ins) return;
  selectedRow = i;
  const bits = $('bits');
  const win = current?.platform !== 'mac';
  const wa = current?.platform === 'wasm';
  let cells = '';
  let shown: string;
  let idx: string;
  if (win) {
    // bytes in memory order, each one as 8 bits (most significant first)
    ins.bytes.forEach((x, n) => {
      for (let k = 7; k >= 0; k--) {
        const one = (x >> k) & 1;
        cells += `<span class="cell${one ? ' one' : ''}${k === 7 && n ? ' gap' : ''}" title="byte ${n}, bit ${k}">${one}</span>`;
      }
    });
    shown = ins.bytes.map((x) => hex(x, 2)).join(' ');
    idx = wa ? `${ins.bytes.length} byte${ins.bytes.length > 1 ? 's' : ''}: the opcode, then its immediates (LEB128 numbers: a local, a label depth, align and offset of a memory access) · click any row to inspect its encoding`
      : `${ins.bytes.length} bytes in memory order (prefixes · REX · opcode · ModRM · SIB · displacement · immediate) · click any row to inspect its encoding`;
  } else {
    const word = (ins.bytes[0] | (ins.bytes[1] << 8) | (ins.bytes[2] << 16) | (ins.bytes[3] << 24)) >>> 0;
    for (let k = 31; k >= 0; k--) {
      const one = (word >>> k) & 1;
      cells += `<span class="cell${one ? ' one' : ''}${k % 4 === 3 && k !== 31 ? ' gap' : ''}" title="bit ${k}">${one}</span>`;
    }
    shown = hex(word, 8);
    idx = 'bit 31 ← → bit 0 · click any row to inspect its encoding';
  }
  const text = ins.line && current?.asm ? current.asm.split('\n')[ins.line - 1].trim() : win ? 'import thunk' : 'libSystem stub';
  bits.innerHTML = `<div><span class="addr" style="color:var(--addr)">0x${hex(ins.addr)}</span>  <b>${shown}</b>  ${(wa ? hlWatLine : hlAsmLine)(text)}</div>`
    + `<div class="cells">${cells}</div><div class="idx">${idx}</div>`;
  for (const el of document.querySelectorAll('#binView .row.on')) el.classList.remove('on');
  document.querySelector(`#binView .row[data-i="${i}"]`)?.classList.add('on');
}

$('binView').addEventListener('click', (e) => {
  const row = (e.target as HTMLElement).closest('.row') as HTMLElement | null;
  if (row) showBits(Number(row.dataset.i));
});

const table = (head: string[], rows: string[][], numeric: number[] = []) =>
  `<div class="tbl-wrap"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) =>
    `<tr>${r.map((c, i) => `<td class="${numeric.includes(i) ? 'num' : ''}${c.startsWith('0x') ? ' a' : ''}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const chips = (names: string[]) => `<div class="chips">${names.map((n) => `<span class="chip">${esc(n)}</span>`).join('') || '<span class="warn">none</span>'}</div>`;

function exportedNames(b: Build): string[] {
  if (b.object) return b.object.exports;
  if (b.mode === 'dynamic' && b.link) {
    const globals = new Set((b.asm ?? '').split('\n').map((l) => /^\.globl (\S+)/.exec(l.trim())?.[1]).filter(Boolean));
    return b.link.symbols.filter((x) => globals.has(x.name)).map((x) => x.name).sort();
  }
  return [];
}

function headerDump(bytes: Uint8Array, n: number): string {
  let dump = '';
  for (let o = 0; o < Math.min(n, bytes.length); o += 16) {
    const row = [...bytes.subarray(o, o + 16)];
    dump += `${hex(o, 8)}  ${row.map((x) => hex(x, 2)).join(' ')}  ${row.map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('')}\n`;
  }
  return esc(dump);
}

const scnFlags = (f: number) => `${f & 0x40000000 ? 'r' : '-'}${f & 0x80000000 ? 'w' : '-'}${f & 0x20000000 ? 'x' : '-'}`;

function renderPE(b: Build): void {
  const v = $('machoView');
  const a = (n: number) => `0x${hex(n)}`;
  const n = libName();
  if (b.mode === 'static' && b.coff && b.winlib) {
    const o = b.coff;
    v.innerHTML = `
      <section><h3>Archive ${esc(n)}_static.lib</h3>${table(['member', 'size'], [['/ (linker members: symbol index)', fmtN(b.winlib.staticLib.length - o.bytes.length - 60)], [`${esc(n)}.obj (COFF object, AMD64)`, fmtN(o.bytes.length)]], [1])}</section>
      <section><h3>Exported symbols</h3>${chips(o.exports)}</section>
      <section><h3>Needs from other libraries</h3>${chips(o.imports)}</section>
      <section><h3>Sections of the object file</h3>${table(['section', 'size', 'relocations'], o.sections.map((x) => [esc(x.name), fmtN(x.size), fmtN(x.relocs)]), [1, 2])}</section>
      <p class="note">Relocations are notes for the linker (<code>IMAGE_REL_AMD64_REL32</code>: “put the distance to <code>printf</code> here”). <code>.pdata</code>/<code>.xdata</code> hold the unwind information Windows needs for exceptions and stack walks. Final addresses appear when <code>link.exe</code> or <code>lld-link</code> builds the program.</p>`;
    return;
  }
  const l = b.pe;
  if (!l) { v.innerHTML = '<p class="warn">No output yet.</p>'; return; }
  const dll = b.mode === 'dynamic';
  const syms = l.symbols.filter((s) => !/^\.L|^\$unwind\$/.test(s.name)).sort((x, y) => x.addr - y.addr);
  v.innerHTML = `
    <section><h3>Image</h3>${table(['', ''], [
      ['format', `PE32+ ${dll ? 'DLL' : 'executable'}, AMD64, console subsystem`],
      ['image base', a(l.imageBase) + (dll ? '' : ' (relocatable: ASLR, high-entropy VA)')],
      [dll ? 'entry point' : 'entry point', l.entry ? a(l.entry) + ' (hla_start → main → exit)' : 'none (no DllMain)'],
      ['file size', fmtB(l.bytes.length)],
    ])}</section>
    <section><h3>Sections</h3>${table(['section', 'rva', 'virtual size', 'file size', 'access'],
      l.sections.map((s) => [esc(s.name), a(s.rva), fmtN(s.vsize), fmtN(s.fileSize), scnFlags(s.flags)]), [2, 3])}</section>
    <section><h3>Imports (the Windows loader fills the import address table)</h3>${l.imports.length ? l.imports.map((d) => `<div style="margin-bottom:6px"><b>${esc(d.dll)}</b></div>${chips(d.names)}`).join('') : chips([])}</section>
    ${dll ? `<section><h3>Exports (export directory of ${esc(n)}.dll)</h3>${chips(l.exports)}</section>
    <p class="note">The import library <code>${esc(n)}.lib</code> (in the download) tells the linker that these names live in <code>${esc(n)}.dll</code>.</p>` : ''}
    <section><h3>Symbols</h3>${table(['symbol', 'address'], syms.map((s) => [esc(s.name), a(s.addr)]))}</section>
    <section><h3>Header bytes</h3><div class="tbl-wrap" style="padding:8px 10px"><pre class="hex">${headerDump(l.bytes, 64)}</pre></div></section>
    <p class="note">The file is not signed: Windows SmartScreen may ask before the first start of a downloaded copy.</p>`;
}

function renderWasm(b: Build): void {
  const v = $('machoView');
  const m = b.wasm;
  if (!m) { v.innerHTML = '<p class="warn">No output yet.</p>'; return; }
  const sig = (t: { params: string[]; results: string[] }) => `(${t.params.join(', ')}) → ${t.results.join(', ') || 'nothing'}`;
  const mapLine = /^;; memory: data (\d+)\.\.(\d+), stack (\d+)\.\.(\d+) .*heap from (\d+)/m.exec(b.asm ?? '');
  const a = (n: number) => `0x${hex(n)}`;
  const pages = m.memory?.pages ?? 0;
  v.innerHTML = `
    <section><h3>Module</h3>${table(['', ''], [
      ['format', 'WebAssembly binary module, version 1 (wasm32: 32-bit linear memory)'],
      ['file size', fmtB(m.bytes.length)],
      ['entry point', 'hla_start(argc, argv) → main; the runtime exits with its result'],
      ['memory', `${pages} pages × 64 KB = ${fmtN(pages * 64)} KB at the start; malloc grows it`],
    ])}</section>
    ${mapLine ? `<section><h3>Linear memory</h3>${table(['region', 'from', 'to', ''], [
      ['NULL area', '0x0', a(Number(mapLine[1])), 'never used: address 0 is NULL'],
      ['data', a(Number(mapLine[1])), a(Number(mapLine[2])), 'strings, data, rodata; zero-filled data'],
      ['stack', a(Number(mapLine[3])), a(Number(mapLine[4])), 'frames of local arrays and variadic arguments; grows down from the top ($sp)'],
      ['heap', a(Number(mapLine[5])), '…', 'malloc of the runtime'],
    ])}</section>` : ''}
    <section><h3>Imports: the system (JavaScript runtime)</h3>${m.imports.length ? table(['module', 'name', 'signature'],
      m.imports.map((i) => [esc(i.module), esc(i.name), sig(i.type)])) : chips([])}
      <p class="note">"env" functions get their arguments directly; "va" ones (declared with <code>...</code>) get the address of the variadic arguments, 8 bytes each, in the caller's frame.</p></section>
    <section><h3>Exports</h3>${chips(m.exports.map((e) => `${e.name} (${e.kind})`))}</section>
    <section><h3>Functions</h3>${table(['function', 'signature', 'locals', 'instructions', 'bytes'],
      m.functions.map((f) => [esc(f.name), sig(f.type), fmtN(f.locals), fmtN(f.instructions), fmtN(f.size)]), [2, 3, 4])}</section>
    ${m.table ? `<section><h3>Table</h3><p class="note">${m.table - 1} function(s) whose address is taken: a function pointer is an index into this table, called with <code>call_indirect</code>.</p></section>` : ''}
    <section><h3>Sections</h3>${table(['section', 'offset', 'size'], m.sections.map((x) => [esc(x.name), a(x.offset), fmtN(x.size)]), [2])}</section>
    ${m.data.length ? `<section><h3>Data segments</h3>${table(['address', 'size'], m.data.map((d) => [a(d.addr), fmtN(d.size)]), [1])}</section>` : ''}
    <section><h3>Header bytes</h3><div class="tbl-wrap" style="padding:8px 10px"><pre class="hex">${headerDump(m.bytes, 64)}</pre></div></section>
    <p class="note">The browser checks the module and compiles it to the machine code of your processor when it loads it: Run executes it natively, no emulator in between.</p>`;
}

function renderMacho(b: Build): void {
  if (b.platform === 'wasm') { renderWasm(b); return; }
  if (b.platform === 'win') { renderPE(b); return; }
  const v = $('machoView');
  const a = (n: number) => `0x${hex(n)}`;
  if (b.mode === 'static' && b.object && b.archive) {
    const o = b.object;
    v.innerHTML = `
      <section><h3>Archive lib${esc(libName())}.a</h3>${table(['member', 'size'], [['__.SYMDEF SORTED (table of contents)', fmtN(b.archive.length - o.bytes.length)], [`${esc(libName())}.o (Mach-O MH_OBJECT)`, fmtN(o.bytes.length)]], [1])}</section>
      <section><h3>Exported symbols</h3>${chips(o.exports)}</section>
      <section><h3>Needs from other libraries</h3>${chips(o.imports)}</section>
      <section><h3>Sections of the object file</h3>${table(['section', 'offset', 'size', 'relocations'], o.sections.map((x) => [esc(x.name), a(x.addr), fmtN(x.size), fmtN(x.relocs)]), [2, 3])}</section>
      <p class="note">Relocations are notes for the linker: “put the address of <code>_printf</code> here”. The final addresses appear only when <code>ld</code> links the library into a program.</p>`;
    return;
  }
  const l = b.link;
  if (!l) { v.innerHTML = '<p class="warn">No output yet.</p>'; return; }
  const syms = l.symbols.filter((s) => !/^L/.test(s.name)).sort((x, y) => x.addr - y.addr);
  const header = l.bytes.subarray(0, 64);
  let dump = '';
  for (let o = 0; o < header.length; o += 16) {
    const row = [...header.subarray(o, o + 16)];
    dump += `${hex(o, 8)}  ${row.map((x) => hex(x, 2)).join(' ')}  ${row.map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('')}\n`;
  }
  v.innerHTML = `
    <section><h3>Segments</h3>${table(['segment', 'vm address', 'vm size', 'file offset', 'file size', 'prot'],
      l.segments.map((s) => [s.name, a(s.addr), a(s.vmsize), a(s.fileOff), a(s.fileSize), s.prot]))}</section>
    <section><h3>Sections</h3>${table(['section', 'address', 'size'], l.map.map((s) => [esc(s.name), a(s.addr), fmtN(s.size)]), [2])}</section>
    <section><h3>Imports bound by dyld from libSystem</h3>${chips(l.imports)}</section>
    <section><h3>Symbols</h3>${table(['symbol', 'address'], syms.map((s) => [esc(s.name), a(s.addr)]))}</section>
    <section><h3>Code signature</h3>${table(['', ''], [
      ['type', 'ad-hoc, linker-signed (CodeDirectory v20400)'], ['hash', 'SHA-256 over 4 KB pages'],
      ['pages', fmtN(l.signature.pages)], ['offset', a(l.signature.offset)], ['CDHash', l.signature.cdhash],
      ...(b.mode === 'exe' ? [['entry point', a(l.entryAddr) + ' (_main)']] : [['install name', `@rpath/lib${esc(libName())}.dylib`]])])}</section>
    ${b.mode === 'dynamic' ? `<section><h3>Exported symbols (export trie)</h3>${chips(exportedNames(b))}</section>` : ''}
    <section><h3>Header bytes</h3><div class="tbl-wrap" style="padding:8px 10px"><pre class="hex">${dump}</pre></div></section>`;
}

function hlC(code: string): string {
  return code.split('\n').map((line) => {
    if (/^\s*\/\//.test(line)) return `<span class="t-com">${esc(line)}</span>`;
    if (/^\s*#/.test(line)) return `<span class="t-dir">${esc(line)}</span>`;
    const ci = line.indexOf('//');
    const body = ci >= 0 ? line.slice(0, ci) : line, com = ci >= 0 ? `<span class="t-com">${esc(line.slice(ci))}</span>` : '';
    return esc(body)
      .replace(/("(?:[^"\\]|\\.)*")/g, '<span class="t-str">$1</span>')
      .replace(/\b(int64_t|int32_t|int16_t|int8_t|uint64_t|uint32_t|uint16_t|uint8_t|double|float|void|char|int|const|static|struct|typedef|enum|extern|return|for|if)\b/g, '<span class="t-kw">$1</span>') + com;
  }).join('\n');
}

const macroName = (n: string) => n.toUpperCase().replace(/[^A-Z0-9]/g, '_');

function buildCommands(kind: Mode): string {
  const n = libName();
  if (platform === 'win') {
    return kind === 'static'
      ? `clang main.c ${n}_static.lib -o demo.exe; .\\demo.exe`
      : `clang -D${macroName(n)}_DLL main.c ${n}.lib -o demo.exe; .\\demo.exe`;
  }
  return kind === 'static'
    ? `clang -Wall main.c lib${n}.a -o demo && ./demo`
    : `clang -Wall main.c -L. -l${n} -Wl,-rpath,@executable_path -o demo && ./demo`;
}

function renderHeader(b: Build): void {
  const cm = cMain();
  const v = $('headerView');
  if (b.mode === 'exe') { v.innerHTML = ''; return; }
  if (!b.header) { v.innerHTML = '<p class="warn">Fix the error in the source to generate the header.</p>'; return; }
  const n = libName();
  v.innerHTML = `
    <section><h3>${esc(n)}.h — generated from the export declarations</h3><div class="tbl-wrap"><pre class="c-view">${hlC(b.header)}</pre></div></section>
    <section><h3>Use it from C</h3><div class="tbl-wrap"><pre class="c-view">#include "${esc(n)}.h"     // in your main.c

${esc(buildCommands(b.mode))}</pre></div>
      <p class="note">${b.platform === 'win'
        ? (b.mode === 'static'
          ? `The code of <code>${esc(n)}_static.lib</code> is copied into the program at link time. With MSVC: <code>cl main.c ${esc(n)}_static.lib</code>.`
          : `<code>-D${macroName(n)}_DLL</code> makes the header declare everything <code>__declspec(dllimport)</code>; the import library <code>${esc(n)}.lib</code> tells the linker that the code is in <code>${esc(n)}.dll</code>. Keep the DLL next to the program. With MSVC: <code>cl /D${macroName(n)}_DLL main.c ${esc(n)}.lib</code>.`)
        : b.mode === 'static'
        ? `The code of <code>lib${esc(n)}.a</code> is copied into the program at link time.`
        : `The program keeps a reference to <code>@rpath/lib${esc(n)}.dylib</code> and loads it when it starts; keep the .dylib next to the program.`}
        <b>Download</b> or <b>Copy ${b.platform === 'win' ? 'PowerShell' : 'Terminal'} command</b> give you the header, the library${cm ? ' and the example main.c' : ''}.</p></section>
    ${cm ? `<section><h3>main.c — example program (lesson 14)</h3><div class="tbl-wrap"><pre class="c-view">${hlC(cm)}</pre></div></section>` : ''}`;
}

// ---------------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------------
function showTab(name: string): void {
  for (const t of document.querySelectorAll<HTMLElement>('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  if (mode !== 'exe' && name === 'run') name = 'header';
  if (mode === 'exe' && name === 'header') name = 'run';
  for (const t of document.querySelectorAll<HTMLElement>('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  for (const id of ['asm', 'bin', 'macho', 'header', 'run']) $(`tab-${id}`).hidden = id !== name;
  $('runStatus').hidden = name !== 'run';
  $('argsBar').hidden = name !== 'run';
  store.set('tab', name);
}
for (const t of document.querySelectorAll<HTMLElement>('.tab, .stage')) t.addEventListener('click', () => showTab(t.dataset.tab!));

function setMode(m: Mode, save = true): void {
  mode = m;
  ($<HTMLInputElement>(`mode-${m}`)).checked = true;
  if (save) { project.mode = m; persist(); }
  rebuild();
  if (m !== 'exe') showTab('header');
}
for (const m of ['exe', 'static', 'dynamic'] as Mode[]) {
  $(`mode-${m}`).addEventListener('change', () => {
    setMode(m);
    if (m === 'exe') { showTab('run'); run(); }
  });
}

// ---------------------------------------------------------------------------
// run in the emulator
// ---------------------------------------------------------------------------
let worker: Worker | null = null;
let workerUrl: string | null = null;

function runStatus(html: string): void { $('runStatus').innerHTML = html; }

type Format = 'macho' | 'pe' | 'wasm';
/** an executable a program wrote, run as it is (with no arguments) */
interface Given { bytes: Uint8Array; format: Format; name: string }

/** the command line after the program name: words and "quoted words" */
const splitArgs = (t: string): string[] => [...t.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
const argsText = () => project.args?.[project.main] ?? '';
function renderArgs(): void {
  $<HTMLInputElement>('args').value = argsText();
  $('argv0').textContent = stem(project.main) + (platform === 'win' ? '.exe' : '');
  $('argv0').title = platform === 'wasm' ? 'argv[0]: the module gets its command line from the runtime' : '';
}
$('args').addEventListener('input', () => {
  project.args = { ...project.args, [project.main]: $<HTMLInputElement>('args').value };
  persist();
});
$('args').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });

const imageFormat = (d: Uint8Array): Format | null =>
  d[0] === 0xcf && d[1] === 0xfa && d[2] === 0xed && d[3] === 0xfe ? 'macho' : d[0] === 0x4d && d[1] === 0x5a ? 'pe'
    : d[0] === 0 && d[1] === 0x61 && d[2] === 0x73 && d[3] === 0x6d ? 'wasm' : null;
const formatName: Record<Format, string> = { macho: 'Mach-O executable', pe: 'PE executable', wasm: 'WebAssembly module' };
const runnerName: Record<Format, string> = { macho: 'ARM64 emulator', pe: 'x64 emulator', wasm: 'WebAssembly engine' };

/** a file the program wrote that is not text (an executable...): download it, run it when it is one */
function binaryRow(name: string, data: Uint8Array): HTMLElement {
  const box = document.createElement('span');
  box.className = 'out';
  const format = imageFormat(data);
  const label = document.createElement('span');
  label.textContent = `${name} · ${format ? formatName[format] : 'binary file'} · ${fmtN(data.length)} bytes`;
  box.appendChild(label);
  const button = (text: string, title: string, f: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', f);
    box.appendChild(b);
  };
  if (format) button('Run', `run ${name} in the ${runnerName[format]}`, () => run({ bytes: data, format, name }));
  button('Download', format === 'macho' ? `save ${name}; then in Terminal: chmod +x ${name}` : `save ${name}`, () => save(name, data));
  return box;
}

function run(given?: Given): void {
  if (!given && mode !== 'exe') { showTab('header'); return; }
  const image = (b: Build | null) => (b?.platform === 'wasm' ? b.wasm : b?.platform === 'win' ? b.pe : b?.link)?.bytes ?? null;
  if (!given && !image(current)) { rebuild(); if (!image(current)) return; }
  const bytes = given?.bytes ?? image(current)!;
  const format: Format = given?.format ?? (current!.platform === 'wasm' ? 'wasm' : current!.platform === 'win' ? 'pe' : 'macho');
  const argv0 = given ? given.name.replace(/\.wasm$/, '') : stem(project.main);
  const args = given ? [] : splitArgs(argsText());
  const out = $('console');
  out.textContent = '';
  // the command line, when there is more to it than the program
  if (given || args.length) {
    const cmd = document.createElement('span');
    cmd.className = 'cmd';
    cmd.textContent = `$ ${[given ? given.name : $('argv0').textContent, ...args].join(' ')}\n`;
    out.appendChild(cmd);
  }
  const body = out.appendChild(document.createTextNode(''));   // what the program prints
  showTab('run');
  setStage('run', 'busy', 'running…', '');
  runStatus('<span class="pill busy">running</span> <button class="btn" id="stop" type="button">Stop</button>');
  $('stop')?.addEventListener('click', () => finish({ exitCode: null, steps: 0, error: 'stopped by user', ms: 0 }));
  const LIMIT = 400_000_000;
  // the program sees the project's files; what it writes is added to the project it ran in
  const target = project;
  const snapshot = Object.fromEntries(target.files.map((f) => [f.name, f.text]));
  let text = '';
  const append = (t: string) => {
    text += t;
    if (text.length > 400_000) text = text.slice(-300_000);
    body.data = text;
  };
  const finish = (r: { exitCode: number | null; steps: number; error: string | null; ms: number; written?: Record<string, string>; binary?: Record<string, Uint8Array> }) => {
    if (worker) { worker.terminate(); worker = null; }
    if (r.written && Object.keys(r.written).length) addWritten(target, r.written);
    if (r.error) {
      const e = document.createElement('span');
      e.className = 'e';
      e.textContent = (text && !text.endsWith('\n') ? '\n' : '') + '⚠ ' + r.error + '\n';
      out.appendChild(e);
    }
    const binaries = Object.entries(r.binary ?? {});
    for (const [name, data] of binaries) {
      if (out.textContent && !out.textContent.endsWith('\n')) out.appendChild(document.createTextNode('\n'));
      out.appendChild(binaryRow(name, data));
      out.appendChild(document.createTextNode('\n'));
    }
    if (binaries.length && target === project) {
      runNote = `the program wrote ${binaries.map(([n]) => n).join(', ')}: see the console`;
      savedNote();
    }
    const ok = r.exitCode === 0 && !r.error;
    const pill = r.error ? `<span class="pill err">${r.error === 'stopped by user' ? 'stopped' : 'crashed'}</span>`
      : `<span class="pill ${ok ? 'ok' : 'err'}">exit ${r.exitCode}</span>`;
    // WebAssembly runs natively: no instruction count, only the time
    const native = format === 'wasm';
    runStatus(native ? `${pill}<span>native WebAssembly</span><span>${r.ms.toFixed(0)} ms</span>`
      : `${pill}<span>${fmtN(r.steps)} instructions</span><span>${r.ms.toFixed(0)} ms</span>${r.ms > 0 ? `<span>${(r.steps / r.ms / 1000).toFixed(1)} M instr/s</span>` : ''}`);
    setStage('run', r.error ? 'err' : ok ? 'ok' : 'err', r.error ? (r.error === 'stopped by user' ? 'stopped' : 'crashed') : `exit ${r.exitCode}`, native ? `${r.ms.toFixed(0)} ms, native` : `${fmtN(r.steps)} instructions`);
  };
  if (worker) worker.terminate();
  try {
    if (!workerUrl) workerUrl = URL.createObjectURL(new Blob([__WORKER_SRC__], { type: 'text/javascript' }));
    worker = new Worker(workerUrl);
  } catch {
    worker = null;
  }
  if (worker) {
    worker.onmessage = (ev) => {
      if (ev.data.type === 'out') append(ev.data.text);
      else finish(ev.data);
    };
    worker.onerror = (ev) => { ev.preventDefault(); worker = null; runInPage(); };
    const copy = bytes.slice();
    worker.postMessage({ bytes: copy.buffer, limit: LIMIT, format, files: snapshot, args, name: argv0 }, [copy.buffer]);
  } else void runInPage();

  async function runInPage() {
    // no worker available (some file:// setups): run synchronously with a smaller budget
    // (a WebAssembly module asynchronously: the main thread may only compile small ones synchronously)
    const t0 = performance.now();
    const files = memoryFiles(snapshot);
    const opts = { limit: 50_000_000, files, args, onOutput: (t: string) => { text += t; } };
    const r = format === 'wasm' ? await runWasmAsync(bytes, { ...opts, name: argv0 }) : format === 'pe' ? runPE(bytes, opts) : runMachO(bytes, opts);
    body.data = text;
    const w = writtenFiles(files);
    finish({ exitCode: r.exitCode, steps: r.steps, error: r.error, ms: performance.now() - t0, written: w.text, binary: w.binary });
  }
}
$('run').addEventListener('click', () => run());

/** files a program wrote become files of its project (text; a changed source rebuilds) */
function addWritten(p: Project, written: Record<string, string>): void {
  for (const [name, text] of Object.entries(written)) {
    const f = p.files.find((x) => x.name === name);
    if (f) f.text = text; else p.files.push({ name, text });
  }
  if (p !== project) { void saveProject(p); return; }
  persist();
  if (project.open in written) { src.value = written[project.open]; renderEditor(); }
  if (Object.keys(written).some(isHla)) rebuild(); else renderFiles();
  const names = Object.keys(written);
  runNote = `the program wrote ${names.length > 3 ? names.length + ' files' : names.join(', ')}`;
  savedNote();
}

// ---------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------
function save(name: string, data: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([data.slice()], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------------------------------------------------------------------------
// what the user gets: one bundle per mode, used by every export path
// ---------------------------------------------------------------------------
interface Bundle {
  zipName: string;
  entries: ZipEntry[];       // files for the .zip
  single: ZipEntry | null;   // the plain download (executable only)
  shell: string;             // Terminal command that recreates the files (and builds/runs)
  zipHelp: string;           // explanation + command after saving the zip
}

const b64 = (bytes: Uint8Array) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/.{1,76}/g, '$&\n');
};
const heredoc = (file: string, text: string) => `cat > ${file} <<'HLA64'\n${text.endsWith('\n') ? text : text + '\n'}HLA64\n`;
// PowerShell: here-strings hold base64 (FromBase64String skips the line breaks) and text files
const psBinary = (file: string, bytes: Uint8Array) => `$b = @'\n${b64(bytes)}'@\n[IO.File]::WriteAllBytes("$PWD\\${file}", [Convert]::FromBase64String($b))\n`;
const psText = (file: string, text: string) => `[IO.File]::WriteAllText("$PWD\\${file}", @'\n${text.endsWith('\n') ? text : text + '\n'}'@)\n`;
// cmd.exe wants CRLF (labels and goto misbehave in LF-only batch files); a pasted here-string has LF
const psBatch = (file: string, text: string) =>
  `[IO.File]::WriteAllText("$PWD\\${file}", (@'\n${text.replace(/\r\n/g, '\n')}'@ -replace "\`r?\`n", "\`r\`n"))\n`;

function windowsBundle(b: Build, out: Uint8Array): Bundle {
  const cm = cMain();
  if (b.mode === 'exe') {
    const name = outName(b);
    return {
      zipName: progName() + '.zip',
      entries: [{ name, data: out }],
      single: { name, data: out },
      shell: psBinary(name, out) + `.\\${name}\n`,
      zipHelp: `Saved <b>${esc(progName())}.zip</b> with <b>${esc(name)}</b>. Files from the internet carry the “Mark of the Web”, so unblock the program once (or allow it in the SmartScreen prompt) and start it from PowerShell:`
        + `\u0000cd $HOME\\Downloads; Expand-Archive -Force ${progName()}.zip .; Unblock-File .\\${name}; .\\${name}`,
    };
  }
  const n = libName(), M = macroName(n), wl = b.winlib!;
  const cmd = buildCommands(b.mode);
  // A plain console has neither compiler: the LLVM installer does not touch PATH, and cl lives in the
  // Developer Command Prompt. clang needs that environment too (INCLUDE, LIB: the headers and the C
  // runtime of Visual Studio and the Windows SDK), so build.bat loads vcvars64.bat first.
  const [clangArgs, clArgs] = b.mode === 'static'
    ? [`main.c ${n}_static.lib -o demo.exe`, `/nologo main.c ${n}_static.lib /Fe:demo.exe`]
    : [`-D${M}_DLL main.c ${n}.lib -o demo.exe`, `/nologo /D${M}_DLL main.c ${n}.lib /Fe:demo.exe`];
  const bat = [
    '@echo off',
    `rem builds main.c against the ${b.mode === 'static' ? 'static library' : 'DLL'} with clang (LLVM) or MSVC cl and runs it`,
    'setlocal',
    'cd /d "%~dp0"',
    'where cl >nul 2>nul || call :vcvars',
    'set "CC="',
    'where clang >nul 2>nul && set "CC=clang"',
    'if not defined CC if exist "%ProgramFiles%\\LLVM\\bin\\clang.exe" set "CC=%ProgramFiles%\\LLVM\\bin\\clang.exe"',
    `if defined CC "%CC%" ${clangArgs} || exit /b 1`,
    'if defined CC goto run',
    'where cl >nul 2>nul || goto none',
    `cl ${clArgs} || exit /b 1`,
    ':run',
    '.\\demo.exe',
    'exit /b %errorlevel%',
    ':none',
    'echo Found neither clang nor cl: install LLVM (winget install LLVM.LLVM) or Visual Studio with "Desktop development with C++".',
    'exit /b 1',
    ':vcvars',
    'set "VSWHERE=%ProgramFiles(x86)%\\Microsoft Visual Studio\\Installer\\vswhere.exe"',
    'if not exist "%VSWHERE%" exit /b 0',
    // not for /f: the ")" of "Program Files (x86)" would end its parenthesis
    '"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath > "%TEMP%\\hla64-vs.txt"',
    'set "VSDIR="',
    'set /p VSDIR=<"%TEMP%\\hla64-vs.txt"',
    'del "%TEMP%\\hla64-vs.txt"',
    'if defined VSDIR call "%VSDIR%\\VC\\Auxiliary\\Build\\vcvars64.bat" >nul',
    'exit /b 0',
    '',
  ].join('\r\n');
  const libs: [string, Uint8Array][] = b.mode === 'static' ? [[`${n}_static.lib`, wl.staticLib]] : [[`${n}.dll`, wl.dll!], [`${n}.lib`, wl.importLib!]];
  const entries: ZipEntry[] = [
    { name: `${n}/${n}.h`, data: b.header ?? '' },
    ...libs.map(([f, d]) => ({ name: `${n}/${f}`, data: d })),
    { name: `${n}/${n}.obj`, data: wl.obj },
    ...(cm ? [{ name: `${n}/main.c`, data: cm }, { name: `${n}/build.bat`, data: bat }] : []),
  ];
  const shell = `New-Item -ItemType Directory -Force ${n} | Out-Null; cd ${n}\n`
    + libs.map(([f, d]) => psBinary(f, d)).join('')
    + psText(`${n}.h`, b.header ?? '')
    + (cm ? psText('main.c', cm) + psBatch('build.bat', bat) + '.\\build.bat\n'
      : `"Wrote ${n}.h and ${libs.map(([f]) => f).join(', ')} into $PWD. Write main.c with #include \`"${n}.h\`" and run: ${cmd}"\n`);
  return {
    zipName: `${n}.zip`,
    entries,
    single: null,
    shell,
    zipHelp: `Saved <b>${esc(n)}.zip</b> with <code>${esc(n)}.h</code>, ${libs.map(([f]) => `<code>${esc(f)}</code>`).join(', ')}, <code>${esc(n)}.obj</code>${cm ? ', <code>main.c</code> and <code>build.bat</code>' : ''}. Unpack it and build the C program (needs clang or Visual Studio's cl):`
      + `\u0000cd $HOME\\Downloads; Expand-Archive -Force ${n}.zip .; cd ${n}; Get-ChildItem | Unblock-File; ${cm ? '.\\build.bat' : cmd}`,
  };
}

function bundle(b: Build): Bundle | null {
  const cm = cMain();
  const out = outputBytes(b);
  if (!out) return null;
  if (b.platform === 'wasm') {
    // the module with a page that runs it (console, arguments, files) and a script for Node
    const name = progName();
    const cmd = isWindowsHost
      ? `cd $HOME\\Downloads; Expand-Archive -Force ${name}.zip .; cd ${name}; node ${name}.mjs`
      : `cd ~/Downloads && unzip -o ${name}.zip && cd ${name} && node ${name}.mjs`;
    return {
      zipName: `${name}.zip`,
      entries: wasmProgramFiles(name, out, __WASM_RUNTIME__),
      single: null,
      shell: '',
      zipHelp: `Saved <b>${esc(name)}.zip</b> with <code>${esc(name)}.wasm</code>, <code>${esc(name)}.html</code> and <code>${esc(name)}.mjs</code>. Unpack it and open <b>${esc(name)}.html</b>: the page runs the module in your browser, with a console, arguments and files (opened from disk, it may ask you to choose ${esc(name)}.wasm once). Or run it in a terminal with Node:`
        + `\u0000${cmd}`,
    };
  }
  if (b.platform === 'win') return windowsBundle(b, out);
  if (b.mode === 'exe') {
    const name = progName();
    return {
      zipName: name + '.zip',
      entries: [{ name, data: out, executable: true }],
      single: { name, data: out, executable: true },
      shell: `base64 --decode > ${name} <<'HLA64'\n${b64(out)}HLA64\nchmod +x ${name} && ./${name}\n`,
      zipHelp: `Saved <b>${esc(name)}.zip</b>: the executable inside keeps its <b>+x</b> bit, so it runs right after unpacking. A browser download is still quarantined (macOS copies the flag onto unpacked files), so clear it once:`
        + `\u0000cd ~/Downloads && unzip -o ${name}.zip && xattr -d com.apple.quarantine ${name} 2>/dev/null; ./${name}`,
    };
  }
  const n = libName();
  const libFile = b.mode === 'static' ? `lib${n}.a` : `lib${n}.dylib`;
  const build = buildCommands(b.mode);
  const script = `#!/bin/sh\n# build the example program against ${libFile}\nset -e\n${cm ? build : `# write main.c with #include "${n}.h", then:\n# ${build}`}\n`;
  const entries: ZipEntry[] = [
    { name: `${n}/${n}.h`, data: b.header ?? '' },
    { name: `${n}/${libFile}`, data: out },
    ...(cm ? [{ name: `${n}/main.c`, data: cm }] : []),
    { name: `${n}/build.sh`, data: script, executable: true },
  ];
  const shell = `mkdir -p ${n} && cd ${n}\n`
    + `base64 --decode > ${libFile} <<'HLA64'\n${b64(out)}HLA64\n`
    + heredoc(`${n}.h`, b.header ?? '')
    + (cm ? heredoc('main.c', cm) + build + '\n'
      : `echo "Wrote ${n}.h and ${libFile} into $(pwd). Write main.c with #include \\"${n}.h\\" and run: ${build}"\n`);
  return {
    zipName: `${n}.zip`,
    entries,
    single: null,
    shell,
    zipHelp: `Saved <b>${esc(n)}.zip</b> with <code>${esc(n)}.h</code>, <code>${esc(libFile)}</code>${cm ? ', <code>main.c</code>' : ''} and <code>build.sh</code>. Unpack it and build the C program:`
      + `\u0000cd ~/Downloads && unzip -o ${n}.zip && cd ${n} && xattr -cr . && sh build.sh`,
  };
}

function showSheet(html: string): void {
  const [text, cmd] = html.split('\u0000');
  $('sheet-text').innerHTML = text;
  $('cmd').textContent = cmd ?? '';
  $('sheet').hidden = false;
}

$('download').addEventListener('click', () => {
  if (!current) return;
  const bu = bundle(current);
  if (!bu) return;
  if (bu.single) {
    const name = bu.single.name;
    save(name, bu.single.data as Uint8Array);
    if (current.platform === 'win') {
      showSheet(`Saved <b>${esc(name)}</b> (${fmtB((bu.single.data as Uint8Array).length)}, x64 PE, not signed). Downloads carry the “Mark of the Web”: started from Explorer, SmartScreen may say “Windows protected your PC” (More info → Run anyway). From PowerShell it starts as is; <code>Unblock-File</code> removes the mark for good:`
        + `\u0000cd $HOME\\Downloads; Unblock-File .\\${name}; .\\${name}`);
    } else {
      showSheet(`Saved <b>${esc(name)}</b> (${fmtB((bu.single.data as Uint8Array).length)}, arm64 Mach-O, ad-hoc signed). Browsers drop the executable bit and mark downloads as quarantined, so start it from Terminal:`
        + `\u0000cd ~/Downloads && chmod +x ${name} && xattr -d com.apple.quarantine ${name} 2>/dev/null; ./${name}`);
    }
  } else {
    save(bu.zipName, zipFiles(bu.entries));
    showSheet(bu.zipHelp);
  }
});

$('copycmd').addEventListener('click', () => {
  const cm = cMain();
  if (!current) return;
  const bu = bundle(current);
  if (!bu || !bu.shell) return;
  const btn = $('copycmd');
  const win = current.platform === 'win';
  const label = copyLabel();
  const done = (ok: boolean) => {
    const what = current!.mode === 'exe'
      ? 'writes the executable into the current directory and runs it'
      : `creates a folder <b>${esc(libName())}</b> with the header and the library${cm ? ', then builds main.c against it with clang or MSVC cl (build.bat finds either) and runs it' : ''}`;
    showSheet(ok
      ? win
        ? `Copied a ${fmtB(bu.shell.length)} PowerShell command to the clipboard. Paste it into a PowerShell window: it ${what}. Nothing is downloaded, so the files get no Mark of the Web.\u0000${bu.shell.split('\n')[0]} …`
        : `Copied a ${fmtB(bu.shell.length)} shell command to the clipboard. Paste it into Terminal: it ${what}. Nothing is downloaded, so macOS adds no quarantine flag.\u0000${bu.shell.split('\n')[0]} …`
      : `The clipboard is not available here. Select the command below (it is long) and copy it manually:\u0000${bu.shell}`);
    btn.textContent = ok ? 'Copied' : label;
    setTimeout(() => (btn.textContent = label), 1600);
  };
  navigator.clipboard?.writeText(bu.shell).then(() => done(true), () => done(false)) ?? done(false);
});

$('copy').addEventListener('click', () => {
  const t = $('cmd').textContent ?? '';
  navigator.clipboard?.writeText(t).then(() => { $('copy').textContent = 'Copied'; setTimeout(() => ($('copy').textContent = 'Copy'), 1500); })
    .catch(() => { const r = document.createRange(); r.selectNodeContents($('cmd')); getSelection()?.removeAllRanges(); getSelection()?.addRange(r); });
});
$('sheet-close').addEventListener('click', () => ($('sheet').hidden = true));
// executables: also offer a zip that preserves the executable bit
const zipBtn = document.createElement('button');
zipBtn.className = 'btn';
zipBtn.type = 'button';
zipBtn.textContent = 'Download as .zip (keeps +x)';
zipBtn.id = 'zipbtn';
zipBtn.addEventListener('click', () => {
  if (!current) return;
  const bu = bundle(current);
  if (!bu) return;
  save(bu.zipName, zipFiles(bu.entries));
  showSheet(bu.zipHelp);
});
$('sheet').querySelector('.cmd')!.appendChild(zipBtn);
// ---------------------------------------------------------------------------
// projects: files on the left, kept in IndexedDB; examples are templates
// ---------------------------------------------------------------------------
const NEW_MAIN = `// main.hla — a new project. Add files on the left (+) and include them:
//   include "util.hla"
extern printf(fmt, ...)

fn main() {
    printf("Hello from HLA64!\\n")
}
`;

let userProjects: Project[] = [];            // this platform's projects (not examples)
let editedExamples = new Set<string>();      // examples with a stored, changed copy

function exampleProject(ex: Example, p: Platform = platform): Project {
  const main = ex.main ?? `${ex.id}.hla`;
  const files = ex.files ? Object.entries(ex.files).map(([name, text]) => ({ name, text })) : [{ name: main, text: ex.src }];
  if (ex.cMain) files.push({ name: 'main.c', text: ex.cMain });
  const proj: Project = { id: `ex-${p}-${ex.id}`, name: ex.title, platform: p, mode: ex.mode ?? 'exe', main, files, open: ex.open ?? main, example: ex.id, updated: 0 };
  if (ex.args) proj.args = { ...ex.args };
  return proj;
}

/** an example project that equals its template is not stored */
function sameAsTemplate(p: Project): boolean {
  const ex = PLATFORMS[p.platform].examples.find((e) => e.id === p.example);
  if (!ex) return false;
  const t = exampleProject(ex, p.platform);
  const args = (q: Project) => JSON.stringify(Object.entries(q.args ?? {}).filter(([, v]) => v).sort());
  return t.mode === p.mode && t.main === p.main && t.files.length === p.files.length
    && t.files.every((f, i) => p.files[i].name === f.name && p.files[i].text === f.text) && args(t) === args(p);
}

let saveTimer = 0;
function persist(): void {
  const p = project;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    if (p.example && sameAsTemplate(p)) { await deleteProject(p.id); editedExamples.delete(p.example); }
    else { await saveProject(p); if (p.example) editedExamples.add(p.example); }
    renderProjects();
    renderExamples();
    savedNote();
  }, 300);
}

let runNote = '';   // what the last run wrote, shown until the next edit
function savedNote(): void {
  $('saved').textContent = runNote ? runNote : !persistent ? 'not saved: browser storage is unavailable'
    : project.example ? (editedExamples.has(project.example) ? 'edited · saved in this browser' : '') : 'saved in this browser';
  $('storage-note').textContent = persistent ? '' : 'Browser storage is unavailable here: projects last until the page is closed.';
}

async function refreshLists(): Promise<void> {
  const all = await listProjects(platform);
  userProjects = all.filter((p) => !p.example);
  editedExamples = new Set(all.filter((p) => p.example).map((p) => p.example!));
  renderFiles();
  renderProjects();
  renderExamples();
}

// ---------------------------------------------------------------- list rows
type Action = { icon: string; title: string; run: (li: HTMLLIElement) => void; danger?: boolean };

function row(label: string, o: { current?: boolean; tag?: string; dot?: boolean; err?: boolean; cls?: string; title?: string; open?: () => void; actions?: Action[] }): HTMLLIElement {
  const li = document.createElement('li');
  if (o.cls) li.className = o.cls;
  if (o.err) li.classList.add('err');
  if (o.current) li.setAttribute('aria-current', 'true');
  li.title = o.title ?? label;
  if (o.open) { li.tabIndex = 0; li.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === li) o.open!(); }); }
  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = label;
  li.appendChild(nm);
  if (o.dot) { const d = document.createElement('span'); d.className = 'dot'; d.title = 'changed'; li.appendChild(d); }
  if (o.tag) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = o.tag; li.appendChild(t); }
  if (o.actions?.length) {
    const box = document.createElement('span');
    box.className = 'row-act';
    for (const a of o.actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'icon-btn' + (a.danger ? ' danger' : '');
      b.textContent = a.icon;
      b.title = a.title;
      b.setAttribute('aria-label', a.title);
      b.addEventListener('click', (e) => { e.stopPropagation(); a.run(li); });
      box.appendChild(b);
    }
    li.appendChild(box);
  }
  if (o.open) li.addEventListener('click', () => o.open!());
  return li;
}

/** a delete button that asks once more in place: the first click turns the row into "Delete?" */
const confirmDelete = (what: string, f: () => void): Action => ({
  icon: '✕', title: `Delete ${what}`, danger: true, run: (li) => {
    if (li.dataset.confirm) { f(); return; }
    li.dataset.confirm = '1';
    const nm = li.querySelector('.nm')!;
    const old = nm.textContent;
    nm.textContent = `Delete ${what}? ✕ again`;
    setTimeout(() => { if (li.isConnected) { delete li.dataset.confirm; nm.textContent = old; } }, 3000);
  },
});

/** an input in place of a row: Enter or leaving the field commits, Esc cancels */
function inlineInput(li: HTMLLIElement, initial: string, commit: (v: string) => string | null): void {
  const input = document.createElement('input');
  input.value = initial;
  input.spellcheck = false;
  li.textContent = '';
  li.appendChild(input);
  input.focus();
  const dot = initial.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  let done = false;
  const finish = (ok: boolean) => {
    if (done) return;
    if (ok && input.value.trim() && input.value.trim() !== initial) {
      const problem = commit(input.value.trim());
      if (problem) { input.setCustomValidity(problem); input.reportValidity(); input.title = problem; return; }
    }
    done = true;
    renderFiles();
    renderProjects();
  };
  input.addEventListener('input', () => input.setCustomValidity(''));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); done = true; renderFiles(); renderProjects(); }
  });
  input.addEventListener('blur', () => finish(true));
  li.addEventListener('click', (e) => e.stopPropagation());
}

// ---------------------------------------------------------------- files
const isHla = (n: string) => /\.hla$/i.test(n);
const badName = (n: string): string | null =>
  !/^[\w.-]+(\/[\w.-]+)*$/.test(n) || n.split('/').some((p) => p === '..' || p === '.') ? 'letters, digits, . - _ and / only'
    : project.files.some((f) => f.name === n) ? `${n} already exists` : null;

function renderFiles(): void {
  const ul = $('file-list');
  ul.textContent = '';
  $('proj-title').textContent = 'Files';
  $('proj-title').title = project.name;
  const errFile = current?.error?.stage === 'src' ? current.error.file : undefined;
  for (const f of project.files) {
    const actions: Action[] = [];
    if (isHla(f.name) && f.name !== project.main) actions.push({ icon: '▶', title: 'Build from this file (make it the main file)', run: () => setMain(f.name) });
    actions.push({ icon: '✎', title: 'Rename', run: (li) => inlineInput(li, f.name, (v) => renameFile(f.name, v)) });
    if (!(isHla(f.name) && project.files.filter((x) => isHla(x.name)).length === 1)) actions.push(confirmDelete(f.name, () => deleteFile(f.name)));
    ul.appendChild(row(f.name, {
      current: f.name === project.open, tag: f.name === project.main ? 'main' : undefined, err: f.name === errFile,
      title: f.name === project.main ? `${f.name}: the build starts here` : f.name, open: () => openFile(f.name), actions,
    }));
  }
}

function openFile(name: string): void {
  const f = project.files.find((x) => x.name === name);
  if (!f) return;
  project.open = name;
  src.value = f.text;
  src.scrollTop = 0;
  src.scrollLeft = 0;
  $('filename').textContent = name;
  $('filename').title = `${project.name} / ${name}`;
  errLine = current?.error?.stage === 'src' && current.error.file === name ? current.error.line : 0;
  renderEditor();
  renderFiles();
  if (current) renderDiag(current);
  updateCursor();
  persist();
}

function addFile(name: string, text: string): void {
  const f = project.files.find((x) => x.name === name);
  if (f) f.text = text; else project.files.push({ name, text });
}

function renameFile(from: string, to: string): string | null {
  if (!/\.\w+$/.test(to)) to += '.hla';
  const problem = badName(to);
  if (problem) return problem;
  if (isHla(from) && !isHla(to) && project.main === from) return 'the main file must stay a .hla file';
  project.files.find((x) => x.name === from)!.name = to;
  // includes of the renamed file follow it (paths are relative to the including file)
  for (const f of project.files) {
    const dir = f.name.includes('/') ? f.name.slice(0, f.name.lastIndexOf('/') + 1) : '';
    const rel = (target: string) => {
      const up = dir.split('/').filter(Boolean).length;
      return target.startsWith(dir) ? target.slice(dir.length) : '../'.repeat(up) + target;
    };
    f.text = f.text.replace(/^(\s*include\s+")([^"]*)(")/gm, (m, a, p, b) => (normalizePath(dir + p) === from ? a + rel(to) + b : m));
    if (f.name === project.open) src.value = f.text;
  }
  if (project.args?.[from] !== undefined) { project.args[to] = project.args[from]; delete project.args[from]; }
  if (project.main === from) { project.main = to; renderArgs(); }
  if (project.open === from) { project.open = to; $('filename').textContent = to; }
  persist();
  rebuild();
  return null;
}

function deleteFile(name: string): void {
  project.files = project.files.filter((x) => x.name !== name);
  if (project.main === name) { project.main = project.files.find((x) => isHla(x.name))?.name ?? project.files[0].name; renderArgs(); }
  if (project.open === name) openFile(project.main);
  persist();
  rebuild();
}

function setMain(name: string): void {
  project.main = name;
  renderArgs();
  persist();
  rebuild();
}

$('file-new').addEventListener('click', () => {
  const li = document.createElement('li');
  $('file-list').appendChild(li);
  inlineInput(li, freeName(project, 'util.hla'), (v) => {
    if (!/\.\w+$/.test(v)) v += '.hla';
    const problem = badName(v);
    if (problem) return problem;
    project.files.push({ name: v, text: isHla(v) ? `// ${v} — include it from ${project.main}: include "${v}"\n` : '' });
    persist();
    setTimeout(() => openFile(v));
    return null;
  });
});

// files from disk: the button, or dropped on the sidebar
async function addFromDisk(list: FileList | null): Promise<void> {
  if (!list?.length) return;
  let last = '';
  for (const file of Array.from(list)) {
    const name = file.name.replace(/[^\w.-]/g, '_');
    addFile(name, (await file.text()).replace(/\r\n/g, '\n'));
    last = name;
  }
  persist();
  openFile(last);
  rebuild();
}
const fileInput = $<HTMLInputElement>('file-input');
$('file-upload').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { void addFromDisk(fileInput.files).then(() => (fileInput.value = '')); });
const side = $('side');
side.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); side.classList.add('drop'); } });
side.addEventListener('dragleave', () => side.classList.remove('drop'));
side.addEventListener('drop', (e) => { e.preventDefault(); side.classList.remove('drop'); void addFromDisk(e.dataTransfer?.files ?? null); });

diag.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-open]');
  if (b) openFile(b.dataset.open!);
});

// ---------------------------------------------------------------- projects and examples
function renderProjects(): void {
  const ul = $('proj-list');
  ul.textContent = '';
  if (!userProjects.length) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="nm" style="color:var(--muted);font-family:var(--ui)">no projects yet: + creates one</span>';
    li.style.cursor = 'default';
    ul.appendChild(li);
  }
  for (const p of userProjects) {
    ul.appendChild(row(p.name, {
      current: p.id === project.id, open: () => void openStored(p.id).then(autorun),
      actions: [
        { icon: '✎', title: 'Rename project', run: (li) => inlineInput(li, p.name, (v) => renameProject(p, v)) },
        confirmDelete(`project ${p.name}`, () => void removeProject(p)),
      ],
    }));
  }
}

function renderExamples(): void {
  const ul = $('ex-list');
  ul.textContent = '';
  for (const ex of examples()) {
    const edited = editedExamples.has(ex.id);
    ul.appendChild(row(ex.title, {
      cls: 'ex', current: project.example === ex.id, dot: edited, title: edited ? `${ex.title} (changed, saved in this browser)` : ex.title,
      open: () => void openStored(`ex-${platform}-${ex.id}`).then(autorun),
      actions: edited ? [{ icon: '↺', title: 'Reset to the original', run: () => void resetExample(ex) }] : [],
    })).dataset.example = ex.id;
  }
}

const projectName = (wanted: string) => {
  let n = wanted;
  for (let i = 2; userProjects.some((p) => p.name === n); i++) n = `${wanted} ${i}`;
  return n;
};

function renameProject(p: Project, name: string): string | null {
  if (userProjects.some((x) => x !== p && x.name === name)) return `${name} already exists`;
  p.name = name;
  if (p.id === project.id) project.name = name;
  void saveProject(p.id === project.id ? project : p).then(refreshLists);
  return null;
}

async function removeProject(p: Project): Promise<void> {
  await deleteProject(p.id);
  await refreshLists();
  if (p.id === project.id) { await openStored(null); autorun(); }
}

async function resetExample(ex: Example): Promise<void> {
  await deleteProject(`ex-${platform}-${ex.id}`);
  editedExamples.delete(ex.id);
  if (project.example === ex.id) { openProject(exampleProject(ex)); autorun(); }
  renderExamples();
}

async function createProject(name: string, files: Project['files'], from?: Project): Promise<void> {
  const p: Project = {
    id: newId(), name: projectName(name), platform, mode: from?.mode ?? 'exe', main: from?.main ?? files[0].name,
    files, open: from?.open ?? files[0].name, updated: 0,
  };
  await saveProject(p);
  await refreshLists();
  openProject(p);
  autorun();
}

$('proj-new').addEventListener('click', () => {
  const li = document.createElement('li');
  $('proj-list').prepend(li);
  inlineInput(li, projectName('my-project'), (v) => {
    void createProject(v, [{ name: 'main.hla', text: NEW_MAIN }]);
    return null;
  });
});
$('proj-dup').addEventListener('click', () => {
  void createProject(`${project.example ?? project.name} copy`, project.files.map((f) => ({ ...f })), project);
});

$('proj-zip').addEventListener('click', () => {
  const dir = progName();
  saveFile(`${dir}.zip`, zipFiles(project.files.map((f) => ({ name: `${dir}/${f.name}`, data: f.text }))));
});

function openProject(p: Project, remember = true): void {
  project = p;
  runNote = '';
  if (remember) store.set(key('project'), p.id);
  mode = p.platform === 'wasm' ? 'exe' : p.mode;   // a WebAssembly module is a whole program
  ($<HTMLInputElement>(`mode-${mode}`)).checked = true;
  if (!p.files.some((f) => f.name === p.open)) p.open = p.main;
  const f = p.files.find((x) => x.name === p.open)!;
  src.value = f.text;
  src.scrollTop = 0;
  $('filename').textContent = p.open;
  $('filename').title = `${p.name} / ${p.open}`;
  selectedRow = -1;
  setStage('run', '', '—', '');
  $('console').textContent = '';
  runStatus(platform === 'wasm' ? '<span>Press Run to run the module in the WebAssembly engine of this browser.</span>'
    : `<span>Press Run to execute the program in the built-in ${PLATFORMS[platform].emulator}.</span>`);
  renderArgs();
  rebuild();
  renderProjects();
  renderExamples();
  savedNote();
}

/** open a stored project (or an example's template); null or unknown: the first example */
async function openStored(id: string | null): Promise<void> {
  const stored = id ? await getProject(id) : null;
  if (stored && stored.platform === platform) { openProject(stored); return; }
  const exId = id?.startsWith(`ex-${platform}-`) ? id.slice(`ex-${platform}-`.length) : null;
  openProject(exampleProject(examples().find((e) => e.id === exId) ?? examples()[0]));
}

function autorun(): void {
  if (mode === 'exe') run(); else showTab('header');
}

/** edits of examples kept in localStorage by earlier versions become example projects (once) */
async function migrate(): Promise<void> {
  if (store.get('projects-v1')) return;
  for (const p of ['mac', 'win'] as Platform[]) {
    for (const ex of PLATFORMS[p].examples) {
      const k = (p === 'mac' ? '' : 'win:');
      const text = store.get(k + 'src:' + ex.id), m = store.get(k + 'mode:' + ex.id) as Mode | null;
      if (text === null && m === null) continue;
      const proj = exampleProject(ex, p);
      if (text !== null) proj.files[0].text = text;
      if (m) proj.mode = m;
      if (!sameAsTemplate(proj)) await saveProject(proj);
    }
    const last = store.get((p === 'mac' ? '' : 'win:') + 'example');
    if (last) store.set((p === 'mac' ? '' : 'win:') + 'project', `ex-${p}-${last}`);
  }
  store.set('projects-v1', '1');
}

const copyLabel = () => (platform === 'win' ? 'Copy PowerShell command' : 'Copy Terminal command');

/** switch the target platform: examples, labels and the tool chain */
function setPlatform(p: Platform): void {
  platform = p;
  store.set('platform', p);
  ($<HTMLInputElement>(`plat-${p}`)).checked = true;
  document.documentElement.dataset.platform = p;
  const P = PLATFORMS[p];
  $('brand-sub').textContent = P.sub;
  $('plat-hint').textContent = p === 'wasm'
    ? 'Everything runs in this page: translator and assembler build a module, the browser runs it natively with a JavaScript runtime as its system.'
    : 'Everything runs in this page: translator, assembler, linker and an emulator of the target CPU.';
  $('tab-btn-macho').textContent = P.tab;
  $('lib-static').textContent = P.lib.static;
  $('lib-dynamic').textContent = P.lib.dynamic;
  $('dyn-name').textContent = p === 'win' ? 'DLL' : 'Dynamic lib';
  $('copycmd').textContent = copyLabel();
  $('copycmd').title = p === 'win' ? 'Copies a PowerShell command that recreates the files (no download, no Mark of the Web)' : 'Copies a shell command that recreates and runs the executable';
  // WebAssembly: programs only (a module is a whole program), downloaded as a .zip with a page that runs it
  $('copycmd').hidden = p === 'wasm';
  for (const m of ['static', 'dynamic']) $(`mode-${m}`).closest('label')!.hidden = p === 'wasm';
  $('sheet').hidden = true;
}

// hosted artifact viewer: plain downloads are blocked, files go through the `downloads` capability (.zip)
type Downloads = { save(r: { filename: string; data: Uint8Array }): Promise<unknown> };
let artifactDownloads: Downloads | null = null;
/** a file for the user: a browser download, or the artifact's downloads capability */
function saveFile(name: string, data: Uint8Array): void {
  if (!__ARTIFACT__) { save(name, data); return; }
  artifactDownloads?.save({ filename: name, data }).catch(() => { /* declined */ });
}
if (__ARTIFACT__) {
  const dl = $<HTMLButtonElement>('download');
  dl.hidden = true;
  zipBtn.hidden = true;
  $('proj-zip').hidden = true;
  dl.textContent = 'Download .zip';
  const w = window as unknown as { claude?: { use(n: string): Promise<Downloads | null> } };
  w.claude?.use('downloads').then((downloads) => {
    if (!downloads) return;
    artifactDownloads = downloads;
    dl.hidden = false;
    $('proj-zip').hidden = false;
    dl.addEventListener('click', (e) => {
      e.stopImmediatePropagation();
      if (!current) return;
      const bu = bundle(current);
      if (!bu) return;
      downloads.save({ filename: bu.zipName, data: zipFiles(bu.entries) }).then(() => showSheet(bu.zipHelp), () => { /* declined */ });
    }, { capture: true });
  }, () => {});
}

for (const p of ['mac', 'win', 'wasm'] as Platform[]) {
  $(`plat-${p}`).addEventListener('change', () => {
    if (worker) { worker.terminate(); worker = null; }
    setPlatform(p);
    void refreshLists().then(() => openStored(store.get(key('project')))).then(autorun);
  });
}

setPlatform(platform);
showTab(store.get('tab') ?? 'run');
const lastProject = store.get(key('project'));
openProject(project, false);               // the first example right away; the stored project follows
void migrate().then(refreshLists).then(() => openStored(store.get(key('project')) ?? lastProject)).then(autorun);

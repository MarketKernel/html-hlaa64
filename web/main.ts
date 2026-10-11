// HLA64 Workbench: editor + translator + assembler/linker + emulator, all in the page.
// Two platforms: macOS on ARM64 (Mach-O) and Windows on x86-64 (PE/COFF).
import { compile, compileLibrary } from '../src/lang/codegen.ts';
import { compileX64, compileLibraryX64 } from '../src/lang/x64/codegen.ts';
import { CompileError } from '../src/lang/lexer.ts';
import { assemble, assembleAndLink, link, writeObject, writeArchive, AsmError, type LinkResult } from '../src/asm/index.ts';
import { assembleAndLinkX, assembleX, writeCoffObject, buildWindowsLibrary, linkPE, type PeResult, type WindowsLibrary } from '../src/asm/x64/index.ts';
import { runMachO } from '../src/emu/macho-loader.ts';
import { runPE } from '../src/emu/x64/pe-loader.ts';
import { zipFiles, type ZipEntry } from './zip.ts';

import exMandelbrot from '../examples/mandelbrot.hla';
import exShowcase from '../examples/showcase.hla';
import exHello from '../examples/hello.hla';
import exFizz from '../examples/fizzbuzz.hla';
import exBare from '../examples/bare-metal.hla';
import exArith from '../tests/cases/arith.hla';
import exMemory from '../tests/cases/memory.hla';
import exMathlib from '../docs/lessons/14-library/mathlib.hla';
import exMathlibMain from '../docs/lessons/14-library/main.c';
import wxMandelbrot from '../tests/x64/cases/mandelbrot.hla';
import wxShowcase from '../tests/x64/cases/showcase.hla';
import wxArith from '../tests/x64/cases/arith.hla';
import wxMemory from '../tests/x64/cases/memory.hla';
import wxMathlib from '../tests/x64/lib/mathlib.hla';

declare const __WORKER_SRC__: string;
declare const __ARTIFACT__: boolean;

type Mode = 'exe' | 'static' | 'dynamic';
type Platform = 'mac' | 'win';
interface Example { id: string; title: string; src: string; mode?: Mode; cMain?: string }

const MAC_EXAMPLES: Example[] = [
  { id: 'mandelbrot', title: 'Mandelbrot set (floating point)', src: exMandelbrot },
  { id: 'mathlib', title: 'Library for C: mathlib (lesson 14)', src: exMathlib, mode: 'static', cMain: exMathlibMain },
  { id: 'showcase', title: 'Language tour (everything)', src: exShowcase },
  { id: 'hello', title: 'Hello, world', src: exHello },
  { id: 'fizzbuzz', title: 'FizzBuzz', src: exFizz },
  { id: 'bare-metal', title: 'Bare metal: syscalls + inline asm', src: exBare },
  { id: 'arith', title: 'Self-test: arithmetic', src: exArith },
  { id: 'memory', title: 'Self-test: memory & calls', src: exMemory },
];
// the same programs with x86-64 register names (hello and fizzbuzz are portable as they are)
const WIN_EXAMPLES: Example[] = [
  { id: 'mandelbrot', title: 'Mandelbrot set (floating point)', src: wxMandelbrot },
  { id: 'mathlib', title: 'Library for C: mathlib (lesson 14)', src: wxMathlib, mode: 'static', cMain: exMathlibMain },
  { id: 'showcase', title: 'Language tour (everything)', src: wxShowcase },
  { id: 'hello', title: 'Hello, world', src: exHello },
  { id: 'fizzbuzz', title: 'FizzBuzz', src: exFizz },
  { id: 'arith', title: 'Self-test: arithmetic', src: wxArith },
  { id: 'memory', title: 'Self-test: memory & calls', src: wxMemory },
];

const PLATFORMS: Record<Platform, { examples: Example[]; sub: string; emulator: string; image: string; tab: string; lib: { static: string; dynamic: string } }> = {
  mac: { examples: MAC_EXAMPLES, sub: 'AArch64 · macOS · offline workbench', emulator: 'ARM64 emulator', image: 'Mach-O executable', tab: 'Mach-O', lib: { static: '.a', dynamic: '.dylib' } },
  win: { examples: WIN_EXAMPLES, sub: 'x86-64 · Windows · offline workbench', emulator: 'x64 emulator', image: 'PE executable', tab: 'PE / COFF', lib: { static: '.lib', dynamic: '.dll' } },
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const src = $<HTMLTextAreaElement>('src');
const hl = $('hl');
const gutter = $('gutter');
const diag = $('diag');
const exampleSel = $<HTMLSelectElement>('example');
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
  'push', 'pop', 'local', 'unsigned', 'auto', 'set', 'call']);
const TYPES = new Set(['i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64', 'ptr', 'f32', 'f64', 'string']);
const REG_ARM = /^(?:[xw](?:[12]?\d|30)|[dsqhb](?:[12]?\d|3[01])|sp|wsp|xzr|wzr|fp|lr)$/i;
const REG_X64 = /^(?:[re]?(?:ax|bx|cx|dx|si|di|sp|bp)|[abcd][lh]|(?:si|di|sp|bp)l|r(?:[89]|1[0-5])[dwb]?|xmm(?:\d|1[0-5])|rip)$/i;
const REG = { test: (w: string) => (platform === 'win' ? REG_X64 : REG_ARM).test(w) };

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

// ---------------------------------------------------------------------------
// editor
// ---------------------------------------------------------------------------
let errLine = 0;

function renderEditor(): void {
  const text = src.value;
  let html = hlHla(text);
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
  coff: ReturnType<typeof writeCoffObject> | null;           // Windows static library: the .obj inside the .lib
  winlib: WindowsLibrary | null;
  header: string | null;
  listing: Listing[];
  instructions: number;
  warnings: string[];
  error: { stage: 'src' | 'asm'; line: number; col: number; message: string } | null;
  tCompile: number;
  tAsm: number;
}

let current: Build | null = null;
let platform: Platform = (store.get('platform') as Platform | null) ?? (isWindowsHost ? 'win' : 'mac');
const examples = () => PLATFORMS[platform].examples;
let currentExample = examples()[0];
let mode: Mode = 'exe';
// storage keys: macOS keeps the original names, Windows gets its own namespace
const key = (k: string) => (platform === 'mac' ? k : 'win:' + k);
const wordBytes = (w: number) => [w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, w >>> 24];

const libName = () => currentExample.id.replace(/[^\w]/g, '_') || 'mylib';

function build(): Build {
  const b: Build = {
    platform, mode, asm: null, link: null, object: null, archive: null, pe: null, coff: null, winlib: null,
    header: null, listing: [], instructions: 0, warnings: [], error: null, tCompile: 0, tAsm: 0,
  };
  const win = platform === 'win';
  const t0 = performance.now();
  try {
    if (mode === 'exe') {
      const r = win ? compileX64(src.value) : compile(src.value);
      b.asm = r.asm;
      b.warnings = r.warnings;
    } else {
      const r = win ? compileLibraryX64(src.value, libName()) : compileLibrary(src.value, libName());
      b.asm = r.asm;
      b.header = r.header;
      b.warnings = r.warnings;
    }
  } catch (e) {
    if (e instanceof CompileError) b.error = { stage: 'src', line: e.line, col: e.col, message: e.message };
    else b.error = { stage: 'src', line: 0, col: 0, message: 'internal compiler error: ' + (e as Error).message };
  }
  b.tCompile = performance.now() - t0;
  if (b.asm) {
    const t1 = performance.now();
    try {
      if (win) {
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
        b.link = assembleAndLink(b.asm, { name: currentExample.id });
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
  if (b.platform === 'win') return b.mode === 'exe' ? b.pe?.bytes ?? null : b.mode === 'static' ? b.winlib?.staticLib ?? null : b.winlib?.dll ?? null;
  return b.mode === 'static' ? b.archive : b.link?.bytes ?? null;
};
/** file names of the outputs */
const outName = (b: Build): string => {
  const n = libName();
  if (b.platform === 'win') return b.mode === 'exe' ? `${progName()}.exe` : b.mode === 'static' ? `${n}_static.lib` : `${n}.dll`;
  return b.mode === 'exe' ? progName() : b.mode === 'static' ? `lib${n}.a` : `lib${n}.dylib`;
};
const progName = () => currentExample.id.replace(/[^\w-]/g, '_') || 'program';

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
  const lines = src.value.split('\n').length;
  errLine = b.error?.stage === 'src' ? b.error.line : 0;
  renderEditor();

  // diagnostics
  if (b.error) {
    const where = b.error.stage === 'src' ? `${currentExample.id}.hla:${b.error.line}:${b.error.col}` : b.error.line ? `assembly line ${b.error.line}` : 'linker';
    diag.innerHTML = `<strong>error</strong> ${esc(where)}: ${esc(b.error.message)}`;
    diag.hidden = false;
  } else if (b.warnings.length) {
    diag.innerHTML = b.warnings.map((w) => `<span class="warn">warning ${esc(w)}</span>`).join('\n');
    diag.hidden = false;
  } else diag.hidden = true;

  setStage('src', b.error?.stage === 'src' ? 'err' : 'ok', `${fmtN(lines)} lines`, `${fmtB(new TextEncoder().encode(src.value).length)}`);
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
    setStage('bin', 'ok', `${fmtN(b.instructions)} instructions`, `${fmtB(textBytes)} of ${win ? '.text' : '__text'}`);
    if (win) {
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
  if (!__ARTIFACT__) $('download').textContent = b.mode === 'exe' ? (win ? 'Download .exe' : 'Download executable') : 'Download .zip';
  const zb = document.getElementById('zipbtn');
  if (zb) zb.hidden = b.mode !== 'exe' || __ARTIFACT__ || win;
  ($<HTMLButtonElement>('copycmd')).disabled = !out;
  $('tab-btn-header').hidden = b.mode === 'exe';
  $('tab-btn-run').hidden = b.mode !== 'exe';
  renderHeader(b);
  renderAsm(b);
  renderListing(b);
  renderMacho(b);
}

let editTimer = 0;
function onEdit(): void {
  renderEditor();
  updateCursor();
  clearTimeout(editTimer);
  editTimer = window.setTimeout(() => {
    rebuild();
    const orig = currentExample.src;
    if (src.value !== orig) { store.set(key('src:' + currentExample.id), src.value); $('saved').textContent = 'edited · saved in this browser'; }
    else { store.del(key('src:' + currentExample.id)); $('saved').textContent = ''; }
  }, 220);
}

// ---------------------------------------------------------------------------
// output views
// ---------------------------------------------------------------------------
function renderAsm(b: Build): void {
  const v = $('asmView');
  if (!b.asm) { v.innerHTML = `<span class="t-com">// fix the error in the source to see the generated assembly</span>`; return; }
  const errAt = b.error?.stage === 'asm' ? b.error.line : 0;
  v.innerHTML = b.asm.split('\n').map((l, i) => (i + 1 === errAt ? `<span class="hl">${hlAsmLine(l) || ' '}</span>` : hlAsmLine(l))).join('\n');
}

let selectedRow = -1;
function renderListing(b: Build): void {
  const v = $('binView');
  if (!b.listing.length || !b.asm) { v.innerHTML = ''; $('bits').innerHTML = '<span class="idx">no machine code yet</span>'; return; }
  const asmLines = b.asm.split('\n');
  const out: string[] = [];
  let prev = 0;
  const win = b.platform === 'win';
  if (b.mode === 'static') out.push(`<span class="t-com">// object file: addresses are offsets; fields the linker fills in (${win ? 'calls, rip-relative addresses' : 'calls, adrp, @PAGEOFF'}) are still zero</span>`);
  // ARM: one 32-bit word per instruction; x64: 1..15 bytes
  const width = win ? Math.min(15, Math.max(...b.listing.map((l) => l.bytes.length))) * 3 - 1 : 8;
  const code = (ins: Listing) => (win ? ins.bytes.map((x) => hex(x, 2)).join(' ') : hex((ins.bytes[0] | (ins.bytes[1] << 8) | (ins.bytes[2] << 16) | (ins.bytes[3] << 24)) >>> 0, 8)).padEnd(width);
  b.listing.forEach((ins, i) => {
    if (ins.line) {
      for (let k = prev + 1; k < ins.line; k++) {
        const t = asmLines[k - 1]?.trim() ?? '';
        if (/^[\w.$]+:$/.test(t)) out.push(`<span class="lbl">${esc(t)}</span>`);
      }
      prev = ins.line;
    } else if (!win && (i === 0 || b.listing[i - 1].sect !== '__stubs')) out.push(`<span class="lbl">__stubs:</span>   <span class="t-com">// trampolines into libSystem through the GOT</span>`);
    else if (win && (i === 0 || b.listing[i - 1].line !== 0)) out.push(`<span class="lbl">import thunks:</span>   <span class="t-com">// jmp qword ptr [rip + __imp_name]: through the import address table</span>`);
    const text = ins.line ? hlAsmLine(asmLines[ins.line - 1].trim()) : win ? `<span class="t-com">jmp [__imp_${esc(ins.sect.replace(/^stub /, ''))}]</span>` : '<span class="t-com">stub</span>';
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
  const win = current?.platform === 'win';
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
    idx = `${ins.bytes.length} bytes in memory order (prefixes · REX · opcode · ModRM · SIB · displacement · immediate) · click any row to inspect its encoding`;
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
  bits.innerHTML = `<div><span class="addr" style="color:var(--addr)">0x${hex(ins.addr)}</span>  <b>${shown}</b>  ${hlAsmLine(text)}</div>`
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

function renderMacho(b: Build): void {
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
        <b>Download</b> or <b>Copy ${b.platform === 'win' ? 'PowerShell' : 'Terminal'} command</b> give you the header, the library${currentExample.cMain ? ' and the example main.c' : ''}.</p></section>
    ${currentExample.cMain ? `<section><h3>main.c — example program (lesson 14)</h3><div class="tbl-wrap"><pre class="c-view">${hlC(currentExample.cMain)}</pre></div></section>` : ''}`;
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
  store.set('tab', name);
}
for (const t of document.querySelectorAll<HTMLElement>('.tab, .stage')) t.addEventListener('click', () => showTab(t.dataset.tab!));

function setMode(m: Mode, persist = true): void {
  mode = m;
  ($<HTMLInputElement>(`mode-${m}`)).checked = true;
  if (persist) store.set(key('mode:' + currentExample.id), m);
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

function run(): void {
  if (mode !== 'exe') { showTab('header'); return; }
  const image = (b: Build | null) => (b?.platform === 'win' ? b.pe : b?.link)?.bytes ?? null;
  if (!image(current)) { rebuild(); if (!image(current)) return; }
  const bytes = image(current)!;
  const format = current!.platform === 'win' ? 'pe' : 'macho';
  const out = $('console');
  out.textContent = '';
  showTab('run');
  setStage('run', 'busy', 'running…', '');
  runStatus('<span class="pill busy">running</span> <button class="btn" id="stop" type="button">Stop</button>');
  $('stop')?.addEventListener('click', () => finish({ exitCode: null, steps: 0, error: 'stopped by user', ms: 0 }));
  const LIMIT = 400_000_000;
  let text = '';
  const append = (t: string) => {
    text += t;
    if (text.length > 400_000) text = text.slice(-300_000);
    out.textContent = text;
  };
  const finish = (r: { exitCode: number | null; steps: number; error: string | null; ms: number }) => {
    if (worker) { worker.terminate(); worker = null; }
    if (r.error) {
      const e = document.createElement('span');
      e.className = 'e';
      e.textContent = (text && !text.endsWith('\n') ? '\n' : '') + '⚠ ' + r.error + '\n';
      out.appendChild(e);
    }
    const ok = r.exitCode === 0 && !r.error;
    const pill = r.error ? `<span class="pill err">${r.error === 'stopped by user' ? 'stopped' : 'crashed'}</span>`
      : `<span class="pill ${ok ? 'ok' : 'err'}">exit ${r.exitCode}</span>`;
    runStatus(`${pill}<span>${fmtN(r.steps)} instructions</span><span>${r.ms.toFixed(0)} ms</span>${r.ms > 0 ? `<span>${(r.steps / r.ms / 1000).toFixed(1)} M instr/s</span>` : ''}`);
    setStage('run', r.error ? 'err' : ok ? 'ok' : 'err', r.error ? (r.error === 'stopped by user' ? 'stopped' : 'crashed') : `exit ${r.exitCode}`, `${fmtN(r.steps)} instructions`);
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
    worker.postMessage({ bytes: copy.buffer, limit: LIMIT, format }, [copy.buffer]);
  } else runInPage();

  function runInPage() {
    // no worker available (some file:// setups): run synchronously with a smaller budget
    const t0 = performance.now();
    const opts = { limit: 50_000_000, onOutput: (t: string) => { text += t; } };
    const r = format === 'pe' ? runPE(bytes, opts) : runMachO(bytes, opts);
    out.textContent = text;
    finish({ exitCode: r.exitCode, steps: r.steps, error: r.error, ms: performance.now() - t0 });
  }
}
$('run').addEventListener('click', run);

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

function windowsBundle(b: Build, out: Uint8Array): Bundle {
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
  const bat = `@echo off\r\nrem build the example program against the ${b.mode === 'static' ? 'static library' : 'DLL'} (clang or MSVC cl)\r\n`
    + (b.mode === 'static'
      ? `where clang >nul 2>nul && (clang main.c ${n}_static.lib -o demo.exe) || (cl /nologo main.c ${n}_static.lib /Fe:demo.exe)\r\n`
      : `where clang >nul 2>nul && (clang -D${M}_DLL main.c ${n}.lib -o demo.exe) || (cl /nologo /D${M}_DLL main.c ${n}.lib /Fe:demo.exe)\r\n`)
    + 'demo.exe\r\n';
  const libs: [string, Uint8Array][] = b.mode === 'static' ? [[`${n}_static.lib`, wl.staticLib]] : [[`${n}.dll`, wl.dll], [`${n}.lib`, wl.importLib]];
  const entries: ZipEntry[] = [
    { name: `${n}/${n}.h`, data: b.header ?? '' },
    ...libs.map(([f, d]) => ({ name: `${n}/${f}`, data: d })),
    { name: `${n}/${n}.obj`, data: wl.obj },
    ...(currentExample.cMain ? [{ name: `${n}/main.c`, data: currentExample.cMain }, { name: `${n}/build.bat`, data: bat }] : []),
  ];
  const shell = `New-Item -ItemType Directory -Force ${n} | Out-Null; cd ${n}\n`
    + libs.map(([f, d]) => psBinary(f, d)).join('')
    + psText(`${n}.h`, b.header ?? '')
    + (currentExample.cMain ? psText('main.c', currentExample.cMain) + cmd + '\n'
      : `"Wrote ${n}.h and ${libs.map(([f]) => f).join(', ')} into $PWD. Write main.c with #include \`"${n}.h\`" and run: ${cmd}"\n`);
  return {
    zipName: `${n}.zip`,
    entries,
    single: null,
    shell,
    zipHelp: `Saved <b>${esc(n)}.zip</b> with <code>${esc(n)}.h</code>, ${libs.map(([f]) => `<code>${esc(f)}</code>`).join(', ')}, <code>${esc(n)}.obj</code>${currentExample.cMain ? ', <code>main.c</code> and <code>build.bat</code>' : ''}. Unpack it and build the C program (needs clang or Visual Studio's cl):`
      + `\u0000cd $HOME\\Downloads; Expand-Archive -Force ${n}.zip .; cd ${n}; Get-ChildItem | Unblock-File; ${currentExample.cMain ? '.\\build.bat' : cmd}`,
  };
}

function bundle(b: Build): Bundle | null {
  const out = outputBytes(b);
  if (!out) return null;
  if (b.platform === 'win') return windowsBundle(b, out);
  if (b.mode === 'exe') {
    const name = currentExample.id.replace(/[^\w-]/g, '_') || 'program';
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
  const script = `#!/bin/sh\n# build the example program against ${libFile}\nset -e\n${currentExample.cMain ? build : `# write main.c with #include "${n}.h", then:\n# ${build}`}\n`;
  const entries: ZipEntry[] = [
    { name: `${n}/${n}.h`, data: b.header ?? '' },
    { name: `${n}/${libFile}`, data: out },
    ...(currentExample.cMain ? [{ name: `${n}/main.c`, data: currentExample.cMain }] : []),
    { name: `${n}/build.sh`, data: script, executable: true },
  ];
  const shell = `mkdir -p ${n} && cd ${n}\n`
    + `base64 --decode > ${libFile} <<'HLA64'\n${b64(out)}HLA64\n`
    + heredoc(`${n}.h`, b.header ?? '')
    + (currentExample.cMain ? heredoc('main.c', currentExample.cMain) + build + '\n'
      : `echo "Wrote ${n}.h and ${libFile} into $(pwd). Write main.c with #include \\"${n}.h\\" and run: ${build}"\n`);
  return {
    zipName: `${n}.zip`,
    entries,
    single: null,
    shell,
    zipHelp: `Saved <b>${esc(n)}.zip</b> with <code>${esc(n)}.h</code>, <code>${esc(libFile)}</code>${currentExample.cMain ? ', <code>main.c</code>' : ''} and <code>build.sh</code>. Unpack it and build the C program:`
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
      showSheet(`Saved <b>${esc(name)}</b> (${fmtB((bu.single.data as Uint8Array).length)}, x64 PE, not signed). Downloads carry the “Mark of the Web”: SmartScreen may say “Windows protected your PC” (More info → Run anyway). Or unblock it and start it from PowerShell:`
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
  if (!current) return;
  const bu = bundle(current);
  if (!bu) return;
  const btn = $('copycmd');
  const win = current.platform === 'win';
  const label = copyLabel();
  const done = (ok: boolean) => {
    const what = current!.mode === 'exe'
      ? 'writes the executable into the current directory and runs it'
      : `creates a folder <b>${esc(libName())}</b> with the header and the library${currentExample.cMain ? ', then compiles main.c against it with clang and runs it' : ''}`;
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
// examples & startup
// ---------------------------------------------------------------------------
function fillExamples(): void {
  exampleSel.textContent = '';
  for (const ex of examples()) {
    const o = document.createElement('option');
    o.value = ex.id;
    o.textContent = ex.title;
    exampleSel.appendChild(o);
  }
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
  $('tab-btn-macho').textContent = P.tab;
  $('lib-static').textContent = P.lib.static;
  $('lib-dynamic').textContent = P.lib.dynamic;
  $('dyn-name').textContent = p === 'win' ? 'DLL' : 'Dynamic lib';
  $('copycmd').textContent = copyLabel();
  $('copycmd').title = p === 'win' ? 'Copies a PowerShell command that recreates the files (no download, no Mark of the Web)' : 'Copies a shell command that recreates and runs the executable';
  $('sheet').hidden = true;
  fillExamples();
}

function loadExample(id: string): void {
  currentExample = examples().find((e) => e.id === id) ?? examples()[0];
  exampleSel.value = currentExample.id;
  const edited = store.get(key('src:' + currentExample.id));
  src.value = edited ?? currentExample.src;
  $('saved').textContent = edited ? 'edited · saved in this browser' : '';
  $('filename').textContent = `${currentExample.id}.hla`;
  store.set(key('example'), currentExample.id);
  const savedMode = store.get(key('mode:' + currentExample.id)) as Mode | null;
  mode = savedMode ?? currentExample.mode ?? 'exe';
  ($<HTMLInputElement>(`mode-${mode}`)).checked = true;
  src.scrollTop = 0;
  selectedRow = -1;
  setStage('run', '', '—', '');
  $('console').textContent = '';
  runStatus(`<span>Press Run to execute the program in the built-in ${PLATFORMS[platform].emulator}.</span>`);
  rebuild();
}
exampleSel.addEventListener('change', () => {
  loadExample(exampleSel.value);
  if (mode === 'exe') run(); else showTab('header');
});

// hosted artifact viewer: plain downloads are blocked, files go through the `downloads` capability (.zip)
if (__ARTIFACT__) {
  const dl = $<HTMLButtonElement>('download');
  dl.hidden = true;
  zipBtn.hidden = true;
  dl.textContent = 'Download .zip';
  const w = window as unknown as { claude?: { use(n: string): Promise<{ save(r: { filename: string; data: Uint8Array }): Promise<unknown> } | null> } };
  w.claude?.use('downloads').then((downloads) => {
    if (!downloads) return;
    dl.hidden = false;
    dl.addEventListener('click', (e) => {
      e.stopImmediatePropagation();
      if (!current) return;
      const bu = bundle(current);
      if (!bu) return;
      downloads.save({ filename: bu.zipName, data: zipFiles(bu.entries) }).then(() => showSheet(bu.zipHelp), () => { /* declined */ });
    }, { capture: true });
  }, () => {});
}

for (const p of ['mac', 'win'] as Platform[]) {
  $(`plat-${p}`).addEventListener('change', () => {
    if (worker) { worker.terminate(); worker = null; }
    setPlatform(p);
    loadExample(store.get(key('example')) ?? examples()[0].id);
    if (mode === 'exe') run(); else showTab('header');
  });
}

setPlatform(platform);
loadExample(store.get(key('example')) ?? examples()[0].id);
showTab(store.get('tab') ?? 'run');
if (mode === 'exe') run();

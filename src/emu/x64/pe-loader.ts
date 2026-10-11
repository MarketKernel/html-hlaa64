// Loads a Windows x64 PE executable into emulator memory, resolves its imports to
// host implementations of msvcrt.dll / kernel32.dll functions, and runs it.
import { X64, EmuError, ExitSignal, Memory } from './cpu.ts';
import { M64, bitsToF64 } from '../cpu.ts';
import { formatPrintf } from '../printf.ts';
import { FileTable, type EmuFiles } from '../files.ts';

export interface PeRunOptions {
  stdin?: string;
  limit?: number;
  onOutput?: (text: string, stream: 1 | 2) => void;
  /** load the image at another base to exercise base relocations */
  base?: number;
  /** DLL images the program (or another DLL) imports from, by file name: { "mathlib.dll": bytes } */
  dlls?: Record<string, Uint8Array>;
  /** command line arguments after the program name (argv[1..]) */
  args?: string[];
  /** where fopen finds and writes files; without it fopen fails (returns NULL) */
  files?: EmuFiles;
}

export interface PeRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  steps: number;
  error: string | null;
}

const THUNKS = 0x7ff700000000;
const STACK_TOP = 0x7ff600000000;
const STACK_SIZE = 8 << 20;
const HEAP = 0x7ff500000000;
const HEAP_SIZE = 64 << 20;
const IMAGE_SCN_MEM_WRITE = 0x80000000;

interface Image {
  name: string;
  base: number;
  entryRva: number;
  image: Uint8Array;
  idv: DataView;
  sects: { name: string; rva: number; vsize: number; writable: boolean }[];
  dir: (i: number) => { rva: number; size: number };
  isDll: boolean;
  optOff: number;           // offset of the optional header in the image
}

/** parse a PE32+ file and lay it out in memory at `base` (or its preferred base), applying base relocations */
function loadImage(name: string, bytes: Uint8Array, wantBase?: number): Image {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint16(0, true) !== 0x5a4d) throw new Error(`${name}: not a PE file (no MZ header)`);
  const pe = dv.getUint32(0x3c, true);
  if (dv.getUint32(pe, true) !== 0x4550) throw new Error(`${name}: not a PE file (no PE signature)`);
  if (dv.getUint16(pe + 4, true) !== 0x8664) throw new Error(`${name}: not an x86-64 image`);
  const nsect = dv.getUint16(pe + 6, true);
  const isDll = (dv.getUint16(pe + 22, true) & 0x2000) !== 0;
  const optSize = dv.getUint16(pe + 20, true);
  const opt = pe + 24;
  if (dv.getUint16(opt, true) !== 0x20b) throw new Error(`${name}: not a PE32+ image`);
  const entryRva = dv.getUint32(opt + 16, true);
  const prefBase = Number(dv.getBigUint64(opt + 24, true));
  const sizeOfImage = dv.getUint32(opt + 56, true);
  const sizeOfHeaders = dv.getUint32(opt + 60, true);
  const odir = (i: number) => ({ rva: dv.getUint32(opt + 112 + i * 8, true), size: dv.getUint32(opt + 116 + i * 8, true) });
  const base = wantBase ?? prefBase;

  const image = new Uint8Array(sizeOfImage);
  image.set(bytes.subarray(0, Math.min(sizeOfHeaders, bytes.length)));
  const sects: Image['sects'] = [];
  for (let i = 0; i < nsect; i++) {
    const o = opt + optSize + i * 40;
    const sname = new TextDecoder().decode(bytes.subarray(o, o + 8)).replace(/\0.*$/s, '');
    const vsize = dv.getUint32(o + 8, true), rva = dv.getUint32(o + 12, true);
    const rawSize = dv.getUint32(o + 16, true), rawPtr = dv.getUint32(o + 20, true);
    const ch = dv.getUint32(o + 36, true);
    if (rawSize) image.set(bytes.subarray(rawPtr, rawPtr + Math.min(rawSize, vsize || rawSize)), rva);
    sects.push({ name: sname, rva, vsize: Math.max(vsize, rawSize), writable: (ch & IMAGE_SCN_MEM_WRITE) !== 0 });
  }
  const idv = new DataView(image.buffer);

  // base relocations (only needed when loading somewhere else)
  const delta = BigInt(base - prefBase);
  if (delta) {
    const rd = odir(5);
    let p = rd.rva;
    while (p < rd.rva + rd.size) {
      const page = idv.getUint32(p, true), blockSize = idv.getUint32(p + 4, true);
      if (!blockSize) break;
      for (let q = p + 8; q < p + blockSize; q += 2) {
        const ent = idv.getUint16(q, true);
        const type = ent >> 12, off = ent & 0xfff;
        if (type === 10) idv.setBigUint64(page + off, (idv.getBigUint64(page + off, true) + delta) & M64, true);
        else if (type !== 0) throw new Error(`${name}: unsupported base relocation type ${type}`);
      }
      p += blockSize;
    }
  }
  return { name, base, entryRva, image, idv, sects, dir: odir, isDll, optOff: opt };
}

/**
 * The stack as Windows lays it out: committed pages at the top, one guard page below them
 * (touching it commits it and moves the guard down), then the uncommitted rest of the
 * reserve. Touching the reserve past the guard page is an access violation — what happens
 * to a frame over 4 KB that is not probed page by page.
 */
function mapStack(mem: Memory, img: Image): void {
  const reserve = Math.max(0x10000, Math.min(STACK_SIZE, Number(img.idv.getBigUint64(img.optOff + 72, true)) || 0x100000));
  const commit = Math.max(0x1000, Math.ceil(Number(img.idv.getBigUint64(img.optOff + 80, true)) / 0x1000) * 0x1000);
  const full = new Uint8Array(reserve);
  const low = STACK_TOP - reserve;
  const committed = mem.map('stack', STACK_TOP - commit, commit, true);
  const guard = mem.map('stack guard page', 0, 0x1000, true);
  const rest = mem.map('stack (reserved)', low, 0, true);
  const place = (top: number) => {
    // committed: [top, STACK_TOP), guard: [top - 4K, top), reserved: [low, top - 4K)
    committed.base = top; committed.size = STACK_TOP - top;
    committed.data = full.subarray(top - low); committed.dv = new DataView(full.buffer, top - low);
    guard.base = top - 0x1000; guard.size = top - 0x1000 >= low ? 0x1000 : 0;
    rest.base = low; rest.size = Math.max(0, top - 0x1000 - low);
  };
  place(STACK_TOP - commit);
  guard.onTouch = () => {
    if (guard.base < low) throw new EmuError('stack overflow (1 MB reserve exhausted)', -1);
    place(guard.base);
    mem.last = null;
  };
  rest.onTouch = () => {
    throw new EmuError(`access violation in the uncommitted stack at 0x${rest.base.toString(16)}+: the guard page was skipped `
      + '(a frame over 4 KB must touch every page in order, like __chkstk)', -1);
  };
}

/** exported functions/data of a DLL image: name -> address */
function exportsOf(img: Image): Map<string, number> {
  const out = new Map<string, number>();
  const ed = img.dir(0);
  if (!ed.rva) return out;
  const { idv, image } = img;
  const n = idv.getUint32(ed.rva + 24, true);
  const funcs = idv.getUint32(ed.rva + 28, true), names = idv.getUint32(ed.rva + 32, true), ords = idv.getUint32(ed.rva + 36, true);
  for (let i = 0; i < n; i++) {
    const nr = idv.getUint32(names + 4 * i, true);
    const nm = new TextDecoder().decode(image.subarray(nr, image.indexOf(0, nr)));
    const rva = idv.getUint32(funcs + 4 * idv.getUint16(ords + 2 * i, true), true);
    if (rva >= ed.rva && rva < ed.rva + ed.size) continue;     // forwarder: not supported
    out.set(nm, img.base + rva);
  }
  return out;
}

export function runPE(bytes: Uint8Array, opts: PeRunOptions = {}): PeRunResult {
  const main = loadImage('program', bytes, opts.base);
  const base = main.base;
  const mem = new Memory();
  // ---------------------------------------------------------------- host side
  const out: number[] = [], err: number[] = [];
  const dec1 = new TextDecoder(), dec2 = new TextDecoder();
  const emit = (stream: 1 | 2, b: ArrayLike<number>) => {
    const arr = stream === 1 ? out : err;
    for (let i = 0; i < b.length; i++) arr.push(b[i]);
    if (opts.onOutput) {
      const t = (stream === 1 ? dec1 : dec2).decode(new Uint8Array(Array.from(b)), { stream: true });
      if (t) opts.onOutput(t, stream);
    }
  };
  let heapTop = HEAP + 16;
  const sizes = new Map<number, number>();
  const malloc = (n: number): number => {
    const size = Math.max(16, Math.ceil(n / 16) * 16);
    if (heapTop + size > HEAP + HEAP_SIZE) return 0;
    const p = heapTop;
    heapTop += size + 16;
    sizes.set(p, n);
    return p;
  };

  // the CPU and memory map are created after imports are known (thunks need addresses)
  const cpu = new X64(mem);
  cpu.limit = opts.limit ?? 200_000_000;
  let thunkNext = THUNKS;
  const JUNK = 0xbad0bad0bad0bad0n;
  let fpResult = false;
  const INT_RESULT = new Set(['puts', 'putchar', 'printf', 'sprintf', 'snprintf', '_snprintf', 'strcmp', 'strncmp', 'memcmp', 'atoi',
    'abs', 'rand', 'toupper', 'tolower', 'isdigit', 'isalpha', 'isspace', 'fflush', 'getchar', 'WriteFile', 'GetStdHandle_',
    'fclose', 'fseek', 'ftell', 'feof']);
  const thunkFor = (name: string, fn: (c: X64) => void, raw = false): number => {
    const a = thunkNext;
    thunkNext += 16;
    cpu.thunks.set(a, raw ? fn : (c) => {
      fpResult = false;
      fn(c);
      // Win64 volatile registers: rcx, rdx, r8-r11, xmm0-xmm5 (rax holds the result)
      for (const r of [1, 2, 8, 9, 10, 11]) c.r[r] = JUNK + BigInt(r);
      for (let x = fpResult ? 1 : 0; x < 6; x++) { c.xlo[x] = 0x7ff8dead00000000n + BigInt(x); c.xhi[x] = 0n; }
      if (INT_RESULT.has(name)) c.r[0] = (c.r[0] & 0xffffffffn) | 0xbad0000000000000n;
    });
    return a;
  };
  const RETURN = thunkFor('<return>', () => { throw new EmuError('internal return thunk executed', RETURN); }, true);
  const EXIT = thunkFor('<exit>', (c) => { throw new ExitSignal(Number(BigInt.asIntN(32, c.r[0] & 0xffffffffn))); }, true);

  const arg = (c: X64, i: number): bigint => (i < 4 ? c.r[[1, 2, 8, 9][i]] : mem.u64(Number(c.rsp) + 8 + 8 * i));
  const ptr = (c: X64, i: number) => Number(arg(c, i));
  const int = (c: X64, i: number) => Number(BigInt.asIntN(32, arg(c, i) & 0xffffffffn));
  const u64 = (c: X64, i: number) => arg(c, i);
  const ret = (c: X64, v: bigint | number) => { c.r[0] = BigInt.asUintN(64, BigInt(v)); };
  const retD = (c: X64, v: number) => { c.setd(0, v); c.xhi[0] = 0n; fpResult = true; };
  const dbl = (c: X64, i: number) => c.d(i);
  const varargs = (c: X64, from: number) => { let i = from; return () => arg(c, i++); };
  const cstr = (p: number) => mem.cstring(p);
  const STDOUT = 0x1001n, STDERR = 0x1002n, STDIN = 0x1000n;
  let seed = 1;
  const files = new FileTable(opts.files, HEAP + HEAP_SIZE + 0x10000);
  const str = (p: number) => new TextDecoder().decode(cstr(p));

  const msvcrt: Record<string, (c: X64) => void> = {
    puts: (c) => { emit(1, cstr(ptr(c, 0))); emit(1, [10]); ret(c, 1); },
    putchar: (c) => { emit(1, [int(c, 0) & 0xff]); ret(c, int(c, 0) & 0xff); },
    printf: (c) => { const b = formatPrintf(mem, ptr(c, 0), varargs(c, 1), { llp64: true }); emit(1, b); ret(c, b.length); },
    sprintf: (c) => { const b = formatPrintf(mem, ptr(c, 1), varargs(c, 2), { llp64: true }); mem.setBytes(ptr(c, 0), new Uint8Array([...b, 0])); ret(c, b.length); },
    snprintf: (c) => {
      const b = formatPrintf(mem, ptr(c, 2), varargs(c, 3), { llp64: true });
      const n = Number(u64(c, 1));
      if (n > 0) mem.setBytes(ptr(c, 0), new Uint8Array([...b.slice(0, n - 1), 0]));
      ret(c, b.length);
    },
    fflush: (c) => ret(c, 0),
    exit: (c) => { throw new ExitSignal(int(c, 0)); },
    // no environment and no command processor in the emulator
    getenv: (c) => ret(c, 0),
    system: (c) => ret(c, -1),
    // files (src/emu/files.ts); Windows: long is 32 bits (fseek's offset, ftell's result)
    fopen: (c) => ret(c, files.fopen(str(ptr(c, 0)), str(ptr(c, 1)))),
    fclose: (c) => ret(c, files.fclose(ptr(c, 0))),
    fread: (c) => {
      const size = Number(u64(c, 1)), got = files.fread(ptr(c, 3), size * Number(u64(c, 2))) ?? new Uint8Array(0);
      mem.setBytes(ptr(c, 0), got);
      ret(c, size ? Math.floor(got.length / size) : 0);
    },
    fwrite: (c) => {
      const size = Number(u64(c, 1));
      ret(c, size ? Math.floor(files.fwrite(ptr(c, 3), mem.bytes(ptr(c, 0), size * Number(u64(c, 2)))) / size) : 0);
    },
    fseek: (c) => ret(c, files.fseek(ptr(c, 0), int(c, 1), int(c, 2))),
    ftell: (c) => ret(c, files.ftell(ptr(c, 0))),
    feof: (c) => ret(c, files.feof(ptr(c, 0)) ? 1 : 0),
    // __getmainargs(int *argc, char ***argv, char ***env, int wildcard, _startupinfo *): what hla_start passes to main
    __getmainargs: (c) => {
      const p = argvBlock();
      mem.set32(ptr(c, 0), p.argc);
      mem.set64(ptr(c, 1), BigInt(p.argv));
      mem.set64(ptr(c, 2), BigInt(p.env));
      ret(c, 0);
    },
    _exit: (c) => { throw new ExitSignal(int(c, 0)); },
    abort: () => { throw new ExitSignal(3); },
    strlen: (c) => ret(c, cstr(ptr(c, 0)).length),
    strcmp: (c) => ret(c, cmp(cstr(ptr(c, 0)), cstr(ptr(c, 1)), Infinity)),
    strncmp: (c) => ret(c, cmp(cstr(ptr(c, 0)), cstr(ptr(c, 1)), Number(u64(c, 2)))),
    strcpy: (c) => { mem.setBytes(ptr(c, 0), new Uint8Array([...cstr(ptr(c, 1)), 0])); ret(c, u64(c, 0)); },
    strcat: (c) => { const d = ptr(c, 0); mem.setBytes(d + cstr(d).length, new Uint8Array([...cstr(ptr(c, 1)), 0])); ret(c, u64(c, 0)); },
    memcpy: (c) => { mem.setBytes(ptr(c, 0), mem.bytes(ptr(c, 1), Number(u64(c, 2)))); ret(c, u64(c, 0)); },
    memmove: (c) => { mem.setBytes(ptr(c, 0), mem.bytes(ptr(c, 1), Number(u64(c, 2)))); ret(c, u64(c, 0)); },
    memset: (c) => { mem.setBytes(ptr(c, 0), new Uint8Array(Number(u64(c, 2))).fill(int(c, 1) & 0xff)); ret(c, u64(c, 0)); },
    memcmp: (c) => ret(c, cmp(mem.bytes(ptr(c, 0), Number(u64(c, 2))), mem.bytes(ptr(c, 1), Number(u64(c, 2))), Infinity, true)),
    malloc: (c) => ret(c, malloc(Number(u64(c, 0)))),
    calloc: (c) => ret(c, malloc(Number(u64(c, 0)) * Number(u64(c, 1)))),
    realloc: (c) => { const old = ptr(c, 0), n = Number(u64(c, 1)); const p = malloc(n); if (old && p) mem.setBytes(p, mem.bytes(old, Math.min(n, sizes.get(old) ?? 0))); ret(c, p); },
    free: () => {},
    atoi: (c) => ret(c, BigInt.asUintN(32, BigInt(parseInt(new TextDecoder().decode(cstr(ptr(c, 0))), 10) || 0))),
    abs: (c) => ret(c, BigInt.asUintN(32, BigInt(Math.abs(int(c, 0))))),
    _abs64: (c) => { const v = BigInt.asIntN(64, u64(c, 0)); ret(c, v < 0n ? -v : v); },
    rand: (c) => { seed = (seed * 214013 + 2531011) >>> 0; ret(c, (seed >>> 16) & 0x7fff); },
    srand: (c) => { seed = int(c, 0) >>> 0; },
    toupper: (c) => { const v = int(c, 0); ret(c, v >= 97 && v <= 122 ? v - 32 : v); },
    tolower: (c) => { const v = int(c, 0); ret(c, v >= 65 && v <= 90 ? v + 32 : v); },
    isdigit: (c) => { const v = int(c, 0); ret(c, v >= 48 && v <= 57 ? 1 : 0); },
    isalpha: (c) => { const v = int(c, 0) | 32; ret(c, v >= 97 && v <= 122 ? 1 : 0); },
    isspace: (c) => { const v = int(c, 0); ret(c, v === 32 || (v >= 9 && v <= 13) ? 1 : 0); },
    qsort: (c) => {
      const b = ptr(c, 0), n = Number(u64(c, 1)), size = Number(u64(c, 2)), f = ptr(c, 3);
      const items: Uint8Array[] = [];
      for (let i = 0; i < n; i++) items.push(mem.bytes(b + i * size, size));
      const ta = malloc(size), tb = malloc(size);
      const sorted = mergeSort(items, (x, y) => {
        mem.setBytes(ta, x); mem.setBytes(tb, y);
        return Number(BigInt.asIntN(32, cpu.call(f, [BigInt(ta), BigInt(tb)], RETURN) & 0xffffffffn));
      });
      sorted.forEach((it, i) => mem.setBytes(b + i * size, it));
    },
    sqrt: (c) => retD(c, Math.sqrt(dbl(c, 0))), sin: (c) => retD(c, Math.sin(dbl(c, 0))), cos: (c) => retD(c, Math.cos(dbl(c, 0))),
    tan: (c) => retD(c, Math.tan(dbl(c, 0))), atan: (c) => retD(c, Math.atan(dbl(c, 0))), atan2: (c) => retD(c, Math.atan2(dbl(c, 0), dbl(c, 1))),
    exp: (c) => retD(c, Math.exp(dbl(c, 0))), log: (c) => retD(c, Math.log(dbl(c, 0))), log10: (c) => retD(c, Math.log10(dbl(c, 0))),
    pow: (c) => retD(c, Math.pow(dbl(c, 0), dbl(c, 1))), floor: (c) => retD(c, Math.floor(dbl(c, 0))), ceil: (c) => retD(c, Math.ceil(dbl(c, 0))),
    fabs: (c) => retD(c, Math.abs(dbl(c, 0))), fmod: (c) => retD(c, dbl(c, 0) % dbl(c, 1)),
    getchar: (c) => ret(c, -1),
  };
  const kernel32: Record<string, (c: X64) => void> = {
    ExitProcess: (c) => { throw new ExitSignal(int(c, 0)); },
    GetStdHandle: (c) => { const n = int(c, 0); ret(c, n === -11 ? STDOUT : n === -12 ? STDERR : STDIN); },
    WriteFile: (c) => {
      const h = u64(c, 0), p = ptr(c, 1), n = Number(u64(c, 2) & 0xffffffffn), written = ptr(c, 3);
      emit(h === STDERR ? 2 : 1, mem.bytes(p, n));
      if (written) mem.set32(written, n);
      ret(c, 1);
    },
    Sleep: () => {},
    GetCommandLineA: (c) => ret(c, cmdline()),
    GetTickCount: (c) => ret(c, Math.floor(performance.now())),
  };
  const libs: Record<string, Record<string, (c: X64) => void>> = { 'msvcrt.dll': msvcrt, 'kernel32.dll': kernel32 };

  // ---------------------------------------------------------------- DLLs and imports
  const images: Image[] = [main];
  const loaded = new Map<string, { img: Image; exports: Map<string, number> }>();
  let nextDllBase = 0x7ffa00000000;
  const loadDll = (dll: string): { img: Image; exports: Map<string, number> } | null => {
    if (loaded.has(dll)) return loaded.get(dll)!;
    const key = Object.keys(opts.dlls ?? {}).find((k) => k.toLowerCase() === dll);
    if (!key) return null;
    const img = loadImage(dll, opts.dlls![key], nextDllBase);
    nextDllBase += Math.ceil(img.image.length / 0x10000 + 1) * 0x10000;
    const rec = { img, exports: exportsOf(img) };
    loaded.set(dll, rec);
    images.push(img);
    bind(img);
    return rec;
  };
  const resolved = new Map<string, number>();
  const bind = (img: Image) => {
    const { idv, image } = img;
    const imp = img.dir(1);
    if (!imp.rva) return;
    for (let d = imp.rva; ; d += 20) {
      const ilt = idv.getUint32(d, true), nameRva = idv.getUint32(d + 12, true), iat = idv.getUint32(d + 16, true);
      if (!nameRva && !iat) break;
      const dll = new TextDecoder().decode(image.subarray(nameRva, image.indexOf(0, nameRva))).toLowerCase();
      const lib = libs[dll];
      const guest = lib ? null : loadDll(dll);
      if (!lib && !guest) throw new Error(`${img.name} needs ${dll}, which is neither built into the emulator nor given`);
      for (let k = 0; ; k++) {
        const e = idv.getBigUint64((ilt || iat) + 8 * k, true);
        if (!e) break;
        if (e >> 63n) throw new Error(`${dll}: import by ordinal is not supported`);
        const hn = Number(e & 0x7fffffffn);
        const fname = new TextDecoder().decode(image.subarray(hn + 2, image.indexOf(0, hn + 2)));
        let addr: number;
        if (guest) {
          const a = guest.exports.get(fname);
          if (a === undefined) throw new Error(`${img.name}: ${dll} does not export ${fname}`);
          addr = a;
        } else {
          const key = dll + '!' + fname;
          if (!resolved.has(key)) {
            const f = lib![fname];
            resolved.set(key, thunkFor(fname, f ?? ((c) => { void c; throw new EmuError(`${dll}!${fname} is not available in the emulator`, -1); })));
          }
          addr = resolved.get(key)!;
        }
        idv.setBigUint64(iat + 8 * k, BigInt(addr), true);
      }
    }
  };
  bind(main);

  // map: headers + sections with their protection, stack, heap, thunk page
  for (const img of images) {
    const pre = img === main ? '' : img.name + ':';
    mem.map(pre + 'headers', img.base, Math.max(0x1000, img.sects.length ? img.sects[0].rva : 0x1000), false, img.image);
    for (const s of img.sects) {
      const size = Math.ceil(s.vsize / 0x1000) * 0x1000;
      mem.map(pre + s.name, img.base + s.rva, size, s.writable, img.image.subarray(s.rva, s.rva + size));
    }
  }
  mapStack(mem, main);
  mem.map('heap', HEAP, HEAP_SIZE);
  mem.map('thunks', THUNKS, 0x10000, false);
  // argv[0] is "program"; the strings are put on the heap on first use
  const argvList = ['program', ...(opts.args ?? [])];
  const heapString = (text: string) => { const b = new TextEncoder().encode(text + '\0'); const p = malloc(b.length); mem.setBytes(p, b); return p; };
  let cmdlineAt = 0;
  let argvAt: { argc: number; argv: number; env: number } | null = null;
  const cmdline = () => (cmdlineAt ||= heapString(argvList.map((a) => (/[\s"]/.test(a) || a === '' ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')));
  const argvBlock = () => {
    if (argvAt) return argvAt;
    const ptrs = argvList.map(heapString);
    const argv = malloc(8 * (ptrs.length + 1)), env = malloc(8);
    ptrs.forEach((p, i) => mem.set64(argv + 8 * i, BigInt(p)));
    mem.set64(argv + 8 * ptrs.length, 0n);
    mem.set64(env, 0n);
    return (argvAt = { argc: ptrs.length, argv, env });
  };

  // ---------------------------------------------------------------- start: rsp ≡ 8 (mod 16), return to EXIT
  cpu.rsp = BigInt(STACK_TOP - 4096 - 8);
  mem.set64(Number(cpu.rsp), BigInt(EXIT));
  cpu.rip = base + main.entryRva;
  let exitCode: number | null = null, error: string | null = null;
  try {
    // DllMain(hinst, DLL_PROCESS_ATTACH, 0) of every loaded DLL with an entry point, last loaded first
    for (const img of images.slice(1).reverse()) {
      if (!img.entryRva) continue;
      const ok = cpu.call(img.base + img.entryRva, [BigInt(img.base), 1n, 0n], RETURN);
      if (!(ok & 0xffffffffn)) throw new EmuError(`${img.name}: DllMain failed`, -1);
    }
    cpu.run();
  } catch (e) {
    if (e instanceof ExitSignal) exitCode = e.code;
    else if (e instanceof EmuError) error = e.message + (e.pc >= 0 ? '' : ` (rip 0x${cpu.rip.toString(16)})`);
    else error = (e as Error).message ?? String(e);
  }
  files.closeAll();
  const t1 = dec1.decode(), t2 = dec2.decode();
  if (opts.onOutput) { if (t1) opts.onOutput(t1, 1); if (t2) opts.onOutput(t2, 2); }
  return {
    stdout: new TextDecoder().decode(new Uint8Array(out)),
    stderr: new TextDecoder().decode(new Uint8Array(err)),
    exitCode, steps: cpu.steps, error,
  };
}

function cmp(a: Uint8Array, b: Uint8Array, n: number, raw = false): number {
  const len = Math.min(n, Math.max(a.length, b.length) + (raw ? 0 : 1));
  for (let i = 0; i < len; i++) { const x = a[i] ?? 0, y = b[i] ?? 0; if (x !== y) return x - y; }
  return 0;
}

function mergeSort<T>(a: T[], f: (x: T, y: T) => number): T[] {
  if (a.length < 2) return a;
  const m = a.length >> 1;
  const l = mergeSort(a.slice(0, m), f), r = mergeSort(a.slice(m), f);
  const out: T[] = [];
  let i = 0, j = 0;
  while (i < l.length && j < r.length) out.push(f(l[i], r[j]) <= 0 ? l[i++] : r[j++]);
  return out.concat(l.slice(i), r.slice(j));
}

export { bitsToF64 };

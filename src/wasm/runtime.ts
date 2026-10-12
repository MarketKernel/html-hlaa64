// The system of wasm32 programs: a JavaScript runtime that gives a module built by HLA64 its C library
// (printf, malloc, fopen … — the list is src/wasm/libc.ts) as imports, starts it at hla_start(argc, argv)
// and collects what it prints. The same code runs the program in Node (CLI, tests), in the workbench's
// worker, and in the page that comes with a downloaded program.
import { formatPrintf } from '../emu/printf.ts';
import { FileTable, type EmuFiles } from '../emu/files.ts';
import { LIBC, FLOAT_RESULT } from './libc.ts';

export interface WasmRunOptions {
  /** command line arguments after the program name (argv[1..]) */
  args?: string[];
  /** argv[0] */
  name?: string;
  /** where fopen finds and writes files; without it fopen fails (returns NULL) */
  files?: EmuFiles;
  /** what getchar / read / fread(stdin) get */
  stdin?: string;
  onOutput?: (text: string, stream: 1 | 2) => void;
}

export interface WasmRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** WebAssembly runs natively: no instruction count */
  steps: number;
  error: string | null;
}

class ExitSignal {
  code: number;
  constructor(code: number) { this.code = code; }
}

type Value = bigint | number;

/** the arguments of an import: i64 arrive as BigInt, f64 as number; `rest` reads the variadic ones */
class Args {
  private raw: Value[];
  private va: number | null;
  private dv: () => DataView;
  constructor(raw: Value[], va: number | null, dv: () => DataView) { this.raw = raw; this.va = va; this.dv = dv; }
  i(k: number): bigint { const v = this.raw[k]; return typeof v === 'bigint' ? v : typeof v === 'number' ? BigInt(Math.trunc(v)) : 0n; }
  /** a pointer or a size */
  n(k: number): number { return Number(BigInt.asIntN(64, this.i(k))); }
  /** a C int */
  int(k: number): number { return Number(BigInt.asIntN(32, this.i(k))); }
  d(k: number): number { const v = this.raw[k]; return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(BigInt.asIntN(64, v)) : 0; }
  /** the variadic arguments from position `from` on, as raw 64-bit slots (a double as its bits) */
  rest(from: number): () => bigint {
    let j = 0;
    if (this.va !== null) { const at = this.va; return () => this.dv().getBigUint64(at + 8 * j++, true); }
    return () => {
      const v = this.raw[from + j++];
      if (typeof v === 'bigint') return BigInt.asUintN(64, v);
      if (typeof v === 'number') { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, v, true); return d.getBigUint64(0, true); }
      return 0n;
    };
  }
}

type Impl = (a: Args) => Value | void;

function makeSystem(opts: WasmRunOptions) {
  let inst: WebAssembly.Instance | null = null;
  const memory = () => inst!.exports.memory as WebAssembly.Memory;
  const u8 = () => new Uint8Array(memory().buffer);
  const dv = () => new DataView(memory().buffer);
  const cstring = (p: number): Uint8Array => { const m = u8(); let e = p; while (e < m.length && m[e]) e++; return m.slice(p, e); };
  const text = (p: number) => new TextDecoder().decode(cstring(p));
  const bytes = (p: number, n: number) => u8().slice(p, p + n);
  const setBytes = (p: number, b: ArrayLike<number>) => u8().set(b, p);
  const mem = { cstring };

  // output
  const outText = ['', ''];
  const decoders = [new TextDecoder(), new TextDecoder()];
  const emit = (stream: 1 | 2, b: ArrayLike<number>) => {
    const t = decoders[stream - 1].decode(Uint8Array.from(b), { stream: true });
    outText[stream - 1] += t;
    if (t && opts.onOutput) opts.onOutput(t, stream);
  };
  const stdin = new TextEncoder().encode(opts.stdin ?? '');
  let stdinPos = 0;

  // heap: above the stack (__heap_base), grows the memory when it needs to; freed blocks are reused by size
  let heapTop = 0;
  const sizes = new Map<number, number>();
  const freed = new Map<number, number[]>();
  const malloc = (n: number): number => {
    const size = Math.max(16, Math.ceil(n / 16) * 16);
    const again = freed.get(size)?.pop();
    if (again) { sizes.set(again, size); u8().fill(0, again, again + size); return again; }
    const p = heapTop;
    if (p + size > memory().buffer.byteLength) {
      const pages = Math.ceil((p + size - memory().buffer.byteLength) / 65536);
      try { memory().grow(pages); } catch { return 0; }
    }
    heapTop += size;
    sizes.set(p, size);
    return p;
  };
  const free = (p: number) => {
    const size = sizes.get(p);
    if (!size) return;
    sizes.delete(p);
    let list = freed.get(size);
    if (!list) freed.set(size, (list = []));
    list.push(p);
  };

  const files = new FileTable(opts.files, 0x40000000);
  /** a FILE*: a file of fopen, or stdout/stderr (any other value) */
  const put = (f: number, b: ArrayLike<number>) => { if (files.has(f)) files.fwrite(f, Uint8Array.from(b)); else emit(f === 2 ? 2 : 1, b); };
  const cmp = (a: Uint8Array, b: Uint8Array, n: number, unsigned = false) => {
    const len = Math.min(n, Math.max(a.length, b.length) + (unsigned ? 0 : 1));
    for (let i = 0; i < len; i++) { const x = a[i] ?? 0, y = b[i] ?? 0; if (x !== y) return x - y; }
    return 0;
  };
  let seed = 1;

  const lib: Record<string, Impl> = {
    puts: (a) => { emit(1, cstring(a.n(0))); emit(1, [10]); return 1; },
    putchar: (a) => { emit(1, [a.int(0) & 0xff]); return a.int(0) & 0xff; },
    putc: (a) => { put(a.n(1), [a.int(0) & 0xff]); return a.int(0) & 0xff; },
    fputc: (a) => { put(a.n(1), [a.int(0) & 0xff]); return a.int(0) & 0xff; },
    fputs: (a) => { put(a.n(1), cstring(a.n(0))); return 1; },
    printf: (a) => { const b = formatPrintf(mem, a.n(0), a.rest(1)); emit(1, b); return b.length; },
    fprintf: (a) => { const b = formatPrintf(mem, a.n(1), a.rest(2)); put(a.n(0), b); return b.length; },
    dprintf: (a) => { const b = formatPrintf(mem, a.n(1), a.rest(2)); emit(a.int(0) === 2 ? 2 : 1, b); return b.length; },
    sprintf: (a) => { const b = formatPrintf(mem, a.n(1), a.rest(2)); setBytes(a.n(0), [...b, 0]); return b.length; },
    snprintf: (a) => {
      const b = formatPrintf(mem, a.n(2), a.rest(3));
      const n = a.n(1);
      if (n > 0) setBytes(a.n(0), [...b.slice(0, n - 1), 0]);
      return b.length;
    },
    fflush: () => 0,
    // files (src/emu/files.ts): fopen(path, mode), fread(buf, size, count, f), fseek(f, off, whence) …
    fopen: (a) => files.fopen(text(a.n(0)), text(a.n(1))),
    fclose: (a) => (files.has(a.n(0)) ? files.fclose(a.n(0)) : 0),
    fread: (a) => {
      const size = a.n(1), n = size * a.n(2), f = a.n(3);
      let got: Uint8Array;
      if (files.has(f)) got = files.fread(f, n) ?? new Uint8Array(0);
      else { got = stdin.subarray(stdinPos, stdinPos + n); stdinPos += got.length; }
      setBytes(a.n(0), got);
      return size ? Math.floor(got.length / size) : 0;
    },
    fwrite: (a) => {
      const size = a.n(1), n = size * a.n(2), f = a.n(3);
      if (files.has(f)) return size ? Math.floor(files.fwrite(f, bytes(a.n(0), n)) / size) : 0;
      emit(f === 2 ? 2 : 1, bytes(a.n(0), n));
      return a.n(2);
    },
    fseek: (a) => files.fseek(a.n(0), a.n(1), a.int(2)),
    ftell: (a) => files.ftell(a.n(0)),
    feof: (a) => (files.feof(a.n(0)) ? 1 : 0),
    write: (a) => { const n = a.n(2); emit(a.int(0) === 2 ? 2 : 1, bytes(a.n(1), n)); return n; },
    read: (a) => {
      const n = Math.min(a.n(2), stdin.length - stdinPos);
      setBytes(a.n(1), stdin.subarray(stdinPos, stdinPos + n));
      stdinPos += n;
      return n;
    },
    getchar: () => (stdinPos < stdin.length ? stdin[stdinPos++] : -1),
    exit: (a) => { throw new ExitSignal(a.int(0)); },
    _exit: (a) => { throw new ExitSignal(a.int(0)); },
    abort: () => { throw new ExitSignal(134); },
    getenv: () => 0,
    system: () => -1,       // no shell
    time: (a) => { const t = Math.floor(Date.now() / 1000); if (a.n(0)) dv().setBigInt64(a.n(0), BigInt(t), true); return t; },
    clock: () => Math.floor(performance.now() * 1000),
    sleep: () => 0,
    usleep: () => 0,
    strlen: (a) => cstring(a.n(0)).length,
    strcmp: (a) => cmp(cstring(a.n(0)), cstring(a.n(1)), Infinity),
    strncmp: (a) => cmp(cstring(a.n(0)), cstring(a.n(1)), a.n(2)),
    strcpy: (a) => { setBytes(a.n(0), [...cstring(a.n(1)), 0]); return a.i(0); },
    strncpy: (a) => { const b = new Uint8Array(a.n(2)); b.set(cstring(a.n(1)).subarray(0, a.n(2))); setBytes(a.n(0), b); return a.i(0); },
    strcat: (a) => { const d = a.n(0); setBytes(d + cstring(d).length, [...cstring(a.n(1)), 0]); return a.i(0); },
    strchr: (a) => {
      const p = a.n(0), ch = a.int(1) & 0xff, m = u8();
      for (let i = p; i < m.length; i++) { if (m[i] === ch) return i; if (!m[i]) return 0; }
      return 0;
    },
    memcpy: (a) => { u8().copyWithin(a.n(0), a.n(1), a.n(1) + a.n(2)); return a.i(0); },
    memmove: (a) => { u8().copyWithin(a.n(0), a.n(1), a.n(1) + a.n(2)); return a.i(0); },
    memset: (a) => { u8().fill(a.int(1) & 0xff, a.n(0), a.n(0) + a.n(2)); return a.i(0); },
    bzero: (a) => { u8().fill(0, a.n(0), a.n(0) + a.n(1)); },
    memcmp: (a) => cmp(bytes(a.n(0), a.n(2)), bytes(a.n(1), a.n(2)), Infinity, true),
    malloc: (a) => malloc(a.n(0)),
    calloc: (a) => malloc(a.n(0) * a.n(1)),
    realloc: (a) => {
      const old = a.n(0), n = a.n(1);
      const p = malloc(n);
      if (old && p) { u8().copyWithin(p, old, old + Math.min(n, sizes.get(old) ?? 0)); free(old); }
      return p;
    },
    free: (a) => { free(a.n(0)); },
    atoi: (a) => BigInt.asIntN(32, BigInt(parseInt(text(a.n(0)), 10) || 0)),
    atol: (a) => BigInt(parseInt(text(a.n(0)), 10) || 0),
    strtol: (a) => {
      const s = text(a.n(0));
      const m = /^\s*[-+]?(0x)?[0-9a-z]*/i.exec(s)!;
      if (a.n(1)) dv().setBigInt64(a.n(1), BigInt(a.n(0) + m[0].length), true);
      return BigInt(parseInt(m[0], a.int(2) || 10) || 0);
    },
    atof: (a) => parseFloat(text(a.n(0))) || 0,
    abs: (a) => Math.abs(a.int(0)),
    labs: (a) => { const v = BigInt.asIntN(64, a.i(0)); return v < 0n ? -v : v; },
    rand: () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; },
    srand: (a) => { seed = a.int(0) >>> 0; },
    arc4random: () => Math.floor(Math.random() * 2 ** 32),
    arc4random_uniform: (a) => Math.floor(Math.random() * (a.n(0) >>> 0)),
    toupper: (a) => { const v = a.int(0); return v >= 97 && v <= 122 ? v - 32 : v; },
    tolower: (a) => { const v = a.int(0); return v >= 65 && v <= 90 ? v + 32 : v; },
    isdigit: (a) => { const v = a.int(0); return v >= 48 && v <= 57 ? 1 : 0; },
    isalpha: (a) => { const v = a.int(0) | 32; return v >= 97 && v <= 122 ? 1 : 0; },
    isspace: (a) => { const v = a.int(0); return v === 32 || (v >= 9 && v <= 13) ? 1 : 0; },
    qsort: (a) => {
      // the comparison function is an index into the module's table, called with two pointers
      const base = a.n(0), n = a.n(1), size = a.n(2);
      const f = (inst!.exports.table as WebAssembly.Table | undefined)?.get(a.n(3)) as ((x: bigint, y: bigint) => bigint) | null;
      if (!f) throw new Error('qsort: the comparison function is not a function of the program');
      const items: Uint8Array[] = [];
      for (let i = 0; i < n; i++) items.push(bytes(base + i * size, size));
      const ta = malloc(size), tb = malloc(size);
      const sorted = mergeSort(items, (x, y) => {
        setBytes(ta, x);
        setBytes(tb, y);
        return Number(BigInt.asIntN(32, BigInt(f(BigInt(ta), BigInt(tb)))));
      });
      sorted.forEach((it, i) => setBytes(base + i * size, it));
      free(ta);
      free(tb);
    },
    sqrt: (a) => Math.sqrt(a.d(0)), sin: (a) => Math.sin(a.d(0)), cos: (a) => Math.cos(a.d(0)), tan: (a) => Math.tan(a.d(0)),
    atan: (a) => Math.atan(a.d(0)), atan2: (a) => Math.atan2(a.d(0), a.d(1)), exp: (a) => Math.exp(a.d(0)),
    log: (a) => Math.log(a.d(0)), log10: (a) => Math.log10(a.d(0)), pow: (a) => Math.pow(a.d(0), a.d(1)),
    floor: (a) => Math.floor(a.d(0)), ceil: (a) => Math.ceil(a.d(0)),
    round: (a) => Math.sign(a.d(0)) * Math.round(Math.abs(a.d(0))),
    fabs: (a) => Math.abs(a.d(0)), fmod: (a) => a.d(0) % a.d(1),
  };

  // imports: "env" gets the arguments directly, "va" ends with the address of the variadic ones
  const wrap = (name: string, impl: Impl, va: boolean) => (...raw: Value[]): Value => {
    const vaPtr = va ? (raw.pop() as number) : null;
    const r = impl(new Args(raw, vaPtr, dv));
    if (FLOAT_RESULT.has(name)) return typeof r === 'bigint' ? Number(r) : (r ?? 0);
    return BigInt.asIntN(64, typeof r === 'bigint' ? r : BigInt(Math.trunc(r ?? 0)));
  };
  const env: Record<string, unknown> = {}, va: Record<string, unknown> = {};
  for (const name of LIBC) {
    if (!lib[name]) throw new Error(`internal: the runtime has no ${name}`);
    env[name] = wrap(name, lib[name], false);
    va[name] = wrap(name, lib[name], true);
  }
  const imports: WebAssembly.Imports = {
    env: env as WebAssembly.ModuleImports, va: va as WebAssembly.ModuleImports,
    hla: { stack_overflow: () => { throw new Error('stack overflow: the frames do not fit into the 1 MB stack (too deep recursion?)'); } },
  };

  const finish = (exitCode: number | null, error: string | null): WasmRunResult => {
    files.closeAll();
    for (const s of [1, 2] as const) {
      const t = decoders[s - 1].decode();
      outText[s - 1] += t;
      if (t && opts.onOutput) opts.onOutput(t, s);
    }
    return { stdout: outText[0], stderr: outText[1], exitCode, steps: 0, error };
  };

  const start = (instance: WebAssembly.Instance): WasmRunResult => {
    inst = instance;
    const ex = instance.exports as Record<string, unknown>;
    if (typeof ex.hla_start !== 'function') return finish(null, 'the module has no hla_start: is there a fn main?');
    heapTop = Number((ex.__heap_base as WebAssembly.Global | undefined)?.value ?? memory().buffer.byteLength);
    // argv: the strings and an array of 8-byte pointers on the heap
    const argv = [opts.name ?? 'program', ...(opts.args ?? [])];
    const ptrs = argv.map((s) => { const b = new TextEncoder().encode(s); const p = malloc(b.length + 1); setBytes(p, [...b, 0]); return p; });
    const arr = malloc(8 * (ptrs.length + 1));
    ptrs.forEach((p, i) => dv().setBigUint64(arr + 8 * i, BigInt(p), true));
    try {
      const r = (ex.hla_start as (argc: bigint, argv: bigint) => bigint)(BigInt(argv.length), BigInt(arr));
      return finish(Number(BigInt.asIntN(32, r)), null);
    } catch (e) {
      return failure(e);
    }
  };

  const failure = (e: unknown): WasmRunResult => {
    if (e instanceof ExitSignal) return finish(e.code, null);
    return finish(null, describeError(e));
  };

  return { imports, start, failure };
}

/** a trap or an error with the function and the code offset it happened at (wasm-function[3]:0x1a2) */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  if (e instanceof RangeError && /call stack/i.test(e.message)) return 'stack overflow: too deep recursion';
  let msg = e.message;
  // the first wasm frame: "at main (wasm://…:wasm-function[3]:0x94)" (V8) or "main@wasm://…:wasm-function[3]:0x94" (Firefox)
  const frame = (e.stack ?? '').split('\n').find((l) => /wasm-function\[\d+\]:0x[0-9a-f]+/i.test(l));
  if (e instanceof WebAssembly.RuntimeError && frame) {
    const [, idx, off] = /wasm-function\[(\d+)\]:(0x[0-9a-f]+)/i.exec(frame)!;
    const name = /^\s*at\s+(\S+)\s+\(/.exec(frame)?.[1] ?? /^\s*([^@\s]+)@/.exec(frame)?.[1];
    msg += ` (in ${name && !/^wasm/.test(name) ? name.replace(/^.*\./, '') : `function #${idx}`}, at ${off} of the module)`;
  }
  return msg;
}

/** run a module synchronously (Node, workers; the main thread of a browser allows only small modules) */
export function runWasm(bytes: Uint8Array, opts: WasmRunOptions = {}): WasmRunResult {
  const sys = makeSystem(opts);
  let instance: WebAssembly.Instance;
  try {
    instance = new WebAssembly.Instance(new WebAssembly.Module(bytes as BufferSource), sys.imports);
  } catch (e) {
    return sys.failure(e);
  }
  return sys.start(instance);
}

export async function runWasmAsync(bytes: Uint8Array, opts: WasmRunOptions = {}): Promise<WasmRunResult> {
  const sys = makeSystem(opts);
  let instance: WebAssembly.Instance;
  try {
    instance = (await WebAssembly.instantiate(bytes as BufferSource, sys.imports)).instance;
  } catch (e) {
    return sys.failure(e);
  }
  return sys.start(instance);
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

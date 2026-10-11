// Loads an arm64 Mach-O executable (as produced by the HLA64 linker) into emulator
// memory, binds its imports to host-implemented libSystem functions, and runs it.
import { Cpu, EmuError, ExitSignal, Memory, M64, bitsToF64, f64ToBits } from './cpu.ts';
import { formatPrintf } from './printf.ts';
import { FileTable, type EmuFiles } from './files.ts';

export interface RunOptions {
  stdin?: string;
  limit?: number;
  args?: string[];
  /** where fopen finds and writes files; without it fopen fails (returns NULL) */
  files?: EmuFiles;
  onOutput?: (text: string, stream: 1 | 2) => void;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  steps: number;
  error: string | null;
}

const THUNK_BASE = 0x7f0000000;
const STACK_TOP = 0x170000000;
const STACK_SIZE = 8 << 20;
const HEAP_BASE = 0x500000000;
const HEAP_SIZE = 64 << 20;
const HOSTDATA_BASE = 0x7e0000000;

interface Seg { name: string; vmaddr: number; vmsize: number; fileoff: number; filesize: number; prot: number }

function uleb(b: Uint8Array, p: { i: number }): number {
  let r = 0, s = 1;
  while (true) {
    const x = b[p.i++];
    r += (x & 0x7f) * s;
    s *= 128;
    if (!(x & 0x80)) return r;
  }
}

function sleb(b: Uint8Array, p: { i: number }): number {
  let r = 0, s = 1, x: number;
  do { x = b[p.i++]; r += (x & 0x7f) * s; s *= 128; } while (x & 0x80);
  if (x & 0x40) r -= s;
  return r;
}

export function runMachO(bytes: Uint8Array, opts: RunOptions = {}): RunResult {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0xfeedfacf || dv.getUint32(4, true) !== 0x0100000c) {
    throw new Error('not an arm64 Mach-O executable');
  }
  const ncmds = dv.getUint32(16, true);
  const segs: Seg[] = [];
  let entryOff = -1;
  let bindOff = 0, bindSize = 0, lazyOff = 0, lazySize = 0;
  let off = 32;
  for (let i = 0; i < ncmds; i++) {
    const cmd = dv.getUint32(off, true), size = dv.getUint32(off + 4, true);
    if (cmd === 0x19) {
      const name = new TextDecoder().decode(bytes.subarray(off + 8, off + 24)).replace(/\0.*$/s, '');
      segs.push({
        name,
        vmaddr: Number(dv.getBigUint64(off + 24, true)), vmsize: Number(dv.getBigUint64(off + 32, true)),
        fileoff: Number(dv.getBigUint64(off + 40, true)), filesize: Number(dv.getBigUint64(off + 48, true)),
        prot: dv.getUint32(off + 60, true),
      });
    } else if (cmd === 0x80000028) {
      entryOff = Number(dv.getBigUint64(off + 8, true));
    } else if (cmd === 0x80000022 || cmd === 0x22) {
      bindOff = dv.getUint32(off + 16, true); bindSize = dv.getUint32(off + 20, true);
      lazyOff = dv.getUint32(off + 40, true); lazySize = dv.getUint32(off + 44, true);
    } else if (cmd === 0x80000034) {
      throw new Error('chained fixups are not supported by the emulator (build with the HLA64 linker)');
    }
    off += size;
  }
  if (entryOff < 0) throw new Error('no LC_MAIN entry point');

  const mem = new Memory();
  const text = segs.find((s) => s.name === '__TEXT');
  if (!text) throw new Error('no __TEXT segment');
  for (const s of segs) {
    if (s.prot === 0 || s.name === '__LINKEDIT') continue;
    mem.map(s.name, s.vmaddr, s.vmsize, (s.prot & 2) !== 0, bytes.subarray(s.fileoff, s.fileoff + s.filesize));
  }
  mem.map('stack', STACK_TOP - STACK_SIZE, STACK_SIZE);
  mem.map('heap', HEAP_BASE, HEAP_SIZE);
  const hostData = mem.map('libSystem data', HOSTDATA_BASE, 0x1000);
  const thunkRegion = mem.map('libSystem', THUNK_BASE, 0x10000, false);
  void thunkRegion;

  const cpu = new Cpu(mem);
  cpu.limit = opts.limit ?? 200_000_000;

  // ---------------------------------------------------------------- output
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
  const stdinBytes = new TextEncoder().encode(opts.stdin ?? '');
  let stdinPos = 0;

  // ---------------------------------------------------------------- heap
  let heapTop = HEAP_BASE + 16;
  const sizes = new Map<number, number>();
  const malloc = (n: number): number => {
    const size = Math.max(16, Math.ceil(n / 16) * 16);
    if (heapTop + size > HEAP_BASE + HEAP_SIZE) return 0;
    const p = heapTop;
    heapTop += size + 16;
    sizes.set(p, n);
    return p;
  };

  // ---------------------------------------------------------------- host functions
  const names = new Map<number, string>();
  let thunkNext = THUNK_BASE;
  // Like real library code, host functions leave garbage in the caller-saved registers,
  // so programs that wrongly keep values there across calls fail here too.
  const JUNK = 0xbad0bad0bad0bad0n;
  let fpResult = false;
  const clobbering = (fn: (c: Cpu) => void) => (c: Cpu) => {
    fpResult = false;
    fn(c);
    for (let r = 1; r <= 17; r++) c.x[r] = JUNK + BigInt(r);
    for (let r = fpResult ? 1 : 0; r < 32; r++) {
      if (r >= 8 && r <= 15) continue;
      c.vlo[r] = 0x7ff8dead00000000n + BigInt(r);   // a NaN
      c.vhi[r] = 0n;
    }
  };
  // C functions returning `int` define only w0; the upper half of x0 is garbage
  const INT_RESULT = new Set(['puts', 'putchar', 'putc', 'fputc', 'fputs', 'printf', 'fprintf', 'dprintf', 'sprintf',
    'snprintf', 'vprintf', 'fflush', 'strcmp', 'strncmp', 'memcmp', 'atoi', 'abs', 'rand', 'toupper', 'tolower',
    'isdigit', 'isalpha', 'isspace', 'usleep', 'sleep', 'getchar']);
  const thunkFor = (name: string, fn0: (c: Cpu) => void): number => {
    const fn = name.startsWith('<') ? fn0 : clobbering(INT_RESULT.has(name)
      ? (c: Cpu) => { fn0(c); c.x[0] = (c.x[0] & 0xffffffffn) | 0xbad0000000000000n; }
      : fn0);
    const a = thunkNext;
    thunkNext += 4;
    cpu.thunks.set(a, fn);
    names.set(a, name);
    return a;
  };
  const RETURN = thunkFor('<return>', () => { throw new EmuError('internal return thunk executed', RETURN); });
  const EXIT = thunkFor('<exit>', (c) => { throw new ExitSignal(Number(BigInt.asIntN(32, c.x[0] & 0xffffffffn))); });

  const X = (c: Cpu, i: number) => c.x[i];
  const ptr = (c: Cpu, i: number) => Number(c.x[i]);
  const int = (c: Cpu, i: number) => Number(BigInt.asIntN(32, c.x[i] & 0xffffffffn));
  const ret = (c: Cpu, v: bigint | number) => { c.x[0] = BigInt.asUintN(64, BigInt(v)); };
  const retD = (c: Cpu, v: number) => { c.setd(0, v); fpResult = true; };
  const varargs = (c: Cpu) => { let i = 0; const sp = Number(c.sp); return () => mem.u64(sp + 8 * i++); };
  const regArgs = (c: Cpu, from: number) => { let i = from; return () => c.x[i++]; };
  const STDOUT_FILE = HOSTDATA_BASE + 0x100, STDERR_FILE = HOSTDATA_BASE + 0x200, STDIN_FILE = HOSTDATA_BASE + 0x300;
  mem.set64(HOSTDATA_BASE, BigInt(STDOUT_FILE));
  mem.set64(HOSTDATA_BASE + 8, BigInt(STDERR_FILE));
  mem.set64(HOSTDATA_BASE + 16, BigInt(STDIN_FILE));
  const streamOf = (p: number): 1 | 2 => (p === STDERR_FILE ? 2 : 1);
  let seed = 1;
  const files = new FileTable(opts.files, HOSTDATA_BASE + 0x10000);
  const cstr = (p: number) => new TextDecoder().decode(mem.cstring(p));

  const lib: Record<string, (c: Cpu) => void> = {
    puts: (c) => { emit(1, mem.cstring(ptr(c, 0))); emit(1, [10]); ret(c, 1); },
    putchar: (c) => { emit(1, [int(c, 0) & 0xff]); ret(c, int(c, 0) & 0xff); },
    putc: (c) => { emit(streamOf(ptr(c, 1)), [int(c, 0) & 0xff]); ret(c, int(c, 0) & 0xff); },
    fputc: (c) => { emit(streamOf(ptr(c, 1)), [int(c, 0) & 0xff]); ret(c, int(c, 0) & 0xff); },
    fputs: (c) => { emit(streamOf(ptr(c, 1)), mem.cstring(ptr(c, 0))); ret(c, 1); },
    printf: (c) => { const b = formatPrintf(mem, ptr(c, 0), varargs(c)); emit(1, b); ret(c, b.length); },
    fprintf: (c) => { const b = formatPrintf(mem, ptr(c, 1), varargs(c)); emit(streamOf(ptr(c, 0)), b); ret(c, b.length); },
    dprintf: (c) => { const b = formatPrintf(mem, ptr(c, 1), varargs(c)); emit(int(c, 0) === 2 ? 2 : 1, b); ret(c, b.length); },
    sprintf: (c) => { const b = formatPrintf(mem, ptr(c, 1), varargs(c)); mem.setBytes(ptr(c, 0), new Uint8Array([...b, 0])); ret(c, b.length); },
    snprintf: (c) => {
      const b = formatPrintf(mem, ptr(c, 2), varargs(c));
      const n = Number(X(c, 1));
      if (n > 0) mem.setBytes(ptr(c, 0), new Uint8Array([...b.slice(0, n - 1), 0]));
      ret(c, b.length);
    },
    vprintf: (c) => { const b = formatPrintf(mem, ptr(c, 0), regArgs(c, 1)); emit(1, b); ret(c, b.length); },
    fflush: (c) => ret(c, 0),
    fwrite: (c) => {
      const size = Number(X(c, 1)), n = size * Number(X(c, 2)), f = ptr(c, 3);
      if (files.has(f)) { ret(c, size ? Math.floor(files.fwrite(f, mem.bytes(ptr(c, 0), n)) / size) : 0); return; }
      emit(streamOf(f), mem.bytes(ptr(c, 0), n));
      ret(c, X(c, 2));
    },
    // files (src/emu/files.ts): fopen(path, mode), fread(buf, size, count, f), fseek(f, off, whence), ...
    fopen: (c) => ret(c, files.fopen(cstr(ptr(c, 0)), cstr(ptr(c, 1)))),
    fclose: (c) => ret(c, files.has(ptr(c, 0)) ? files.fclose(ptr(c, 0)) : 0),
    fread: (c) => {
      const size = Number(X(c, 1)), n = size * Number(X(c, 2)), f = ptr(c, 3);
      let got: Uint8Array;
      if (files.has(f)) got = files.fread(f, n) ?? new Uint8Array(0);
      else { got = stdinBytes.subarray(stdinPos, stdinPos + n); stdinPos += got.length; }
      mem.setBytes(ptr(c, 0), got);
      ret(c, size ? Math.floor(got.length / size) : 0);
    },
    fseek: (c) => ret(c, files.fseek(ptr(c, 0), Number(BigInt.asIntN(64, X(c, 1))), int(c, 2))),
    ftell: (c) => ret(c, files.ftell(ptr(c, 0))),
    feof: (c) => ret(c, files.feof(ptr(c, 0)) ? 1 : 0),
    write: (c) => { const n = Number(X(c, 2)); emit(int(c, 0) === 2 ? 2 : 1, mem.bytes(ptr(c, 1), n)); ret(c, n); },
    read: (c) => {
      const n = Math.min(Number(X(c, 2)), stdinBytes.length - stdinPos);
      mem.setBytes(ptr(c, 1), stdinBytes.subarray(stdinPos, stdinPos + n));
      stdinPos += n;
      ret(c, n);
    },
    getchar: (c) => ret(c, stdinPos < stdinBytes.length ? stdinBytes[stdinPos++] : -1),
    exit: (c) => { throw new ExitSignal(int(c, 0)); },
    _exit: (c) => { throw new ExitSignal(int(c, 0)); },
    abort: () => { throw new ExitSignal(134); },
    strlen: (c) => ret(c, mem.cstring(ptr(c, 0)).length),
    strcmp: (c) => ret(c, cmpBytes(mem.cstring(ptr(c, 0)), mem.cstring(ptr(c, 1)), Infinity)),
    strncmp: (c) => ret(c, cmpBytes(mem.cstring(ptr(c, 0)), mem.cstring(ptr(c, 1)), Number(X(c, 2)))),
    strcpy: (c) => { mem.setBytes(ptr(c, 0), new Uint8Array([...mem.cstring(ptr(c, 1)), 0])); ret(c, X(c, 0)); },
    strncpy: (c) => {
      const n = Number(X(c, 2));
      const s = mem.cstring(ptr(c, 1));
      const b = new Uint8Array(n);
      b.set(s.subarray(0, n));
      mem.setBytes(ptr(c, 0), b);
      ret(c, X(c, 0));
    },
    strcat: (c) => {
      const d = ptr(c, 0);
      const l = mem.cstring(d).length;
      mem.setBytes(d + l, new Uint8Array([...mem.cstring(ptr(c, 1)), 0]));
      ret(c, X(c, 0));
    },
    strchr: (c) => {
      const p = ptr(c, 0), ch = int(c, 1) & 0xff;
      for (let i = 0; ; i++) {
        const b = mem.u8(p + i);
        if (b === ch) { ret(c, p + i); return; }
        if (!b) { ret(c, 0); return; }
      }
    },
    memcpy: (c) => { mem.setBytes(ptr(c, 0), mem.bytes(ptr(c, 1), Number(X(c, 2)))); ret(c, X(c, 0)); },
    memmove: (c) => { mem.setBytes(ptr(c, 0), mem.bytes(ptr(c, 1), Number(X(c, 2)))); ret(c, X(c, 0)); },
    memset: (c) => { mem.setBytes(ptr(c, 0), new Uint8Array(Number(X(c, 2))).fill(int(c, 1) & 0xff)); ret(c, X(c, 0)); },
    bzero: (c) => { mem.setBytes(ptr(c, 0), new Uint8Array(Number(X(c, 1)))); },
    memcmp: (c) => ret(c, cmpBytes(mem.bytes(ptr(c, 0), Number(X(c, 2))), mem.bytes(ptr(c, 1), Number(X(c, 2))), Infinity, true)),
    malloc: (c) => ret(c, malloc(Number(X(c, 0)))),
    calloc: (c) => ret(c, malloc(Number(X(c, 0)) * Number(X(c, 1)))),
    realloc: (c) => {
      const old = ptr(c, 0), n = Number(X(c, 1));
      const p = malloc(n);
      if (old && p) mem.setBytes(p, mem.bytes(old, Math.min(n, sizes.get(old) ?? 0)));
      ret(c, p);
    },
    free: () => {},
    atoi: (c) => ret(c, BigInt.asUintN(32, BigInt(parseInt(new TextDecoder().decode(mem.cstring(ptr(c, 0))), 10) || 0))),
    atol: (c) => ret(c, BigInt(parseInt(new TextDecoder().decode(mem.cstring(ptr(c, 0))), 10) || 0)),
    strtol: (c) => {
      const s = new TextDecoder().decode(mem.cstring(ptr(c, 0)));
      const base = int(c, 2) || 10;
      const m = /^\s*[-+]?(0x)?[0-9a-z]*/i.exec(s)!;
      if (X(c, 1)) mem.set64(ptr(c, 1), BigInt(ptr(c, 0) + m[0].length));
      ret(c, BigInt(parseInt(m[0], base) || 0));
    },
    abs: (c) => ret(c, BigInt.asUintN(32, BigInt(Math.abs(int(c, 0))))),
    labs: (c) => { const v = BigInt.asIntN(64, X(c, 0)); ret(c, v < 0n ? -v : v); },
    rand: (c) => { seed = (seed * 1103515245 + 12345) % 2147483648; ret(c, seed); },
    srand: (c) => { seed = int(c, 0) >>> 0; },
    arc4random: (c) => ret(c, Math.floor(Math.random() * 2 ** 32)),
    arc4random_uniform: (c) => ret(c, Math.floor(Math.random() * Number(X(c, 0) & 0xffffffffn))),
    time: (c) => { const t = Math.floor(Date.now() / 1000); if (X(c, 0)) mem.set64(ptr(c, 0), BigInt(t)); ret(c, t); },
    clock: (c) => ret(c, Math.floor(performance.now() * 1000)),
    usleep: (c) => ret(c, 0),
    sleep: (c) => ret(c, 0),
    getenv: (c) => ret(c, 0),
    system: (c) => ret(c, -1),     // no shell in the emulator
    toupper: (c) => { const v = int(c, 0); ret(c, v >= 97 && v <= 122 ? v - 32 : v); },
    tolower: (c) => { const v = int(c, 0); ret(c, v >= 65 && v <= 90 ? v + 32 : v); },
    isdigit: (c) => { const v = int(c, 0); ret(c, v >= 48 && v <= 57 ? 1 : 0); },
    isalpha: (c) => { const v = int(c, 0) | 32; ret(c, v >= 97 && v <= 122 ? 1 : 0); },
    isspace: (c) => { const v = int(c, 0); ret(c, v === 32 || (v >= 9 && v <= 13) ? 1 : 0); },
    qsort: (c) => {
      const base = ptr(c, 0), n = Number(X(c, 1)), size = Number(X(c, 2)), cmp = ptr(c, 3);
      const items: Uint8Array[] = [];
      for (let i = 0; i < n; i++) items.push(mem.bytes(base + i * size, size));
      const tmpA = malloc(size), tmpB = malloc(size);
      const sorted = mergeSort(items, (a, b) => {
        mem.setBytes(tmpA, a);
        mem.setBytes(tmpB, b);
        return Number(BigInt.asIntN(32, cpu.call(cmp, [BigInt(tmpA), BigInt(tmpB)], RETURN) & 0xffffffffn));
      });
      sorted.forEach((it, i) => mem.setBytes(base + i * size, it));
    },
    sqrt: (c) => retD(c, Math.sqrt(c.d(0))),
    sin: (c) => retD(c, Math.sin(c.d(0))),
    cos: (c) => retD(c, Math.cos(c.d(0))),
    tan: (c) => retD(c, Math.tan(c.d(0))),
    atan: (c) => retD(c, Math.atan(c.d(0))),
    atan2: (c) => retD(c, Math.atan2(c.d(0), c.d(1))),
    exp: (c) => retD(c, Math.exp(c.d(0))),
    log: (c) => retD(c, Math.log(c.d(0))),
    log10: (c) => retD(c, Math.log10(c.d(0))),
    pow: (c) => retD(c, Math.pow(c.d(0), c.d(1))),
    floor: (c) => retD(c, Math.floor(c.d(0))),
    ceil: (c) => retD(c, Math.ceil(c.d(0))),
    round: (c) => retD(c, Math.sign(c.d(0)) * Math.round(Math.abs(c.d(0)))),
    fabs: (c) => retD(c, Math.abs(c.d(0))),
    fmod: (c) => retD(c, c.d(0) % c.d(1)),
    atof: (c) => retD(c, parseFloat(new TextDecoder().decode(mem.cstring(ptr(c, 0)))) || 0),
  };
  const dataSyms: Record<string, number> = {
    ___stdoutp: HOSTDATA_BASE, ___stderrp: HOSTDATA_BASE + 8, ___stdinp: HOSTDATA_BASE + 16,
  };

  const resolve = (sym: string): number => {
    if (dataSyms[sym] !== undefined) return dataSyms[sym];
    const n = sym.startsWith('_') ? sym.slice(1) : sym;
    const f = lib[n];
    if (f) return thunkFor(n, f);
    return thunkFor(n, () => { throw new EmuError(`'${n}' is not available in the emulator`, -1); });
  };
  const resolved = new Map<string, number>();

  // ---------------------------------------------------------------- binding
  const applyBinds = (b: Uint8Array, lazy: boolean) => {
    const p = { i: 0 };
    let sym = '', seg = 0, segOffset = 0, addend = 0;
    const bindHere = () => {
      if (!resolved.has(sym)) resolved.set(sym, resolve(sym));
      mem.set64(segs[seg].vmaddr + segOffset, BigInt(resolved.get(sym)! + addend) & M64);
      segOffset += 8;
    };
    while (p.i < b.length) {
      const byte = b[p.i++];
      const op = byte & 0xf0, imm = byte & 0x0f;
      switch (op) {
        case 0x00: if (!lazy) return; break;
        case 0x10: case 0x30: break;
        case 0x20: uleb(b, p); break;
        case 0x40: {
          let s = '';
          while (b[p.i]) s += String.fromCharCode(b[p.i++]);
          p.i++;
          sym = s;
          break;
        }
        case 0x50: break;
        case 0x60: addend = sleb(b, p); break;
        case 0x70: seg = imm; segOffset = uleb(b, p); break;
        case 0x80: segOffset += uleb(b, p); break;
        case 0x90: bindHere(); break;
        case 0xa0: bindHere(); segOffset += uleb(b, p); break;
        case 0xb0: bindHere(); segOffset += imm * 8; break;
        case 0xc0: {
          const count = uleb(b, p), skip = uleb(b, p);
          for (let k = 0; k < count; k++) { bindHere(); segOffset += skip; }
          break;
        }
        default: throw new Error(`unknown bind opcode 0x${byte.toString(16)}`);
      }
    }
  };
  if (bindSize) applyBinds(bytes.subarray(bindOff, bindOff + bindSize), false);
  if (lazySize) applyBinds(bytes.subarray(lazyOff, lazyOff + lazySize), true);

  // ---------------------------------------------------------------- syscalls
  cpu.onSvc = (c) => {
    const num = Number(c.x[16]);
    c.c = false;
    switch (num) {
      case 1: throw new ExitSignal(int(c, 0));
      case 3: lib.read(c); return;
      case 4: lib.write(c); return;
      case 20: ret(c, 4242); return;
      default:
        ret(c, 78); // ENOSYS
        c.c = true;
    }
  };

  // ---------------------------------------------------------------- start
  const argv = ['program', ...(opts.args ?? [])];
  let sp = STACK_TOP - 4096;
  const ptrs: number[] = [];
  for (const a of argv) {
    const b = new TextEncoder().encode(a + '\0');
    mem.setBytes(sp, b);
    ptrs.push(sp);
    sp += b.length;
  }
  const argvAddr = STACK_TOP - 8192;
  ptrs.forEach((p, i) => mem.set64(argvAddr + 8 * i, BigInt(p)));
  mem.set64(argvAddr + 8 * ptrs.length, 0n);
  cpu.sp = BigInt(argvAddr - 256);
  cpu.x[0] = BigInt(argv.length);
  cpu.x[1] = BigInt(argvAddr);
  cpu.x[30] = BigInt(EXIT);
  cpu.x[29] = 0n;
  cpu.pc = text.vmaddr + entryOff;

  let exitCode: number | null = null;
  let error: string | null = null;
  try {
    cpu.run();
  } catch (e) {
    if (e instanceof ExitSignal) exitCode = e.code;
    else if (e instanceof EmuError) {
      const where = e.pc >= 0 ? '' : ` (pc 0x${cpu.pc.toString(16)})`;
      error = e.message + where;
    } else error = (e as Error).message ?? String(e);
  }
  files.closeAll();
  const tail1 = dec1.decode(), tail2 = dec2.decode();
  if (opts.onOutput) { if (tail1) opts.onOutput(tail1, 1); if (tail2) opts.onOutput(tail2, 2); }
  return {
    stdout: new TextDecoder().decode(new Uint8Array(out)),
    stderr: new TextDecoder().decode(new Uint8Array(err)),
    exitCode, steps: cpu.steps, error,
  };
}

function cmpBytes(a: Uint8Array, b: Uint8Array, n: number, raw = false): number {
  const len = Math.min(n, Math.max(a.length, b.length) + (raw ? 0 : 1));
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function mergeSort<T>(a: T[], cmp: (x: T, y: T) => number): T[] {
  if (a.length < 2) return a;
  const m = a.length >> 1;
  const l = mergeSort(a.slice(0, m), cmp), r = mergeSort(a.slice(m), cmp);
  const out: T[] = [];
  let i = 0, j = 0;
  while (i < l.length && j < r.length) out.push(cmp(l[i], r[j]) <= 0 ? l[i++] : r[j++]);
  return out.concat(l.slice(i), r.slice(j));
}

export { bitsToF64, f64ToBits };

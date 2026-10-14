// Loads a Linux x86-64 ELF executable (and the shared libraries it needs) into emulator memory,
// binds its imports to host implementations of glibc functions (libc.so.6, libm.so.6), applies the
// dynamic relocations, builds the initial process stack (argc, argv, envp, auxv) and runs it.
// Calls follow the System V AMD64 ABI. Like real library code, host functions leave garbage in the
// registers a call may change, and they check what glibc relies on: a 16-byte aligned stack at every
// call, and `al` (the number of vector registers used) before a variadic call that passes doubles.
import { X64, EmuError, ExitSignal, Memory } from './cpu.ts';
import { bitsToF64 } from '../cpu.ts';
import { formatPrintf } from '../printf.ts';
import { FileTable, type EmuFiles } from '../files.ts';
import { glibcLibraryOf } from '../../asm/elf/glibc.ts';

export interface ElfRunOptions {
  stdin?: string;
  limit?: number;
  onOutput?: (text: string, stream: 1 | 2) => void;
  /** shared libraries the program (or another library) needs, by DT_NEEDED name: { "libmathlib.so": bytes },
   *  or a function that finds them */
  libs?: Record<string, Uint8Array> | ((name: string) => Uint8Array | null);
  /** command line arguments after the program name (argv[1..]) */
  args?: string[];
  /** where fopen finds and writes files; without it fopen fails (returns NULL) */
  files?: EmuFiles;
}

export interface ElfRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  steps: number;
  error: string | null;
}

const THUNKS = 0x7ff700000000;
const HOSTDATA = 0x7ff710000000;
const STACK_TOP = 0x7ffff0000000;
const STACK_SIZE = 8 << 20;
const HEAP = 0x7ff500000000;
const HEAP_SIZE = 64 << 20;
const LIB_BASE = 0x7f0000000000;
const TLS_BASE = 0x7ff720000000;
const PAGE = 0x1000;

const R_X86_64_NONE = 0, R_X86_64_64 = 1, R_X86_64_COPY = 5, R_X86_64_GLOB_DAT = 6, R_X86_64_JUMP_SLOT = 7, R_X86_64_RELATIVE = 8;
const R_X86_64_DTPMOD64 = 16, R_X86_64_DTPOFF64 = 17, R_X86_64_TPOFF64 = 18;

interface DynSym { name: string; value: number; size: number; shndx: number; bind: number; type: number }

interface Image {
  name: string;
  base: number;              // load bias: 0 for an executable, where the library was put for a .so
  lo: number; hi: number;    // the address range of the loaded segments (biased)
  image: Uint8Array;         // bytes of [lo, hi)
  dv: DataView;
  segs: { vaddr: number; memsz: number; writable: boolean; exec: boolean }[];
  entry: number;
  dyn: Map<number, number[]>;
  syms: DynSym[];
  needed: string[];
  tls: { vaddr: number; filesz: number; memsz: number; align: number } | null;   // PT_TLS (vaddr biased)
}

/** parse an ELF64 x86-64 file and lay out its PT_LOAD segments at `bias` (0 for an executable) */
function loadImage(name: string, bytes: Uint8Array, bias: number | null): Image {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, false) !== 0x7f454c46) throw new Error(`${name}: not an ELF file`);
  if (bytes[4] !== 2 || bytes[5] !== 1) throw new Error(`${name}: not a 64-bit little-endian ELF file`);
  if (dv.getUint16(18, true) !== 62) throw new Error(`${name}: not an x86-64 file`);
  const type = dv.getUint16(16, true);
  if (type !== 2 && type !== 3) throw new Error(`${name}: not an executable or shared library`);
  const phoff = Number(dv.getBigUint64(32, true)), phnum = dv.getUint16(56, true), phent = dv.getUint16(54, true);
  const loads: { off: number; vaddr: number; filesz: number; memsz: number; flags: number }[] = [];
  let dynVaddr = -1;
  let tls: Image['tls'] = null;
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phent;
    const pt = dv.getUint32(o, true), flags = dv.getUint32(o + 4, true);
    const off = Number(dv.getBigUint64(o + 8, true)), vaddr = Number(dv.getBigUint64(o + 16, true));
    const filesz = Number(dv.getBigUint64(o + 32, true)), memsz = Number(dv.getBigUint64(o + 40, true));
    if (pt === 1) loads.push({ off, vaddr, filesz, memsz, flags });
    else if (pt === 2) dynVaddr = vaddr;
    else if (pt === 7) tls = { vaddr, filesz, memsz, align: Math.max(1, Number(dv.getBigUint64(o + 48, true))) };
  }
  if (!loads.length) throw new Error(`${name}: no loadable segments`);
  // an executable (ET_EXEC) stays where it was linked; a position-independent file goes to `bias`
  const b = type === 2 ? 0 : (bias ?? 0x555555554000);
  const lo = Math.floor(Math.min(...loads.map((l) => l.vaddr)) / PAGE) * PAGE + b;
  const hi = Math.ceil(Math.max(...loads.map((l) => l.vaddr + l.memsz)) / PAGE) * PAGE + b;
  const image = new Uint8Array(hi - lo);
  for (const l of loads) image.set(bytes.subarray(l.off, l.off + l.filesz), l.vaddr + b - lo);
  const idv = new DataView(image.buffer);
  const img: Image = {
    name, base: b, lo, hi, image, dv: idv, entry: Number(dv.getBigUint64(24, true)) + b,
    segs: loads.map((l) => ({ vaddr: l.vaddr + b, memsz: l.memsz, writable: (l.flags & 2) !== 0, exec: (l.flags & 1) !== 0 })),
    dyn: new Map(), syms: [], needed: [], tls: tls && { ...tls, vaddr: tls.vaddr + b },
  };
  if (dynVaddr < 0) return img;
  const u64 = (a: number) => Number(idv.getBigUint64(a - lo, true));
  for (let a = dynVaddr + b; ; a += 16) {
    const tag = Number(idv.getBigInt64(a - lo, true)), v = u64(a + 8);
    if (tag === 0) break;
    if (!img.dyn.has(tag)) img.dyn.set(tag, []);
    img.dyn.get(tag)!.push(v);
  }
  const d1 = (tag: number) => img.dyn.get(tag)?.[0];
  const strtab = d1(5)! + b;
  const str = (o: number) => { const s = strtab - lo + o; return new TextDecoder().decode(image.subarray(s, image.indexOf(0, s))); };
  img.needed = (img.dyn.get(1) ?? []).map(str);
  // the number of dynamic symbols: DT_HASH's nchain, else the .dynsym section header
  let nsym = 0;
  if (d1(4) !== undefined) nsym = idv.getUint32(d1(4)! + b - lo + 4, true);
  else {
    const shoff = Number(dv.getBigUint64(40, true)), shnum = dv.getUint16(60, true);
    for (let i = 0; i < shnum; i++) {
      const o = shoff + 64 * i;
      if (o + 64 <= bytes.length && dv.getUint32(o + 4, true) === 11) nsym = Number(dv.getBigUint64(o + 32, true)) / 24;
    }
  }
  const symtab = (d1(6) ?? 0) + b;
  for (let i = 0; i < nsym; i++) {
    const o = symtab - lo + 24 * i;
    const info = image[o + 4];
    img.syms.push({ name: str(idv.getUint32(o, true)), bind: info >> 4, type: info & 15, shndx: idv.getUint16(o + 6, true), value: Number(idv.getBigUint64(o + 8, true)), size: Number(idv.getBigUint64(o + 16, true)) });
  }
  return img;
}

/** glibc's rand(): the TYPE_3 additive feedback generator, seeded like srandom() */
class GlibcRand {
  private r: number[] = [];
  private i = 0;
  constructor(seed = 1) { this.seed(seed); }
  seed(s: number) {
    const r = new Array<number>(34);
    r[0] = s >>> 0 || 1;
    for (let i = 1; i < 31; i++) {
      const hi = Math.trunc((r[i - 1] | 0) / 127773), lo = (r[i - 1] | 0) % 127773;
      let w = 16807 * lo - 2836 * hi;
      if (w < 0) w += 2147483647;
      r[i] = w;
    }
    for (let i = 31; i < 34; i++) r[i] = r[i - 31];
    this.r = r;
    this.i = 34;
    for (let k = 34; k < 344; k++) this.step();
  }
  private step(): number {
    const r = this.r, n = this.i;
    const v = (r[(n - 31) % 34] + r[(n - 3) % 34]) >>> 0;
    r[n % 34] = v;
    this.i = n + 1;
    return v;
  }
  next(): number { return this.step() >>> 1; }
}

export function runElf(bytes: Uint8Array, opts: ElfRunOptions = {}): ElfRunResult {
  const mem = new Memory();
  const cpu = new X64(mem);
  cpu.abi = 'sysv';
  cpu.limit = opts.limit ?? 200_000_000;

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
  const stdinBytes = new TextEncoder().encode(opts.stdin ?? '');
  let stdinPos = 0;
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

  // host data: FILE objects of the standard streams, environ, errno, variables a program imports
  let hostNext = HOSTDATA + 0x1000;
  const hostAlloc = (n: number) => { const p = hostNext; hostNext += Math.ceil(n / 16) * 16; return p; };
  const STDIN_FILE = hostAlloc(256), STDOUT_FILE = hostAlloc(256), STDERR_FILE = hostAlloc(256);
  const ERRNO = hostAlloc(16);
  const dataSyms = new Map<string, number>();
  const defineData = (name: string, value: bigint) => { const p = hostAlloc(16); dataSyms.set(name, p); pendingData.push([p, value]); };
  const pendingData: [number, bigint][] = [];
  defineData('stdin', BigInt(STDIN_FILE));
  defineData('stdout', BigInt(STDOUT_FILE));
  defineData('stderr', BigInt(STDERR_FILE));
  const streamOf = (p: number): 1 | 2 => (p === STDERR_FILE ? 2 : 1);

  let thunkNext = THUNKS;
  const JUNK = 0xbad0bad0bad0bad0n;
  let fpResult = false;
  // C functions returning `int` define only eax; the upper half of rax is garbage
  const INT_RESULT = new Set(['puts', 'putchar', 'putc', 'fputc', 'fputs', 'printf', 'fprintf', 'dprintf', 'sprintf', 'snprintf',
    'vprintf', 'vfprintf', 'vsnprintf', 'vsprintf', 'fflush', 'strcmp', 'strncmp', 'memcmp', 'atoi', 'abs', 'rand', 'toupper', 'tolower',
    'isdigit', 'isalpha', 'isspace', 'isalnum', 'isupper', 'islower', 'usleep', 'sleep', 'getchar', 'fclose', 'fseek', 'feof', 'getpid',
    '__printf_chk', '__fprintf_chk', '__sprintf_chk', '__snprintf_chk', 'atexit', '__cxa_atexit']);
  const names = new Map<number, string>();
  const thunkFor = (name: string, fn: (c: X64) => void, raw = false): number => {
    const a = thunkNext;
    thunkNext += 16;
    names.set(a, name);
    cpu.thunks.set(a, raw ? fn : (c) => {
      // the call pushed the return address: rsp ≡ 8 (mod 16) when the caller's stack was aligned
      if ((c.rsp & 15n) !== 8n) throw new EmuError(`${name}: the stack is not 16-byte aligned at the call (rsp = 0x${(c.rsp + 8n).toString(16)} before it; System V requires rsp % 16 == 0)`, -1);
      fpResult = false;
      fn(c);
      // System V volatile registers: rdi rsi rdx rcx r8-r11, every xmm (rax / xmm0 hold the result)
      for (const r of [1, 2, 6, 7, 8, 9, 10, 11]) c.r[r] = JUNK + BigInt(r);
      for (let x = fpResult ? 1 : 0; x < 16; x++) { c.xlo[x] = 0x7ff8dead00000000n + BigInt(x); c.xhi[x] = 0n; }
      if (INT_RESULT.has(name)) c.r[0] = (c.r[0] & 0xffffffffn) | 0xbad0000000000000n;
    });
    return a;
  };
  const RETURN = thunkFor('<return>', () => { throw new EmuError('internal return thunk executed', RETURN); }, true);
  let images: Image[] = [];
  const DL_FINI = thunkFor('_dl_fini', () => runFini());

  // arguments: integers in rdi rsi rdx rcx r8 r9, doubles in xmm0-7, the rest on the stack
  const GPR = [7, 6, 2, 1, 8, 9];
  const X = (c: X64, i: number): bigint => (i < 6 ? c.r[GPR[i]] : mem.u64(Number(c.rsp) + 8 + 8 * (i - 6)));
  const ptr = (c: X64, i: number) => Number(X(c, i));
  const int = (c: X64, i: number) => Number(BigInt.asIntN(32, X(c, i) & 0xffffffffn));
  const D = (c: X64, i: number) => c.d(i);
  const ret = (c: X64, v: bigint | number) => { c.r[0] = BigInt.asUintN(64, BigInt(v)); };
  const retD = (c: X64, v: number) => { c.setd(0, v); c.xhi[0] = 0n; fpResult = true; };
  const cstr = (p: number) => mem.cstring(p);
  const str = (p: number) => new TextDecoder().decode(cstr(p));
  /** the variadic arguments of a call after `gp` integer and `fp` floating point fixed ones */
  const varargs = (c: X64, gp: number, fp = 0, name = 'printf') => {
    let stack = Number(c.rsp) + 8 + 8 * Math.max(0, gp - 6);
    const al = Number(c.r[0] & 0xffn);
    return (isFp?: boolean): bigint => {
      if (isFp) {
        if (fp < 8) {
          if (al === 0) throw new EmuError(`${name}: a floating point argument, but al = 0 (set al to the number of xmm registers with arguments before a variadic call)`, -1);
          return c.xlo[fp++];
        }
      } else if (gp < 6) return c.r[GPR[gp++]];
      const v = mem.u64(stack);
      stack += 8;
      return v;
    };
  };
  /** arguments from a va_list (System V: { u32 gp_offset, u32 fp_offset, void *overflow, void *save_area }) */
  const vaList = (p: number) => (isFp?: boolean): bigint => {
    const gpo = mem.u32(p), fpo = mem.u32(p + 4), save = Number(mem.u64(p + 16));
    if (isFp && fpo < 176) { mem.set32(p + 4, fpo + 16); return mem.u64(save + fpo); }
    if (!isFp && gpo < 48) { mem.set32(p, gpo + 8); return mem.u64(save + gpo); }
    const ov = Number(mem.u64(p + 8));
    mem.set64(p + 8, BigInt(ov + 8));
    return mem.u64(ov);
  };
  const files = new FileTable(opts.files, HOSTDATA + 0x100000);
  const rng = new GlibcRand();
  const atexit: [number, bigint][] = [];
  const doExit = (code: number): never => {
    while (atexit.length) { const [f, a] = atexit.pop()!; cpu.call(f, [a], RETURN); }
    throw new ExitSignal(code);
  };
  const putOut = (f: number, b: ArrayLike<number>) => {
    if (files.has(f)) return files.fwrite(f, Uint8Array.from(b));
    emit(streamOf(f), b);
    return b.length;
  };
  const printfTo = (c: X64, b: number[], dest: number, size: number | null) => {
    if (size === null) mem.setBytes(dest, new Uint8Array([...b, 0]));
    else if (size > 0) mem.setBytes(dest, new Uint8Array([...b.slice(0, size - 1), 0]));
    ret(c, b.length);
  };
  let mainImage: Image | null = null;
  let argvInfo = { argc: 0, argv: 0, envp: 0 };
  // the dynamic loader's _dl_fini (rdx at the entry point, rtld_fini of __libc_start_main): destructors of
  // the program and its libraries, the program first, each one's DT_FINI_ARRAY backwards, then DT_FINI
  const runFini = () => {
    for (const img of images) {
      const d1 = (t: number) => img.dyn.get(t)?.[0];
      const arr = d1(26), n = d1(28) ?? 0;                                  // DT_FINI_ARRAY, DT_FINI_ARRAYSZ
      if (arr !== undefined) for (let i = n / 8 - 1; i >= 0; i--) {
        const f = Number(mem.u64(arr + img.base + 8 * i));
        if (f && f !== -1) cpu.call(f, [], RETURN);
      }
      if (d1(13)) cpu.call(d1(13)! + img.base, [], RETURN);              // DT_FINI
    }
  };
  const runInit = (img: Image) => {
    const d1 = (t: number) => img.dyn.get(t)?.[0];
    const args = [BigInt(argvInfo.argc), BigInt(argvInfo.argv), BigInt(argvInfo.envp)];
    if (d1(12)) cpu.call(d1(12)! + img.base, args, RETURN);               // DT_INIT
    const arr = d1(25), n = d1(27) ?? 0;                                  // DT_INIT_ARRAY, DT_INIT_ARRAYSZ
    if (arr !== undefined) for (let i = 0; i < n / 8; i++) {
      const f = Number(mem.u64(arr + img.base + 8 * i));
      if (f && f !== -1) cpu.call(f, args, RETURN);
    }
  };
  const syscall = (c: X64, n: number, a: (i: number) => bigint): bigint => {
    switch (n) {
      case 0: {                                           // read(fd, buf, n)
        const k = Math.min(Number(a(2)), stdinBytes.length - stdinPos);
        if (Number(a(0)) !== 0) return -9n;               // EBADF
        mem.setBytes(Number(a(1)), stdinBytes.subarray(stdinPos, stdinPos + k));
        stdinPos += k;
        return BigInt(k);
      }
      case 1: {                                           // write(fd, buf, n)
        const fd = Number(a(0)), k = Number(a(2));
        if (fd !== 1 && fd !== 2) return -9n;
        emit(fd as 1 | 2, mem.bytes(Number(a(1)), k));
        return BigInt(k);
      }
      case 39: return 4242n;                              // getpid
      case 60: case 231: throw new ExitSignal(Number(BigInt.asIntN(32, a(0) & 0xffffffffn)));   // exit, exit_group
      default: void c; return -38n;                       // ENOSYS
    }
  };
  cpu.onSyscall = (c) => { c.r[0] = BigInt.asUintN(64, syscall(c, Number(c.r[0]), (i) => c.r[[7, 6, 2, 10, 8, 9][i]])); };

  const lib: Record<string, (c: X64) => void> = {
    puts: (c) => { emit(1, cstr(ptr(c, 0))); emit(1, [10]); ret(c, 1); },
    putchar: (c) => { emit(1, [int(c, 0) & 0xff]); ret(c, int(c, 0) & 0xff); },
    putc: (c) => { putOut(ptr(c, 1), [int(c, 0) & 0xff]); ret(c, int(c, 0) & 0xff); },
    fputc: (c) => { putOut(ptr(c, 1), [int(c, 0) & 0xff]); ret(c, int(c, 0) & 0xff); },
    fputs: (c) => { putOut(ptr(c, 1), cstr(ptr(c, 0))); ret(c, 1); },
    printf: (c) => { const b = formatPrintf(mem, ptr(c, 0), varargs(c, 1)); emit(1, b); ret(c, b.length); },
    fprintf: (c) => { const b = formatPrintf(mem, ptr(c, 1), varargs(c, 2, 0, 'fprintf')); putOut(ptr(c, 0), b); ret(c, b.length); },
    dprintf: (c) => { const b = formatPrintf(mem, ptr(c, 1), varargs(c, 2, 0, 'dprintf')); emit(int(c, 0) === 2 ? 2 : 1, b); ret(c, b.length); },
    sprintf: (c) => printfTo(c, formatPrintf(mem, ptr(c, 1), varargs(c, 2, 0, 'sprintf')), ptr(c, 0), null),
    snprintf: (c) => printfTo(c, formatPrintf(mem, ptr(c, 2), varargs(c, 3, 0, 'snprintf')), ptr(c, 0), Number(X(c, 1))),
    vprintf: (c) => { const b = formatPrintf(mem, ptr(c, 0), vaList(ptr(c, 1))); emit(1, b); ret(c, b.length); },
    vfprintf: (c) => { const b = formatPrintf(mem, ptr(c, 1), vaList(ptr(c, 2))); putOut(ptr(c, 0), b); ret(c, b.length); },
    vsprintf: (c) => printfTo(c, formatPrintf(mem, ptr(c, 1), vaList(ptr(c, 2))), ptr(c, 0), null),
    vsnprintf: (c) => printfTo(c, formatPrintf(mem, ptr(c, 2), vaList(ptr(c, 3))), ptr(c, 0), Number(X(c, 1))),
    // _FORTIFY_SOURCE variants (gcc -O2 on Ubuntu): an extra flag argument
    __printf_chk: (c) => { const b = formatPrintf(mem, ptr(c, 1), varargs(c, 2, 0, '__printf_chk')); emit(1, b); ret(c, b.length); },
    __fprintf_chk: (c) => { const b = formatPrintf(mem, ptr(c, 2), varargs(c, 3, 0, '__fprintf_chk')); putOut(ptr(c, 0), b); ret(c, b.length); },
    __sprintf_chk: (c) => printfTo(c, formatPrintf(mem, ptr(c, 3), varargs(c, 4, 0, '__sprintf_chk')), ptr(c, 0), null),
    __snprintf_chk: (c) => printfTo(c, formatPrintf(mem, ptr(c, 4), varargs(c, 5, 0, '__snprintf_chk')), ptr(c, 0), Number(X(c, 1))),
    fflush: (c) => ret(c, 0),
    fwrite: (c) => {
      const size = Number(X(c, 1)), n = size * Number(X(c, 2)), f = ptr(c, 3);
      if (files.has(f)) { ret(c, size ? Math.floor(files.fwrite(f, mem.bytes(ptr(c, 0), n)) / size) : 0); return; }
      emit(streamOf(f), mem.bytes(ptr(c, 0), n));
      ret(c, X(c, 2));
    },
    fopen: (c) => ret(c, files.fopen(str(ptr(c, 0)), str(ptr(c, 1)))),
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
    write: (c) => ret(c, syscall(c, 1, (i) => X(c, i))),
    read: (c) => ret(c, syscall(c, 0, (i) => X(c, i))),
    syscall: (c) => ret(c, syscall(c, Number(X(c, 0)), (i) => X(c, i + 1))),
    getchar: (c) => ret(c, stdinPos < stdinBytes.length ? stdinBytes[stdinPos++] : -1),
    exit: (c) => doExit(int(c, 0)),
    _exit: (c) => { throw new ExitSignal(int(c, 0)); },
    abort: () => { throw new ExitSignal(134); },
    __stack_chk_fail: () => { emit(2, new TextEncoder().encode('*** stack smashing detected ***: terminated\n')); throw new ExitSignal(134); },
    __assert_fail: (c) => { emit(2, new TextEncoder().encode(`program: ${str(ptr(c, 1))}:${int(c, 2)}: ${str(ptr(c, 3))}: Assertion \`${str(ptr(c, 0))}' failed.\n`)); throw new ExitSignal(134); },
    atexit: (c) => { atexit.push([ptr(c, 0), 0n]); ret(c, 0); },
    __cxa_atexit: (c) => { atexit.push([ptr(c, 0), X(c, 1)]); ret(c, 0); },
    __cxa_finalize: () => {},
    __errno_location: (c) => ret(c, ERRNO),
    // the entry of executables built by gcc/clang (crt1.o): constructors, main(argc, argv, envp), exit
    __libc_start_main: (c) => {
      const main = ptr(c, 0), init = ptr(c, 3), rtldFini = ptr(c, 5);
      if (rtldFini) atexit.push([rtldFini, 0n]);
      if (init) cpu.call(init, [BigInt(argvInfo.argc), BigInt(argvInfo.argv), BigInt(argvInfo.envp)], RETURN);
      else if (mainImage) runInit(mainImage);
      const r = cpu.call(main, [BigInt(argvInfo.argc), BigInt(argvInfo.argv), BigInt(argvInfo.envp)], RETURN);
      doExit(Number(BigInt.asIntN(32, r & 0xffffffffn)));
    },
    getpid: (c) => ret(c, 4242),
    // general-dynamic TLS: { module, offset } -> the address (only the program's block, module 1)
    __tls_get_addr: (c) => ret(c, tp - tlsSize + Number(mem.u64(ptr(c, 0) + 8))),
    strlen: (c) => ret(c, cstr(ptr(c, 0)).length),
    strcmp: (c) => ret(c, cmpBytes(cstr(ptr(c, 0)), cstr(ptr(c, 1)), Infinity)),
    strncmp: (c) => ret(c, cmpBytes(cstr(ptr(c, 0)), cstr(ptr(c, 1)), Number(X(c, 2)))),
    strcpy: (c) => { mem.setBytes(ptr(c, 0), new Uint8Array([...cstr(ptr(c, 1)), 0])); ret(c, X(c, 0)); },
    __strcpy_chk: (c) => { mem.setBytes(ptr(c, 0), new Uint8Array([...cstr(ptr(c, 1)), 0])); ret(c, X(c, 0)); },
    strncpy: (c) => {
      const n = Number(X(c, 2)), s = cstr(ptr(c, 1)), b = new Uint8Array(n);
      b.set(s.subarray(0, n));
      mem.setBytes(ptr(c, 0), b);
      ret(c, X(c, 0));
    },
    strcat: (c) => { const d = ptr(c, 0); mem.setBytes(d + cstr(d).length, new Uint8Array([...cstr(ptr(c, 1)), 0])); ret(c, X(c, 0)); },
    strchr: (c) => {
      const p = ptr(c, 0), ch = int(c, 1) & 0xff;
      for (let i = 0; ; i++) {
        const b = mem.u8(p + i);
        if (b === ch) { ret(c, p + i); return; }
        if (!b) { ret(c, 0); return; }
      }
    },
    strdup: (c) => { const s = cstr(ptr(c, 0)); const p = malloc(s.length + 1); mem.setBytes(p, new Uint8Array([...s, 0])); ret(c, p); },
    memcpy: (c) => { mem.setBytes(ptr(c, 0), mem.bytes(ptr(c, 1), Number(X(c, 2)))); ret(c, X(c, 0)); },
    __memcpy_chk: (c) => { mem.setBytes(ptr(c, 0), mem.bytes(ptr(c, 1), Number(X(c, 2)))); ret(c, X(c, 0)); },
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
    atoi: (c) => ret(c, BigInt.asUintN(32, BigInt(parseInt(str(ptr(c, 0)), 10) || 0))),
    atol: (c) => ret(c, BigInt(parseInt(str(ptr(c, 0)), 10) || 0)),
    atoll: (c) => ret(c, BigInt(parseInt(str(ptr(c, 0)), 10) || 0)),
    strtol: (c) => {
      const s = str(ptr(c, 0));
      const base = int(c, 2) || 10;
      const m = /^\s*[-+]?(0x)?[0-9a-z]*/i.exec(s)!;
      if (X(c, 1)) mem.set64(ptr(c, 1), BigInt(ptr(c, 0) + m[0].length));
      ret(c, BigInt(parseInt(m[0], base) || 0));
    },
    abs: (c) => ret(c, BigInt.asUintN(32, BigInt(Math.abs(int(c, 0))))),
    labs: (c) => { const v = BigInt.asIntN(64, X(c, 0)); ret(c, v < 0n ? -v : v); },
    llabs: (c) => { const v = BigInt.asIntN(64, X(c, 0)); ret(c, v < 0n ? -v : v); },
    rand: (c) => ret(c, rng.next()),
    srand: (c) => rng.seed(int(c, 0) >>> 0),
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
    isalnum: (c) => { const v = int(c, 0); ret(c, (v >= 48 && v <= 57) || ((v | 32) >= 97 && (v | 32) <= 122) ? 1 : 0); },
    isupper: (c) => { const v = int(c, 0); ret(c, v >= 65 && v <= 90 ? 1 : 0); },
    islower: (c) => { const v = int(c, 0); ret(c, v >= 97 && v <= 122 ? 1 : 0); },
    isspace: (c) => { const v = int(c, 0); ret(c, v === 32 || (v >= 9 && v <= 13) ? 1 : 0); },
    qsort: (c) => {
      const base = ptr(c, 0), n = Number(X(c, 1)), size = Number(X(c, 2)), cmp = ptr(c, 3);
      const items: Uint8Array[] = [];
      for (let i = 0; i < n; i++) items.push(mem.bytes(base + i * size, size));
      const ta = malloc(size), tb = malloc(size);
      const sorted = mergeSort(items, (a, b) => {
        mem.setBytes(ta, a); mem.setBytes(tb, b);
        return Number(BigInt.asIntN(32, cpu.call(cmp, [BigInt(ta), BigInt(tb)], RETURN) & 0xffffffffn));
      });
      sorted.forEach((it, i) => mem.setBytes(base + i * size, it));
    },
    sqrt: (c) => retD(c, Math.sqrt(D(c, 0))), sin: (c) => retD(c, Math.sin(D(c, 0))), cos: (c) => retD(c, Math.cos(D(c, 0))),
    tan: (c) => retD(c, Math.tan(D(c, 0))), atan: (c) => retD(c, Math.atan(D(c, 0))), atan2: (c) => retD(c, Math.atan2(D(c, 0), D(c, 1))),
    exp: (c) => retD(c, Math.exp(D(c, 0))), log: (c) => retD(c, Math.log(D(c, 0))), log10: (c) => retD(c, Math.log10(D(c, 0))),
    pow: (c) => retD(c, Math.pow(D(c, 0), D(c, 1))), floor: (c) => retD(c, Math.floor(D(c, 0))), ceil: (c) => retD(c, Math.ceil(D(c, 0))),
    round: (c) => retD(c, Math.sign(D(c, 0)) * Math.round(Math.abs(D(c, 0)))),
    fabs: (c) => retD(c, Math.abs(D(c, 0))), fmod: (c) => retD(c, D(c, 0) % D(c, 1)),
    atof: (c) => retD(c, parseFloat(str(ptr(c, 0))) || 0),
    strtod: (c) => {
      const s = str(ptr(c, 0)), m = /^\s*[-+]?(\d+\.?\d*(e[-+]?\d+)?|\.\d+(e[-+]?\d+)?|inf(inity)?|nan)/i.exec(s);
      if (X(c, 1)) mem.set64(ptr(c, 1), BigInt(ptr(c, 0) + (m ? m[0].length : 0)));
      retD(c, m ? Number(m[0].trim().replace(/^([-+]?)inf(inity)?$/i, '$1Infinity')) : 0);
    },
  };

  // ---------------------------------------------------------------- load the program and its libraries
  const main = loadImage('program', bytes, null);
  mainImage = main;
  images = [main];
  let nextBase = LIB_BASE;
  const libImages = new Map<string, Image>();
  for (let i = 0; i < images.length; i++) {
    for (const n of images[i].needed) {
      if (n === 'libc.so.6' || n === 'libm.so.6' || n === 'ld-linux-x86-64.so.2' || libImages.has(n)) continue;
      // by its DT_NEEDED name, or by the file name when that is a path (a library linked without a soname)
      const find = (k: string) => (typeof opts.libs === 'function' ? opts.libs(k) : opts.libs?.[k]);
      const data = find(n) ?? (n.includes('/') ? find(n.slice(n.lastIndexOf('/') + 1)) : null);
      if (!data) throw new Error(`${images[i].name} needs ${n}, which is neither built into the emulator nor given`);
      const img = loadImage(n, data, nextBase);
      nextBase = Math.ceil((img.hi + 0x100000) / 0x100000) * 0x100000;
      libImages.set(n, img);
      images.push(img);
    }
  }
  // symbol lookup in load order (the program first), then the host libraries
  const hostResolved = new Map<string, number>();
  // static TLS: only the program may have it (variant II: the block lies right below the thread pointer)
  for (const img of images.slice(1)) if (img.tls) throw new Error(`${img.name}: thread-local storage in a shared library is not supported by the emulator`);
  const tlsSize = main.tls ? Math.ceil(main.tls.memsz / main.tls.align) * main.tls.align : 0;
  const tlsOnly = (img: Image) => { if (img !== main) throw new Error(`${img.name}: thread-local storage in a shared library is not supported by the emulator`); };
  const lookup = (name: string, from: Image, weak: boolean): number => {
    for (const img of images) {
      const s = img.syms.find((x) => x.name === name && x.shndx !== 0 && (x.bind === 1 || x.bind === 2));
      if (s) return s.type === 10 ? (() => { throw new Error(`${name}: indirect functions (IFUNC) are not supported`); })() : s.value + img.base;
    }
    if (dataSyms.has(name)) return dataSyms.get(name)!;
    if (hostResolved.has(name)) return hostResolved.get(name)!;
    const g = glibcLibraryOf(name);
    if (lib[name]) { hostResolved.set(name, thunkFor(name, lib[name])); return hostResolved.get(name)!; }
    if (g?.data || name === 'environ' || name === '__environ') {
      defineData(name, name.includes('environ') ? 0n : 0n);
      return dataSyms.get(name)!;
    }
    if (g) {
      hostResolved.set(name, thunkFor(name, () => { throw new EmuError(`${g.lib}: ${name} is not available in the emulator`, -1); }));
      return hostResolved.get(name)!;
    }
    if (weak) return 0;
    throw new Error(`${from.name}: symbol lookup error: undefined symbol: ${name}`);
  };
  const relocate = (img: Image) => {
    const d1 = (t: number) => img.dyn.get(t)?.[0];
    const tables: [number | undefined, number][] = [[d1(7), d1(8) ?? 0], [d1(23), d1(2) ?? 0]];   // DT_RELA/RELASZ, DT_JMPREL/PLTRELSZ
    if (img.dyn.has(17)) throw new Error(`${img.name}: REL relocations are not supported (x86-64 uses RELA)`);
    if (d1(20) !== undefined && d1(20) !== 7 && d1(23) !== undefined) throw new Error(`${img.name}: PLT relocations must be RELA`);
    const copies: [number, number, number][] = [];
    for (const [at, size] of tables) {
      if (at === undefined) continue;
      for (let o = at + img.base - img.lo; o < at + img.base - img.lo + size; o += 24) {
        const where = Number(img.dv.getBigUint64(o, true)) + img.base, info = img.dv.getBigUint64(o + 8, true), add = img.dv.getBigInt64(o + 16, true);
        const type = Number(info & 0xffffffffn), si = Number(info >> 32n);
        const set = (v: bigint) => img.dv.setBigUint64(where - img.lo, BigInt.asUintN(64, v), true);
        const symAddr = () => { const s = img.syms[si]; return BigInt(lookup(s.name, img, s.bind === 2)); };
        switch (type) {
          case R_X86_64_NONE: break;
          case R_X86_64_RELATIVE: set(BigInt(img.base) + add); break;
          case R_X86_64_64: set(symAddr() + add); break;
          case R_X86_64_GLOB_DAT: case R_X86_64_JUMP_SLOT: set(symAddr()); break;
          case R_X86_64_COPY: copies.push([where, si, img.syms[si].size]); break;
          // thread-local storage of the program (module 1): its block ends at the thread pointer
          case R_X86_64_TPOFF64: tlsOnly(img); set(BigInt(si ? img.syms[si].value : 0) + add - BigInt(tlsSize)); break;
          case R_X86_64_DTPMOD64: tlsOnly(img); set(1n); break;
          case R_X86_64_DTPOFF64: tlsOnly(img); set(BigInt(si ? img.syms[si].value : 0) + add); break;
          default: throw new Error(`${img.name}: unsupported relocation type ${type}`);
        }
      }
    }
    return copies;
  };
  const copyRelocs = images.map((img) => [img, relocate(img)] as const);
  // the thread pointer (fs) points at a glibc-like TCB: itself at 0 and 0x10, the stack protector's canary at 0x28
  const tp = TLS_BASE + Math.ceil((tlsSize + 0x100) / 0x1000) * 0x1000;

  // ---------------------------------------------------------------- map memory
  for (const img of images) {
    const pre = img === main ? '' : img.name + ':';
    // pages take the permissions of the segments that cover them (a page shared by two segments gets both)
    const pages = new Map<number, { w: boolean; x: boolean }>();
    for (const s of img.segs) {
      for (let p = Math.floor(s.vaddr / PAGE) * PAGE; p < s.vaddr + s.memsz; p += PAGE) {
        const e = pages.get(p) ?? { w: false, x: false };
        pages.set(p, { w: e.w || s.writable, x: e.x || s.exec });
      }
    }
    const sorted = [...pages.keys()].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length;) {
      let j = i;
      const k = pages.get(sorted[i])!;
      while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + PAGE && pages.get(sorted[j + 1])!.w === k.w && pages.get(sorted[j + 1])!.x === k.x) j++;
      const start = sorted[i], end = sorted[j] + PAGE;
      mem.map(pre + (k.x ? 'text' : k.w ? 'data' : 'rodata'), start, end - start, k.w, img.image.subarray(start - img.lo, end - img.lo));
      i = j + 1;
    }
  }
  mem.map('stack', STACK_TOP - STACK_SIZE, STACK_SIZE, true);
  mem.map('thread (TLS, TCB)', TLS_BASE, tp - TLS_BASE + 0x1000, true);
  if (main.tls) mem.setBytes(tp - tlsSize, main.image.subarray(main.tls.vaddr - main.lo, main.tls.vaddr - main.lo + main.tls.filesz));
  mem.set64(tp, BigInt(tp));
  mem.set64(tp + 0x10, BigInt(tp));
  mem.set64(tp + 0x28, 0x2f8e1d3c5b6a7900n);
  cpu.fsBase = BigInt(tp);
  mem.map('heap', HEAP, HEAP_SIZE);
  mem.map('host data', HOSTDATA, 0x200000, true);
  mem.map('thunks', THUNKS, 0x10000, false);
  for (const [p, v] of pendingData) mem.set64(p, v);
  pendingData.length = 0;
  for (const [img, copies] of copyRelocs) for (const [where, si, size] of copies) {
    const s = img.syms[si];
    // the definition elsewhere (a host variable): copy its bytes into the program, which then owns it
    let src = 0;
    for (const other of images) { if (other === img) continue; const d = other.syms.find((x) => x.name === s.name && x.shndx !== 0); if (d) { src = d.value + other.base; break; } }
    if (!src) src = lookup(s.name, img, false);
    mem.setBytes(where, mem.bytes(src, size));
    dataSyms.set(s.name, where);
  }

  // ---------------------------------------------------------------- the initial stack: argc, argv, envp, auxv
  const argvList = ['program', ...(opts.args ?? [])];
  let sp = STACK_TOP - 64;
  const strPtrs: number[] = [];
  for (const a of [...argvList].reverse()) {
    const b = new TextEncoder().encode(a + '\0');
    sp -= b.length;
    mem.setBytes(sp, b);
    strPtrs.unshift(sp);
  }
  sp -= 16;
  const random = sp;
  for (let i = 0; i < 16; i++) mem.set8(random + i, (i * 37 + 11) & 0xff);
  const words: bigint[] = [BigInt(argvList.length), ...strPtrs.map(BigInt), 0n, 0n, 6n, BigInt(PAGE), 25n, BigInt(random), 9n, BigInt(main.entry), 0n, 0n];
  sp = Math.floor((sp - 8 * words.length) / 16) * 16;
  words.forEach((w, i) => mem.set64(sp + 8 * i, w));
  argvInfo = { argc: argvList.length, argv: sp + 8, envp: sp + 8 * (argvList.length + 2) };
  for (const [name, p] of dataSyms) if (name === 'environ' || name === '__environ') mem.set64(p, BigInt(argvInfo.envp));

  cpu.rsp = BigInt(sp);
  cpu.rip = main.entry;
  let exitCode: number | null = null, error: string | null = null;
  try {
    // constructors of the libraries, the last needed first
    for (const img of images.slice(1).reverse()) runInit(img);
    cpu.r[2] = BigInt(DL_FINI);   // rdx at the entry point: the loader's _dl_fini, for the program to register with atexit
    cpu.run();
  } catch (e) {
    if (e instanceof ExitSignal) exitCode = e.code;
    else if (e instanceof EmuError) error = e.message + (e.pc >= 0 ? '' : ` (rip 0x${cpu.rip.toString(16)}${names.has(cpu.rip) ? `, in ${names.get(cpu.rip)}` : ''})`);
    else error = (e as Error).message ?? String(e);
  }
  files.closeAll();
  const t1 = dec1.decode(), t2 = dec2.decode();
  if (opts.onOutput) { if (t1) opts.onOutput(t1, 1); if (t2) opts.onOutput(t2, 2); }
  return {
    stdout: new TextDecoder().decode(new Uint8Array(out)),
    stderr: new TextDecoder().decode(new Uint8Array(err)),
    exitCode: exitCode === null ? null : exitCode & 0xff, steps: cpu.steps, error,
  };
}

function cmpBytes(a: Uint8Array, b: Uint8Array, n: number, raw = false): number {
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

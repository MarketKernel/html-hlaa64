// ELF64 linker for x86-64 Linux: turns one assembled program (XAssembly) into an executable or a
// shared library (.so), dynamically linked against glibc (libc.so.6, libm.so.6) through
// /lib64/ld-linux-x86-64.so.2. Imports are resolved by name against the glibc export lists
// (src/asm/elf/glibc.ts) or caller-supplied libraries; calls go through `jmp [GOT]` stubs, the GOT is
// filled by the dynamic loader at start (BIND_NOW, GLOB_DAT relocations), and every glibc symbol is asked
// for in its default version (.gnu.version_r: memcpy@GLIBC_2.14, as ld does; without versions glibc would
// bind the oldest compatibility version of each function, like realpath@GLIBC_2.2.5).
//
// Layout (each segment starts on a new page in memory, but the file is contiguous):
//   R   ELF header, program headers, .interp, .hash, .dynsym, .dynstr, .rela.dyn
//   RX  .text (+ the stubs)
//   R   .rodata
//   RW  .dynamic, .got, .data, .bss
// followed by .symtab/.strtab and the section headers (for nm, objdump, gdb).
import { AsmError } from '../parse.ts';
import { SCN_EXEC, SCN_WRITE, type XAssembly, type XSection } from '../x64/assembler.ts';
import { glibcLibraryOf } from './glibc.ts';
import { StrTab, symbolSizes } from './object.ts';

export interface ElfOptions {
  kind?: 'exe' | 'so';
  entry?: string;                                    // exe: entry symbol (default hla_start, then _start)
  soname?: string;                                   // so: DT_SONAME (default library.so)
  /** extra shared libraries and the names they export: { "libmathlib.so": ["add", "table"] } */
  libs?: Record<string, string[]>;
}

export interface ElfSegment { type: string; offset: number; vaddr: number; filesz: number; memsz: number; flags: string }
export interface ElfSection { name: string; addr: number; offset: number; size: number; flags: string }

export interface ElfResult {
  bytes: Uint8Array;
  base: number;                                      // address of the first byte of the file (0 for a .so)
  entry: number;                                     // 0 for a .so
  interp: string | null;
  segments: ElfSegment[];
  sections: ElfSection[];
  needed: string[];
  imports: { lib: string; names: string[] }[];       // lib '' (a .so): left for the program that loads it
  exports: string[];
  symbols: { name: string; addr: number }[];
  listing: { addr: number; bytes: number[]; line: number; sect: string }[];
}

export const INTERP = '/lib64/ld-linux-x86-64.so.2';
const PAGE = 0x1000;
const EXE_BASE = 0x400000;
const align = (v: number, a: number) => Math.ceil(v / a) * a;

const R_X86_64_64 = 1, R_X86_64_GLOB_DAT = 6, R_X86_64_RELATIVE = 8;
const DT = { NULL: 0, NEEDED: 1, HASH: 4, STRTAB: 5, SYMTAB: 6, RELA: 7, RELASZ: 8, RELAENT: 9, STRSZ: 10, SYMENT: 11, SONAME: 14, DEBUG: 21, FLAGS: 30, RELACOUNT: 0x6ffffff9, FLAGS_1: 0x6ffffffb, VERSYM: 0x6ffffff0, VERNEED: 0x6ffffffe, VERNEEDNUM: 0x6fffffff };

/** the SysV ELF hash of a symbol name (DT_HASH) */
export function elfHash(name: string): number {
  let h = 0;
  for (const b of new TextEncoder().encode(name)) {
    h = ((h << 4) + b) >>> 0;
    const g = h & 0xf0000000;
    if (g) h ^= g >>> 24;
    h &= ~g >>> 0;
  }
  return h >>> 0;
}

export function linkElf(asmb: XAssembly, opts: ElfOptions = {}): ElfResult {
  const so = opts.kind === 'so';
  const base = so ? 0 : EXE_BASE;
  const syms = asmb.symbols;

  // ---------------------------------------------------------------- imports
  const libOf = (name: string): { lib: string; data: boolean; version?: string } | null => {
    for (const [lib, names] of Object.entries(opts.libs ?? {})) if (names.includes(name)) return { lib, data: false };
    return glibcLibraryOf(name);
  };
  const imports = new Map<string, { lib: string; data: boolean; version?: string }>();
  const needPlt = new Set<string>(), needGot = new Set<string>();
  for (const s of asmb.sections) {
    for (const f of s.fixups) {
      if (f.kind === 'rva') throw new AsmError(`.rva (image-relative address of '${f.sym}') exists only on Windows`, f.line);
      if (f.kind === 'got') { needGot.add(f.sym); if (f.add) throw new AsmError(`${f.sym}@GOTPCREL cannot have an offset`, f.line); }
      if (syms.has(f.sym)) continue;
      let l = libOf(f.sym);
      if (!l) {
        if (!so) throw new AsmError(`undefined symbol '${f.sym}': not defined here and not exported by ${[...Object.keys(opts.libs ?? {}), 'libc.so.6', 'libm.so.6'].join(', ')}`, f.line);
        l = { lib: '', data: f.kind !== 'rel' || !f.branch };    // a .so may use what the program defines
      }
      imports.set(f.sym, l);
      if (f.kind === 'rel') {
        if (l.data) throw new AsmError(`'${f.sym}' is a variable of ${l.lib}: reach it through the GOT, mov rax, qword ptr [rip + ${f.sym}@GOTPCREL]`, f.line);
        needPlt.add(f.sym);
      }
      if (f.kind === 'abs' && f.size !== 8) throw new AsmError(`32-bit address of '${f.sym}' from a shared library`, f.line);
    }
  }
  for (const n of needPlt) needGot.add(n);
  const needed = [...new Set([...imports.values()].map((l) => l.lib).filter((l) => l))]
    .sort((a, b) => (a === 'libc.so.6' ? 1 : b === 'libc.so.6' ? -1 : a.localeCompare(b)));

  // ---------------------------------------------------------------- dynamic symbols and strings
  const exported = so ? [...syms.values()].filter((d) => d.global).map((d) => d.name).sort() : [];
  const dynNames = [...[...imports.keys()].sort(), ...exported];
  const dynstr = new StrTab();
  const neededOff = needed.map((n) => dynstr.add(n));
  const sonameOff = so ? dynstr.add(opts.soname ?? 'library.so') : 0;
  const dynIndex = new Map<string, number>();
  dynNames.forEach((n, i) => { dynIndex.set(n, i + 1); dynstr.add(n); });
  // symbol versions: one Verneed per library, one Vernaux per version asked of it (indices from 2)
  const verneed: { lib: string; vers: { name: string; index: number }[] }[] = [];
  const verIndex = new Map<string, number>();
  for (const lib of needed) {
    const vers = [...new Set([...imports.values()].filter((l) => l.lib === lib && l.version).map((l) => l.version!))].sort();
    if (!vers.length) continue;
    verneed.push({ lib, vers: vers.map((name) => { const index = verIndex.size + 2; verIndex.set(lib + '@' + name, index); dynstr.add(name); return { name, index }; }) });
  }
  const versym = [0, ...dynNames.map((n) => { const l = imports.get(n); return l?.version ? verIndex.get(l.lib + '@' + l.version)! : 1; })];
  const verneedSize = verneed.reduce((a, v) => a + 16 + 16 * v.vers.length, 0);
  const ndyn = dynNames.length + 1;

  // ---------------------------------------------------------------- output sections
  type Out = { name: string; parts: { s: XSection; off: number }[]; data: number[]; addr: number; off: number; size: number; nobits: boolean };
  const mk = (name: string, nobits = false): Out => ({ name, parts: [], data: [], addr: 0, off: 0, size: 0, nobits });
  const text = mk('.text'), rodata = mk('.rodata'), data = mk('.data'), bss = mk('.bss', true);
  const place = (o: Out, s: XSection) => {
    const a = Math.max(1, s.align);
    while (o.data.length % a) o.data.push(o === text ? 0xcc : 0);
    o.parts.push({ s, off: o.data.length });
    if (s.zerofill) o.data.push(...new Array(s.size).fill(0));
    else o.data.push(...s.data);
  };
  for (const s of asmb.sections) {
    if (s.flags & SCN_EXEC) place(text, s);
    else if (s.zerofill) place(bss, s);
    else if (s.flags & SCN_WRITE) place(data, s);
    else place(rodata, s);
  }
  // stubs for calls to imported functions: jmp qword ptr [rip + GOT]
  const stubOff = new Map<string, number>();
  for (const n of [...needPlt].sort()) {
    while (text.data.length % 8) text.data.push(0xcc);
    stubOff.set(n, text.data.length);
    text.data.push(0xff, 0x25, 0, 0, 0, 0, 0xcc, 0xcc);
  }
  const gotNames = [...needGot].sort();
  const gotSlot = new Map(gotNames.map((n, i) => [n, 8 * i]));
  const got = mk('.got');
  got.data = new Array(8 * gotNames.length).fill(0);

  // ---------------------------------------------------------------- dynamic relocations (counted before layout)
  // GOT entries of imports: GLOB_DAT; GOT entries of own symbols: RELATIVE in a .so, the address in an executable;
  // 64-bit addresses in data: RELATIVE in a .so, R_X86_64_64 for imports
  // a .so's own exported symbol in the GOT stays interposable: GLOB_DAT, so that it follows a program's copy
  const preemptible = (n: string) => so && exported.includes(n);
  let nrela = 0, nrelative = 0;
  for (const n of gotNames) if (imports.has(n) || so) { nrela++; if (!imports.has(n) && !preemptible(n)) nrelative++; }
  for (const s of asmb.sections) for (const f of s.fixups) if (f.kind === 'abs' && (imports.has(f.sym) || so)) { nrela++; if (!imports.has(f.sym) && !preemptible(f.sym)) nrelative++; }

  // ---------------------------------------------------------------- layout
  const interp = so ? null : INTERP;
  const nph = (interp ? 2 : 0) + 4 + 2;          // PHDR, INTERP (executable), 4 LOAD, DYNAMIC, GNU_STACK
  let off = 64 + 56 * nph;
  const hdr = { interp: 0, hash: 0, dynsym: 0, dynstr: 0, versym: 0, verneed: 0, rela: 0, end: 0 };
  if (interp) { hdr.interp = off; off += interp.length + 1; }
  off = align(off, 8);
  const nbucket = Math.max(1, Math.min(ndyn, 1 << Math.ceil(Math.log2(Math.max(1, ndyn)))));
  hdr.hash = off; off += 4 * (2 + nbucket + ndyn);
  off = align(off, 8);
  hdr.dynsym = off; off += 24 * ndyn;
  hdr.dynstr = off; off += dynstr.bytes.length;
  if (verneed.length) {
    off = align(off, 2);
    hdr.versym = off; off += 2 * ndyn;
    off = align(off, 8);
    hdr.verneed = off; off += verneedSize;
  }
  off = align(off, 8);
  hdr.rela = off; off += 24 * nrela;
  hdr.end = off;
  // each further segment starts on a new page in memory, at the same offset within the page as in the file
  let vaddr = base + off;
  const segStart = (alignTo: number) => {
    off = align(off, alignTo);
    vaddr = align(vaddr, PAGE) + (off % PAGE);
    if (vaddr - base < off) vaddr += PAGE;
    return { off, vaddr };
  };
  const put = (o: Out, a: number) => {
    off = align(off, a); vaddr = align(vaddr, a);
    o.off = off; o.addr = vaddr; o.size = o.data.length;
    off += o.nobits ? 0 : o.size; vaddr += o.size;
  };
  // an output section is aligned like its most aligned part (at most a page: segments start on one)
  const alignOf = (o: Out) => {
    const a = Math.max(16, ...o.parts.map((p) => p.s.align));
    if (a > PAGE) throw new AsmError(`alignment ${a} of ${o.parts.find((p) => p.s.align === a)!.s.name} is more than a page`, 0);
    return a;
  };
  const textSeg = segStart(16); put(text, alignOf(text));
  const textEnd = { off, vaddr };
  const roSeg = segStart(16); put(rodata, alignOf(rodata));
  const roEnd = { off, vaddr };
  const rwSeg = segStart(8);
  const dynamic = mk('.dynamic');
  const dynEntries: [number, number][] = [];
  const dyn = (tag: number, v = 0) => dynEntries.push([tag, v]);
  needed.forEach((_, i) => dyn(DT.NEEDED, neededOff[i]));
  if (so) dyn(DT.SONAME, sonameOff);
  dyn(DT.HASH); dyn(DT.STRTAB); dyn(DT.SYMTAB); dyn(DT.STRSZ, dynstr.bytes.length); dyn(DT.SYMENT, 24);
  if (verneed.length) { dyn(DT.VERSYM); dyn(DT.VERNEED); dyn(DT.VERNEEDNUM, verneed.length); }
  if (nrela) { dyn(DT.RELA); dyn(DT.RELASZ, 24 * nrela); dyn(DT.RELAENT, 24); }
  if (nrelative) dyn(DT.RELACOUNT, nrelative);
  dyn(DT.FLAGS, 8);            // DF_BIND_NOW: every GOT entry is filled before the program starts
  dyn(DT.FLAGS_1, 1);          // DF_1_NOW
  if (!so) dyn(DT.DEBUG);
  dyn(DT.NULL);
  dynamic.data = new Array(16 * dynEntries.length).fill(0);
  put(dynamic, 8); put(got, 8); put(data, alignOf(data));
  const rwFileEnd = { off, vaddr };
  put(bss, alignOf(bss));
  const rwEnd = vaddr;
  const fileEnd = off;
  const addrOfHdr = (o: number) => base + o;

  // ---------------------------------------------------------------- symbol addresses
  const secAddr = new Map<XSection, number>();
  for (const o of [text, rodata, data, bss]) for (const part of o.parts) secAddr.set(part.s, o.addr + part.off);
  const addrOf = (name: string, line: number): number => {
    const d = syms.get(name);
    if (d) return secAddr.get(d.sect)! + d.off;
    if (stubOff.has(name)) return text.addr + stubOff.get(name)!;
    throw new AsmError(`undefined symbol '${name}'`, line);
  };
  const writable = (s: XSection) => s.zerofill || (s.flags & SCN_WRITE) !== 0;

  // ---------------------------------------------------------------- resolve fixups, collect dynamic relocations
  const relative: [number, bigint][] = [], symbolic: [number, number, number, bigint][] = [];   // [where, (sym, type,) addend]
  const patches: { o: Out; at: number; size: number; v: bigint }[] = [];
  const outOf = (s: XSection) => [text, rodata, data, bss].find((o) => o.parts.some((p) => p.s === s))!;
  for (const s of asmb.sections) {
    const o = outOf(s);
    const partOff = o.parts.find((p) => p.s === s)!.off;
    for (const f of s.fixups) {
      const at = partOff + f.off;
      const pc = o.addr + partOff + f.end;
      let v: bigint;
      if (f.kind === 'got') v = BigInt(got.addr + gotSlot.get(f.sym)!) - BigInt(pc);
      else if (f.kind === 'rel') {
        v = BigInt(addrOf(f.sym, f.line)) + f.add - BigInt(pc);
        const lim = f.size === 1 ? 128n : 1n << 31n;
        if (v < -lim || v >= lim) throw new AsmError(`'${f.sym}' is out of range`, f.line);
      } else {
        // an absolute address
        if (imports.has(f.sym) || so) {
          if (!writable(s)) throw new AsmError(`the address of '${f.sym}' in read-only ${s.name} would need a load-time fix-up: put the table in writable data`, f.line);
          if (f.size !== 8) throw new AsmError(`32-bit address of '${f.sym}' in a position-independent image`, f.line);
          // an import, or an export of a .so (which a program's copy relocation may move): by name
          if (imports.has(f.sym) || preemptible(f.sym)) { symbolic.push([o.addr + at, dynIndex.get(f.sym)!, R_X86_64_64, f.add]); v = 0n; }
          else { v = BigInt(addrOf(f.sym, f.line)) + f.add; relative.push([o.addr + at, v]); }
        } else {
          v = BigInt(addrOf(f.sym, f.line)) + f.add;
          if (f.size === 4 && v >= 1n << 32n) throw new AsmError(`the address of '${f.sym}' does not fit in 32 bits`, f.line);
        }
      }
      if (!s.zerofill) patches.push({ o, at, size: f.size, v });
    }
  }
  for (const n of gotNames) {
    const slot = got.addr + gotSlot.get(n)!;
    if (imports.has(n) || preemptible(n)) symbolic.push([slot, dynIndex.get(n)!, R_X86_64_GLOB_DAT, 0n]);
    else {
      const a = BigInt(addrOf(n, 0));
      if (so) relative.push([slot, a]);
      const u = BigInt.asUintN(64, a);
      for (let i = 0; i < 8; i++) got.data[gotSlot.get(n)! + i] = Number((u >> BigInt(8 * i)) & 0xffn);
    }
  }
  for (const p of patches) {
    const u = BigInt.asUintN(p.size * 8, p.v);
    for (let i = 0; i < p.size; i++) p.o.data[p.at + i] = Number((u >> BigInt(8 * i)) & 0xffn);
  }
  for (const [n, so2] of stubOff) {
    const d = BigInt(got.addr + gotSlot.get(n)!) - BigInt(text.addr + so2 + 6);
    const u = BigInt.asUintN(32, d);
    for (let i = 0; i < 4; i++) text.data[so2 + 2 + i] = Number((u >> BigInt(8 * i)) & 0xffn);
  }
  if (relative.length + symbolic.length !== nrela) throw new Error(`internal: ${relative.length + symbolic.length} dynamic relocations, expected ${nrela}`);

  // ---------------------------------------------------------------- .dynamic values
  const dynVal: Record<number, number> = {
    [DT.HASH]: addrOfHdr(hdr.hash), [DT.STRTAB]: addrOfHdr(hdr.dynstr), [DT.SYMTAB]: addrOfHdr(hdr.dynsym), [DT.RELA]: addrOfHdr(hdr.rela),
    [DT.VERSYM]: addrOfHdr(hdr.versym), [DT.VERNEED]: addrOfHdr(hdr.verneed),
  };
  {
    const dv = new DataView(new ArrayBuffer(dynamic.data.length));
    dynEntries.forEach(([tag, v], i) => { dv.setBigInt64(16 * i, BigInt(tag), true); dv.setBigUint64(16 * i + 8, BigInt(dynVal[tag] ?? v), true); });
    dynamic.data = [...new Uint8Array(dv.buffer)];
  }

  // ---------------------------------------------------------------- entry
  let entry = 0;
  if (!so) {
    const name = opts.entry ?? (syms.has('hla_start') ? 'hla_start' : syms.has('_start') ? '_start' : null);
    if (!name || !syms.has(name)) throw new AsmError(`no entry point: define ${opts.entry ?? 'hla_start or _start'}`, 0);
    entry = addrOf(name, 0);
  }

  // ---------------------------------------------------------------- .symtab (all named symbols, for tools)
  const strtab = new StrTab();
  const sizes = symbolSizes(asmb);
  const allSyms = [...syms.values()].filter((d) => !d.name.startsWith('.L'));
  const locals = allSyms.filter((d) => !d.global), globals = allSyms.filter((d) => d.global);
  const symtabBytes: number[] = new Array(24).fill(0);
  const outSections = [text, rodata, dynamic, got, data, bss];
  const symEnt = (name: number, info: number, shndx: number, value: number, size: number) => {
    const dv = new DataView(new ArrayBuffer(24));
    dv.setUint32(0, name, true); dv.setUint8(4, info); dv.setUint16(6, shndx, true);
    dv.setBigUint64(8, BigInt(value), true); dv.setBigUint64(16, BigInt(size), true);
    return [...new Uint8Array(dv.buffer)];
  };
  // section header indices are known once the list below is built; symbols point at .text/.rodata/.data/.bss
  const shIndexOf = new Map<Out, number>();
  const symOf = (d: (typeof allSyms)[number], bind: number) => {
    const o = outOf(d.sect);
    const type = d.func || d.sect.flags & SCN_EXEC ? 2 : 1;
    return symEnt(strtab.add(d.name), (bind << 4) | type, shIndexOf.get(o) ?? 0, secAddr.get(d.sect)! + d.off, sizes.get(d.name) ?? 0);
  };

  // ---------------------------------------------------------------- section headers
  type Sh = { name: string; type: number; flags: number; addr: number; off: number; size: number; link: number; info: number; align: number; entsize: number };
  const shs: Sh[] = [{ name: '', type: 0, flags: 0, addr: 0, off: 0, size: 0, link: 0, info: 0, align: 0, entsize: 0 }];
  const A = 2, W = 1, X = 4;
  if (interp) shs.push({ name: '.interp', type: 1, flags: A, addr: addrOfHdr(hdr.interp), off: hdr.interp, size: interp.length + 1, link: 0, info: 0, align: 1, entsize: 0 });
  const iDynsym = shs.length + 1, iDynstr = shs.length + 2;
  shs.push({ name: '.hash', type: 5, flags: A, addr: addrOfHdr(hdr.hash), off: hdr.hash, size: 4 * (2 + nbucket + ndyn), link: iDynsym, info: 0, align: 8, entsize: 4 });
  shs.push({ name: '.dynsym', type: 11, flags: A, addr: addrOfHdr(hdr.dynsym), off: hdr.dynsym, size: 24 * ndyn, link: iDynstr, info: 1, align: 8, entsize: 24 });
  shs.push({ name: '.dynstr', type: 3, flags: A, addr: addrOfHdr(hdr.dynstr), off: hdr.dynstr, size: dynstr.bytes.length, link: 0, info: 0, align: 1, entsize: 0 });
  if (verneed.length) {
    shs.push({ name: '.gnu.version', type: 0x6fffffff, flags: A, addr: addrOfHdr(hdr.versym), off: hdr.versym, size: 2 * ndyn, link: iDynsym, info: 0, align: 2, entsize: 2 });
    shs.push({ name: '.gnu.version_r', type: 0x6ffffffe, flags: A, addr: addrOfHdr(hdr.verneed), off: hdr.verneed, size: verneedSize, link: iDynstr, info: verneed.length, align: 8, entsize: 0 });
  }
  if (nrela) shs.push({ name: '.rela.dyn', type: 4, flags: A, addr: addrOfHdr(hdr.rela), off: hdr.rela, size: 24 * nrela, link: iDynsym, info: 0, align: 8, entsize: 24 });
  const secFlags: Record<string, number> = { '.text': A | X, '.rodata': A, '.dynamic': A | W, '.got': A | W, '.data': A | W, '.bss': A | W };
  for (const o of outSections) {
    if (!o.size) continue;
    shIndexOf.set(o, shs.length);
    shs.push({ name: o.name, type: o.nobits ? 8 : o === dynamic ? 6 : 1, flags: secFlags[o.name], addr: o.addr, off: o.off, size: o.size, link: o === dynamic ? iDynstr : 0, info: 0, align: o === dynamic || o === got ? 8 : 16, entsize: o === dynamic ? 16 : o === got ? 8 : 0 });
  }
  for (const d of locals) symtabBytes.push(...symOf(d, 0));
  for (const d of globals) symtabBytes.push(...symOf(d, 1));
  const iSymtab = shs.length;
  shs.push({ name: '.symtab', type: 2, flags: 0, addr: 0, off: 0, size: symtabBytes.length, link: iSymtab + 1, info: 1 + locals.length, align: 8, entsize: 24 });
  shs.push({ name: '.strtab', type: 3, flags: 0, addr: 0, off: 0, size: strtab.bytes.length, link: 0, info: 0, align: 1, entsize: 0 });
  const shstr = new StrTab();
  const shNames = shs.map((h) => shstr.add(h.name));
  shNames.push(shstr.add('.shstrtab'));
  shs.push({ name: '.shstrtab', type: 3, flags: 0, addr: 0, off: 0, size: shstr.bytes.length, link: 0, info: 0, align: 1, entsize: 0 });
  let tail = align(fileEnd, 8);
  const symtabOff = tail; tail += symtabBytes.length;
  const strtabOff = tail; tail += strtab.bytes.length;
  const shstrOff = tail; tail += shstr.bytes.length;
  shs[iSymtab].off = symtabOff; shs[iSymtab + 1].off = strtabOff; shs[iSymtab + 2].off = shstrOff;
  const shoff = align(tail, 8);
  const total = shoff + 64 * shs.length;

  // ---------------------------------------------------------------- write
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
  dv.setUint16(16, so ? 3 : 2, true);        // ET_DYN / ET_EXEC
  dv.setUint16(18, 62, true);
  dv.setUint32(20, 1, true);
  dv.setBigUint64(24, BigInt(entry), true);
  dv.setBigUint64(32, 64n, true);
  dv.setBigUint64(40, BigInt(shoff), true);
  dv.setUint16(52, 64, true);
  dv.setUint16(54, 56, true);
  dv.setUint16(56, nph, true);
  dv.setUint16(58, 64, true);
  dv.setUint16(60, shs.length, true);
  dv.setUint16(62, shs.length - 1, true);

  const segments: ElfSegment[] = [];
  const ph: { type: number; flags: number; off: number; vaddr: number; filesz: number; memsz: number; align: number }[] = [];
  const PF_X = 1, PF_W = 2, PF_R = 4;
  const phSize = 56 * nph;
  if (!so) ph.push({ type: 6, flags: PF_R, off: 64, vaddr: base + 64, filesz: phSize, memsz: phSize, align: 8 });   // PT_PHDR
  if (interp) ph.push({ type: 3, flags: PF_R, off: hdr.interp, vaddr: addrOfHdr(hdr.interp), filesz: interp.length + 1, memsz: interp.length + 1, align: 1 });
  ph.push({ type: 1, flags: PF_R, off: 0, vaddr: base, filesz: hdr.end, memsz: hdr.end, align: PAGE });
  ph.push({ type: 1, flags: PF_R | PF_X, off: textSeg.off, vaddr: textSeg.vaddr, filesz: textEnd.off - textSeg.off, memsz: textEnd.vaddr - textSeg.vaddr, align: PAGE });
  ph.push({ type: 1, flags: PF_R, off: roSeg.off, vaddr: roSeg.vaddr, filesz: roEnd.off - roSeg.off, memsz: roEnd.vaddr - roSeg.vaddr, align: PAGE });
  ph.push({ type: 1, flags: PF_R | PF_W, off: rwSeg.off, vaddr: rwSeg.vaddr, filesz: rwFileEnd.off - rwSeg.off, memsz: rwEnd - rwSeg.vaddr, align: PAGE });
  ph.push({ type: 2, flags: PF_R | PF_W, off: dynamic.off, vaddr: dynamic.addr, filesz: dynamic.size, memsz: dynamic.size, align: 8 });   // PT_DYNAMIC
  ph.push({ type: 0x6474e551, flags: PF_R | PF_W, off: 0, vaddr: 0, filesz: 0, memsz: 0, align: 16 });                                  // PT_GNU_STACK
  const typeName: Record<number, string> = { 1: 'LOAD', 2: 'DYNAMIC', 3: 'INTERP', 6: 'PHDR', 0x6474e551: 'GNU_STACK' };
  ph.forEach((p, i) => {
    const o = 64 + 56 * i;
    dv.setUint32(o, p.type, true); dv.setUint32(o + 4, p.flags, true);
    dv.setBigUint64(o + 8, BigInt(p.off), true); dv.setBigUint64(o + 16, BigInt(p.vaddr), true); dv.setBigUint64(o + 24, BigInt(p.vaddr), true);
    dv.setBigUint64(o + 32, BigInt(p.filesz), true); dv.setBigUint64(o + 40, BigInt(p.memsz), true); dv.setBigUint64(o + 48, BigInt(p.align), true);
    segments.push({ type: typeName[p.type], offset: p.off, vaddr: p.vaddr, filesz: p.filesz, memsz: p.memsz, flags: (p.flags & PF_R ? 'R' : '') + (p.flags & PF_W ? 'W' : '') + (p.flags & PF_X ? 'X' : '') });
  });
  if (ph.length !== nph) throw new Error('internal: program header count');

  if (interp) buf.set(new TextEncoder().encode(interp), hdr.interp);
  // .hash
  {
    const buckets = new Array(nbucket).fill(0), chains = new Array(ndyn).fill(0);
    for (let i = 1; i < ndyn; i++) {
      const b = elfHash(dynNames[i - 1]) % nbucket;
      chains[i] = buckets[b];
      buckets[b] = i;
    }
    [nbucket, ndyn, ...buckets, ...chains].forEach((v, i) => dv.setUint32(hdr.hash + 4 * i, v, true));
  }
  // .dynsym: imports undefined, exports defined
  dynNames.forEach((n, i) => {
    const o = hdr.dynsym + 24 * (i + 1);
    const d = syms.get(n);
    dv.setUint32(o, dynstr.add(n), true);
    if (d && !imports.has(n)) {
      const type = d.func || d.sect.flags & SCN_EXEC ? 2 : 1;
      dv.setUint8(o + 4, (1 << 4) | type);
      dv.setUint16(o + 6, shIndexOf.get(outOf(d.sect)) ?? 0, true);
      dv.setBigUint64(o + 8, BigInt(addrOf(n, 0)), true);
      dv.setBigUint64(o + 16, BigInt(sizes.get(n) ?? 0), true);
    } else {
      dv.setUint8(o + 4, (1 << 4) | (imports.get(n)!.data ? 1 : 2));
    }
  });
  buf.set(dynstr.bytes, hdr.dynstr);
  // .gnu.version: the version index of every dynamic symbol (1: global, unversioned); .gnu.version_r: what is asked of each library
  if (verneed.length) {
    versym.forEach((v, i) => dv.setUint16(hdr.versym + 2 * i, v, true));
    let o = hdr.verneed;
    verneed.forEach((vn, k) => {
      dv.setUint16(o, 1, true);                                   // vn_version
      dv.setUint16(o + 2, vn.vers.length, true);                  // vn_cnt
      dv.setUint32(o + 4, dynstr.add(vn.lib), true);              // vn_file
      dv.setUint32(o + 8, 16, true);                              // vn_aux
      dv.setUint32(o + 12, k + 1 < verneed.length ? 16 + 16 * vn.vers.length : 0, true);   // vn_next
      vn.vers.forEach((v, j) => {
        const a = o + 16 + 16 * j;
        dv.setUint32(a, elfHash(v.name), true);                   // vna_hash
        dv.setUint16(a + 4, 0, true);                             // vna_flags
        dv.setUint16(a + 6, v.index, true);                       // vna_other: the index in .gnu.version
        dv.setUint32(a + 8, dynstr.add(v.name), true);            // vna_name
        dv.setUint32(a + 12, j + 1 < vn.vers.length ? 16 : 0, true);   // vna_next
      });
      o += 16 + 16 * vn.vers.length;
    });
  }
  // .rela.dyn: RELATIVE first (DT_RELACOUNT)
  let ro = hdr.rela;
  for (const [where, v] of relative) {
    dv.setBigUint64(ro, BigInt(where), true); dv.setBigUint64(ro + 8, BigInt(R_X86_64_RELATIVE), true); dv.setBigInt64(ro + 16, BigInt.asIntN(64, v), true); ro += 24;
  }
  for (const [where, si, type, add] of symbolic) {
    dv.setBigUint64(ro, BigInt(where), true); dv.setBigUint64(ro + 8, (BigInt(si) << 32n) | BigInt(type), true); dv.setBigInt64(ro + 16, add, true); ro += 24;
  }
  for (const o of [text, rodata, dynamic, got, data]) if (o.size) buf.set(o.data, o.off);
  buf.set(symtabBytes, symtabOff);
  buf.set(strtab.bytes, strtabOff);
  buf.set(shstr.bytes, shstrOff);
  shs.forEach((h, i) => {
    const o = shoff + 64 * i;
    dv.setUint32(o, shNames[i], true); dv.setUint32(o + 4, h.type, true);
    dv.setBigUint64(o + 8, BigInt(h.flags), true); dv.setBigUint64(o + 16, BigInt(h.addr), true);
    dv.setBigUint64(o + 24, BigInt(h.off), true); dv.setBigUint64(o + 32, BigInt(h.size), true);
    dv.setUint32(o + 40, h.link, true); dv.setUint32(o + 44, h.info, true);
    dv.setBigUint64(o + 48, BigInt(h.align), true); dv.setBigUint64(o + 56, BigInt(h.entsize), true);
  });

  const listing: ElfResult['listing'] = [];
  for (const s of asmb.sections) {
    if (!(s.flags & SCN_EXEC)) continue;
    for (const ins of s.insns) listing.push({ addr: secAddr.get(s)! + ins.off, bytes: s.data.slice(ins.off, ins.off + ins.len), line: ins.line, sect: '.text' });
  }
  const byLib = new Map<string, string[]>();
  for (const [n, l] of [...imports].sort((a, b) => a[0].localeCompare(b[0]))) { if (!byLib.has(l.lib)) byLib.set(l.lib, []); byLib.get(l.lib)!.push(n); }
  return {
    bytes: buf, base, entry, interp, segments,
    sections: shs.slice(1).filter((h) => h.flags & A).map((h) => ({ name: h.name, addr: h.addr, offset: h.off, size: h.size, flags: (h.flags & A ? 'A' : '') + (h.flags & W ? 'W' : '') + (h.flags & X ? 'X' : '') })),
    needed,
    imports: [...byLib].map(([lib, names]) => ({ lib, names })).sort((a, b) => a.lib.localeCompare(b.lib)),
    exports: exported,
    symbols: allSyms.map((d) => ({ name: d.name, addr: secAddr.get(d.sect)! + d.off })).sort((a, b) => a.addr - b.addr),
    listing,
  };
}

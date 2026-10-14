// PE32+ linker for x86-64 Windows: turns one assembled program (XAssembly) into an
// .exe or a .dll. Imports are resolved by name against msvcrt.dll / kernel32.dll / user32.dll
// (or a caller-supplied map), with an import address table, `jmp [IAT]` stubs for
// direct calls, base relocations for ASLR and the exception directory from .pdata.
import { AsmError } from '../parse.ts';
import type { XAssembly, XSection } from '../x64/assembler.ts';
import { SYSTEM_DLLS, systemExports } from './winapi.ts';

export interface PeOptions {
  kind?: 'exe' | 'dll';
  entry?: string;                          // exe: entry symbol (default hla_start, mainCRTStartup, main)
  dllName?: string;                        // dll: its own file name (export directory)
  imports?: Record<string, string[]>;      // extra symbol -> DLL assignments: { "user32.dll": ["MessageBoxA"] }
  subsystem?: 'console' | 'windows';
}

export interface PeResult {
  bytes: Uint8Array;
  imageBase: number;
  entry: number;                           // VA (0 for a dll without entry)
  sections: { name: string; rva: number; vsize: number; fileSize: number; flags: number }[];
  imports: { dll: string; names: string[] }[];
  exports: string[];
  symbols: { name: string; addr: number }[];
  listing: { addr: number; bytes: number[]; line: number; sect: string }[];
}

const FILE_ALIGN = 0x200, SECT_ALIGN = 0x1000;
const align = (v: number, a: number) => Math.ceil(v / a) * a;

export function linkPE(asmb: XAssembly, opts: PeOptions = {}): PeResult {
  const dll = opts.kind === 'dll';
  const imageBase = dll ? 0x180000000 : 0x140000000;
  const syms = asmb.symbols;
  const dllOf = (name: string): string | null => {
    for (const [d, list] of Object.entries(opts.imports ?? {})) if (list.includes(name)) return d.toLowerCase();
    return SYSTEM_DLLS.find((d) => systemExports(d).has(name)) ?? null;
  };

  // ---------------------------------------------------------------- imports
  const importNames: string[] = [];             // functions to import (without __imp_)
  const needStub = new Set<string>();
  for (const s of asmb.sections) {
    for (const f of s.fixups) {
      if (f.kind === 'got') throw new AsmError(`${f.sym}@GOTPCREL: there is no GOT on Windows (write [rip + ${f.sym}])`, f.line);
      if (syms.has(f.sym)) continue;
      const n = f.sym.startsWith('__imp_') ? f.sym.slice(6) : f.sym;
      if (n === f.sym && f.kind !== 'rel' && f.kind !== 'abs') throw new AsmError(`undefined symbol '${f.sym}'`, f.line);
      if (!dllOf(n)) {
        throw new AsmError(`undefined symbol '${n}': not defined here and not exported by ${[...Object.keys(opts.imports ?? {}), ...SYSTEM_DLLS].join(', ')}`
          + (dll ? ' (a DLL cannot use functions of the program that loads it: link the static library instead)' : ''), f.line);
      }
      if (!importNames.includes(n)) importNames.push(n);
      if (n === f.sym) needStub.add(n);
    }
  }
  const byDll = new Map<string, string[]>();
  for (const n of importNames) {
    const d = dllOf(n)!;
    if (!byDll.has(d)) byDll.set(d, []);
    byDll.get(d)!.push(n);
  }

  // ---------------------------------------------------------------- output sections
  type Out = { name: string; flags: number; parts: { s: XSection; off: number }[]; data: number[]; vsize: number; rva: number; fileOff: number; fileSize: number };
  const mk = (name: string, flags: number): Out => ({ name, flags, parts: [], data: [], vsize: 0, rva: 0, fileOff: 0, fileSize: 0 });
  const text = mk('.text', 0x60000020), rdata = mk('.rdata', 0x40000040), data = mk('.data', 0xc0000040),
    bss = mk('.bss', 0xc0000080), pdata = mk('.pdata', 0x40000040), idata = mk('.idata', 0xc0000040), reloc = mk('.reloc', 0x42000040);
  const place = (o: Out, s: XSection) => {
    const a = Math.max(1, s.align);
    while (o.data.length % a) o.data.push(o === text ? 0xcc : 0);
    o.parts.push({ s, off: o.data.length });
    if (s.zerofill) o.data.push(...new Array(s.size).fill(0));
    else o.data.push(...s.data);
  };
  for (const s of asmb.sections) {
    if (s.flags & 0x20000000) place(text, s);
    else if (s.name === '.pdata') place(pdata, s);
    else if (s.zerofill) place(bss, s);
    else if (s.flags & 0x80000000) place(data, s);
    else place(rdata, s);
  }
  // stubs for direct calls to imported functions: jmp qword ptr [rip + IAT]
  const stubOff = new Map<string, number>();
  for (const n of needStub) {
    while (text.data.length % 8) text.data.push(0xcc);
    stubOff.set(n, text.data.length);
    text.data.push(0xff, 0x25, 0, 0, 0, 0, 0xcc, 0xcc);
  }

  // ---------------------------------------------------------------- import directory (.idata)
  // layout: descriptors | ILTs | IATs | hint/name entries | dll names
  const dlls = [...byDll.keys()].sort();
  const descSize = (dlls.length + 1) * 20;
  let p = descSize;
  const iltOff = new Map<string, number>(), iatOff = new Map<string, number>(), hintOff = new Map<string, number>(), nameOff = new Map<string, number>();
  for (const d of dlls) { iltOff.set(d, p); p += (byDll.get(d)!.length + 1) * 8; }
  const iatStart = p;
  for (const d of dlls) { iatOff.set(d, p); p += (byDll.get(d)!.length + 1) * 8; }
  const iatEnd = p;
  for (const d of dlls) for (const n of byDll.get(d)!) { hintOff.set(d + '!' + n, p); p += align(2 + n.length + 1, 2); }
  for (const d of dlls) { nameOff.set(d, p); p += d.length + 1; }
  if (dlls.length) idata.data = new Array(align(p, 8)).fill(0);
  const iatSlot = (n: string) => { const d = dllOf(n)!; return iatOff.get(d)! + byDll.get(d)!.indexOf(n) * 8; };

  // ---------------------------------------------------------------- export directory (dll)
  const exported = [...syms.values()].filter((x) => x.global).map((x) => x.name).sort();
  let edataOff = -1;
  if (dll) {
    while (rdata.data.length % 8) rdata.data.push(0);
    edataOff = rdata.data.length;
    const n = exported.length;
    const own = (opts.dllName ?? 'library.dll');
    const sizeDir = 40, funcs = sizeDir, names = funcs + 4 * n, ords = names + 4 * n, strs = ords + 2 * n;
    const block: number[] = new Array(strs).fill(0);
    const strBytes: number[] = [];
    const strOffs: number[] = [];
    const ownOff = strs; strBytes.push(...new TextEncoder().encode(own), 0);
    for (const e of exported) { strOffs.push(strs + strBytes.length); strBytes.push(...new TextEncoder().encode(e), 0); }
    rdata.data.push(...block, ...strBytes);
    (rdata as Out & { exportInfo?: unknown }).exportInfo = { n, funcs, names, ords, strs, ownOff, strOffs };
  }

  // ---------------------------------------------------------------- base relocation targets are collected while resolving
  const outs = [text, rdata, data, bss, pdata, idata, reloc];
  const sizeofHeaders = align(0x40 + 4 + 20 + 240 + 40 * outs.length, FILE_ALIGN);
  // first pass: rvas without .reloc (its size depends on the number of relocations)
  const layout = (relocSize: number) => {
    let rva = SECT_ALIGN, file = sizeofHeaders;
    for (const o of outs) {
      const size = o === reloc ? relocSize : o.data.length;
      o.vsize = size;
      if (!size) { o.rva = 0; continue; }
      o.rva = rva;
      rva = align(rva + size, SECT_ALIGN);
      if (o === bss) { o.fileOff = 0; o.fileSize = 0; continue; }
      o.fileOff = file;
      o.fileSize = align(size, FILE_ALIGN);
      file += o.fileSize;
    }
    return { sizeOfImage: rva, fileSize: file };
  };
  let lay = layout(0);
  const secRva = new Map<XSection, number>();
  for (const o of outs) for (const part of o.parts) secRva.set(part.s, o.rva + part.off);
  const symRva = (name: string, line: number): number => {
    const d = syms.get(name);
    if (d) return secRva.get(d.sect)! + d.off;
    if (name.startsWith('__imp_')) return idata.rva + iatSlot(name.slice(6));
    if (stubOff.has(name)) return text.rva + stubOff.get(name)!;
    throw new AsmError(`undefined symbol '${name}'`, line);
  };

  // ---------------------------------------------------------------- resolve fixups
  const dir64: number[] = [];       // RVAs of absolute 64-bit addresses
  const patches: { o: Out; at: number; size: number; v: bigint }[] = [];
  for (const o of outs) {
    for (const part of o.parts) {
      for (const f of part.s.fixups) {
        const at = part.off + f.off;
        const target = BigInt(symRva(f.sym, f.line)) + f.add;
        let v: bigint;
        if (f.kind === 'rel') {
          v = target - BigInt(o.rva + part.off + f.end);
          const lim = f.size === 1 ? 128n : 1n << 31n;
          if (v < -lim || v >= lim) throw new AsmError(`'${f.sym}' is out of range`, f.line);
        } else if (f.kind === 'rva') v = target;
        else {
          if (f.size !== 8) throw new AsmError(`32-bit absolute address of '${f.sym}' is not allowed in a relocatable image`, f.line);
          v = BigInt(imageBase) + target;
          dir64.push(o.rva + at);
        }
        patches.push({ o, at, size: f.size, v });
      }
    }
  }
  for (const [n, off] of stubOff) {
    const disp = idata.rva + iatSlot(n) - (text.rva + off + 6);
    patches.push({ o: text, at: off + 2, size: 4, v: BigInt(disp) });
  }
  // .reloc blocks
  dir64.sort((a, b) => a - b);
  const rel: number[] = [];
  for (let i = 0; i < dir64.length;) {
    const page = dir64[i] & ~0xfff;
    const entries: number[] = [];
    while (i < dir64.length && (dir64[i] & ~0xfff) === page) entries.push((10 << 12) | (dir64[i++] & 0xfff));
    if (entries.length % 2) entries.push(0);
    const size = 8 + entries.length * 2;
    rel.push(...u32(page), ...u32(size));
    for (const e of entries) rel.push(e & 0xff, e >> 8);
  }
  reloc.data = rel;
  lay = layout(rel.length);
  if (reloc.rva === 0 && rel.length) throw new Error('internal: reloc layout');
  for (const pt of patches) put(pt.o.data, pt.at, pt.size, pt.v);

  // fill the import directory
  if (dlls.length) {
    dlls.forEach((d, i) => {
      put(idata.data, i * 20, 4, BigInt(idata.rva + iltOff.get(d)!));
      put(idata.data, i * 20 + 12, 4, BigInt(idata.rva + nameOff.get(d)!));
      put(idata.data, i * 20 + 16, 4, BigInt(idata.rva + iatOff.get(d)!));
      byDll.get(d)!.forEach((n, k) => {
        const hn = BigInt(idata.rva + hintOff.get(d + '!' + n)!);
        put(idata.data, iltOff.get(d)! + k * 8, 8, hn);
        put(idata.data, iatOff.get(d)! + k * 8, 8, hn);
        const ho = hintOff.get(d + '!' + n)!;
        new TextEncoder().encode(n).forEach((b, j) => (idata.data[ho + 2 + j] = b));
      });
      new TextEncoder().encode(d).forEach((b, j) => (idata.data[nameOff.get(d)! + j] = b));
    });
  }
  // fill the export directory
  if (dll) {
    const ex = (rdata as Out & { exportInfo?: { n: number; funcs: number; names: number; ords: number; strs: number; ownOff: number; strOffs: number[] } }).exportInfo!;
    const b = rdata.rva + edataOff;
    const w = (o: number, sz: number, v: number) => put(rdata.data, edataOff + o, sz, BigInt(v));
    w(12, 4, b + ex.ownOff);
    w(16, 4, 1);
    w(20, 4, ex.n);
    w(24, 4, ex.n);
    w(28, 4, b + ex.funcs);
    w(32, 4, b + ex.names);
    w(36, 4, b + ex.ords);
    exported.forEach((name, i) => {
      w(ex.funcs + 4 * i, 4, symRva(name, 0));
      w(ex.names + 4 * i, 4, b + ex.strOffs[i]);
      w(ex.ords + 2 * i, 2, i);
    });
  }

  // ---------------------------------------------------------------- entry point
  let entryRva = 0;
  if (!dll || opts.entry) {
    const cand = opts.entry ? [opts.entry] : ['hla_start', 'mainCRTStartup', 'main'];
    const e = cand.find((n) => syms.has(n));
    if (!e) throw new AsmError(`entry point not found (looked for ${cand.join(', ')})`, 0);
    entryRva = symRva(e, 0);
  }

  // ---------------------------------------------------------------- headers
  const file = new Uint8Array(lay.fileSize);
  const dv = new DataView(file.buffer);
  file[0] = 0x4d; file[1] = 0x5a;                 // MZ
  dv.setUint32(0x3c, 0x40, true);                 // e_lfanew
  const pe = 0x40;
  dv.setUint32(pe, 0x4550, true);                 // PE\0\0
  const used = outs.filter((o) => o.vsize > 0);
  dv.setUint16(pe + 4, 0x8664, true);
  dv.setUint16(pe + 6, used.length, true);
  dv.setUint32(pe + 8, 0, true);                  // reproducible: no timestamp
  dv.setUint16(pe + 20, 240, true);
  dv.setUint16(pe + 22, dll ? 0x2022 : 0x0022, true);   // EXECUTABLE_IMAGE | LARGE_ADDRESS_AWARE (| DLL)
  const op = pe + 24;
  dv.setUint16(op, 0x20b, true);
  file[op + 2] = 14;                              // linker version
  dv.setUint32(op + 4, text.vsize ? align(text.vsize, FILE_ALIGN) : 0, true);
  dv.setUint32(op + 8, [rdata, data, pdata, idata, reloc].reduce((a, o) => a + o.fileSize, 0), true);
  dv.setUint32(op + 12, bss.vsize, true);
  dv.setUint32(op + 16, entryRva, true);
  dv.setUint32(op + 20, text.rva, true);
  dv.setBigUint64(op + 24, BigInt(imageBase), true);
  dv.setUint32(op + 32, SECT_ALIGN, true);
  dv.setUint32(op + 36, FILE_ALIGN, true);
  dv.setUint16(op + 40, 6, true);                 // OS version 6.0
  dv.setUint16(op + 48, 6, true);                 // subsystem version 6.0
  dv.setUint32(op + 56, lay.sizeOfImage, true);
  dv.setUint32(op + 60, sizeofHeaders, true);
  dv.setUint16(op + 68, opts.subsystem === 'windows' ? 2 : 3, true);
  dv.setUint16(op + 70, 0x8160, true);            // HIGH_ENTROPY_VA | DYNAMIC_BASE | NX_COMPAT | TERMINAL_SERVER_AWARE
  dv.setBigUint64(op + 72, 0x100000n, true);      // stack reserve
  dv.setBigUint64(op + 80, 0x1000n, true);        // stack commit
  dv.setBigUint64(op + 88, 0x100000n, true);      // heap reserve
  dv.setBigUint64(op + 96, 0x1000n, true);        // heap commit
  dv.setUint32(op + 108, 16, true);               // number of data directories
  const dirEntry = (i: number, rva: number, size: number) => { dv.setUint32(op + 112 + i * 8, rva, true); dv.setUint32(op + 116 + i * 8, size, true); };
  if (dll) {
    const ex = (rdata as Out & { exportInfo?: { strs: number; strOffs: number[] } }).exportInfo!;
    void ex;
    dirEntry(0, rdata.rva + edataOff, rdata.data.length - edataOff);
  }
  if (dlls.length) {
    dirEntry(1, idata.rva, descSize);
    dirEntry(12, idata.rva + iatStart, iatEnd - iatStart);
  }
  if (pdata.vsize) dirEntry(3, pdata.rva, pdata.vsize);
  if (reloc.vsize) dirEntry(5, reloc.rva, reloc.vsize);
  let sh = op + 240;
  for (const o of used) {
    new TextEncoder().encode(o.name).forEach((b, i) => (file[sh + i] = b));
    dv.setUint32(sh + 8, o.vsize, true);
    dv.setUint32(sh + 12, o.rva, true);
    dv.setUint32(sh + 16, o.fileSize, true);
    dv.setUint32(sh + 20, o.fileOff, true);
    dv.setUint32(sh + 36, o.flags >>> 0, true);
    if (o.fileSize) file.set(o.data, o.fileOff);
    sh += 40;
  }

  const listing: PeResult['listing'] = [];
  for (const o of [text]) for (const part of o.parts) for (const ins of part.s.insns) {
    const at = part.off + ins.off;
    listing.push({ addr: imageBase + o.rva + at, bytes: o.data.slice(at, at + ins.len), line: ins.line, sect: part.s.name });
  }
  for (const [n, off] of stubOff) listing.push({ addr: imageBase + text.rva + off, bytes: text.data.slice(off, off + 6), line: 0, sect: `stub ${n}` });
  return {
    bytes: file,
    imageBase,
    entry: entryRva ? imageBase + entryRva : 0,
    sections: used.map((o) => ({ name: o.name, rva: o.rva, vsize: o.vsize, fileSize: o.fileSize, flags: o.flags })),
    imports: dlls.map((d) => ({ dll: d, names: byDll.get(d)! })),
    exports: exported,
    symbols: [...syms.values()].filter((x) => !x.name.startsWith('.L') && !x.name.startsWith('$')).map((x) => ({ name: x.name, addr: imageBase + secRva.get(x.sect)! + x.off })),
    listing,
  };
}

function u32(v: number): number[] { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]; }

function put(buf: number[], at: number, size: number, v: bigint): void {
  const u = BigInt.asUintN(size * 8, v);
  for (let i = 0; i < size; i++) buf[at + i] = Number((u >> BigInt(8 * i)) & 0xffn);
}

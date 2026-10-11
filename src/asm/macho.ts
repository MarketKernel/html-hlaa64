// Minimal Mach-O linker/writer for arm64 macOS executables.
//
// Produces a PIE executable that links libSystem dynamically:
//   __PAGEZERO | __TEXT (__text, __stubs, consts, strings) | __DATA (__got, data, bss) | __LINKEDIT
// Imports are bound at load time with classic dyld bind opcodes (LC_DYLD_INFO_ONLY),
// internal pointers in data are rebased, and the file gets an ad-hoc code signature
// (required by the kernel on Apple Silicon).
import { AsmError } from './parse.ts';
import type { Assembly, Section } from './assembler.ts';
import { sha256 } from './sha256.ts';

export interface LinkOptions {
  name?: string;              // identifier used in the code signature
  entry?: string;             // entry symbol, default _main
  kind?: 'exe' | 'dylib';     // executable (default) or dynamic library
  installName?: string;       // dylib: LC_ID_DYLIB path, e.g. @rpath/libfoo.dylib
  dylibs?: string[];          // default: libSystem
}

export interface LinkResult {
  bytes: Uint8Array;
  map: { name: string; addr: number; size: number }[];
  symbols: { name: string; addr: number }[];
  imports: string[];
  entryAddr: number;
  /** every instruction: address, final machine word, assembly source line (0 for stubs) */
  listing: { addr: number; word: number; line: number; sect: string }[];
  segments: { name: string; addr: number; vmsize: number; fileOff: number; fileSize: number; prot: string }[];
  signature: { offset: number; size: number; pages: number; cdhash: string };
}

const PAGE = 0x4000;

const LC_SEGMENT_64 = 0x19, LC_SYMTAB = 0x2, LC_DYSYMTAB = 0xb, LC_LOAD_DYLIB = 0xc, LC_LOAD_DYLINKER = 0xe,
  LC_UUID = 0x1b, LC_CODE_SIGNATURE = 0x1d, LC_BUILD_VERSION = 0x32, LC_DYLD_INFO_ONLY = 0x80000022, LC_MAIN = 0x80000028;

const S_NON_LAZY_SYMBOL_POINTERS = 0x6, S_SYMBOL_STUBS = 0x8;
const S_ATTR_PURE_INSTRUCTIONS = 0x80000000, S_ATTR_SOME_INSTRUCTIONS = 0x400;
const INDIRECT_SYMBOL_LOCAL = 0x80000000;

const align = (v: number, a: number) => Math.ceil(v / a) * a;

class Buf {
  data: number[] = [];
  u8(v: number) { this.data.push(v & 0xff); }
  u16(v: number) { this.u8(v); this.u8(v >>> 8); }
  u32(v: number) { for (let i = 0; i < 4; i++) this.u8(v >>> (8 * i)); }
  u64(v: number | bigint) {
    const b = BigInt(v);
    for (let i = 0n; i < 8n; i++) this.u8(Number((b >> (8n * i)) & 0xffn));
  }
  str(s: string, len: number) {
    const b = new TextEncoder().encode(s);
    for (let i = 0; i < len; i++) this.u8(i < b.length ? b[i] : 0);
  }
  cstr(s: string) { for (const c of new TextEncoder().encode(s)) this.u8(c); this.u8(0); }
  uleb(v: number) {
    do {
      let b = v % 128;
      v = Math.floor(v / 128);
      if (v) b |= 0x80;
      this.u8(b);
    } while (v);
  }
  sleb(v: number) {
    let more = true;
    while (more) {
      let b = v & 0x7f;
      v = Math.floor(v / 128);
      if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) more = false; else b |= 0x80;
      this.u8(b);
    }
  }
  pad(a: number) { while (this.data.length % a) this.u8(0); }
  get length() { return this.data.length; }
}

interface Place { sect: Section; off: number }

export function link(asmb: Assembly, opts: LinkOptions = {}): LinkResult {
  const entry = opts.entry ?? '_main';
  const dylib = opts.kind === 'dylib';
  const BASE = dylib ? 0 : 0x100000000;
  const installName = opts.installName ?? `@rpath/lib${opts.name ?? 'hla'}.dylib`;
  const dylibs = opts.dylibs ?? ['/usr/lib/libSystem.B.dylib'];
  const syms = asmb.symbols;

  for (const s of asmb.sections) {
    if (s.seg === '__DATA_CONST') s.seg = '__DATA';
    if (s.seg !== '__TEXT' && s.seg !== '__DATA') {
      throw new AsmError(`segment ${s.seg} is not supported (use __TEXT or __DATA)`, s.fixups[0]?.line ?? 0);
    }
  }

  // ---------------------------------------------------------------- imports
  const imports: string[] = [];
  const importIdx = new Map<string, number>();
  const stubOf = new Map<string, number>();     // import -> stub index
  const gotOf = new Map<string, number>();      // symbol -> got index
  const gotSyms: { name: string; local: boolean }[] = [];
  const addImport = (n: string) => {
    if (!importIdx.has(n)) { importIdx.set(n, imports.length); imports.push(n); }
  };
  const addGot = (n: string, local: boolean) => {
    if (!gotOf.has(n)) { gotOf.set(n, gotSyms.length); gotSyms.push({ name: n, local }); }
  };
  for (const s of asmb.sections) {
    for (const f of s.fixups) {
      const sym = f.fix.sym;
      if (!sym) continue;
      const defined = syms.has(sym);
      if (f.fix.kind === 'abs64') {
        if (!defined) addImport(sym);
        continue;
      }
      const got = (f.fix as { got: boolean }).got;
      if (got) {
        if (!defined) addImport(sym);
        addGot(sym, defined);
        continue;
      }
      if (defined) continue;
      if (f.fix.kind === 'branch26') {
        addImport(sym);
        if (!stubOf.has(sym)) stubOf.set(sym, stubOf.size);
        addGot(sym, false);
        continue;
      }
      throw new AsmError(`undefined symbol '${sym}'` + (f.fix.kind === 'page21' || f.fix.kind === 'pageoff12'
        ? ' (external data must be accessed through @GOTPAGE/@GOTPAGEOFF)' : ''), f.line);
    }
  }
  if (!dylib && !syms.has(entry)) throw new AsmError(`entry point '${entry}' is not defined — a library has no main: build it as a static or dynamic library`, 0);

  // ---------------------------------------------------------------- synthetic sections
  const mkSect = (seg: string, name: string, flags: number, alignP2: number, size: number): Section => ({
    seg, name, flags, align: alignP2, data: new Array(size).fill(0), size, zerofill: false, fixups: [], insns: [], addr: 0, fileOff: 0,
  });
  const stubs = mkSect('__TEXT', '__stubs', S_SYMBOL_STUBS | S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS, 2, stubOf.size * 12);
  const got = mkSect('__DATA', '__got', S_NON_LAZY_SYMBOL_POINTERS, 3, gotSyms.length * 8);

  const userText = asmb.sections.filter((s) => s.seg === '__TEXT');
  const textSects: Section[] = [
    ...userText.filter((s) => s.name === '__text'),
    ...(stubs.size ? [stubs] : []),
    ...userText.filter((s) => s.name !== '__text'),
  ];
  const userData = asmb.sections.filter((s) => s.seg === '__DATA');
  const dataSects: Section[] = [
    ...(got.size ? [got] : []),
    ...userData.filter((s) => !s.zerofill && s.name === '__const'),
    ...userData.filter((s) => !s.zerofill && s.name !== '__const'),
    ...userData.filter((s) => s.zerofill),
  ];
  const hasData = dataSects.length > 0;
  const allSects = [...textSects, ...dataSects];

  // ---------------------------------------------------------------- load command sizes
  const dylinker = '/usr/lib/dyld';
  const dylinkerSize = align(12 + dylinker.length + 1, 8);
  const dylibSizes = dylibs.map((d) => align(24 + d.length + 1, 8));
  const idDylibSize = align(24 + installName.length + 1, 8);
  const cmds: number[] = [
    ...(dylib ? [] : [72]),              // __PAGEZERO
    72 + 80 * textSects.length,          // __TEXT
    ...(hasData ? [72 + 80 * dataSects.length] : []),
    72,                                  // __LINKEDIT
    48,                                  // LC_DYLD_INFO_ONLY
    24,                                  // LC_SYMTAB
    80,                                  // LC_DYSYMTAB
    ...(dylib ? [idDylibSize] : [dylinkerSize]),
    24,                                  // LC_UUID
    24,                                  // LC_BUILD_VERSION
    ...(dylib ? [] : [24]),              // LC_MAIN
    ...dylibSizes,
    16,                                  // LC_CODE_SIGNATURE
  ];
  const sizeofcmds = cmds.reduce((a, b) => a + b, 0);
  const ncmds = cmds.length;

  // ---------------------------------------------------------------- layout
  let off = align(32 + sizeofcmds, 16);
  for (const s of textSects) {
    off = align(off, 1 << s.align);
    s.fileOff = off;
    s.addr = BASE + off;
    off += s.size;
  }
  const textSize = align(off, PAGE);
  let dataFileSize = 0, dataVmSize = 0;
  const dataAddr = BASE + textSize;
  if (hasData) {
    let doff = 0;
    for (const s of dataSects.filter((x) => !x.zerofill)) {
      doff = align(doff, 1 << s.align);
      s.fileOff = textSize + doff;
      s.addr = dataAddr + doff;
      doff += s.size;
    }
    const fileEnd = doff;
    for (const s of dataSects.filter((x) => x.zerofill)) {
      doff = align(doff, 1 << s.align);
      s.fileOff = 0;
      s.addr = dataAddr + doff;
      doff += s.size;
    }
    dataFileSize = align(fileEnd, PAGE);
    dataVmSize = align(Math.max(doff, 1), PAGE);
  }
  const linkeditOff = textSize + dataFileSize;
  const linkeditAddr = dataAddr + dataVmSize;

  const addrOf = (name: string): number => {
    const d = syms.get(name);
    if (!d) throw new AsmError(`undefined symbol '${name}'`, 0);
    return d.sect.addr + d.off;
  };
  const gotAddr = (name: string) => got.addr + gotOf.get(name)! * 8;
  const stubAddr = (name: string) => stubs.addr + stubOf.get(name)! * 12;

  // ---------------------------------------------------------------- fixups
  const rebases: Place[] = [];
  const binds: { place: Place; sym: string; addend: number }[] = [];
  const rd32 = (s: Section, o: number) => (s.data[o] | (s.data[o + 1] << 8) | (s.data[o + 2] << 16) | (s.data[o + 3] << 24)) >>> 0;
  const wr32 = (s: Section, o: number, v: number) => { for (let i = 0; i < 4; i++) s.data[o + i] = (v >>> (8 * i)) & 0xff; };
  const wr64 = (s: Section, o: number, v: number) => { const b = BigInt(v); for (let i = 0; i < 8; i++) s.data[o + i] = Number((b >> BigInt(8 * i)) & 0xffn); };

  const patch = (s: Section, o: number, line: number, kind: string, target: number, scale = 0) => {
    const pc = s.addr + o;
    let w = rd32(s, o);
    const delta = target - pc;
    const range = (bits: number, what: string) => {
      if (delta % 4) throw new AsmError(`${what} target is not 4-byte aligned`, line);
      const lim = 2 ** (bits - 1) * 4;
      if (delta < -lim || delta >= lim) throw new AsmError(`${what} target out of range (${delta} bytes)`, line);
      return (delta / 4) & ((1 << bits) - 1);
    };
    switch (kind) {
      case 'branch26': w |= range(26, 'branch'); break;
      case 'branch19': w |= range(19, 'conditional branch') << 5; break;
      case 'branch14': w |= range(14, 'test branch') << 5; break;
      case 'adr21': {
        if (delta < -(1 << 20) || delta >= 1 << 20) throw new AsmError('adr target out of range', line);
        const v = delta & 0x1fffff;
        w |= ((v & 3) << 29) | ((v >> 2) << 5);
        break;
      }
      case 'page21': {
        const pages = Math.floor(target / 4096) - Math.floor(pc / 4096);
        if (pages < -(1 << 20) || pages >= 1 << 20) throw new AsmError('adrp target out of range', line);
        const v = pages & 0x1fffff;
        w |= ((v & 3) << 29) | ((v >> 2) << 5);
        break;
      }
      case 'pageoff12': {
        const lo = target % 4096;
        if (lo % (1 << scale)) throw new AsmError(`@PAGEOFF target is not aligned to ${1 << scale} bytes`, line);
        w |= (lo >> scale) << 10;
        break;
      }
    }
    wr32(s, o, w >>> 0);
  };

  for (const s of asmb.sections) {
    for (const f of s.fixups) {
      const fx = f.fix;
      if (fx.kind === 'abs64') {
        if (s.seg !== '__DATA') {
          throw new AsmError(`absolute pointer to '${fx.sym}' in read-only ${s.seg},${s.name} (put pointer tables into __DATA,__const)`, f.line);
        }
        if (syms.has(fx.sym)) {
          wr64(s, f.off, addrOf(fx.sym) + Number(fx.add));
          rebases.push({ sect: s, off: f.off });
        } else {
          binds.push({ place: { sect: s, off: f.off }, sym: fx.sym, addend: Number(fx.add) });
        }
        continue;
      }
      const pc = s.addr + f.off;
      let target: number;
      if (!fx.sym) target = pc + Number(fx.add);
      else if (fx.got) target = gotAddr(fx.sym) + Number(fx.add);
      else if (fx.kind === 'branch26' && stubOf.has(fx.sym)) target = stubAddr(fx.sym);
      else target = addrOf(fx.sym) + Number(fx.add);
      patch(s, f.off, f.line, fx.kind, target, fx.scale);
    }
  }
  // stubs: adrp x16, got@PAGE ; ldr x16, [x16, got@PAGEOFF] ; br x16
  for (const [name, i] of stubOf) {
    const o = i * 12;
    wr32(stubs, o, 0x90000010);
    wr32(stubs, o + 4, 0xf9400210);
    wr32(stubs, o + 8, 0xd61f0200);
    patch(stubs, o, 0, 'page21', gotAddr(name));
    patch(stubs, o + 4, 0, 'pageoff12', gotAddr(name), 3);
  }
  gotSyms.forEach((g, i) => {
    if (g.local) {
      wr64(got, i * 8, addrOf(g.name));
      rebases.push({ sect: got, off: i * 8 });
    } else {
      binds.push({ place: { sect: got, off: i * 8 }, sym: g.name, addend: 0 });
    }
  });

  // ---------------------------------------------------------------- dyld info
  const dataSegIndex = dylib ? 1 : 2;
  const segOff = (p: Place) => p.sect.addr + p.off - dataAddr;
  const rebase = new Buf();
  if (rebases.length) {
    rebase.u8(0x11); // REBASE_OPCODE_SET_TYPE_IMM | POINTER
    for (const p of rebases.sort((a, b) => segOff(a) - segOff(b))) {
      rebase.u8(0x20 | dataSegIndex); // SET_SEGMENT_AND_OFFSET_ULEB
      rebase.uleb(segOff(p));
      rebase.u8(0x51);                // DO_REBASE_IMM_TIMES 1
    }
    rebase.u8(0x00);
    rebase.pad(8);
  }
  const bind = new Buf();
  if (binds.length) {
    for (const b of binds) {
      bind.u8(0x11);                  // SET_DYLIB_ORDINAL_IMM 1
      bind.u8(0x40);                  // SET_SYMBOL_TRAILING_FLAGS_IMM
      bind.cstr(b.sym);
      bind.u8(0x51);                  // SET_TYPE_IMM POINTER
      if (b.addend) { bind.u8(0x60); bind.sleb(b.addend); }
      bind.u8(0x70 | dataSegIndex);   // SET_SEGMENT_AND_OFFSET_ULEB
      bind.uleb(segOff(b.place));
      bind.u8(0x90);                  // DO_BIND
    }
    bind.u8(0x00);
    bind.pad(8);
  }
  // export trie: __mh_execute_header for executables, every global symbol for libraries
  const exportList = dylib
    ? [...syms.values()].filter((d) => d.global).map((d) => ({ name: d.name, addr: d.sect.addr + d.off - BASE }))
    : [{ name: '__mh_execute_header', addr: 0 }];
  const exp = new Buf();
  exp.data.push(...buildExportTrie(exportList));
  exp.pad(8);

  // ---------------------------------------------------------------- symbol table
  const sectIndex = (s: Section) => allSects.indexOf(s) + 1;
  type NL = { name: string; type: number; sect: number; desc: number; value: number };
  const locals: NL[] = [], extdefs: NL[] = [], undefs: NL[] = [];
  for (const d of syms.values()) {
    if (d.name.startsWith('L') || d.name.startsWith('l')) continue;
    const nl = { name: d.name, type: 0x0e | (d.global ? 1 : 0), sect: sectIndex(d.sect), desc: 0, value: d.sect.addr + d.off };
    (d.global ? extdefs : locals).push(nl);
  }
  if (!dylib) extdefs.push({ name: '__mh_execute_header', type: 0x0f, sect: 1, desc: 0x10, value: BASE });
  for (const n of imports) undefs.push({ name: n, type: 0x01, sect: 0, desc: 0x0100, value: 0 });
  locals.sort((a, b) => a.value - b.value);
  extdefs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  undefs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const allNl = [...locals, ...extdefs, ...undefs];
  const strtab = new Buf();
  strtab.u8(0x20); strtab.u8(0);
  const strx = allNl.map((n) => { const i = strtab.length; strtab.cstr(n.name); return i; });
  strtab.pad(8);
  const symtab = new Buf();
  allNl.forEach((n, i) => {
    symtab.u32(strx[i]); symtab.u8(n.type); symtab.u8(n.sect); symtab.u16(n.desc); symtab.u64(n.value);
  });
  const symIndex = (name: string) => allNl.findIndex((n) => n.name === name && n.type === 0x01);
  const indirect = new Buf();
  const stubList = [...stubOf.keys()];
  for (const n of stubList) indirect.u32(symIndex(n));
  for (const g of gotSyms) indirect.u32(g.local ? INDIRECT_SYMBOL_LOCAL : symIndex(g.name));
  const nIndirect = stubList.length + gotSyms.length;

  // ---------------------------------------------------------------- linkedit layout
  let lo = linkeditOff;
  const rebaseOff = lo; lo += rebase.length;
  const bindOff = lo; lo += bind.length;
  const exportOff = lo; lo += exp.length;
  const symOff = lo; lo += symtab.length;
  const indirectOff = lo; lo += align(indirect.length, 8);
  const strOff = lo; lo += strtab.length;
  const sigOff = align(lo, 16);
  const ident = (opts.name ?? 'a.out').replace(/[^\w.-]/g, '_');
  const nPages = Math.ceil(sigOff / 4096);
  const cdSize = 88 + ident.length + 1 + nPages * 32;
  const sigSize = align(12 + 8 + cdSize, 16);
  const fileSize = sigOff + sigSize;
  const linkeditSize = fileSize - linkeditOff;

  // ---------------------------------------------------------------- header + load commands
  const out = new Buf();
  out.u32(0xfeedfacf); out.u32(0x0100000c); out.u32(0); out.u32(dylib ? 6 : 2);   // MH_DYLIB / MH_EXECUTE
  out.u32(ncmds); out.u32(sizeofcmds);
  out.u32(dylib ? 0x00100085 : 0x00200085);   // NOUNDEFS | DYLDLINK | TWOLEVEL | (NO_REEXPORTED_DYLIBS or PIE)
  out.u32(0);

  const segment = (name: string, vmaddr: number, vmsize: number, fileoff: number, filesize: number, prot: number, sects: Section[]) => {
    out.u32(LC_SEGMENT_64); out.u32(72 + 80 * sects.length);
    out.str(name, 16);
    out.u64(vmaddr); out.u64(vmsize); out.u64(fileoff); out.u64(filesize);
    out.u32(prot); out.u32(prot); out.u32(sects.length); out.u32(0);
    for (const s of sects) {
      out.str(s.name, 16); out.str(s.seg, 16);
      out.u64(s.addr); out.u64(s.size);
      out.u32(s.zerofill ? 0 : s.fileOff); out.u32(s.align);
      out.u32(0); out.u32(0);
      out.u32(s.flags);
      if (s === stubs) { out.u32(0); out.u32(12); }
      else if (s === got) { out.u32(stubList.length); out.u32(0); }
      else { out.u32(0); out.u32(0); }
      out.u32(0);
    }
  };
  if (!dylib) segment('__PAGEZERO', 0, BASE, 0, 0, 0, []);
  segment('__TEXT', BASE, textSize, 0, textSize, 5, textSects);
  if (hasData) segment('__DATA', dataAddr, dataVmSize, textSize, dataFileSize, 3, dataSects);
  segment('__LINKEDIT', linkeditAddr, align(linkeditSize, PAGE), linkeditOff, linkeditSize, 1, []);

  out.u32(LC_DYLD_INFO_ONLY); out.u32(48);
  out.u32(rebase.length ? rebaseOff : 0); out.u32(rebase.length);
  out.u32(bind.length ? bindOff : 0); out.u32(bind.length);
  out.u32(0); out.u32(0);            // weak bind
  out.u32(0); out.u32(0);            // lazy bind
  out.u32(exportOff); out.u32(exp.length);

  out.u32(LC_SYMTAB); out.u32(24);
  out.u32(symOff); out.u32(allNl.length); out.u32(strOff); out.u32(strtab.length);

  out.u32(LC_DYSYMTAB); out.u32(80);
  out.u32(0); out.u32(locals.length);
  out.u32(locals.length); out.u32(extdefs.length);
  out.u32(locals.length + extdefs.length); out.u32(undefs.length);
  for (let i = 0; i < 6; i++) out.u32(0);              // toc, modtab, extrefsym
  out.u32(nIndirect ? indirectOff : 0); out.u32(nIndirect);
  for (let i = 0; i < 4; i++) out.u32(0);              // extrel, locrel

  if (dylib) {
    out.u32(0xd); out.u32(idDylibSize);                 // LC_ID_DYLIB
    out.u32(24); out.u32(1); out.u32(0x00010000); out.u32(0x00010000);
    out.str(installName, idDylibSize - 24);
  } else {
    out.u32(LC_LOAD_DYLINKER); out.u32(dylinkerSize); out.u32(12);
    out.str(dylinker, dylinkerSize - 12);
  }

  // UUID: hash of the section contents (deterministic builds)
  const uuidSrc = new Uint8Array(allSects.flatMap((s) => s.data));
  const uuid = sha256(uuidSrc);
  out.u32(LC_UUID); out.u32(24);
  for (let i = 0; i < 16; i++) out.u8(i === 6 ? (uuid[i] & 0x0f) | 0x40 : i === 8 ? (uuid[i] & 0x3f) | 0x80 : uuid[i]);

  out.u32(LC_BUILD_VERSION); out.u32(24);
  out.u32(1);                 // PLATFORM_MACOS
  out.u32(0x000b0000);        // minos 11.0
  out.u32(0x000f0000);        // sdk 15.0
  out.u32(0);                 // ntools

  if (!dylib) {
    out.u32(LC_MAIN); out.u32(24);
    out.u64(addrOf(entry) - BASE); out.u64(0);
  }

  dylibs.forEach((d, i) => {
    out.u32(LC_LOAD_DYLIB); out.u32(dylibSizes[i]);
    out.u32(24); out.u32(2); out.u32(0x05276403); out.u32(0x00010000);
    out.str(d, dylibSizes[i] - 24);
  });

  out.u32(LC_CODE_SIGNATURE); out.u32(16); out.u32(sigOff); out.u32(sigSize);

  if (out.length !== 32 + sizeofcmds) throw new Error(`internal: load command size mismatch ${out.length} vs ${32 + sizeofcmds}`);

  // ---------------------------------------------------------------- file image
  const file = new Uint8Array(fileSize);
  file.set(out.data, 0);
  for (const s of allSects) if (!s.zerofill) file.set(s.data, s.fileOff);
  file.set(rebase.data, rebaseOff);
  file.set(bind.data, bindOff);
  file.set(exp.data, exportOff);
  file.set(symtab.data, symOff);
  file.set(indirect.data, indirectOff);
  file.set(strtab.data, strOff);

  // ---------------------------------------------------------------- ad-hoc code signature
  const sig = new Buf();
  const be32 = (v: number) => { sig.u8(v >>> 24); sig.u8(v >>> 16); sig.u8(v >>> 8); sig.u8(v); };
  const be64 = (v: number) => { be32(Math.floor(v / 0x100000000)); be32(v >>> 0); };
  be32(0xfade0cc0); be32(12 + 8 + cdSize); be32(1);   // SuperBlob
  be32(0); be32(20);                                    // CodeDirectory slot at offset 20
  be32(0xfade0c02); be32(cdSize); be32(0x20400);
  be32(0x20002);                                        // adhoc | linker-signed
  be32(88 + ident.length + 1);                          // hashOffset
  be32(88);                                             // identOffset
  be32(0); be32(nPages); be32(sigOff);                  // nSpecialSlots, nCodeSlots, codeLimit
  sig.u8(32); sig.u8(2); sig.u8(0); sig.u8(12);         // hashSize, SHA256, platform, pageSize 4K
  be32(0); be32(0); be32(0); be32(0);                   // spare2, scatter, team, spare3
  be64(0);                                              // codeLimit64
  be64(0); be64(textSize); be64(dylib ? 0 : 1);         // execSeg base/limit/flags (1 = main binary)
  sig.cstr(ident);
  for (let p = 0; p < nPages; p++) {
    const h = sha256(file.subarray(p * 4096, Math.min(sigOff, (p + 1) * 4096)));
    for (const b of h) sig.u8(b);
  }
  file.set(sig.data, sigOff);

  const listing: LinkResult['listing'] = [];
  for (const s of textSects) {
    if (s === stubs) {
      for (let o = 0; o < s.size; o += 4) listing.push({ addr: s.addr + o, word: rd32(s, o), line: 0, sect: '__stubs' });
      continue;
    }
    for (const ins of s.insns) listing.push({ addr: s.addr + ins.off, word: rd32(s, ins.off), line: ins.line, sect: s.name });
  }
  const cd = file.subarray(sigOff + 20, sigOff + 20 + cdSize);
  const cdhash = [...sha256(cd).subarray(0, 20)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const segments: LinkResult['segments'] = [
    ...(dylib ? [] : [{ name: '__PAGEZERO', addr: 0, vmsize: BASE, fileOff: 0, fileSize: 0, prot: '---' }]),
    { name: '__TEXT', addr: BASE, vmsize: textSize, fileOff: 0, fileSize: textSize, prot: 'r-x' },
    ...(hasData ? [{ name: '__DATA', addr: dataAddr, vmsize: dataVmSize, fileOff: textSize, fileSize: dataFileSize, prot: 'rw-' }] : []),
    { name: '__LINKEDIT', addr: linkeditAddr, vmsize: align(linkeditSize, PAGE), fileOff: linkeditOff, fileSize: linkeditSize, prot: 'r--' },
  ];

  return {
    listing, segments,
    signature: { offset: sigOff, size: sigSize, pages: nPages, cdhash },
    bytes: file,
    map: allSects.map((s) => ({ name: `${s.seg},${s.name}`, addr: s.addr, size: s.size })),
    symbols: [...syms.values()].map((d) => ({ name: d.name, addr: d.sect.addr + d.off })),
    imports,
    entryAddr: dylib ? 0 : addrOf(entry),
  };
}

/** Serialize a dyld export trie for (name, address) pairs. */
export function buildExportTrie(entries: { name: string; addr: number }[]): number[] {
  interface Node { children: Map<string, Node>; addr: number | null; offset: number }
  const mk = (): Node => ({ children: new Map(), addr: null, offset: 0 });
  const root = mk();
  // character trie
  for (const e of entries) {
    let n = root;
    for (const ch of e.name) {
      if (!n.children.has(ch)) n.children.set(ch, mk());
      n = n.children.get(ch)!;
    }
    n.addr = e.addr;
  }
  // compress chains of single-child, non-terminal nodes into multi-character edges
  type CNode = { edges: { label: string; node: CNode }[]; addr: number | null; offset: number };
  const compress = (n: Node): CNode => {
    const edges: { label: string; node: CNode }[] = [];
    for (const [ch, child] of n.children) {
      let label = ch, c = child;
      while (c.addr === null && c.children.size === 1) {
        const [ch2, next] = [...c.children][0];
        label += ch2;
        c = next;
      }
      edges.push({ label, node: compress(c) });
    }
    return { edges, addr: n.addr, offset: 0 };
  };
  const croot = compress(root);
  const order: CNode[] = [];
  const walk = (n: CNode) => { order.push(n); for (const e of n.edges) walk(e.node); };
  walk(croot);
  const ulebLen = (v: number) => { let n = 1; while (v >= 128) { v = Math.floor(v / 128); n++; } return n; };
  const nodeSize = (n: CNode) => {
    let size = 0;
    if (n.addr !== null) { const t = 1 + ulebLen(n.addr); size += ulebLen(t) + t; } else size += 1;
    size += 1;
    for (const e of n.edges) size += new TextEncoder().encode(e.label).length + 1 + ulebLen(e.node.offset);
    return size;
  };
  // offsets depend on uleb sizes of offsets: iterate until stable
  for (let changed = true; changed;) {
    changed = false;
    let off = 0;
    for (const n of order) {
      if (n.offset !== off) { n.offset = off; changed = true; }
      off += nodeSize(n);
    }
  }
  const out: number[] = [];
  const uleb = (v: number) => { do { let b = v % 128; v = Math.floor(v / 128); if (v) b |= 0x80; out.push(b); } while (v); };
  for (const n of order) {
    if (n.addr !== null) {
      uleb(1 + ulebLen(n.addr));
      out.push(0);          // flags: regular
      uleb(n.addr);
    } else out.push(0);
    out.push(n.edges.length);
    for (const e of n.edges) {
      for (const b of new TextEncoder().encode(e.label)) out.push(b);
      out.push(0);
      uleb(e.node.offset);
    }
  }
  return out;
}

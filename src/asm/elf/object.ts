// ELF64 relocatable object writer (.o) for x86-64 Linux. The result links with ld / ld.lld / gcc / clang
// like objects produced by gcc or clang: RELA relocations (PC32, PLT32 for calls, GOTPCREL, 64), a
// symbol table with locals first, and an empty .note.GNU-stack (the stack is not executable).
import { AsmError } from '../parse.ts';
import { SCN_EXEC, SCN_WRITE, type XAssembly, type XSection } from '../x64/assembler.ts';

export const R_X86_64_64 = 1, R_X86_64_PC32 = 2, R_X86_64_GOTPCREL = 9, R_X86_64_32 = 10, R_X86_64_PLT32 = 4;
const SHT_PROGBITS = 1, SHT_SYMTAB = 2, SHT_STRTAB = 3, SHT_RELA = 4, SHT_NOBITS = 8;
const SHF_WRITE = 1, SHF_ALLOC = 2, SHF_EXECINSTR = 4, SHF_INFO_LINK = 0x40;
const STB_LOCAL = 0, STB_GLOBAL = 1, STT_NOTYPE = 0, STT_OBJECT = 1, STT_FUNC = 2, STT_SECTION = 3;

export interface ElfObjectResult {
  bytes: Uint8Array;
  exports: string[];
  imports: string[];
  sections: { name: string; size: number; relocs: number }[];
  listing: { addr: number; bytes: number[]; line: number; sect: string }[];
}

/** a string table: offsets of names, deduplicated */
export class StrTab {
  bytes: number[] = [0];
  private at = new Map<string, number>();
  add(s: string): number {
    if (!s) return 0;
    let o = this.at.get(s);
    if (o === undefined) {
      o = this.bytes.length;
      this.bytes.push(...new TextEncoder().encode(s), 0);
      this.at.set(s, o);
    }
    return o;
  }
}

/** symbol sizes: from each label to the next label of the section that is not a local (.L) one */
export function symbolSizes(asmb: XAssembly): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of asmb.sections) {
    const own = [...asmb.symbols.values()].filter((d) => d.sect === s && !d.name.startsWith('.L')).sort((a, b) => a.off - b.off);
    own.forEach((d, i) => out.set(d.name, (own.slice(i + 1).find((e) => e.off > d.off)?.off ?? s.size) - d.off));
  }
  return out;
}

export function writeElfObject(asmb: XAssembly): ElfObjectResult {
  const sections = asmb.sections;
  const syms = asmb.symbols;
  const isLocalLabel = (n: string) => n.startsWith('.L');

  // ------------------------------------------------------------------ relocations (fields hold zero, RELA addends)
  type Rel = { off: number; sym: string; type: number; addend: bigint; section: boolean };
  const relocs = new Map<XSection, Rel[]>();
  const referenced = new Set<string>();
  const gotLocals = new Set<string>();      // local labels reached through the GOT: they need a symbol of their own
  for (const s of sections) {
    const list: Rel[] = [];
    relocs.set(s, list);
    for (const f of s.fixups) {
      const t = syms.get(f.sym);
      const put = (v: bigint, n: number) => { const u = BigInt.asUintN(n * 8, v); for (let i = 0; i < n; i++) s.data[f.off + i] = Number((u >> BigInt(8 * i)) & 0xffn); };
      if (f.kind === 'rva') throw new AsmError(`.rva (image-relative address of '${f.sym}') exists only on Windows`, f.line);
      if (f.kind === 'got') {
        if (f.add) throw new AsmError(`${f.sym}@GOTPCREL cannot have an offset`, f.line);
        put(0n, 4);
        list.push({ off: f.off, sym: f.sym, type: R_X86_64_GOTPCREL, addend: -BigInt(f.end - f.off), section: false });
        if (t && !t.global) gotLocals.add(f.sym);
        else referenced.add(f.sym);
        continue;
      }
      // local symbols are reached through their section symbol, like gcc and clang do; so is a pc-relative
      // data reference to a global one, which binds it here (ld refuses PC32 against a global in a .so)
      const viaSection = !!t && (!t.global || (f.kind === 'rel' && !f.branch));
      const extra = viaSection ? BigInt(t!.off) : 0n;
      const target = viaSection ? t!.sect.name : f.sym;
      if (f.kind === 'rel') {
        if (t && t.sect === s) {
          // pc-relative inside the section: final now
          const d = BigInt(t.off) + f.add - BigInt(f.end);
          const lim = f.size === 1 ? 128n : 1n << 31n;
          if (d < -lim || d >= lim) throw new AsmError(`target '${f.sym}' out of range`, f.line);
          put(d, f.size);
          continue;
        }
        if (f.size !== 4) throw new AsmError(`short jump to '${f.sym}' outside this section`, f.line);
        put(0n, 4);
        // S + A - P with P the field: the instruction ends (end - off) bytes after it
        const type = f.branch && !viaSection ? R_X86_64_PLT32 : R_X86_64_PC32;
        list.push({ off: f.off, sym: target, type, addend: extra + f.add - BigInt(f.end - f.off), section: viaSection });
      } else {
        put(0n, f.size);
        if (f.size !== 8 && f.size !== 4) throw new AsmError(`${f.size}-byte address of '${f.sym}'`, f.line);
        list.push({ off: f.off, sym: target, type: f.size === 8 ? R_X86_64_64 : R_X86_64_32, addend: extra + f.add, section: viaSection });
      }
      if (!viaSection) referenced.add(f.sym);
    }
  }

  // ------------------------------------------------------------------ section headers (content sections first)
  type Sh = { name: string; type: number; flags: number; addr: number; data: number[] | null; size: number; link: number; info: number; align: number; entsize: number; off?: number };
  const shs: Sh[] = [{ name: '', type: 0, flags: 0, addr: 0, data: [], size: 0, link: 0, info: 0, align: 0, entsize: 0 }];
  const secIndex = new Map<XSection, number>();
  for (const s of sections) {
    secIndex.set(s, shs.length);
    let flags = SHF_ALLOC;
    if (s.flags & SCN_EXEC) flags |= SHF_EXECINSTR;
    if (s.flags & SCN_WRITE) flags |= SHF_WRITE;
    shs.push({ name: s.name, type: s.zerofill ? SHT_NOBITS : SHT_PROGBITS, flags, addr: 0, data: s.zerofill ? null : s.data, size: s.size, link: 0, info: 0, align: Math.max(1, s.align), entsize: 0 });
  }

  // ------------------------------------------------------------------ symbol table: null, sections, locals, globals, undefined
  const strtab = new StrTab();
  type Sym = { name: string; info: number; shndx: number; value: number; size: number };
  const table: Sym[] = [{ name: '', info: 0, shndx: 0, value: 0, size: 0 }];
  const index = new Map<string, number>();
  for (const s of sections) { index.set(s.name, table.length); table.push({ name: '', info: (STB_LOCAL << 4) | STT_SECTION, shndx: secIndex.get(s)!, value: 0, size: 0 }); }
  const sizes = symbolSizes(asmb);
  const typeOf = (d: { sect: XSection; name: string; func: boolean }) => (d.func || (d.sect.flags & SCN_EXEC && !isLocalLabel(d.name)) ? STT_FUNC : STT_OBJECT);
  const defined = [...syms.values()];
  for (const d of defined) {
    if (d.global || (isLocalLabel(d.name) && !gotLocals.has(d.name))) continue;
    index.set(d.name, table.length);
    table.push({ name: d.name, info: (STB_LOCAL << 4) | (isLocalLabel(d.name) ? STT_NOTYPE : typeOf(d)), shndx: secIndex.get(d.sect)!, value: d.off, size: isLocalLabel(d.name) ? 0 : sizes.get(d.name) ?? 0 });
  }
  const firstGlobal = table.length;
  const exportsList: string[] = [];
  for (const d of defined) {
    if (!d.global) continue;
    exportsList.push(d.name);
    index.set(d.name, table.length);
    table.push({ name: d.name, info: (STB_GLOBAL << 4) | typeOf(d), shndx: secIndex.get(d.sect)!, value: d.off, size: sizes.get(d.name) ?? 0 });
  }
  // .globl names that are never defined are undefined references too (like `.globl printf`)
  for (const g of asmb.globals) if (!syms.has(g)) referenced.add(g);
  const undefs = [...referenced].filter((n) => !syms.has(n)).sort();
  for (const n of undefs) { index.set(n, table.length); table.push({ name: n, info: (STB_GLOBAL << 4) | STT_NOTYPE, shndx: 0, value: 0, size: 0 }); }
  const symBytes: number[] = [];
  for (const s of table) {
    const dv = new DataView(new ArrayBuffer(24));
    dv.setUint32(0, strtab.add(s.name), true);
    dv.setUint8(4, s.info);
    dv.setUint16(6, s.shndx, true);
    dv.setBigUint64(8, BigInt(s.value), true);
    dv.setBigUint64(16, BigInt(s.size), true);
    symBytes.push(...new Uint8Array(dv.buffer));
  }

  // ------------------------------------------------------------------ .rela.*, .note.GNU-stack, .symtab, .strtab, .shstrtab
  const symtabIndex = shs.length + sections.filter((s) => relocs.get(s)!.length).length + 1;
  for (const s of sections) {
    const list = relocs.get(s)!;
    if (!list.length) continue;
    const bytes: number[] = [];
    for (const r of list) {
      const si = index.get(r.sym);
      if (si === undefined) throw new AsmError(`internal: no symbol '${r.sym}'`, 0);
      const dv = new DataView(new ArrayBuffer(24));
      dv.setBigUint64(0, BigInt(r.off), true);
      dv.setBigUint64(8, (BigInt(si) << 32n) | BigInt(r.type), true);
      dv.setBigInt64(16, r.addend, true);
      bytes.push(...new Uint8Array(dv.buffer));
    }
    shs.push({ name: '.rela' + s.name, type: SHT_RELA, flags: SHF_INFO_LINK, addr: 0, data: bytes, size: bytes.length, link: symtabIndex, info: secIndex.get(s)!, align: 8, entsize: 24 });
  }
  shs.push({ name: '.note.GNU-stack', type: SHT_PROGBITS, flags: 0, addr: 0, data: [], size: 0, link: 0, info: 0, align: 1, entsize: 0 });
  shs.push({ name: '.symtab', type: SHT_SYMTAB, flags: 0, addr: 0, data: symBytes, size: symBytes.length, link: symtabIndex + 1, info: firstGlobal, align: 8, entsize: 24 });
  shs.push({ name: '.strtab', type: SHT_STRTAB, flags: 0, addr: 0, data: strtab.bytes, size: strtab.bytes.length, link: 0, info: 0, align: 1, entsize: 0 });
  const shstr = new StrTab();
  const nameOffs = shs.map((h) => shstr.add(h.name));
  const shstrName = shstr.add('.shstrtab');
  shs.push({ name: '.shstrtab', type: SHT_STRTAB, flags: 0, addr: 0, data: shstr.bytes, size: shstr.bytes.length, link: 0, info: 0, align: 1, entsize: 0 });
  nameOffs.push(shstrName);

  // ------------------------------------------------------------------ layout and bytes
  let off = 64;
  for (const h of shs) {
    if (!h.data || !h.size) { h.off = h.type === SHT_NOBITS || !h.size ? off : 0; continue; }
    off = Math.ceil(off / Math.max(1, h.align)) * Math.max(1, h.align);
    h.off = off;
    off += h.size;
  }
  const shoff = Math.ceil(off / 8) * 8;
  const buf = new Uint8Array(shoff + 64 * shs.length);
  const dv = new DataView(buf.buffer);
  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
  dv.setUint16(16, 1, true);            // ET_REL
  dv.setUint16(18, 62, true);           // EM_X86_64
  dv.setUint32(20, 1, true);
  dv.setBigUint64(40, BigInt(shoff), true);
  dv.setUint16(52, 64, true);
  dv.setUint16(58, 64, true);
  dv.setUint16(60, shs.length, true);
  dv.setUint16(62, shs.length - 1, true);
  shs.forEach((h, i) => {
    if (h.data && h.size) buf.set(h.data, h.off!);
    const o = shoff + 64 * i;
    dv.setUint32(o, nameOffs[i], true);
    dv.setUint32(o + 4, h.type, true);
    dv.setBigUint64(o + 8, BigInt(h.flags), true);
    dv.setBigUint64(o + 16, BigInt(h.addr), true);
    dv.setBigUint64(o + 24, BigInt(h.off ?? 0), true);
    dv.setBigUint64(o + 32, BigInt(h.size), true);
    dv.setUint32(o + 40, h.link, true);
    dv.setUint32(o + 44, h.info, true);
    dv.setBigUint64(o + 48, BigInt(h.align), true);
    dv.setBigUint64(o + 56, BigInt(h.entsize), true);
  });

  const listing: ElfObjectResult['listing'] = [];
  for (const s of sections) for (const ins of s.insns) listing.push({ addr: ins.off, bytes: s.data.slice(ins.off, ins.off + ins.len), line: ins.line, sect: s.name });
  return {
    bytes: buf,
    exports: exportsList.sort(),
    imports: undefs,
    sections: sections.map((s) => ({ name: s.name, size: s.size, relocs: relocs.get(s)!.length })),
    listing,
  };
}

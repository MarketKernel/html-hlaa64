// Mach-O relocatable object writer (MH_OBJECT) for arm64.
// The result links with the system linker (`clang main.c lib.o`, `ld`), so HLA64
// code can be used from C and other languages.
//
// Branches to labels in the same section are resolved here; everything else
// (calls to other functions, adrp/add/ldr pairs, GOT loads, pointers in data)
// becomes a relocation for the linker.
import { AsmError } from './parse.ts';
import type { Assembly, Section } from './assembler.ts';

const ARM64_RELOC_UNSIGNED = 0, ARM64_RELOC_BRANCH26 = 2, ARM64_RELOC_PAGE21 = 3, ARM64_RELOC_PAGEOFF12 = 4,
  ARM64_RELOC_GOT_LOAD_PAGE21 = 5, ARM64_RELOC_GOT_LOAD_PAGEOFF12 = 6, ARM64_RELOC_ADDEND = 10;

const align = (v: number, a: number) => Math.ceil(v / a) * a;

interface Reloc { address: number; symbolnum: number; pcrel: boolean; length: number; extern: boolean; type: number }

export interface ObjectResult {
  bytes: Uint8Array;
  /** external symbols defined by the object (what a library exports) */
  exports: string[];
  /** symbols the object needs from elsewhere */
  imports: string[];
  /** sections with object-file addresses and relocation counts */
  sections: { name: string; addr: number; size: number; relocs: number }[];
  /** every instruction: object-file address, machine word (unrelocated fields are zero), assembly line */
  listing: { addr: number; word: number; line: number; sect: string }[];
}

export function writeObject(asmb: Assembly): ObjectResult {
  const sections: Section[] = [
    ...asmb.sections.filter((s) => !s.zerofill),
    ...asmb.sections.filter((s) => s.zerofill),
  ];
  // object-file addresses: sections laid out one after another
  let addr = 0;
  for (const s of sections) {
    addr = align(addr, 1 << s.align);
    s.addr = addr;
    addr += s.size;
  }
  const vmsize = addr;
  const syms = asmb.symbols;

  // ---------------------------------------------------------------- symbols
  type NSym = { name: string; type: number; sect: number; value: number };
  // symbols that will appear in relocations (in-section branches are resolved here instead)
  const local = (s: Section, f: Section['fixups'][number]) => {
    const fx = f.fix;
    return fx.kind !== 'abs64' && !fx.got && ['branch26', 'branch19', 'branch14', 'adr21'].includes(fx.kind)
      && syms.get(fx.sym)?.sect === s;
  };
  const referenced = new Set<string>();
  for (const s of sections) for (const f of s.fixups) if (f.fix.sym && !local(s, f)) referenced.add(f.fix.sym);
  const locals: NSym[] = [], extdefs: NSym[] = [], undefs: NSym[] = [];
  for (const d of syms.values()) {
    const temp = d.name.startsWith('L') || d.name.startsWith('l');
    if (temp && !referenced.has(d.name)) continue;       // assembler-local label, resolved here
    const n: NSym = { name: d.name, type: 0x0e | (d.global ? 1 : 0), sect: sections.indexOf(d.sect) + 1, value: d.sect.addr + d.off };
    (d.global ? extdefs : locals).push(n);
  }
  for (const name of referenced) if (!syms.has(name)) undefs.push({ name, type: 0x01, sect: 0, value: 0 });
  const byName = (a: NSym, b: NSym) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  locals.sort((a, b) => a.value - b.value);
  extdefs.sort(byName);
  undefs.sort(byName);
  const all = [...locals, ...extdefs, ...undefs];
  const index = new Map(all.map((n, i) => [n.name, i]));

  // ---------------------------------------------------------------- fixups -> patches or relocations
  const rd32 = (s: Section, o: number) => (s.data[o] | (s.data[o + 1] << 8) | (s.data[o + 2] << 16) | (s.data[o + 3] << 24)) >>> 0;
  const wr32 = (s: Section, o: number, v: number) => { for (let i = 0; i < 4; i++) s.data[o + i] = (v >>> (8 * i)) & 0xff; };
  const relocs = new Map<Section, Reloc[]>();
  for (const s of sections) {
    const list: Reloc[] = [];
    relocs.set(s, list);
    for (const f of s.fixups) {
      const fx = f.fix;
      const target = fx.sym ? syms.get(fx.sym) : undefined;
      const add = Number(fx.add);
      const ext = (type: number, pcrel: boolean, length = 2) => {
        if (add && type !== ARM64_RELOC_UNSIGNED) {
          if (type === ARM64_RELOC_BRANCH26 || fx.kind === 'pageoff12' && (fx as { got?: boolean }).got || type === ARM64_RELOC_GOT_LOAD_PAGE21) {
            throw new AsmError(`an offset on '${fx.sym}' is not supported here`, f.line);
          }
          if (add < -(1 << 23) || add >= 1 << 23) throw new AsmError('symbol offset too large', f.line);
          list.push({ address: f.off, symbolnum: add & 0xffffff, pcrel: false, length: 2, extern: false, type: ARM64_RELOC_ADDEND });
        }
        list.push({ address: f.off, symbolnum: index.get(fx.sym)!, pcrel, length, extern: true, type });
      };
      if (fx.kind === 'abs64') {
        // implicit addend stored in the data itself
        const b = BigInt.asUintN(64, fx.add);
        for (let i = 0; i < 8; i++) s.data[f.off + i] = Number((b >> BigInt(8 * i)) & 0xffn);
        ext(ARM64_RELOC_UNSIGNED, false, 3);
        continue;
      }
      const sameSection = !fx.sym || (target && target.sect === s);
      if (sameSection && !fx.got && (fx.kind === 'branch26' || fx.kind === 'branch19' || fx.kind === 'branch14' || fx.kind === 'adr21')) {
        // pc-relative inside one section: the distance never changes, resolve now
        const delta = (fx.sym ? target!.off : f.off) + add - f.off;
        let w = rd32(s, f.off);
        const field = (bits: number, what: string) => {
          if (delta % 4) throw new AsmError(`${what} target is not 4-byte aligned`, f.line);
          const lim = 2 ** (bits - 1) * 4;
          if (delta < -lim || delta >= lim) throw new AsmError(`${what} target out of range`, f.line);
          return (delta / 4) & ((1 << bits) - 1);
        };
        if (fx.kind === 'branch26') w |= field(26, 'branch');
        else if (fx.kind === 'branch19') w |= field(19, 'conditional branch') << 5;
        else if (fx.kind === 'branch14') w |= field(14, 'test branch') << 5;
        else {
          const v = delta & 0x1fffff;
          w |= ((v & 3) << 29) | ((v >> 2) << 5);
        }
        wr32(s, f.off, w >>> 0);
        continue;
      }
      switch (fx.kind) {
        case 'branch26': ext(ARM64_RELOC_BRANCH26, true); break;
        case 'page21': ext(fx.got ? ARM64_RELOC_GOT_LOAD_PAGE21 : ARM64_RELOC_PAGE21, true); break;
        case 'pageoff12': ext(fx.got ? ARM64_RELOC_GOT_LOAD_PAGEOFF12 : ARM64_RELOC_PAGEOFF12, false); break;
        default:
          throw new AsmError(`'${fx.sym}' must be in the same section for this instruction (only bl/b can reach other code)`, f.line);
      }
    }
    // the linker expects relocations from the end of the section backwards (like clang emits them)
    const pairs: Reloc[][] = [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].type === ARM64_RELOC_ADDEND) { pairs.push([list[i], list[i + 1]]); i++; } else pairs.push([list[i]]);
    }
    pairs.sort((a, b) => b[0].address - a[0].address);
    relocs.set(s, pairs.flat());
  }

  // ---------------------------------------------------------------- layout
  const sizeofcmds = (72 + 80 * sections.length) + 24 + 24 + 80;
  let off = 32 + sizeofcmds;
  const dataStart = align(off, 8);
  off = dataStart;
  const fileOff = new Map<Section, number>();
  let fileEnd = dataStart;
  for (const s of sections) {
    if (s.zerofill) continue;
    off = align(off, 1 << s.align);
    fileOff.set(s, off);
    off += s.size;
    fileEnd = off;
  }
  off = align(off, 8);
  const relOff = new Map<Section, number>();
  for (const s of sections) {
    const n = relocs.get(s)!.length;
    if (n) { relOff.set(s, off); off += n * 8; }
  }
  const symOff = align(off, 8);
  off = symOff + all.length * 16;
  const strtab: number[] = [0x20, 0];
  const strx = all.map((n) => { const i = strtab.length; for (const c of new TextEncoder().encode(n.name)) strtab.push(c); strtab.push(0); return i; });
  while (strtab.length % 8) strtab.push(0);
  const strOff = off;
  const total = strOff + strtab.length;

  // ---------------------------------------------------------------- write
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  let p = 0;
  const u32 = (v: number) => { dv.setUint32(p, v >>> 0, true); p += 4; };
  const u64 = (v: number) => { dv.setBigUint64(p, BigInt(v), true); p += 8; };
  const str = (s: string, n: number) => { const b = new TextEncoder().encode(s); for (let i = 0; i < n; i++) buf[p + i] = b[i] ?? 0; p += n; };

  u32(0xfeedfacf); u32(0x0100000c); u32(0); u32(1);      // MH_OBJECT
  u32(4); u32(sizeofcmds); u32(0); u32(0);

  u32(0x19); u32(72 + 80 * sections.length);
  str('', 16);
  u64(0); u64(vmsize); u64(dataStart); u64(fileEnd - dataStart);
  u32(7); u32(7); u32(sections.length); u32(0);
  for (const s of sections) {
    str(s.name, 16); str(s.seg, 16);
    u64(s.addr); u64(s.size);
    u32(s.zerofill ? 0 : fileOff.get(s)!); u32(s.align);
    u32(relOff.get(s) ?? 0); u32(relocs.get(s)!.length);
    u32(s.flags); u32(0); u32(0); u32(0);
  }
  u32(0x32); u32(24); u32(1); u32(0x000b0000); u32(0x000f0000); u32(0);     // LC_BUILD_VERSION macOS 11
  u32(0x2); u32(24); u32(symOff); u32(all.length); u32(strOff); u32(strtab.length);
  u32(0xb); u32(80);
  u32(0); u32(locals.length); u32(locals.length); u32(extdefs.length); u32(locals.length + extdefs.length); u32(undefs.length);
  for (let i = 0; i < 14; i++) u32(0);

  for (const s of sections) if (!s.zerofill) buf.set(s.data, fileOff.get(s)!);
  for (const s of sections) {
    const o = relOff.get(s);
    if (o === undefined) continue;
    relocs.get(s)!.forEach((r, i) => {
      dv.setInt32(o + i * 8, r.address, true);
      const packed = (r.symbolnum & 0xffffff) | ((r.pcrel ? 1 : 0) << 24) | (r.length << 25) | ((r.extern ? 1 : 0) << 27) | (r.type << 28);
      dv.setUint32(o + i * 8 + 4, packed >>> 0, true);
    });
  }
  all.forEach((n, i) => {
    const o = symOff + i * 16;
    dv.setUint32(o, strx[i], true);
    buf[o + 4] = n.type; buf[o + 5] = n.sect;
    dv.setUint16(o + 6, 0, true);
    dv.setBigUint64(o + 8, BigInt(n.value), true);
  });
  buf.set(strtab, strOff);

  const listing: ObjectResult['listing'] = [];
  for (const s of sections) for (const ins of s.insns) listing.push({ addr: s.addr + ins.off, word: rd32(s, ins.off), line: ins.line, sect: s.name });
  return {
    bytes: buf, exports: extdefs.map((n) => n.name), imports: undefs.map((n) => n.name), listing,
    sections: sections.map((s) => ({ name: `${s.seg},${s.name}`, addr: s.addr, size: s.size, relocs: relocs.get(s)!.length })),
  };
}

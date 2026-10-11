// COFF object file writer (.obj) for x86-64 Windows. The result links with
// link.exe / lld-link like objects produced by MSVC or clang.
import { AsmError } from '../parse.ts';
import { SCN_EXEC, type XAssembly, type XSection } from '../x64/assembler.ts';

const IMAGE_REL_AMD64_ADDR64 = 1, IMAGE_REL_AMD64_ADDR32 = 2, IMAGE_REL_AMD64_ADDR32NB = 3, IMAGE_REL_AMD64_REL32 = 4;

export interface CoffObjectResult {
  bytes: Uint8Array;
  exports: string[];
  imports: string[];
  sections: { name: string; size: number; relocs: number }[];
  listing: { addr: number; bytes: number[]; line: number; sect: string }[];
}

const alignFlag = (a: number) => ((Math.log2(a) | 0) + 1) << 20;   // IMAGE_SCN_ALIGN_<a>BYTES

export function writeCoffObject(asmb: XAssembly): CoffObjectResult {
  const sections = asmb.sections;
  const syms = asmb.symbols;
  const isLocalLabel = (n: string) => n.startsWith('.L') || n.startsWith('$unwind$');

  // ------------------------------------------------------------------ resolve what can be resolved here
  type Rel = { off: number; sym: string; type: number };
  const relocs = new Map<XSection, Rel[]>();
  const referenced = new Set<string>();
  for (const s of sections) {
    const list: Rel[] = [];
    relocs.set(s, list);
    for (const f of s.fixups) {
      const t = syms.get(f.sym);
      const put = (v: bigint, n: number) => { const u = BigInt.asUintN(n * 8, v); for (let i = 0; i < n; i++) s.data[f.off + i] = Number((u >> BigInt(8 * i)) & 0xffn); };
      // references to local symbols (and all RVAs) go through the section symbol, like MSVC and clang
      const viaSection = t && (f.kind === 'rva' || !t.global);
      const target = viaSection ? t!.sect.name : f.sym;
      const extra = viaSection ? BigInt(t!.off) : 0n;
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
        // REL32 is relative to the end of the 4-byte field; correct for bytes that follow it
        put(extra + f.add - BigInt(f.end - (f.off + 4)), 4);
        list.push({ off: f.off, sym: target, type: IMAGE_REL_AMD64_REL32 });
      } else if (f.kind === 'rva') {
        put(extra + f.add, 4);
        list.push({ off: f.off, sym: target, type: IMAGE_REL_AMD64_ADDR32NB });
      } else {
        put(extra + f.add, f.size);
        list.push({ off: f.off, sym: target, type: f.size === 8 ? IMAGE_REL_AMD64_ADDR64 : IMAGE_REL_AMD64_ADDR32 });
      }
      if (!viaSection) referenced.add(f.sym);
    }
  }

  // ------------------------------------------------------------------ symbol table
  type Sym = { name: string; value: number; sect: number; type: number; cls: number; aux?: number[] };
  const table: Sym[] = [];
  const index = new Map<string, number>();
  const strtab: number[] = [];
  const enc = new TextEncoder();
  sections.forEach((s, i) => {
    // section symbol + auxiliary record (length, number of relocations)
    const aux = new Array(18).fill(0);
    const dv = new DataView(new ArrayBuffer(18));
    dv.setUint32(0, s.size, true);
    dv.setUint16(4, relocs.get(s)!.length, true);
    for (let k = 0; k < 18; k++) aux[k] = dv.getUint8(k);
    table.push({ name: s.name, value: 0, sect: i + 1, type: 0, cls: 3, aux });
  });
  const locals: Sym[] = [], externs: Sym[] = [];
  for (const d of syms.values()) {
    if (isLocalLabel(d.name) && !referenced.has(d.name)) continue;
    const sym: Sym = { name: d.name, value: d.off, sect: sections.indexOf(d.sect) + 1, type: d.func || (d.sect.flags & SCN_EXEC && !isLocalLabel(d.name)) ? 0x20 : 0, cls: d.global ? 2 : 3 };
    (d.global ? externs : locals).push(sym);
  }
  const undefs = [...referenced].filter((n) => !syms.has(n)).sort().map((name) => ({ name, value: 0, sect: 0, type: 0, cls: 2 }) as Sym);
  for (const s of [...locals, ...externs, ...undefs]) table.push(s);
  let idx = 0;
  for (const s of table) { if (!index.has(s.name)) index.set(s.name, idx); idx += 1 + (s.aux ? 1 : 0); }
  const nameField = (n: string): number[] => {
    const b = enc.encode(n);
    if (b.length <= 8) { const out = new Array(8).fill(0); b.forEach((x, k) => (out[k] = x)); return out; }
    const off = 4 + strtab.length;
    strtab.push(...b, 0);
    return [0, 0, 0, 0, off & 0xff, (off >> 8) & 0xff, (off >> 16) & 0xff, off >>> 24];
  };

  // ------------------------------------------------------------------ layout
  let off = 20 + 40 * sections.length;
  const rawOff = new Map<XSection, number>();
  for (const s of sections) {
    if (s.zerofill || !s.size) continue;
    off = Math.ceil(off / 4) * 4;
    rawOff.set(s, off);
    off += s.size;
  }
  const relOff = new Map<XSection, number>();
  for (const s of sections) {
    const n = relocs.get(s)!.length;
    if (n) { relOff.set(s, off); off += 10 * n; }
  }
  const symOff = off;
  const nsyms = idx;
  // strings are collected while writing symbols; write header last
  const symBytes: number[] = [];
  for (const s of table) {
    symBytes.push(...nameField(s.name));
    const dv = new DataView(new ArrayBuffer(10));
    dv.setUint32(0, s.value, true);
    dv.setInt16(4, s.sect, true);
    dv.setUint16(6, s.type, true);
    dv.setUint8(8, s.cls);
    dv.setUint8(9, s.aux ? 1 : 0);
    symBytes.push(...new Uint8Array(dv.buffer));
    if (s.aux) symBytes.push(...s.aux);
  }
  // long section names also go to the string table
  const secNames = sections.map((s) => {
    const b = enc.encode(s.name);
    if (b.length <= 8) { const out = new Array(8).fill(0); b.forEach((x, k) => (out[k] = x)); return out; }
    const o = 4 + strtab.length;
    strtab.push(...b, 0);
    const t = enc.encode('/' + o);
    const out = new Array(8).fill(0); t.forEach((x, k) => (out[k] = x));
    return out;
  });
  const total = symOff + symBytes.length + 4 + strtab.length;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, 0x8664, true);
  dv.setUint16(2, sections.length, true);
  dv.setUint32(4, 0, true);
  dv.setUint32(8, symOff, true);
  dv.setUint32(12, nsyms, true);
  dv.setUint16(16, 0, true);
  dv.setUint16(18, 0, true);
  sections.forEach((s, i) => {
    const o = 20 + i * 40;
    buf.set(secNames[i], o);
    dv.setUint32(o + 8, 0, true);
    dv.setUint32(o + 12, 0, true);
    dv.setUint32(o + 16, s.size, true);
    dv.setUint32(o + 20, rawOff.get(s) ?? 0, true);
    dv.setUint32(o + 24, relOff.get(s) ?? 0, true);
    dv.setUint32(o + 28, 0, true);
    dv.setUint16(o + 32, relocs.get(s)!.length, true);
    dv.setUint16(o + 34, 0, true);
    dv.setUint32(o + 36, (s.flags | alignFlag(s.align)) >>> 0, true);
    if (!s.zerofill && s.size) buf.set(s.data, rawOff.get(s)!);
    const ro = relOff.get(s);
    if (ro !== undefined) relocs.get(s)!.forEach((r, k) => {
      const si = index.get(r.sym);
      if (si === undefined) throw new AsmError(`internal: no symbol '${r.sym}'`, 0);
      dv.setUint32(ro + k * 10, r.off, true);
      dv.setUint32(ro + k * 10 + 4, si, true);
      dv.setUint16(ro + k * 10 + 8, r.type, true);
    });
  });
  buf.set(symBytes, symOff);
  dv.setUint32(symOff + symBytes.length, 4 + strtab.length, true);
  buf.set(strtab, symOff + symBytes.length + 4);

  const listing: CoffObjectResult['listing'] = [];
  for (const s of sections) for (const ins of s.insns) listing.push({ addr: ins.off, bytes: s.data.slice(ins.off, ins.off + ins.len), line: ins.line, sect: s.name });
  return {
    bytes: buf,
    exports: externs.map((s) => s.name).sort(),
    imports: undefs.map((s) => s.name),
    sections: sections.map((s) => ({ name: s.name, size: s.size, relocs: relocs.get(s)!.length })),
    listing,
  };
}

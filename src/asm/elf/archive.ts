// Static library writer for Linux: a GNU `ar` archive (what `ar rcs` makes and ld / ld.lld / gcc read):
// a symbol table member "/" (big-endian count, member offsets, names), a long-name table "//" when a
// member name does not fit "name/" in 16 bytes, then the object files, each 2-byte aligned.
import type { ArchiveMember } from '../archive.ts';

const enc = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** a 60-byte member header; the date is 0 and the owner root, so the same input gives the same bytes */
function header(name: string, size: number): Uint8Array {
  const field = (v: string, n: number) => v.padEnd(n, ' ').slice(0, n);
  return enc.encode(field(name, 16) + field('0', 12) + field('0', 6) + field('0', 6) + field('644', 8) + field(String(size), 10) + '`\n');
}

const even = (b: Uint8Array) => (b.length & 1 ? concat([b, enc.encode('\n')]) : b);

export function writeGnuArchive(members: ArchiveMember[]): Uint8Array {
  const longNames: number[] = [];
  const names = members.map((m) => {
    if (m.name.length <= 15) return m.name + '/';
    const off = longNames.length;
    longNames.push(...enc.encode(m.name + '/\n'));
    return '/' + off;
  });
  const syms = members.flatMap((m, i) => m.symbols.map((s) => ({ s, i })));
  const strs = concat(syms.map((x) => concat([enc.encode(x.s), new Uint8Array(1)])));
  const symSize = 4 + 4 * syms.length + strs.length;
  const longTable = longNames.length ? even(new Uint8Array(longNames)) : null;
  let off = 8 + 60 + symSize + (symSize & 1) + (longTable ? 60 + longTable.length : 0);
  const offsets = members.map((m) => { const o = off; off += 60 + m.data.length + (m.data.length & 1); return o; });

  const symtab = new Uint8Array(4 + 4 * syms.length);
  const dv = new DataView(symtab.buffer);
  dv.setUint32(0, syms.length, false);
  syms.forEach((x, k) => dv.setUint32(4 + 4 * k, offsets[x.i], false));
  const parts: Uint8Array[] = [enc.encode('!<arch>\n'), header('/', symSize), even(concat([symtab, strs]))];
  if (longTable) parts.push(header('//', longTable.length), longTable);
  members.forEach((m, i) => parts.push(header(names[i], m.data.length), even(m.data)));
  return concat(parts);
}

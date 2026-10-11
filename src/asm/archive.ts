// Static library writer: a BSD `ar` archive with a ranlib table of contents
// ("__.SYMDEF SORTED"), the format Apple's ar/ranlib produce and ld64 reads.

export interface ArchiveMember {
  name: string;          // e.g. "mathlib.o"
  data: Uint8Array;
  symbols: string[];     // external symbols defined by this member
}

const enc = new TextEncoder();

/** 60-byte member header with a BSD long name ("#1/len"); the name follows the header. */
function header(name: string, size: number, date: number): { head: Uint8Array; nameBytes: Uint8Array } {
  // pad the name with NULs so that member data stays 8-byte aligned
  const raw = enc.encode(name);
  const nameLen = Math.ceil((raw.length + 1) / 8) * 8 + 4;   // header is 60 bytes: 60 + nameLen ≡ 0 (mod 8)
  const nameBytes = new Uint8Array(nameLen);
  nameBytes.set(raw);
  const field = (v: string, n: number) => v.padEnd(n, ' ').slice(0, n);
  const text = field(`#1/${nameLen}`, 16) + field(String(date), 12) + field('0', 6) + field('0', 6)
    + field('100644', 8) + field(String(size + nameLen), 10) + '`\n';
  return { head: enc.encode(text), nameBytes };
}

export function writeArchive(members: ArchiveMember[], date = Math.floor(Date.now() / 1000)): Uint8Array {
  const parts: Uint8Array[] = [enc.encode('!<arch>\n')];
  // symbol table: entries sorted by name
  const entries = members.flatMap((m, i) => m.symbols.map((s) => ({ s, i })))
    .sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));
  const strs: number[] = [];
  const strx = entries.map((e) => { const o = strs.length; strs.push(...enc.encode(e.s), 0); return o; });
  while (strs.length % 8) strs.push(0);
  const tocSize = 4 + entries.length * 8 + 4 + strs.length;
  const toc = header('__.SYMDEF SORTED', tocSize, date);
  // member offsets (from the start of the file)
  let off = 8 + toc.head.length + toc.nameBytes.length + tocSize;
  const memberOffsets: number[] = [];
  const memberParts: Uint8Array[][] = [];
  for (const m of members) {
    const h = header(m.name, m.data.length, date);
    const pad = (8 - (m.data.length % 8)) % 8;
    memberOffsets.push(off);
    memberParts.push([h.head, h.nameBytes, m.data, new Uint8Array(pad)]);
    off += h.head.length + h.nameBytes.length + m.data.length + pad;
  }
  const tocData = new Uint8Array(tocSize);
  const dv = new DataView(tocData.buffer);
  dv.setUint32(0, entries.length * 8, true);
  entries.forEach((e, k) => {
    dv.setUint32(4 + k * 8, strx[k], true);
    dv.setUint32(8 + k * 8, memberOffsets[e.i], true);
  });
  dv.setUint32(4 + entries.length * 8, strs.length, true);
  tocData.set(strs, 8 + entries.length * 8);
  parts.push(toc.head, toc.nameBytes, tocData);
  // the table of contents itself must keep 8-byte alignment for what follows
  for (const mp of memberParts) parts.push(...mp);
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

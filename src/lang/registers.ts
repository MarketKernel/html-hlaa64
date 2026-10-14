// Register model shared by the HLA64 translator.
// A register is kept as its canonical assembler name: 'x19', 'w0', 'sp', 'xzr', 'd8', 's0'.

export type RegClass = 'x' | 'w' | 'd' | 's';

export interface RegInfo {
  cls: RegClass;
  n: number;          // 0..31 (31 = sp or zr for x/w)
  name: string;       // canonical name
}

const SPECIAL: Record<string, string> = {
  fp: 'x29', lr: 'x30', ip0: 'x16', ip1: 'x17',
};

export function parseReg(text: string): RegInfo | null {
  const t = text.toLowerCase();
  if (SPECIAL[t]) return parseReg(SPECIAL[t]);
  if (t === 'sp') return { cls: 'x', n: 31, name: 'sp' };
  if (t === 'wsp') return { cls: 'w', n: 31, name: 'wsp' };
  if (t === 'xzr') return { cls: 'x', n: 31, name: 'xzr' };
  if (t === 'wzr') return { cls: 'w', n: 31, name: 'wzr' };
  const m = /^([xwds])([0-9]{1,2})$/.exec(t);
  if (!m) return null;
  const n = Number(m[2]);
  if (m[2].length === 2 && m[2][0] === '0') return null;
  const cls = m[1] as RegClass;
  if ((cls === 'x' || cls === 'w') && n > 30) return null;
  if (n > 31) return null;
  return { cls, n, name: cls + n };
}

export function isReg(text: string): boolean {
  return parseReg(text) !== null;
}

export function isFpReg(r: string): boolean {
  const info = parseReg(r);
  return info?.cls === 'd' || info?.cls === 's';
}

export function is64(r: string): boolean {
  return r[0] === 'x' || r === 'sp' || r[0] === 'd';
}

export function regNum(r: string): number {
  return parseReg(r)!.n;
}

/** The same physical register viewed as 32 or 64 bits. */
export function view(r: string, bits: 32 | 64): string {
  const info = parseReg(r)!;
  if (info.cls === 'd' || info.cls === 's') return (bits === 64 ? 'd' : 's') + info.n;
  if (r === 'sp' || r === 'wsp') return bits === 64 ? 'sp' : 'wsp';
  if (r === 'xzr' || r === 'wzr') return bits === 64 ? 'xzr' : 'wzr';
  return (bits === 64 ? 'x' : 'w') + info.n;
}

export function sameReg(a: string, b: string): boolean {
  const ra = parseReg(a), rb = parseReg(b);
  if (!ra || !rb) return false;
  const fa = ra.cls === 'd' || ra.cls === 's';
  const fb = rb.cls === 'd' || rb.cls === 's';
  if (fa !== fb) return false;
  if (ra.n === 31 && rb.n === 31) return (a.endsWith('sp')) === (b.endsWith('sp'));
  return ra.n === rb.n;
}

// ---------------------------------------------------------------------------
// Immediate encodability helpers
// ---------------------------------------------------------------------------

export const MASK64 = (1n << 64n) - 1n;

export function toU64(v: bigint): bigint {
  return v & MASK64;
}

export function toS64(v: bigint): bigint {
  v &= MASK64;
  return v >= 1n << 63n ? v - (1n << 64n) : v;
}

/** add/sub immediate: 12 bits, optionally shifted left by 12. */
export function isAddImm(v: bigint): boolean {
  if (v < 0n) return false;
  if (v < 4096n) return true;
  return (v & 0xfffn) === 0n && v < 4096n << 12n;
}

/**
 * Logical (bitmask) immediate encoding for and/orr/eor/tst.
 * Returns {n, immr, imms} or null when the value cannot be encoded.
 */
export function encodeBitmask(value: bigint, bits: 32 | 64): { n: number; immr: number; imms: number } | null {
  let v = bits === 32 ? value & 0xffffffffn : value & MASK64;
  const full = bits === 64 ? MASK64 : 0xffffffffn;
  if (v === 0n || v === full) return null;
  if (bits === 32) v = v | (v << 32n); // replicate to 64 bits

  // find smallest element size
  let size = 64;
  while (size > 2) {
    const half = size / 2;
    const mask = (1n << BigInt(half)) - 1n;
    if ((v & mask) !== ((v >> BigInt(half)) & mask)) break;
    size = half;
  }
  const emask = size === 64 ? MASK64 : (1n << BigInt(size)) - 1n;
  const elt = v & emask;
  // elt must be a rotated run of ones
  const ones = popcount(elt);
  // find rotation r such that ror(elt, r) = (1<<ones)-1
  const run = (1n << BigInt(ones)) - 1n;
  let rot = -1;
  for (let r = 0; r < size; r++) {
    const rr = BigInt(r);
    const rotated = ((elt >> rr) | (elt << (BigInt(size) - rr))) & emask;
    if (rotated === run) { rot = r; break; }
  }
  if (rot < 0) return null;
  // the element is ROR(run, immr) where immr = (size - rot) % size
  const immr = (size - rot) % size;
  let imms: number;
  // imms encodes element size and ones-1
  switch (size) {
    case 64: imms = ones - 1; break;
    case 32: imms = 0b000000 | (ones - 1); break;
    case 16: imms = 0b100000 | (ones - 1); break;
    case 8: imms = 0b110000 | (ones - 1); break;
    case 4: imms = 0b111000 | (ones - 1); break;
    case 2: imms = 0b111100 | (ones - 1); break;
    default: return null;
  }
  const n = size === 64 ? 1 : 0;
  if (bits === 32 && n === 1) return null;
  return { n, immr, imms };
}

function popcount(v: bigint): number {
  let c = 0;
  while (v) { c += Number(v & 1n); v >>= 1n; }
  return c;
}

/** Can `mov Rd, #v` be done with one movz or movn instruction? */
export function isSingleMov(v: bigint, bits: 32 | 64): boolean {
  const u = bits === 32 ? v & 0xffffffffn : toU64(v);
  const inv = bits === 32 ? ~u & 0xffffffffn : ~u & MASK64;
  return isMovzImm(u, bits) || isMovzImm(inv, bits) || encodeBitmask(u, bits) !== null;
}

export function isMovzImm(u: bigint, bits: 32 | 64): boolean {
  for (let sh = 0; sh < bits; sh += 16) {
    if ((u & ~(0xffffn << BigInt(sh))) === 0n) return true;
  }
  return false;
}

/** Sequence of instructions that loads an arbitrary constant into `reg`. */
export function movSequence(reg: string, v: bigint): string[] {
  const bits = is64(reg) ? 64 : 32;
  const u = bits === 32 ? v & 0xffffffffn : toU64(v);
  if (isSingleMov(u, bits)) return [`mov ${reg}, #${fmtImm(bits === 32 ? toS32(u) : toS64(u))}`];
  // choose movz or movn base depending on which yields fewer instructions
  const chunks: bigint[] = [];
  for (let sh = 0; sh < bits; sh += 16) chunks.push((u >> BigInt(sh)) & 0xffffn);
  const zeros = chunks.filter((c) => c === 0n).length;
  const ffffs = chunks.filter((c) => c === 0xffffn).length;
  const out: string[] = [];
  if (ffffs > zeros) {
    let first = true;
    chunks.forEach((c, i) => {
      if (c === 0xffffn) return;
      if (first) {
        out.push(`movn ${reg}, #${fmtHex(~c & 0xffffn)}${i ? `, lsl #${i * 16}` : ''}`);
        first = false;
      } else {
        out.push(`movk ${reg}, #${fmtHex(c)}${i ? `, lsl #${i * 16}` : ''}`);
      }
    });
  } else {
    let first = true;
    chunks.forEach((c, i) => {
      if (c === 0n) return;
      out.push(`${first ? 'movz' : 'movk'} ${reg}, #${fmtHex(c)}${i ? `, lsl #${i * 16}` : ''}`);
      first = false;
    });
  }
  return out;
}

export function toS32(v: bigint): bigint {
  v &= 0xffffffffn;
  return v >= 0x80000000n ? v - 0x100000000n : v;
}

export function fmtImm(v: bigint): string {
  if (v > 0xffffn || v < -0xffffn) return v < 0n ? '-0x' + (-v).toString(16) : '0x' + v.toString(16);
  return v.toString();
}

function fmtHex(v: bigint): string {
  return v < 10n ? v.toString() : '0x' + v.toString(16);
}

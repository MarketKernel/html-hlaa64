// AArch64 instruction encoder (the subset used by HLA64 plus common hand-written code).
// encode() returns the 32-bit word with relocatable fields left zero, plus a fixup
// that the linker resolves once addresses are known.
import { AsmError, CONDS, type Operand, type Reg, type Value } from './parse.ts';

export type FixKind =
  | 'branch26'    // b, bl
  | 'branch19'    // b.cond, cbz, cbnz, ldr literal
  | 'branch14'    // tbz, tbnz
  | 'adr21'       // adr
  | 'page21'      // adrp sym@PAGE / sym@GOTPAGE
  | 'pageoff12';  // add/ldr/str sym@PAGEOFF (scale = access size shift)

export interface Fixup {
  kind: FixKind;
  sym: string;
  add: bigint;
  got: boolean;
  scale: number;   // for pageoff12: log2 of the access size (0 for add)
}

export interface Encoded {
  word: number;
  fixup?: Fixup;
}

type Ops = Operand[];

const MASK64 = (1n << 64n) - 1n;

class Enc {
  mn: string;
  ops: Ops;
  line: number;
  constructor(mn: string, ops: Ops, line: number) {
    this.mn = mn;
    this.ops = ops;
    this.line = line;
  }

  err(msg: string): never {
    throw new AsmError(`${this.mn}: ${msg}`, this.line);
  }

  count(...n: number[]): void {
    if (!n.includes(this.ops.length)) this.err(`expected ${n.join(' or ')} operands, got ${this.ops.length}`);
  }

  reg(i: number, opts: { sp?: boolean; zr?: boolean; cls?: string } = {}): Reg {
    const o = this.ops[i];
    if (!o || o.k !== 'reg') this.err(`operand ${i + 1} must be a register`);
    if (opts.cls && !opts.cls.includes(o.cls)) this.err(`operand ${i + 1}: unexpected register class '${o.cls}'`);
    if (o.n === 31 && o.sp && opts.sp === false) this.err(`operand ${i + 1}: sp is not allowed here`);
    if (o.n === 31 && !o.sp && opts.zr === false) this.err(`operand ${i + 1}: zero register is not allowed here`);
    return o;
  }

  gpr(i: number, opts: { sp?: boolean; zr?: boolean } = {}): Reg {
    return this.reg(i, { ...opts, cls: 'xw' });
  }

  isReg(i: number): boolean { return this.ops[i]?.k === 'reg'; }
  isImm(i: number): boolean { return this.ops[i]?.k === 'imm'; }

  imm(i: number): bigint {
    const o = this.ops[i];
    if (!o || o.k !== 'imm') this.err(`operand ${i + 1} must be an immediate`);
    if (o.v.sym) this.err(`operand ${i + 1}: unexpected symbol`);
    return o.v.add;
  }

  immV(i: number): Value {
    const o = this.ops[i];
    if (!o || (o.k !== 'imm' && o.k !== 'sym')) this.err(`operand ${i + 1} must be an immediate or symbol`);
    return o.v;
  }

  num(i: number, lo: number, hi: number): number {
    const v = this.imm(i);
    if (v < BigInt(lo) || v > BigInt(hi)) this.err(`immediate ${v} out of range [${lo}, ${hi}]`);
    return Number(v);
  }

  shiftOp(i: number): { op: string; amount: number } | null {
    const o = this.ops[i];
    if (!o) return null;
    if (o.k !== 'shift') this.err(`operand ${i + 1} must be a shift or extend`);
    return { op: o.op, amount: o.amount ?? 0 };
  }

  cond(i: number): number {
    const o = this.ops[i];
    if (!o || o.k !== 'cond') this.err(`operand ${i + 1} must be a condition code`);
    return o.cc;
  }
}

const sf = (r: Reg) => (r.cls === 'x' ? 1 : 0);
const same = (a: Reg, b: Reg, e: Enc) => { if (sf(a) !== sf(b)) e.err('register widths do not match'); };

// ---------------------------------------------------------------------------
// immediates
// ---------------------------------------------------------------------------
export function encodeBitmask(value: bigint, bits: 32 | 64): { n: number; immr: number; imms: number } | null {
  let v = bits === 32 ? value & 0xffffffffn : value & MASK64;
  const full = bits === 64 ? MASK64 : 0xffffffffn;
  if (v === 0n || v === full) return null;
  if (bits === 32) v = v | (v << 32n);
  let size = 64;
  while (size > 2) {
    const half = size / 2;
    const mask = (1n << BigInt(half)) - 1n;
    if ((v & mask) !== ((v >> BigInt(half)) & mask)) break;
    size = half;
  }
  const emask = size === 64 ? MASK64 : (1n << BigInt(size)) - 1n;
  const elt = v & emask;
  let ones = 0;
  for (let x = elt; x; x >>= 1n) ones += Number(x & 1n);
  const run = (1n << BigInt(ones)) - 1n;
  let rot = -1;
  for (let r = 0; r < size; r++) {
    const rr = BigInt(r);
    const rotated = ((elt >> rr) | (elt << (BigInt(size) - rr))) & emask;
    if (rotated === run) { rot = r; break; }
  }
  if (rot < 0) return null;
  const immr = (size - rot) % size;
  const sizeBits: Record<number, number> = { 64: 0, 32: 0, 16: 0b100000, 8: 0b110000, 4: 0b111000, 2: 0b111100 };
  const imms = sizeBits[size] | (ones - 1);
  const n = size === 64 ? 1 : 0;
  return { n, immr, imms };
}

/** imm8 for fmov, or null. */
export function fpImm8(v: number): number | null {
  for (let i = 0; i < 256; i++) if (expandFpImm8(i) === v) return i;
  return null;
}

function expandFpImm8(i: number): number {
  const sign = (i >> 7) & 1, b = (i >> 6) & 1, cd = (i >> 4) & 3, frac = i & 15;
  const exp = (b ? 0x3fc : 0x400) | cd;
  const bits = (BigInt(sign) << 63n) | (BigInt(exp) << 52n) | (BigInt(frac) << 48n);
  const dv = new DataView(new ArrayBuffer(8));
  dv.setBigUint64(0, bits);
  return dv.getFloat64(0);
}

// ---------------------------------------------------------------------------
// instruction classes
// ---------------------------------------------------------------------------
const EXTEND: Record<string, number> = { uxtb: 0, uxth: 1, uxtw: 2, uxtx: 3, sxtb: 4, sxth: 5, sxtw: 6, sxtx: 7 };
const SHIFT: Record<string, number> = { lsl: 0, lsr: 1, asr: 2, ror: 3 };

/** add/sub/adds/subs (also cmp/cmn via rd = zr). op: 0 add, 1 sub; s: set flags. */
function addSub(e: Enc, op: number, s: number, rd: Reg, rn: Reg, rest: number): Encoded {
  const o = e.ops[rest];
  const base = (sf(rd) << 31) | (op << 30) | (s << 29);
  if (!o) e.err('missing operand');
  if (o.k === 'imm') {
    if (o.v.reloc === 'PAGEOFF' || o.v.reloc === 'GOTPAGEOFF') {
      if (op !== 0 || s !== 0) e.err('@PAGEOFF is only valid with add');
      if (!o.v.sym) e.err('@PAGEOFF needs a symbol');
      const w = base | 0x11000000 | (rn.n << 5) | rd.n;
      return { word: w >>> 0, fixup: { kind: 'pageoff12', sym: o.v.sym, add: o.v.add, got: o.v.reloc === 'GOTPAGEOFF', scale: 0 } };
    }
    if (o.v.sym) e.err('unexpected symbol in immediate');
    let v = o.v.add;
    let sh = 0;
    const lsl = e.shiftOp(rest + 1);
    if (lsl) {
      if (lsl.op !== 'lsl' || (lsl.amount !== 0 && lsl.amount !== 12)) e.err('immediate shift must be lsl #0 or #12');
      sh = lsl.amount === 12 ? 1 : 0;
    }
    if (v < 0n) {
      // add x, y, #-n  ==  sub x, y, #n
      v = -v;
      op ^= 1;
    }
    if (!sh && v > 4095n) {
      if ((v & 0xfffn) === 0n && v >> 12n <= 4095n) { v >>= 12n; sh = 1; }
      else e.err(`immediate ${o.v.add} does not fit in 12 bits`);
    }
    if (v > 4095n) e.err('immediate out of range');
    const w = (sf(rd) << 31) | (op << 30) | (s << 29) | 0x11000000 | (sh << 22) | (Number(v) << 10) | (rn.n << 5) | rd.n;
    return { word: w >>> 0 };
  }
  if (o.k !== 'reg') e.err('expected register or immediate');
  const rm = o;
  const sh = e.shiftOp(rest + 1);
  // extended register form: needed for sp operands or explicit extends
  const usesSp = (rd.n === 31 && rd.sp) || (rn.n === 31 && rn.sp);
  if ((sh && EXTEND[sh.op] !== undefined) || usesSp || (rm.cls === 'w' && rd.cls === 'x')) {
    let option: number;
    let amount = 0;
    if (sh && EXTEND[sh.op] !== undefined) { option = EXTEND[sh.op]; amount = sh.amount; }
    else if (sh && sh.op === 'lsl') { option = sf(rd) ? 3 : 2; amount = sh.amount; }
    else if (sh) return e.err(`shift '${sh.op}' not allowed with sp`);
    else option = rm.cls === 'w' && rd.cls === 'x' ? 2 : sf(rd) ? 3 : 2;
    if (amount > 4) e.err('extend amount must be 0..4');
    const w = (sf(rd) << 31) | (op << 30) | (s << 29) | 0x0b200000 | (rm.n << 16) | (option << 13) | (amount << 10) | (rn.n << 5) | rd.n;
    return { word: w >>> 0 };
  }
  same(rd, rm, e);
  let shift = 0, amount = 0;
  if (sh) {
    if (SHIFT[sh.op] === undefined || sh.op === 'ror') e.err(`bad shift '${sh.op}'`);
    shift = SHIFT[sh.op];
    amount = sh.amount;
    if (amount >= (sf(rd) ? 64 : 32)) e.err('shift amount out of range');
  }
  const w = (sf(rd) << 31) | (op << 30) | (s << 29) | 0x0b000000 | (shift << 22) | (rm.n << 16) | (amount << 10) | (rn.n << 5) | rd.n;
  return { word: w >>> 0 };
}

/** and/orr/eor/ands and the inverted bic/orn/eon/bics. opc: 0 and, 1 orr, 2 eor, 3 ands. */
function logical(e: Enc, opc: number, invert: number, rd: Reg, rn: Reg, rest: number): Encoded {
  const o = e.ops[rest];
  if (!o) e.err('missing operand');
  if (o.k === 'imm') {
    let v = e.imm(rest);
    if (invert) v = ~v;
    const bits = sf(rd) ? 64 : 32;
    const bm = encodeBitmask(v, bits);
    if (!bm) e.err(`immediate 0x${BigInt.asUintN(bits, v).toString(16)} cannot be encoded as a logical immediate`);
    const w = (sf(rd) << 31) | (opc << 29) | 0x12000000 | (bm.n << 22) | (bm.immr << 16) | (bm.imms << 10) | (rn.n << 5) | rd.n;
    return { word: w >>> 0 };
  }
  if (o.k !== 'reg') e.err('expected register or immediate');
  same(rd, o, e);
  let shift = 0, amount = 0;
  const sh = e.shiftOp(rest + 1);
  if (sh) {
    if (SHIFT[sh.op] === undefined) e.err(`bad shift '${sh.op}'`);
    shift = SHIFT[sh.op];
    amount = sh.amount;
  }
  const w = (sf(rd) << 31) | (opc << 29) | 0x0a000000 | (shift << 22) | (invert << 21) | (o.n << 16) | (amount << 10) | (rn.n << 5) | rd.n;
  return { word: w >>> 0 };
}

function movWide(e: Enc, opc: number, rd: Reg, imm: bigint, hw: number): Encoded {
  if (imm < 0n || imm > 0xffffn) e.err(`immediate ${imm} does not fit in 16 bits`);
  if (!sf(rd) && hw > 1) e.err('shift out of range for a 32-bit register');
  const w = (sf(rd) << 31) | (opc << 29) | 0x12800000 | (hw << 21) | (Number(imm) << 5) | rd.n;
  return { word: w >>> 0 };
}

function bitfield(e: Enc, opc: number, rd: Reg, rn: Reg, immr: number, imms: number): Encoded {
  const s = sf(rd);
  const w = (s << 31) | (opc << 29) | 0x13000000 | (s << 22) | (immr << 16) | (imms << 10) | (rn.n << 5) | rd.n;
  return { word: w >>> 0 };
}

function dp2(rd: Reg, rn: Reg, rm: Reg, opcode: number): Encoded {
  return { word: ((sf(rd) << 31) | 0x1ac00000 | (rm.n << 16) | (opcode << 10) | (rn.n << 5) | rd.n) >>> 0 };
}

function dp1(rd: Reg, rn: Reg, opcode: number): Encoded {
  return { word: ((sf(rd) << 31) | 0x5ac00000 | (opcode << 10) | (rn.n << 5) | rd.n) >>> 0 };
}

function dp3(rd: Reg, rn: Reg, rm: Reg, ra: Reg | number, op31: number, o0: number): Encoded {
  const a = typeof ra === 'number' ? ra : ra.n;
  return { word: ((sf(rd) << 31) | 0x1b000000 | (op31 << 21) | (rm.n << 16) | (o0 << 15) | (a << 10) | (rn.n << 5) | rd.n) >>> 0 };
}

function csel(rd: Reg, rn: Reg | number, rm: Reg | number, cond: number, op: number, o2: number): Encoded {
  const n = typeof rn === 'number' ? rn : rn.n;
  const m = typeof rm === 'number' ? rm : rm.n;
  return { word: ((sf(rd) << 31) | (op << 30) | 0x1a800000 | (m << 16) | (cond << 12) | (o2 << 10) | (n << 5) | rd.n) >>> 0 };
}

// ---------------------------------------------------------------------------
// loads and stores
// ---------------------------------------------------------------------------
interface LsInfo { size: number; v: number; opc: number }

/** size: log2 bytes; v: SIMD&FP; opc: 0 store, 1 load, 2 load signed 64, 3 load signed 32 */
function lsInfo(e: Enc, mn: string, rt: Reg): LsInfo {
  const fp = rt.cls !== 'x' && rt.cls !== 'w';
  const isLoad = mn.startsWith('ld');
  const base = mn.replace(/^(ld|st)u?r/, '');
  if (fp) {
    if (base !== '') e.err('FP registers use plain ldr/str');
    const size = { b: 0, h: 1, s: 2, d: 3, q: 4 }[rt.cls as 'b']!;
    if (size === 4) return { size: 0, v: 1, opc: isLoad ? 3 : 2 };
    return { size, v: 1, opc: isLoad ? 1 : 0 };
  }
  switch (base) {
    case '': return { size: rt.cls === 'x' ? 3 : 2, v: 0, opc: isLoad ? 1 : 0 };
    case 'b': if (rt.cls !== 'w') e.err('use a w register'); return { size: 0, v: 0, opc: isLoad ? 1 : 0 };
    case 'h': if (rt.cls !== 'w') e.err('use a w register'); return { size: 1, v: 0, opc: isLoad ? 1 : 0 };
    case 'sb': return { size: 0, v: 0, opc: rt.cls === 'x' ? 2 : 3 };
    case 'sh': return { size: 1, v: 0, opc: rt.cls === 'x' ? 2 : 3 };
    case 'sw': if (rt.cls !== 'x') e.err('ldrsw needs an x register'); return { size: 2, v: 0, opc: 2 };
  }
  return e.err('unknown load/store');
}

function loadStore(e: Enc): Encoded {
  const mn = e.mn;
  const rt = e.reg(0);
  const m = e.ops[1];
  const info = lsInfo(e, mn, rt);
  const scaleBytes = info.v && info.opc >= 2 && info.size === 0 ? 16 : 1 << info.size;
  const scale = Math.log2(scaleBytes);
  const head = (info.size << 30) | (info.v << 26) | (info.opc << 22);
  const unscaledOnly = /^(ld|st)ur/.test(mn);
  if (!m) e.err('missing address');
  if (m.k === 'sym' || (m.k === 'imm' && m.v.sym)) {
    // literal load: ldr x0, label
    if (mn !== 'ldr' && mn !== 'ldrsw') e.err('literal form only for ldr');
    const opc = info.v ? ({ 2: 0, 3: 1, 4: 2 } as Record<number, number>)[info.size] ?? 0 : mn === 'ldrsw' ? 2 : rt.cls === 'x' ? 1 : 0;
    const w = (opc << 30) | 0x18000000 | (info.v << 26) | rt.n;
    return { word: w >>> 0, fixup: { kind: 'branch19', sym: m.v.sym!, add: m.v.add, got: false, scale: 0 } };
  }
  if (m.k !== 'mem') e.err('expected a memory operand');
  const rn = m.base.n;
  // post-index: [xn], #imm
  if (e.ops.length === 3) {
    if (m.off || m.index || m.pre) e.err('bad post-index form');
    const off = Number(e.imm(2));
    if (off < -256 || off > 255) e.err('post-index offset out of range');
    return { word: (0x38000400 | head | ((off & 0x1ff) << 12) | (rn << 5) | rt.n) >>> 0 };
  }
  e.count(2);
  if (m.index) {
    const rm = m.index;
    let option = 3;
    if (m.ext) option = ({ lsl: 3, uxtw: 2, sxtw: 6, sxtx: 7, uxtx: 3 } as Record<string, number>)[m.ext];
    if (rm.cls === 'w' && option !== 2 && option !== 6) e.err('w index register needs uxtw or sxtw');
    if (rm.cls === 'x' && (option === 2 || option === 6)) e.err('uxtw/sxtw need a w index register');
    let S = 0;
    if (m.amount !== null) {
      if (m.amount === scale) S = 1;
      else if (m.amount === 0 && m.ext !== 'lsl') S = 0;
      else if (m.amount === 0 && scale === 0) S = 1;
      else if (m.amount !== 0) e.err(`index shift must be #${scale}`);
    }
    return { word: (0x38200800 | head | (rm.n << 16) | (option << 13) | (S << 12) | (rn << 5) | rt.n) >>> 0 };
  }
  const off = m.off;
  if (off && (off.reloc === 'PAGEOFF' || off.reloc === 'GOTPAGEOFF')) {
    if (m.pre) e.err('@PAGEOFF cannot be used with writeback');
    if (!off.sym) e.err('@PAGEOFF needs a symbol');
    return {
      word: (0x39000000 | head | (rn << 5) | rt.n) >>> 0,
      fixup: { kind: 'pageoff12', sym: off.sym, add: off.add, got: off.reloc === 'GOTPAGEOFF', scale },
    };
  }
  if (off?.sym) e.err('symbolic offsets need @PAGEOFF');
  const v = off ? Number(off.add) : 0;
  if (m.pre) {
    if (v < -256 || v > 255) e.err('pre-index offset out of range');
    return { word: (0x38000c00 | head | ((v & 0x1ff) << 12) | (rn << 5) | rt.n) >>> 0 };
  }
  if (!unscaledOnly && v >= 0 && v % scaleBytes === 0 && v / scaleBytes < 4096) {
    return { word: (0x39000000 | head | ((v / scaleBytes) << 10) | (rn << 5) | rt.n) >>> 0 };
  }
  if (v >= -256 && v <= 255) {
    // ldur / stur
    return { word: (0x38000000 | head | ((v & 0x1ff) << 12) | (rn << 5) | rt.n) >>> 0 };
  }
  return e.err(`offset ${v} out of range`);
}

function loadStorePair(e: Enc): Encoded {
  const isLoad = e.mn === 'ldp';
  const r1 = e.reg(0), r2 = e.reg(1);
  if (r1.cls !== r2.cls) e.err('register classes do not match');
  let opc: number, v = 0, scale: number;
  switch (r1.cls) {
    case 'x': opc = 2; scale = 8; break;
    case 'w': opc = 0; scale = 4; break;
    case 's': opc = 0; v = 1; scale = 4; break;
    case 'd': opc = 1; v = 1; scale = 8; break;
    case 'q': opc = 2; v = 1; scale = 16; break;
    default: return e.err('bad register for ldp/stp');
  }
  const m = e.ops[2];
  if (!m || m.k !== 'mem' || m.index) e.err('expected [base, #imm]');
  let mode: number, off: number;
  if (e.ops.length === 4) {
    if (m.off || m.pre) e.err('bad post-index form');
    mode = 1;
    off = Number(e.imm(3));
  } else {
    e.count(3);
    off = m.off ? Number(m.off.add) : 0;
    if (m.off?.sym) e.err('symbolic offset not allowed');
    mode = m.pre ? 3 : 2;
  }
  if (off % scale !== 0) e.err(`offset must be a multiple of ${scale}`);
  const imm7 = off / scale;
  if (imm7 < -64 || imm7 > 63) e.err('offset out of range');
  const w = (opc << 30) | 0x28000000 | (v << 26) | (mode << 23) | ((isLoad ? 1 : 0) << 22) | ((imm7 & 0x7f) << 15) | (r2.n << 10) | (m.base.n << 5) | r1.n;
  return { word: w >>> 0 };
}

// ---------------------------------------------------------------------------
// floating point
// ---------------------------------------------------------------------------
function ftype(e: Enc, r: Reg): number {
  if (r.cls === 's') return 0;
  if (r.cls === 'd') return 1;
  if (r.cls === 'h') return 3;
  return e.err('expected an s or d register');
}

function fp2(e: Enc, opcode: number): Encoded {
  e.count(3);
  const rd = e.reg(0), rn = e.reg(1), rm = e.reg(2);
  const t = ftype(e, rd);
  if (ftype(e, rn) !== t || ftype(e, rm) !== t) e.err('register types do not match');
  return { word: (0x1e200800 | (t << 22) | (rm.n << 16) | (opcode << 12) | (rn.n << 5) | rd.n) >>> 0 };
}

function fp1(e: Enc, opcode: number): Encoded {
  e.count(2);
  const rd = e.reg(0), rn = e.reg(1);
  const t = ftype(e, rd);
  if (ftype(e, rn) !== t) e.err('register types do not match');
  return { word: (0x1e204000 | (t << 22) | (opcode << 15) | (rn.n << 5) | rd.n) >>> 0 };
}

/** fp <-> int conversions. rmode/opcode select scvtf, ucvtf, fcvtzs, fcvtzu, fmov. */
function fpInt(gpr: Reg, fpr: Reg, e: Enc, rmode: number, opcode: number, toFp: boolean): Encoded {
  const t = ftype(e, fpr);
  const rd = toFp ? fpr.n : gpr.n;
  const rn = toFp ? gpr.n : fpr.n;
  return { word: ((sf(gpr) << 31) | 0x1e200000 | (t << 22) | (1 << 21) | (rmode << 19) | (opcode << 16) | (rn << 5) | rd) >>> 0 };
}

// ---------------------------------------------------------------------------
// main dispatcher
// ---------------------------------------------------------------------------
const COND_BRANCH = /^b\.?(eq|ne|cs|hs|cc|lo|mi|pl|vs|vc|hi|ls|ge|lt|gt|le|al|nv)$/;

export function encode(mnemonic: string, ops: Ops, line: number): Encoded {
  const e: Enc = new Enc(mnemonic, ops, line);
  const mn = mnemonic;

  const cb = COND_BRANCH.exec(mn);
  if (cb || mn.startsWith('b.')) {
    const cc = cb ? CONDS[cb[1]] : undefined;
    if (cc === undefined) e.err('unknown condition');
    e.count(1);
    const t = e.immV(0);
    return { word: (0x54000000 | cc) >>> 0, fixup: { kind: 'branch19', sym: t.sym ?? '', add: t.add, got: false, scale: 0 } };
  }

  switch (mn) {
    // ---------------------------------------------------------------- moves
    case 'mov': {
      e.count(2);
      const rd = e.reg(0);
      if (rd.cls !== 'x' && rd.cls !== 'w') {
        // fmov alias for vector moves is not supported; treat as fmov
        return encode('fmov', ops, line);
      }
      const o = ops[1];
      if (o.k === 'reg') {
        if (o.cls !== 'x' && o.cls !== 'w') return encode('fmov', ops, line);
        same(rd, o, e);
        if ((rd.n === 31 && rd.sp) || (o.n === 31 && o.sp)) {
          // mov to/from sp: add rd, rn, #0
          return { word: ((sf(rd) << 31) | 0x11000000 | (o.n << 5) | rd.n) >>> 0 };
        }
        // orr rd, zr, rm
        return { word: ((sf(rd) << 31) | 0x2a0003e0 | (o.n << 16) | rd.n) >>> 0 };
      }
      const bits = sf(rd) ? 64 : 32;
      const raw = e.imm(1);
      const v = bits === 64 ? BigInt.asUintN(64, raw) : BigInt.asUintN(32, raw);
      if (bits === 32 && (raw > 0xffffffffn || raw < -0x80000000n)) e.err('immediate out of 32-bit range');
      const full = bits === 64 ? MASK64 : 0xffffffffn;
      for (let hw = 0; hw < bits / 16; hw++) {
        if ((v & ~(0xffffn << BigInt(hw * 16)) & full) === 0n) return movWide(e, 2, rd, (v >> BigInt(hw * 16)) & 0xffffn, hw);
      }
      const inv = ~v & full;
      for (let hw = 0; hw < bits / 16; hw++) {
        if ((inv & ~(0xffffn << BigInt(hw * 16)) & full) === 0n) return movWide(e, 0, rd, (inv >> BigInt(hw * 16)) & 0xffffn, hw);
      }
      const bm = encodeBitmask(v, bits as 32 | 64);
      if (bm) {
        return { word: ((sf(rd) << 31) | 0x320003e0 | (bm.n << 22) | (bm.immr << 16) | (bm.imms << 10) | rd.n) >>> 0 };
      }
      return e.err(`immediate 0x${v.toString(16)} cannot be loaded with a single mov (use movz/movk)`);
    }
    case 'movz': case 'movn': case 'movk': {
      e.count(2, 3);
      const rd = e.gpr(0, { sp: false });
      let hw = 0;
      const sh = e.shiftOp(2);
      if (sh) {
        if (sh.op !== 'lsl' || sh.amount % 16 !== 0) e.err('shift must be lsl #0/16/32/48');
        hw = sh.amount / 16;
      }
      return movWide(e, { movn: 0, movz: 2, movk: 3 }[mn], rd, e.imm(1), hw);
    }

    // ---------------------------------------------------------------- arithmetic
    case 'add': case 'sub': case 'adds': case 'subs': {
      e.count(3, 4);
      const s = mn.endsWith('s') ? 1 : 0;
      const rd = e.gpr(0), rn = e.gpr(1);
      same(rd, rn, e);
      return addSub(e, mn.startsWith('add') ? 0 : 1, s, rd, rn, 2);
    }
    case 'cmp': case 'cmn': {
      e.count(2, 3);
      const rn = e.gpr(0);
      const zr: Reg = { k: 'reg', cls: rn.cls, n: 31, sp: false };
      return addSub(e, mn === 'cmp' ? 1 : 0, 1, zr, rn, 1);
    }
    case 'neg': case 'negs': {
      e.count(2, 3);
      const rd = e.gpr(0);
      const zr: Reg = { k: 'reg', cls: rd.cls, n: 31, sp: false };
      return addSub(e, 1, mn === 'negs' ? 1 : 0, rd, zr, 1);
    }
    case 'and': case 'orr': case 'eor': case 'ands': case 'bic': case 'orn': case 'eon': case 'bics': {
      e.count(3, 4);
      const rd = e.gpr(0), rn = e.gpr(1);
      same(rd, rn, e);
      const opc = { and: 0, orr: 1, eor: 2, ands: 3, bic: 0, orn: 1, eon: 2, bics: 3 }[mn];
      const inv = ['bic', 'orn', 'eon', 'bics'].includes(mn) ? 1 : 0;
      return logical(e, opc, inv, rd, rn, 2);
    }
    case 'tst': {
      e.count(2, 3);
      const rn = e.gpr(0);
      const zr: Reg = { k: 'reg', cls: rn.cls, n: 31, sp: false };
      return logical(e, 3, 0, zr, rn, 1);
    }
    case 'mvn': {
      e.count(2, 3);
      const rd = e.gpr(0);
      const zr: Reg = { k: 'reg', cls: rd.cls, n: 31, sp: false };
      return logical(e, 1, 1, rd, zr, 1);
    }
    case 'lsl': case 'lsr': case 'asr': case 'ror': {
      e.count(3);
      const rd = e.gpr(0), rn = e.gpr(1);
      same(rd, rn, e);
      const size = sf(rd) ? 64 : 32;
      if (e.isReg(2)) {
        const rm = e.gpr(2);
        return dp2(rd, rn, rm, { lsl: 8, lsr: 9, asr: 10, ror: 11 }[mn]);
      }
      const sh = e.num(2, 0, size - 1);
      if (mn === 'lsl') return bitfield(e, 2, rd, rn, (size - sh) % size, size - 1 - sh);
      if (mn === 'lsr') return bitfield(e, 2, rd, rn, sh, size - 1);
      if (mn === 'asr') return bitfield(e, 0, rd, rn, sh, size - 1);
      // ror imm = extr rd, rn, rn, #sh
      return { word: ((sf(rd) << 31) | 0x13800000 | (sf(rd) << 22) | (rn.n << 16) | (sh << 10) | (rn.n << 5) | rd.n) >>> 0 };
    }
    case 'lslv': case 'lsrv': case 'asrv': case 'rorv': {
      e.count(3);
      return dp2(e.gpr(0), e.gpr(1), e.gpr(2), { lslv: 8, lsrv: 9, asrv: 10, rorv: 11 }[mn]);
    }
    case 'sxtb': case 'sxth': case 'sxtw': case 'uxtb': case 'uxth': {
      e.count(2);
      const rd = e.gpr(0), rn = e.gpr(1);
      const imms = { sxtb: 7, sxth: 15, sxtw: 31, uxtb: 7, uxth: 15 }[mn];
      const signed = mn[0] === 's';
      if (!signed && rd.cls !== 'w') e.err('uxtb/uxth use a w destination');
      if (mn === 'sxtw' && rd.cls !== 'x') e.err('sxtw needs an x destination');
      return bitfield(e, signed ? 0 : 2, rd, rn, 0, imms);
    }
    case 'ubfx': case 'sbfx': case 'ubfiz': case 'sbfiz': case 'bfi': case 'bfxil': {
      e.count(4);
      const rd = e.gpr(0), rn = e.gpr(1);
      const size = sf(rd) ? 64 : 32;
      const lsb = e.num(2, 0, size - 1), width = e.num(3, 1, size);
      const opc = mn.startsWith('u') ? 2 : mn.startsWith('s') ? 0 : 1;
      if (mn === 'ubfx' || mn === 'sbfx' || mn === 'bfxil') return bitfield(e, opc, rd, rn, lsb, lsb + width - 1);
      return bitfield(e, opc, rd, rn, (size - lsb) % size, width - 1);
    }
    case 'ubfm': case 'sbfm': case 'bfm': {
      e.count(4);
      return bitfield(e, { sbfm: 0, bfm: 1, ubfm: 2 }[mn], e.gpr(0), e.gpr(1), e.num(2, 0, 63), e.num(3, 0, 63));
    }
    case 'extr': {
      e.count(4);
      const rd = e.gpr(0), rn = e.gpr(1), rm = e.gpr(2);
      const lsb = e.num(3, 0, sf(rd) ? 63 : 31);
      return { word: ((sf(rd) << 31) | 0x13800000 | (sf(rd) << 22) | (rm.n << 16) | (lsb << 10) | (rn.n << 5) | rd.n) >>> 0 };
    }
    case 'mul': case 'mneg': {
      e.count(3);
      return dp3(e.gpr(0), e.gpr(1), e.gpr(2), 31, 0, mn === 'mneg' ? 1 : 0);
    }
    case 'madd': case 'msub': {
      e.count(4);
      return dp3(e.gpr(0), e.gpr(1), e.gpr(2), e.gpr(3), 0, mn === 'msub' ? 1 : 0);
    }
    case 'smull': case 'umull': case 'smaddl': case 'umaddl': case 'smsubl': case 'umsubl': {
      const isL = mn.endsWith('ll') && !mn.includes('add') && !mn.includes('sub');
      e.count(isL ? 3 : 4);
      const rd = e.reg(0, { cls: 'x' }), rn = e.reg(1, { cls: 'w' }), rm = e.reg(2, { cls: 'w' });
      const ra = isL ? 31 : e.reg(3, { cls: 'x' });
      const op31 = mn[0] === 'u' ? 5 : 1;
      return dp3(rd, rn, rm, ra, op31, mn.includes('sub') ? 1 : 0);
    }
    case 'smulh': case 'umulh': {
      e.count(3);
      const rd = e.reg(0, { cls: 'x' });
      return dp3(rd, e.reg(1, { cls: 'x' }), e.reg(2, { cls: 'x' }), 31, mn === 'smulh' ? 2 : 6, 0);
    }
    case 'sdiv': case 'udiv': {
      e.count(3);
      return dp2(e.gpr(0), e.gpr(1), e.gpr(2), mn === 'sdiv' ? 3 : 2);
    }
    case 'clz': case 'cls': case 'rbit': case 'rev': case 'rev16': case 'rev32': {
      e.count(2);
      const rd = e.gpr(0), rn = e.gpr(1);
      let opcode = { rbit: 0, rev16: 1, rev32: 2, rev: 3, clz: 4, cls: 5 }[mn];
      if (mn === 'rev' && !sf(rd)) opcode = 2;
      if (mn === 'rev32' && !sf(rd)) e.err('rev32 needs x registers');
      return dp1(rd, rn, opcode);
    }

    // ---------------------------------------------------------------- conditional
    case 'csel': case 'csinc': case 'csinv': case 'csneg': {
      e.count(4);
      const rd = e.gpr(0);
      const [op, o2] = { csel: [0, 0], csinc: [0, 1], csinv: [1, 0], csneg: [1, 1] }[mn];
      return csel(rd, e.gpr(1), e.gpr(2), e.cond(3), op, o2);
    }
    case 'cset': case 'csetm': {
      e.count(2);
      const rd = e.gpr(0);
      return csel(rd, 31, 31, e.cond(1) ^ 1, mn === 'csetm' ? 1 : 0, mn === 'csetm' ? 0 : 1);
    }
    case 'cinc': case 'cinv': case 'cneg': {
      e.count(3);
      const rd = e.gpr(0), rn = e.gpr(1);
      const [op, o2] = { cinc: [0, 1], cinv: [1, 0], cneg: [1, 1] }[mn];
      return csel(rd, rn, rn, e.cond(2) ^ 1, op, o2);
    }
    case 'ccmp': case 'ccmn': {
      e.count(4);
      const rn = e.gpr(0);
      const nzcv = e.num(2, 0, 15);
      const cc = e.cond(3);
      const op = mn === 'ccmp' ? 1 : 0;
      if (e.isImm(1)) {
        const imm = e.num(1, 0, 31);
        return { word: ((sf(rn) << 31) | (op << 30) | 0x3a400800 | (imm << 16) | (cc << 12) | (rn.n << 5) | nzcv) >>> 0 };
      }
      const rm = e.gpr(1);
      return { word: ((sf(rn) << 31) | (op << 30) | 0x3a400000 | (rm.n << 16) | (cc << 12) | (rn.n << 5) | nzcv) >>> 0 };
    }

    // ---------------------------------------------------------------- addresses
    case 'adr': case 'adrp': {
      e.count(2);
      const rd = e.reg(0, { cls: 'x' });
      const v = e.immV(1);
      if (!v.sym) e.err('expected a symbol');
      if (mn === 'adrp') {
        if (v.reloc !== 'PAGE' && v.reloc !== 'GOTPAGE') e.err('adrp needs sym@PAGE or sym@GOTPAGE');
        return { word: (0x90000000 | rd.n) >>> 0, fixup: { kind: 'page21', sym: v.sym, add: v.add, got: v.reloc === 'GOTPAGE', scale: 0 } };
      }
      return { word: (0x10000000 | rd.n) >>> 0, fixup: { kind: 'adr21', sym: v.sym, add: v.add, got: false, scale: 0 } };
    }

    // ---------------------------------------------------------------- branches
    case 'b': case 'bl': {
      e.count(1);
      const v = e.immV(0);
      return { word: mn === 'b' ? 0x14000000 : 0x94000000, fixup: { kind: 'branch26', sym: v.sym ?? '', add: v.add, got: false, scale: 0 } };
    }
    case 'br': case 'blr': {
      e.count(1);
      const rn = e.reg(0, { cls: 'x' });
      return { word: ((mn === 'br' ? 0xd61f0000 : 0xd63f0000) | (rn.n << 5)) >>> 0 };
    }
    case 'ret': {
      e.count(0, 1);
      const rn = ops.length ? e.reg(0, { cls: 'x' }).n : 30;
      return { word: (0xd65f0000 | (rn << 5)) >>> 0 };
    }
    case 'cbz': case 'cbnz': {
      e.count(2);
      const rt = e.gpr(0);
      const v = e.immV(1);
      return { word: ((sf(rt) << 31) | (mn === 'cbz' ? 0x34000000 : 0x35000000) | rt.n) >>> 0, fixup: { kind: 'branch19', sym: v.sym ?? '', add: v.add, got: false, scale: 0 } };
    }
    case 'tbz': case 'tbnz': {
      e.count(3);
      const rt = e.gpr(0);
      const bit = e.num(1, 0, sf(rt) ? 63 : 31);
      const v = e.immV(2);
      const w = ((bit >> 5) << 31) | (mn === 'tbz' ? 0x36000000 : 0x37000000) | ((bit & 31) << 19) | rt.n;
      return { word: w >>> 0, fixup: { kind: 'branch14', sym: v.sym ?? '', add: v.add, got: false, scale: 0 } };
    }

    // ---------------------------------------------------------------- system
    case 'svc': e.count(1); return { word: (0xd4000001 | (e.num(0, 0, 0xffff) << 5)) >>> 0 };
    case 'brk': e.count(1); return { word: (0xd4200000 | (e.num(0, 0, 0xffff) << 5)) >>> 0 };
    case 'nop': e.count(0); return { word: 0xd503201f };
    case 'yield': return { word: 0xd503203f };
    case 'dmb': return { word: 0xd5033bbf };   // dmb ish
    case 'isb': return { word: 0xd5033fdf };

    // ---------------------------------------------------------------- memory
    case 'ldr': case 'str': case 'ldrb': case 'strb': case 'ldrh': case 'strh':
    case 'ldrsb': case 'ldrsh': case 'ldrsw':
    case 'ldur': case 'stur': case 'ldurb': case 'sturb': case 'ldurh': case 'sturh':
    case 'ldursb': case 'ldursh': case 'ldursw':
      e.count(2, 3);
      return loadStore(e);
    case 'ldp': case 'stp':
      e.count(3, 4);
      return loadStorePair(e);

    // ---------------------------------------------------------------- floating point
    case 'fmov': {
      e.count(2);
      const rd = e.reg(0);
      const o = ops[1];
      if (o.k === 'fimm' || o.k === 'imm') {
        const val = o.k === 'fimm' ? o.v : Number(e.imm(1));
        const t = ftype(e, rd);
        const i8 = fpImm8(val);
        if (i8 === null) e.err(`${val} cannot be encoded as an fmov immediate`);
        return { word: (0x1e201000 | (t << 22) | (i8 << 13) | rd.n) >>> 0 };
      }
      const rn = e.reg(1);
      const rdFp = rd.cls !== 'x' && rd.cls !== 'w';
      const rnFp = rn.cls !== 'x' && rn.cls !== 'w';
      if (rdFp && rnFp) {
        const t = ftype(e, rd);
        if (ftype(e, rn) !== t) e.err('register types do not match');
        return { word: (0x1e204000 | (t << 22) | (rn.n << 5) | rd.n) >>> 0 };
      }
      if (rdFp) {
        if ((rd.cls === 'd') !== (rn.cls === 'x')) e.err('use fmov d, x or fmov s, w');
        return fpInt(rn, rd, e, 0, 7, true);
      }
      if ((rn.cls === 'd') !== (rd.cls === 'x')) e.err('use fmov x, d or fmov w, s');
      return fpInt(rd, rn, e, 0, 6, false);
    }
    case 'fadd': return fp2(e, 2);
    case 'fsub': return fp2(e, 3);
    case 'fmul': return fp2(e, 0);
    case 'fdiv': return fp2(e, 1);
    case 'fmax': return fp2(e, 4);
    case 'fmin': return fp2(e, 5);
    case 'fmaxnm': return fp2(e, 6);
    case 'fminnm': return fp2(e, 7);
    case 'fnmul': return fp2(e, 8);
    case 'fneg': return fp1(e, 2);
    case 'fabs': return fp1(e, 1);
    case 'fsqrt': return fp1(e, 3);
    case 'frintn': return fp1(e, 8);
    case 'frintp': return fp1(e, 9);
    case 'frintm': return fp1(e, 10);
    case 'frintz': return fp1(e, 11);
    case 'frinta': return fp1(e, 12);
    case 'fcvt': {
      e.count(2);
      const rd = e.reg(0), rn = e.reg(1);
      const opc = ftype(e, rd), t = ftype(e, rn);
      if (opc === t) e.err('fcvt needs different precisions');
      return { word: (0x1e224000 | (t << 22) | (opc << 15) | (rn.n << 5) | rd.n) >>> 0 };
    }
    case 'fcmp': case 'fcmpe': {
      e.count(2);
      const rn = e.reg(1 - 1);
      const t = ftype(e, rn);
      const ex = mn === 'fcmpe' ? 0x10 : 0;
      if (ops[1].k === 'fimm' || ops[1].k === 'imm') {
        const z = ops[1].k === 'fimm' ? ops[1].v : Number(e.imm(1));
        if (z !== 0) e.err('fcmp immediate must be #0.0');
        return { word: (0x1e202008 | (t << 22) | (rn.n << 5) | ex) >>> 0 };
      }
      const rm = e.reg(1);
      if (ftype(e, rm) !== t) e.err('register types do not match');
      return { word: (0x1e202000 | (t << 22) | (rm.n << 16) | (rn.n << 5) | ex) >>> 0 };
    }
    case 'fcsel': {
      e.count(4);
      const rd = e.reg(0), rn = e.reg(1), rm = e.reg(2);
      const t = ftype(e, rd);
      return { word: (0x1e200c00 | (t << 22) | (rm.n << 16) | (e.cond(3) << 12) | (rn.n << 5) | rd.n) >>> 0 };
    }
    case 'fmadd': case 'fmsub': case 'fnmadd': case 'fnmsub': {
      e.count(4);
      const rd = e.reg(0), rn = e.reg(1), rm = e.reg(2), ra = e.reg(3);
      const t = ftype(e, rd);
      const [o1, o0] = { fmadd: [0, 0], fmsub: [0, 1], fnmadd: [1, 0], fnmsub: [1, 1] }[mn];
      return { word: (0x1f000000 | (t << 22) | (o1 << 21) | (rm.n << 16) | (o0 << 15) | (ra.n << 10) | (rn.n << 5) | rd.n) >>> 0 };
    }
    case 'scvtf': case 'ucvtf': {
      e.count(2);
      const rd = e.reg(0), rn = e.gpr(1);
      return fpInt(rn, rd, e, 0, mn === 'scvtf' ? 2 : 3, true);
    }
    case 'fcvtzs': case 'fcvtzu': case 'fcvtas': case 'fcvtau': case 'fcvtms': case 'fcvtmu': case 'fcvtps': case 'fcvtpu': case 'fcvtns': case 'fcvtnu': {
      e.count(2);
      const rd = e.gpr(0), rn = e.reg(1);
      const rmode = { z: 3, a: 0, m: 2, p: 1, n: 0 }[mn[4] as 'z'];
      let opcode = mn.endsWith('s') ? 0 : 1;
      if (mn[4] === 'a') opcode += 4;
      return fpInt(rd, rn, e, rmode, opcode, false);
    }
  }
  return e.err('unknown or unsupported instruction');
}

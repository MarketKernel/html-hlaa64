// x86-64 instruction encoder (Intel syntax, LLVM dialect) for the subset HLA64
// generates plus common hand-written code. Encodings follow LLVM's choices so the
// output is byte-identical to `clang --target=x86_64-pc-windows-msvc -c`.
import { AsmError, parseValue, splitOperands, type Value } from '../parse.ts';
import { xreg, XCOND, type XReg } from './regs.ts';

export type XOperand =
  | XReg
  | { k: 'imm'; v: Value }
  | { k: 'mem'; size: 0 | 1 | 2 | 4 | 8 | 16; base: XReg | 'rip' | null; index: XReg | null; scale: 1 | 2 | 4 | 8; disp: Value };

type Mem = Extract<XOperand, { k: 'mem' }>;

/** A symbolic field: pc-relative (`rel`, relative to the end of the instruction) or absolute. */
export interface XFixup {
  off: number;          // offset of the field inside the instruction
  size: 1 | 4 | 8;
  kind: 'rel' | 'abs';
  sym: string;
  add: bigint;
}

export interface XEncoded {
  bytes: number[];
  fixups: XFixup[];
  /** jmp/jcc to a label: the assembler chooses the short or the long form */
  jump?: { cond: number | null; target: Value };
}

// ---------------------------------------------------------------------------
// operand parsing
// ---------------------------------------------------------------------------
const PTR: Record<string, Mem['size']> = { byte: 1, word: 2, dword: 4, qword: 8, xmmword: 16, oword: 16 };

export function parseXOperand(text: string, line: number): XOperand {
  let t = text.trim();
  const r = xreg(t);
  if (r) return r;
  let size: Mem['size'] = 0;
  const pm = /^(byte|word|dword|qword|xmmword|oword)\s+ptr\s+/i.exec(t);
  if (pm) {
    size = PTR[pm[1].toLowerCase()];
    t = t.slice(pm[0].length).trim();
  }
  if (t.startsWith('[')) {
    if (!t.endsWith(']')) throw new AsmError(`bad memory operand '${text}'`, line);
    return parseMem(t.slice(1, -1), size, line, text);
  }
  if (size) throw new AsmError(`'ptr' needs a memory operand: '${text}'`, line);
  if (/^offset\s+/i.test(t)) t = t.replace(/^offset\s+/i, '');
  return { k: 'imm', v: parseValue(t, line) };
}

function parseMem(body: string, size: Mem['size'], line: number, text: string): Mem {
  // split into signed terms at top level
  const terms: { neg: boolean; t: string }[] = [];
  let cur = '', depth = 0, neg = false;
  const flush = () => { if (cur.trim()) terms.push({ neg, t: cur.trim() }); cur = ''; };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '(') depth++;
    if (c === ')') depth--;
    if ((c === '+' || c === '-') && depth === 0) {
      // a sign directly after '*' belongs to a number (e.g. 4*-1 is not supported anyway)
      if (cur.trim() === '' && c === '-') { neg = !neg; continue; }
      flush();
      neg = c === '-';
      continue;
    }
    cur += c;
  }
  flush();
  let base: Mem['base'] = null, index: XReg | null = null, scale: Mem['scale'] = 1;
  let disp: Value = { sym: null, add: 0n, reloc: null };
  for (const { neg: n, t } of terms) {
    if (/^rip$/i.test(t)) { if (n || base) throw new AsmError(`bad rip operand '${text}'`, line); base = 'rip'; continue; }
    const sc = /^(\w+)\s*\*\s*(\d+)$|^(\d+)\s*\*\s*(\w+)$/.exec(t);
    if (sc && xreg(sc[1] ?? sc[4])) {
      const rn = sc[1] ?? sc[4], sv = Number(sc[2] ?? sc[3]);
      const rr = xreg(rn);
      if (!rr || rr.size !== 8 || rr.xmm) throw new AsmError(`bad index register in '${text}'`, line);
      if (![1, 2, 4, 8].includes(sv)) throw new AsmError(`scale must be 1, 2, 4 or 8 in '${text}'`, line);
      if (index || n) throw new AsmError(`bad index in '${text}'`, line);
      index = rr; scale = sv as Mem['scale'];
      continue;
    }
    const rr = xreg(t);
    if (rr) {
      if (rr.size !== 8 || rr.xmm || n) throw new AsmError(`bad address register '${t}' in '${text}'`, line);
      if (!base) base = rr;
      else if (!index) index = rr;
      else throw new AsmError(`too many registers in '${text}'`, line);
      continue;
    }
    const v = parseValue(t, line);
    if (v.sym && n) throw new AsmError(`cannot subtract a symbol in '${text}'`, line);
    if (v.sym && disp.sym) throw new AsmError(`two symbols in '${text}'`, line);
    disp = { sym: disp.sym ?? v.sym, add: disp.add + (n ? -v.add : v.add), reloc: null };
  }
  if (index && index.n === 4) throw new AsmError(`rsp cannot be an index register: '${text}'`, line);
  if (base === 'rip' && index) throw new AsmError(`rip-relative addressing cannot have an index: '${text}'`, line);
  return { k: 'mem', size, base, index, scale, disp };
}

// ---------------------------------------------------------------------------
// encoding helpers
// ---------------------------------------------------------------------------
const fitsI8 = (v: bigint) => v >= -128n && v <= 127n;
const fitsI32 = (v: bigint) => v >= -(1n << 31n) && v < 1n << 31n;
const le = (v: bigint, n: number) => { const out: number[] = []; const u = BigInt.asUintN(n * 8, v); for (let i = 0; i < n; i++) out.push(Number((u >> BigInt(8 * i)) & 0xffn)); return out; };

interface Parts {
  pre?: number[];         // legacy / mandatory prefixes (66, F2, F3)
  w?: boolean;
  op: number[];
  reg?: number;           // ModRM.reg (register number or opcode extension)
  rm?: XReg | Mem;        // ModRM.rm operand
  opreg?: XReg;           // register encoded in the low 3 opcode bits (push r, mov r, imm, bswap)
  imm?: { v: Value; size: 1 | 2 | 4 | 8 };
  byteRegs?: XReg[];      // 8-bit registers involved (for REX rules)
  forceRex?: boolean;
}

class XEnc {
  mn: string;
  ops: XOperand[];
  line: number;
  constructor(mn: string, ops: XOperand[], line: number) { this.mn = mn; this.ops = ops; this.line = line; }
  err(m: string): never { throw new AsmError(`${this.mn}: ${m}`, this.line); }
  count(...n: number[]) { if (!n.includes(this.ops.length)) this.err(`expected ${n.join(' or ')} operands`); }
  isReg(i: number): boolean { const o = this.ops[i]; return !!o && o.k === 'reg'; }
  isMem(i: number): boolean { return this.ops[i]?.k === 'mem'; }
  isImm(i: number): boolean { return this.ops[i]?.k === 'imm'; }
  reg(i: number): XReg { const o = this.ops[i]; if (!o || o.k !== 'reg') this.err(`operand ${i + 1} must be a register`); return o; }
  gpr(i: number): XReg { const r = this.reg(i); if (r.xmm) this.err(`operand ${i + 1} must be a general register`); return r; }
  xmm(i: number): XReg { const r = this.reg(i); if (!r.xmm) this.err(`operand ${i + 1} must be an xmm register`); return r; }
  mem(i: number): Mem { const o = this.ops[i]; if (!o || o.k !== 'mem') this.err(`operand ${i + 1} must be memory`); return o; }
  rm(i: number): XReg | Mem { const o = this.ops[i]; if (!o || o.k === 'imm') this.err(`operand ${i + 1} must be a register or memory`); return o; }
  imm(i: number): Value { const o = this.ops[i]; if (!o || o.k !== 'imm') this.err(`operand ${i + 1} must be an immediate`); return o.v; }
  num(i: number): bigint { const v = this.imm(i); if (v.sym) this.err('unexpected symbol'); return v.add; }

  /** operand size of an r/m operand (register size or `ptr` size). */
  sizeOf(o: XReg | Mem, other?: XReg | Mem | null): number {
    if (o.k === 'reg') return o.size;
    if (o.size) return o.size;
    if (other && other.k === 'reg') return other.size;
    return this.err('operand size is unknown: add byte/word/dword/qword ptr');
  }

  emit(p: Parts): XEncoded {
    const bytes: number[] = [];
    const fixups: XFixup[] = [];
    bytes.push(...(p.pre ?? []));
    let rexW = p.w ? 1 : 0, rexR = 0, rexX = 0, rexB = 0;
    let modrm: number | null = null, sib: number | null = null;
    let disp: number[] = [];
    let dispFix: { sym: string; add: bigint } | null = null;
    if (p.reg !== undefined) rexR = (p.reg >> 3) & 1;
    if (p.rm) {
      const reg3 = (p.reg ?? 0) & 7;
      if (p.rm.k === 'reg') {
        rexB = (p.rm.n >> 3) & 1;
        modrm = 0xc0 | (reg3 << 3) | (p.rm.n & 7);
      } else {
        const m = p.rm;
        if (m.base === 'rip') {
          modrm = (reg3 << 3) | 5;
          disp = [0, 0, 0, 0];
          if (!m.disp.sym) this.err('rip-relative operand needs a symbol');
          dispFix = { sym: m.disp.sym, add: m.disp.add };
        } else {
          if (m.disp.sym) this.err(`absolute address of '${m.disp.sym}': use [rip + ${m.disp.sym}]`);
          const d = m.disp.add;
          const base = m.base;
          if (!base) {
            // [index*scale + disp32] (or absolute disp32): SIB with no base
            if (m.index) rexX = (m.index.n >> 3) & 1;
            modrm = (reg3 << 3) | 4;
            sib = ((Math.log2(m.scale)) << 6) | ((m.index ? m.index.n & 7 : 4) << 3) | 5;
            disp = le(d, 4);
          } else {
            rexB = (base.n >> 3) & 1;
            const needSib = !!m.index || (base.n & 7) === 4;
            let mod: number;
            if (d === 0n && (base.n & 7) !== 5) mod = 0;
            else if (fitsI8(d)) { mod = 1; disp = le(d, 1); }
            else if (fitsI32(d)) { mod = 2; disp = le(d, 4); }
            else return this.err('displacement out of 32-bit range');
            if (needSib) {
              if (m.index) rexX = (m.index.n >> 3) & 1;
              modrm = (mod << 6) | (reg3 << 3) | 4;
              sib = ((Math.log2(m.scale)) << 6) | ((m.index ? m.index.n & 7 : 4) << 3) | (base.n & 7);
            } else modrm = (mod << 6) | (reg3 << 3) | (base.n & 7);
          }
        }
      }
    }
    if (p.opreg) rexB = (p.opreg.n >> 3) & 1;
    const byteRegs = p.byteRegs ?? [];
    const needRex = rexW || rexR || rexX || rexB || p.forceRex || byteRegs.some((r) => r.rex8);
    if (needRex && byteRegs.some((r) => r.high8)) this.err('ah/bh/ch/dh cannot be used with registers that need a REX prefix');
    if (needRex) bytes.push(0x40 | (rexW << 3) | (rexR << 2) | (rexX << 1) | rexB);
    const op = [...p.op];
    if (p.opreg) op[op.length - 1] |= p.opreg.n & 7;
    bytes.push(...op);
    if (modrm !== null) bytes.push(modrm);
    if (sib !== null) bytes.push(sib);
    const dispOff = bytes.length;
    bytes.push(...disp);
    if (p.imm) {
      const immOff = bytes.length;
      if (p.imm.v.sym) {
        if (p.imm.size !== 8 && p.imm.size !== 4) this.err('symbolic immediates need 32 or 64 bits');
        fixups.push({ off: immOff, size: p.imm.size, kind: 'abs', sym: p.imm.v.sym, add: p.imm.v.add });
        bytes.push(...new Array(p.imm.size).fill(0));
      } else bytes.push(...le(p.imm.v.add, p.imm.size));
    }
    if (dispFix) fixups.push({ off: dispOff, size: 4, kind: 'rel', sym: dispFix.sym, add: dispFix.add });
    return { bytes, fixups };
  }
}

const ALU: Record<string, number> = { add: 0, or: 1, adc: 2, sbb: 3, and: 4, sub: 5, xor: 6, cmp: 7 };
const SHIFT: Record<string, number> = { rol: 0, ror: 1, rcl: 2, rcr: 3, shl: 4, sal: 4, shr: 5, sar: 7 };
const UNARY: Record<string, [number, number]> = { not: [0xf6, 2], neg: [0xf6, 3], mul: [0xf6, 4], div: [0xf6, 6], idiv: [0xf6, 7], inc: [0xfe, 0], dec: [0xfe, 1] };

// SSE: mnemonic -> [mandatory prefix, opcode, W for gpr operand]
const SSE_ARITH: Record<string, [number | null, number]> = {
  addsd: [0xf2, 0x58], mulsd: [0xf2, 0x59], subsd: [0xf2, 0x5c], divsd: [0xf2, 0x5e], minsd: [0xf2, 0x5d], maxsd: [0xf2, 0x5f], sqrtsd: [0xf2, 0x51],
  addss: [0xf3, 0x58], mulss: [0xf3, 0x59], subss: [0xf3, 0x5c], divss: [0xf3, 0x5e], minss: [0xf3, 0x5d], maxss: [0xf3, 0x5f], sqrtss: [0xf3, 0x51],
  ucomisd: [0x66, 0x2e], comisd: [0x66, 0x2f], ucomiss: [null, 0x2e], comiss: [null, 0x2f],
  xorps: [null, 0x57], xorpd: [0x66, 0x57], andps: [null, 0x54], andpd: [0x66, 0x54], andnpd: [0x66, 0x55], orpd: [0x66, 0x56],
  cvtss2sd: [0xf3, 0x5a], cvtsd2ss: [0xf2, 0x5a], pxor: [0x66, 0xef], unpcklpd: [0x66, 0x14],
};

/** Encode one instruction. `mn` is lower case; `ops` already parsed. */
export function encodeX(mn: string, ops: XOperand[], line: number): XEncoded {
  const e: XEnc = new XEnc(mn, ops, line);
  const sizeW = (s: number) => ({ pre: s === 2 ? [0x66] : [], w: s === 8 });

  // ---------------------------------------------------------------- jumps and calls
  if (mn === 'jmp' || (mn[0] === 'j' && XCOND[mn.slice(1)] !== undefined)) {
    e.count(1);
    const cond = mn === 'jmp' ? null : XCOND[mn.slice(1)];
    const o = ops[0];
    if (o.k === 'imm') return { bytes: [], fixups: [], jump: { cond, target: o.v } };
    if (cond !== null) e.err('conditional jumps need a label');
    return e.emit({ op: [0xff], reg: 4, rm: e.rm(0) });
  }
  if (mn === 'call') {
    e.count(1);
    const o = ops[0];
    if (o.k === 'imm') {
      if (!o.v.sym) e.err('call needs a symbol');
      return { bytes: [0xe8, 0, 0, 0, 0], fixups: [{ off: 1, size: 4, kind: 'rel', sym: o.v.sym, add: o.v.add }] };
    }
    return e.emit({ op: [0xff], reg: 2, rm: e.rm(0) });
  }

  // ---------------------------------------------------------------- ALU group
  if (ALU[mn] !== undefined) {
    e.count(2);
    const x = ALU[mn];
    const dst = e.rm(0);
    if (e.isImm(1)) {
      const s = e.sizeOf(dst);
      const v = e.num(1);
      const isAcc = dst.k === 'reg' && dst.n === 0;
      if (s === 1) {
        if (isAcc) return e.emit({ op: [0x04 + 8 * x], imm: { v: { sym: null, add: v, reloc: null }, size: 1 } });
        return e.emit({ op: [0x80], reg: x, rm: dst, imm: { v: { sym: null, add: v, reloc: null }, size: 1 }, byteRegs: dst.k === 'reg' ? [dst] : [] });
      }
      if (fitsI8(v)) return e.emit({ ...sizeW(s), op: [0x83], reg: x, rm: dst, imm: { v: { sym: null, add: v, reloc: null }, size: 1 } });
      const isz = s === 2 ? 2 : 4;
      if (s === 8 && !fitsI32(v)) e.err(`immediate ${v} does not fit in 32 bits (load it into a register first)`);
      if (isAcc) return e.emit({ ...sizeW(s), op: [0x05 + 8 * x], imm: { v: { sym: null, add: v, reloc: null }, size: isz } });
      return e.emit({ ...sizeW(s), op: [0x81], reg: x, rm: dst, imm: { v: { sym: null, add: v, reloc: null }, size: isz } });
    }
    if (e.isReg(1)) {
      const src = e.gpr(1);
      const s = src.size;
      if (dst.k === 'reg' && dst.size !== s) e.err('operand sizes differ');
      return e.emit({ ...sizeW(s), op: [s === 1 ? 0x00 + 8 * x : 0x01 + 8 * x], reg: src.n, rm: dst, byteRegs: s === 1 ? [src, ...(dst.k === 'reg' ? [dst] : [])] : [] });
    }
    const r = e.gpr(0);
    const m = e.mem(1);
    return e.emit({ ...sizeW(r.size), op: [r.size === 1 ? 0x02 + 8 * x : 0x03 + 8 * x], reg: r.n, rm: m, byteRegs: r.size === 1 ? [r] : [] });
  }

  switch (mn) {
    // ---------------------------------------------------------------- moves
    case 'mov': {
      e.count(2);
      const dst = e.rm(0);
      if (dst.k === 'reg' && dst.xmm) e.err('use movsd/movq/movaps for xmm registers');
      if (e.isImm(1)) {
        const s = e.sizeOf(dst);
        const v = e.imm(1);
        if (v.sym) e.err('absolute addresses are not position independent: use lea reg, [rip + sym]');
        const n = v.add;
        if (dst.k === 'reg') {
          if (s === 8) {
            if (fitsI32(n)) return e.emit({ w: true, op: [0xc7], reg: 0, rm: dst, imm: { v, size: 4 } });
            return e.emit({ w: true, op: [0xb8], opreg: dst, imm: { v, size: 8 } });
          }
          if (s === 1) return e.emit({ op: [0xb0], opreg: dst, imm: { v, size: 1 }, byteRegs: [dst] });
          return e.emit({ pre: s === 2 ? [0x66] : [], op: [0xb8], opreg: dst, imm: { v, size: s as 2 | 4 } });
        }
        if (s === 8 && !fitsI32(n)) e.err('immediate does not fit in 32 bits');
        if (s === 1) return e.emit({ op: [0xc6], reg: 0, rm: dst, imm: { v, size: 1 } });
        return e.emit({ ...sizeW(s), op: [0xc7], reg: 0, rm: dst, imm: { v, size: s === 2 ? 2 : 4 } });
      }
      if (e.isReg(1)) {
        const src = e.gpr(1);
        if (dst.k === 'reg' && dst.size !== src.size) e.err('operand sizes differ (use movzx/movsx/movsxd)');
        const s = src.size;
        return e.emit({ ...sizeW(s), op: [s === 1 ? 0x88 : 0x89], reg: src.n, rm: dst, byteRegs: s === 1 ? [src, ...(dst.k === 'reg' ? [dst] : [])] : [] });
      }
      const r = e.gpr(0);
      return e.emit({ ...sizeW(r.size), op: [r.size === 1 ? 0x8a : 0x8b], reg: r.n, rm: e.mem(1), byteRegs: r.size === 1 ? [r] : [] });
    }
    case 'movabs': {
      e.count(2);
      const r = e.gpr(0);
      if (r.size !== 8) e.err('movabs needs a 64-bit register');
      return e.emit({ w: true, op: [0xb8], opreg: r, imm: { v: e.imm(1), size: 8 } });
    }
    case 'movzx': case 'movsx': {
      e.count(2);
      const r = e.gpr(0);
      const src = e.rm(1);
      const ss = e.sizeOf(src);
      if (ss !== 1 && ss !== 2) e.err('source must be 8 or 16 bits');
      const op = mn === 'movzx' ? (ss === 1 ? 0xb6 : 0xb7) : (ss === 1 ? 0xbe : 0xbf);
      return e.emit({ ...sizeW(r.size), op: [0x0f, op], reg: r.n, rm: src, byteRegs: src.k === 'reg' && ss === 1 ? [src] : [] });
    }
    case 'movsxd': {
      e.count(2);
      const r = e.gpr(0);
      return e.emit({ w: r.size === 8, op: [0x63], reg: r.n, rm: e.rm(1) });
    }
    case 'lea': {
      e.count(2);
      const r = e.gpr(0);
      return e.emit({ ...sizeW(r.size), op: [0x8d], reg: r.n, rm: e.mem(1) });
    }
    case 'xchg': {
      e.count(2);
      // xchg is symmetric: put the memory operand (if any) into r/m
      const [ai, bi] = e.isMem(1) ? [1, 0] : [0, 1];
      const a = e.rm(ai), b = e.gpr(bi);
      // short form with the accumulator: xchg rax, r  ->  90+r
      if (a.k === 'reg' && b.size > 1 && (a.n === 0 || b.n === 0) && a.size === b.size) {
        return e.emit({ ...sizeW(b.size), op: [0x90], opreg: a.n === 0 ? b : a });
      }
      return e.emit({ ...sizeW(b.size), op: [b.size === 1 ? 0x86 : 0x87], reg: b.n, rm: a });
    }
    case 'test': {
      e.count(2);
      const dst = e.rm(0);
      if (e.isImm(1)) {
        const s = e.sizeOf(dst);
        const v = e.imm(1);
        const acc = dst.k === 'reg' && dst.n === 0;
        if (s === 1) return acc ? e.emit({ op: [0xa8], imm: { v, size: 1 } }) : e.emit({ op: [0xf6], reg: 0, rm: dst, imm: { v, size: 1 }, byteRegs: dst.k === 'reg' ? [dst] : [] });
        const isz = s === 2 ? 2 : 4;
        return acc ? e.emit({ ...sizeW(s), op: [0xa9], imm: { v, size: isz } }) : e.emit({ ...sizeW(s), op: [0xf7], reg: 0, rm: dst, imm: { v, size: isz } });
      }
      const src = e.gpr(1);
      return e.emit({ ...sizeW(src.size), op: [src.size === 1 ? 0x84 : 0x85], reg: src.n, rm: dst, byteRegs: src.size === 1 ? [src, ...(dst.k === 'reg' ? [dst] : [])] : [] });
    }

    // ---------------------------------------------------------------- unary / multiply / divide
    case 'not': case 'neg': case 'mul': case 'div': case 'idiv': case 'inc': case 'dec': {
      e.count(1);
      const o = e.rm(0);
      const s = e.sizeOf(o);
      const [op, x] = UNARY[mn];
      return e.emit({ ...sizeW(s), op: [s === 1 ? op : op + 1], reg: x, rm: o, byteRegs: s === 1 && o.k === 'reg' ? [o] : [] });
    }
    case 'imul': {
      e.count(1, 2, 3);
      if (ops.length === 1) {
        const o = e.rm(0);
        const s = e.sizeOf(o);
        return e.emit({ ...sizeW(s), op: [s === 1 ? 0xf6 : 0xf7], reg: 5, rm: o });
      }
      const r = e.gpr(0);
      if (ops.length === 2 && !e.isImm(1)) return e.emit({ ...sizeW(r.size), op: [0x0f, 0xaf], reg: r.n, rm: e.rm(1) });
      const src = ops.length === 3 ? e.rm(1) : r;
      const v = e.num(ops.length === 3 ? 2 : 1);
      if (fitsI8(v)) return e.emit({ ...sizeW(r.size), op: [0x6b], reg: r.n, rm: src, imm: { v: { sym: null, add: v, reloc: null }, size: 1 } });
      return e.emit({ ...sizeW(r.size), op: [0x69], reg: r.n, rm: src, imm: { v: { sym: null, add: v, reloc: null }, size: r.size === 2 ? 2 : 4 } });
    }
    case 'cqo': return { bytes: [0x48, 0x99], fixups: [] };
    case 'cdq': return { bytes: [0x99], fixups: [] };
    case 'cdqe': return { bytes: [0x48, 0x98], fixups: [] };
    case 'cwde': return { bytes: [0x98], fixups: [] };

    // ---------------------------------------------------------------- shifts and bits
    case 'shl': case 'sal': case 'shr': case 'sar': case 'rol': case 'ror': case 'rcl': case 'rcr': {
      e.count(1, 2);
      const o = e.rm(0);
      const s = e.sizeOf(o);
      const x = SHIFT[mn];
      const b8 = s === 1;
      const br = b8 && o.k === 'reg' ? [o] : [];
      if (ops.length === 1) return e.emit({ ...sizeW(s), op: [b8 ? 0xd0 : 0xd1], reg: x, rm: o, byteRegs: br });
      if (e.isReg(1)) {
        const c = e.gpr(1);
        if (c.name !== 'cl') e.err('the shift count register must be cl');
        return e.emit({ ...sizeW(s), op: [b8 ? 0xd2 : 0xd3], reg: x, rm: o, byteRegs: br });
      }
      const v = e.num(1);
      if (v === 1n) return e.emit({ ...sizeW(s), op: [b8 ? 0xd0 : 0xd1], reg: x, rm: o, byteRegs: br });
      return e.emit({ ...sizeW(s), op: [b8 ? 0xc0 : 0xc1], reg: x, rm: o, imm: { v: { sym: null, add: v & 0xffn, reloc: null }, size: 1 }, byteRegs: br });
    }
    case 'bt': case 'bts': case 'btr': case 'btc': {
      e.count(2);
      const o = e.rm(0);
      const ext = { bt: 4, bts: 5, btr: 6, btc: 7 }[mn];
      if (e.isImm(1)) return e.emit({ ...sizeW(e.sizeOf(o)), op: [0x0f, 0xba], reg: ext, rm: o, imm: { v: e.imm(1), size: 1 } });
      const r = e.gpr(1);
      return e.emit({ ...sizeW(r.size), op: [0x0f, { bt: 0xa3, bts: 0xab, btr: 0xb3, btc: 0xbb }[mn]], reg: r.n, rm: o });
    }
    case 'bswap': {
      e.count(1);
      const r = e.gpr(0);
      return e.emit({ w: r.size === 8, op: [0x0f, 0xc8], opreg: r });
    }
    case 'bsf': case 'bsr': case 'lzcnt': case 'tzcnt': case 'popcnt': {
      e.count(2);
      const r = e.gpr(0);
      const op = { bsf: 0xbc, bsr: 0xbd, lzcnt: 0xbd, tzcnt: 0xbc, popcnt: 0xb8 }[mn];
      const pre = mn === 'bsf' || mn === 'bsr' ? [] : [0xf3];
      return e.emit({ pre: [...(r.size === 2 ? [0x66] : []), ...pre], w: r.size === 8, op: [0x0f, op], reg: r.n, rm: e.rm(1) });
    }

    // ---------------------------------------------------------------- stack and control
    case 'push': case 'pop': {
      e.count(1);
      if (mn === 'push' && e.isImm(0)) {
        const v = e.num(0);
        if (fitsI8(v)) return e.emit({ op: [0x6a], imm: { v: { sym: null, add: v, reloc: null }, size: 1 } });
        return e.emit({ op: [0x68], imm: { v: { sym: null, add: v, reloc: null }, size: 4 } });
      }
      if (e.isReg(0)) {
        const r = e.gpr(0);
        if (r.size !== 8) e.err('push/pop need a 64-bit register');
        return e.emit({ op: [mn === 'push' ? 0x50 : 0x58], opreg: r });
      }
      return e.emit({ op: [mn === 'push' ? 0xff : 0x8f], reg: mn === 'push' ? 6 : 0, rm: e.mem(0) });
    }
    case 'ret':
      e.count(0, 1);
      if (ops.length) return e.emit({ op: [0xc2], imm: { v: e.imm(0), size: 2 } });
      return { bytes: [0xc3], fixups: [] };
    case 'nop': e.count(0); return { bytes: [0x90], fixups: [] };
    case 'int3': return { bytes: [0xcc], fixups: [] };
    case 'ud2': return { bytes: [0x0f, 0x0b], fixups: [] };
    case 'hlt': return { bytes: [0xf4], fixups: [] };
    case 'pause': return { bytes: [0xf3, 0x90], fixups: [] };
    case 'mfence': return { bytes: [0x0f, 0xae, 0xf0], fixups: [] };
    case 'cpuid': return { bytes: [0x0f, 0xa2], fixups: [] };
    case 'rdtsc': return { bytes: [0x0f, 0x31], fixups: [] };
    case 'leave': return { bytes: [0xc9], fixups: [] };

    // ---------------------------------------------------------------- SSE moves and conversions
    case 'movsd': case 'movss': {
      e.count(2);
      const pre = [mn === 'movsd' ? 0xf2 : 0xf3];
      if (e.isMem(0)) return e.emit({ pre, op: [0x0f, 0x11], reg: e.xmm(1).n, rm: e.mem(0) });
      return e.emit({ pre, op: [0x0f, 0x10], reg: e.xmm(0).n, rm: e.rm(1) });
    }
    case 'movaps': case 'movapd': case 'movups': case 'movupd': {
      e.count(2);
      const pre = mn.endsWith('pd') ? [0x66] : [];
      const ld = mn.startsWith('movu') ? 0x10 : 0x28;
      if (e.isMem(0)) return e.emit({ pre, op: [0x0f, ld + 1], reg: e.xmm(1).n, rm: e.mem(0) });
      return e.emit({ pre, op: [0x0f, ld], reg: e.xmm(0).n, rm: e.rm(1) });
    }
    case 'movq': case 'movd': {
      e.count(2);
      const a = ops[0], b = ops[1];
      const w = mn === 'movq';
      if (a.k === 'reg' && a.xmm && b.k === 'reg' && !b.xmm) return e.emit({ pre: [0x66], w, op: [0x0f, 0x6e], reg: a.n, rm: b });
      if (a.k === 'reg' && !a.xmm && b.k === 'reg' && b.xmm) return e.emit({ pre: [0x66], w, op: [0x0f, 0x7e], reg: b.n, rm: a });
      if (mn === 'movq' && a.k === 'reg' && a.xmm) return e.emit({ pre: [0xf3], op: [0x0f, 0x7e], reg: a.n, rm: e.rm(1) });
      if (mn === 'movq' && a.k === 'mem') return e.emit({ pre: [0x66], op: [0x0f, 0xd6], reg: e.xmm(1).n, rm: a });
      if (mn === 'movd' && a.k === 'reg' && a.xmm) return e.emit({ pre: [0x66], op: [0x0f, 0x6e], reg: a.n, rm: e.rm(1) });
      if (mn === 'movd' && a.k === 'mem') return e.emit({ pre: [0x66], op: [0x0f, 0x7e], reg: e.xmm(1).n, rm: a });
      return e.err('unsupported operand combination');
    }
    case 'cvtsi2sd': case 'cvtsi2ss': {
      e.count(2);
      const x = e.xmm(0);
      const src = e.rm(1);
      const s = src.k === 'reg' ? src.size : src.size || 4;
      return e.emit({ pre: [mn === 'cvtsi2sd' ? 0xf2 : 0xf3], w: s === 8, op: [0x0f, 0x2a], reg: x.n, rm: src });
    }
    case 'cvttsd2si': case 'cvtsd2si': case 'cvttss2si': case 'cvtss2si': {
      e.count(2);
      const r = e.gpr(0);
      const pre = [mn.includes('sd') ? 0xf2 : 0xf3];
      return e.emit({ pre, w: r.size === 8, op: [0x0f, mn.startsWith('cvtt') ? 0x2c : 0x2d], reg: r.n, rm: e.rm(1) });
    }
  }

  // ---------------------------------------------------------------- SSE arithmetic
  if (SSE_ARITH[mn]) {
    e.count(2);
    const [p, op] = SSE_ARITH[mn];
    return e.emit({ pre: p === null ? [] : [p], op: [0x0f, op], reg: e.xmm(0).n, rm: e.rm(1) });
  }

  // ---------------------------------------------------------------- setcc / cmovcc
  if (mn.startsWith('set') && XCOND[mn.slice(3)] !== undefined) {
    e.count(1);
    const o = e.rm(0);
    if (o.k === 'reg' && o.size !== 1) e.err('setcc needs an 8-bit register');
    return e.emit({ op: [0x0f, 0x90 + XCOND[mn.slice(3)]], reg: 0, rm: o, byteRegs: o.k === 'reg' ? [o] : [] });
  }
  if (mn.startsWith('cmov') && XCOND[mn.slice(4)] !== undefined) {
    e.count(2);
    const r = e.gpr(0);
    return e.emit({ ...sizeW(r.size), op: [0x0f, 0x40 + XCOND[mn.slice(4)]], reg: r.n, rm: e.rm(1) });
  }
  return e.err('unknown or unsupported instruction');
}

/** Parse the operand list of an instruction. */
export function parseXOperands(text: string, line: number): XOperand[] {
  return text ? splitOperands(text).map((o) => parseXOperand(o, line)) : [];
}

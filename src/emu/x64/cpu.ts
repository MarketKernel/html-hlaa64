// x86-64 interpreter for the instruction subset the HLA64 Windows toolchain produces
// (plus common hand-written code). Registers are BigInts; decoded instructions are
// cached as closures keyed by their address.
import { EmuError, Memory, M64, M32, bitsToF64, f64ToBits, bitsToF32, f32ToBits } from '../cpu.ts';

export { EmuError, ExitSignal, Memory } from '../cpu.ts';

const MASK: Record<number, bigint> = { 1: 0xffn, 2: 0xffffn, 4: M32, 8: M64 };
const sx = (v: bigint, size: number) => BigInt.asIntN(size * 8, v);

type Exec = (c: X64) => void;
/** decoded r/m operand: a register number or an address computation */
// mem: effective address of a memory access; ea: the full 64-bit value (lea)
type E = { reg: number } | { mem: (c: X64) => number; ea: (c: X64) => bigint };

export class X64 {
  r: bigint[] = new Array(16).fill(0n);
  rip = 0;
  cf = false; zf = false; sf = false; of = false; pf = false;
  xlo = new BigUint64Array(16);
  xhi = new BigUint64Array(16);
  mem: Memory;
  cache = new Map<number, Exec>();
  steps = 0;
  limit = 200_000_000;
  thunks = new Map<number, (c: X64) => void>();

  constructor(mem: Memory) { this.mem = mem; }

  // ---------------------------------------------------------------- registers
  get(n: number, size: number, rex: boolean): bigint {
    if (size === 1 && !rex && n >= 4 && n < 8) return (this.r[n - 4] >> 8n) & 0xffn;
    return this.r[n] & MASK[size];
  }
  set(n: number, size: number, v: bigint, rex: boolean): void {
    switch (size) {
      case 8: this.r[n] = v & M64; break;
      case 4: this.r[n] = v & M32; break;          // 32-bit writes zero the upper half
      case 2: this.r[n] = (this.r[n] & ~0xffffn) | (v & 0xffffn); break;
      default:
        if (!rex && n >= 4 && n < 8) this.r[n - 4] = (this.r[n - 4] & ~0xff00n) | ((v & 0xffn) << 8n);
        else this.r[n] = (this.r[n] & ~0xffn) | (v & 0xffn);
    }
  }
  get rsp(): bigint { return this.r[4]; }
  set rsp(v: bigint) { this.r[4] = v & M64; }

  push(v: bigint): void { this.rsp = this.rsp - 8n; this.mem.set64(Number(this.rsp), v); }
  pop(): bigint { const v = this.mem.u64(Number(this.rsp)); this.rsp = this.rsp + 8n; return v; }

  d(n: number): number { return bitsToF64(this.xlo[n]); }
  setd(n: number, v: number): void { this.xlo[n] = f64ToBits(v); }          // upper half preserved (movsd semantics)
  s(n: number): number { return bitsToF32(Number(this.xlo[n] & M32)); }
  sets(n: number, v: number): void { this.xlo[n] = (this.xlo[n] & ~M32) | BigInt(f32ToBits(v)); }

  // ---------------------------------------------------------------- flags
  parity(v: bigint): boolean { let b = Number(v & 0xffn), p = 0; while (b) { p ^= b & 1; b >>= 1; } return p === 0; }
  logic(res: bigint, size: number): bigint {
    const m = res & MASK[size];
    this.cf = false; this.of = false;
    this.zf = m === 0n; this.sf = (m >> BigInt(size * 8 - 1)) === 1n; this.pf = this.parity(m);
    return m;
  }
  add(a: bigint, b: bigint, carry: bigint, size: number): bigint {
    const m = MASK[size];
    const ua = a & m, ub = b & m;
    const full = ua + ub + carry;
    const res = full & m;
    this.cf = full > m;
    this.of = sx(ua, size) + sx(ub, size) + carry !== sx(res, size);
    this.zf = res === 0n; this.sf = (res >> BigInt(size * 8 - 1)) === 1n; this.pf = this.parity(res);
    return res;
  }
  sub(a: bigint, b: bigint, borrow: bigint, size: number): bigint {
    const m = MASK[size];
    const ua = a & m, ub = b & m;
    const res = (ua - ub - borrow) & m;
    this.cf = ua < ub + borrow;
    this.of = sx(ua, size) - sx(ub, size) - borrow !== sx(res, size);
    this.zf = res === 0n; this.sf = (res >> BigInt(size * 8 - 1)) === 1n; this.pf = this.parity(res);
    return res;
  }
  cond(cc: number): boolean {
    let r: boolean;
    switch (cc >> 1) {
      case 0: r = this.of; break;
      case 1: r = this.cf; break;
      case 2: r = this.zf; break;
      case 3: r = this.cf || this.zf; break;
      case 4: r = this.sf; break;
      case 5: r = this.pf; break;
      case 6: r = this.sf !== this.of; break;
      default: r = this.zf || this.sf !== this.of;
    }
    return cc & 1 ? !r : r;
  }

  // ---------------------------------------------------------------- run loop
  run(stop: number | null = null): void {
    while (this.rip !== stop) {
      if (++this.steps > this.limit) throw new EmuError(`instruction limit (${this.limit}) exceeded — infinite loop?`, this.rip);
      const pc = this.rip;
      let f = this.cache.get(pc);
      if (!f) {
        const th = this.thunks.get(pc);
        if (th) f = (c) => { th(c); c.rip = Number(c.pop()); };
        else {
          try { f = decode(this.mem, pc); } catch (e) {
            if (e instanceof EmuError) throw e;
            throw new EmuError('jump to unmapped memory', pc);
          }
        }
        this.cache.set(pc, f);
      }
      f(this);
    }
  }

  /** Call guest code from a host function (Win64 convention, re-entrant). */
  call(addr: number, args: bigint[], ret: number): bigint {
    const savedRip = this.rip, savedRsp = this.rsp;
    const regs = [1, 2, 8, 9];
    args.forEach((a, i) => (this.r[regs[i]] = a & M64));
    let sp = ((this.rsp - 128n) & ~15n) - 32n;   // aligned + shadow space
    sp -= 8n;
    this.rsp = sp;
    this.mem.set64(Number(sp), BigInt(ret));
    this.rip = addr;
    this.run(ret);
    this.rip = savedRip;
    this.rsp = savedRsp;
    return this.r[0];
  }
}

// ---------------------------------------------------------------------------
// decoder
// ---------------------------------------------------------------------------
function decode(m: Memory, pc: number): Exec {
  let p = pc;
  const u8 = () => m.u8(p++);
  let opsize = false, rep: 0 | 0xf2 | 0xf3 = 0;
  // legacy prefixes
  for (;;) {
    const b = m.u8(p);
    if (b === 0x66) { opsize = true; p++; }
    else if (b === 0xf2 || b === 0xf3) { rep = b; p++; }
    else if (b === 0x2e || b === 0x3e || b === 0x26 || b === 0x36 || b === 0x64 || b === 0x65 || b === 0xf0) p++;
    else break;
  }
  let rex = 0;
  if ((m.u8(p) & 0xf0) === 0x40) rex = u8();
  const W = (rex & 8) !== 0, R = (rex & 4) ? 8 : 0, X = (rex & 2) ? 8 : 0, B = (rex & 1) ? 8 : 0;
  const hasRex = rex !== 0;
  const osz = W ? 8 : opsize ? 2 : 4;
  let end = 0;   // address of the next instruction (set once the whole instruction is decoded)

  const modrm = () => {
    const b = u8();
    const mod = b >> 6, reg = ((b >> 3) & 7) | R, rm = b & 7;
    if (mod === 3) return { reg, e: { reg: rm | B } as E };
    let base = -1, index = -1, scale = 1, disp = 0;
    let ripRel = false;
    if (rm === 4) {
      const s = u8();
      scale = 1 << (s >> 6);
      const idx = ((s >> 3) & 7) | X;
      if (idx !== 4) index = idx;
      const bs = s & 7;
      if (bs === 5 && mod === 0) { disp = m.u32(p) | 0; p += 4; }
      else base = bs | B;
    } else if (rm === 5 && mod === 0) {
      ripRel = true;
      disp = m.u32(p) | 0; p += 4;
    } else base = rm | B;
    if (mod === 1) { disp = (m.u8(p) << 24) >> 24; p++; }
    else if (mod === 2) { disp = m.u32(p) | 0; p += 4; }
    const ea = ripRel
      ? () => BigInt(end + disp)
      : (c: X64) => ((base >= 0 ? c.r[base] : 0n) + (index >= 0 ? c.r[index] * BigInt(scale) : 0n) + BigInt(disp)) & M64;
    const e: E = ripRel ? { mem: () => end + disp, ea } : { mem: (c) => Number(ea(c)), ea };
    return { reg, e };
  };
  const imm = (size: number): bigint => {
    let v: bigint;
    if (size === 1) v = BigInt((m.u8(p) << 24) >> 24);
    else if (size === 2) v = BigInt((m.u16(p) << 16) >> 16);
    else if (size === 4) v = BigInt(m.u32(p) | 0);
    else v = BigInt.asIntN(64, m.u64(p));
    p += size;
    return v;
  };
  const rd = (c: X64, e: E, size: number): bigint => ('reg' in e ? c.get(e.reg, size, hasRex) : c.mem.read(e.mem(c), size));
  const wr = (c: X64, e: E, size: number, v: bigint) => { if ('reg' in e) c.set(e.reg, size, v, hasRex); else c.mem.write(e.mem(c), size, v); };
  const fin = (f: Exec): Exec => { end = p; const next = p; return (c) => { f(c); if (c.rip === pc) c.rip = next; }; };
  const fjump = (f: (c: X64) => number | null): Exec => { end = p; const next = p; return (c) => { const t = f(c); c.rip = t === null ? next : t; }; };
  const undef = (what: string): never => { throw new EmuError(`unsupported instruction (${what})`, pc); };

  const alu = (op: number, c: X64, a: bigint, b: bigint, size: number): bigint | null => {
    switch (op) {
      case 0: return c.add(a, b, 0n, size);
      case 1: return c.logic(a | b, size);
      case 2: return c.add(a, b, c.cf ? 1n : 0n, size);
      case 3: return c.sub(a, b, c.cf ? 1n : 0n, size);
      case 4: return c.logic(a & b, size);
      case 5: return c.sub(a, b, 0n, size);
      case 6: return c.logic(a ^ b, size);
      default: c.sub(a, b, 0n, size); return null;   // cmp
    }
  };
  const shift = (c: X64, op: number, v: bigint, cnt: number, size: number): bigint => {
    const bits = size * 8;
    const mask = MASK[size];
    cnt &= size === 8 ? 63 : 31;
    if (cnt === 0) return v & mask;
    v &= mask;
    const n = BigInt(cnt);
    let res: bigint;
    switch (op) {
      case 0: res = ((v << n) | (v >> BigInt(bits - (cnt % bits)))) & mask; c.cf = (res & 1n) === 1n; return res;
      case 1: res = ((v >> n) | (v << BigInt(bits - (cnt % bits)))) & mask; c.cf = (res >> BigInt(bits - 1)) === 1n; return res;
      case 4: case 6: res = (v << n) & mask; c.cf = ((v >> BigInt(bits - cnt)) & 1n) === 1n; break;
      case 5: res = v >> n; c.cf = ((v >> (n - 1n)) & 1n) === 1n; break;
      case 7: res = BigInt.asUintN(bits, sx(v, size) >> n); c.cf = ((sx(v, size) >> (n - 1n)) & 1n) !== 0n; break;
      default: return undef(`shift op ${op}`);
    }
    c.zf = res === 0n; c.sf = (res >> BigInt(bits - 1)) === 1n; c.pf = c.parity(res); c.of = false;
    return res;
  };

  const op = u8();
  // ---------------------------------------------------------------- one-byte opcodes
  if (op < 0x40 && (op & 7) < 6) {
    const o = op >> 3, form = op & 7;
    if (form === 4) { const v = imm(1); return fin((c) => { const r = alu(o, c, c.get(0, 1, hasRex), v, 1); if (r !== null) c.set(0, 1, r, hasRex); }); }
    if (form === 5) { const v = imm(osz === 2 ? 2 : 4); return fin((c) => { const r = alu(o, c, c.get(0, osz, hasRex), v, osz); if (r !== null) c.set(0, osz, r, hasRex); }); }
    const { reg, e } = modrm();
    const size = form & 1 ? osz : 1;
    if (form < 2) return fin((c) => { const r = alu(o, c, rd(c, e, size), c.get(reg, size, hasRex), size); if (r !== null) wr(c, e, size, r); });
    return fin((c) => { const r = alu(o, c, c.get(reg, size, hasRex), rd(c, e, size), size); if (r !== null) c.set(reg, size, r, hasRex); });
  }
  if (op >= 0x50 && op <= 0x57) { const n = (op & 7) | B; return fin((c) => c.push(c.r[n])); }
  if (op >= 0x58 && op <= 0x5f) { const n = (op & 7) | B; return fin((c) => { c.r[n] = c.pop(); }); }
  if (op >= 0x70 && op <= 0x7f) { const d = Number(imm(1)); return fjump((c) => (c.cond(op & 15) ? end + d : null)); }
  if (op >= 0x91 && op <= 0x97) { const n = (op & 7) | B; return fin((c) => { const a = c.get(0, osz, hasRex), b = c.get(n, osz, hasRex); c.set(0, osz, b, hasRex); c.set(n, osz, a, hasRex); }); }
  if (op >= 0xb0 && op <= 0xb7) { const n = (op & 7) | B; const v = imm(1); return fin((c) => c.set(n, 1, v, hasRex)); }
  if (op >= 0xb8 && op <= 0xbf) { const n = (op & 7) | B; const v = imm(osz === 8 ? 8 : osz); return fin((c) => c.set(n, osz, v, hasRex)); }
  switch (op) {
    case 0x63: { const { reg, e } = modrm(); return fin((c) => c.set(reg, osz, BigInt.asUintN(64, sx(rd(c, e, 4), 4)), hasRex)); }
    case 0x68: { const v = imm(4); return fin((c) => c.push(BigInt.asUintN(64, v))); }
    case 0x6a: { const v = imm(1); return fin((c) => c.push(BigInt.asUintN(64, v))); }
    case 0x69: case 0x6b: {
      const { reg, e } = modrm();
      const v = imm(op === 0x6b ? 1 : osz === 2 ? 2 : 4);
      return fin((c) => { const full = sx(rd(c, e, osz), osz) * v; const res = BigInt.asUintN(osz * 8, full); c.cf = c.of = sx(res, osz) !== full; c.set(reg, osz, res, hasRex); });
    }
    case 0x80: case 0x81: case 0x83: {
      const { reg, e } = modrm();
      const size = op === 0x80 ? 1 : osz;
      const v = imm(op === 0x81 ? (osz === 2 ? 2 : 4) : 1);
      const o = reg & 7;
      return fin((c) => { const r = alu(o, c, rd(c, e, size), v, size); if (r !== null) wr(c, e, size, r); });
    }
    case 0x84: case 0x85: { const { reg, e } = modrm(); const size = op === 0x84 ? 1 : osz; return fin((c) => { c.logic(rd(c, e, size) & c.get(reg, size, hasRex), size); }); }
    case 0x86: case 0x87: {
      const { reg, e } = modrm(); const size = op === 0x86 ? 1 : osz;
      return fin((c) => { const a = rd(c, e, size), b = c.get(reg, size, hasRex); wr(c, e, size, b); c.set(reg, size, a, hasRex); });
    }
    case 0x88: case 0x89: { const { reg, e } = modrm(); const size = op === 0x88 ? 1 : osz; return fin((c) => wr(c, e, size, c.get(reg, size, hasRex))); }
    case 0x8a: case 0x8b: { const { reg, e } = modrm(); const size = op === 0x8a ? 1 : osz; return fin((c) => c.set(reg, size, rd(c, e, size), hasRex)); }
    case 0x8d: { const { reg, e } = modrm(); if ('reg' in e) return undef('lea with a register'); return fin((c) => c.set(reg, osz, e.ea(c), hasRex)); }
    case 0x8f: { const { e } = modrm(); return fin((c) => { const v = c.pop(); wr(c, e, 8, v); }); }
    case 0x90: return fin(() => {});
    case 0x98: return fin((c) => { if (W) c.r[0] = BigInt.asUintN(64, sx(c.r[0], 4)); else c.set(0, 4, BigInt.asUintN(32, sx(c.r[0], 2)), hasRex); });
    case 0x99: return fin((c) => { if (W) c.r[2] = sx(c.r[0], 8) < 0n ? M64 : 0n; else c.set(2, 4, sx(c.r[0], 4) < 0n ? M32 : 0n, hasRex); });
    case 0xa8: { const v = imm(1); return fin((c) => { c.logic(c.get(0, 1, hasRex) & v, 1); }); }
    case 0xa9: { const v = imm(osz === 2 ? 2 : 4); return fin((c) => { c.logic(c.get(0, osz, hasRex) & BigInt.asUintN(osz * 8, v), osz); }); }
    case 0xc0: case 0xc1: case 0xd0: case 0xd1: case 0xd2: case 0xd3: {
      const { reg, e } = modrm();
      const size = op & 1 ? osz : 1;
      const cnt = op <= 0xc1 ? Number(imm(1)) & 0xff : op <= 0xd1 ? 1 : -1;
      const o = reg & 7;
      return fin((c) => { const n = cnt >= 0 ? cnt : Number(c.r[1] & 0xffn); wr(c, e, size, shift(c, o, rd(c, e, size), n, size)); });
    }
    case 0xc2: { const n = Number(m.u16(p)); p += 2; end = p; return (c) => { c.rip = Number(c.pop()); c.rsp = c.rsp + BigInt(n); }; }
    case 0xc3: end = p; return (c) => { c.rip = Number(c.pop()); };
    case 0xc6: case 0xc7: {
      const { e } = modrm();
      const size = op === 0xc6 ? 1 : osz;
      const v = imm(size === 1 ? 1 : size === 2 ? 2 : 4);
      return fin((c) => wr(c, e, size, BigInt.asUintN(64, v)));
    }
    case 0xc9: return fin((c) => { c.rsp = c.r[5]; c.r[5] = c.pop(); });
    case 0xcc: return () => { throw new EmuError('int3 (breakpoint)', pc); };
    case 0xe8: { const d = Number(imm(4)); end = p; const next = p; return (c) => { c.push(BigInt(next)); c.rip = next + d; }; }
    case 0xe9: { const d = Number(imm(4)); return fjump(() => end + d); }
    case 0xeb: { const d = Number(imm(1)); return fjump(() => end + d); }
    case 0xf4: return () => { throw new EmuError('hlt', pc); };
    case 0xf6: case 0xf7: {
      const { reg, e } = modrm();
      const size = op === 0xf6 ? 1 : osz;
      const o = reg & 7;
      const v = o === 0 || o === 1 ? imm(size === 1 ? 1 : size === 2 ? 2 : 4) : 0n;
      const bits = BigInt(size * 8);
      return fin((c) => {
        const a = rd(c, e, size);
        switch (o) {
          case 0: case 1: c.logic(a & BigInt.asUintN(size * 8, v), size); break;
          case 2: wr(c, e, size, ~a & MASK[size]); break;
          case 3: { const r = c.sub(0n, a, 0n, size); c.cf = a !== 0n; wr(c, e, size, r); break; }
          case 4: case 5: {
            if (size === 1) return undef('8-bit mul');
            const x = o === 4 ? c.get(0, size, hasRex) : sx(c.get(0, size, hasRex), size);
            const y = o === 4 ? a : sx(a, size);
            const full = x * y;
            const lo = BigInt.asUintN(size * 8, full), hi = BigInt.asUintN(size * 8, full >> bits);
            c.set(0, size, lo, hasRex); c.set(2, size, hi, hasRex);
            c.cf = c.of = o === 4 ? hi !== 0n : sx(lo, size) !== full;
            break;
          }
          default: {
            if (size === 1) return undef('8-bit div');
            if (a === 0n) throw new EmuError('integer division by zero (#DE)', pc);
            const hi = c.get(2, size, hasRex), lo = c.get(0, size, hasRex);
            let n = (hi << bits) | lo;
            let q: bigint, r: bigint;
            if (o === 6) { q = n / a; r = n % a; if (q >> bits) throw new EmuError('division overflow (#DE)', pc); }
            else {
              n = BigInt.asIntN(size * 16, n);
              const d = sx(a, size);
              q = n / d; r = n % d;
              if (q !== sx(BigInt.asUintN(size * 8, q), size)) throw new EmuError('division overflow (#DE)', pc);
            }
            c.set(0, size, BigInt.asUintN(size * 8, q), hasRex); c.set(2, size, BigInt.asUintN(size * 8, r), hasRex);
          }
        }
      });
    }
    case 0xfe: case 0xff: {
      const { reg, e } = modrm();
      const o = reg & 7;
      const size = op === 0xfe ? 1 : osz;
      if (o === 0 || o === 1) return fin((c) => { const cf = c.cf; const r = o === 0 ? c.add(rd(c, e, size), 1n, 0n, size) : c.sub(rd(c, e, size), 1n, 0n, size); c.cf = cf; wr(c, e, size, r); });
      if (op === 0xff && o === 2) { end = p; const next = p; return (c) => { const t = Number(rd(c, e, 8)); c.push(BigInt(next)); c.rip = t; }; }
      if (op === 0xff && o === 4) { end = p; return (c) => { c.rip = Number(rd(c, e, 8)); }; }
      if (op === 0xff && o === 6) return fin((c) => c.push(rd(c, e, 8)));
      return undef(`ff /${o}`);
    }
    case 0x0f: return decode0f();
  }
  return undef(`opcode 0x${op.toString(16)}`);

  // ---------------------------------------------------------------- two-byte opcodes
  function decode0f(): Exec {
    const op2 = u8();
    if (op2 >= 0x80 && op2 <= 0x8f) { const d = Number(imm(4)); return fjump((c) => (c.cond(op2 & 15) ? end + d : null)); }
    if (op2 >= 0x90 && op2 <= 0x9f) { const { e } = modrm(); return fin((c) => wr(c, e, 1, c.cond(op2 & 15) ? 1n : 0n)); }
    if (op2 >= 0x40 && op2 <= 0x4f) { const { reg, e } = modrm(); return fin((c) => { const v = rd(c, e, osz); if (c.cond(op2 & 15)) c.set(reg, osz, v, hasRex); else if (osz === 4) c.set(reg, 4, c.get(reg, 4, hasRex), hasRex); }); }
    if (op2 >= 0xc8 && op2 <= 0xcf) {
      const n = (op2 & 7) | B;
      return fin((c) => { const v = c.get(n, osz, hasRex); let r = 0n; for (let i = 0; i < osz; i++) r |= ((v >> BigInt(8 * i)) & 0xffn) << BigInt(8 * (osz - 1 - i)); c.set(n, osz, r, hasRex); });
    }
    switch (op2) {
      case 0x0b: return () => { throw new EmuError('ud2', pc); };
      case 0x1f: { modrm(); return fin(() => {}); }
      case 0x31: return fin((c) => { const t = BigInt(c.steps); c.r[0] = t & M32; c.r[2] = (t >> 32n) & M32; });
      case 0xa2: return fin((c) => { c.r[0] = 0n; c.r[3] = 0n; c.r[1] = 0n; c.r[2] = 0n; });
      case 0xaf: { const { reg, e } = modrm(); return fin((c) => { const full = sx(c.get(reg, osz, hasRex), osz) * sx(rd(c, e, osz), osz); const res = BigInt.asUintN(osz * 8, full); c.cf = c.of = sx(res, osz) !== full; c.set(reg, osz, res, hasRex); }); }
      case 0xb6: case 0xb7: { const { reg, e } = modrm(); const s = op2 === 0xb6 ? 1 : 2; return fin((c) => c.set(reg, osz, rd(c, e, s), hasRex)); }
      case 0xbe: case 0xbf: { const { reg, e } = modrm(); const s = op2 === 0xbe ? 1 : 2; return fin((c) => c.set(reg, osz, BigInt.asUintN(64, sx(rd(c, e, s), s)), hasRex)); }
      case 0xa3: case 0xab: case 0xb3: case 0xbb: case 0xba: {
        const { reg, e } = modrm();
        const ext = op2 === 0xba ? reg & 7 : { 0xa3: 4, 0xab: 5, 0xb3: 6, 0xbb: 7 }[op2]!;
        const iv = op2 === 0xba ? Number(imm(1)) & 0xff : -1;
        return fin((c) => {
          const bit = BigInt((iv >= 0 ? iv : Number(c.get(reg, osz, hasRex))) & (osz * 8 - 1));
          const v = rd(c, e, osz);
          c.cf = ((v >> bit) & 1n) === 1n;
          if (ext === 5) wr(c, e, osz, v | (1n << bit));
          else if (ext === 6) wr(c, e, osz, v & ~(1n << bit));
          else if (ext === 7) wr(c, e, osz, v ^ (1n << bit));
        });
      }
      case 0xbc: case 0xbd: case 0xb8: {
        const { reg, e } = modrm();
        const bits = osz * 8;
        return fin((c) => {
          const v = rd(c, e, osz);
          if (op2 === 0xb8) { let n = 0n; for (let x = v; x; x >>= 1n) n += x & 1n; c.set(reg, osz, n, hasRex); c.zf = v === 0n; c.cf = false; return; }
          if (rep === 0xf3) {
            // lzcnt / tzcnt
            let n = 0;
            if (op2 === 0xbd) { while (n < bits && !((v >> BigInt(bits - 1 - n)) & 1n)) n++; }
            else { while (n < bits && !((v >> BigInt(n)) & 1n)) n++; }
            c.cf = v === 0n; c.zf = n === 0;
            c.set(reg, osz, BigInt(n), hasRex);
            return;
          }
          c.zf = v === 0n;
          if (v === 0n) return;
          let i = op2 === 0xbd ? bits - 1 : 0;
          if (op2 === 0xbd) while (!((v >> BigInt(i)) & 1n)) i--; else while (!((v >> BigInt(i)) & 1n)) i++;
          c.set(reg, osz, BigInt(i), hasRex);
        });
      }
      // ------------------------------------------------------------ SSE
      case 0x10: case 0x11: {
        const { reg, e } = modrm();
        const store = op2 === 0x11;
        if (rep === 0xf2 || rep === 0xf3) {
          const dbl = rep === 0xf2;
          return fin((c) => {
            if (store) { if ('reg' in e) { if (dbl) c.xlo[e.reg] = c.xlo[reg]; else c.xlo[e.reg] = (c.xlo[e.reg] & ~M32) | (c.xlo[reg] & M32); } else c.mem.write(e.mem(c), dbl ? 8 : 4, c.xlo[reg]); }
            else if ('reg' in e) { if (dbl) c.xlo[reg] = c.xlo[e.reg]; else c.xlo[reg] = (c.xlo[reg] & ~M32) | (c.xlo[e.reg] & M32); }
            else { c.xlo[reg] = c.mem.read(e.mem(c), dbl ? 8 : 4); c.xhi[reg] = 0n; }
          });
        }
        return movx(reg, e, store);
      }
      case 0x28: case 0x29: { const { reg, e } = modrm(); return movx(reg, e, op2 === 0x29); }
      // movdqa / movdqu (66 / F3 0F 6F, 7F): 128-bit moves, as compilers emit for struct copies
      case 0x6f: case 0x7f: {
        if (!opsize && rep !== 0xf3) return undef('MMX movq');
        const { reg, e } = modrm();
        return movx(reg, e, op2 === 0x7f);
      }
      case 0x14: { const { reg, e } = modrm(); return fin((c) => { c.xhi[reg] = 'reg' in e ? c.xlo[e.reg] : c.mem.u64(e.mem(c)); }); }
      case 0x2a: {
        const { reg, e } = modrm();
        const dbl = rep === 0xf2;
        const s = W ? 8 : 4;
        return fin((c) => { const v = Number(sx(rd(c, e, s), s)); if (dbl) c.setd(reg, v); else c.sets(reg, Math.fround(v)); });
      }
      case 0x2c: case 0x2d: {
        const { reg, e } = modrm();
        const dbl = rep === 0xf2;
        const s = W ? 8 : 4;
        return fin((c) => {
          const v = 'reg' in e ? (dbl ? c.d(e.reg) : c.s(e.reg)) : (dbl ? bitsToF64(c.mem.u64(e.mem(c))) : bitsToF32(c.mem.u32(e.mem(c))));
          const t = op2 === 0x2c ? Math.trunc(v) : roundEven(v);
          const lim = 2 ** (s * 8 - 1);
          const r = Number.isNaN(t) || t >= lim || t < -lim ? 1n << BigInt(s * 8 - 1) : BigInt.asUintN(s * 8, BigInt(t));
          c.set(reg, s, r, hasRex);
        });
      }
      case 0x2e: case 0x2f: {
        const { reg, e } = modrm();
        const dbl = opsize;
        return fin((c) => {
          const a = dbl ? c.d(reg) : c.s(reg);
          const b = 'reg' in e ? (dbl ? c.d(e.reg) : c.s(e.reg)) : (dbl ? bitsToF64(c.mem.u64(e.mem(c))) : bitsToF32(c.mem.u32(e.mem(c))));
          c.of = false; c.sf = false;
          if (Number.isNaN(a) || Number.isNaN(b)) { c.zf = c.pf = c.cf = true; }
          else { c.pf = false; c.zf = a === b; c.cf = a < b; }
        });
      }
      case 0x51: case 0x58: case 0x59: case 0x5c: case 0x5d: case 0x5e: case 0x5f: case 0x5a: {
        const { reg, e } = modrm();
        if (rep !== 0xf2 && rep !== 0xf3) return undef(`packed SSE 0f ${op2.toString(16)}`);
        const dbl = rep === 0xf2;
        return fin((c) => {
          const b = 'reg' in e ? (dbl ? c.d(e.reg) : c.s(e.reg)) : (dbl ? bitsToF64(c.mem.u64(e.mem(c))) : bitsToF32(c.mem.u32(e.mem(c))));
          if (op2 === 0x5a) { if (dbl) c.sets(reg, Math.fround(b)); else c.setd(reg, b); return; }
          const a = dbl ? c.d(reg) : c.s(reg);
          let r: number;
          switch (op2) {
            case 0x51: r = Math.sqrt(b); break;
            case 0x58: r = a + b; break;
            case 0x59: r = a * b; break;
            case 0x5c: r = a - b; break;
            case 0x5d: r = a < b ? a : b; break;
            case 0x5e: r = a / b; break;
            default: r = a > b ? a : b; break;
          }
          if (dbl) c.setd(reg, r); else c.sets(reg, Math.fround(r));
        });
      }
      case 0x54: case 0x55: case 0x56: case 0x57: case 0xef: {
        const { reg, e } = modrm();
        return fin((c) => {
          const lo = 'reg' in e ? c.xlo[e.reg] : c.mem.u64(e.mem(c));
          const hi = 'reg' in e ? c.xhi[e.reg] : c.mem.u64(e.mem(c) + 8);
          const f = (a: bigint, b: bigint) => (op2 === 0x54 ? a & b : op2 === 0x55 ? ~a & b & M64 : op2 === 0x56 ? a | b : a ^ b);
          c.xlo[reg] = f(c.xlo[reg], lo);
          c.xhi[reg] = f(c.xhi[reg], hi);
        });
      }
      case 0x6e: {
        const { reg, e } = modrm();
        return fin((c) => { c.xlo[reg] = rd(c, e, W ? 8 : 4); c.xhi[reg] = 0n; });
      }
      case 0x7e: {
        const { reg, e } = modrm();
        if (rep === 0xf3) return fin((c) => { c.xlo[reg] = 'reg' in e ? c.xlo[e.reg] : c.mem.u64(e.mem(c)); c.xhi[reg] = 0n; });
        return fin((c) => wr(c, e, W ? 8 : 4, W ? c.xlo[reg] : c.xlo[reg] & M32));
      }
      case 0xd6: { const { reg, e } = modrm(); return fin((c) => { if ('reg' in e) { c.xlo[e.reg] = c.xlo[reg]; c.xhi[e.reg] = 0n; } else c.mem.set64(e.mem(c), c.xlo[reg]); }); }
    }
    return undef(`opcode 0f ${op2.toString(16)}`);
  }

  function movx(reg: number, e: E, store: boolean): Exec {
    return fin((c) => {
      if (store) {
        if ('reg' in e) { c.xlo[e.reg] = c.xlo[reg]; c.xhi[e.reg] = c.xhi[reg]; }
        else { const a = e.mem(c); c.mem.set64(a, c.xlo[reg]); c.mem.set64(a + 8, c.xhi[reg]); }
      } else if ('reg' in e) { c.xlo[reg] = c.xlo[e.reg]; c.xhi[reg] = c.xhi[e.reg]; }
      else { const a = e.mem(c); c.xlo[reg] = c.mem.u64(a); c.xhi[reg] = c.mem.u64(a + 8); }
    });
  }
}

function roundEven(v: number): number {
  const r = Math.round(v);
  return Math.abs(v % 1) === 0.5 ? 2 * Math.round(v / 2) : r;
}

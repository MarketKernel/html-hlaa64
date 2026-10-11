// AArch64 interpreter for the instruction subset the HLA64 toolchain produces
// (plus the usual hand-written code). 64-bit values are BigInts; every decoded
// instruction is cached as a closure keyed by its address.
import { fpImm8Value } from './fpimm.ts';

export const M64 = (1n << 64n) - 1n;
export const M32 = 0xffffffffn;

export class EmuError extends Error {
  pc: number;
  constructor(msg: string, pc: number) {
    super(pc >= 0 ? `${msg} at 0x${pc.toString(16)}` : msg);   // pc < 0: the loader adds where it happened
    this.pc = pc;
  }
}

export class ExitSignal {
  code: number;
  constructor(code: number) { this.code = code; }
}

// ---------------------------------------------------------------------------
// memory
// ---------------------------------------------------------------------------
export interface Region {
  base: number; size: number; data: Uint8Array; dv: DataView; name: string; writable: boolean;
  /** called on the first access (a guard page); the access is retried afterwards */
  onTouch?: () => void;
}

export class Memory {
  regions: Region[] = [];
  last: Region | null = null;

  map(name: string, base: number, size: number, writable = true, init?: Uint8Array): Region {
    const data = new Uint8Array(size);
    if (init) data.set(init.subarray(0, size));
    const r = { base, size, data, dv: new DataView(data.buffer), name, writable };
    this.regions.push(r);
    return r;
  }

  find(addr: number, len: number): Region {
    const l = this.last;
    if (l && addr >= l.base && addr + len <= l.base + l.size) return l;
    for (const r of this.regions) {
      if (addr >= r.base && addr + len <= r.base + r.size) {
        if (r.onTouch) { r.onTouch(); return this.find(addr, len); }
        this.last = r;
        return r;
      }
    }
    throw new EmuError(`memory access fault at 0x${addr.toString(16)} (${len} bytes)`, -1);
  }

  w(addr: number, len: number): Region {
    const r = this.find(addr, len);
    if (!r.writable) throw new EmuError(`write to read-only memory (${r.name}) at 0x${addr.toString(16)}`, -1);
    return r;
  }

  u8(a: number): number { const r = this.find(a, 1); return r.data[a - r.base]; }
  u16(a: number): number { const r = this.find(a, 2); return r.dv.getUint16(a - r.base, true); }
  u32(a: number): number { const r = this.find(a, 4); return r.dv.getUint32(a - r.base, true); }
  u64(a: number): bigint { const r = this.find(a, 8); return r.dv.getBigUint64(a - r.base, true); }
  set8(a: number, v: number) { const r = this.w(a, 1); r.data[a - r.base] = v; }
  set16(a: number, v: number) { const r = this.w(a, 2); r.dv.setUint16(a - r.base, v, true); }
  set32(a: number, v: number) { const r = this.w(a, 4); r.dv.setUint32(a - r.base, v >>> 0, true); }
  set64(a: number, v: bigint) { const r = this.w(a, 8); r.dv.setBigUint64(a - r.base, v & M64, true); }

  read(addr: bigint | number, len: bigint | number): bigint {
    const a = Number(addr);
    switch (Number(len)) {
      case 1: return BigInt(this.u8(a));
      case 2: return BigInt(this.u16(a));
      case 4: return BigInt(this.u32(a));
      default: return this.u64(a);
    }
  }

  write(addr: number, len: number, v: bigint) {
    switch (len) {
      case 1: this.set8(addr, Number(v & 0xffn)); break;
      case 2: this.set16(addr, Number(v & 0xffffn)); break;
      case 4: this.set32(addr, Number(v & M32)); break;
      default: this.set64(addr, v); break;
    }
  }

  cstring(addr: number, max = 1 << 20): Uint8Array {
    const out: number[] = [];
    for (let i = 0; i < max; i++) {
      const b = this.u8(addr + i);
      if (!b) break;
      out.push(b);
    }
    return new Uint8Array(out);
  }

  bytes(addr: number, len: number): Uint8Array {
    if (len === 0) return new Uint8Array(0);
    const r = this.find(addr, len);
    return r.data.slice(addr - r.base, addr - r.base + len);
  }

  setBytes(addr: number, b: Uint8Array) {
    if (!b.length) return;
    const r = this.w(addr, b.length);
    r.data.set(b, addr - r.base);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const sx = (v: bigint, bits: number): bigint => BigInt.asIntN(bits, v);
const ones = (n: number): bigint => (n >= 64 ? M64 : (1n << BigInt(n)) - 1n);

function decodeBitMasks(n: number, imms: number, immr: number, bits: number): bigint {
  const combined = (n << 6) | (~imms & 0x3f);
  let len = -1;
  for (let i = 6; i >= 0; i--) if (combined & (1 << i)) { len = i; break; }
  if (len < 1) throw new Error('reserved bitmask');
  const levels = (1 << len) - 1;
  const s = imms & levels, r = immr & levels;
  const esize = 1 << len;
  const welem = ones(s + 1);
  const em = ones(esize);
  const rot = r === 0 ? welem : ((welem >> BigInt(r)) | (welem << BigInt(esize - r))) & em;
  let v = 0n;
  for (let i = 0; i < bits; i += esize) v |= rot << BigInt(i);
  return v & ones(bits);
}

const f64 = new DataView(new ArrayBuffer(8));
export function bitsToF64(b: bigint): number { f64.setBigUint64(0, b & M64); return f64.getFloat64(0); }
export function f64ToBits(v: number): bigint { f64.setFloat64(0, v); return f64.getBigUint64(0); }
export function bitsToF32(b: number): number { f64.setUint32(0, b >>> 0); return f64.getFloat32(0); }
export function f32ToBits(v: number): number { f64.setFloat32(0, v); return f64.getUint32(0); }

type Exec = (c: Cpu) => void;

export class Cpu {
  x = new Array<bigint>(31).fill(0n);
  sp = 0n;
  pc = 0;
  n = false; z = false; c = false; v = false;
  vlo = new BigUint64Array(32);
  vhi = new BigUint64Array(32);
  mem: Memory;
  cache = new Map<number, Exec>();
  steps = 0;
  limit = 200_000_000;
  /** called for `svc` */
  onSvc: (c: Cpu, imm: number) => void = () => { throw new EmuError('svc not handled', this.pc); };
  /** host functions mapped at thunk addresses */
  thunks = new Map<number, (c: Cpu) => void>();

  constructor(mem: Memory) { this.mem = mem; }

  // register access: n == 31 reads zr unless sp is requested
  r(n: number): bigint { return n === 31 ? 0n : this.x[n]; }
  rsp(n: number): bigint { return n === 31 ? this.sp : this.x[n]; }
  set(n: number, v: bigint) { if (n !== 31) this.x[n] = v & M64; }
  setsp(n: number, v: bigint) { if (n === 31) this.sp = v & M64; else this.x[n] = v & M64; }
  rw(n: number, sf: boolean): bigint { return sf ? this.r(n) : this.r(n) & M32; }
  setw(n: number, v: bigint, sf: boolean) { this.set(n, sf ? v : v & M32); }

  d(n: number): number { return bitsToF64(this.vlo[n]); }
  s(n: number): number { return bitsToF32(Number(this.vlo[n] & M32)); }
  setd(n: number, v: number) { this.vlo[n] = f64ToBits(v); this.vhi[n] = 0n; }
  sets(n: number, v: number) { this.vlo[n] = BigInt(f32ToBits(v)); this.vhi[n] = 0n; }
  fp(n: number, dbl: boolean): number { return dbl ? this.d(n) : this.s(n); }
  setfp(n: number, v: number, dbl: boolean) { if (dbl) this.setd(n, v); else this.sets(n, Math.fround(v)); }

  cond(cc: number): boolean {
    let r: boolean;
    switch (cc >> 1) {
      case 0: r = this.z; break;
      case 1: r = this.c; break;
      case 2: r = this.n; break;
      case 3: r = this.v; break;
      case 4: r = this.c && !this.z; break;
      case 5: r = this.n === this.v; break;
      case 6: r = this.n === this.v && !this.z; break;
      default: r = true;
    }
    if ((cc & 1) && cc !== 15) r = !r;
    return r;
  }

  setNZCV(nzcv: number) { this.n = !!(nzcv & 8); this.z = !!(nzcv & 4); this.c = !!(nzcv & 2); this.v = !!(nzcv & 1); }

  /** x + y + carry with flags (width bits). */
  addc(x: bigint, y: bigint, carry: bigint, sf: boolean, setFlags: boolean): bigint {
    const mask = sf ? M64 : M32;
    const bits = sf ? 64 : 32;
    const ux = x & mask, uy = y & mask;
    const usum = ux + uy + carry;
    const res = usum & mask;
    if (setFlags) {
      this.n = (res >> BigInt(bits - 1)) === 1n;
      this.z = res === 0n;
      this.c = usum > mask;
      this.v = sx(ux, bits) + sx(uy, bits) + carry !== sx(res, bits);
    }
    return res;
  }

  /** Run until `stopPc` is reached (or forever when null). */
  run(stopPc: number | null = null): void {
    const cache = this.cache;
    while (this.pc !== stopPc) {
      if (++this.steps > this.limit) throw new EmuError(`instruction limit (${this.limit}) exceeded — infinite loop?`, this.pc);
      const pc = this.pc;
      let f = cache.get(pc);
      if (!f) {
        const thunk = this.thunks.get(pc);
        if (thunk) {
          f = (c) => { thunk(c); c.pc = Number(c.x[30]); };
        } else {
          let word: number;
          try { word = this.mem.u32(pc); } catch { throw new EmuError('jump to unmapped memory', pc); }
          f = decode(word, pc);
        }
        cache.set(pc, f);
      }
      f(this);
    }
  }

  /** Call guest code at `addr` from a host function (re-entrant). */
  call(addr: number, args: bigint[], returnThunk: number): bigint {
    const savedPc = this.pc, savedLr = this.x[30];
    args.forEach((a, i) => this.set(i, a));
    this.x[30] = BigInt(returnThunk);
    this.pc = addr;
    this.run(returnThunk);
    this.pc = savedPc;
    this.x[30] = savedLr;
    return this.x[0];
  }
}

// ---------------------------------------------------------------------------
// decoder
// ---------------------------------------------------------------------------
function undef(word: number, pc: number): Exec {
  return () => { throw new EmuError(`unsupported instruction 0x${word.toString(16).padStart(8, '0')}`, pc); };
}

function shiftReg(v: bigint, type: number, amt: number, sf: boolean): bigint {
  const bits = sf ? 64 : 32;
  const mask = sf ? M64 : M32;
  const a = BigInt(amt);
  v &= mask;
  switch (type) {
    case 0: return (v << a) & mask;
    case 1: return v >> a;
    case 2: return BigInt.asUintN(bits, sx(v, bits) >> a);
    default: return amt === 0 ? v : ((v >> a) | (v << BigInt(bits - amt))) & mask;
  }
}

function extendReg(v: bigint, option: number, shift: number): bigint {
  let r: bigint;
  switch (option) {
    case 0: r = v & 0xffn; break;
    case 1: r = v & 0xffffn; break;
    case 2: r = v & M32; break;
    case 3: r = v; break;
    case 4: r = BigInt.asUintN(64, sx(v & 0xffn, 8)); break;
    case 5: r = BigInt.asUintN(64, sx(v & 0xffffn, 16)); break;
    case 6: r = BigInt.asUintN(64, sx(v & M32, 32)); break;
    default: r = v;
  }
  return (r << BigInt(shift)) & M64;
}

function decode(w: number, pc: number): Exec {
  const next = pc + 4;
  const rd = w & 31, rn = (w >>> 5) & 31, rm = (w >>> 16) & 31;
  const sf = (w >>> 31) === 1;
  const mask = sf ? M64 : M32;
  const bits = sf ? 64 : 32;

  // ------------------------------------------------ data processing (immediate)
  if (((w & 0x1f000000) >>> 0) === 0x11000000) {
    const op = (w >>> 30) & 1, S = (w >>> 29) & 1;
    const imm = BigInt(((w >>> 10) & 0xfff) << ((w >>> 22) & 1 ? 12 : 0));
    return (c) => {
      const a = c.rsp(rn) & mask;
      const res = op ? c.addc(a, ~imm & mask, 1n, sf, !!S) : c.addc(a, imm, 0n, sf, !!S);
      if (S) c.set(rd, res); else c.setsp(rd, res);
      c.pc = next;
    };
  }
  if (((w & 0x1f800000) >>> 0) === 0x12000000) {
    const opc = (w >>> 29) & 3;
    const imm = decodeBitMasks((w >>> 22) & 1, (w >>> 10) & 63, (w >>> 16) & 63, bits);
    return (c) => {
      const a = c.r(rn) & mask;
      let res: bigint;
      switch (opc) {
        case 0: res = a & imm; break;
        case 1: res = a | imm; break;
        case 2: res = a ^ imm; break;
        default:
          res = a & imm;
          c.n = (res >> BigInt(bits - 1)) === 1n; c.z = res === 0n; c.c = false; c.v = false;
      }
      if (opc === 3) c.set(rd, res); else c.setsp(rd, res);
      c.pc = next;
    };
  }
  if (((w & 0x1f800000) >>> 0) === 0x12800000) {
    const opc = (w >>> 29) & 3, hw = (w >>> 21) & 3;
    const imm = BigInt((w >>> 5) & 0xffff) << BigInt(hw * 16);
    if (opc === 1) return undef(w, pc);
    return (c) => {
      if (opc === 0) c.set(rd, ~imm & mask);
      else if (opc === 2) c.set(rd, imm);
      else c.set(rd, ((c.r(rd) & ~(0xffffn << BigInt(hw * 16))) | imm) & mask);
      c.pc = next;
    };
  }
  if (((w & 0x1f800000) >>> 0) === 0x13000000) {
    const opc = (w >>> 29) & 3;
    const immr = (w >>> 16) & 63, imms = (w >>> 10) & 63;
    return (c) => {
      const src = c.r(rn) & mask;
      let res: bigint;
      if (opc === 1) {
        // BFM
        let dst = c.r(rd) & mask;
        if (imms >= immr) {
          const wd = imms - immr + 1;
          dst = (dst & ~ones(wd)) | ((src >> BigInt(immr)) & ones(wd));
        } else {
          const wd = imms + 1, pos = bits - immr;
          dst = (dst & ~(ones(wd) << BigInt(pos))) | ((src & ones(wd)) << BigInt(pos));
        }
        res = dst & mask;
      } else {
        let width: number, val: bigint, pos: number;
        if (imms >= immr) { width = imms - immr + 1; val = (src >> BigInt(immr)) & ones(width); pos = 0; }
        else { width = imms + 1; val = src & ones(width); pos = bits - immr; }
        if (opc === 0) {
          // sign-extend from bit (pos + width - 1)
          const total = pos + width;
          res = BigInt.asUintN(bits, sx(val << BigInt(pos), total));
        } else res = (val << BigInt(pos)) & mask;
      }
      c.set(rd, res);
      c.pc = next;
    };
  }
  if (((w & 0x1f800000) >>> 0) === 0x13800000) {
    const lsb = BigInt((w >>> 10) & 63);
    return (c) => {
      const cat = ((c.r(rn) & mask) << BigInt(bits)) | (c.r(rm) & mask);
      c.set(rd, (cat >> lsb) & mask);
      c.pc = next;
    };
  }
  if (((w & 0x1f000000) >>> 0) === 0x10000000) {
    const page = (w >>> 31) === 1;
    let imm = (((w >>> 5) & 0x7ffff) << 2) | ((w >>> 29) & 3);
    if (imm & 0x100000) imm -= 0x200000;
    const target = page ? Math.floor(pc / 4096) * 4096 + imm * 4096 : pc + imm;
    return (c) => { c.set(rd, BigInt(target)); c.pc = next; };
  }

  // ------------------------------------------------ branches & system
  if (((w & 0x7c000000) >>> 0) === 0x14000000) {
    let imm = w & 0x3ffffff;
    if (imm & 0x2000000) imm -= 0x4000000;
    const target = pc + imm * 4;
    const link = (w >>> 31) === 1;
    return (c) => { if (link) c.x[30] = BigInt(next); c.pc = target; };
  }
  if (((w & 0x7e000000) >>> 0) === 0x34000000) {
    let imm = (w >>> 5) & 0x7ffff;
    if (imm & 0x40000) imm -= 0x80000;
    const target = pc + imm * 4;
    const nz = (w >>> 24) & 1;
    return (c) => { c.pc = ((c.r(rd) & mask) === 0n) !== !!nz ? target : next; };
  }
  if (((w & 0x7e000000) >>> 0) === 0x36000000) {
    let imm = (w >>> 5) & 0x3fff;
    if (imm & 0x2000) imm -= 0x4000;
    const target = pc + imm * 4;
    const bit = BigInt(((w >>> 31) << 5) | ((w >>> 19) & 31));
    const nz = (w >>> 24) & 1;
    return (c) => { c.pc = (((c.r(rd) >> bit) & 1n) === 1n) === !!nz ? target : next; };
  }
  if (((w & 0xff000010) >>> 0) === 0x54000000) {
    let imm = (w >>> 5) & 0x7ffff;
    if (imm & 0x40000) imm -= 0x80000;
    const target = pc + imm * 4;
    const cc = w & 15;
    return (c) => { c.pc = c.cond(cc) ? target : next; };
  }
  if (((w & 0xffe0001f) >>> 0) === 0xd4000001) {
    const imm = (w >>> 5) & 0xffff;
    return (c) => { c.pc = next; c.onSvc(c, imm); };
  }
  if (((w & 0xffe0001f) >>> 0) === 0xd4200000) {
    return () => { throw new EmuError(`brk #${(w >>> 5) & 0xffff}`, pc); };
  }
  if (((w & 0xffdffc1f) >>> 0) === 0xd61f0000) {
    const link = (w & 0x00200000) !== 0;
    return (c) => { const t = Number(c.r(rn)); if (link) c.x[30] = BigInt(next); c.pc = t; };
  }
  if (((w & 0xfffffc1f) >>> 0) === 0xd65f0000) return (c) => { c.pc = Number(c.r(rn)); };
  if (((w & 0xfffff01f) >>> 0) === 0xd503201f || ((w & 0xfffff000) >>> 0) === 0xd5033000) return (c) => { c.pc = next; };

  // ------------------------------------------------ loads & stores
  if (((w & 0x3a000000) >>> 0) === 0x28000000) return decodePair(w, pc);
  if (((w & 0x3b000000) >>> 0) === 0x18000000) {
    const opc = w >>> 30, V = (w >>> 26) & 1;
    let imm = (w >>> 5) & 0x7ffff;
    if (imm & 0x40000) imm -= 0x80000;
    const addr = pc + imm * 4;
    return (c) => {
      if (V) {
        if (opc === 0) c.vlo[rd] = BigInt(c.mem.u32(addr));
        else c.vlo[rd] = c.mem.u64(addr);
        c.vhi[rd] = opc === 2 ? c.mem.u64(addr + 8) : 0n;
      } else if (opc === 0) c.set(rd, BigInt(c.mem.u32(addr)));
      else if (opc === 1) c.set(rd, c.mem.u64(addr));
      else c.set(rd, BigInt.asUintN(64, sx(BigInt(c.mem.u32(addr)), 32)));
      c.pc = next;
    };
  }
  if (((w & 0x3b000000) >>> 0) === 0x39000000 || ((w & 0x3b200000) >>> 0) === 0x38000000 || ((w & 0x3b200c00) >>> 0) === 0x38200800) {
    return decodeLoadStore(w, pc);
  }

  // ------------------------------------------------ data processing (register)
  if (((w & 0x1f000000) >>> 0) === 0x0a000000) {
    const opc = (w >>> 29) & 3, shift = (w >>> 22) & 3, N = (w >>> 21) & 1, amt = (w >>> 10) & 63;
    return (c) => {
      let b = shiftReg(c.r(rm), shift, amt, sf);
      if (N) b = ~b & mask;
      const a = c.r(rn) & mask;
      let res: bigint;
      switch (opc) {
        case 0: res = a & b; break;
        case 1: res = a | b; break;
        case 2: res = a ^ b; break;
        default:
          res = a & b;
          c.n = (res >> BigInt(bits - 1)) === 1n; c.z = res === 0n; c.c = false; c.v = false;
      }
      c.set(rd, res);
      c.pc = next;
    };
  }
  if (((w & 0x1f200000) >>> 0) === 0x0b000000) {
    const op = (w >>> 30) & 1, S = (w >>> 29) & 1, shift = (w >>> 22) & 3, amt = (w >>> 10) & 63;
    return (c) => {
      const b = shiftReg(c.r(rm), shift, amt, sf);
      const a = c.r(rn) & mask;
      const res = op ? c.addc(a, ~b & mask, 1n, sf, !!S) : c.addc(a, b, 0n, sf, !!S);
      c.set(rd, res);
      c.pc = next;
    };
  }
  if (((w & 0x1f200000) >>> 0) === 0x0b200000) {
    const op = (w >>> 30) & 1, S = (w >>> 29) & 1, option = (w >>> 13) & 7, amt = (w >>> 10) & 7;
    return (c) => {
      const b = extendReg(c.r(rm), option, amt) & mask;
      const a = c.rsp(rn) & mask;
      const res = op ? c.addc(a, ~b & mask, 1n, sf, !!S) : c.addc(a, b, 0n, sf, !!S);
      if (S) c.set(rd, res); else c.setsp(rd, res);
      c.pc = next;
    };
  }
  if (((w & 0x3fe00000) >>> 0) === 0x3a400000) {
    const op = (w >>> 30) & 1, cc = (w >>> 12) & 15, nzcv = w & 15, isImm = (w >>> 11) & 1;
    return (c) => {
      if (c.cond(cc)) {
        const a = c.r(rn) & mask;
        const b = isImm ? BigInt(rm) : c.r(rm) & mask;
        if (op) c.addc(a, ~b & mask, 1n, sf, true); else c.addc(a, b, 0n, sf, true);
      } else c.setNZCV(nzcv);
      c.pc = next;
    };
  }
  if (((w & 0x1fe00000) >>> 0) === 0x1a800000) {
    const op = (w >>> 30) & 1, o2 = (w >>> 10) & 1, cc = (w >>> 12) & 15;
    return (c) => {
      let res: bigint;
      if (c.cond(cc)) res = c.r(rn) & mask;
      else {
        res = c.r(rm) & mask;
        if (op) res = ~res & mask;
        if (o2) res = (res + 1n) & mask;
      }
      c.set(rd, res);
      c.pc = next;
    };
  }
  if (((w & 0x5fe00000) >>> 0) === 0x1ac00000) {
    const opcode = (w >>> 10) & 63;
    return (c) => {
      const a = c.r(rn) & mask, b = c.r(rm) & mask;
      let res: bigint;
      switch (opcode) {
        case 2: res = b === 0n ? 0n : a / b; break;
        case 3: res = b === 0n ? 0n : BigInt.asUintN(bits, sx(a, bits) / sx(b, bits)); break;
        case 8: res = shiftReg(a, 0, Number(b % BigInt(bits)), sf); break;
        case 9: res = shiftReg(a, 1, Number(b % BigInt(bits)), sf); break;
        case 10: res = shiftReg(a, 2, Number(b % BigInt(bits)), sf); break;
        case 11: res = shiftReg(a, 3, Number(b % BigInt(bits)), sf); break;
        default: throw new EmuError(`unsupported data-processing op ${opcode}`, pc);
      }
      c.set(rd, res & mask);
      c.pc = next;
    };
  }
  if (((w & 0x5fe00000) >>> 0) === 0x5ac00000) {
    const opcode = (w >>> 10) & 63;
    return (c) => {
      const a = c.r(rn) & mask;
      let res = 0n;
      switch (opcode) {
        case 0: for (let i = 0; i < bits; i++) if ((a >> BigInt(i)) & 1n) res |= 1n << BigInt(bits - 1 - i); break;
        case 1: case 2: case 3: {
          const chunk = opcode === 1 ? 16 : opcode === 2 ? 32 : 64;
          const cb = Math.min(chunk, bits);
          for (let base = 0; base < bits; base += cb) {
            for (let i = 0; i < cb / 8; i++) {
              const byte = (a >> BigInt(base + i * 8)) & 0xffn;
              res |= byte << BigInt(base + cb - 8 - i * 8);
            }
          }
          break;
        }
        case 4: { let n = 0; for (let i = bits - 1; i >= 0 && !((a >> BigInt(i)) & 1n); i--) n++; res = BigInt(n); break; }
        case 5: {
          const top = (a >> BigInt(bits - 1)) & 1n;
          let n = 0;
          for (let i = bits - 2; i >= 0 && ((a >> BigInt(i)) & 1n) === top; i--) n++;
          res = BigInt(n);
          break;
        }
        default: throw new EmuError(`unsupported data-processing op ${opcode}`, pc);
      }
      c.set(rd, res & mask);
      c.pc = next;
    };
  }
  if (((w & 0x1f000000) >>> 0) === 0x1b000000) {
    const op31 = (w >>> 21) & 7, o0 = (w >>> 15) & 1, ra = (w >>> 10) & 31;
    return (c) => {
      let res: bigint;
      switch (op31) {
        case 0: { const p = (c.r(rn) * c.r(rm)) & mask; res = o0 ? c.r(ra) - p : c.r(ra) + p; break; }
        case 1: { const p = sx(c.r(rn) & M32, 32) * sx(c.r(rm) & M32, 32); res = o0 ? c.r(ra) - p : c.r(ra) + p; break; }
        case 5: { const p = (c.r(rn) & M32) * (c.r(rm) & M32); res = o0 ? c.r(ra) - p : c.r(ra) + p; break; }
        case 2: res = (sx(c.r(rn), 64) * sx(c.r(rm), 64)) >> 64n; break;
        case 6: res = (c.r(rn) * c.r(rm)) >> 64n; break;
        default: throw new EmuError('unsupported multiply', pc);
      }
      c.set(rd, BigInt.asUintN(64, res) & (op31 === 0 ? mask : M64));
      c.pc = next;
    };
  }

  // ------------------------------------------------ floating point
  if (((w & 0x1f000000) >>> 0) === 0x1f000000) {
    const dbl = ((w >>> 22) & 3) === 1, o1 = (w >>> 21) & 1, o0 = (w >>> 15) & 1, ra = (w >>> 10) & 31;
    return (c) => {
      const p = c.fp(rn, dbl) * c.fp(rm, dbl);
      const a = c.fp(ra, dbl);
      let res = o0 ? a - p : a + p;
      if (o1) res = o0 ? p - a : -(a + p);
      c.setfp(rd, res, dbl);
      c.pc = next;
    };
  }
  if (((w & 0x5f200000) >>> 0) === 0x1e200000) return decodeFp(w, pc);

  return undef(w, pc);
}

function decodePair(w: number, pc: number): Exec {
  const next = pc + 4;
  const opc = w >>> 30, V = (w >>> 26) & 1, mode = (w >>> 23) & 3, L = (w >>> 22) & 1;
  let imm7 = (w >>> 15) & 0x7f;
  if (imm7 & 0x40) imm7 -= 0x80;
  const rt = w & 31, rt2 = (w >>> 10) & 31, rn = (w >>> 5) & 31;
  const size = V ? 4 << opc : opc === 2 ? 8 : 4;
  const off = imm7 * size;
  if (mode === 0) return undef(w, pc);
  return (c) => {
    const base = Number(c.rsp(rn));
    const addr = mode === 1 ? base : base + off;
    const m = c.mem;
    const ld = (r: number, a: number) => {
      if (V) {
        if (size === 16) { c.vlo[r] = m.u64(a); c.vhi[r] = m.u64(a + 8); }
        else { c.vlo[r] = size === 8 ? m.u64(a) : BigInt(m.u32(a)); c.vhi[r] = 0n; }
      } else if (size === 8) c.set(r, m.u64(a));
      else c.set(r, BigInt(m.u32(a)));
    };
    const st = (r: number, a: number) => {
      if (V) {
        if (size === 16) { m.set64(a, c.vlo[r]); m.set64(a + 8, c.vhi[r]); }
        else if (size === 8) m.set64(a, c.vlo[r]); else m.set32(a, Number(c.vlo[r] & M32));
      } else if (size === 8) m.set64(a, c.r(r));
      else m.set32(a, Number(c.r(r) & M32));
    };
    if (L) { ld(rt, addr); ld(rt2, addr + size); } else { st(rt, addr); st(rt2, addr + size); }
    if (mode !== 2) c.setsp(rn, BigInt(base + off));
    c.pc = next;
  };
}

function decodeLoadStore(w: number, pc: number): Exec {
  const next = pc + 4;
  const size = w >>> 30, V = (w >>> 26) & 1, opc = (w >>> 22) & 3;
  const rt = w & 31, rn = (w >>> 5) & 31;
  let bytes = 1 << size;
  let isLoad: boolean, signed = false, to64 = true, isQ = false;
  if (V) {
    if (opc >= 2) { if (size !== 0) return undef(w, pc); isQ = true; bytes = 16; isLoad = opc === 3; }
    else isLoad = opc === 1;
  } else {
    if (size === 3 && opc >= 2) return (c) => { c.pc = next; }; // prfm
    isLoad = opc !== 0;
    signed = opc >= 2;
    to64 = opc === 2 || (opc === 1 && size === 3);
  }
  // address mode
  let addrFn: (c: Cpu) => number;
  let wb: ((c: Cpu) => void) | null = null;
  if (((w & 0x3b000000) >>> 0) === 0x39000000) {
    const off = ((w >>> 10) & 0xfff) * bytes;
    addrFn = (c) => Number(c.rsp(rn)) + off;
  } else if (((w & 0x3b200c00) >>> 0) === 0x38200800) {
    const rm = (w >>> 16) & 31, option = (w >>> 13) & 7, S = (w >>> 12) & 1;
    const sh = S ? Math.log2(bytes) : 0;
    addrFn = (c) => Number((c.rsp(rn) + extendReg(c.r(rm), option, sh)) & M64);
  } else {
    let imm9 = (w >>> 12) & 0x1ff;
    if (imm9 & 0x100) imm9 -= 0x200;
    const kind = (w >>> 10) & 3;
    if (kind === 0) addrFn = (c) => Number(c.rsp(rn)) + imm9;
    else if (kind === 1) { addrFn = (c) => Number(c.rsp(rn)); wb = (c) => c.setsp(rn, c.rsp(rn) + BigInt(imm9)); }
    else if (kind === 3) { addrFn = (c) => Number(c.rsp(rn)) + imm9; wb = (c) => c.setsp(rn, c.rsp(rn) + BigInt(imm9)); }
    else return undef(w, pc);
  }
  return (c) => {
    const a = addrFn(c);
    const m = c.mem;
    if (V) {
      if (isLoad) {
        if (isQ) { c.vlo[rt] = m.u64(a); c.vhi[rt] = m.u64(a + 8); }
        else { c.vlo[rt] = m.read(a, bytes); c.vhi[rt] = 0n; }
      } else if (isQ) { m.set64(a, c.vlo[rt]); m.set64(a + 8, c.vhi[rt]); }
      else m.write(a, bytes, c.vlo[rt]);
    } else if (isLoad) {
      let v = m.read(a, bytes);
      if (signed) v = BigInt.asUintN(to64 ? 64 : 32, sx(v, bytes * 8));
      c.set(rt, to64 ? v : v & M32);
    } else {
      m.write(a, bytes, c.r(rt));
    }
    if (wb) wb(c);
    c.pc = next;
  };
}

function roundEven(v: number): number {
  const r = Math.round(v);
  return Math.abs(v % 1) === 0.5 ? 2 * Math.round(v / 2) : r;
}

function fpToInt(v: number, bits: number, unsigned: boolean): bigint {
  if (Number.isNaN(v)) return 0n;
  const t = Math.trunc(v);
  const max = unsigned ? 2 ** bits - 1 : 2 ** (bits - 1) - 1;
  const min = unsigned ? 0 : -(2 ** (bits - 1));
  if (t >= max) return unsigned ? (1n << BigInt(bits)) - 1n : (1n << BigInt(bits - 1)) - 1n;
  if (t <= min) return unsigned ? 0n : BigInt.asUintN(bits, -(1n << BigInt(bits - 1)));
  return BigInt.asUintN(bits, BigInt(t));
}

function decodeFp(w: number, pc: number): Exec {
  const next = pc + 4;
  const rd = w & 31, rn = (w >>> 5) & 31, rm = (w >>> 16) & 31;
  const type = (w >>> 22) & 3;
  const dbl = type === 1;
  const sf = (w >>> 31) === 1;
  const low = (w >>> 10) & 3;
  if (low === 2) {
    const opcode = (w >>> 12) & 15;
    return (c) => {
      const a = c.fp(rn, dbl), b = c.fp(rm, dbl);
      let r: number;
      switch (opcode) {
        case 0: r = a * b; break;
        case 1: r = a / b; break;
        case 2: r = a + b; break;
        case 3: r = a - b; break;
        case 4: r = Number.isNaN(a) || Number.isNaN(b) ? NaN : Math.max(a, b); break;
        case 5: r = Number.isNaN(a) || Number.isNaN(b) ? NaN : Math.min(a, b); break;
        case 6: r = Number.isNaN(a) ? b : Number.isNaN(b) ? a : Math.max(a, b); break;
        case 7: r = Number.isNaN(a) ? b : Number.isNaN(b) ? a : Math.min(a, b); break;
        case 8: r = -(a * b); break;
        default: throw new EmuError('unsupported fp op', pc);
      }
      c.setfp(rd, r, dbl);
      c.pc = next;
    };
  }
  if (low === 3) {
    const cc = (w >>> 12) & 15;
    return (c) => { c.setfp(rd, c.cond(cc) ? c.fp(rn, dbl) : c.fp(rm, dbl), dbl); c.pc = next; };
  }
  if (low === 1) return undef(w, pc);
  if ((w >>> 12) & 1) {
    // fmov immediate
    const v = fpImm8Value((w >>> 13) & 0xff);
    return (c) => { c.setfp(rd, v, dbl); c.pc = next; };
  }
  if ((w >>> 13) & 1) {
    // fcmp
    const zero = (w >>> 3) & 1;
    return (c) => {
      const a = c.fp(rn, dbl), b = zero ? 0 : c.fp(rm, dbl);
      if (Number.isNaN(a) || Number.isNaN(b)) c.setNZCV(0b0011);
      else if (a === b) c.setNZCV(0b0110);
      else if (a < b) c.setNZCV(0b1000);
      else c.setNZCV(0b0010);
      c.pc = next;
    };
  }
  if ((w >>> 14) & 1) {
    const opcode = (w >>> 15) & 63;
    return (c) => {
      const a = c.fp(rn, dbl);
      switch (opcode) {
        case 0: c.vlo[rd] = dbl ? c.vlo[rn] : c.vlo[rn] & M32; c.vhi[rd] = 0n; break;
        case 1: c.setfp(rd, Math.abs(a), dbl); break;
        case 2: c.setfp(rd, -a, dbl); break;
        case 3: c.setfp(rd, Math.sqrt(a), dbl); break;
        case 4: case 5: c.setfp(rd, a, opcode === 5); break;   // fcvt to single / double
        case 8: c.setfp(rd, roundEven(a), dbl); break;
        case 9: c.setfp(rd, Math.ceil(a), dbl); break;
        case 10: c.setfp(rd, Math.floor(a), dbl); break;
        case 11: c.setfp(rd, Math.trunc(a), dbl); break;
        case 12: c.setfp(rd, Math.sign(a) * Math.round(Math.abs(a)), dbl); break;
        default: throw new EmuError('unsupported fp op', pc);
      }
      c.pc = next;
    };
  }
  // conversions between fp and integer registers
  const rmode = (w >>> 19) & 3, opcode = (w >>> 16) & 7;
  const ibits = sf ? 64 : 32;
  return (c) => {
    if (opcode === 2 || opcode === 3) {
      let iv = c.r(rn) & (sf ? M64 : M32);
      const v = opcode === 2 ? Number(sx(iv, ibits)) : Number(iv);
      void iv;
      c.setfp(rd, v, dbl);
    } else if (opcode === 7) {
      // fmov gpr -> fp
      c.vlo[rd] = c.r(rn) & (sf ? M64 : M32);
      c.vhi[rd] = 0n;
    } else if (opcode === 6) {
      c.set(rd, sf ? c.vlo[rn] : c.vlo[rn] & M32);
    } else {
      const a = c.fp(rn, dbl);
      let r: number;
      if (opcode === 4 || opcode === 5) r = Math.sign(a) * Math.round(Math.abs(a));
      else if (rmode === 0) r = roundEven(a);
      else if (rmode === 1) r = Math.ceil(a);
      else if (rmode === 2) r = Math.floor(a);
      else r = Math.trunc(a);
      c.set(rd, fpToInt(r, ibits, (opcode & 1) === 1));
    }
    c.pc = next;
  };
}

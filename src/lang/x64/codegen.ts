// HLA64 → x86-64 assembly for Windows (Win64 ABI, LLVM Intel syntax, COFF).
//
// Conventions:
//  * r10, r11 are compiler scratch registers; xmm4, xmm5 are FP scratch.
//  * Arguments: rcx, rdx, r8, r9 / xmm0..xmm3 (positional), the rest on the stack after
//    the 32-byte shadow space. Result in rax / xmm0.
//  * Functions address their frame from rsp (no frame pointer); the outgoing-argument
//    area is allocated once in the prologue. Unwind info is emitted with .seh_* directives.
//  * Non-volatile registers (rbx, rbp, rsi, rdi, r12-r15, xmm6-xmm15) the body touches
//    are saved automatically. `let i = 0` without a register picks one of them.
//  * extern functions are called directly (`call printf`); the linker turns that into a
//    jmp [__imp_printf] thunk for DLL functions or a direct call for static C objects.
import { type Token } from '../lexer.ts';
import { parse } from '../parser.ts';
import { memSize, type BinOp, type Expr, type Item, type MemType, type Program, type Stmt } from '../ast.ts';
import { CodeGenBase, alignUp, log2, asmString, fmtData, endsWithJump, type CompileResult, type Operand, type Sym, type FnState } from '../frontend.ts';
import { xreg, xview, type XReg } from '../../asm/x64/regs.ts';

export type { CompileResult } from '../frontend.ts';

const BUILTINS = new Set([
  'syscall', 'sext8', 'sext16', 'sext32', 'sext', 'zext8', 'zext16', 'zext32', 'abs', 'min', 'max', 'umin', 'umax',
  'clz', 'rbit', 'rev', 'float', 'int', 'sqrt', 'fabs', 'sizeof', 'len', 'offsetof',
]);

const ARG_GPR = ['rcx', 'rdx', 'r8', 'r9'];
const NONVOL = [3, 6, 7, 12, 13, 14, 15, 5];          // rbx, rsi, rdi, r12-r15, rbp (auto pool order)
const NAMES64 = ['rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'];
const INV: Record<string, string> = { e: 'ne', ne: 'e', l: 'ge', ge: 'l', le: 'g', g: 'le', b: 'ae', ae: 'b', be: 'a', a: 'be', s: 'ns', ns: 's', p: 'np', np: 'p' };
const PTR: Record<number, string> = { 1: 'byte', 2: 'word', 4: 'dword', 8: 'qword' };

/** Is `text` a register usable in HLA64 code on this target (64/32-bit GPR or xmm)? */
export function x64IsReg(text: string): boolean {
  const r = xreg(text);
  return !!r && (r.xmm || r.size === 8 || r.size === 4);
}

export interface X64CompileOptions {
  /** add the hla_start entry stub (programs); libraries leave it out */
  entry?: boolean;
}

export function compileX64(src: string, opts: X64CompileOptions = {}): CompileResult {
  const prog = parse(src, { isReg: x64IsReg });
  return new X64Gen(src, prog, opts.entry ?? true).run();
}

export function compileLibraryX64(src: string, name: string): CompileResult & { header: string } {
  const prog = parse(src, { isReg: x64IsReg });
  const cg = new X64Gen(src, prog, false);
  const r = cg.run();
  return { ...r, header: cg.header(name) };
}

const R = (r: string) => xreg(r)!;
const is64 = (r: string) => R(r).size === 8 || R(r).xmm;
const v64 = (r: string) => xview(R(r), 8).name;
const v32 = (r: string) => xview(R(r), 4).name;
const v8 = (r: string) => xview(R(r), 1).name;
const vSize = (r: string, bytes: 1 | 2 | 4 | 8) => xview(R(r), bytes).name;
const view = (r: string, bits: 32 | 64) => (R(r).xmm ? r : bits === 64 ? v64(r) : v32(r));
const sameReg = (a: string, b: string) => { const x = xreg(a), y = xreg(b); return !!x && !!y && x.xmm === y.xmm && x.n === y.n; };
const fitsI32 = (v: bigint) => v >= -(1n << 31n) && v < 1n << 31n;

interface X64Fn extends FnState {
  maxStackArgs: number;     // outgoing stack arguments beyond the 4 register ones
  stgTop: number;           // staging slots in use (bytes)
  stgMax: number;
  pushDepth: number;
  pushMax: number;
  stackParams: { reg: string; idx: number }[];
  xmmAvoid: Set<number>;    // xmm registers named in the function or by global aliases
}

class X64Gen extends CodeGenBase {
  readonly localPrefix = '.L';
  readonly builtins = BUILTINS;
  entryStub: boolean;
  declare fn: X64Fn | null;

  constructor(src: string, prog: Program, entry: boolean) {
    super(src, prog, {});
    this.entryStub = entry;
  }

  // ======================================================================
  // target hooks
  // ======================================================================
  sym(name: string): string { return name; }
  canonReg(text: string): string | null { return x64IsReg(text) ? R(text).name : null; }
  regNum(reg: string): number { return R(reg).n; }
  isFp(reg: string): boolean { return R(reg).xmm; }
  regBytes(reg: string): number { const r = R(reg); return r.xmm ? 8 : r.size; }
  cTypeOfReg(r: string): string { const x = xreg(r); return !x ? 'int64_t' : x.xmm ? 'double' : x.size === 4 ? 'int32_t' : 'int64_t'; }
  autoPool(): number[] { return NONVOL; }
  autoRegName(n: number, bits: 32 | 64): string { return bits === 64 ? NAMES64[n] : v32(NAMES64[n]); }
  zerofill(label: string, size: number, p2: number): string[] { return [`.p2align ${p2}`, `${label}:`, `    .zero ${size}`]; }
  jump(label: string): void { this.emit(`jmp ${label}`); }
  resetTemps(): void { this.temps.clear(); this.ftemps.clear(); }

  finish(): string {
    const out: string[] = ['// Generated by HLA64 (TypeScript) — x86-64 / Windows', '.intel_syntax noprefix', '.text'];
    if (this.entryStub && this.globals.get('main')?.k === 'fn') {
      out.push('',
        '// process entry point: run main, then exit through the C runtime (flushes stdio)',
        '.globl hla_start', '.seh_proc hla_start', 'hla_start:',
        '    sub rsp, 40', '    .seh_stackalloc 40', '    .seh_endprologue',
        '    call main', '    mov ecx, eax', '    call qword ptr [rip + __imp_exit]', '    int3', '.seh_endproc');
    }
    out.push(...this.text);
    const ro = [...this.cstrings, ...this.rodataLines, ...this.literal8, ...this.constPtrLines];
    if (ro.length) out.push('', '.section .rdata,"dr"', ...ro);
    if (this.dataLines.length) out.push('', '.data', ...this.dataLines);
    if (this.bss.length) out.push('', '.bss', ...this.bss);
    return out.join('\n') + '\n';
  }

  headerApi(libName: string): { pre: string[]; api: string } {
    const m = libName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    return {
      pre: [
        `// Windows: #define ${m}_DLL before including this header when linking with ${libName}.dll`,
        `// (through the import library ${libName}.lib); leave it undefined for the static library.`,
        `#if defined(${m}_DLL)`, `#define ${m}_API __declspec(dllimport)`, '#else', `#define ${m}_API`, '#endif', '',
      ],
      api: `${m}_API `,
    };
  }

  // ======================================================================
  // frame slots (resolved after the body is generated)
  // ======================================================================
  /** reserve `bytes` of staging space (released with the returned function) */
  stage(bytes: number): { at: (k: number) => string; release: () => void } {
    const f = this.fn!;
    const base = f.stgTop;
    f.stgTop += alignUp(bytes, 8);
    f.stgMax = Math.max(f.stgMax, f.stgTop);
    return { at: (k: number) => `[rsp + %STG%+${base + k}]`, release: () => { f.stgTop = base; } };
  }

  declareLocal(s: Extract<Stmt, { k: 'local' }>): void {
    const ty = this.varType(s.ty);
    const size = ty.elemSize * (ty.count ?? 1);
    const al = Math.min(16, ty.struct ? ty.struct.align : ty.elemSize);
    const f = this.fn!;
    const off = alignUp(f.localsSize, al);
    f.localsSize = off + size;
    this.scopes[this.scopes.length - 1].set(s.name, { k: 'local', off, ty, size });
    this.emit(`// local ${s.name}: [rsp + locals+${off}], ${size} bytes`);
  }

  localRef(off: number): string { return `%LOC%+${off}`; }

  // ======================================================================
  // functions
  // ======================================================================
  genFunction(it: Extract<Item, { k: 'fn' }>): void {
    const fnSrc = this.src.slice(it.t.start, it.end.end);
    const avoid = new Set<number>();
    for (const m of fnSrc.matchAll(/\b(rbx|ebx|rbp|ebp|rsi|esi|rdi|edi|r1[2-5]d?)\b/gi)) avoid.add(R(m[1]).n);
    for (const s of this.globals.values()) if (s.k === 'alias' && !this.isFp(s.reg)) avoid.add(this.regNum(s.reg));
    const xmmAvoid = new Set<number>();
    for (const m of fnSrc.matchAll(/\bxmm(\d+)\b/gi)) xmmAvoid.add(Number(m[1]));
    for (const s of this.globals.values()) if (s.k === 'alias' && this.isFp(s.reg)) xmmAvoid.add(this.regNum(s.reg));
    const isMain = it.name === 'main';
    this.fn = {
      name: it.name, label: it.name, retLabel: `.L${it.name}.ret`, lines: [], localsSize: 0,
      autoInUse: new Set(), autoAvoid: avoid, loops: [], labels: new Map(), naked: it.naked, isMain,
      maxStackArgs: 0, stgTop: 0, stgMax: 0, pushDepth: 0, pushMax: 0, stackParams: [], xmmAvoid,
    };
    this.labelN = 0;
    this.collectLabels(it.body);
    this.pushScope();
    // parameters (positional Win64 assignment)
    const moves: string[] = [];
    it.params.forEach((p, i) => {
      const fp = p.ty === 'f32' || p.ty === 'f64' || (p.reg !== null && p.reg !== 'auto' && this.isFp(p.reg));
      if (i >= 4) {
        // stack parameter: copy it into a register at entry
        const reg = p.reg && p.reg !== 'auto' ? p.reg : null;
        if (fp) {
          if (!reg) this.err('floating point parameters after the 4th need an explicit xmm register', p.t);
          this.scopes[0].set(p.name, { k: 'alias', reg: reg!, unsigned: false });
          moves.push(`    movsd ${reg}, qword ptr [rsp + %IN%+${8 * i}]`);
          return;
        }
        const target = this.defineAlias({ name: p.name, reg, unsigned: p.unsigned, t: p.t });
        moves.push(`    mov ${v64(target)}, qword ptr [rsp + %IN%+${8 * i}]`);
        if (p.ty && memSize(p.ty) < 8) moves.push(this.extendLine(v64(target), p.ty));
        return;
      }
      const abi = fp ? `xmm${i}` : ARG_GPR[i];
      if (p.ty && !fp && memSize(p.ty) < 8) moves.push(this.extendLine(abi, p.ty));
      if (p.ty === 'f32') moves.push(`    cvtss2sd ${abi}, ${abi}`);
      if (p.reg === null) {
        this.scopes[0].set(p.name, { k: 'alias', reg: abi, unsigned: p.unsigned });
      } else {
        const reg = p.reg === 'auto' ? null : p.reg;
        if (fp && reg === null) this.err('auto is not available for floating point parameters; name an xmm register', p.t);
        const target = this.defineAlias({ name: p.name, reg, unsigned: p.unsigned, t: p.t });
        if (!sameReg(target, abi)) moves.push(fp ? `    movaps ${target}, ${abi}` : `    mov ${view(abi, is64(target) ? 64 : 32)}, ${target}`.replace(/mov (\S+), (\S+)/, 'mov $2, $1'));
      }
    });
    const bodyStart = this.fn.lines.length;
    this.genBlock(it.body, false);
    const last = it.body[it.body.length - 1];
    if (isMain && !(last && last.k === 'return') && !it.naked) this.emit('mov eax, 0');
    const body = this.fn.lines.slice(bodyStart).concat();
    this.popScope();
    const f = this.fn;

    const out: string[] = [''];
    if (it.exported || isMain) out.push(`.globl ${it.name}`);
    if (it.naked) {
      out.push('.p2align 4', `${it.name}:`, ...moves, ...peephole(body).map(fix({ STG: 0, LOC: 0, IN: 8, PSH: 0 })));
      this.text.push(...out);
      this.fn = null;
      this.scopes = [];
      return;
    }
    // non-volatile registers touched by the body
    const all = [...moves, ...body].join('\n');
    const usedGp = new Set<number>(), usedX = new Set<number>();
    for (const m of all.matchAll(/\b(rbx|ebx|bx|bl|rbp|ebp|bp|bpl|rsi|esi|si|sil|rdi|edi|di|dil|r1[2-5][dwb]?)\b/g)) usedGp.add(R(m[1]).n);
    for (const m of all.matchAll(/\bxmm([6-9]|1[0-5])\b/g)) usedX.add(Number(m[1]));
    if (!isMain) for (const s of this.globals.values()) if (s.k === 'alias') (this.isFp(s.reg) ? usedX : usedGp).delete(this.regNum(s.reg));
    const pushes = [...usedGp].sort((a, b) => a - b).map((n) => NAMES64[n]);
    const xmms = [...usedX].sort((a, b) => a - b);
    // frame: [shadow 32][stack args][staging][push slots][locals][xmm saves]
    const OUT = 32 + 8 * f.maxStackArgs;
    const STG = OUT;
    const PSH = STG + f.stgMax;
    const LOC = PSH + 8 * f.pushMax;
    const XMM = alignUp(LOC + f.localsSize, 16);
    let frame = XMM + 16 * xmms.length;
    while ((8 + 8 * pushes.length + frame) % 16) frame += 8;
    const IN = frame + 8 * pushes.length + 8;

    out.push(`.seh_proc ${it.name}`, '.p2align 4', `${it.name}:`);
    for (const r of pushes) out.push(`    push ${r}`, `    .seh_pushreg ${r}`);
    if (frame >= 4096) {
      // Windows commits the stack one guard page at a time: touch every page of a large frame
      // in order before moving rsp (what __chkstk does), using the volatile r10/r11
      out.push(`    lea r10, [rsp - ${frame}]`, '    mov r11, rsp', `.L${it.name}.probe:`, '    sub r11, 4096',
        '    test qword ptr [r11], r11', '    cmp r11, r10', `    ja .L${it.name}.probe`);
    }
    if (frame) out.push(`    sub rsp, ${frame}`, `    .seh_stackalloc ${frame}`);
    xmms.forEach((x, i) => out.push(`    movaps xmmword ptr [rsp + ${XMM + 16 * i}], xmm${x}`, `    .seh_savexmm xmm${x}, ${XMM + 16 * i}`));
    out.push('    .seh_endprologue');
    const fx = fix({ STG, LOC, IN, PSH });
    out.push(...moves.map(fx));
    out.push(...peephole([...body, `${f.retLabel}:`]).map(fx));
    xmms.forEach((x, i) => out.push(`    movaps xmm${x}, xmmword ptr [rsp + ${XMM + 16 * i}]`));
    if (frame) out.push(`    add rsp, ${frame}`);
    for (const r of [...pushes].reverse()) out.push(`    pop ${r}`);
    out.push('    ret', '.seh_endproc');
    const retUsed = out.some((l) => l.includes(f.retLabel) && !l.endsWith(':'));
    this.text.push(...out.filter((l) => retUsed || l !== `${f.retLabel}:`));
    this.fn = null;
    this.scopes = [];
  }

  extendLine(reg: string, ty: MemType): string {
    switch (ty) {
      case 'i8': return `    movsx ${v64(reg)}, ${v8(reg)}`;
      case 'u8': return `    movzx ${v32(reg)}, ${v8(reg)}`;
      case 'i16': return `    movsx ${v64(reg)}, ${vSize(reg, 2)}`;
      case 'u16': return `    movzx ${v32(reg)}, ${vSize(reg, 2)}`;
      case 'i32': return `    movsxd ${v64(reg)}, ${v32(reg)}`;
      default: return `    mov ${v32(reg)}, ${v32(reg)}`;
    }
  }

  genReturn(s: Extract<Stmt, { k: 'return' }>): void {
    if (s.e) {
      if (this.isFloat(s.e)) this.genFExpr(s.e, 'xmm0');
      else if (s.e.k === 'call' && !this.isBuiltinCall(s.e)) this.genCall(s.e);
      else this.genExpr(s.e, 'rax');
    }
    if (this.fn!.naked) this.emit('ret');
    else this.jump(this.fn!.retLabel);
  }

  genPushPop(s: Extract<Stmt, { k: 'push' | 'pop' }>): void {
    // the frame is addressed from rsp, so `push`/`pop` use dedicated frame slots
    const f = this.fn!;
    const regs = s.regs.map((e) => {
      const op = this.operand(e);
      if (!op || op.k !== 'reg') this.err(`${s.k} expects registers`, s.t);
      return op.r;
    });
    if (s.k === 'push') {
      for (const r of regs) {
        const slot = `[rsp + %PSH%+${8 * f.pushDepth++}]`;
        this.emit(this.isFp(r) ? `movsd qword ptr ${slot}, ${r}` : `mov qword ptr ${slot}, ${v64(r)}`);
      }
      f.pushMax = Math.max(f.pushMax, f.pushDepth);
    } else {
      for (const r of [...regs].reverse()) {
        if (f.pushDepth === 0) this.err('pop without a matching push', s.t);
        const slot = `[rsp + %PSH%+${8 * --f.pushDepth}]`;
        this.emit(this.isFp(r) ? `movsd ${r}, qword ptr ${slot}` : `mov ${v64(r)}, qword ptr ${slot}`);
      }
    }
  }

  // ======================================================================
  // scratch registers
  // ======================================================================
  withTemps<T>(f: () => T): T {
    const saved = new Set(this.temps), savedF = new Set(this.ftemps);
    try { return f(); } finally { this.temps = saved; this.ftemps = savedF; }
  }

  allocTemp(bits: 32 | 64, t: Token): string {
    const extra = this.fn && !this.fn.naked ? NONVOL.filter((n) => !this.fn!.autoInUse.has(n) && !this.fn!.autoAvoid.has(n)).reverse() : [];
    for (const n of [10, 11, ...extra]) {
      if (!this.temps.has(n)) { this.temps.add(n); return bits === 64 ? NAMES64[n] : v32(NAMES64[n]); }
    }
    return this.err('expression too complex: out of scratch registers; split it into several statements', t);
  }

  freeTemp(r: string): void {
    const x = xreg(r);
    if (x && !x.xmm && this.temps.has(x.n) && (x.n === 10 || x.n === 11 || NONVOL.includes(x.n))) this.temps.delete(x.n);
  }

  isTemp(r: string): boolean {
    const x = xreg(r);
    if (!x || x.xmm) return false;
    return x.n === 10 || x.n === 11 || (NONVOL.includes(x.n) && this.temps.has(x.n) && !this.fn?.autoInUse.has(x.n));
  }

  allocFTemp(t: Token): string {
    // xmm5, xmm4, then non-volatile xmm registers the function does not name (saved by the prologue)
    const extra = this.fn && !this.fn.naked ? [15, 14, 13, 12, 11, 10, 9, 8, 7, 6].filter((n) => !this.fn!.xmmAvoid.has(n)) : [];
    for (const n of [5, 4, ...extra]) if (!this.ftemps.has(n)) { this.ftemps.add(n); return `xmm${n}`; }
    return this.err('floating point expression too complex: split it', t);
  }

  regOrTemp(e: Expr, bits: 32 | 64, t: Token): string {
    const op = this.operand(e);
    if (op?.k === 'reg') return view(op.r, bits);
    return this.toReg(e, this.allocTemp(bits, t));
  }

  /** register holding e (evaluated into pref when it is not a register already) */
  toReg(e: Expr, pref: string): string {
    const op = this.operand(e);
    const bits = is64(pref) ? 64 : 32;
    if (op?.k === 'reg') return view(op.r, bits);
    this.genExpr(e, pref);
    return pref;
  }

  movImm(T: string, v: bigint): void {
    const bits = is64(T) ? 64 : 32;
    const u = BigInt.asUintN(bits, v);
    if (bits === 32) { this.emit(`mov ${T}, ${u}`); return; }
    const s = BigInt.asIntN(64, u);
    if (u <= 0xffffffffn) this.emit(`mov ${v32(T)}, ${u}`);          // zero-extends, shortest
    else if (fitsI32(s)) this.emit(`mov ${T}, ${s}`);
    else this.emit(`movabs ${T}, ${s}`);
  }

  isBuiltinCall(e: Extract<Expr, { k: 'call' }>): boolean {
    return BUILTINS.has(e.name) && !this.isUserFn(e.name);
  }

  // ======================================================================
  // integer expressions
  // ======================================================================
  genExpr(e: Expr, T: string): void {
    if (this.isFp(T)) { this.genFExpr(e, T); return; }
    const bits = is64(T) ? 64 : 32;
    const op = this.operand(e);
    if (op) {
      if (op.k === 'imm') this.movImm(T, op.v);
      else {
        if (this.isFp(op.r)) this.err(`'${op.r}' is a floating point register; use int(...) to convert`, e.t);
        const r = view(op.r, bits);
        if (!sameReg(r, T)) this.emit(`mov ${T}, ${r}`);
      }
      return;
    }
    switch (e.k) {
      case 'float': return this.err('floating point value in an integer context; use int(...)', e.t);
      case 'str': this.emit(`lea ${v64(T)}, [rip + ${this.cstring(e.bytes)}]`); return;
      case 'name': {
        const s = this.lookup(e.name);
        if (!s) this.err(`unknown name '${e.name}'`, e.t);
        if (s.k === 'data') {
          if (s.ty.count !== null || s.ty.struct) { this.emit(`lea ${v64(T)}, [rip + ${s.label}]`); return; }
          this.loadMem(T, s.ty.elem!, `[rip + ${s.label}]`, e.t);
          return;
        }
        if (s.k === 'local') {
          if (s.ty.count !== null || s.ty.struct) { this.emit(`lea ${v64(T)}, [rsp + ${this.localRef(s.off)}]`); return; }
          this.loadMem(T, s.ty.elem!, `[rsp + ${this.localRef(s.off)}]`, e.t);
          return;
        }
        if (s.k === 'fn') { this.emit(`lea ${v64(T)}, [rip + ${s.label}]`); return; }
        if (s.k === 'extern') { this.emit(`lea ${v64(T)}, [rip + ${s.label}]`); return; }
        return this.err(`'${e.name}' cannot be used as a value`, e.t);
      }
      case 'addr': this.genAddrOf(e, T); return;
      case 'index': case 'mem': {
        const m = this.memAccess(e, T);
        if (m.ty === 'f32' || m.ty === 'f64') this.err('floating point memory in an integer context; use int(...)', e.t);
        this.loadMem(T, m.ty, m.mode, e.t);
        m.release();
        return;
      }
      case 'un': {
        if (e.op === '!') { this.genBoolValue(e, T); return; }
        this.genExpr(e.e, T);
        this.emit(`${e.op === '-' ? 'neg' : 'not'} ${T}`);
        return;
      }
      case 'bin':
        if (['==', '!=', '<', '<=', '>', '>=', '&&', '||'].includes(e.op)) { this.genBoolValue(e, T); return; }
        this.genBinary(e.op, e.l, e.r, T, e.t);
        return;
      case 'tern': this.genTernary(e, T); return;
      case 'call': {
        if (this.isBuiltinCall(e)) { this.genBuiltin(e, T); return; }
        this.callGuarded(e, T, () => this.genCall(e));
        if (!sameReg(T, 'rax')) this.emit(`mov ${T}, ${view('rax', bits)}`);
        return;
      }
    }
    this.err('unsupported expression', e.t);
  }

  /** Calls clobber r10/r11/xmm4/xmm5: refuse when an outer scratch value is live. */
  callGuarded(e: Expr, T: string | null, f: () => void): void {
    const live = new Set(this.temps), liveF = new Set(this.ftemps);
    if (T) { const x = R(T); if (x.xmm) liveF.delete(x.n); else live.delete(x.n); }
    // values parked in callee-saved spill registers survive calls
    for (const n of [...live]) if (NONVOL.includes(n)) live.delete(n);
    for (const n of [...liveF]) if (n >= 6) liveF.delete(n);
    if (live.size || liveF.size) this.err('a function call cannot be nested inside a complex expression; assign its result to a register first', e.t);
    const saved = this.temps, savedF = this.ftemps;
    this.temps = new Set([...saved].filter((n) => NONVOL.includes(n)));
    this.ftemps = new Set([...savedF].filter((n) => n >= 6));
    try { f(); } finally { this.temps = saved; this.ftemps = savedF; }
  }

  loadMem(T: string, ty: MemType, mode: string, t: Token): void {
    if (this.isFp(T)) {
      if (ty === 'f64') this.emit(`movsd ${T}, qword ptr ${mode}`);
      else if (ty === 'f32') this.emit(`cvtss2sd ${T}, dword ptr ${mode}`);
      else this.err('integer memory loaded into a floating point register; use float(...)', t);
      return;
    }
    const bits = is64(T) ? 64 : 32;
    switch (ty) {
      case 'u8': this.emit(`movzx ${v32(T)}, byte ptr ${mode}`); break;
      case 'i8': this.emit(`movsx ${T}, byte ptr ${mode}`); break;
      case 'u16': this.emit(`movzx ${v32(T)}, word ptr ${mode}`); break;
      case 'i16': this.emit(`movsx ${T}, word ptr ${mode}`); break;
      case 'u32': this.emit(`mov ${v32(T)}, dword ptr ${mode}`); break;
      case 'i32': this.emit(bits === 64 ? `movsxd ${T}, dword ptr ${mode}` : `mov ${T}, dword ptr ${mode}`); break;
      default: this.emit(`mov ${T}, ${bits === 64 ? 'qword' : 'dword'} ptr ${mode}`); break;
    }
  }

  storeMem(src: string, ty: MemType, mode: string): void {
    if (this.isFp(src)) {
      if (ty === 'f32') { this.emit(`cvtsd2ss xmm5, ${src}`); this.emit(`movss dword ptr ${mode}, xmm5`); }
      else this.emit(`movsd qword ptr ${mode}, ${src}`);
      return;
    }
    const size = memSize(ty) as 1 | 2 | 4 | 8;
    this.emit(`mov ${PTR[size]} ptr ${mode}, ${vSize(src, size)}`);
  }

  storeImm(v: bigint, ty: MemType, mode: string, t: Token): void {
    const size = memSize(ty) as 1 | 2 | 4 | 8;
    const u = BigInt.asIntN(size * 8, v);
    if (size < 8 || fitsI32(u)) { this.emit(`mov ${PTR[size]} ptr ${mode}, ${size === 8 ? u : BigInt.asUintN(size * 8, v)}`); return; }
    const tmp = this.allocTemp(64, t);
    this.movImm(tmp, v);
    this.emit(`mov qword ptr ${mode}, ${tmp}`);
    this.freeTemp(tmp);
  }

  // ---------------------------------------------------------------- binary operators
  genBinary(op: BinOp, l: Expr, r: Expr, T: string, t: Token): void {
    const bits = is64(T) ? 64 : 32;
    const unsigned = this.isUnsigned(l) || this.isUnsigned(r);
    const lc = this.constEval(l), rc = this.constEval(r);
    if (lc !== null && rc !== null) { this.movImm(T, this.constEval({ k: 'bin', op, l, r, t } as Expr)!); return; }
    const commutative = ['+', '*', '&', '|', '^'].includes(op);
    if (commutative && lc !== null) [l, r] = [r, l];
    if (this.hasCall(l) && !this.hasCall(r)) this.checkClobber([l, r]);
    if (this.hasCall(r) && !(commutative && !this.hasCall(l))) {
      this.err('a function call may only be the left-most operand of an expression; assign it to a register first', r.t);
    }
    if (commutative && this.hasCall(r)) [l, r] = [r, l];
    if (op === '/' || op === '%') { this.genDivide(op, l, r, T, unsigned, t); return; }
    if (op === '<<' || op === '>>' || op === '>>>') { this.genShift(op, l, r, T, unsigned, t); return; }

    const mn = { '+': 'add', '-': 'sub', '*': 'imul', '&': 'and', '|': 'or', '^': 'xor' }[op as '+'];
    if (!mn) this.err(`operator '${op}' is not arithmetic`, t);
    const rv = this.constEval(r);
    const lop = this.operand(l), rop = this.operand(r);
    // multiplication by a power of two -> shift
    if (op === '*' && rv !== null && rv > 0n && (rv & (rv - 1n)) === 0n) {
      this.genExpr(l, T);
      if (rv > 1n) this.emit(`shl ${T}, ${log2(rv)}`);
      return;
    }
    // three-operand forms
    if (rv !== null && fitsI32(rv) && lop?.k === 'reg' && !sameReg(lop.r, T)) {
      const lr = view(lop.r, bits);
      if (op === '*') { this.emit(`imul ${T}, ${lr}, ${rv}`); return; }
      if (op === '+' || op === '-') { const d = op === '+' ? rv : -rv; this.emit(`lea ${T}, [${v64(lr)} ${d < 0n ? '-' : '+'} ${d < 0n ? -d : d}]`); return; }
    }
    if (op === '+' && lop?.k === 'reg' && rop?.k === 'reg' && !sameReg(lop.r, T) && !sameReg(rop.r, T)) {
      this.emit(`lea ${T}, [${v64(lop.r)} + ${v64(rop.r)}]`);
      return;
    }
    // T = l op r with r an immediate that fits in 32 bits
    if (rv !== null && fitsI32(rv)) {
      this.genExpr(l, T);
      if (op === '*') this.emit(`imul ${T}, ${T}, ${rv}`);
      else if (!(rv === 0n && (op === '+' || op === '-' || op === '|' || op === '^'))) this.emit(`${mn} ${T}, ${rv}`);
      return;
    }
    // r is a register
    if (rop?.k === 'reg') {
      const rr = view(rop.r, bits);
      if (sameReg(rr, T)) {
        if (commutative) { this.binWithReg(mn, T, l, bits, t); return; }
        // T = l - T: evaluate l elsewhere
        const tmp = this.allocTemp(bits, t);
        this.genExpr(l, tmp);
        this.emit(`${mn} ${tmp}, ${T}`);
        this.emit(`mov ${T}, ${tmp}`);
        this.freeTemp(tmp);
        return;
      }
      this.genExpr(l, T);
      this.emit(`${mn} ${T}, ${rr}`);
      return;
    }
    // r is complex (or a 64-bit immediate)
    if (!this.readsReg(r, T) || this.hasCall(l)) {
      this.genExpr(l, T);
      const tmp = this.allocTemp(bits, t);
      const rr = this.toReg(r, tmp);
      this.emit(`${mn} ${T}, ${rr}`);
      this.freeTemp(tmp);
      return;
    }
    const tmp = this.allocTemp(bits, t);
    const rr = this.toReg(r, tmp);
    this.genExpr(l, T);
    this.emit(`${mn} ${T}, ${rr}`);
    this.freeTemp(tmp);
  }

  /** T = T op l (commutative op, r was T) */
  binWithReg(mn: string, T: string, l: Expr, bits: 32 | 64, t: Token): void {
    const lop = this.operand(l);
    if (lop?.k === 'reg') { this.emit(`${mn} ${T}, ${view(lop.r, bits)}`); return; }
    const lv = this.constEval(l);
    if (lv !== null && fitsI32(lv)) { this.emit(mn === 'imul' ? `imul ${T}, ${T}, ${lv}` : `${mn} ${T}, ${lv}`); return; }
    const tmp = this.allocTemp(bits, t);
    this.genExpr(l, tmp);
    this.emit(`${mn} ${T}, ${tmp}`);
    this.freeTemp(tmp);
  }

  /** division and remainder through rdx:rax */
  genDivide(op: BinOp, l: Expr, r: Expr, T: string, unsigned: boolean, t: Token): void {
    const bits = is64(T) ? 64 : 32;
    const rv = this.constEval(r);
    // unsigned power-of-two shortcuts
    if (unsigned && rv !== null && rv > 0n && (rv & (rv - 1n)) === 0n) {
      this.genExpr(l, T);
      if (op === '/') { if (rv > 1n) this.emit(`shr ${T}, ${log2(rv)}`); }
      else if (fitsI32(rv - 1n)) this.emit(`and ${T}, ${rv - 1n}`);
      else { const tmp = this.allocTemp(bits, t); this.movImm(tmp, rv - 1n); this.emit(`and ${T}, ${tmp}`); this.freeTemp(tmp); }
      return;
    }
    if (rv === 0n) this.err('division by zero', t);
    const result = op === '/' ? 'rax' : 'rdx';
    const saveRax = !sameReg(T, 'rax'), saveRdx = !sameReg(T, 'rdx');
    const st = this.stage(16);
    if (saveRax) this.emit(`mov qword ptr ${st.at(0)}, rax`);
    if (saveRdx) this.emit(`mov qword ptr ${st.at(8)}, rdx`);
    const d = this.allocTemp(bits, t);
    this.genExpr(r, d);
    this.genExpr(l, view('rax', bits));
    if (unsigned) this.emit('xor edx, edx');
    else this.emit(bits === 64 ? 'cqo' : 'cdq');
    this.emit(`${unsigned ? 'div' : 'idiv'} ${d}`);
    this.freeTemp(d);
    if (!sameReg(T, result)) this.emit(`mov ${T}, ${view(result, bits)}`);
    if (saveRax) this.emit(`mov rax, qword ptr ${st.at(0)}`);
    if (saveRdx) this.emit(`mov rdx, qword ptr ${st.at(8)}`);
    st.release();
  }

  genShift(op: BinOp, l: Expr, r: Expr, T: string, unsigned: boolean, t: Token): void {
    const bits = is64(T) ? 64 : 32;
    const mn = op === '<<' ? 'shl' : op === '>>>' || unsigned ? 'shr' : 'sar';
    const rv = this.constEval(r);
    if (rv !== null) {
      this.genExpr(l, T);
      const n = Number(BigInt.asUintN(64, rv) % BigInt(bits));
      if (n) this.emit(`${mn} ${T}, ${n}`);
      return;
    }
    // the count must be in cl
    const tCx = sameReg(T, 'rcx');
    const amount = this.allocTemp(64, t);
    this.genExpr(r, amount);
    const V = tCx ? this.allocTemp(bits, t) : T;
    this.genExpr(l, V);
    const st = tCx ? null : this.stage(8);
    if (st) this.emit(`mov qword ptr ${st.at(0)}, rcx`);
    this.emit(`mov rcx, ${amount}`);
    this.emit(`${mn} ${V}, cl`);
    if (st) { this.emit(`mov rcx, qword ptr ${st.at(0)}`); st.release(); }
    if (V !== T) { this.emit(`mov ${T}, ${V}`); this.freeTemp(V); }
    this.freeTemp(amount);
  }

  // ---------------------------------------------------------------- comparisons and branches
  exprWidth(e: Expr): number {
    const op = this.operand(e);
    if (op?.k === 'reg') return is64(op.r) ? 64 : 32;
    if (op?.k === 'imm') return op.v >= -0x80000000n && op.v <= 0x7fffffffn ? 0 : 64;
    switch (e.k) {
      case 'bin':
        if (['==', '!=', '<', '<=', '>', '>=', '&&', '||'].includes(e.op)) return 0;
        return Math.max(this.exprWidth(e.l), this.exprWidth(e.r));
      case 'un': return e.op === '!' ? 0 : this.exprWidth(e.e);
      case 'tern': return Math.max(this.exprWidth(e.a), this.exprWidth(e.b));
    }
    return 0;
  }

  cmpWidth(l: Expr, r: Expr): 32 | 64 {
    return Math.max(this.exprWidth(l), this.exprWidth(r)) === 32 ? 32 : 64;
  }

  /** emit a comparison; returns the condition suffix that is true when `l op r` */
  genCompare(op: BinOp, l: Expr, r: Expr, t: Token): string {
    if (this.isFloat(l) || this.isFloat(r)) return this.genFCompare(op, l, r, t);
    let o = op;
    if (this.constEval(l) !== null && this.constEval(r) === null) {
      [l, r] = [r, l];
      o = ({ '<': '>', '>': '<', '<=': '>=', '>=': '<=' } as Record<string, BinOp>)[o] ?? o;
    }
    const unsigned = this.isUnsigned(l) || this.isUnsigned(r);
    const rc = this.constEval(r);
    const lw = this.exprWidth(l), rw = this.exprWidth(r);
    if (rc === null && ((lw === 32 && rw === 64) || (lw === 64 && rw === 32))) {
      // mixed widths: widen the 32-bit side
      const narrow = lw === 32 ? l : r;
      const wide = lw === 32 ? r : l;
      const nr = this.regOrTemp(narrow, 32, t);
      const ext = this.allocTemp(64, t);
      this.emit(this.isUnsigned(narrow) ? `mov ${v32(ext)}, ${nr}` : `movsxd ${ext}, ${nr}`);
      const wr = this.regOrTemp(wide, 64, t);
      if (lw === 32) this.emit(`cmp ${ext}, ${wr}`); else this.emit(`cmp ${wr}, ${ext}`);
      return cc(o, unsigned);
    }
    const bits = this.cmpWidth(l, r);
    const lr = this.regOrTemp(l, bits, t);
    if (rc !== null) {
      const v = bits === 32 ? BigInt.asIntN(32, rc) : rc;
      if (fitsI32(v)) this.emit(`cmp ${lr}, ${v}`);
      else { const tmp = this.allocTemp(bits, t); this.movImm(tmp, v); this.emit(`cmp ${lr}, ${tmp}`); }
    } else {
      const rr = this.regOrTemp(r, bits, t);
      this.emit(`cmp ${lr}, ${rr}`);
    }
    return cc(o, unsigned);
  }

  genBranch(e: Expr, label: string, ifTrue: boolean): void {
    const c = this.constEval(e);
    if (c !== null) { if ((c !== 0n) === ifTrue) this.jump(label); return; }
    if (e.k === 'un' && e.op === '!') { this.genBranch(e.e, label, !ifTrue); return; }
    if (e.k === 'bin' && (e.op === '&&' || e.op === '||')) {
      const and = e.op === '&&';
      if (and !== ifTrue) { this.genBranch(e.l, label, ifTrue); this.genBranch(e.r, label, ifTrue); }
      else {
        const skip = this.newLabel('skip');
        this.genBranch(e.l, skip, !ifTrue);
        this.genBranch(e.r, label, ifTrue);
        this.label(skip);
      }
      return;
    }
    if (e.k === 'bin' && ['==', '!=', '<', '<=', '>', '>='].includes(e.op)) {
      const fp = this.isFloat(e.l) || this.isFloat(e.r);
      if ((e.op === '==' || e.op === '!=') && !fp) {
        let x: Expr | null = null;
        if (this.constEval(e.r) === 0n) x = e.l; else if (this.constEval(e.l) === 0n) x = e.r;
        if (x) { this.genTestBranch(x, label, (e.op === '!=') === ifTrue); return; }
      }
      const code = this.withTemps(() => this.genCompare(e.op, e.l, e.r, e.t));
      if (fp && (e.op === '==' || e.op === '!=')) {
        // unordered (NaN) sets PF: == is false, != is true
        const wantEq = (e.op === '==') === ifTrue;
        if (wantEq) { const skip = this.newLabel('nan'); this.emit(`jp ${skip}`); this.emit(`je ${label}`); this.label(skip); }
        else { this.emit(`jp ${label}`); this.emit(`jne ${label}`); }
        return;
      }
      this.emit(`j${ifTrue ? code : INV[code]} ${label}`);
      return;
    }
    if (this.isFloat(e)) this.err('floating point value used as a condition; compare it explicitly', e.t);
    this.genTestBranch(e, label, ifTrue);
  }

  /** branch when x != 0 (nonZero) or x == 0 */
  genTestBranch(x: Expr, label: string, nonZero: boolean): void {
    this.withTemps(() => {
      if (x.k === 'bin' && x.op === '&') {
        const mc = this.constEval(x.r) ?? this.constEval(x.l);
        const other = this.constEval(x.r) !== null ? x.l : x.r;
        if (mc !== null) {
          const m = BigInt.asUintN(64, mc);
          const r = this.regOrTemp(other, 64, x.t);
          if (m <= 0x7fffffffn) { this.emit(`test ${r}, ${m}`); this.emit(`j${nonZero ? 'ne' : 'e'} ${label}`); return; }
          if ((m & (m - 1n)) === 0n) { this.emit(`bt ${r}, ${log2(m)}`); this.emit(`j${nonZero ? 'c' : 'nc'} ${label}`); return; }
        }
      }
      const bits = this.cmpWidth(x, x);
      const r = this.regOrTemp(x, bits, x.t);
      this.emit(`test ${r}, ${r}`);
      this.emit(`j${nonZero ? 'ne' : 'e'} ${label}`);
    });
  }

  genBoolValue(e: Expr, T: string): void {
    this.withTemps(() => {
      if (e.k === 'bin' && ['<', '<=', '>', '>='].includes(e.op) || (e.k === 'bin' && (e.op === '==' || e.op === '!=') && !this.isFloat(e.l) && !this.isFloat(e.r))) {
        const b = e as Extract<Expr, { k: 'bin' }>;
        const code = this.genCompare(b.op, b.l, b.r, b.t);
        this.emit(`set${code} ${v8(T)}`);
        this.emit(`movzx ${v32(T)}, ${v8(T)}`);
        return;
      }
      if (e.k === 'un' && e.op === '!' && !this.isFloat(e.e)) {
        const r = this.regOrTemp(e.e, this.cmpWidth(e.e, e.e), e.t);
        this.emit(`test ${r}, ${r}`);
        this.emit(`sete ${v8(T)}`);
        this.emit(`movzx ${v32(T)}, ${v8(T)}`);
        return;
      }
      const f = this.newLabel('false'), end = this.newLabel('bool');
      this.genBranch(e, f, false);
      this.emit(`mov ${v32(T)}, 1`);
      this.jump(end);
      this.label(f);
      this.emit(`mov ${v32(T)}, 0`);
      this.label(end);
    });
  }

  genTernary(e: Extract<Expr, { k: 'tern' }>, T: string): void {
    this.withTemps(() => {
      const bits = is64(T) ? 64 : 32;
      const a = this.operand(e.a), b = this.operand(e.b);
      const simple = e.c.k === 'bin' && ['==', '!=', '<', '<=', '>', '>='].includes(e.c.op) && !this.isFloat(e.c.l) && !this.isFloat(e.c.r);
      if (simple && a && b) {
        const c = e.c as Extract<Expr, { k: 'bin' }>;
        // materialize both values first (mov does not touch flags, but the compare may read T)
        const regOf = (o: Operand) => {
          if (o.k === 'reg') return view(o.r, bits);
          const tmp = this.allocTemp(bits, e.t);
          this.movImm(tmp, o.v);
          return tmp;
        };
        const ra = regOf(a), rb = regOf(b);
        const code = this.genCompare(c.op, c.l, c.r, c.t);
        if (!sameReg(rb, T)) this.emit(`mov ${T}, ${rb}`);
        else if (sameReg(ra, T)) return;
        if (sameReg(rb, T) || !sameReg(ra, T)) this.emit(`cmov${code} ${T}, ${ra}`);
        return;
      }
      const els = this.newLabel('else'), end = this.newLabel('tend');
      this.genBranch(e.c, els, false);
      this.genInto(e.a, T);
      this.jump(end);
      this.label(els);
      this.genInto(e.b, T);
      this.label(end);
    });
  }

  // ---------------------------------------------------------------- memory
  /** Addressing mode for an index / mem expression. */
  memAccess(e: Expr, avoid: string | null): { ty: MemType; mode: string; release: () => void } {
    const used: string[] = [];
    const posts: string[] = [];
    const release = () => { for (const p of posts) this.emit(p); for (const r of used) this.freeTemp(r); };
    const tmp = () => { const r = this.allocTemp(64, e.t); used.push(r); return r; };
    if (e.k === 'index') {
      const s = this.lookup(e.name);
      if (!s || (s.k !== 'data' && s.k !== 'local')) this.err(`'${e.name}' is not an array (use u8[ptr + i] style access for pointers in registers)`, e.t);
      if (s.ty.struct || !s.ty.elem) this.err(`'${e.name}' is an array of structs; use &${e.name}[i] to get an element address`, e.t);
      const ty = s.ty.elem;
      const size = memSize(ty);
      const ic = this.constEval(e.index);
      if (ic !== null) {
        if (s.ty.count !== null && (ic < 0n || ic >= BigInt(s.ty.count))) this.warnings.push(`line ${e.t.line}: index ${ic} is out of bounds for '${e.name}'`);
        const off = Number(ic) * size;
        if (s.k === 'local') return { ty, mode: `[rsp + ${this.localRef(s.off + off)}]`, release };
        return { ty, mode: `[rip + ${s.label}${off ? (off > 0 ? ' + ' + off : ' - ' + -off) : ''}]`, release };
      }
      // index register (+ constant)
      let idxExpr = e.index;
      let extra = 0n;
      if (idxExpr.k === 'bin' && (idxExpr.op === '+' || idxExpr.op === '-') && this.operand(idxExpr.l)?.k === 'reg') {
        const c = this.constEval(idxExpr.r);
        if (c !== null) { extra = idxExpr.op === '+' ? c : -c; idxExpr = idxExpr.l; }
      }
      const iop = this.operand(idxExpr);
      let idx: string;
      if (iop?.k === 'reg' && is64(iop.r)) idx = iop.r;
      else if (iop?.k === 'reg') { idx = tmp(); this.emit(this.isUnsigned(idxExpr) ? `mov ${v32(idx)}, ${iop.r}` : `movsxd ${idx}, ${iop.r}`); }
      else { idx = tmp(); this.genExpr(idxExpr, idx); }
      const disp = Number(extra) * size;
      const scale = size === 16 ? 1 : size;
      const dispS = disp ? (disp > 0 ? ` + ${disp}` : ` - ${-disp}`) : '';
      if (s.k === 'local') return { ty, mode: `[rsp + ${scale}*${idx} + ${this.localRef(s.off + disp)}]`, release };
      const b = tmp();
      this.emit(`lea ${b}, [rip + ${s.label}]`);
      return { ty, mode: `[${b} + ${scale}*${idx}${dispS}]`, release };
    }
    if (e.k !== 'mem') return this.err('not a memory reference', e.t);
    const ty: MemType = e.ty ?? (avoid ? (this.isFp(avoid) ? 'f64' : is64(avoid) ? 'u64' : 'u32') : 'u64');
    const size = memSize(ty);
    if (e.post) {
      const op = this.operand(e.addr);
      if (op?.k !== 'reg') this.err('post-increment needs a register address: [p++]', e.t);
      posts.push(`${e.post > 0 ? 'add' : 'sub'} ${v64(op.r)}, ${size}`);
      return { ty, mode: `[${v64(op.r)}]`, release };
    }
    const parts = this.decompose(e.addr);
    if (parts) {
      const { base, index, scale, off } = parts;
      const offS = off ? (off > 0 ? ` + ${off}` : ` - ${-off}`) : '';
      if (!index) return { ty, mode: `[${base}${offS}]`, release };
      let ix = index.r;
      if (!is64(ix)) { const t2 = tmp(); this.emit(this.isUnsigned(index.e) ? `mov ${v32(t2)}, ${ix}` : `movsxd ${t2}, ${ix}`); ix = t2; }
      return { ty, mode: `[${base} + ${scale}*${ix}${offS}]`, release };
    }
    const a = tmp();
    this.genExpr(e.addr, a);
    return { ty, mode: `[${a}]`, release };
  }

  /** base + index*scale + off with 64-bit register base, scale 1/2/4/8 */
  decompose(e: Expr): { base: string; index: { r: string; e: Expr } | null; scale: number; off: number } | null {
    const terms: { e: Expr; scale: number; neg: boolean }[] = [];
    let off = 0n;
    const walk = (x: Expr, neg: boolean): boolean => {
      const c = this.constEval(x);
      if (c !== null) { off += neg ? -c : c; return true; }
      if (x.k === 'bin' && (x.op === '+' || x.op === '-')) return walk(x.l, neg) && walk(x.r, x.op === '-' ? !neg : neg);
      if (x.k === 'bin' && (x.op === '<<' || x.op === '*')) {
        const c2 = this.constEval(x.r);
        if (c2 !== null && this.operand(x.l)?.k === 'reg') { terms.push({ e: x.l, scale: x.op === '<<' ? 1 << Number(c2) : Number(c2), neg }); return true; }
        return false;
      }
      if (this.operand(x)?.k === 'reg') { terms.push({ e: x, scale: 1, neg }); return true; }
      return false;
    };
    if (!walk(e, false)) return null;
    if (terms.some((t) => t.neg) || terms.length === 0 || terms.length > 2) return null;
    if (!fitsI32(off)) return null;
    const reg = (x: Expr) => (this.operand(x) as { r: string }).r;
    const base = terms.find((t) => t.scale === 1 && is64(reg(t.e)) && !this.isFp(reg(t.e)));
    if (!base) return null;
    const other = terms.find((t) => t !== base) ?? null;
    if (other && (this.isFp(reg(other.e)) || ![1, 2, 4, 8].includes(other.scale))) return null;
    return { base: reg(base.e), index: other ? { r: reg(other.e), e: other.e } : null, scale: other ? other.scale : 1, off: Number(off) };
  }

  genAddrOf(e: Extract<Expr, { k: 'addr' }>, T: string): void {
    const x = e.e;
    const T64 = v64(T);
    if (x.k === 'name') {
      const s = this.lookup(x.name);
      if (s?.k === 'data' || s?.k === 'fn') { this.emit(`lea ${T64}, [rip + ${s.label}]`); return; }
      if (s?.k === 'extern') { this.emit(`lea ${T64}, [rip + ${s.label}]`); return; }
      if (s?.k === 'local') { this.emit(`lea ${T64}, [rsp + ${this.localRef(s.off)}]`); return; }
      this.err(`cannot take the address of '${x.name}'`, x.t);
    }
    if (x.k === 'str') { this.emit(`lea ${T64}, [rip + ${this.cstring(x.bytes)}]`); return; }
    if (x.k === 'index') {
      const s = this.lookup(x.name);
      if (!s || (s.k !== 'data' && s.k !== 'local')) this.err(`'${x.name}' is not an array`, x.t);
      const size = s.ty.elemSize;
      const base = s.k === 'local' ? `rsp + ${this.localRef(s.off)}` : `rip + ${s.label}`;
      const ic = this.constEval(x.index);
      if (ic !== null) {
        const off = Number(ic) * size;
        this.emit(s.k === 'local' ? `lea ${T64}, [rsp + ${this.localRef(s.off + off)}]` : `lea ${T64}, [${base}${off ? ' + ' + off : ''}]`);
        return;
      }
      const tmp = this.allocTemp(64, x.t);
      this.genExpr(x.index, tmp);
      if ([1, 2, 4, 8].includes(size)) {
        if (s.k === 'local') this.emit(`lea ${T64}, [rsp + ${size}*${tmp} + ${this.localRef(s.off)}]`);
        else { this.emit(`lea ${T64}, [rip + ${s.label}]`); this.emit(`lea ${T64}, [${T64} + ${size}*${tmp}]`); }
      } else {
        this.emit(`imul ${tmp}, ${tmp}, ${size}`);
        this.emit(`lea ${T64}, [${base}]`);
        this.emit(`add ${T64}, ${tmp}`);
      }
      this.freeTemp(tmp);
      return;
    }
    if (x.k === 'mem') { this.genExpr(x.addr, T64); return; }
    this.err('cannot take the address of this expression', e.t);
  }

  // ---------------------------------------------------------------- assignment
  genAssign(target: Expr, op: string, value: Expr, t: Token): void {
    const binop = op === '=' ? null : (op.slice(0, -1) as BinOp);
    const top = this.operand(target);
    if (top?.k === 'imm') this.err('cannot assign to a constant', t);
    if (top?.k === 'reg') {
      const T = top.r;
      if (this.isFp(T)) { if (binop) this.genFBinary(binop, target, value, T, t); else this.genFExpr(value, T); return; }
      if (binop) this.genBinary(binop, target, value, T, t); else this.genExpr(value, T);
      return;
    }
    const ty = this.targetType(target, value, t);
    const fp = ty === 'f32' || ty === 'f64';
    const bits: 32 | 64 = memSize(ty) === 8 ? 64 : 32;
    if (!binop) {
      const vop = this.operand(value);
      if (vop?.k === 'imm' && !fp) {
        const m = this.targetAccess(target, null, t);
        this.storeImm(vop.v, ty, m.mode, t);
        m.release();
        return;
      }
      let src: string;
      if (vop?.k === 'reg') src = vop.r;
      else if (fp) { src = this.allocFTemp(t); this.genFExpr(value, src); }
      else {
        if (this.hasCall(value)) this.err('assign the call result to a register first, then store it', t);
        src = this.allocTemp(bits, t);
        this.genExpr(value, src);
      }
      const m = this.targetAccess(target, src, t);
      this.storeMem(src, ty, m.mode);
      m.release();
      return;
    }
    // read-modify-write
    const m = this.targetAccess(target, null, t);
    if (fp) {
      const ft = this.allocFTemp(t);
      this.loadMem(ft, ty, m.mode, t);
      this.genFBinary(binop, { k: 'name', name: ft, t }, value, ft, t);
      this.storeMem(ft, ty, m.mode);
      m.release();
      return;
    }
    if (m.post) this.err('post-increment addressing cannot be used with compound assignment', t);
    const vt = this.allocTemp(bits, t);
    this.loadMem(vt, ty, m.mode, t);
    this.genBinary(binop, { k: 'name', name: vt, t }, value, vt, t);
    this.storeMem(vt, ty, m.mode);
    m.release();
  }

  targetType(target: Expr, value: Expr, t: Token): MemType {
    if (target.k === 'name' || target.k === 'index') {
      const s = this.lookup(target.name);
      if (!s) this.err(`unknown name '${target.name}'`, target.t);
      if (s.k !== 'data' && s.k !== 'local') this.err(`cannot assign to '${target.name}'`, t);
      if (s.k === 'data' && s.ro) this.err(`'${target.name}' is read-only`, t);
      if (target.k === 'name' && (s.ty.count !== null || s.ty.struct)) this.err(`'${target.name}' is an array; assign to an element: ${target.name}[i] = ...`, t);
      if (!s.ty.elem) this.err(`'${target.name}' is an array of structs; store through &${target.name}[i]`, t);
      return s.ty.elem;
    }
    if (target.k === 'mem') {
      if (target.ty) return target.ty;
      const vop = this.operand(value);
      if (vop?.k === 'reg') return this.isFp(vop.r) ? 'f64' : is64(vop.r) ? 'u64' : 'u32';
      if (this.isFloat(value)) return 'f64';
      return 'u64';
    }
    return this.err('invalid assignment target', t);
  }

  targetAccess(target: Expr, src: string | null, t: Token): { mode: string; release: () => void; post: boolean } {
    if (target.k === 'name') {
      const s = this.lookup(target.name) as Extract<Sym, { k: 'data' | 'local' }>;
      if (s.k === 'data') return { mode: `[rip + ${s.label}]`, release: () => {}, post: false };
      return { mode: `[rsp + ${this.localRef(s.off)}]`, release: () => {}, post: false };
    }
    const m = this.memAccess(target, src);
    void t;
    return { mode: m.mode, release: m.release, post: target.k === 'mem' && target.post !== 0 };
  }

  // ======================================================================
  // calls (Win64)
  // ======================================================================
  genCall(e: Extract<Expr, { k: 'call' }>): void {
    if (this.isBuiltinCall(e)) {
      if (e.name === 'syscall') this.err('syscall() is not available on Windows: call WinAPI functions (WriteFile, ExitProcess) instead', e.t);
      this.genBuiltin(e, 'rax');
      return;
    }
    const s = this.lookup(e.name);
    let target: string;
    let fixed: number | null = null;
    let indirect: string | null = null;
    if (s?.k === 'fn') {
      target = s.label;
      if (e.args.length !== s.nparams) this.warnings.push(`line ${e.t.line}: '${e.name}' expects ${s.nparams} argument(s), got ${e.args.length}`);
    } else if (s?.k === 'extern') { target = s.label; fixed = s.fixed; }   // the linker adds a jmp [__imp_] thunk for DLL functions
    else if (s?.k === 'alias') { target = ''; indirect = v64(s.reg); }
    else if (!s && this.canonReg(e.name)) { target = ''; indirect = v64(this.canonReg(e.name)!); }
    else return this.err(`unknown function '${e.name}' (declare C functions with: extern ${e.name})`, e.t);
    const f = this.fn!;
    f.maxStackArgs = Math.max(f.maxStackArgs, Math.max(0, e.args.length - 4));
    // an indirect target in a volatile register is parked in the frame while arguments are set up
    let callee = indirect ? indirect : target;
    let park: ReturnType<X64Gen['stage']> | null = null;
    if (indirect && !NONVOL.includes(R(indirect).n)) {
      park = this.stage(8);
      this.emit(`mov qword ptr ${park.at(0)}, ${indirect}`);
      callee = `qword ptr ${park.at(0)}`;
    }
    this.setArgs(e.args, fixed, e.t);
    this.emit(`call ${callee}`);
    park?.release();
  }

  /** after a nested call, later arguments must not read volatile registers */
  checkClobber(order: Expr[]): void {
    let callAt: Expr | null = null;
    for (const a of order) {
      if (callAt) {
        const regs = [...this.readsRegs(a)].filter((n) => !NONVOL.includes(n));
        if (regs.length) this.err(`${NAMES64[regs[0]]} is read after a nested call (${(callAt as { name?: string }).name ?? 'call'}) that clobbers it; copy it to a non-volatile register first`, a.t);
      }
      if (this.hasCall(a)) callAt = a;
    }
  }

  setArgs(args: Expr[], fixed: number | null, t: Token): void {
    const variadicFrom = fixed ?? Infinity;
    const isF = args.map((a) => this.isFloat(a));
    const dest = (i: number) => (i < 4 ? (isF[i] ? `xmm${i}` : ARG_GPR[i]) : `qword ptr [rsp + ${32 + 8 * (i - 4)}]`);
    this.checkClobber(args);
    const argRegs = args.map((_, i) => (i < 4 && !isF[i] ? R(ARG_GPR[i]).n : -1));
    let conflict = args.some((a, i) => i > 0 && this.hasCall(a));
    for (let i = 0; i < args.length && !conflict; i++) {
      if (argRegs[i] < 0) continue;
      for (let j = i + 1; j < args.length; j++) if (this.readsRegs(args[j]).has(argRegs[i])) conflict = true;
    }
    const dupGpr = (i: number) => { if (isF[i] && i < 4 && i >= variadicFrom) this.emit(`movq ${ARG_GPR[i]}, xmm${i}`); };
    if (!conflict) {
      // stack arguments first (they may read argument registers), then registers
      for (let i = 4; i < args.length; i++) {
        this.resetTemps();
        if (isF[i]) { const ft = this.allocFTemp(t); this.genFExpr(args[i], ft); this.emit(`movsd ${dest(i)}, ${ft}`); continue; }
        const op = this.operand(args[i]);
        if (op?.k === 'imm' && fitsI32(op.v)) { this.emit(`mov ${dest(i)}, ${op.v}`); continue; }
        const r = op?.k === 'reg' ? v64(op.r) : this.toReg(args[i], this.allocTemp(64, t));
        this.emit(`mov ${dest(i)}, ${r}`);
      }
      for (let i = 0; i < Math.min(4, args.length); i++) {
        this.resetTemps();
        const a = args[i];
        if (isF[i]) { this.genFExpr(a, `xmm${i}`); dupGpr(i); continue; }
        const d = ARG_GPR[i];
        if (a.k === 'call' && !this.isBuiltinCall(a)) { this.genCall(a); if (d !== 'rax') this.emit(`mov ${d}, rax`); continue; }
        const op = this.operand(a);
        if (op?.k === 'reg' && sameReg(op.r, d)) continue;
        this.genExpr(a, op?.k === 'reg' && !is64(op.r) && !this.isFp(op.r) ? v32(d) : d);
      }
      return;
    }
    // evaluate everything into staging slots, then distribute
    const st = this.stage(8 * args.length);
    args.forEach((a, i) => {
      this.resetTemps();
      if (isF[i]) { const ft = this.allocFTemp(t); this.genFExpr(a, ft); this.emit(`movsd qword ptr ${st.at(8 * i)}, ${ft}`); return; }
      if (a.k === 'call' && !this.isBuiltinCall(a)) { this.genCall(a); this.emit(`mov qword ptr ${st.at(8 * i)}, rax`); return; }
      const r = this.toReg(a, this.allocTemp(64, t));
      this.emit(`mov qword ptr ${st.at(8 * i)}, ${v64(r)}`);
    });
    args.forEach((_, i) => {
      if (i >= 4) { this.emit(`mov r11, qword ptr ${st.at(8 * i)}`); this.emit(`mov ${dest(i)}, r11`); return; }
      if (isF[i]) { this.emit(`movsd xmm${i}, qword ptr ${st.at(8 * i)}`); dupGpr(i); }
      else this.emit(`mov ${ARG_GPR[i]}, qword ptr ${st.at(8 * i)}`);
    });
    st.release();
  }

  genBuiltin(e: Extract<Expr, { k: 'call' }>, T: string): void {
    const bits = is64(T) ? 64 : 32;
    const n = e.args.length;
    const need = (k: number) => { if (n !== k) this.err(`${e.name}() takes ${k} argument(s)`, e.t); };
    switch (e.name) {
      case 'syscall': this.err('syscall() is not available on Windows: call WinAPI functions (WriteFile, ExitProcess) instead', e.t);
      // falls through (unreachable)
      case 'sizeof': case 'len': need(1); this.movImm(T, this.sizeofExpr(e.args[0], e.name === 'len', e.t)); return;
      case 'sext8': case 'sext16': case 'sext32': case 'sext': {
        need(1);
        const r = this.regOrTemp(e.args[0], 64, e.t);
        if (e.name === 'sext8') this.emit(`movsx ${T}, ${v8(r)}`);
        else if (e.name === 'sext16') this.emit(`movsx ${T}, ${vSize(r, 2)}`);
        else if (bits === 64) this.emit(`movsxd ${T}, ${v32(r)}`);
        else if (!sameReg(r, T)) this.emit(`mov ${T}, ${v32(r)}`);
        return;
      }
      case 'zext8': case 'zext16': case 'zext32': {
        need(1);
        const r = this.regOrTemp(e.args[0], 64, e.t);
        if (e.name === 'zext8') this.emit(`movzx ${v32(T)}, ${v8(r)}`);
        else if (e.name === 'zext16') this.emit(`movzx ${v32(T)}, ${vSize(r, 2)}`);
        else this.emit(`mov ${v32(T)}, ${v32(r)}`);
        return;
      }
      case 'abs': {
        need(1);
        const r = this.regOrTemp(e.args[0], bits, e.t);
        if (!sameReg(r, T)) this.emit(`mov ${T}, ${r}`);
        const tmp = this.allocTemp(bits, e.t);
        this.emit(`mov ${tmp}, ${T}`);
        this.emit(`neg ${T}`);
        this.emit(`cmovs ${T}, ${tmp}`);
        this.freeTemp(tmp);
        return;
      }
      case 'min': case 'max': case 'umin': case 'umax': {
        need(2);
        const a = this.regOrTemp(e.args[0], bits, e.t), b = this.regOrTemp(e.args[1], bits, e.t);
        this.emit(`cmp ${a}, ${b}`);
        const code = { min: 'l', max: 'g', umin: 'b', umax: 'a' }[e.name]!;
        if (sameReg(a, T)) { this.emit(`cmov${INV[code]} ${T}, ${b}`); return; }
        if (!sameReg(b, T)) this.emit(`mov ${T}, ${b}`);
        this.emit(`cmov${code} ${T}, ${a}`);
        return;
      }
      case 'clz': need(1); this.emit(`lzcnt ${T}, ${this.regOrTemp(e.args[0], bits, e.t)}`); return;
      case 'rev': need(1); this.genExpr(e.args[0], T); this.emit(`bswap ${T}`); return;
      case 'rbit': return this.err('rbit() has no single instruction on x86-64', e.t);
      case 'int': {
        need(1);
        if (!this.isFloat(e.args[0])) { this.genExpr(e.args[0], T); return; }
        const ft = this.fReg(e.args[0], this.allocFTemp(e.t));
        this.emit(`cvttsd2si ${T}, ${ft}`);
        return;
      }
      case 'float': case 'sqrt': case 'fabs':
        this.err(`${e.name}() produces a floating point value; assign it to an xmm register`, e.t);
    }
    this.err(`unknown builtin '${e.name}'`, e.t);
  }

  // ======================================================================
  // floating point (double precision in xmm registers)
  // ======================================================================
  isFloat(e: Expr): boolean {
    switch (e.k) {
      case 'float': return true;
      case 'name': {
        const s = this.lookup(e.name);
        if (s?.k === 'alias') return this.isFp(s.reg);
        if (!s) { const r = xreg(e.name); return !!r && r.xmm; }
        if (s.k === 'data' || s.k === 'local') return s.ty.count === null && (s.ty.elem === 'f32' || s.ty.elem === 'f64');
        return false;
      }
      case 'index': { const s = this.lookup(e.name); return (s?.k === 'data' || s?.k === 'local') && (s.ty.elem === 'f32' || s.ty.elem === 'f64'); }
      case 'mem': return e.ty === 'f32' || e.ty === 'f64';
      case 'un': return e.op === '-' && this.isFloat(e.e);
      case 'bin': return ['+', '-', '*', '/'].includes(e.op) && (this.isFloat(e.l) || this.isFloat(e.r));
      case 'tern': return this.isFloat(e.a) || this.isFloat(e.b);
      case 'call':
        if (this.isUserFn(e.name)) return false;
        if (['float', 'sqrt', 'fabs'].includes(e.name)) return true;
        return (e.name === 'min' || e.name === 'max') && e.args.some((a) => this.isFloat(a));
    }
    return false;
  }

  fReg(e: Expr, pref: string): string {
    const op = this.operand(e);
    if (op?.k === 'reg' && this.isFp(op.r)) return op.r;
    this.genFExpr(e, pref);
    return pref;
  }

  fconst(T: string, v: number): void {
    if (v === 0 && !Object.is(v, -0)) { this.emit(`xorps ${T}, ${T}`); return; }
    this.emit(`movsd ${T}, qword ptr [rip + ${this.fpLiteral(v, 64)}]`);
  }

  genFExpr(e: Expr, T: string): void {
    const c = this.constEval(e);
    if (c !== null) { this.fconst(T, Number(c)); return; }
    switch (e.k) {
      case 'float': this.fconst(T, e.v); return;
      case 'name': {
        const op = this.operand(e);
        if (op?.k === 'reg') {
          if (!this.isFp(op.r)) this.err(`'${e.name}' is an integer register; use float(...)`, e.t);
          if (!sameReg(op.r, T)) this.emit(`movaps ${T}, ${op.r}`);
          return;
        }
        const s = this.lookup(e.name);
        if (s?.k === 'data' && s.ty.count === null && s.ty.elem) { this.loadMem(T, s.ty.elem, `[rip + ${s.label}]`, e.t); return; }
        if (s?.k === 'local' && s.ty.count === null && s.ty.elem) { this.loadMem(T, s.ty.elem, `[rsp + ${this.localRef(s.off)}]`, e.t); return; }
        return this.err(`'${e.name}' is not a floating point value`, e.t);
      }
      case 'index': case 'mem': {
        const m = this.memAccess(e, T);
        if (m.ty !== 'f32' && m.ty !== 'f64') this.err('integer memory in a floating point context; use float(...)', e.t);
        this.loadMem(T, m.ty, m.mode, e.t);
        m.release();
        return;
      }
      case 'un':
        if (e.op !== '-') this.err(`operator '${e.op}' is not valid for floating point`, e.t);
        this.genFExpr(e.e, T);
        this.flipSign(T, e.t, 'btc');
        return;
      case 'bin':
        if (!['+', '-', '*', '/'].includes(e.op)) this.err(`operator '${e.op}' is not valid for floating point`, e.t);
        this.genFBinary(e.op, e.l, e.r, T, e.t);
        return;
      case 'tern': {
        const els = this.newLabel('else'), end = this.newLabel('tend');
        this.genBranch(e.c, els, false);
        this.genFExpr(e.a, T);
        this.jump(end);
        this.label(els);
        this.genFExpr(e.b, T);
        this.label(end);
        return;
      }
      case 'call': {
        if (!this.isUserFn(e.name)) {
          if (e.name === 'float') {
            const a = e.args[0];
            if (this.isFloat(a)) { this.genFExpr(a, T); return; }
            const r = this.regOrTemp(a, 64, e.t);
            this.emit(`cvtsi2sd ${T}, ${r}`);
            return;
          }
          if (e.name === 'sqrt') { const r = this.fReg(e.args[0], T); this.emit(`sqrtsd ${T}, ${r}`); return; }
          if (e.name === 'fabs') { this.genFExpr(e.args[0], T); this.flipSign(T, e.t, 'btr'); return; }
          if (e.name === 'min' || e.name === 'max') {
            const b = this.fReg(e.args[1], this.allocFTemp(e.t));
            this.genFExpr(e.args[0], T);
            this.emit(`${e.name}sd ${T}, ${b}`);
            return;
          }
        }
        this.callGuarded(e, T, () => this.genCall(e));
        if (T !== 'xmm0') this.emit(`movaps ${T}, xmm0`);
        return;
      }
    }
    this.err('unsupported floating point expression', e.t);
  }

  /** change the sign bit through a scratch general register (btc = negate, btr = absolute value) */
  flipSign(T: string, t: Token, op: 'btc' | 'btr'): void {
    const tmp = this.allocTemp(64, t);
    this.emit(`movq ${tmp}, ${T}`);
    this.emit(`${op} ${tmp}, 63`);
    this.emit(`movq ${T}, ${tmp}`);
    this.freeTemp(tmp);
  }

  genFBinary(op: BinOp, l: Expr, r: Expr, T: string, t: Token): void {
    if (!['+', '-', '*', '/'].includes(op)) this.err(`operator '${op}' is not valid for floating point`, t);
    const mn = { '+': 'addsd', '-': 'subsd', '*': 'mulsd', '/': 'divsd' }[op as '+'];
    const rop = this.operand(r);
    if (rop?.k === 'reg' && this.isFp(rop.r) && !sameReg(rop.r, T)) {
      this.genFExpr(l, T);
      this.emit(`${mn} ${T}, ${rop.r}`);
      return;
    }
    const tmp = this.allocFTemp(t);
    this.genFExpr(r, tmp);
    this.genFExpr(l, T);
    this.emit(`${mn} ${T}, ${tmp}`);
    this.ftemps.delete(R(tmp).n);
  }

  genFCompare(op: BinOp, l: Expr, r: Expr, t: Token): string {
    // ucomisd sets CF/ZF like an unsigned compare; < and <= are done by swapping
    let a = l, b = r, code: string;
    switch (op) {
      case '>': code = 'a'; break;
      case '>=': code = 'ae'; break;
      case '<': code = 'a'; [a, b] = [r, l]; break;
      case '<=': code = 'ae'; [a, b] = [r, l]; break;
      case '==': code = 'e'; break;
      default: code = 'ne';
    }
    const ra = this.fReg(a, this.allocFTemp(t));
    const rb = this.fReg(b, this.allocFTemp(t));
    this.emit(`ucomisd ${ra}, ${rb}`);
    return code;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function cc(op: string, unsigned: boolean): string {
  switch (op) {
    case '==': return 'e';
    case '!=': return 'ne';
    case '<': return unsigned ? 'b' : 'l';
    case '<=': return unsigned ? 'be' : 'le';
    case '>': return unsigned ? 'a' : 'g';
    case '>=': return unsigned ? 'ae' : 'ge';
  }
  throw new Error('bad comparison ' + op);
}

/** substitute frame placeholders (%STG%+n etc.) with real offsets */
function fix(bases: Record<string, number>): (l: string) => string {
  return (l: string) => l.replace(/%(STG|LOC|IN|PSH)%\+(-?\d+)/g, (_, k: string, n: string) => String(bases[k] + Number(n)));
}

/** drop `jmp L` directly followed by `L:` and unreachable instructions after jmp */
function peephole(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*jmp (\S+)$/.exec(lines[i]);
    if (m) {
      let j = i + 1, found = false;
      while (j < lines.length && lines[j].endsWith(':')) { if (lines[j] === `${m[1]}:`) { found = true; break; } j++; }
      if (found) continue;
      out.push(lines[i]);
      while (i + 1 < lines.length && !lines[i + 1].endsWith(':') && !lines[i + 1].trim().startsWith('.') && !lines[i + 1].trim().startsWith('//')) i++;
      continue;
    }
    out.push(lines[i]);
  }
  return out;
}

export { asmString, fmtData, endsWithJump };

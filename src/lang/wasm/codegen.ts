// HLA64 → WebAssembly text (wasm32): one module, run by a JavaScript runtime that is its system.
//
// Conventions:
//  * Registers are locals of the function: r0..r31 hold 64-bit integers (i64), f0..f31 doubles (f64).
//    A call cannot change the caller's registers (every function has its own locals), so all of them
//    behave like callee-saved registers; `let x = 0` without a register picks one of r16..r31.
//  * Parameters by position: `fn f(a, x: f64)` gets a in r0 and x in f1. The result is r0, or f0 for a
//    function that returns a floating point value.
//  * Memory is linear and 32-bit (wasm32): an address is computed in an i64 register and wrapped to
//    i32 by the memory instruction. Data starts at 1024; below it is NULL territory.
//  * Local arrays, `local` variables, push/pop slots and variadic arguments live in a frame on a
//    shadow stack in linear memory: the global $sp, the frame address in the local $fp.
//  * WebAssembly has only structured control flow: loops become block/loop/br, conditions if/else;
//    goto and assembler labels do not exist here.
//  * C functions (printf, malloc, fopen...) are imports from the runtime (src/wasm/libc.ts).
import { type Token } from '../lexer.ts';
import { parse } from '../parser.ts';
import { memSize, type BinOp, type Expr, type Item, type MemType, type Program, type Stmt } from '../ast.ts';
import { CodeGenBase, alignUp, log2, changes, type CompileResult, type FnState, type LoopCtx, type Sym } from '../frontend.ts';
import { LIBC_SET, FLOAT_RESULT, PARAMS, DATA_BASE, STACK_SIZE } from '../../wasm/libc.ts';

export type { CompileResult } from '../frontend.ts';

const BUILTINS = new Set([
  'syscall', 'sext8', 'sext16', 'sext32', 'sext', 'zext8', 'zext16', 'zext32', 'abs', 'min', 'max', 'umin', 'umax',
  'clz', 'rbit', 'rev', 'float', 'int', 'sqrt', 'fabs', 'sizeof', 'len', 'offsetof',
]);

type VT = 'i64' | 'f64';
interface Sig { params: VT[]; ret: VT }

const REG_RE = /^([rf])([0-9]|[12][0-9]|3[01])$/i;
const AUTO_POOL = Array.from({ length: 16 }, (_, i) => 16 + i);   // r16..r31
const MAX_PARAMS = 16;

/** Is `text` a register of the wasm32 target (r0..r31, f0..f31)? */
export function wasmIsReg(text: string): boolean {
  return REG_RE.test(text);
}

/** Compile a program. Function result types (i64 or f64) are found by translating until they settle:
 *  a caller has to know whether `f()` leaves an integer or a double. */
export function compileWasm(src: string): CompileResult {
  const prog = parse(src, { isReg: wasmIsReg });
  let known = new Set<string>();
  for (let pass = 0; ; pass++) {
    const g = new WasmGen(src, prog, known);
    const r = g.run();
    if ([...g.foundFloatRet].every((n) => known.has(n)) || pass > 8) return r;
    known = new Set([...known, ...g.foundFloatRet]);
  }
}

interface WasmLoop extends LoopCtx { top: string }

interface WasmFn extends FnState {
  stgTop: number;
  stgMax: number;
  pushDepth: number;
  pushMax: number;
  tempsInUse: Set<string>;
  finalReturn: Stmt | null;
  retFloat: boolean;
}

interface Import { label: string; module: 'env' | 'va'; params: string[]; ret: VT }

const ICMP: Record<string, [string, string]> = {
  '==': ['eq', 'eq'], '!=': ['ne', 'ne'], '<': ['lt_s', 'lt_u'], '<=': ['le_s', 'le_u'], '>': ['gt_s', 'gt_u'], '>=': ['ge_s', 'ge_u'],
};
const INVERSE: Record<string, BinOp> = { '==': '!=', '!=': '==', '<': '>=', '>=': '<', '>': '<=', '<=': '>' };
const FCMP: Record<string, string> = { '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' };
const IARITH: Record<string, [string, string]> = {
  '+': ['add', 'add'], '-': ['sub', 'sub'], '*': ['mul', 'mul'], '/': ['div_s', 'div_u'], '%': ['rem_s', 'rem_u'],
  '&': ['and', 'and'], '|': ['or', 'or'], '^': ['xor', 'xor'], '<<': ['shl', 'shl'], '>>': ['shr_s', 'shr_u'], '>>>': ['shr_u', 'shr_u'],
};
const FARITH: Record<string, string> = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div' };
const COMPARE = ['==', '!=', '<', '<=', '>', '>='];

/** a double as WebAssembly text */
function fnum(v: number): string {
  if (Number.isNaN(v)) return 'nan';
  if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
  if (Object.is(v, -0)) return '-0';
  return String(v);
}

class WasmGen extends CodeGenBase {
  readonly localPrefix = '$';
  readonly builtins = BUILTINS;
  declare fn: WasmFn | null;
  items = new Map<string, Extract<Item, { k: 'fn' }>>();
  floatRet: Set<string>;
  /** functions found to return a double in this pass (see compileWasm) */
  foundFloatRet = new Set<string>();
  imports = new Map<string, Import[]>();
  types = new Map<string, string>();          // call_indirect signatures: key -> $type name
  globalRegs = new Set<string>();             // registers of global aliases: wasm globals
  rawCalls: { name: string; t: Token }[] = [];  // `call puts` written as an instruction
  stackCheck = false;

  constructor(src: string, prog: Program, floatRet: Set<string>) {
    super(src, prog, {});
    this.floatRet = new Set(floatRet);
    for (const it of prog.items) {
      if (it.k !== 'fn') continue;
      this.items.set(it.name, it);
      if (it.ret === 'f64' || it.ret === 'f32' || (it.ret && /^f\d/i.test(it.ret))) this.floatRet.add(it.name);
    }
  }

  // ======================================================================
  // target hooks
  // ======================================================================
  sym(name: string): string { return '$' + name; }
  canonReg(text: string): string | null { return wasmIsReg(text) ? text.toLowerCase() : null; }
  regNum(reg: string): number { return Number(reg.slice(1)); }
  isFp(reg: string): boolean { return reg[0] === 'f' || reg[0] === 'F'; }
  regBytes(): number { return 8; }
  cTypeOfReg(r: string): string { return this.isFp(r) ? 'double' : 'int64_t'; }
  autoPool(): number[] { return AUTO_POOL; }
  autoRegName(n: number): string { return `r${n}`; }
  zerofill(label: string, size: number, p2: number): string[] { return [`.p2align ${p2}`, `${label}:`, `    .zero ${size}`]; }
  jump(): void { throw new Error('internal: jumps do not exist in WebAssembly'); }
  label(): void { throw new Error('internal: labels do not exist in WebAssembly'); }
  resetTemps(): void { this.fn?.tempsInUse.clear(); }

  run(): CompileResult {
    const top = this.prog.items.find((it) => it.k === 'asm');
    if (top) this.err('assembler outside of a function is not available on wasm32: put the instructions into a function', top.t);
    for (const it of this.prog.items) if (it.k === 'alias') this.globalRegs.add(this.canonReg(it.decl.reg!) ?? it.decl.reg!);
    return super.run();
  }

  emit(line: string): void {
    const t = line.trim();
    this.fn!.lines.push(t.startsWith('//') ? ';;' + t.slice(2) : t);
  }

  /** read / write a register: a local of the function, or a global for a register of a global alias */
  get(r: string): string { return `${this.globalRegs.has(r) ? 'global' : 'local'}.get $${r}`; }
  set(r: string): string { return `${this.globalRegs.has(r) ? 'global' : 'local'}.set $${r}`; }

  /** a scratch local for one statement: $t0.. (i64), $ft0.. (f64), $at0.. (i32 addresses) */
  tmp(t: 'i64' | 'f64' | 'i32'): string {
    const p = t === 'i64' ? '$t' : t === 'f64' ? '$ft' : '$at';
    for (let n = 0; ; n++) {
      const name = p + n;
      if (!this.fn!.tempsInUse.has(name)) { this.fn!.tempsInUse.add(name); return name; }
    }
  }
  free(name: string): void { this.fn!.tempsInUse.delete(name); }

  sigOf(name: string): Sig {
    const it = this.items.get(name)!;
    return {
      params: it.params.map((p) => (p.ty === 'f32' || p.ty === 'f64' || (p.reg && p.reg !== 'auto' && this.isFp(p.reg)) ? 'f64' : 'i64')),
      ret: this.floatRet.has(name) ? 'f64' : 'i64',
    };
  }

  // ======================================================================
  // frame: [variadic staging][push slots][locals], addressed from $fp
  // ======================================================================
  stage(bytes: number): { base: number; release: () => void } {
    const f = this.fn!;
    const base = f.stgTop;
    f.stgTop += alignUp(bytes, 8);
    f.stgMax = Math.max(f.stgMax, f.stgTop);
    return { base, release: () => { f.stgTop = base; } };
  }

  declareLocal(s: Extract<Stmt, { k: 'local' }>): void {
    const ty = this.varType(s.ty);
    const size = ty.elemSize * (ty.count ?? 1);
    const al = Math.min(16, ty.struct ? ty.struct.align : ty.elemSize);
    const f = this.fn!;
    const off = alignUp(f.localsSize, al);
    f.localsSize = off + size;
    this.scopes[this.scopes.length - 1].set(s.name, { k: 'local', off, ty, size });
    this.emit(`;; local ${s.name}: frame + %LOC%+${off}, ${size} bytes`);
  }

  // ======================================================================
  // functions
  // ======================================================================
  genFunction(it: Extract<Item, { k: 'fn' }>): void {
    const fnSrc = this.src.slice(it.t.start, it.end.end);
    const avoid = new Set<number>();
    for (const m of fnSrc.matchAll(/\br([0-9]|[12][0-9]|3[01])\b/gi)) avoid.add(Number(m[1]));
    for (const r of this.globalRegs) if (!this.isFp(r)) avoid.add(this.regNum(r));
    const isMain = it.name === 'main';
    const last = it.body[it.body.length - 1];
    this.fn = {
      name: it.name, label: this.sym(it.name), retLabel: `$${it.name}.ret`, lines: [], localsSize: 0,
      autoInUse: new Set(), autoAvoid: avoid, loops: [], labels: new Map(), naked: it.naked, isMain,
      stgTop: 0, stgMax: 0, pushDepth: 0, pushMax: 0, tempsInUse: new Set(),
      finalReturn: last?.k === 'return' ? last : null, retFloat: this.floatRet.has(it.name),
    };
    this.labelN = 0;
    this.collectLabels(it.body);
    this.pushScope();
    const sig = this.sigOf(it.name);
    const params: string[] = [];
    it.params.forEach((p, i) => {
      if (i >= MAX_PARAMS) this.err(`at most ${MAX_PARAMS} parameters on wasm32`, p.t);
      const fp = sig.params[i] === 'f64';
      const abi = (fp ? 'f' : 'r') + i;
      params.push(`(param $${abi} ${sig.params[i]})`);
      let target = abi;
      if (p.reg === null) this.scopes[0].set(p.name, { k: 'alias', reg: abi, unsigned: p.unsigned });
      else {
        const reg = p.reg === 'auto' ? null : p.reg;
        if (fp && reg === null) this.err('auto is not available for floating point parameters; name an f register', p.t);
        if (reg && this.isFp(reg) !== fp) this.err(`'${reg}' does not fit the parameter's type`, p.t);
        target = this.defineAlias({ name: p.name, reg, unsigned: p.unsigned, t: p.t });
        if (target !== abi) { this.emit(this.get(abi)); this.emit(this.set(target)); }
      }
      if (p.ty && !fp && memSize(p.ty) < 8) { this.emit(this.get(target)); this.narrow(p.ty); this.emit(this.set(target)); }
    });
    this.genBlock(it.body, false);
    if (isMain && !(last && last.k === 'return') && !it.naked) { this.emit('i64.const 0'); this.emit(this.set('r0')); }
    this.popScope();
    const f = this.fn;
    const result = f.retFloat ? 'f0' : 'r0';

    // frame
    const STG = 0, PSH = f.stgMax, LOC = PSH + 8 * f.pushMax;
    const frame = alignUp(LOC + f.localsSize, 16);
    const fix = (l: string) => l.replace(/%(STG|PSH|LOC)%\+(-?\d+)/g, (_, k: string, n: string) => String({ STG, PSH, LOC }[k]! + Number(n)));
    const body: string[] = [];
    if (frame) {
      this.stackCheck = true;
      body.push(';; frame: ' + frame + ' bytes on the shadow stack', 'global.get $sp', `i32.const ${frame}`, 'i32.sub', 'local.tee $fp', 'global.set $sp',
        'local.get $fp', 'i32.const {STACK_LIMIT}', 'i32.lt_u', 'if', 'call $hla.stack_overflow', 'end');
    }
    body.push(`block ${f.retLabel}`, ...f.lines.map(fix), 'end');
    if (frame) body.push('local.get $fp', `i32.const ${frame}`, 'i32.add', 'global.set $sp');
    body.push(this.get(result));
    const lines = tidy(body);

    // locals: every register the body names (not the parameters or globals), scratch locals, $fp
    const declared = new Set(it.params.map((_, i) => (sig.params[i] === 'f64' ? 'f' : 'r') + i));
    const regs = new Set<string>();
    for (const l of lines) for (const m of l.matchAll(/\b(?:local\.(?:get|set|tee)) \$([rf]\d+|t\d+|ft\d+|at\d+|fp)\b/g)) regs.add(m[1]);
    const order = (x: string) => (x === 'fp' ? 2e3 : /^[rf]/.test(x) ? (x[0] === 'r' ? 0 : 100) + Number(x.slice(1)) : (x[0] === 't' ? 1e3 : x[0] === 'f' ? 1.1e3 : 1.2e3) + Number(x.replace(/\D/g, '')));
    const locals = [...regs].filter((r) => !declared.has(r)).sort((a, b) => order(a) - order(b))
      .map((r) => `(local $${r} ${r === 'fp' || r.startsWith('at') ? 'i32' : r[0] === 'f' ? 'f64' : 'i64'})`);
    const exp = it.exported ? ` (export "${it.name}")` : '';
    this.text.push('', `  (func ${f.label}${exp}${params.length ? ' ' + params.join(' ') : ''} (result ${f.retFloat ? 'f64' : 'i64'})`);
    for (let i = 0; i < locals.length; i += 6) this.text.push('    ' + locals.slice(i, i + 6).join(' '));
    this.text.push(...lines.map((l) => '    ' + l), '  )');
    this.fn = null;
    this.scopes = [];
  }

  /** sign or zero extend the i64 on the stack from a narrow type */
  narrow(ty: MemType): void {
    switch (ty) {
      case 'i8': this.emit('i64.extend8_s'); break;
      case 'i16': this.emit('i64.extend16_s'); break;
      case 'i32': this.emit('i64.extend32_s'); break;
      case 'u8': this.emit('i64.const 255'); this.emit('i64.and'); break;
      case 'u16': this.emit('i64.const 65535'); this.emit('i64.and'); break;
      case 'u32': this.emit('i64.const 4294967295'); this.emit('i64.and'); break;
    }
  }

  genReturn(s: Extract<Stmt, { k: 'return' }>): void {
    const f = this.fn!;
    if (s.e) {
      if (this.isFloat(s.e)) this.foundFloatRet.add(f.name);
      if (f.retFloat) { this.toF(s.e); this.emit(this.set('f0')); }
      else { this.toI(s.e); this.emit(this.set('r0')); }
    }
    if (s !== f.finalReturn) this.emit(`br ${f.retLabel}`);   // the last statement of the body just ends the block
  }

  genPushPop(s: Extract<Stmt, { k: 'push' | 'pop' }>): void {
    const f = this.fn!;
    const regs = s.regs.map((e) => {
      const op = this.operand(e);
      if (!op || op.k !== 'reg') this.err(`${s.k} expects registers`, s.t);
      return op.r;
    });
    if (s.k === 'push') {
      for (const r of regs) {
        this.emit('local.get $fp');
        this.emit(this.get(r));
        this.emit(`${this.isFp(r) ? 'f64' : 'i64'}.store offset=%PSH%+${8 * f.pushDepth++}`);
      }
      f.pushMax = Math.max(f.pushMax, f.pushDepth);
    } else {
      for (const r of [...regs].reverse()) {
        if (f.pushDepth === 0) this.err('pop without a matching push', s.t);
        this.emit('local.get $fp');
        this.emit(`${this.isFp(r) ? 'f64' : 'i64'}.load offset=%PSH%+${8 * --f.pushDepth}`);
        this.emit(this.set(r));
      }
    }
  }

  // ======================================================================
  // statements: structured control flow
  // ======================================================================
  genStmt(s: Stmt): void {
    switch (s.k) {
      case 'if': this.resetTemps(); this.genIfW(s.arms, s.els); return;
      case 'while': this.resetTemps(); this.loopW(s.label, s.cond, s.body, null, null); return;
      case 'dowhile': this.resetTemps(); this.loopW(s.label, null, s.body, null, s.cond); return;
      case 'loop': this.resetTemps(); this.loopW(s.label, null, s.body, null, null); return;
      case 'for':
        this.resetTemps();
        this.pushScope();
        for (const st of s.init) this.genStmt(st);
        this.loopW(s.label, s.cond, s.body, () => { for (const st of s.step) this.genStmt(st); }, null);
        this.popScope();
        return;
      case 'forin': this.resetTemps(); this.genForInW(s); return;
      case 'break': case 'continue': {
        const loops = this.fn!.loops as WasmLoop[];
        const target = s.label ? [...loops].reverse().find((l) => l.label === s.label) : loops[loops.length - 1];
        if (!target) this.err(s.label ? `no enclosing loop labelled '${s.label}'` : `'${s.k}' outside of a loop`, s.t);
        this.emit(`br ${s.k === 'break' ? target.brk : target.cont}`);
        return;
      }
      case 'goto': {
        const wl = this.gotoTargets.get(s.label);
        if (wl) { this.emit(`br ${wl}`); return; }
        if (!this.fn!.labels.has(s.label)) this.err(`unknown label '${s.label}'`, s.t);
        this.err(`goto ${s.label} jumps into another block: WebAssembly has only structured control flow, so a goto must stay in the statement list of its label (or blocks inside it)`, s.t);
      }
      // falls through (unreachable)
      case 'label': return;    // turned into a block or loop by genList
      case 'asm':
        for (const l of s.lines) this.rawWasm(this.rawText(l, s.t), l.parts[0]?.tok ?? s.t);
        return;
      case 'asmtext':
        for (const l of s.text.split('\n')) if (l.trim()) this.rawWasm(l.trim(), s.t);
        return;
    }
    super.genStmt(s);
  }

  /** an instruction written in the source: registers become locals ($r5), data names their addresses */
  rawWasm(txt: string, t: Token): void {
    if (/^[\w.$]+:$/.test(txt) || /^\d+:/.test(txt)) this.err('labels do not exist in WebAssembly: use block/loop with br, or the loops of HLA64', t);
    if (txt.startsWith('.')) this.err(`assembler directives are not available on wasm32: '${txt}'`, t);
    if (txt.startsWith('(')) this.err('write the instructions in the flat form, one per line: local.get x, i64.const 1, i64.add', t);
    let out = txt.replace(/^(local|global)\.(get|set|tee)\s+\$?([rf]\d+)\b/i, (m, _k: string, op: string, r: string) => {
      const reg = this.canonReg(r);
      if (!reg) return m;
      if (!this.globalRegs.has(reg)) return `local.${op} $${reg}`;
      return op === 'tee' ? `global.set $${reg}\nglobal.get $${reg}` : `global.${op} $${reg}`;
    });
    out = out.replace(/^(i32|i64)\.const\s+(\$[\w.$]+)$/, (m, ty: string, label: string) => {
      const s = this.globals.get(label.slice(1));
      if (s?.k === 'extern') this.err(`the address of the system function '${label.slice(1)}' is not available on wasm32`, t);
      return s && (s.k === 'data' || s.k === 'fn') ? `${ty}.const {${label}}` : m;
    });
    out = out.replace(/\boffset=(\$[\w.$]+)/, (m, label: string) => (this.globals.get(label.slice(1))?.k === 'data' ? `offset={${label}}` : m));
    const call = /^call\s+\$([\w.$]+)$/.exec(out);
    if (call && this.globals.get(call[1])?.k === 'extern') this.rawCalls.push({ name: call[1], t });
    for (const l of out.split('\n')) this.emit(l);
  }

  // ---------------------------------------------------------------- goto
  // A label and the gotos to it in the same statement list become structure: a goto forward is a br out
  // of a block that ends at the label, a goto backward a br to a loop that starts at it.
  //     goto done          block $f.done.fwd             again:          loop $f.again
  //     ...           →      ...                           ...       →     ...
  //   done:                end                             goto again      br $f.again
  // A goto into another block (a label inside an if or a loop it is not in) has no such form.
  gotoTargets = new Map<string, string>();

  genBlock(body: Stmt[], scope = true): void {
    if (scope) this.pushScope();
    this.genList(body);
    if (scope) this.popScope();
  }

  genList(stmts: Stmt[]): void {
    // the last label that is reached by a goto before it: everything up to it goes into a block
    let k = -1;
    stmts.forEach((s, i) => { if (s.k === 'label' && stmts.slice(0, i).some((x) => gotoIn(x, s.name))) k = i; });
    if (k >= 0) {
      const name = (stmts[k] as Extract<Stmt, { k: 'label' }>).name;
      const wl = `$${this.fn!.name}.${name}.fwd`;
      this.emit(`block ${wl}`);
      this.withGoto(name, wl, () => this.genList(stmts.slice(0, k)));
      this.emit('end');
      this.genList2(stmts.slice(k));
      return;
    }
    this.genList2(stmts);
  }

  /** a list whose labels are reached only from after them: loops from each label to its last goto */
  private genList2(stmts: Stmt[]): void {
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i];
      if (s.k !== 'label') { this.genStmt(s); continue; }
      let j = -1;
      for (let x = i + 1; x < stmts.length; x++) if (gotoIn(stmts[x], s.name)) j = x;
      if (j < 0) continue;
      const wl = `$${this.fn!.name}.${s.name}`;
      this.emit(`loop ${wl}`);
      this.withGoto(s.name, wl, () => this.genList(stmts.slice(i + 1, j + 1)));
      this.emit('end');
      i = j;
    }
  }

  private withGoto(name: string, wl: string, f: () => void): void {
    const before = this.gotoTargets.get(name);
    this.gotoTargets.set(name, wl);
    try { f(); } finally { if (before === undefined) this.gotoTargets.delete(name); else this.gotoTargets.set(name, before); }
  }

  genIfW(arms: { cond: Expr; body: Stmt[] }[], els: Stmt[] | null): void {
    const [arm, ...rest] = arms;
    this.resetTemps();
    this.cond(arm.cond);
    this.emit('if');
    this.genBlock(arm.body);
    if (rest.length || els) {
      this.emit('else');
      if (rest.length) this.genIfW(rest, els);
      else this.genBlock(els!);
    }
    this.emit('end');
  }

  /**
   *   block $end            ;; break
   *     loop $loop
   *       (cond, br_if $end when false)
   *       block $next        ;; continue
   *         body
   *       end
   *       step
   *       br $loop           (do-while: cond, br_if $loop)
   *     end
   *   end
   * Labels nothing branches to are dropped with their block afterwards (tidy).
   */
  loopW(label: string | null, cond: Expr | null, body: Stmt[], step: (() => void) | null, bottom: Expr | null): void {
    const l: WasmLoop = { brk: this.newLabel('end'), cont: this.newLabel('next'), top: this.newLabel('loop'), label };
    this.emit(`block ${l.brk}`);
    this.emit(`loop ${l.top}`);
    if (cond) { this.resetTemps(); this.branch(cond, l.brk, false); }
    this.emit(`block ${l.cont}`);
    this.withLoop(l, () => this.genBlock(body));
    this.emit('end');
    if (step) { this.resetTemps(); step(); }
    if (bottom) { this.resetTemps(); this.branch(bottom, l.top, true); }
    else this.emit(`br ${l.top}`);
    this.emit('end');
    this.emit('end');
  }

  /** br_if to label when e is true (ifTrue) or false */
  branch(e: Expr, label: string, ifTrue: boolean): void {
    const c = this.constEval(e);
    if (c !== null) { if ((c !== 0n) === ifTrue) this.emit(`br ${label}`); return; }
    if (e.k === 'un' && e.op === '!') { this.branch(e.e, label, !ifTrue); return; }
    if (!ifTrue && e.k === 'bin' && COMPARE.includes(e.op) && !this.isFloat(e.l) && !this.isFloat(e.r)) {
      this.cond({ ...e, op: INVERSE[e.op] });
      this.emit(`br_if ${label}`);
      return;
    }
    this.cond(e);
    if (!ifTrue) this.emit('i32.eqz');
    this.emit(`br_if ${label}`);
  }

  genBranch(e: Expr, label: string, ifTrue: boolean): void { this.branch(e, label, ifTrue); }

  genForInW(s: Extract<Stmt, { k: 'forin' }>): void {
    this.pushScope();
    let sym = this.lookup(s.v);
    const reuse = !s.reg && sym && (sym.k === 'alias' || this.scalarLocal(s.v));
    if (!reuse) {
      const free = s.reg ? null : this.tryAllocAuto();
      if (free) this.fn!.autoInUse.delete(free.n);
      if (!s.reg && !free) { this.spillVar(s.v, false, s.t); this.emit(`// ${s.v} -> frame (all registers for let are taken)`); }
      else this.defineAlias({ name: s.v, reg: s.reg, unsigned: false, t: s.t });
      sym = this.lookup(s.v)!;
    }
    const v: Expr = { k: 'name', name: s.v, t: s.t };
    let step = 1n;
    if (s.step) {
      const st = this.constEval(s.step);
      if (st === null || st === 0n) this.err('step must be a non-zero constant', s.t);
      step = st;
    }
    this.resetTemps();
    this.genAssign(v, '=', s.from, s.t);
    this.resetTemps();
    // the bound is computed once unless it is a constant or a register the body does not change
    let bound: Expr = s.to;
    const toOp = this.operand(s.to);
    if (this.constEval(s.to) === null && (toOp === null || (s.to.k === 'name' && changes(s.body, s.to.name)))) {
      const hidden = this.tryAllocAuto();
      const name = '$bound';
      if (hidden) {
        this.scopes[this.scopes.length - 1].set(name, { k: 'alias', reg: hidden.reg, unsigned: false, auto: hidden.n } as Sym);
        this.genExpr(s.to, hidden.reg);
      } else {
        this.spillVar(name, false, s.t);
        this.genAssign({ k: 'name', name, t: s.t }, '=', s.to, s.t);
      }
      bound = { k: 'name', name, t: s.t };
    }
    const op: BinOp = step > 0n ? (s.inclusive ? '<=' : '<') : (s.inclusive ? '>=' : '>');
    this.loopW(s.label, { k: 'bin', op, l: v, r: bound, t: s.t }, s.body, () => this.genAssign(v, '+=', { k: 'num', v: step, t: s.t }, s.t), null);
    this.popScope();
  }

  // ======================================================================
  // integer expressions: each pushes one i64
  // ======================================================================
  genExpr(e: Expr, T: string): void {
    if (this.isFp(T)) { this.genFExpr(e, T); return; }
    this.v(e);
    this.emit(this.set(T));
  }

  genFExpr(e: Expr, T: string): void {
    if (!this.isFp(T)) { this.genExpr(e, T); return; }
    this.fv(e);
    this.emit(this.set(T));
  }

  genBinary(op: BinOp, l: Expr, r: Expr, T: string, t: Token): void {
    this.v({ k: 'bin', op, l, r, t });
    this.emit(this.set(T));
  }

  /** an integer value whatever e is (a double is truncated, like int(...)) */
  toI(e: Expr): void {
    if (this.isFloat(e) && this.constEval(e) === null) { this.fv(e); this.emit('i64.trunc_sat_f64_s'); } else this.v(e);
  }
  /** a double whatever e is (an integer is converted, like float(...)) */
  toF(e: Expr): void {
    if (this.isFloat(e) || this.constEval(e) !== null) this.fv(e); else { this.v(e); this.emit('f64.convert_i64_s'); }
  }

  regOf(e: Expr): string | null {
    if (e.k !== 'name') return null;
    const s = this.lookup(e.name);
    if (s?.k === 'alias') return s.reg;
    return s ? null : this.canonReg(e.name);
  }

  v(e: Expr): void {
    const c = this.constEval(e);
    if (c !== null) { this.emit(`i64.const ${BigInt.asIntN(64, c)}`); return; }
    switch (e.k) {
      case 'float': return this.err('floating point value in an integer context; use int(...)', e.t);
      case 'str': this.emit(`i64.const {${this.cstring(e.bytes)}}`); return;
      case 'name': {
        const r = this.regOf(e);
        if (r) {
          if (this.isFp(r)) this.err(`'${e.name}' is a floating point register; use int(...) to convert`, e.t);
          this.emit(this.get(r));
          return;
        }
        const s = this.lookup(e.name);
        if (!s) this.err(`unknown name '${e.name}'`, e.t);
        if (s.k === 'data' || s.k === 'local') {
          if (s.ty.count !== null || s.ty.struct) { this.symAddr(s, 0); return; }
          if (s.ty.elem === 'f32' || s.ty.elem === 'f64') this.err(`'${e.name}' is a floating point variable; use int(...)`, e.t);
          this.loadInt(s.ty.elem!, this.pushSym(s, 0));
          return;
        }
        if (s.k === 'fn') { this.emit(`i64.const {${s.label}}`); return; }
        if (s.k === 'extern') this.err(`the address of the system function '${e.name}' is not available on wasm32`, e.t);
        return this.err(`'${e.name}' cannot be used as a value`, e.t);
      }
      case 'addr': this.addrOf(e); return;
      case 'index': case 'mem': {
        const m = this.access(e, null);
        if (m.ty === 'f32' || m.ty === 'f64') this.err('floating point memory in an integer context; use int(...)', e.t);
        this.loadInt(m.ty, m.off);
        m.post();
        return;
      }
      case 'un':
        if (e.op === '!') { this.cond(e); this.emit('i64.extend_i32_u'); return; }
        if (this.isFloat(e.e)) this.err('floating point value in an integer context; use int(...)', e.t);
        if (e.op === '-') { this.emit('i64.const 0'); this.v(e.e); this.emit('i64.sub'); return; }
        this.v(e.e);
        this.emit('i64.const -1');
        this.emit('i64.xor');
        return;
      case 'bin': {
        if (COMPARE.includes(e.op) || e.op === '&&' || e.op === '||') { this.cond(e); this.emit('i64.extend_i32_u'); return; }
        if (this.isFloat(e)) this.err('floating point value in an integer context; use int(...)', e.t);
        const ops = IARITH[e.op];
        if (!ops) this.err(`operator '${e.op}' is not arithmetic`, e.t);
        if ((e.op === '/' || e.op === '%') && this.constEval(e.r) === 0n) this.err('division by zero', e.t);
        const unsigned = this.isUnsigned(e.l) || this.isUnsigned(e.r);
        this.v(e.l);
        this.v(e.r);
        this.emit(`i64.${ops[unsigned ? 1 : 0]}`);
        return;
      }
      case 'tern':
        this.cond(e.c);
        this.emit('if (result i64)');
        this.toI(e.a);
        this.emit('else');
        this.toI(e.b);
        this.emit('end');
        return;
      case 'call':
        if (this.isBuiltinCall(e)) { this.builtin(e); return; }
        this.callValue(e, 'i64');
        return;
    }
    this.err('unsupported expression', e.t);
  }

  isBuiltinCall(e: Extract<Expr, { k: 'call' }>): boolean {
    return BUILTINS.has(e.name) && !this.isUserFn(e.name);
  }

  builtin(e: Extract<Expr, { k: 'call' }>): void {
    const n = e.args.length;
    const need = (k: number) => { if (n !== k) this.err(`${e.name}() takes ${k} argument(s)`, e.t); };
    const a = e.args[0];
    switch (e.name) {
      case 'syscall': return this.err('syscall() is not available on wasm32: the system is the JavaScript runtime; call its C functions (extern write, exit ...)', e.t);
      case 'sizeof': case 'len': need(1); this.emit(`i64.const ${this.sizeofExpr(a, e.name === 'len', e.t)}`); return;
      case 'sext8': need(1); this.v(a); this.emit('i64.extend8_s'); return;
      case 'sext16': need(1); this.v(a); this.emit('i64.extend16_s'); return;
      case 'sext32': case 'sext': need(1); this.v(a); this.emit('i64.extend32_s'); return;
      case 'zext8': need(1); this.v(a); this.narrow('u8'); return;
      case 'zext16': need(1); this.v(a); this.narrow('u16'); return;
      case 'zext32': need(1); this.v(a); this.narrow('u32'); return;
      case 'abs': {
        need(1);
        const t = this.tmp('i64');
        this.v(a);
        this.emit(`local.set ${t}`);
        for (const l of ['i64.const 0', `local.get ${t}`, 'i64.sub', `local.get ${t}`, `local.get ${t}`, 'i64.const 0', 'i64.lt_s', 'select']) this.emit(l);
        this.free(t);
        return;
      }
      case 'min': case 'max': case 'umin': case 'umax': {
        need(2);
        if (e.args.some((x) => this.isFloat(x))) this.err(`${e.name}() of floating point values in an integer context; use int(...)`, e.t);
        const x = this.tmp('i64'), y = this.tmp('i64');
        this.v(e.args[0]);
        this.emit(`local.set ${x}`);
        this.v(e.args[1]);
        this.emit(`local.set ${y}`);
        const cmp = { min: 'lt_s', max: 'gt_s', umin: 'lt_u', umax: 'gt_u' }[e.name];
        for (const l of [`local.get ${x}`, `local.get ${y}`, `local.get ${x}`, `local.get ${y}`, `i64.${cmp}`, 'select']) this.emit(l);
        this.free(x);
        this.free(y);
        return;
      }
      case 'clz': need(1); this.v(a); this.emit('i64.clz'); return;
      case 'rbit': case 'rev': return this.err(`${e.name}() has no instruction on wasm32`, e.t);
      case 'int': need(1); this.toI(a); return;
      case 'float': case 'sqrt': case 'fabs':
        return this.err(`${e.name}() produces a floating point value; assign it to an f register`, e.t);
      case 'offsetof': break;
    }
    this.err(`unknown builtin '${e.name}'`, e.t);
  }

  // ---------------------------------------------------------------- conditions: each pushes one i32
  cond(e: Expr): void {
    const c = this.constEval(e);
    if (c !== null) { this.emit(`i32.const ${c !== 0n ? 1 : 0}`); return; }
    if (e.k === 'un' && e.op === '!') { this.cond(e.e); this.emit('i32.eqz'); return; }
    if (e.k === 'bin' && (e.op === '&&' || e.op === '||')) {
      this.cond(e.l);
      this.emit('if (result i32)');
      if (e.op === '&&') { this.cond(e.r); this.emit('else'); this.emit('i32.const 0'); }
      else { this.emit('i32.const 1'); this.emit('else'); this.cond(e.r); }
      this.emit('end');
      return;
    }
    if (e.k === 'bin' && COMPARE.includes(e.op)) {
      if (this.isFloat(e.l) || this.isFloat(e.r)) {
        this.fv(e.l);
        this.fv(e.r);
        this.emit(`f64.${FCMP[e.op]}`);
        return;
      }
      if ((e.op === '==' || e.op === '!=') && (this.constEval(e.r) === 0n || this.constEval(e.l) === 0n)) {
        this.v(this.constEval(e.r) === 0n ? e.l : e.r);
        this.emit('i64.eqz');
        if (e.op === '!=') this.emit('i32.eqz');
        return;
      }
      const unsigned = this.isUnsigned(e.l) || this.isUnsigned(e.r);
      this.v(e.l);
      this.v(e.r);
      this.emit(`i64.${ICMP[e.op][unsigned ? 1 : 0]}`);
      return;
    }
    if (this.isFloat(e)) this.err('floating point value used as a condition; compare it explicitly', e.t);
    this.v(e);
    this.emit('i64.const 0');
    this.emit('i64.ne');
  }

  // ---------------------------------------------------------------- memory
  /** push the i32 address of a data or frame symbol (+ extra bytes); returns the memarg (" offset=…") */
  pushSym(s: Extract<Sym, { k: 'data' | 'local' }>, extra: number): string {
    if (s.k === 'data') {
      this.emit(`i32.const {${s.label}${extra ? (extra > 0 ? '+' : '') + extra : ''}}`);
      return '';
    }
    this.emit('local.get $fp');
    if (s.off + extra < 0) { this.emit(`i32.const ${s.off + extra}`); this.emit('i32.add'); return ' offset=%LOC%+0'; }
    return ` offset=%LOC%+${s.off + extra}`;
  }

  /** push the i64 address of a data or frame symbol */
  symAddr(s: Extract<Sym, { k: 'data' | 'local' }>, extra: number): void {
    if (s.k === 'data') { this.emit(`i64.const {${s.label}${extra ? (extra > 0 ? '+' : '') + extra : ''}}`); return; }
    this.emit('local.get $fp');
    this.emit(`i32.const %LOC%+${s.off + extra}`);
    this.emit('i32.add');
    this.emit('i64.extend_i32_u');
  }

  /** i64 index * size, as an i32 */
  scaled(idx: Expr, size: number): void {
    this.v(idx);
    if (size !== 1) {
      if ((size & (size - 1)) === 0) { this.emit(`i64.const ${log2(BigInt(size))}`); this.emit('i64.shl'); }
      else { this.emit(`i64.const ${size}`); this.emit('i64.mul'); }
    }
    this.emit('i32.wrap_i64');
  }

  /** push the i32 address of a memory reference; `off` is its memarg, `post` updates a [p++] register */
  access(e: Expr, valueIsFloat: boolean | null): { ty: MemType; off: string; post: () => void } {
    const none = () => {};
    if (e.k === 'name') {
      const s = this.lookup(e.name) as Extract<Sym, { k: 'data' | 'local' }>;
      return { ty: s.ty.elem!, off: this.pushSym(s, 0), post: none };
    }
    if (e.k === 'index') {
      const s = this.lookup(e.name);
      if (!s || (s.k !== 'data' && s.k !== 'local')) this.err(`'${e.name}' is not an array (use u8[ptr + i] style access for pointers in registers)`, e.t);
      if (s.ty.struct || !s.ty.elem) this.err(`'${e.name}' is an array of structs; use &${e.name}[i] to get an element address`, e.t);
      const ty = s.ty.elem;
      const size = memSize(ty);
      const ic = this.constEval(e.index);
      if (ic !== null) {
        if (s.ty.count !== null && (ic < 0n || ic >= BigInt(s.ty.count))) this.warnings.push(`line ${e.t.line}: index ${ic} is out of bounds for '${e.name}'`);
        return { ty, off: this.pushSym(s, Number(ic) * size), post: none };
      }
      let idx = e.index, extra = 0;
      if (idx.k === 'bin' && (idx.op === '+' || idx.op === '-')) {
        const c = this.constEval(idx.r);
        if (c !== null) { extra = Number(idx.op === '+' ? c : -c) * size; idx = idx.l; }
      }
      if (s.k === 'data') {
        this.scaled(idx, size);
        const disp = `{${s.label}${extra ? (extra > 0 ? '+' : '') + extra : ''}}`;
        return { ty, off: ` offset=${disp}`, post: none };
      }
      this.emit('local.get $fp');
      this.scaled(idx, size);
      this.emit('i32.add');
      if (s.off + extra < 0) { this.emit(`i32.const ${s.off + extra}`); this.emit('i32.add'); return { ty, off: ' offset=%LOC%+0', post: none }; }
      return { ty, off: ` offset=%LOC%+${s.off + extra}`, post: none };
    }
    if (e.k !== 'mem') return this.err('not a memory reference', e.t);
    const ty: MemType = e.ty ?? (valueIsFloat ? 'f64' : 'u64');
    const size = memSize(ty);
    if (e.post) {
      const r = this.regOf(e.addr);
      if (!r || this.isFp(r)) this.err('post-increment needs a register address: [p++]', e.t);
      this.emit(this.get(r));
      this.emit('i32.wrap_i64');
      return {
        ty, off: '', post: () => {
          this.emit(this.get(r));
          this.emit(`i64.const ${size}`);
          this.emit(e.post > 0 ? 'i64.add' : 'i64.sub');
          this.emit(this.set(r));
        },
      };
    }
    // base + constant: the constant becomes the memarg offset
    let base = e.addr, off = 0n;
    if (base.k === 'bin' && base.op === '+') {
      const c = this.constEval(base.r) ?? null, cl = this.constEval(base.l);
      if (c !== null && c >= 0n && c < 1n << 32n) { off = c; base = base.l; }
      else if (cl !== null && cl >= 0n && cl < 1n << 32n) { off = cl; base = base.r; }
    } else if (base.k === 'bin' && base.op === '-') {
      const c = this.constEval(base.r);
      if (c !== null && c <= 0n && -c < 1n << 32n) { off = -c; base = base.l; }
    }
    this.v(base);
    this.emit('i32.wrap_i64');
    return { ty, off: off ? ` offset=${off}` : '', post: none };
  }

  loadInt(ty: MemType, off: string): void {
    const op = { u8: 'i64.load8_u', i8: 'i64.load8_s', u16: 'i64.load16_u', i16: 'i64.load16_s', u32: 'i64.load32_u', i32: 'i64.load32_s' }[ty as 'u8'] ?? 'i64.load';
    this.emit(op + off);
  }

  loadFloat(ty: MemType, off: string, t: Token): void {
    if (ty === 'f64') this.emit('f64.load' + off);
    else if (ty === 'f32') { this.emit('f32.load' + off); this.emit('f64.promote_f32'); }
    else this.err('integer memory loaded into a floating point register; use float(...)', t);
  }

  store(ty: MemType, off: string): void {
    if (ty === 'f64') this.emit('f64.store' + off);
    else if (ty === 'f32') { this.emit('f32.demote_f64'); this.emit('f32.store' + off); }
    else this.emit(['', 'i64.store8', 'i64.store16', '', 'i64.store32', '', '', '', 'i64.store'][memSize(ty)] + off);
  }

  addrOf(e: Extract<Expr, { k: 'addr' }>): void {
    const x = e.e;
    if (x.k === 'name') {
      const s = this.lookup(x.name);
      if (s?.k === 'data' || s?.k === 'local') { this.symAddr(s, 0); return; }
      if (s?.k === 'fn') { this.emit(`i64.const {${s.label}}`); return; }
      if (s?.k === 'extern') this.err(`the address of the system function '${x.name}' is not available on wasm32`, x.t);
      this.err(`cannot take the address of '${x.name}'`, x.t);
    }
    if (x.k === 'str') { this.emit(`i64.const {${this.cstring(x.bytes)}}`); return; }
    if (x.k === 'index') {
      const s = this.lookup(x.name);
      if (!s || (s.k !== 'data' && s.k !== 'local')) this.err(`'${x.name}' is not an array`, x.t);
      const size = s.ty.elemSize;
      const ic = this.constEval(x.index);
      if (ic !== null) { this.symAddr(s, Number(ic) * size); return; }
      this.symAddr(s, 0);
      this.v(x.index);
      if (size !== 1) { this.emit(`i64.const ${size}`); this.emit('i64.mul'); }
      this.emit('i64.add');
      return;
    }
    if (x.k === 'mem') { this.v(x.addr); return; }
    this.err('cannot take the address of this expression', e.t);
  }

  // ---------------------------------------------------------------- assignment
  genAssign(target: Expr, op: string, value: Expr, t: Token): void {
    const binop = op === '=' ? null : (op.slice(0, -1) as BinOp);
    const top = this.operand(target);
    if (top?.k === 'imm') this.err('cannot assign to a constant', t);
    if (top?.k === 'reg') {
      const T = top.r;
      const v: Expr = binop ? { k: 'bin', op: binop, l: target, r: value, t } : value;
      if (this.isFp(T)) {
        if (binop && !FARITH[binop]) this.err(`operator '${binop}' is not valid for floating point`, t);
        this.fv(v);
      } else this.v(v);
      this.emit(this.set(T));
      return;
    }
    const ty = this.targetType(target, value, t);
    const fp = ty === 'f32' || ty === 'f64';
    if (binop && target.k === 'mem' && target.post) this.err('post-increment addressing cannot be used with compound assignment', t);
    const m = this.access(target, fp);
    const val = (e: Expr) => (fp ? this.fv(e) : this.v(e));
    if (!binop) {
      val(value);
      this.store(ty, m.off);
      m.post();
      return;
    }
    // read-modify-write through the address in a scratch local
    const a = this.tmp('i32');
    this.emit(`local.tee ${a}`);
    this.emit(`local.get ${a}`);
    if (fp) {
      if (!FARITH[binop]) this.err(`operator '${binop}' is not valid for floating point`, t);
      this.loadFloat(ty, m.off, t);
      this.fv(value);
      this.emit(`f64.${FARITH[binop]}`);
    } else {
      this.loadInt(ty, m.off);
      if ((binop === '/' || binop === '%') && this.constEval(value) === 0n) this.err('division by zero', t);
      this.v(value);
      this.emit(`i64.${IARITH[binop][this.isUnsigned(target) || this.isUnsigned(value) ? 1 : 0]}`);
    }
    this.store(ty, m.off);
    this.free(a);
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
    if (target.k === 'mem') return target.ty ?? (this.isFloat(value) ? 'f64' : 'u64');
    return this.err('invalid assignment target', t);
  }

  // ======================================================================
  // calls
  // ======================================================================
  genCall(e: Extract<Expr, { k: 'call' }>): void {
    if (this.isBuiltinCall(e)) {
      if (this.isFloat(e)) this.fv(e); else this.v(e);
      this.emit('drop');
      return;
    }
    this.callValue(e, null);
  }

  /** an argument of the wanted type: integers and doubles are converted like C does with a prototype */
  arg(a: Expr, t: VT): void {
    if (t === 'f64') this.toF(a); else this.toI(a);
  }

  importFor(name: string, module: 'env' | 'va', params: string[], ret: VT): string {
    const list = this.imports.get(name) ?? [];
    const same = list.find((i) => i.module === module && i.params.join() === params.join() && i.ret === ret);
    if (same) return same.label;
    const label = list.length ? `$${name}.${list.length + 1}` : `$${name}`;
    list.push({ label, module, params, ret });
    this.imports.set(name, list);
    return label;
  }

  typeFor(params: string[], ret: VT): string {
    const key = `${params.map((p) => p[0]).join('')}.${ret[0]}`;
    const name = `$t.${key}`;
    this.types.set(name, `(func${params.length ? ' (param ' + params.join(' ') + ')' : ''} (result ${ret}))`);
    return name;
  }

  /** a call that leaves a value of type `want` (null: nothing) */
  callValue(e: Extract<Expr, { k: 'call' }>, want: VT | null): void {
    const s = this.lookup(e.name);
    let ret: VT;
    if (s?.k === 'fn') {
      const sig = this.sigOf(e.name);
      if (e.args.length !== sig.params.length) this.warnings.push(`line ${e.t.line}: '${e.name}' expects ${sig.params.length} argument(s), got ${e.args.length}`);
      sig.params.forEach((p, i) => { if (i < e.args.length) this.arg(e.args[i], p); else this.emit(`${p}.const 0`); });
      for (const extra of e.args.slice(sig.params.length)) { this.toI(extra); this.emit('drop'); }
      this.emit(`call ${s.label}`);
      ret = sig.ret;
    } else if (s?.k === 'extern') {
      if (!LIBC_SET.has(e.name)) this.err(`'${e.name}' is not a function of the wasm32 system (the JavaScript runtime gives printf, malloc, fopen ... see docs/wasm.md)`, e.t);
      const fixed = s.fixed ?? e.args.length;
      const params: string[] = [];
      e.args.slice(0, fixed).forEach((a) => {
        const t: VT = this.isFloat(a) ? 'f64' : 'i64';
        params.push(t);
        this.arg(a, t);
      });
      let st: ReturnType<WasmGen['stage']> | null = null;
      if (s.fixed !== null) {
        // the variadic arguments: 8 bytes each in this frame, their address is the last argument
        const rest = e.args.slice(s.fixed);
        st = this.stage(8 * Math.max(1, rest.length));
        rest.forEach((a, k) => {
          this.emit('local.get $fp');
          const f = this.isFloat(a);
          if (f) this.fv(a); else this.v(a);
          this.emit(`${f ? 'f64' : 'i64'}.store offset=%STG%+${st!.base + 8 * k}`);
        });
        this.emit('local.get $fp');
        this.emit(`i32.const %STG%+${st.base}`);
        this.emit('i32.add');
        params.push('i32');
      }
      ret = FLOAT_RESULT.has(e.name) ? 'f64' : 'i64';
      this.emit(`call ${this.importFor(e.name, s.fixed !== null ? 'va' : 'env', params, ret)}`);
      st?.release();
    } else {
      // a function pointer: an index into the table, called through its signature
      const callee: Expr = { k: 'name', name: e.name, t: e.t };
      if (!(s?.k === 'alias' || (!s && this.canonReg(e.name)) || this.fixedAddress(callee))) this.err(`unknown function '${e.name}' (declare C functions with: extern ${e.name})`, e.t);
      const params = e.args.map((a) => (this.isFloat(a) ? 'f64' : 'i64') as VT);
      e.args.forEach((a, i) => this.arg(a, params[i]));
      this.v(callee);
      this.emit('i32.wrap_i64');
      ret = want ?? 'i64';
      this.emit(`call_indirect (type ${this.typeFor(params, ret)})`);
    }
    if (want === null) this.emit('drop');
    else if (ret !== want) this.emit(want === 'f64' ? 'f64.convert_i64_s' : 'i64.trunc_sat_f64_s');
  }

  // ======================================================================
  // floating point: each pushes one f64
  // ======================================================================
  isFloat(e: Expr): boolean {
    switch (e.k) {
      case 'float': return true;
      case 'name': {
        const s = this.lookup(e.name);
        if (s?.k === 'alias') return this.isFp(s.reg);
        if (!s) { const r = this.canonReg(e.name); return !!r && this.isFp(r); }
        if (s.k === 'data' || s.k === 'local') return s.ty.count === null && (s.ty.elem === 'f32' || s.ty.elem === 'f64');
        return false;
      }
      case 'index': { const s = this.lookup(e.name); return (s?.k === 'data' || s?.k === 'local') && (s.ty.elem === 'f32' || s.ty.elem === 'f64'); }
      case 'mem': return e.ty === 'f32' || e.ty === 'f64';
      case 'un': return e.op === '-' && this.isFloat(e.e);
      case 'bin': return ['+', '-', '*', '/'].includes(e.op) && (this.isFloat(e.l) || this.isFloat(e.r));
      case 'tern': return this.isFloat(e.a) || this.isFloat(e.b);
      case 'call': {
        const s = this.lookup(e.name);
        if (s?.k === 'fn') return this.floatRet.has(e.name);
        if (s?.k === 'extern') return FLOAT_RESULT.has(e.name);
        if (s) return false;
        if (['float', 'sqrt', 'fabs'].includes(e.name)) return true;
        return (e.name === 'min' || e.name === 'max') && e.args.some((a) => this.isFloat(a));
      }
    }
    return false;
  }

  fv(e: Expr): void {
    const c = this.constEval(e);
    if (c !== null) { this.emit(`f64.const ${fnum(Number(c))}`); return; }
    switch (e.k) {
      case 'float': this.emit(`f64.const ${fnum(e.v)}`); return;
      case 'name': {
        const r = this.regOf(e);
        if (r) {
          if (!this.isFp(r)) this.err(`'${e.name}' is an integer register; use float(...)`, e.t);
          this.emit(this.get(r));
          return;
        }
        const s = this.lookup(e.name);
        if ((s?.k === 'data' || s?.k === 'local') && s.ty.count === null && s.ty.elem) { this.loadFloat(s.ty.elem, this.pushSym(s, 0), e.t); return; }
        return this.err(`'${e.name}' is not a floating point value`, e.t);
      }
      case 'index': case 'mem': {
        const m = this.access(e, true);
        if (m.ty !== 'f32' && m.ty !== 'f64') this.err('integer memory in a floating point context; use float(...)', e.t);
        this.loadFloat(m.ty, m.off, e.t);
        m.post();
        return;
      }
      case 'un':
        if (e.op !== '-') this.err(`operator '${e.op}' is not valid for floating point`, e.t);
        this.fv(e.e);
        this.emit('f64.neg');
        return;
      case 'bin':
        if (!FARITH[e.op]) this.err(`operator '${e.op}' is not valid for floating point`, e.t);
        this.fv(e.l);
        this.fv(e.r);
        this.emit(`f64.${FARITH[e.op]}`);
        return;
      case 'tern':
        this.cond(e.c);
        this.emit('if (result f64)');
        this.toF(e.a);
        this.emit('else');
        this.toF(e.b);
        this.emit('end');
        return;
      case 'call': {
        if (!this.isUserFn(e.name)) {
          if (e.name === 'float') { this.toF(e.args[0]); return; }
          if (e.name === 'sqrt') { this.fv(e.args[0]); this.emit('f64.sqrt'); return; }
          if (e.name === 'fabs') { this.fv(e.args[0]); this.emit('f64.abs'); return; }
          if (e.name === 'min' || e.name === 'max') { this.fv(e.args[0]); this.fv(e.args[1]); this.emit(`f64.${e.name}`); return; }
          if (BUILTINS.has(e.name)) this.err(`${e.name}() is an integer operation; use float(...)`, e.t);
        }
        this.callValue(e, 'f64');
        return;
      }
    }
    this.err('unsupported floating point expression', e.t);
  }

  // ======================================================================
  // the module
  // ======================================================================
  finish(): string {
    for (const c of this.rawCalls) {
      if (!LIBC_SET.has(c.name)) this.err(`'${c.name}' is not a function of the wasm32 system (the JavaScript runtime gives printf, malloc, fopen ... see docs/wasm.md)`, c.t);
      if (this.imports.has(c.name)) continue;
      // no call through the sugar: the import as C declares the function
      const p = PARAMS[c.name];
      const params: string[] = [...p.replace('...', '')].map((x) => (x === 'F' ? 'f64' : 'i64'));
      if (p.endsWith('...')) params.push('i32');
      this.importFor(c.name, p.endsWith('...') ? 'va' : 'env', params, FLOAT_RESULT.has(c.name) ? 'f64' : 'i64');
    }
    // linear memory: read-only data, data, then zero-filled data; the stack above them, the heap above it
    const lay = new DataLayout(DATA_BASE);
    lay.add([...this.cstrings, ...this.rodataLines, ...this.constPtrLines, ...this.literal8]);
    lay.add(this.dataLines);
    lay.add(this.bss);
    const dataEnd = alignUp(lay.pos, 16);
    const heapBase = dataEnd + STACK_SIZE;
    const pages = Math.ceil(heapBase / 65536) + 1;

    // function table: functions whose address is taken (index 0 stays null)
    const table: string[] = [];
    const tableIndex = (label: string) => { let i = table.indexOf(label); if (i < 0) { table.push(label); i = table.length - 1; } return i + 1; };
    const resolve = (label: string, where: string): number => {
      const s = this.globals.get(label.slice(1));
      if (s?.k === 'fn') return tableIndex(label);
      const a = lay.labels.get(label);
      if (a === undefined) throw new Error(`internal: unknown symbol ${label} in ${where}`);
      return a;
    };
    const fill = (l: string) => l.replace(/\{(\$[\w.$]+?)([+-]\d+)?\}|\{STACK_LIMIT\}/g, (m, label: string | undefined, add: string | undefined) =>
      label ? String(resolve(label, l) + Number(add ?? 0)) : String(dataEnd));
    const funcs = this.text.map((l) => {
      const out = fill(l);
      const syms = [...l.matchAll(/\{(\$[\w.$]+?)([+-]\d+)?\}/g)].map((m) => m[1] + (m[2] ?? ''));
      return syms.length && !out.includes(';;') ? `${out}  ;; ${syms.join(', ')}` : out;
    });
    const segments = lay.segments((label) => resolve(label, 'data'));

    const out: string[] = [
      ';; Generated by HLA64 (TypeScript) — WebAssembly (wasm32)',
      `;; memory: data ${DATA_BASE}..${lay.pos}, stack ${dataEnd}..${heapBase} (grows down), heap from ${heapBase} (malloc)`,
      '(module',
    ];
    for (const [name, def] of [...this.types].sort()) out.push(`  (type ${name} ${def})`);
    for (const [name, list] of [...this.imports].sort(([a], [b]) => a.localeCompare(b))) {
      for (const i of list) {
        out.push(`  (import "${i.module}" "${name}" (func ${i.label}${i.params.length ? ' (param ' + i.params.join(' ') + ')' : ''} (result ${i.ret})))`);
      }
    }
    if (this.stackCheck) out.push('  (import "hla" "stack_overflow" (func $hla.stack_overflow))');
    out.push(`  (memory (export "memory") ${pages})`);
    out.push(`  (global $sp (mut i32) (i32.const ${heapBase}))`);
    out.push(`  (global $__heap_base (export "__heap_base") i32 (i32.const ${heapBase}))`);
    for (const r of [...this.globalRegs].sort()) out.push(`  (global $${r} (mut ${this.isFp(r) ? 'f64' : 'i64'}) (${this.isFp(r) ? 'f64' : 'i64'}.const 0))`);

    // the entry: hla_start(argc, argv) runs main and gives back its result (the runtime calls exit)
    const main = this.items.get('main');
    const entry: string[] = [];
    if (main) {
      const sig = this.sigOf('main');
      entry.push('', '  ;; entry point: the runtime calls hla_start(argc, argv) and exits with its result',
        '  (func $hla_start (export "hla_start") (param $argc i64) (param $argv i64) (result i64)');
      sig.params.forEach((p, i) => entry.push(`    ${i < 2 && p === 'i64' ? `local.get ${i ? '$argv' : '$argc'}` : `${p}.const 0`}`));
      entry.push('    call $main');
      if (sig.ret === 'f64') entry.push('    i64.trunc_sat_f64_s');
      entry.push('  )');
    }
    const body = [...entry, ...funcs];
    if (table.length) {
      out.push(`  (table (export "table") ${table.length + 1} funcref)`);
      out.push(`  (elem (i32.const 1) ${table.join(' ')})`);
    }
    out.push(...body);
    if (segments.length) out.push('');
    for (const s of segments) out.push(`  (data (i32.const ${s.addr}) "${watString(s.bytes)}")${s.names.length ? '  ;; ' + s.names.join(', ') : ''}`);
    out.push(')');
    return out.join('\n') + '\n';
  }
}

/** is there a `goto label` in x (at any depth)? */
function gotoIn(x: unknown, label: string): boolean {
  if (!x || typeof x !== 'object') return false;
  if (Array.isArray(x)) return x.some((y) => gotoIn(y, label));
  const n = x as { k?: string; label?: string };
  if (n.k === 'goto') return n.label === label;
  return Object.values(x).some((y) => typeof y === 'object' && gotoIn(y, label));
}

/** drop block/loop labels nothing branches to (with their block), additions of zero, then indent by nesting */
function tidy(input: string[]): string[] {
  const lines: string[] = [];
  for (const raw of input) {
    const l = raw.replace(/ offset=0$/, '');
    if (l === 'i32.add' && lines[lines.length - 1] === 'i32.const 0') { lines.pop(); continue; }
    lines.push(l);
  }
  const used = new Set<string>();
  for (const l of lines) {
    const m = /^(br|br_if|br_table)\s+(.*)$/.exec(l);
    if (m) for (const x of m[2].split(/\s+/)) used.add(x);
  }
  const drop = new Set<number>();
  const open: { i: number; remove: boolean }[] = [];
  lines.forEach((l, i) => {
    const op = l.split(/\s+/)[0];
    if (op === 'block' || op === 'loop' || op === 'if') {
      const label = /^(?:block|loop)\s+(\$\S+)$/.exec(l)?.[1];
      const remove = !!label && !used.has(label);
      if (remove) drop.add(i);
      open.push({ i, remove });
    } else if (op === 'end') {
      const o = open.pop();
      if (o?.remove) drop.add(i);
    }
  });
  const out: string[] = [];
  let depth = 0;
  lines.forEach((l, i) => {
    if (drop.has(i)) return;
    const op = l.split(/\s+/)[0];
    if (op === 'end' || op === 'else') depth = Math.max(0, depth - 1);
    out.push('  '.repeat(depth) + l);
    if (op === 'block' || op === 'loop' || op === 'if' || op === 'else') depth++;
  });
  return out;
}

/** a WebAssembly text string: printable ASCII as is, everything else as \hh */
function watString(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) {
    if (b === 34) s += '\\"';
    else if (b === 92) s += '\\\\';
    else if (b >= 32 && b < 127) s += String.fromCharCode(b);
    else s += '\\' + b.toString(16).padStart(2, '0');
  }
  return s;
}

/** Lays out the data directives of the frontend (.p2align, label:, .byte … .quad, .asciz, .space, .zero)
 *  in linear memory; a .quad may name a label (a pointer, or a function: its table index). */
class DataLayout {
  pos: number;
  labels = new Map<string, number>();
  private chunks: { addr: number; names: string[]; bytes: number[]; fix: { at: number; label: string }[] }[] = [];

  constructor(start: number) { this.pos = start; }

  add(lines: string[]): void {
    let cur: (typeof this.chunks)[number] | null = null;
    const chunk = () => (cur ??= (this.chunks.push({ addr: this.pos, names: [], bytes: [], fix: [] }), this.chunks[this.chunks.length - 1]));
    const put = (bs: number[]) => { chunk().bytes.push(...bs); this.pos += bs.length; };
    for (const raw of lines) {
      const l = raw.replace(/\s+\/\/.*$/, '').trim();
      if (!l || l.startsWith('.globl')) continue;
      let m: RegExpExecArray | null;
      if ((m = /^\.p2align (\d+)$/.exec(l))) {
        const a = 1 << Number(m[1]);
        const pad = (a - (this.pos % a)) % a;
        if (pad) { if (cur) put(new Array(pad).fill(0)); else this.pos += pad; }
      } else if ((m = /^(\S+):$/.exec(l))) {
        cur = null;
        this.labels.set(m[1], this.pos);
        chunk().names.push(m[1]);
      } else if ((m = /^\.(byte|short|long|quad) (.+)$/.exec(l))) {
        const size = { byte: 1, short: 2, long: 4, quad: 8 }[m[1]]!;
        const v = m[2].trim();
        if (/^-?(0x[\da-f]+|\d+)$/i.test(v)) {
          let x = BigInt.asUintN(size * 8, BigInt(v));
          const bs: number[] = [];
          for (let i = 0; i < size; i++) { bs.push(Number(x & 0xffn)); x >>= 8n; }
          put(bs);
        } else {
          chunk().fix.push({ at: chunk().bytes.length, label: v });
          put(new Array(size).fill(0));
        }
      } else if ((m = /^\.(asciz|ascii) (".*")$/.exec(l))) {
        put([...parseAsmString(m[2]), ...(m[1] === 'asciz' ? [0] : [])]);
      } else if ((m = /^\.(space|zero) (\d+)$/.exec(l))) {
        const n = Number(m[2]);
        if (m[1] === 'space' && cur) put(new Array(n).fill(0));
        else { chunk(); this.pos += n; cur = null; }
      } else throw new Error(`internal: data directive '${l}'`);
    }
  }

  /** initialized chunks with their pointers filled in (zero-only chunks are left to the zeroed memory) */
  segments(resolve: (label: string) => number): { addr: number; bytes: Uint8Array; names: string[] }[] {
    const out: { addr: number; bytes: Uint8Array; names: string[] }[] = [];
    for (const c of this.chunks) {
      const bytes = Uint8Array.from(c.bytes);
      const dv = new DataView(bytes.buffer);
      for (const f of c.fix) dv.setBigUint64(f.at, BigInt(resolve(f.label)), true);
      if (bytes.some((b) => b !== 0)) out.push({ addr: c.addr, bytes, names: c.names });
    }
    return out;
  }
}

/** the inverse of asmString: "..." with \n \t \" \\ \ooo escapes */
function parseAsmString(s: string): number[] {
  const out: number[] = [];
  for (let i = 1; i < s.length - 1; i++) {
    const c = s[i];
    if (c !== '\\') { out.push(...new TextEncoder().encode(c)); continue; }
    const n = s[++i];
    if (n === 'n') out.push(10);
    else if (n === 't') out.push(9);
    else if (n === '"' || n === '\\') out.push(n.charCodeAt(0));
    else if (/[0-7]/.test(n)) { out.push(parseInt(s.slice(i, i + 3), 8)); i += 2; }
    else out.push(n.charCodeAt(0));
  }
  return out;
}

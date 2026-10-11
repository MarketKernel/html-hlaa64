// HLA64 translator: the target-independent part of code generation.
// Symbols, scopes, constants, structures, data sections, C headers and the
// statement-level control flow live here; a target (AArch64/macOS, x86-64/Windows)
// supplies instruction selection, calling convention and frame layout.
import { CompileError, type Token } from './lexer.ts';
import { memSize, MEM_TYPES, type BinOp, type Expr, type Item, type LetDecl, type MemType,
  type Program, type RawLine, type Stmt, type TypeRef } from './ast.ts';
import { toS64 } from './registers.ts';

export interface VarType {
  elem: MemType | null;   // scalar memory type, or null for struct elements
  struct: StructInfo | null;
  elemSize: number;
  count: number | null;   // null => scalar
  isString: boolean;
}

export interface StructInfo { name: string; size: number; align: number; fields: Map<string, { off: number; ty: VarType }> }

export type Sym =
  | { k: 'alias'; reg: string; unsigned: boolean; global?: boolean }
  | { k: 'const'; v: bigint }
  | { k: 'data'; label: string; ty: VarType; size: number; ro: boolean }
  | { k: 'local'; off: number; ty: VarType; size: number; spilled?: boolean }   // spilled: a `let` without a free register
  | { k: 'fn'; label: string; nparams: number }
  | { k: 'extern'; label: string; fixed: number | null }
  | { k: 'struct'; info: StructInfo };

export type Operand = { k: 'imm'; v: bigint } | { k: 'reg'; r: string };

export interface CompileResult {
  asm: string;
  warnings: string[];
}

export const C_TYPES: Record<string, string> = {
  i8: 'int8_t', u8: 'uint8_t', i16: 'int16_t', u16: 'uint16_t', i32: 'int32_t', u32: 'uint32_t',
  i64: 'int64_t', u64: 'uint64_t', ptr: 'void *', f32: 'float', f64: 'double', void: 'void',
};

export function hasValueReturn(body: Stmt[]): boolean {
  for (const st of body) {
    if (st.k === 'return' && st.e) return true;
    for (const key of ['body', 'els', 'init', 'step'] as const) {
      const v = (st as Record<string, unknown>)[key];
      if (Array.isArray(v) && hasValueReturn(v as Stmt[])) return true;
    }
    if (st.k === 'if' && st.arms.some((a) => hasValueReturn(a.body))) return true;
  }
  return false;
}

export interface LoopCtx { brk: string; cont: string; label: string | null }

export interface FnState {
  name: string;
  label: string;
  retLabel: string;
  lines: string[];
  localsSize: number;
  autoInUse: Set<number>;
  autoAvoid: Set<number>;
  loops: LoopCtx[];
  labels: Map<string, string>;
  naked: boolean;
  isMain: boolean;
}

export abstract class CodeGenBase {
  src: string;
  prog: Program;
  globals = new Map<string, Sym>();
  scopes: Map<string, Sym>[] = [];
  text: string[] = [];
  cstrings: string[] = [];
  cstringMap = new Map<string, string>();
  dataLines: string[] = [];
  rodataLines: string[] = [];
  constPtrLines: string[] = [];
  literal8: string[] = [];
  fpLits = new Map<string, string>();
  bss: string[] = [];
  warnings: string[] = [];
  labelN = 0;
  fn: FnState | null = null;
  temps = new Set<number>();
  ftemps = new Set<number>();

  constructor(src: string, prog: Program, consts: Record<string, number> = {}) {
    this.src = src;
    this.prog = prog;
    for (const [k, v] of Object.entries(consts)) this.globals.set(k, { k: 'const', v: BigInt(v) });
  }

  // ---------------------------------------------------------------- target hooks
  /** prefix for assembler-local labels: 'L' (Mach-O) or '.L' (COFF/ELF) */
  abstract readonly localPrefix: string;
  /** builtin function names of this target */
  abstract readonly builtins: Set<string>;
  /** assembler symbol for an HLA64 name: `_name` on macOS, `name` on Windows */
  abstract sym(name: string): string;
  /** canonical register name, or null when `text` is not a register */
  abstract canonReg(text: string): string | null;
  abstract regNum(reg: string): number;
  abstract isFp(reg: string): boolean;
  abstract regBytes(reg: string): number;
  abstract cTypeOfReg(reg: string): string;
  /** callee-saved register numbers used for `let` without a register */
  abstract autoPool(): number[];
  abstract autoRegName(n: number, bits: 32 | 64): string;
  abstract zerofill(label: string, size: number, p2: number): string[];
  abstract jump(label: string): void;
  abstract resetTemps(): void;
  abstract declareLocal(s: Extract<Stmt, { k: 'local' }>): void;
  abstract genReturn(s: Extract<Stmt, { k: 'return' }>): void;
  abstract genFunction(it: Extract<Item, { k: 'fn' }>): void;
  abstract genExpr(e: Expr, T: string): void;
  abstract genFExpr(e: Expr, T: string): void;
  abstract genBinary(op: BinOp, l: Expr, r: Expr, T: string, t: Token): void;
  abstract genBranch(e: Expr, label: string, ifTrue: boolean): void;
  abstract genAssign(target: Expr, op: string, value: Expr, t: Token): void;
  abstract genCall(e: Extract<Expr, { k: 'call' }>): void;
  abstract genPushPop(s: Extract<Stmt, { k: 'push' | 'pop' }>): void;
  /** assemble the final text from text/data lists */
  abstract finish(): string;

  run(): CompileResult {
    // pass 1: declare everything (functions may be used before definition)
    for (const it of this.prog.items) this.declare(it);
    // pass 2: data definitions and functions
    for (const it of this.prog.items) {
      if (it.k === 'data') this.genData(it);
    }
    for (const it of this.prog.items) {
      if (it.k === 'fn') this.genFunction(it);
      else if (it.k === 'asm') {
        this.text.push(...it.lines.map((l) => this.rawText(l, it.t)));
      }
    }
    return { asm: this.finish(), warnings: this.warnings };
  }

  err(msg: string, t: Token): never {
    throw new CompileError(msg, t.line, t.col);
  }

  declare(it: Item): void {
    const def = (name: string, s: Sym, t: Token) => {
      if (this.globals.has(name) && !name.startsWith('SYS_')) this.err(`'${name}' is already defined`, t);
      this.globals.set(name, s);
    };
    switch (it.k) {
      case 'fn':
        def(it.name, { k: 'fn', label: this.sym(it.name), nparams: it.params.length }, it.t);
        break;
      case 'extern':
        if (this.globals.get(it.name)?.k === 'fn') break; // defined locally
        def(it.name, { k: 'extern', label: this.sym(it.name), fixed: it.fixed }, it.t);
        break;
      case 'const': {
        const v = this.constEval(it.e);
        if (v === null) this.err(`constant '${it.name}' must be a compile-time expression`, it.t);
        def(it.name, { k: 'const', v }, it.t);
        break;
      }
      case 'enum': {
        let next = 0n;
        for (const m of it.members) {
          if (m.e) {
            const v = this.constEval(m.e);
            if (v === null) this.err('enum value must be constant', m.t);
            next = v;
          }
          def(`${it.name}.${m.name}`, { k: 'const', v: next }, m.t);
          next++;
        }
        def(`${it.name}.count`, { k: 'const', v: next }, it.t);
        break;
      }
      case 'struct': {
        const fields = new Map<string, { off: number; ty: VarType }>();
        let off = 0, align = 1;
        for (const f of it.fields) {
          const ty = this.varType(f.ty);
          const a = ty.struct ? ty.struct.align : ty.elemSize;
          off = alignUp(off, a);
          align = Math.max(align, a);
          fields.set(f.name, { off, ty });
          def(`${it.name}.${f.name}`, { k: 'const', v: BigInt(off) }, f.ty.t);
          off += typeSize(ty);
        }
        const size = alignUp(off, align);
        const info: StructInfo = { name: it.name, size, align, fields };
        def(it.name, { k: 'struct', info }, it.t);
        def(`${it.name}.size`, { k: 'const', v: BigInt(size) }, it.t);
        break;
      }
      case 'data': {
        const ty = this.dataType(it);
        def(it.name, { k: 'data', label: this.sym(it.name), ty, size: typeSize(ty), ro: it.ro }, it.t);
        break;
      }
      case 'alias': {
        const d = it.decl;
        if (!d.reg || d.reg === 'auto') this.err('global aliases need an explicit register', d.t);
        if (d.init) this.err('global aliases cannot have an initializer', d.t);
        def(d.name, { k: 'alias', reg: d.reg, unsigned: d.unsigned, global: true }, d.t);
        break;
      }
      case 'asm': break;
    }
  }

  varType(t: TypeRef): VarType {
    let elem: MemType | null = null;
    let struct: StructInfo | null = null;
    let elemSize: number;
    let isString = false;
    if (t.name === 'string') { elem = 'u8'; elemSize = 1; isString = true; }
    else if (MEM_TYPES.includes(t.name)) { elem = t.name as MemType; elemSize = memSize(elem); }
    else {
      const s = this.globals.get(t.name);
      if (!s || s.k !== 'struct') this.err(`unknown type '${t.name}'`, t.t);
      struct = s.info;
      elemSize = s.info.size;
    }
    let count: number | null = null;
    if (t.count) {
      const c = this.constEval(t.count);
      if (c === null || c < 0n) this.err('array size must be a non-negative constant', t.t);
      count = Number(c);
    }
    return { elem, struct, elemSize, count, isString };
  }

  dataType(it: Extract<Item, { k: 'data' }>): VarType {
    if (it.ty) {
      const ty = this.varType(it.ty);
      if (ty.isString && ty.count === null) {
        if (!it.init || it.init.k !== 'expr' || it.init.e.k !== 'str') this.err('string data needs a string initializer', it.t);
        ty.count = it.init.e.bytes.length + 1;
      }
      if (ty.count === null && it.init?.k === 'list') ty.count = it.init.items.length;
      if (ty.count === null && it.init?.k === 'expr' && it.init.e.k === 'str' && ty.elem === 'u8') {
        ty.count = it.init.e.bytes.length + 1;
        ty.isString = true;
      }
      return ty;
    }
    if (!it.init) this.err(`data '${it.name}' needs a type or an initializer`, it.t);
    if (it.init.k === 'expr' && it.init.e.k === 'str') {
      return { elem: 'u8', struct: null, elemSize: 1, count: it.init.e.bytes.length + 1, isString: true };
    }
    if (it.init.k === 'expr' && it.init.e.k === 'float') {
      return { elem: 'f64', struct: null, elemSize: 8, count: null, isString: false };
    }
    if (it.init.k === 'list') {
      const isPtr = it.init.items.some((e) => e.k === 'str' || e.k === 'addr');
      const isF = it.init.items.some((e) => e.k === 'float');
      const elem: MemType = isPtr ? 'ptr' : isF ? 'f64' : 'i64';
      return { elem, struct: null, elemSize: 8, count: it.init.items.length, isString: false };
    }
    return { elem: 'i64', struct: null, elemSize: 8, count: null, isString: false };
  }

  // ======================================================================
  // C header for exported items
  // ======================================================================
  /** target-specific header lines and the prefix of every declaration (Windows: dllimport macro) */
  headerApi(libName: string): { pre: string[]; api: string } {
    void libName;
    return { pre: [], api: '' };
  }

  /** compile-time check of a struct layout in the C header */
  headerStaticAssert(libName: string, cond: string, msg: string): string {
    void libName;
    return `_Static_assert(${cond}, "${msg}");`;
  }

  header(libName: string): string {
    const guard = libName.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_H';
    const { pre, api } = this.headerApi(libName);
    const out: string[] = [
      `// ${libName}.h — generated by HLA64 from ${libName}.hla. Do not edit.`,
      `#ifndef ${guard}`, `#define ${guard}`, '', '#include <stdint.h>', '', ...pre,
      '#ifdef __cplusplus', 'extern "C" {', '#endif', '',
    ];
    const ctype = (t: TypeRef): { type: string; dims: string } => {
      const dims = t.count ? `[${this.constEval(t.count)}]` : '';
      if (t.name === 'string') return { type: 'char', dims };
      if (C_TYPES[t.name]) return { type: t.name === 'ptr' ? 'void *' : C_TYPES[t.name], dims };
      return { type: t.name, dims };
    };
    for (const it of this.prog.items) {
      if (it.k === 'const' && it.exported) {
        out.push(`#define ${it.name} ${this.constEval(it.e)}`);
      } else if (it.k === 'enum' && it.exported) {
        const s = it.members.map((m) => `    ${it.name}_${m.name} = ${(this.globals.get(`${it.name}.${m.name}`) as { v: bigint }).v},`);
        out.push(`enum ${it.name} {`, ...s, `    ${it.name}_count = ${(this.globals.get(`${it.name}.count`) as { v: bigint }).v}`, '};', '');
      } else if (it.k === 'struct' && it.exported) {
        const info = (this.globals.get(it.name) as Extract<Sym, { k: 'struct' }>).info;
        out.push(`typedef struct ${it.name} {`);
        for (const f of it.fields) {
          const c = ctype(f.ty);
          out.push(`    ${c.type}${c.type.endsWith('*') ? '' : ' '}${f.name}${c.dims};   // offset ${info.fields.get(f.name)!.off}`);
        }
        out.push(`} ${it.name};`);
        out.push(this.headerStaticAssert(libName, `sizeof(${it.name}) == ${info.size}`, `${it.name}: layout differs from HLA64`), '');
      }
    }
    for (const it of this.prog.items) {
      if (it.k === 'data' && it.exported) {
        const sym = this.globals.get(it.name) as Extract<Sym, { k: 'data' }>;
        let type: string;
        let dims = sym.ty.count !== null ? `[${sym.ty.count}]` : '';
        if (sym.ty.isString) type = 'char';
        else if (sym.ty.struct) type = sym.ty.struct.name;
        else type = sym.ty.elem === 'ptr' ? 'void *' : C_TYPES[sym.ty.elem!];
        if (type.endsWith('*') && !dims) dims = '';
        out.push(`extern ${api}${it.ro ? 'const ' : ''}${type}${type.endsWith('*') ? '' : ' '}${it.name}${dims};`);
      }
    }
    out.push('');
    for (const it of this.prog.items) {
      if (it.k !== 'fn' || !(it.exported || it.name === 'main') || it.name === 'main') continue;
      const params = it.params.map((p) => {
        const t = p.ty ? C_TYPES[p.ty] : p.reg && p.reg !== 'auto' ? this.cTypeOfReg(p.reg) : 'int64_t';
        return `${t}${t.endsWith('*') ? '' : ' '}${p.name}`;
      });
      let ret: string;
      if (it.ret) ret = C_TYPES[it.ret] ?? this.cTypeOfReg(it.ret);
      else ret = hasValueReturn(it.body) ? 'int64_t' : 'void';
      out.push(`${api}${ret}${ret.endsWith('*') ? '' : ' '}${it.name}(${params.join(', ') || 'void'});`);
    }
    out.push('', '#ifdef __cplusplus', '}', '#endif', '', `#endif // ${guard}`, '');
    return out.join('\n');
  }

  // ======================================================================
  // data section
  // ======================================================================
  genData(it: Extract<Item, { k: 'data' }>): void {
    const sym = this.globals.get(it.name) as Extract<Sym, { k: 'data' }>;
    const ty = sym.ty;
    const align = ty.struct ? ty.struct.align : ty.elemSize;
    const p2 = Math.log2(Math.max(1, Math.min(align, 16))) | 0;
    if (!it.init) {
      if (it.ro) this.err('rodata needs an initializer', it.t);
      if (it.exported) this.bss.push(`.globl ${sym.label}`);
      this.bss.push(...this.zerofill(sym.label, Math.max(sym.size, 1), p2));
      return;
    }
    // read-only data holding pointers needs load-time rebasing: __DATA,__const
    const hasPtr = it.init.k === 'list' ? it.init.items.some((e) => e.k === 'str' || this.isPointerInit(e)) : this.isPointerInit(it.init.e);
    const out = it.ro ? (hasPtr ? this.constPtrLines : this.rodataLines) : this.dataLines;
    if (ty.struct) this.err('struct data cannot have an initializer yet (leave it zero-filled)', it.t);
    if (it.exported) out.push(`.globl ${sym.label}`);
    out.push(`.p2align ${p2}`, `${sym.label}:`);
    const elem = ty.elem!;
    const directive = ['', '.byte', '.short', '', '.long', '', '', '', '.quad'][ty.elemSize];
    let emitted = 0;
    const emitValue = (e: Expr) => {
      if (elem === 'f64' || elem === 'f32') {
        const v = e.k === 'float' ? e.v : e.k === 'num' ? Number(e.v) : this.err('expected a number', e.t);
        out.push(elem === 'f64' ? `    .quad ${f64bits(v)} // ${v}` : `    .long ${f32bits(v)} // ${v}`);
      } else if (e.k === 'str' || e.k === 'addr' || (e.k === 'name' && this.isAddressName(e.name))) {
        if (ty.elemSize !== 8) this.err('pointers need 8-byte elements (use ptr)', e.t);
        out.push(`    .quad ${this.staticAddress(e)}`);
      } else {
        const v = this.constEval(e);
        if (v === null) this.err('data initializer must be constant', e.t);
        out.push(`    ${directive} ${fmtData(v, ty.elemSize)}`);
      }
      emitted += ty.elemSize;
    };
    if (it.init.k === 'expr' && it.init.e.k === 'str' && elem === 'u8' || elem === 'i8' && it.init.k === 'expr' && it.init.e.k === 'str') {
      const bytes = (it.init.e as Extract<Expr, { k: 'str' }>).bytes;
      if (bytes.length + 1 <= sym.size) {
        out.push(`    .asciz ${asmString(bytes)}`);
        emitted = bytes.length + 1;
      } else if (bytes.length === sym.size) {
        out.push(`    .ascii ${asmString(bytes)}`);
        emitted = bytes.length;
      } else this.err(`string does not fit into ${sym.size} bytes`, it.t);
    } else if (it.init.k === 'list') {
      if (ty.count !== null && it.init.items.length > ty.count) this.err('too many initializers', it.t);
      for (const e of it.init.items) emitValue(e);
    } else {
      if (ty.count !== null) {
        // fill every element with the same value
        for (let i = 0; i < ty.count; i++) emitValue(it.init.e);
      } else emitValue(it.init.e);
    }
    if (emitted < sym.size) out.push(`    .space ${sym.size - emitted}`);
  }

  isPointerInit(e: Expr): boolean {
    return e.k === 'addr' || (e.k === 'name' && this.isAddressName(e.name));
  }

  isAddressName(name: string): boolean {
    const s = this.globals.get(name);
    return !!s && (s.k === 'fn' || (s.k === 'data' && s.ty.count !== null));
  }

  staticAddress(e: Expr): string {
    if (e.k === 'str') return this.cstring(e.bytes);
    const inner = e.k === 'addr' ? e.e : e;
    if (inner.k !== 'name') this.err('only &name is supported in static initializers', e.t);
    const s = this.globals.get(inner.name);
    if (!s || (s.k !== 'data' && s.k !== 'fn' && s.k !== 'extern')) this.err(`'${inner.name}' is not a global symbol`, e.t);
    if (s.k === 'extern') this.err('addresses of extern symbols are not supported in data', e.t);
    return s.label;
  }

  cstring(bytes: number[]): string {
    const key = bytes.join(',');
    let l = this.cstringMap.get(key);
    if (!l) {
      l = `${this.localPrefix}str.${this.cstringMap.size}`;
      this.cstringMap.set(key, l);
      this.cstrings.push(`${l}:`, `    .asciz ${asmString(bytes)}`);
    }
    return l;
  }

  fpLiteral(v: number, bits: 32 | 64): string {
    const key = bits + ':' + v;
    let l = this.fpLits.get(key);
    if (!l) {
      l = `${this.localPrefix}fp.${this.fpLits.size}`;
      this.fpLits.set(key, l);
      if (!this.literal8.length) this.literal8.push('.p2align 3');
      this.literal8.push(`${l}:`, bits === 64 ? `    .quad ${f64bits(v)} // ${v}` : `    .long ${f32bits(v)}`, ...(bits === 32 ? ['    .long 0'] : []));
    }
    return l;
  }

  // ======================================================================
  // constants
  // ======================================================================
  constEval(e: Expr): bigint | null {
    switch (e.k) {
      case 'num': return e.v;
      case 'name': {
        const s = this.lookup(e.name);
        return s && s.k === 'const' ? s.v : null;
      }
      case 'un': {
        const v = this.constEval(e.e);
        if (v === null) return null;
        return e.op === '-' ? -v : e.op === '~' ? ~v : (v === 0n ? 1n : 0n);
      }
      case 'bin': {
        const l = this.constEval(e.l);
        if (l === null) return null;
        const r = this.constEval(e.r);
        if (r === null) return null;
        switch (e.op) {
          case '+': return l + r;
          case '-': return l - r;
          case '*': return l * r;
          case '/': if (r === 0n) this.err('division by zero', e.t); return l / r;
          case '%': if (r === 0n) this.err('division by zero', e.t); return l % r;
          case '&': return l & r;
          case '|': return l | r;
          case '^': return l ^ r;
          case '<<': return toS64(l << r);
          case '>>': return l >> r;
          case '>>>': return (l & ((1n << 64n) - 1n)) >> r;
          case '==': return l === r ? 1n : 0n;
          case '!=': return l !== r ? 1n : 0n;
          case '<': return l < r ? 1n : 0n;
          case '<=': return l <= r ? 1n : 0n;
          case '>': return l > r ? 1n : 0n;
          case '>=': return l >= r ? 1n : 0n;
          case '&&': return l && r ? 1n : 0n;
          case '||': return l || r ? 1n : 0n;
        }
        return null;
      }
      case 'tern': {
        const c = this.constEval(e.c);
        if (c === null) return null;
        return this.constEval(c ? e.a : e.b);
      }
      case 'call': {
        if (e.name === 'sizeof' || e.name === 'len') {
          if (e.args.length !== 1) return null;
          return this.sizeofExpr(e.args[0], e.name === 'len', e.t);
        }
        if (e.name === 'offsetof') return null;
        return null;
      }
    }
    return null;
  }

  sizeofExpr(a: Expr, len: boolean, t: Token): bigint {
    if (a.k === 'name') {
      if (MEM_TYPES.includes(a.name)) return BigInt(memSize(a.name as MemType));
      const s = this.lookup(a.name);
      if (s?.k === 'struct') return BigInt(s.info.size);
      if (s?.k === 'data' || s?.k === 'local') {
        if (len) {
          if (s.ty.count === null) return 1n;
          return BigInt(s.ty.isString ? s.ty.count - 1 : s.ty.count);
        }
        return BigInt(s.size);
      }
      if (s?.k === 'alias') return BigInt(this.regBytes(s.reg));
    }
    if (a.k === 'str') return BigInt(len ? a.bytes.length : a.bytes.length + 1);
    return this.err(`cannot take ${len ? 'len' : 'sizeof'} of this expression`, t);
  }

  // ======================================================================
  // scopes
  // ======================================================================
  lookup(name: string): Sym | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const s = this.scopes[i].get(name);
      if (s) return s;
    }
    return this.globals.get(name);
  }

  pushScope(): Map<string, Sym> {
    const m = new Map<string, Sym>();
    this.scopes.push(m);
    return m;
  }

  popScope(): void {
    const m = this.scopes.pop()!;
    for (const [name, s] of m) {
      if (s.k === 'alias' && (s as { auto?: number }).auto !== undefined) {
        this.fn!.autoInUse.delete((s as { auto?: number }).auto!);
      }
      void name;
    }
  }

  allocAuto(t: Token, bits: 32 | 64 = 64): { reg: string; n: number } {
    return this.tryAllocAuto(bits) ?? this.err(`no free callee-saved registers left (${this.autoPool().map((n) => this.autoRegName(n, 64)).join(', ')}); reuse a variable, use local, or name a register`, t);
  }

  tryAllocAuto(bits: 32 | 64 = 64): { reg: string; n: number } | null {
    const f = this.fn!;
    for (const n of this.autoPool()) {
      if (f.autoInUse.has(n) || f.autoAvoid.has(n)) continue;
      f.autoInUse.add(n);
      return { reg: this.autoRegName(n, bits), n };
    }
    return null;
  }

  /** `let` without a register when every callee-saved register is taken: a 64-bit slot in the frame */
  spillVar(name: string, unsigned: boolean, t: Token): void {
    this.declareLocal({ k: 'local', name, ty: { name: unsigned ? 'u64' : 'i64', count: null, t }, t });
    const s = this.scopes[this.scopes.length - 1].get(name) as Extract<Sym, { k: 'local' }>;
    s.spilled = true;
  }

  /** a register variable, or false when it was spilled to the frame (no free register) */
  isSpilled(name: string): boolean {
    const s = this.lookup(name);
    return s?.k === 'local' && !!s.spilled;
  }

  /** a scalar in the frame or in the data section: its address does not depend on registers a call clobbers */
  fixedAddress(e: Expr): boolean {
    if (e.k !== 'name') return false;
    const s = this.lookup(e.name);
    return (s?.k === 'local' || s?.k === 'data') && s.ty.count === null && !!s.ty.elem;
  }

  defineAlias(d: { name: string; reg: string | null; unsigned: boolean; t: Token }): string {
    const scope = this.scopes[this.scopes.length - 1];
    let reg: string;
    let auto: number | undefined;
    if (!d.reg || d.reg === 'auto') {
      const a = this.allocAuto(d.t);
      reg = a.reg;
      auto = a.n;
    } else {
      reg = this.canonReg(d.reg)!;
    }
    const sym = { k: 'alias' as const, reg, unsigned: d.unsigned, auto };
    scope.set(d.name, sym);
    this.emit(`// ${d.name} -> ${reg}`);
    return reg;
  }

  // ======================================================================
  // functions
  // ======================================================================
  emit(line: string): void {
    if (line.startsWith('//') || line.endsWith(':')) this.fn!.lines.push(line);
    else this.fn!.lines.push('    ' + line);
  }

  newLabel(kind: string): string {
    return `${this.localPrefix}${this.fn!.name}.${kind}${this.labelN++}`;
  }

  label(l: string): void {
    this.fn!.lines.push(`${l}:`);
  }

  collectLabels(body: Stmt[]): void {
    for (const s of body) {
      if (s.k === 'label') {
        if (this.fn!.labels.has(s.name)) this.err(`duplicate label '${s.name}'`, s.t);
        this.fn!.labels.set(s.name, `${this.localPrefix}${this.fn!.name}.${s.name}`);
      }
      for (const key of ['body', 'els', 'init', 'step'] as const) {
        const v = (s as Record<string, unknown>)[key];
        if (Array.isArray(v)) this.collectLabels(v as Stmt[]);
      }
      if (s.k === 'if') for (const a of s.arms) this.collectLabels(a.body);
    }
  }

  // ======================================================================
  // statements
  // ======================================================================
  genBlock(body: Stmt[], scope = true): void {
    if (scope) this.pushScope();
    for (const s of body) this.genStmt(s);
    if (scope) this.popScope();
  }

  genStmt(s: Stmt): void {
    this.resetTemps();
    switch (s.k) {
      case 'let':
        for (const d of s.decls) this.genLet(d);
        break;
      case 'const': {
        const v = this.constEval(s.e);
        if (v === null) this.err('constant must be a compile-time expression', s.t);
        this.scopes[this.scopes.length - 1].set(s.name, { k: 'const', v });
        break;
      }
      case 'local': this.declareLocal(s); break;
      case 'assign': this.genAssign(s.target, s.op, s.value, s.t); break;
      case 'incdec': this.genAssign(s.target, s.op === '++' ? '+=' : '-=', { k: 'num', v: 1n, t: s.t }, s.t); break;
      case 'expr': {
        const e = s.e;
        if (e.k !== 'call') this.err('expression statement must be a call', s.t);
        this.genCall(e);
        break;
      }
      case 'block': this.genBlock(s.body); break;
      case 'if': this.genIf(s); break;
      case 'while': {
        const l = this.loopLabels(s.label);
        this.jump(l.cont);
        const body = this.newLabel('body');
        this.label(body);
        this.withLoop(l, () => this.genBlock(s.body));
        this.label(l.cont);
        this.genBranch(s.cond, body, true);
        this.label(l.brk);
        break;
      }
      case 'dowhile': {
        const l = this.loopLabels(s.label);
        const body = this.newLabel('body');
        this.label(body);
        this.withLoop(l, () => this.genBlock(s.body));
        this.label(l.cont);
        this.genBranch(s.cond, body, true);
        this.label(l.brk);
        break;
      }
      case 'loop': {
        const l = this.loopLabels(s.label);
        this.label(l.cont);
        this.withLoop(l, () => this.genBlock(s.body));
        this.jump(l.cont);
        this.label(l.brk);
        break;
      }
      case 'for': this.genFor(s); break;
      case 'forin': this.genForIn(s); break;
      case 'break': case 'continue': {
        const loops = this.fn!.loops;
        let target: LoopCtx | undefined;
        if (s.label) target = [...loops].reverse().find((l) => l.label === s.label);
        else target = loops[loops.length - 1];
        if (!target) this.err(s.label ? `no enclosing loop labelled '${s.label}'` : `'${s.k}' outside of a loop`, s.t);
        this.jump(s.k === 'break' ? target.brk : target.cont);
        break;
      }
      case 'return': this.genReturn(s); break;
      case 'goto': {
        const l = this.fn!.labels.get(s.label);
        if (!l) this.err(`unknown label '${s.label}'`, s.t);
        this.jump(l);
        break;
      }
      case 'label': this.label(this.fn!.labels.get(s.name)!); break;
      case 'asm':
        for (const l of s.lines) {
          const txt = this.rawText(l, s.t);
          if (!this.fn!.naked && /^(\d+:\s*)?ret\b/.test(txt)) {
            this.warnings.push(`line ${l.line}: 'ret' in a function with a prologue skips the epilogue (stack and saved registers are not restored); use 'return' or make the function naked`);
          }
          if (/^[A-Za-z_.$][\w.$]*:$/.test(txt) || txt.startsWith('.')) this.fn!.lines.push(txt);
          else this.emit(txt);
        }
        break;
      case 'asmtext':
        for (const l of s.text.split('\n')) this.emit(l.trim());
        break;
      case 'push': case 'pop': this.genPushPop(s); break;
    }
  }

  genLet(d: LetDecl): void {
    // evaluate the initializer before the alias becomes visible: `let x = x + 1` shadows
    if (d.init && d.reg && d.reg !== 'auto') {
      const reg = this.defineAlias(d);
      this.genInto(d.init, reg);
      return;
    }
    if (!d.reg || d.reg === 'auto') {
      const a = this.tryAllocAuto();
      if (!a) {
        // spilled: declared under a hidden name first, so `let x = x + 1` still reads the outer x
        const scope = this.scopes[this.scopes.length - 1];
        const hidden = `$spill.${d.name}`;
        this.spillVar(hidden, d.unsigned, d.t);
        if (d.init) this.genAssign({ k: 'name', name: hidden, t: d.t }, '=', d.init, d.t);
        scope.set(d.name, scope.get(hidden)!);
        scope.delete(hidden);
        this.emit(`// ${d.name} -> frame (all callee-saved registers are taken)`);
        return;
      }
      this.fn!.autoInUse.delete(a.n);
    }
    if (d.init && (!d.reg || d.reg === 'auto')) {
      const s = this.scopes[this.scopes.length - 1];
      // allocate first, then evaluate (the new register is not referenced by init)
      const reg = this.defineAlias(d);
      const sym = s.get(d.name)!;
      s.delete(d.name);
      this.genInto(d.init, reg);
      s.set(d.name, sym);
      return;
    }
    this.defineAlias(d);
  }

  genInto(e: Expr, reg: string): void {
    if (this.isFp(reg)) this.genFExpr(e, reg);
    else this.genExpr(e, reg);
  }

  loopLabels(label: string | null): LoopCtx {
    return { brk: this.newLabel('end'), cont: this.newLabel('next'), label };
  }

  withLoop(l: LoopCtx, f: () => void): void {
    this.fn!.loops.push(l);
    f();
    this.fn!.loops.pop();
  }

  genIf(s: Extract<Stmt, { k: 'if' }>): void {
    const end = this.newLabel('endif');
    s.arms.forEach((arm, i) => {
      const last = i === s.arms.length - 1 && !s.els;
      const next = last ? end : this.newLabel('else');
      this.genBranch(arm.cond, next, false);
      this.genBlock(arm.body);
      if (!last) {
        if (!endsWithJump(arm.body)) this.jump(end);
        this.label(next);
      }
    });
    if (s.els) this.genBlock(s.els);
    this.label(end);
  }

  genFor(s: Extract<Stmt, { k: 'for' }>): void {
    this.pushScope();
    for (const st of s.init) this.genStmt(st);
    const l = this.loopLabels(s.label);
    const cond = this.newLabel('cond');
    const body = this.newLabel('body');
    this.jump(cond);
    this.label(body);
    this.withLoop(l, () => this.genBlock(s.body));
    this.label(l.cont);
    for (const st of s.step) this.genStmt(st);
    this.label(cond);
    if (s.cond) this.genBranch(s.cond, body, true);
    else this.jump(body);
    this.label(l.brk);
    this.popScope();
  }

  genForIn(s: Extract<Stmt, { k: 'forin' }>): void {
    this.pushScope();
    let sym = this.lookup(s.v);
    const reuse = !s.reg && sym && (sym.k === 'alias' || (sym.k === 'local' && sym.spilled));
    if (!reuse) {
      const free = s.reg ? null : this.tryAllocAuto();
      if (free) this.fn!.autoInUse.delete(free.n);
      if (!s.reg && !free) { this.spillVar(s.v, false, s.t); this.emit(`// ${s.v} -> frame (all callee-saved registers are taken)`); }
      else this.defineAlias({ name: s.v, reg: s.reg, unsigned: false, t: s.t });
      sym = this.lookup(s.v)!;
    }
    // a spilled loop variable lives in the frame: plain assignments and comparisons through memory
    const iv = sym!.k === 'alias' ? sym!.reg : null;
    const v: Expr = { k: 'name', name: s.v, t: s.t };
    let step = 1n;
    if (s.step) {
      const st = this.constEval(s.step);
      if (st === null || st === 0n) this.err('step must be a non-zero constant', s.t);
      step = st;
    }
    // upper bound: constant, register, or computed once into a hidden register (or frame slot)
    let bound: Expr = s.to;
    if (this.constEval(s.to) === null && this.operand(s.to) === null) {
      const hidden = this.tryAllocAuto();
      const name = '$bound';   // the loop has its own scope
      if (hidden) {
        this.scopes[this.scopes.length - 1].set(name, { k: 'alias', reg: hidden.reg, unsigned: false, auto: hidden.n } as Sym);
        this.genExpr(s.to, hidden.reg);
      } else {
        this.spillVar(name, false, s.t);
        this.genAssign({ k: 'name', name, t: s.t }, '=', s.to, s.t);
      }
      bound = { k: 'name', name, t: s.t };
    }
    this.resetTemps();
    if (iv) this.genExpr(s.from, iv);
    else this.genAssign(v, '=', s.from, s.t);
    const l = this.loopLabels(s.label);
    const cond = this.newLabel('cond');
    const body = this.newLabel('body');
    this.jump(cond);
    this.label(body);
    this.withLoop(l, () => this.genBlock(s.body));
    this.label(l.cont);
    this.resetTemps();   // nothing is live between the steps of the loop
    if (iv) this.genBinary('+', v, { k: 'num', v: step, t: s.t }, iv, s.t);
    else this.genAssign(v, '+=', { k: 'num', v: step, t: s.t }, s.t);
    this.label(cond);
    const op: BinOp = step > 0n ? (s.inclusive ? '<=' : '<') : (s.inclusive ? '>=' : '>');
    this.resetTemps();
    this.genBranch({ k: 'bin', op, l: { k: 'name', name: s.v, t: s.t }, r: bound, t: s.t }, body, true);
    this.label(l.brk);
    this.popScope();
  }

  // ======================================================================
  // raw assembler lines with alias substitution
  // ======================================================================
  rawText(l: RawLine, t: Token): string {
    let out = '';
    let prev: Token | null = null;
    l.parts.forEach(({ gap, tok }, idx) => {
      out += gap;
      let text = tok.kind === 'str' ? tok.text : tok.text;
      // no substitution in b.eq / sym@PAGE / numeric label references like 1b, 2f
      const glued = prev && gap === '' && (prev.text === '.' || prev.text === '@' || prev.kind === 'num');
      // the first word is the mnemonic (b, add, ...), never a name to substitute
      const mnemonic = idx === 0 && !(l.parts[1]?.tok.text === ':' && l.parts[1].gap === '');
      if (tok.kind === 'ident' && !glued && !mnemonic) {
        const s = this.lookup(tok.text);
        const lab = this.fn?.labels.get(tok.text);
        if (lab) text = lab;
        else if (s) {
          if (s.k === 'alias') text = s.reg;
          else if (s.k === 'const') text = s.v.toString();
          else if (s.k === 'data' || s.k === 'fn' || s.k === 'extern') text = s.label;
          else if (s.k === 'local' && s.spilled) this.err(`'${tok.text}' has no register (all callee-saved registers are taken, it lives in the frame): name a register for it to use it in asm`, tok);
          else if (s.k === 'local') text = `${s.off}`;
        }
      }
      out += text;
      prev = tok;
    });
    void t;
    return out.trim();
  }

  // ======================================================================
  // operands and helpers
  // ======================================================================
  /** Simple operand: an immediate or a register, without emitting code. */
  operand(e: Expr): Operand | null {
    const c = this.constEval(e);
    if (c !== null) return { k: 'imm', v: c };
    if (e.k === 'name') {
      const s = this.lookup(e.name);
      if (s?.k === 'alias') return { k: 'reg', r: s.reg };
      if (!s) {
        const r = this.canonReg(e.name);
        if (r) return { k: 'reg', r };
      }
    }
    return null;
  }

  isUnsigned(e: Expr): boolean {
    switch (e.k) {
      case 'name': {
        const s = this.lookup(e.name);
        if (s?.k === 'alias') return s.unsigned;
        if ((s?.k === 'data' || s?.k === 'local') && s.ty.elem) return s.ty.elem[0] === 'u' || s.ty.elem === 'ptr';
        return false;
      }
      case 'mem': return !!e.ty && (e.ty[0] === 'u' || e.ty === 'ptr');
      case 'index': {
        const s = this.lookup(e.name);
        return (s?.k === 'data' || s?.k === 'local') && !!s.ty.elem && s.ty.elem[0] === 'u';
      }
      case 'bin': return this.isUnsigned(e.l) || this.isUnsigned(e.r);
      case 'un': return this.isUnsigned(e.e);
      case 'call': return ['umin', 'umax', 'zext8', 'zext16', 'zext32'].includes(e.name);
    }
    return false;
  }

  hasCall(e: Expr): boolean {
    switch (e.k) {
      case 'call': return !this.builtins.has(e.name) || e.name === 'syscall' || e.args.some((a) => this.hasCall(a));
      case 'un': return this.hasCall(e.e);
      case 'bin': return this.hasCall(e.l) || this.hasCall(e.r);
      case 'tern': return this.hasCall(e.c) || this.hasCall(e.a) || this.hasCall(e.b);
      case 'index': return this.hasCall(e.index);
      case 'mem': return this.hasCall(e.addr);
      case 'addr': return this.hasCall(e.e);
    }
    return false;
  }

  /** Registers (by number) an expression reads. */
  readsRegs(e: Expr, out = new Set<number>()): Set<number> {
    switch (e.k) {
      case 'name': {
        const op = this.operand(e);
        if (op?.k === 'reg' && !this.isFp(op.r)) out.add(this.regNum(op.r));
        break;
      }
      case 'un': this.readsRegs(e.e, out); break;
      case 'bin': this.readsRegs(e.l, out); this.readsRegs(e.r, out); break;
      case 'tern': this.readsRegs(e.c, out); this.readsRegs(e.a, out); this.readsRegs(e.b, out); break;
      case 'call': for (const a of e.args) this.readsRegs(a, out); break;
      case 'index': this.readsRegs(e.index, out); break;
      case 'mem': this.readsRegs(e.addr, out); break;
      case 'addr': this.readsRegs(e.e, out); break;
    }
    return out;
  }

  readsReg(e: Expr, r: string): boolean {
    return this.readsRegs(e).has(this.regNum(r));
  }

  isUserFn(name: string): boolean {
    const s = this.lookup(name);
    return !!s && (s.k === 'fn' || s.k === 'extern');
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
export function alignUp(v: number, a: number): number {
  return Math.ceil(v / a) * a;
}

export function log2(v: bigint): number {
  let n = 0;
  while (v > 1n) { v >>= 1n; n++; }
  return n;
}

export function typeSize(ty: VarType): number {
  return ty.elemSize * (ty.count ?? 1);
}

export function endsWithJump(body: Stmt[]): boolean {
  const last = body[body.length - 1];
  return !!last && (last.k === 'return' || last.k === 'break' || last.k === 'continue' || last.k === 'goto');
}

export function asmString(bytes: number[]): string {
  let s = '"';
  for (const b of bytes) {
    if (b === 34) s += '\\"';
    else if (b === 92) s += '\\\\';
    else if (b === 10) s += '\\n';
    else if (b === 9) s += '\\t';
    else if (b >= 32 && b < 127) s += String.fromCharCode(b);
    else s += '\\' + b.toString(8).padStart(3, '0');
  }
  return s + '"';
}

export function fmtData(v: bigint, size: number): string {
  const bits = BigInt(size * 8);
  const u = BigInt.asUintN(Number(bits), v);
  return u > 9n ? '0x' + u.toString(16) : u.toString();
}

export function f64bits(v: number): string {
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, v);
  return '0x' + b.getBigUint64(0).toString(16).padStart(16, '0');
}

export function f32bits(v: number): string {
  const b = new DataView(new ArrayBuffer(4));
  b.setFloat32(0, v);
  return '0x' + b.getUint32(0).toString(16).padStart(8, '0');
}

// HLA64 recursive-descent parser.
import { lex, CompileError, type Token } from './lexer.ts';
import { MEM_TYPES, type BinOp, type DataInit, type Expr, type Item, type LetDecl, type MemType, type Param,
  type Program, type RawLine, type Stmt, type TypeRef } from './ast.ts';
import { isReg as armIsReg } from './registers.ts';

// `in` and `step` are contextual: special only in a `for ... in ... step` header
const KEYWORDS = new Set([
  'fn', 'function', 'export', 'naked', 'extern', 'const', 'data', 'rodata', 'struct', 'enum', 'alias',
  'let', 'var', 'if', 'else', 'elif', 'while', 'do', 'loop', 'for', 'break', 'continue',
  'return', 'goto', 'asm', 'push', 'pop', 'local', 'unsigned', 'set', 'call', 'auto', 'switch',
]);

// Go-style precedence: bitwise operators bind tighter than comparisons,
// so `x & 1 == 0` means `(x & 1) == 0`.
const PREC: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3, '!=': 3, '<': 3, '<=': 3, '>': 3, '>=': 3,
  '+': 4, '-': 4, '|': 4, '^': 4,
  '*': 5, '/': 5, '%': 5, '<<': 5, '>>': 5, '>>>': 5, '&': 5,
};

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=']);

export interface ParseOptions {
  /** register names of the target (default: AArch64) */
  isReg?: (text: string) => boolean;
}

export function parse(src: string, opts: ParseOptions = {}): Program {
  return new Parser(src, opts.isReg ?? armIsReg).program();
}

class Parser {
  toks: Token[];
  pos = 0;
  src: string;
  switches = 0;

  isReg: (text: string) => boolean;

  constructor(src: string, isReg: (text: string) => boolean) {
    this.src = src;
    this.isReg = isReg;
    this.toks = lex(src);
  }

  // ----------------------------------------------------------------- helpers
  get cur(): Token { return this.toks[this.pos]; }
  peek(n = 1): Token { return this.toks[Math.min(this.pos + n, this.toks.length - 1)]; }
  next(): Token { const t = this.toks[this.pos]; if (t.kind !== 'eof') this.pos++; return t; }
  is(text: string, t: Token = this.cur): boolean { return (t.kind === 'op' || t.kind === 'ident') && t.text === text; }
  isOp(text: string, t: Token = this.cur): boolean { return t.kind === 'op' && t.text === text; }

  err(msg: string, t: Token = this.cur): never {
    throw new CompileError(msg, t.line, t.col);
  }

  accept(text: string): Token | null {
    if (this.is(text)) return this.next();
    return null;
  }

  expect(text: string, what?: string): Token {
    if (this.is(text)) return this.next();
    return this.err(`expected '${text}'${what ? ' ' + what : ''}, found '${this.cur.text}'`);
  }

  ident(what = 'identifier'): Token {
    const t = this.cur;
    if (t.kind !== 'ident') this.err(`expected ${what}, found '${t.text}'`);
    return this.next();
  }

  /** Dotted name: Point.x, Color.Red */
  dottedName(): Token {
    const first = this.ident('name');
    let text = first.text;
    while (this.isOp('.') && this.cur.start === this.toks[this.pos - 1].end && this.peek().kind === 'ident'
      && this.peek().start === this.cur.end) {
      this.next();
      text += '.' + this.next().text;
    }
    return { ...first, text };
  }

  /** End of a simple statement: ';' or newline or '}' or EOF. */
  endStmt(): void {
    if (this.accept(';')) return;
    if (this.cur.nl || this.isOp('}') || this.cur.kind === 'eof') return;
    this.err(`unexpected '${this.cur.text}' (expected end of statement)`);
  }

  skipSemis(): void {
    while (this.isOp(';')) this.next();
  }

  // ----------------------------------------------------------------- program
  program(): Program {
    const items: Item[] = [];
    this.skipSemis();
    while (this.cur.kind !== 'eof') {
      items.push(...this.item());
      this.skipSemis();
    }
    return { items };
  }

  item(): Item[] {
    const t = this.cur;
    if (t.kind !== 'ident') this.err(`unexpected '${t.text}' at top level`);
    switch (t.text) {
      case 'export': {
        // export fn | data | rodata | struct | enum | const
        const what = this.peek();
        if (what.kind === 'ident' && ['data', 'rodata', 'struct', 'enum', 'const'].includes(what.text)) {
          this.next();
          const items = this.item();
          for (const it of items) (it as { exported?: boolean }).exported = true;
          return items;
        }
        return [this.fnItem()];
      }
      case 'naked': case 'fn': case 'function':
        return [this.fnItem()];
      case 'extern': return this.externItem();
      case 'const': {
        this.next();
        const out: Item[] = [];
        do {
          const name = this.dottedName();
          if (this.accept(':')) this.typeRef();
          this.expect('=');
          out.push({ k: 'const', name: name.text, e: this.expr(), t: name });
        } while (this.accept(','));
        this.endStmt();
        return out;
      }
      case 'data': case 'rodata': return [this.dataItem()];
      case 'struct': return [this.structItem()];
      case 'enum': return [this.enumItem()];
      case 'alias': case 'let': case 'var': {
        const s = this.letStmt();
        if (s.k !== 'let') this.err('unexpected');
        return s.decls.map((decl) => ({ k: 'alias', decl }) as Item);
      }
      case 'asm': {
        const s = this.asmStmt();
        if (s.k === 'asm') return [{ k: 'asm', lines: s.lines, t: s.t }];
        return [{ k: 'asm', lines: [], t: s.t }];
      }
      default:
        return this.err(`unexpected '${t.text}' at top level (expected fn, data, const, extern, struct...)`);
    }
  }

  fnItem(): Item {
    let exported = false, naked = false;
    while (this.is('export') || this.is('naked')) {
      if (this.next().text === 'export') exported = true; else naked = true;
    }
    if (!this.accept('fn') && !this.accept('function')) this.err("expected 'fn'");
    const name = this.ident('function name');
    const params: Param[] = [];
    if (this.accept('(')) {
      while (!this.isOp(')')) {
        const unsigned = !!this.accept('unsigned');
        const p = this.ident('parameter name');
        let reg: string | null = null;
        let ty: MemType | null = null;
        if (this.accept(':')) {
          // `n: x19` / `n: auto` choose a register; `n: i32` / `p: ptr` give a C type
          const r = this.ident('register, auto or type');
          if (MEM_TYPES.includes(r.text)) ty = r.text as MemType;
          else if (r.text !== 'auto' && !this.isReg(r.text)) this.err(`'${r.text}' is not a register or a type`, r);
          else reg = r.text.toLowerCase();
        }
        params.push({ name: p.text, reg, ty, unsigned: unsigned || (!!ty && (ty[0] === 'u' || ty === 'ptr')), t: p });
        if (!this.accept(',')) break;
      }
      this.expect(')');
    }
    let ret: string | null = null;
    if (this.accept('->')) {
      const r = this.ident('result type');
      if (!MEM_TYPES.includes(r.text) && r.text !== 'void' && !this.isReg(r.text)) this.err(`'${r.text}' is not a type`, r);
      ret = r.text.toLowerCase();
    }
    const body = this.block();
    return { k: 'fn', name: name.text, params, body, exported, naked, ret, t: name, end: this.toks[this.pos - 1] };
  }

  externItem(): Item[] {
    this.next();
    this.accept('fn');
    const out: Item[] = [];
    do {
      const name = this.ident('extern name');
      let fixed: number | null = null;
      if (this.accept('(')) {
        let n = 0;
        let variadic = false;
        while (!this.isOp(')')) {
          if (this.accept('...')) { variadic = true; break; }
          this.ident('parameter name');
          if (this.accept(':')) this.ident();
          n++;
          if (!this.accept(',')) break;
        }
        this.expect(')');
        if (variadic) fixed = n;
      }
      out.push({ k: 'extern', name: name.text, fixed, t: name });
    } while (this.accept(','));
    this.endStmt();
    return out;
  }

  typeRef(): TypeRef {
    const t = this.ident('type');
    let count: Expr | null = null;
    if (this.isOp('[') && !this.cur.nl) {
      this.next();
      count = this.expr();
      this.expect(']');
    }
    return { name: t.text, count, t };
  }

  dataItem(): Item {
    const ro = this.next().text === 'rodata';
    const name = this.ident('data name');
    if (this.isReg(name.text)) this.err(`'${name.text}' is a register name`, name);
    let ty: TypeRef | null = null;
    if (this.accept(':')) ty = this.typeRef();
    let init: DataInit | null = null;
    if (this.accept('=')) {
      if (this.isOp('[')) {
        this.next();
        const items: Expr[] = [];
        this.skipNl();
        while (!this.isOp(']')) {
          items.push(this.expr());
          if (!this.accept(',')) break;
        }
        this.expect(']');
        init = { k: 'list', items };
      } else {
        init = { k: 'expr', e: this.expr() };
      }
    }
    this.endStmt();
    return { k: 'data', name: name.text, ty, init, ro, t: name };
  }

  skipNl(): void { /* newlines are not tokens; nothing to skip */ }

  structItem(): Item {
    const t = this.next();
    const name = this.ident('struct name');
    this.expect('{');
    const fields: { name: string; ty: TypeRef }[] = [];
    while (!this.isOp('}')) {
      const f = this.ident('field name');
      this.expect(':');
      fields.push({ name: f.text, ty: this.typeRef() });
      if (!this.accept(',') && !this.accept(';') && !this.cur.nl && !this.isOp('}')) this.err("expected ',' or newline");
    }
    this.expect('}');
    return { k: 'struct', name: name.text, fields, t };
  }

  enumItem(): Item {
    const t = this.next();
    const name = this.ident('enum name');
    this.expect('{');
    const members: { name: string; e: Expr | null; t: Token }[] = [];
    while (!this.isOp('}')) {
      const m = this.ident('enum member');
      let e: Expr | null = null;
      if (this.accept('=')) e = this.expr();
      members.push({ name: m.text, e, t: m });
      if (!this.accept(',') && !this.accept(';') && !this.cur.nl && !this.isOp('}')) this.err("expected ',' or newline");
    }
    this.expect('}');
    return { k: 'enum', name: name.text, members, t };
  }

  // ----------------------------------------------------------------- statements
  block(): Stmt[] {
    this.expect('{', 'to open a block');
    const body: Stmt[] = [];
    this.skipSemis();
    while (!this.isOp('}')) {
      if (this.cur.kind === 'eof') this.err("unexpected end of file: missing '}'");
      body.push(this.stmt());
      this.skipSemis();
    }
    this.expect('}');
    return body;
  }

  stmt(): Stmt {
    const t = this.cur;
    if (this.isOp('{')) return { k: 'block', body: this.block(), t };
    if (this.isOp('[')) return this.assignStmt();
    // numeric local label of the assembler: `1:  mov x0, #1`
    if (t.kind === 'num' && this.isOp(':', this.peek()) && this.peek().start === t.end) return this.rawLine();
    if (t.kind !== 'ident') this.err(`unexpected '${t.text}'`);

    // label:  (optionally naming the loop that follows)
    if (this.isOp(':', this.peek()) && !KEYWORDS.has(t.text) && !this.isReg(t.text)) {
      this.next(); this.next();
      if (this.isLoopStart()) {
        const loop = this.stmt();
        (loop as { label: string | null }).label = t.text;
        return { k: 'block', body: [{ k: 'label', name: t.text, t }, loop], t };
      }
      return { k: 'label', name: t.text, t };
    }

    switch (t.text) {
      case 'let': case 'var': case 'alias': return this.letStmt();
      case 'set': this.next(); return this.assignStmt();
      case 'call': {
        // `call name(args)` is the hlaa64 call statement; `call puts`, `call rax` are x86-64 instructions
        const n1 = this.peek(), n2 = this.peek(2);
        if (n1.nl || n1.kind !== 'ident' || n2.nl || !this.isOp('(', n2)) return this.rawLine();
        this.next(); const e = this.expr(); this.endStmt(); return { k: 'expr', e, t };
      }
      case 'if': return this.ifStmt();
      case 'switch': return this.switchStmt();
      case 'while': {
        this.next();
        const cond = this.expr();
        return { k: 'while', cond, body: this.block(), label: null, t };
      }
      case 'do': {
        this.next();
        const body = this.block();
        this.expect('while');
        const cond = this.expr();
        this.endStmt();
        return { k: 'dowhile', body, cond, label: null, t };
      }
      case 'loop': this.next(); return { k: 'loop', body: this.block(), label: null, t };
      case 'for': return this.forStmt();
      case 'break': case 'continue': {
        this.next();
        let label: string | null = null;
        if (this.cur.kind === 'ident' && !this.cur.nl) label = this.next().text;
        this.endStmt();
        return { k: t.text as 'break' | 'continue', label, t };
      }
      case 'return': {
        this.next();
        let e: Expr | null = null;
        if (!this.cur.nl && !this.isOp(';') && !this.isOp('}') && this.cur.kind !== 'eof') e = this.expr();
        this.endStmt();
        return { k: 'return', e, t };
      }
      case 'goto': {
        this.next();
        const l = this.ident('label');
        this.endStmt();
        return { k: 'goto', label: l.text, t };
      }
      case 'asm': return this.asmStmt();
      case 'push': case 'pop': {
        this.next();
        const regs: Expr[] = [];
        do regs.push(this.primary()); while (this.accept(','));
        this.endStmt();
        return { k: t.text as 'push' | 'pop', regs, t };
      }
      case 'local': {
        // local name: type[N] | local name: type = init | local name = init (i64)
        this.next();
        const name = this.ident('local name');
        let ty: TypeRef = { name: 'i64', count: null, t: name };
        if (this.accept(':')) ty = this.typeRef();
        else if (!this.is('=')) this.expect(':');
        const init = this.accept('=') ? this.expr() : null;
        this.endStmt();
        return { k: 'local', name: name.text, ty, init, t: name };
      }
      case 'const': {
        this.next();
        const name = this.ident('constant name');
        this.expect('=');
        const e = this.expr();
        this.endStmt();
        return { k: 'const', name: name.text, e, t: name };
      }
    }

    // assignment / increment / call / raw assembler line
    const n1 = this.peek();
    const sameLine = !n1.nl;
    if (sameLine && n1.kind === 'op' && (ASSIGN_OPS.has(n1.text) || n1.text === '++' || n1.text === '--')) {
      return this.assignStmt();
    }
    if (sameLine && this.isOp('(', n1) && n1.start === t.end) {
      const e = this.expr();
      this.endStmt();
      return { k: 'expr', e, t };
    }
    if (sameLine && this.isOp('[', n1) && n1.start === t.end) return this.assignStmt();
    if (sameLine && this.isOp('.', n1) && n1.start === t.end && !KEYWORDS.has(t.text)) {
      // could be Struct.field — but those cannot be assigned, so this is raw asm (b.eq ...)
    }
    if (KEYWORDS.has(t.text)) this.err(`unexpected keyword '${t.text}'`);
    return this.rawLine();
  }

  isLoopStart(): boolean {
    return ['while', 'do', 'loop', 'for'].includes(this.cur.text) && this.cur.kind === 'ident';
  }

  letStmt(): Stmt {
    const kw = this.next();
    const decls: LetDecl[] = [];
    do {
      const unsigned = !!this.accept('unsigned');
      const name = this.ident('alias name');
      if (this.isReg(name.text)) this.err(`'${name.text}' is a register and cannot be used as an alias name`, name);
      let reg: string | null = null;
      let init: Expr | null = null;
      if (kw.text === 'alias') {
        // alias name = reg   |   alias name: reg
        if (!this.accept('=')) this.expect(':');
        const r = this.ident('register');
        if (!this.isReg(r.text)) this.err(`'${r.text}' is not a register`, r);
        reg = r.text.toLowerCase();
        if (this.accept(':=')) init = this.expr();
      } else {
        if (this.accept(':')) {
          const r = this.ident('register or auto');
          if (r.text !== 'auto' && !this.isReg(r.text)) this.err(`'${r.text}' is not a register`, r);
          reg = r.text.toLowerCase();
        }
        if (this.accept('=')) init = this.expr();
      }
      decls.push({ name: name.text, reg, unsigned, init, t: name });
    } while (this.accept(','));
    this.endStmt();
    return { k: 'let', decls, t: kw };
  }

  /** Assignment-like statement without terminator handling for `for(...)` headers. */
  simpleStmt(): Stmt {
    const t = this.cur;
    if (this.is('let') || this.is('var')) {
      const kw = this.next();
      const unsigned = !!this.accept('unsigned');
      const name = this.ident('alias name');
      let reg: string | null = null;
      if (this.accept(':')) reg = this.ident('register').text.toLowerCase();
      this.expect('=');
      return { k: 'let', decls: [{ name: name.text, reg, unsigned, init: this.expr(), t: name }], t: kw };
    }
    const target = this.unary();
    if (this.isOp('++') || this.isOp('--')) {
      const op = this.next().text as '++' | '--';
      return { k: 'incdec', target, op, t };
    }
    if (this.cur.kind === 'op' && ASSIGN_OPS.has(this.cur.text)) {
      const op = this.next().text;
      return { k: 'assign', target, op, value: this.expr(), t };
    }
    if (target.k === 'call') return { k: 'expr', e: target, t };
    return this.err('expected assignment');
  }

  assignStmt(): Stmt {
    const s = this.simpleStmt();
    this.endStmt();
    return s;
  }

  ifStmt(): Stmt {
    const t = this.next();
    const arms: { cond: Expr; body: Stmt[] }[] = [];
    arms.push({ cond: this.expr(), body: this.block() });
    let els: Stmt[] | null = null;
    while (true) {
      if (this.is('elif')) {
        this.next();
        arms.push({ cond: this.expr(), body: this.block() });
      } else if (this.is('else')) {
        this.next();
        if (this.is('if')) {
          this.next();
          arms.push({ cond: this.expr(), body: this.block() });
        } else {
          els = this.block();
          break;
        }
      } else break;
    }
    return { k: 'if', arms, els, t };
  }

  /**
   * switch v { case 1, 2 { } case 'a'..='z' { } default { } } — sugar for an if/elif chain: the first
   * matching case runs, there is no fall-through, and break/continue belong to the enclosing loop.
   * A subject that is not a plain name is computed once into a hidden variable.
   */
  switchStmt(): Stmt {
    const t = this.next();
    const subject = this.expr();
    const plain = subject.k === 'name' || subject.k === 'num';
    const v: Expr = plain ? subject : { k: 'name', name: `__switch${++this.switches}`, t };
    const arms: { cond: Expr; body: Stmt[] }[] = [];
    let els: Stmt[] | null = null;
    this.expect('{', 'to open the switch');
    this.skipSemis();
    while (!this.isOp('}')) {
      const c = this.cur;
      if (c.kind === 'eof') this.err("unexpected end of file: missing '}'");
      if (this.is('default') || this.is('else')) {
        if (els) this.err('a switch has only one default');
        this.next();
        els = this.block();
      } else if (this.is('case')) {
        if (els) this.err("'case' after 'default'");
        this.next();
        let cond: Expr | null = null;
        do {
          const lo = this.expr();
          let one: Expr;
          if (this.isOp('..') || this.isOp('..=')) {
            const op = this.next().text === '..=' ? '<=' : '<';
            const hi = this.expr();
            one = { k: 'bin', op: '&&', l: { k: 'bin', op: '>=', l: v, r: lo, t: c }, r: { k: 'bin', op, l: v, r: hi, t: c }, t: c };
          } else one = { k: 'bin', op: '==', l: v, r: lo, t: c };
          cond = cond ? { k: 'bin', op: '||', l: cond, r: one, t: c } : one;
        } while (this.accept(','));
        arms.push({ cond, body: this.block() });
      } else this.err(`expected 'case' or 'default' in switch, found '${c.text}'`);
      this.skipSemis();
    }
    this.expect('}');
    const body: Stmt[] = arms.length ? [{ k: 'if', arms, els, t }] : els ?? [];
    if (!plain) body.unshift({ k: 'let', decls: [{ name: (v as { name: string }).name, reg: null, unsigned: false, init: subject, t }], t });
    return body.length === 1 ? body[0] : { k: 'block', body, t };
  }

  forStmt(): Stmt {
    const t = this.next();
    // for i in a..b [step s] { }      for i: x9 in a..=b { }
    if (this.cur.kind === 'ident' && (this.is('in', this.peek()) || this.isOp(':', this.peek()))) {
      const v = this.next();
      let reg: string | null = null;
      if (this.accept(':')) {
        const r = this.ident('register');
        if (!this.isReg(r.text) && r.text !== 'auto') this.err(`'${r.text}' is not a register`, r);
        reg = r.text === 'auto' ? null : r.text.toLowerCase();
      }
      this.expect('in');
      const from = this.expr();
      let inclusive = false;
      if (this.accept('..=')) inclusive = true; else this.expect('..', "in range 'a..b'");
      const to = this.expr();
      let step: Expr | null = null;
      if (this.accept('step')) step = this.expr();
      return { k: 'forin', v: v.text, reg, from, to, inclusive, step, body: this.block(), label: null, t };
    }
    // C-style
    const paren = !!this.accept('(');
    const init: Stmt[] = [];
    while (!this.isOp(';')) {
      init.push(this.simpleStmt());
      if (!this.accept(',')) break;
    }
    this.expect(';');
    const cond = this.isOp(';') ? null : this.expr();
    this.expect(';');
    const step: Stmt[] = [];
    while (!(paren ? this.isOp(')') : this.isOp('{'))) {
      step.push(this.simpleStmt());
      if (!this.accept(',')) break;
    }
    if (paren) this.expect(')');
    return { k: 'for', init, cond, step, body: this.block(), label: null, t };
  }

  asmStmt(): Stmt {
    const t = this.next();
    if (this.cur.kind === 'str') {
      const s = this.next();
      this.endStmt();
      return { k: 'asmtext', text: String.fromCharCode(...s.bytes!), t };
    }
    const open = this.expect('{');
    // collect tokens until the matching '}', grouped by source line
    const lines: RawLine[] = [];
    let depth = 0;
    let curLine: RawLine | null = null;
    let prevEnd = open.end;
    while (true) {
      const tok = this.cur;
      if (tok.kind === 'eof') this.err("unterminated asm block", open);
      if (this.isOp('{')) depth++;
      if (this.isOp('}')) {
        if (depth === 0) break;
        depth--;
      }
      this.next();
      if (this.isOp(';', tok)) { curLine = null; prevEnd = tok.end; continue; }
      if (!curLine || tok.nl) {
        curLine = { parts: [], line: tok.line };
        lines.push(curLine);
        curLine.parts.push({ gap: '', tok });
      } else {
        curLine.parts.push({ gap: this.src.slice(prevEnd, tok.start), tok });
      }
      prevEnd = tok.end;
    }
    this.expect('}');
    return { k: 'asm', lines, t };
  }

  rawLine(): Stmt {
    const first = this.cur;
    const line: RawLine = { parts: [], line: first.line };
    let prevEnd = first.start;
    let depth = 0;
    while (true) {
      const tok = this.cur;
      if (tok.kind === 'eof') break;
      if (line.parts.length && tok.nl) break;
      if (this.isOp(';') && depth === 0) break;
      if (this.isOp('}') && depth === 0) break;
      if (this.isOp('{')) depth++;
      if (this.isOp('}')) depth--;
      line.parts.push({ gap: this.src.slice(prevEnd, tok.start), tok });
      prevEnd = tok.end;
      this.next();
    }
    this.endStmt();
    return { k: 'asm', lines: [line], t: first };
  }

  // ----------------------------------------------------------------- expressions
  expr(): Expr {
    const c = this.binary(1);
    if (this.isOp('?') && !this.cur.nl) {
      const t = this.next();
      const a = this.expr();
      this.expect(':');
      const b = this.expr();
      return { k: 'tern', c, a, b, t };
    }
    return c;
  }

  binary(minPrec: number): Expr {
    let l = this.unary();
    while (true) {
      const t = this.cur;
      if (t.kind !== 'op' || t.nl) break;
      const p = PREC[t.text];
      if (p === undefined || p < minPrec) break;
      this.next();
      const r = this.binary(p + 1);
      l = { k: 'bin', op: t.text as BinOp, l, r, t };
    }
    return l;
  }

  unary(): Expr {
    const t = this.cur;
    if (this.isOp('-') || this.isOp('~') || this.isOp('!')) {
      this.next();
      const e = this.unary();
      if (t.text === '-' && e.k === 'num') return { ...e, v: -e.v };
      if (t.text === '-' && e.k === 'float') return { ...e, v: -e.v };
      return { k: 'un', op: t.text as '-' | '~' | '!', e, t };
    }
    if (this.isOp('+')) { this.next(); return this.unary(); }
    if (this.isOp('&')) {
      this.next();
      return { k: 'addr', e: this.unary(), t };
    }
    return this.primary();
  }

  primary(): Expr {
    const t = this.cur;
    switch (t.kind) {
      case 'num': case 'char': this.next(); return { k: 'num', v: t.value!, t };
      case 'float': this.next(); return { k: 'float', v: t.fvalue!, t };
      case 'str': this.next(); return { k: 'str', bytes: t.bytes!, t };
      case 'op':
        if (t.text === '(') {
          this.next();
          const e = this.expr();
          this.expect(')');
          return e;
        }
        if (t.text === '[') return this.memRef(null, t);
        return this.err(`unexpected '${t.text}' in expression`);
      case 'ident': {
        if (KEYWORDS.has(t.text) && t.text !== 'auto') this.err(`unexpected keyword '${t.text}' in expression`);
        // typed memory access: u8[addr]
        if (MEM_TYPES.includes(t.text) && this.isOp('[', this.peek()) && !this.peek().nl) {
          this.next();
          return this.memRef(t.text as MemType, t);
        }
        const name = this.dottedName();
        if (this.isOp('(') && !this.cur.nl && this.cur.start === name.end) {
          this.next();
          const args: Expr[] = [];
          while (!this.isOp(')')) {
            args.push(this.expr());
            if (!this.accept(',')) break;
          }
          this.expect(')');
          return { k: 'call', name: name.text, args, t: name };
        }
        if (this.isOp('[') && !this.cur.nl) {
          this.next();
          const index = this.expr();
          this.expect(']');
          return { k: 'index', name: name.text, index, t: name };
        }
        // `sizeof name` without parentheses
        return { k: 'name', name: name.text, t: name };
      }
    }
    return this.err(`unexpected '${t.text}' in expression`);
  }

  memRef(ty: MemType | null, t: Token): Expr {
    this.expect('[');
    const addr = this.expr();
    let post: 1 | -1 | 0 = 0;
    if (this.isOp('++')) { this.next(); post = 1; } else if (this.isOp('--')) { this.next(); post = -1; }
    this.expect(']');
    return { k: 'mem', ty, addr, post, t };
  }
}

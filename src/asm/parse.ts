// Assembly source parser: splits lines into labels, directives and instructions,
// and parses instruction operands into a small structured form.

export class AsmError extends Error {
  line: number;
  constructor(message: string, line: number) {
    super(message);
    this.line = line;
  }
}

// ---------------------------------------------------------------------------
// expressions (integers and symbol references)
// ---------------------------------------------------------------------------
// PAGE…: Mach-O arm64; GOTPCREL, PLT: ELF x86-64 (`[rip + sym@GOTPCREL]`, `call sym@PLT`)
export type Reloc = 'PAGE' | 'PAGEOFF' | 'GOTPAGE' | 'GOTPAGEOFF' | 'GOTPCREL' | 'PLT' | null;

/** A value: constant `add` plus optional symbol, with optional @-relocation modifier. */
export interface Value {
  sym: string | null;
  add: bigint;
  reloc: Reloc;
}

export interface Reg {
  k: 'reg';
  cls: 'x' | 'w' | 'b' | 'h' | 's' | 'd' | 'q';
  n: number;        // 31 = sp or zr (see sp)
  sp: boolean;      // true for sp/wsp
}

export type Operand =
  | Reg
  | { k: 'imm'; v: Value; hash: boolean }
  | { k: 'fimm'; v: number }
  | { k: 'mem'; base: Reg; off: Value | null; index: Reg | null; ext: string | null; amount: number | null; pre: boolean }
  | { k: 'shift'; op: string; amount: number | null }   // lsl #3, sxtw, uxtw #2
  | { k: 'cond'; cc: number }
  | { k: 'sym'; v: Value };                              // bare symbol / label

export const CONDS: Record<string, number> = {
  eq: 0, ne: 1, cs: 2, hs: 2, cc: 3, lo: 3, mi: 4, pl: 5, vs: 6, vc: 7,
  hi: 8, ls: 9, ge: 10, lt: 11, gt: 12, le: 13, al: 14, nv: 15,
};

const SHIFTS = new Set(['lsl', 'lsr', 'asr', 'ror', 'uxtb', 'uxth', 'uxtw', 'uxtx', 'sxtb', 'sxth', 'sxtw', 'sxtx', 'msl']);

export function parseReg(t: string): Reg | null {
  const s = t.toLowerCase();
  switch (s) {
    case 'sp': return { k: 'reg', cls: 'x', n: 31, sp: true };
    case 'wsp': return { k: 'reg', cls: 'w', n: 31, sp: true };
    case 'xzr': return { k: 'reg', cls: 'x', n: 31, sp: false };
    case 'wzr': return { k: 'reg', cls: 'w', n: 31, sp: false };
    case 'fp': return { k: 'reg', cls: 'x', n: 29, sp: false };
    case 'lr': return { k: 'reg', cls: 'x', n: 30, sp: false };
    case 'ip0': return { k: 'reg', cls: 'x', n: 16, sp: false };
    case 'ip1': return { k: 'reg', cls: 'x', n: 17, sp: false };
  }
  const m = /^([xwbhsdq])(\d{1,2})$/.exec(s);
  if (!m) return null;
  const n = Number(m[2]);
  const cls = m[1] as Reg['cls'];
  if ((cls === 'x' || cls === 'w') ? n > 30 : n > 31) return null;
  return { k: 'reg', cls, n, sp: false };
}

/** Tiny expression parser: numbers, symbols, + - * / % << >> & | ^ ~, parentheses, @modifier. */
export function parseValue(text: string, line: number): Value {
  let s = text.trim();
  let reloc: Reloc = null;
  const at = /@(PAGE|PAGEOFF|GOTPAGE|GOTPAGEOFF|GOTPCREL|PLT)$/i.exec(s);
  if (at) {
    reloc = at[1].toUpperCase() as Reloc;
    s = s.slice(0, at.index).trim();
  }
  const toks = s.match(/0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*|'(?:\\.|[^'])'|[A-Za-z_.$][\w.$]*|<<|>>|[-+*/%&|^~()]/g) ?? [];
  const joined = toks.join('');
  if (joined.replace(/\s/g, '') !== s.replace(/\s/g, '')) throw new AsmError(`cannot parse expression '${text}'`, line);
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];

  type V = { sym: string | null; add: bigint };
  const err = (m: string): never => { throw new AsmError(`${m} in '${text}'`, line); };
  const combine = (a: V, b: V, op: string): V => {
    if (op === '+') {
      if (a.sym && b.sym) err('cannot add two symbols');
      return { sym: a.sym ?? b.sym, add: a.add + b.add };
    }
    if (op === '-') {
      if (b.sym) err('symbol differences are not supported');
      return { sym: a.sym, add: a.add - b.add };
    }
    if (a.sym || b.sym) err(`operator '${op}' cannot be applied to a symbol`);
    const x = a.add, y = b.add;
    switch (op) {
      case '*': return { sym: null, add: x * y };
      case '/': return { sym: null, add: x / y };
      case '%': return { sym: null, add: x % y };
      case '<<': return { sym: null, add: x << y };
      case '>>': return { sym: null, add: x >> y };
      case '&': return { sym: null, add: x & y };
      case '|': return { sym: null, add: x | y };
      case '^': return { sym: null, add: x ^ y };
    }
    return err(`bad operator ${op}`);
  };
  const PREC: Record<string, number> = { '|': 1, '^': 2, '&': 3, '<<': 4, '>>': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };
  const primary = (): V => {
    const t = next();
    if (t === undefined) return err('unexpected end');
    if (t === '(') { const v = expr(0); if (next() !== ')') err("missing ')'"); return v; }
    if (t === '-') { const v = primary(); if (v.sym) err('cannot negate a symbol'); return { sym: null, add: -v.add }; }
    if (t === '+') return primary();
    if (t === '~') { const v = primary(); if (v.sym) err('cannot invert a symbol'); return { sym: null, add: ~v.add }; }
    if (/^\d/.test(t)) {
      const c = t.replace(/_/g, '');
      return { sym: null, add: BigInt(c.length > 1 && /^0[0-7]+$/.test(c) ? '0o' + c.slice(1) : c) };
    }
    if (t[0] === "'") {
      const body = t.slice(1, -1);
      const ch = body[0] === '\\' ? ({ n: 10, t: 9, r: 13, '0': 0, '\\': 92, "'": 39 } as Record<string, number>)[body[1]] ?? body.charCodeAt(1) : body.charCodeAt(0);
      return { sym: null, add: BigInt(ch) };
    }
    return { sym: t, add: 0n };
  };
  const expr = (minPrec: number): V => {
    let l = primary();
    while (true) {
      const op = peek();
      const p = op !== undefined ? PREC[op] : undefined;
      if (p === undefined || p < minPrec) break;
      next();
      const r = expr(p + 1);
      l = combine(l, r, op!);
    }
    return l;
  };
  if (!toks.length) err('empty expression');
  const v = expr(0);
  if (pos !== toks.length) err(`unexpected '${toks[pos]}'`);
  return { ...v, reloc };
}

/** Split an operand list on top-level commas. */
export function splitOperands(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '', inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { cur += c; if (c === '\\') { cur += s[++i] ?? ''; } else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; cur += c; continue; }
    if (c === '[' || c === '{' || c === '(') depth++;
    if (c === ']' || c === '}' || c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}

export function parseOperand(text: string, line: number): Operand {
  const t = text.trim();
  if (!t) throw new AsmError('empty operand', line);
  const r = parseReg(t);
  if (r) return r;
  if (t[0] === '[') {
    const pre = t.endsWith('!');
    const body = t.slice(0, pre ? -1 : undefined).trim();
    if (!body.endsWith(']')) throw new AsmError(`bad memory operand '${t}'`, line);
    const parts = splitOperands(body.slice(1, -1));
    const base = parseReg(parts[0] ?? '');
    if (!base || !(base.cls === 'x')) throw new AsmError(`bad base register in '${t}'`, line);
    if (parts.length === 1) return { k: 'mem', base, off: null, index: null, ext: null, amount: null, pre };
    const p1 = parts[1];
    const idx = parseReg(p1);
    if (idx) {
      let ext: string | null = null, amount: number | null = null;
      if (parts[2]) {
        const m = /^(lsl|uxtw|sxtw|sxtx|uxtx)(?:\s+#?(.+))?$/i.exec(parts[2]);
        if (!m) throw new AsmError(`bad index extend '${parts[2]}'`, line);
        ext = m[1].toLowerCase();
        amount = m[2] !== undefined ? Number(parseValue(m[2], line).add) : null;
      }
      return { k: 'mem', base, off: null, index: idx, ext, amount, pre };
    }
    const off = parseValue(p1.replace(/^#/, ''), line);
    return { k: 'mem', base, off, index: null, ext: null, amount: null, pre };
  }
  const lower = t.toLowerCase();
  const sm = /^([a-z]+)(?:\s+#?(.+))?$/i.exec(t);
  if (sm && SHIFTS.has(sm[1].toLowerCase())) {
    return { k: 'shift', op: sm[1].toLowerCase(), amount: sm[2] !== undefined ? Number(parseValue(sm[2], line).add) : null };
  }
  if (CONDS[lower] !== undefined) return { k: 'cond', cc: CONDS[lower] };
  if (t[0] === '#') {
    const body = t.slice(1).trim();
    if (/^[-+]?(\d+\.\d*|\d*\.\d+)(e[-+]?\d+)?$/i.test(body) || /^[-+]?\d+e[-+]?\d+$/i.test(body)) return { k: 'fimm', v: parseFloat(body) };
    return { k: 'imm', v: parseValue(body, line), hash: true };
  }
  if (/^[-+]?(\d+\.\d*|\d*\.\d+)(e[-+]?\d+)?$/i.test(t)) return { k: 'fimm', v: parseFloat(t) };
  const v = parseValue(t, line);
  if (v.sym === null || v.reloc) return { k: 'imm', v, hash: false };
  return { k: 'sym', v };
}

// ---------------------------------------------------------------------------
// statements
// ---------------------------------------------------------------------------
export type Stmt =
  | { k: 'label'; name: string; line: number }
  | { k: 'dir'; name: string; args: string; line: number }
  | { k: 'inst'; mn: string; ops: string; line: number };

/** Remove `//` comments (and `#` comments for x86) outside of strings. */
function stripComment(l: string, hash = false): string {
  let inStr = false;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '/' && l[i + 1] === '/') return l.slice(0, i);
    else if (hash && c === '#') return l.slice(0, i);
    else if (c === '/' && l[i + 1] === '*') {
      const e = l.indexOf('*/', i + 2);
      l = l.slice(0, i) + ' ' + (e >= 0 ? l.slice(e + 2) : '');
    }
  }
  return l;
}

function splitStatements(l: string): string[] {
  const out: string[] = [];
  let inStr = false, cur = '';
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (inStr) { cur += c; if (c === '\\') cur += l[++i] ?? ''; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    if (c === ';') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** Rename numeric local labels (`1:` with `1b` / `1f` references) to unique names. */
function resolveLocalLabels(stmts: Stmt[]): Stmt[] {
  const defs = new Map<string, number[]>();          // label number -> statement indices
  stmts.forEach((st, i) => {
    if (st.k === 'label' && /^\d+$/.test(st.name)) {
      if (!defs.has(st.name)) defs.set(st.name, []);
      defs.get(st.name)!.push(i);
    }
  });
  if (!defs.size) return stmts;
  const nameOf = (n: string, k: number) => `L.local.${n}.${k}`;
  return stmts.map((st, i) => {
    if (st.k === 'label' && /^\d+$/.test(st.name)) {
      return { ...st, name: nameOf(st.name, defs.get(st.name)!.indexOf(i)) };
    }
    if (st.k !== 'inst') return st;
    const ops = st.ops.replace(/(?<![\w.$#])(\d+)([bf])\b/g, (whole, n: string, dir: string) => {
      const list = defs.get(n);
      if (!list) throw new AsmError(`no local label '${n}:' for '${whole}'`, st.line);
      const k = dir === 'b' ? list.filter((x) => x < i).length - 1 : list.findIndex((x) => x > i);
      if (k < 0) throw new AsmError(`no ${dir === 'b' ? 'previous' : 'following'} local label '${n}:'`, st.line);
      return nameOf(n, k);
    });
    return { ...st, ops };
  });
}

export function parseSource(src: string, opts: { hashComments?: boolean } = {}): Stmt[] {
  return resolveLocalLabels(parseSourceRaw(src, !!opts.hashComments));
}

function parseSourceRaw(src: string, hash: boolean): Stmt[] {
  const out: Stmt[] = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    for (let part of splitStatements(stripComment(lines[i], hash))) {
      part = part.trim();
      // labels (possibly several) at the start
      while (true) {
        const m = /^([A-Za-z_.$][\w.$]*|\d+|"[^"]+")\s*:(?!:)/.exec(part);
        if (!m) break;
        out.push({ k: 'label', name: m[1].replace(/^"|"$/g, ''), line: lineNo });
        part = part.slice(m[0].length).trim();
      }
      if (!part) continue;
      const m = /^(\S+)\s*(.*)$/.exec(part)!;
      const name = m[1];
      if (name.startsWith('.') && !/^\.\d/.test(name)) out.push({ k: 'dir', name: name.toLowerCase(), args: m[2].trim(), line: lineNo });
      else out.push({ k: 'inst', mn: name.toLowerCase(), ops: m[2].trim(), line: lineNo });
    }
  }
  return out;
}

/** Decode a .ascii/.asciz string literal into bytes. */
export function parseStringLiteral(s: string, line: number): number[] {
  const t = s.trim();
  if (t[0] !== '"' || t[t.length - 1] !== '"' || t.length < 2) throw new AsmError(`expected a string literal, got '${s}'`, line);
  const body = t.slice(1, -1);
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      bytes.push(...enc.encode(c));
      continue;
    }
    const e = body[++i];
    if (/[0-7]/.test(e)) {
      let o = e;
      while (o.length < 3 && /[0-7]/.test(body[i + 1] ?? '')) o += body[++i];
      bytes.push(parseInt(o, 8) & 0xff);
      continue;
    }
    switch (e) {
      case 'n': bytes.push(10); break;
      case 't': bytes.push(9); break;
      case 'r': bytes.push(13); break;
      case 'b': bytes.push(8); break;
      case 'f': bytes.push(12); break;
      case 'v': bytes.push(11); break;
      case 'a': bytes.push(7); break;
      case 'e': bytes.push(27); break;
      case '\\': bytes.push(92); break;
      case '"': bytes.push(34); break;
      case "'": bytes.push(39); break;
      case 'x': {
        let h = '';
        while (/[0-9a-fA-F]/.test(body[i + 1] ?? '') && h.length < 2) h += body[++i];
        bytes.push(parseInt(h || '0', 16));
        break;
      }
      default: throw new AsmError(`unknown escape '\\${e}'`, line);
    }
  }
  return bytes;
}

// WebAssembly assembler: the text format (WAT) the wasm32 translator writes → a binary module (.wasm).
// Module fields in S-expression form; function bodies in the flat form, one instruction per line
// (block/loop/if … else … end, br $label). Every body is type-checked the way an engine validates it,
// so a wrong instruction in `asm { }` is reported with its line instead of a failure to load later.
// The result carries a listing (the bytes of every instruction, by line) and a description of the
// module for the inspector.
import { AsmError } from '../parse.ts';

export { AsmError };

type ValType = 'i32' | 'i64' | 'f32' | 'f64';
type StackType = ValType | 'any';
const VALTYPE: Record<ValType, number> = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };
const LETTER: Record<string, ValType> = { i: 'i32', I: 'i64', f: 'f32', F: 'f64' };

export interface FuncType { params: ValType[]; results: ValType[] }

export interface WasmListing { addr: number; bytes: number[]; line: number; sect: string }

export interface WasmModule {
  bytes: Uint8Array;
  listing: WasmListing[];
  instructions: number;
  sections: { name: string; offset: number; size: number }[];
  types: FuncType[];
  imports: { module: string; name: string; type: FuncType }[];
  exports: { name: string; kind: string; index: number }[];
  functions: { name: string; index: number; type: FuncType; locals: number; offset: number; size: number; instructions: number }[];
  memory: { pages: number; max: number | null } | null;
  table: number;
  globals: { name: string; type: ValType; mutable: boolean; init: string }[];
  data: { addr: number; size: number }[];
}

// ---------------------------------------------------------------------------
// tokens
// ---------------------------------------------------------------------------
interface Tok { k: '(' | ')' | 'str' | 'atom'; v: string; bytes?: number[]; line: number }

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let line = 1;
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === ';' && src[i + 1] === ';') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '(' && src[i + 1] === ';') {
      let depth = 0;
      do {
        if (src[i] === '(' && src[i + 1] === ';') { depth++; i += 2; }
        else if (src[i] === ';' && src[i + 1] === ')') { depth--; i += 2; }
        else { if (src[i] === '\n') line++; i++; }
      } while (depth > 0 && i < src.length);
      continue;
    }
    if (c === '(' || c === ')') { out.push({ k: c, v: c, line }); i++; continue; }
    if (c === '"') {
      const bytes: number[] = [];
      const start = line;
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\n') throw new AsmError('unterminated string', start);
        if (src[i] !== '\\') {
          const cp = src.codePointAt(i)!;
          bytes.push(...new TextEncoder().encode(String.fromCodePoint(cp)));
          i += cp > 0xffff ? 2 : 1;
          continue;
        }
        const e = src[i + 1];
        i += 2;
        if (e === 'n') bytes.push(10);
        else if (e === 't') bytes.push(9);
        else if (e === 'r') bytes.push(13);
        else if (e === '"' || e === '\\' || e === "'") bytes.push(e.charCodeAt(0));
        else if (/[0-9a-fA-F]/.test(e) && /[0-9a-fA-F]/.test(src[i])) { bytes.push(parseInt(e + src[i], 16)); i++; }
        else throw new AsmError(`unknown escape '\\${e}' in a string`, line);
      }
      if (i >= src.length) throw new AsmError('unterminated string', start);
      i++;
      out.push({ k: 'str', v: '', bytes, line: start });
      continue;
    }
    let j = i;
    while (j < src.length && !/[\s()";]/.test(src[j])) j++;
    if (j === i) throw new AsmError(`unexpected character '${c}'`, line);
    out.push({ k: 'atom', v: src.slice(i, j), line });
    i = j;
  }
  return out;
}

/** S-expression: an atom or a list */
type SX = { list: SX[]; line: number } | Tok;
const isList = (x: SX | undefined): x is { list: SX[]; line: number } => !!x && 'list' in x;
const head = (x: SX | undefined): string | null => (isList(x) && x.list[0] && !isList(x.list[0]) && x.list[0].k === 'atom' ? x.list[0].v : null);

function sexprs(toks: Tok[]): SX[] {
  let i = 0;
  const one = (): SX => {
    const t = toks[i++];
    if (t.k === ')') throw new AsmError("unexpected ')'", t.line);
    if (t.k !== '(') return t;
    const list: SX[] = [];
    while (i < toks.length && toks[i].k !== ')') list.push(one());
    if (i >= toks.length) throw new AsmError("missing ')'", t.line);
    i++;
    return { list, line: t.line };
  };
  const out: SX[] = [];
  while (i < toks.length) out.push(one());
  return out;
}

// ---------------------------------------------------------------------------
// instructions: opcode bytes, stack signature ("ii:i"), immediates
// ---------------------------------------------------------------------------
type Imm = '' | 'mem' | 'i32' | 'i64' | 'f32' | 'f64' | 'local' | 'global' | 'func' | 'label' | 'labels' | 'block' | 'type' | 'zero' | 'zero2';
interface Op { code: number[]; sig: string | null; imm: Imm; align?: number }
const OPS = new Map<string, Op>();
const def = (name: string, code: number[], sig: string | null, imm: Imm = '', align?: number) => OPS.set(name, { code, sig, imm, align });

def('unreachable', [0x00], null); def('nop', [0x01], ':');
def('block', [0x02], null, 'block'); def('loop', [0x03], null, 'block'); def('if', [0x04], null, 'block');
def('else', [0x05], null); def('end', [0x0b], null);
def('br', [0x0c], null, 'label'); def('br_if', [0x0d], null, 'label'); def('br_table', [0x0e], null, 'labels');
def('return', [0x0f], null); def('call', [0x10], null, 'func'); def('call_indirect', [0x11], null, 'type');
def('drop', [0x1a], null); def('select', [0x1b], null);
def('local.get', [0x20], null, 'local'); def('local.set', [0x21], null, 'local'); def('local.tee', [0x22], null, 'local');
def('global.get', [0x23], null, 'global'); def('global.set', [0x24], null, 'global');
([['i32.load', 0x28, 'i:i', 2], ['i64.load', 0x29, 'i:I', 3], ['f32.load', 0x2a, 'i:f', 2], ['f64.load', 0x2b, 'i:F', 3],
  ['i32.load8_s', 0x2c, 'i:i', 0], ['i32.load8_u', 0x2d, 'i:i', 0], ['i32.load16_s', 0x2e, 'i:i', 1], ['i32.load16_u', 0x2f, 'i:i', 1],
  ['i64.load8_s', 0x30, 'i:I', 0], ['i64.load8_u', 0x31, 'i:I', 0], ['i64.load16_s', 0x32, 'i:I', 1], ['i64.load16_u', 0x33, 'i:I', 1],
  ['i64.load32_s', 0x34, 'i:I', 2], ['i64.load32_u', 0x35, 'i:I', 2],
  ['i32.store', 0x36, 'ii:', 2], ['i64.store', 0x37, 'iI:', 3], ['f32.store', 0x38, 'if:', 2], ['f64.store', 0x39, 'iF:', 3],
  ['i32.store8', 0x3a, 'ii:', 0], ['i32.store16', 0x3b, 'ii:', 1], ['i64.store8', 0x3c, 'iI:', 0], ['i64.store16', 0x3d, 'iI:', 1], ['i64.store32', 0x3e, 'iI:', 2],
] as [string, number, string, number][]).forEach(([n, c, s, a]) => def(n, [c], s, 'mem', a));
def('memory.size', [0x3f], ':i', 'zero'); def('memory.grow', [0x40], 'i:i', 'zero');
def('i32.const', [0x41], ':i', 'i32'); def('i64.const', [0x42], ':I', 'i64'); def('f32.const', [0x43], ':f', 'f32'); def('f64.const', [0x44], ':F', 'f64');
{
  let c = 0x45;
  def('i32.eqz', [c++], 'i:i');
  for (const n of ['eq', 'ne', 'lt_s', 'lt_u', 'gt_s', 'gt_u', 'le_s', 'le_u', 'ge_s', 'ge_u']) def('i32.' + n, [c++], 'ii:i');
  def('i64.eqz', [c++], 'I:i');
  for (const n of ['eq', 'ne', 'lt_s', 'lt_u', 'gt_s', 'gt_u', 'le_s', 'le_u', 'ge_s', 'ge_u']) def('i64.' + n, [c++], 'II:i');
  for (const n of ['eq', 'ne', 'lt', 'gt', 'le', 'ge']) def('f32.' + n, [c++], 'ff:i');
  for (const n of ['eq', 'ne', 'lt', 'gt', 'le', 'ge']) def('f64.' + n, [c++], 'FF:i');
  for (const [t, l] of [['i32', 'i'], ['i64', 'I']]) {
    for (const n of ['clz', 'ctz', 'popcnt']) def(`${t}.${n}`, [c++], `${l}:${l}`);
    for (const n of ['add', 'sub', 'mul', 'div_s', 'div_u', 'rem_s', 'rem_u', 'and', 'or', 'xor', 'shl', 'shr_s', 'shr_u', 'rotl', 'rotr']) def(`${t}.${n}`, [c++], `${l}${l}:${l}`);
  }
  for (const [t, l] of [['f32', 'f'], ['f64', 'F']]) {
    for (const n of ['abs', 'neg', 'ceil', 'floor', 'trunc', 'nearest', 'sqrt']) def(`${t}.${n}`, [c++], `${l}:${l}`);
    for (const n of ['add', 'sub', 'mul', 'div', 'min', 'max', 'copysign']) def(`${t}.${n}`, [c++], `${l}${l}:${l}`);
  }
  for (const [n, s] of [['i32.wrap_i64', 'I:i'], ['i32.trunc_f32_s', 'f:i'], ['i32.trunc_f32_u', 'f:i'], ['i32.trunc_f64_s', 'F:i'], ['i32.trunc_f64_u', 'F:i'],
    ['i64.extend_i32_s', 'i:I'], ['i64.extend_i32_u', 'i:I'], ['i64.trunc_f32_s', 'f:I'], ['i64.trunc_f32_u', 'f:I'], ['i64.trunc_f64_s', 'F:I'], ['i64.trunc_f64_u', 'F:I'],
    ['f32.convert_i32_s', 'i:f'], ['f32.convert_i32_u', 'i:f'], ['f32.convert_i64_s', 'I:f'], ['f32.convert_i64_u', 'I:f'], ['f32.demote_f64', 'F:f'],
    ['f64.convert_i32_s', 'i:F'], ['f64.convert_i32_u', 'i:F'], ['f64.convert_i64_s', 'I:F'], ['f64.convert_i64_u', 'I:F'], ['f64.promote_f32', 'f:F'],
    ['i32.reinterpret_f32', 'f:i'], ['i64.reinterpret_f64', 'F:I'], ['f32.reinterpret_i32', 'i:f'], ['f64.reinterpret_i64', 'I:F'],
    ['i32.extend8_s', 'i:i'], ['i32.extend16_s', 'i:i'], ['i64.extend8_s', 'I:I'], ['i64.extend16_s', 'I:I'], ['i64.extend32_s', 'I:I']]) def(n, [c++], s);
  let k = 0;
  for (const [n, s] of [['i32.trunc_sat_f32_s', 'f:i'], ['i32.trunc_sat_f32_u', 'f:i'], ['i32.trunc_sat_f64_s', 'F:i'], ['i32.trunc_sat_f64_u', 'F:i'],
    ['i64.trunc_sat_f32_s', 'f:I'], ['i64.trunc_sat_f32_u', 'f:I'], ['i64.trunc_sat_f64_s', 'F:I'], ['i64.trunc_sat_f64_u', 'F:I']]) def(n, [0xfc, k++], s);
  def('memory.copy', [0xfc, 10], 'iii:', 'zero2');
  def('memory.fill', [0xfc, 11], 'iii:', 'zero');
}

/** the names of all instructions (for highlighting and docs) */
export const WASM_MNEMONICS: ReadonlySet<string> = new Set(OPS.keys());

// ---------------------------------------------------------------------------
// binary helpers
// ---------------------------------------------------------------------------
function uleb(n: number | bigint): number[] {
  let v = BigInt(n);
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}

function sleb(n: bigint): number[] {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    if ((v === 0n && !(b & 0x40)) || (v === -1n && b & 0x40)) { out.push(b); return out; }
    out.push(b | 0x80);
  }
}

const str = (s: string): number[] => { const b = [...new TextEncoder().encode(s)]; return [...uleb(b.length), ...b]; };
const vec = (items: number[][]): number[] => [...uleb(items.length), ...items.flat()];

function parseInteger(text: string, bits: 32 | 64, line: number): bigint {
  const t = text.replace(/_/g, '');
  const m = /^([+-]?)(0x[0-9a-f]+|\d+)$/i.exec(t);
  if (!m) throw new AsmError(`'${text}' is not an integer`, line);
  let v = BigInt(m[2]);
  if (m[1] === '-') v = -v;
  const max = 1n << BigInt(bits);
  if (v >= max || v < -(max >> 1n)) throw new AsmError(`${text} does not fit into ${bits} bits`, line);
  return BigInt.asIntN(bits, v);
}

function parseFloatText(text: string, line: number): number {
  const t = text.replace(/_/g, '');
  const m = /^([+-]?)(.*)$/.exec(t)!;
  const sign = m[1] === '-' ? -1 : 1;
  const body = m[2];
  if (body === 'inf') return sign * Infinity;
  if (body === 'nan' || /^nan:0x[0-9a-f]+$/i.test(body)) return NaN;
  const hex = /^0x([0-9a-f]*)(?:\.([0-9a-f]*))?(?:p([+-]?\d+))?$/i.exec(body);
  if (hex) {
    const int = hex[1] || '0', frac = hex[2] ?? '';
    let v = parseInt(int + frac || '0', 16) / 16 ** frac.length;
    v *= 2 ** Number(hex[3] ?? 0);
    return sign * v;
  }
  if (!/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(body)) throw new AsmError(`'${text}' is not a number`, line);
  return sign * Number(body);
}

function f32bytes(v: number): number[] { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v, true); return [...new Uint8Array(d.buffer)]; }
function f64bytes(v: number): number[] { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, v, true); return [...new Uint8Array(d.buffer)]; }

// ---------------------------------------------------------------------------
// the module
// ---------------------------------------------------------------------------
interface Func {
  name: string; line: number; type: FuncType; typeIdx: number; exportNames: string[];
  localNames: string[]; locals: ValType[]; body: Tok[][];   // instruction lines
}

export function assembleWasm(src: string): WasmModule {
  const top = sexprs(tokenize(src));
  if (top.length !== 1 || head(top[0]) !== 'module') throw new AsmError('expected one (module …)', top[0]?.line ?? 1);
  const fields = (top[0] as { list: SX[] }).list.slice(1);

  const types: FuncType[] = [];
  const typeNames = new Map<string, number>();
  const typeIndex = (t: FuncType) => {
    const k = t.params.join() + ':' + t.results.join();
    let i = types.findIndex((x) => x.params.join() + ':' + x.results.join() === k);
    if (i < 0) { types.push(t); i = types.length - 1; }
    return i;
  };
  const imports: { module: string; name: string; fname: string; typeIdx: number; line: number }[] = [];
  const funcs: Func[] = [];
  const globals: { name: string; type: ValType; mutable: boolean; init: number[]; initText: string; exportNames: string[] }[] = [];
  const exports: { name: string; kind: 'func' | 'memory' | 'global' | 'table'; ref: string; line: number }[] = [];
  let memory: { pages: number; max: number | null; exportNames: string[] } | null = null;
  let table: { size: number; exportNames: string[] } | null = null;
  const elems: { offset: number; refs: { name: string; line: number }[] }[] = [];
  const datas: { offset: number; bytes: number[] }[] = [];
  let start: { ref: string; line: number } | null = null;

  const atom = (x: SX | undefined, what: string, line: number): string => {
    if (!x || isList(x) || x.k !== 'atom') throw new AsmError(`expected ${what}`, x ? (isList(x) ? x.line : x.line) : line);
    return x.v;
  };
  const valtype = (x: SX | undefined, line: number): ValType => {
    const v = atom(x, 'a value type (i32, i64, f32, f64)', line);
    if (!(v in VALTYPE)) throw new AsmError(`'${v}' is not a value type (i32, i64, f32, f64)`, line);
    return v as ValType;
  };
  /** (param …)(result …)(local …) and inline (export "…") of a function or import */
  const funcHeader = (items: SX[], line: number) => {
    const params: ValType[] = [], results: ValType[] = [], paramNames: string[] = [], locals: ValType[] = [], localNames: string[] = [], exportNames: string[] = [];
    let typeRef: string | null = null;
    let i = 0;
    for (; i < items.length; i++) {
      const it = items[i];
      const h = head(it);
      if (!h || !['param', 'result', 'local', 'export', 'type'].includes(h)) break;
      const l = (it as { list: SX[]; line: number });
      const rest = l.list.slice(1);
      if (h === 'export') { exportNames.push(strOf(rest[0], l.line)); continue; }
      if (h === 'type') { typeRef = atom(rest[0], 'a type', l.line); continue; }
      const named = rest[0] && !isList(rest[0]) && rest[0].k === 'atom' && rest[0].v.startsWith('$');
      const list = h === 'param' ? params : h === 'result' ? results : locals;
      const names = h === 'param' ? paramNames : localNames;
      if (named) { names.push((rest[0] as Tok).v); list.push(valtype(rest[1], l.line)); if (rest.length > 2) throw new AsmError(`a named ${h} has one type`, l.line); }
      else for (const r of rest) { if (h !== 'result') names.push(''); list.push(valtype(r, l.line)); }
    }
    let type: FuncType = { params, results };
    if (typeRef !== null) {
      const ti = typeNames.get(typeRef) ?? (/^\d+$/.test(typeRef) ? Number(typeRef) : -1);
      if (ti < 0 || ti >= types.length) throw new AsmError(`unknown type ${typeRef}`, line);
      if (!params.length && !results.length) type = types[ti];
    }
    return { type, paramNames, locals, localNames, exportNames, rest: items.slice(i) };
  };
  const strOf = (x: SX | undefined, line: number): string => {
    if (!x || isList(x) || x.k !== 'str') throw new AsmError('expected a "string"', line);
    return new TextDecoder().decode(new Uint8Array(x.bytes!));
  };
  const constExpr = (x: SX | undefined, want: ValType, line: number): { bytes: number[]; text: string; value: number } => {
    const h = head(x);
    if (!h || !isList(x)) throw new AsmError(`expected (${want}.const …)`, line);
    const v = atom(x.list[1], 'a value', x.line);
    if (h !== `${want}.const`) throw new AsmError(`expected (${want}.const …), found (${h} …)`, x.line);
    if (want === 'i32') { const n = parseInteger(v, 32, x.line); return { bytes: [0x41, ...sleb(n), 0x0b], text: String(n), value: Number(n) }; }
    if (want === 'i64') { const n = parseInteger(v, 64, x.line); return { bytes: [0x42, ...sleb(n), 0x0b], text: String(n), value: Number(n) }; }
    const f = parseFloatText(v, x.line);
    return { bytes: [want === 'f32' ? 0x43 : 0x44, ...(want === 'f32' ? f32bytes(f) : f64bytes(f)), 0x0b], text: String(f), value: f };
  };

  // pass 1: types first (functions may name them), then everything else
  for (const f of fields) {
    if (head(f) !== 'type') continue;
    const l = f as { list: SX[]; line: number };
    const name = !isList(l.list[1]) && (l.list[1] as Tok)?.v.startsWith('$') ? (l.list[1] as Tok).v : null;
    const fn = l.list[name ? 2 : 1];
    if (head(fn) !== 'func') throw new AsmError('expected (type $name (func …))', l.line);
    const h = funcHeader((fn as { list: SX[] }).list.slice(1), l.line);
    types.push(h.type);
    if (name) typeNames.set(name, types.length - 1);
  }
  for (const f of fields) {
    const h = head(f);
    if (!h || !isList(f)) throw new AsmError('expected a module field: (func …), (import …), (memory …), (data …) …', isList(f) ? f.line : (f as Tok).line);
    const rest = f.list.slice(1);
    const named = (x: SX | undefined) => (x && !isList(x) && x.k === 'atom' && x.v.startsWith('$') ? x.v : null);
    switch (h) {
      case 'type': break;
      case 'import': {
        const module = strOf(rest[0], f.line), name = strOf(rest[1], f.line);
        const d = rest[2];
        if (head(d) !== 'func' || !isList(d)) throw new AsmError('only functions can be imported', f.line);
        const fname = named(d.list[1]) ?? '';
        const hd = funcHeader(d.list.slice(fname ? 2 : 1), d.line);
        if (funcs.length) throw new AsmError('imports must come before the functions of the module', f.line);
        imports.push({ module, name, fname, typeIdx: typeIndex(hd.type), line: f.line });
        break;
      }
      case 'func': {
        const name = named(rest[0]) ?? '';
        const hd = funcHeader(rest.slice(name ? 1 : 0), f.line);
        // the body: flat instructions, grouped by line
        const body: Tok[][] = [];
        let cur: Tok[] | null = null;
        const flat = (xs: SX[]) => {
          for (const x of xs) {
            if (isList(x)) {
              // block types are the only lists allowed inside a body: if (result i64)
              if (head(x) === 'result' || head(x) === 'type' || head(x) === 'param') {
                if (!cur) throw new AsmError(`(${head(x)} …) without an instruction`, x.line);
                cur.push({ k: '(', v: '(', line: x.line }, ...(x.list as Tok[]), { k: ')', v: ')', line: x.line });
                continue;
              }
              throw new AsmError('write the instructions in the flat form, one per line (no folded (i64.add …))', x.line);
            }
            // an instruction name starts an instruction; numbers, $names and offset=… are its operands
            if (x.k === 'atom' && OPS.has(x.v)) { cur = [x]; body.push(cur); continue; }
            if (!cur || (x.k === 'atom' && /^[a-z_][\w.]*$/i.test(x.v) && !/^(nan|inf)$/.test(x.v))) {
              throw new AsmError(`unknown instruction '${x.k === 'str' ? '"…"' : x.v}'`, x.line);
            }
            cur.push(x);
          }
        };
        flat(hd.rest);
        funcs.push({
          name, line: f.line, type: hd.type, typeIdx: typeIndex(hd.type), exportNames: hd.exportNames,
          localNames: [...hd.paramNames, ...hd.localNames], locals: hd.locals, body,
        });
        break;
      }
      case 'memory': {
        if (memory) throw new AsmError('only one memory', f.line);
        const ex: string[] = [];
        let i = named(rest[0]) ? 1 : 0;
        while (head(rest[i]) === 'export') ex.push(strOf((rest[i++] as { list: SX[] }).list[1], f.line));
        const pages = Number(atom(rest[i], 'the size in pages', f.line));
        const max = rest[i + 1] ? Number(atom(rest[i + 1], 'the maximum size', f.line)) : null;
        memory = { pages, max, exportNames: ex };
        break;
      }
      case 'table': {
        const ex: string[] = [];
        let i = named(rest[0]) ? 1 : 0;
        while (head(rest[i]) === 'export') ex.push(strOf((rest[i++] as { list: SX[] }).list[1], f.line));
        table = { size: Number(atom(rest[i], 'the table size', f.line)), exportNames: ex };
        break;
      }
      case 'global': {
        const name = named(rest[0]) ?? '';
        let i = name ? 1 : 0;
        const ex: string[] = [];
        while (head(rest[i]) === 'export') ex.push(strOf((rest[i++] as { list: SX[] }).list[1], f.line));
        const mut = head(rest[i]) === 'mut';
        const type = mut ? valtype((rest[i] as { list: SX[] }).list[1], f.line) : valtype(rest[i], f.line);
        const init = constExpr(rest[i + 1], type, f.line);
        globals.push({ name, type, mutable: mut, init: init.bytes, initText: init.text, exportNames: ex });
        break;
      }
      case 'export': {
        const d = rest[1];
        const kind = head(d);
        if (!isList(d) || !kind || !['func', 'memory', 'global', 'table'].includes(kind)) throw new AsmError('expected (export "name" (func $f))', f.line);
        exports.push({ name: strOf(rest[0], f.line), kind: kind as 'func', ref: atom(d.list[1], 'a name', d.line), line: f.line });
        break;
      }
      case 'elem': {
        const off = constExpr(rest[0], 'i32', f.line).value;
        const refs = rest.slice(1).filter((x) => !(!isList(x) && x.k === 'atom' && x.v === 'func'))
          .map((x) => ({ name: atom(x, 'a function', f.line), line: f.line }));
        elems.push({ offset: off, refs });
        break;
      }
      case 'data': {
        const off = constExpr(rest[0], 'i32', f.line).value;
        const bytes: number[] = [];
        for (const x of rest.slice(1)) {
          if (isList(x) || x.k !== 'str') throw new AsmError('expected "data" strings', f.line);
          bytes.push(...x.bytes!);
        }
        datas.push({ offset: off, bytes });
        break;
      }
      case 'start': start = { ref: atom(rest[0], 'a function', f.line), line: f.line }; break;
      default: throw new AsmError(`unknown module field '(${h} …)'`, f.line);
    }
  }

  // names → indices
  const funcIdx = new Map<string, number>();
  imports.forEach((im, i) => { if (im.fname) funcIdx.set(im.fname, i); });
  funcs.forEach((fn, i) => { if (fn.name) { if (funcIdx.has(fn.name)) throw new AsmError(`function ${fn.name} is defined twice`, fn.line); funcIdx.set(fn.name, imports.length + i); } });
  const funcTypes = [...imports.map((i) => types[i.typeIdx]), ...funcs.map((f) => f.type)];
  const funcName = (i: number) => (i < imports.length ? imports[i].fname || `${imports[i].module}.${imports[i].name}` : funcs[i - imports.length].name || `#${i}`);
  const globalIdx = new Map<string, number>();
  globals.forEach((g, i) => { if (g.name) globalIdx.set(g.name, i); });
  const refFunc = (ref: string, line: number): number => {
    const i = funcIdx.get(ref) ?? (/^\d+$/.test(ref) ? Number(ref) : -1);
    if (i < 0 || i >= funcTypes.length) throw new AsmError(`unknown function ${ref}`, line);
    return i;
  };

  // code
  const listing: WasmListing[] = [];
  const bodies: { bytes: number[]; insns: { at: number; bytes: number[]; line: number }[] }[] = [];
  let instructions = 0;
  const cx: Ctx = { types, typeNames, funcTypes, refFunc, funcName, globals, globalIdx, hasMemory: !!memory, tableSize: table ? (table as { size: number }).size : 0 };
  funcs.forEach((fn) => {
    const insns: { at: number; bytes: number[]; line: number }[] = [];
    const code = new FunctionCompiler(fn, cx).compile(insns);
    instructions += insns.length;
    // locals: runs of the same type
    const runs: number[][] = [];
    for (const t of fn.locals) {
      const last = runs[runs.length - 1];
      if (last && last[1] === VALTYPE[t]) last[0]++;
      else runs.push([1, VALTYPE[t]]);
    }
    const localBytes = [...uleb(runs.length), ...runs.flatMap(([n, t]) => [...uleb(n), t])];
    const body = [...localBytes, ...code, 0x0b];
    insns.forEach((x) => (x.at += localBytes.length));
    bodies.push({ bytes: [...uleb(body.length), ...body], insns: insns.map((x) => ({ ...x, at: x.at + uleb(body.length).length })) });
  });

  // sections
  const out: number[] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const sections: WasmModule['sections'] = [];
  const section = (id: number, name: string, content: number[]) => {
    if (!content.length) return;
    out.push(id, ...uleb(content.length));
    sections.push({ name, offset: out.length, size: content.length });
    out.push(...content);
  };
  const exportList: { name: string; kind: number; index: number; line: number }[] = [];
  const addExport = (name: string, kind: number, index: number, line: number) => {
    if (exportList.some((e) => e.name === name)) throw new AsmError(`"${name}" is exported twice`, line);
    exportList.push({ name, kind, index, line });
  };
  funcs.forEach((fn, i) => fn.exportNames.forEach((n) => addExport(n, 0, imports.length + i, fn.line)));
  table?.exportNames.forEach((n) => addExport(n, 1, 0, 1));
  memory?.exportNames.forEach((n) => addExport(n, 2, 0, 1));
  globals.forEach((g, i) => g.exportNames.forEach((n) => addExport(n, 3, i, 1)));
  for (const e of exports) {
    const k = { func: 0, table: 1, memory: 2, global: 3 }[e.kind];
    const idx = e.kind === 'func' ? refFunc(e.ref, e.line) : e.kind === 'global' ? (globalIdx.get(e.ref) ?? Number(e.ref)) : 0;
    addExport(e.name, k, idx, e.line);
  }

  section(1, 'type', types.length ? vec(types.map((t) => [0x60, ...vec(t.params.map((p) => [VALTYPE[p]])), ...vec(t.results.map((r) => [VALTYPE[r]]))])) : []);
  section(2, 'import', imports.length ? vec(imports.map((im) => [...str(im.module), ...str(im.name), 0x00, ...uleb(im.typeIdx)])) : []);
  section(3, 'function', funcs.length ? vec(funcs.map((f) => uleb(f.typeIdx))) : []);
  if (table) section(4, 'table', [1, 0x70, 0x00, ...uleb(table.size)]);
  if (memory) section(5, 'memory', [1, ...(memory.max !== null ? [0x01, ...uleb(memory.pages), ...uleb(memory.max)] : [0x00, ...uleb(memory.pages)])]);
  section(6, 'global', globals.length ? vec(globals.map((g) => [VALTYPE[g.type], g.mutable ? 1 : 0, ...g.init])) : []);
  section(7, 'export', exportList.length ? vec(exportList.map((e) => [...str(e.name), e.kind, ...uleb(e.index)])) : []);
  if (start) section(8, 'start', uleb(refFunc(start.ref, start.line)));
  if (elems.length) {
    if (!table) throw new AsmError('(elem …) needs a (table …)', 1);
    section(9, 'element', vec(elems.map((e) => [0x00, 0x41, ...sleb(BigInt(e.offset)), 0x0b, ...vec(e.refs.map((r) => uleb(refFunc(r.name, r.line))))])));
  }
  if (bodies.length) {
    const content = [...uleb(bodies.length)];
    const starts: number[] = [];
    for (const b of bodies) { starts.push(content.length); content.push(...b.bytes); }
    const base = out.length + 1 + uleb(content.length).length;
    section(10, 'code', content);
    bodies.forEach((b, i) => {
      for (const x of b.insns) listing.push({ addr: base + starts[i] + x.at, bytes: x.bytes, line: x.line, sect: funcs[i].name });
    });
  }
  if (datas.length) {
    if (!memory) throw new AsmError('(data …) needs a (memory …)', 1);
    section(11, 'data', vec(datas.map((d) => [0x00, 0x41, ...sleb(BigInt(d.offset)), 0x0b, ...uleb(d.bytes.length), ...d.bytes])));
  }
  // names: functions and their locals, for stack traces and debuggers
  const fnames = [...imports.map((im, i) => [i, im.fname || im.name] as const), ...funcs.map((f, i) => [imports.length + i, f.name] as const)].filter(([, n]) => n);
  const names: number[] = [...str('name')];
  const sub = (id: number, content: number[]) => names.push(id, ...uleb(content.length), ...content);
  if (fnames.length) sub(1, vec(fnames.map(([i, n]) => [...uleb(i), ...str(n.replace(/^\$/, ''))])));
  const withLocals = funcs.map((f, i) => [imports.length + i, f] as const).filter(([, f]) => f.localNames.some(Boolean));
  if (withLocals.length) sub(2, vec(withLocals.map(([i, f]) => [...uleb(i), ...vec(f.localNames.map((n, k) => [k, n] as const).filter(([, n]) => n).map(([k, n]) => [...uleb(k), ...str(n.replace(/^\$/, ''))]))])));
  section(0, 'name', names);

  const bytes = new Uint8Array(out);
  let fo = 0;
  return {
    bytes, listing, instructions, sections, types,
    imports: imports.map((im) => ({ module: im.module, name: im.name, type: types[im.typeIdx] })),
    exports: exportList.map((e) => ({ name: e.name, kind: ['func', 'table', 'memory', 'global'][e.kind], index: e.index })),
    functions: funcs.map((f, i) => {
      const b = bodies[i];
      const r = { name: f.name.replace(/^\$/, '') || `#${imports.length + i}`, index: imports.length + i, type: f.type, locals: f.locals.length, offset: fo, size: b.bytes.length, instructions: b.insns.length };
      fo += b.bytes.length;
      return r;
    }),
    memory: memory ? { pages: (memory as { pages: number }).pages, max: (memory as { max: number | null }).max } : null,
    table: table ? (table as { size: number }).size : 0,
    globals: globals.map((g) => ({ name: g.name.replace(/^\$/, ''), type: g.type, mutable: g.mutable, init: g.initText })),
    data: datas.map((d) => ({ addr: d.offset, size: d.bytes.length })),
  };
}

// ---------------------------------------------------------------------------
// one function body: validation (stack types, labels) and encoding
// ---------------------------------------------------------------------------
/** what a function body refers to: the module's types, functions, globals, memory and table */
interface Ctx {
  types: FuncType[]; typeNames: Map<string, number>; funcTypes: FuncType[];
  refFunc: (ref: string, line: number) => number; funcName: (i: number) => string;
  globals: { name: string; type: ValType; mutable: boolean }[]; globalIdx: Map<string, number>;
  hasMemory: boolean; tableSize: number;
}

interface Frame { op: string; label: string | null; results: ValType[]; branch: ValType[]; height: number; unreachable: boolean; hasElse: boolean; line: number }

class FunctionCompiler {
  stack: StackType[] = [];
  frames: Frame[] = [];
  localTypes: ValType[];
  localIdx = new Map<string, number>();

  private fn: Func;
  private cx: Ctx;

  constructor(fn: Func, cx: Ctx) {
    this.fn = fn;
    this.cx = cx;
    this.localTypes = [...fn.type.params, ...fn.locals];
    fn.localNames.forEach((n, i) => { if (n) { if (this.localIdx.has(n)) throw new AsmError(`local ${n} is declared twice`, fn.line); this.localIdx.set(n, i); } });
  }

  fail(msg: string, line: number): never { throw new AsmError(msg, line); }

  push(t: StackType): void { this.stack.push(t); }

  pop(want: StackType, what: string, line: number): StackType {
    const f = this.frames[this.frames.length - 1];
    if (this.stack.length === f.height) {
      if (f.unreachable) return want;
      this.fail(`${what}: expected ${want === 'any' ? 'a value' : want} on the stack, but it is empty`, line);
    }
    const t = this.stack.pop()!;
    if (want !== 'any' && t !== 'any' && t !== want) this.fail(`${what}: expected ${want}, found ${t}`, line);
    return t === 'any' ? want : t;
  }

  popAll(ts: ValType[], what: string, line: number): void {
    for (let i = ts.length - 1; i >= 0; i--) this.pop(ts[i], what, line);
  }

  unreachable(): void {
    const f = this.frames[this.frames.length - 1];
    this.stack.length = f.height;
    f.unreachable = true;
  }

  /** end of a block: exactly its results on the stack */
  closeCheck(f: Frame, what: string, line: number): void {
    this.popAll(f.results, what, line);
    if (this.stack.length > f.height) {
      const extra = this.stack.slice(f.height);
      this.fail(`${what}: ${extra.length} value(s) left on the stack (${extra.join(', ')})${f.results.length ? '' : '; drop them or store them'}`, line);
    }
  }

  labelDepth(t: Tok | undefined, line: number): number {
    if (!t || t.k !== 'atom') this.fail('expected a label', line);
    if (/^\d+$/.test(t.v)) { const d = Number(t.v); if (d >= this.frames.length) this.fail(`label depth ${d} is too deep`, line); return d; }
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i].label === t.v) return this.frames.length - 1 - i;
    return this.fail(`unknown label ${t.v} (it must name an enclosing block, loop or if)`, line);
  }

  local(t: Tok | undefined, line: number): number {
    if (!t || t.k !== 'atom') this.fail('expected a local', line);
    const i = this.localIdx.get(t.v) ?? (/^\d+$/.test(t.v) ? Number(t.v) : -1);
    if (i < 0 || i >= this.localTypes.length) this.fail(`unknown local ${t.v}`, line);
    return i;
  }

  compile(insns: { at: number; bytes: number[]; line: number }[]): number[] {
    const out: number[] = [];
    this.frames.push({ op: 'func', label: null, results: this.fn.type.results, branch: this.fn.type.results, height: 0, unreachable: false, hasElse: false, line: this.fn.line });
    for (const toks of this.fn.body) {
      const line = toks[0].line;
      const bytes = this.instruction(toks, line);
      insns.push({ at: out.length, bytes, line });
      out.push(...bytes);
    }
    if (this.frames.length > 1) {
      const f = this.frames[this.frames.length - 1];
      this.fail(`'${f.op}' is not closed: missing 'end'`, f.line);
    }
    this.closeCheck(this.frames[0], `end of function ${this.fn.name || ''}`.trim(), this.fn.body[this.fn.body.length - 1]?.[0].line ?? this.fn.line);
    return out;
  }

  instruction(toks: Tok[], line: number): number[] {
    const name = toks[0].v;
    const op = OPS.get(name)!;
    const args = toks.slice(1);
    const bytes = [...op.code];
    const top = this.frames[this.frames.length - 1];
    const noArgs = () => { if (args.length) this.fail(`${name} takes no operands`, line); };
    if (op.sig !== null && op.imm === '') noArgs();
    switch (name) {
      case 'block': case 'loop': case 'if': {
        let label: string | null = null, i = 0;
        if (args[0]?.k === 'atom' && args[0].v.startsWith('$')) { label = args[0].v; i = 1; }
        const results: ValType[] = [];
        while (i < args.length) {
          if (args[i].k !== '(' || args[i + 1]?.v !== 'result') this.fail(`${name}: expected (result type)`, line);
          i += 2;
          while (i < args.length && args[i].k !== ')') results.push(this.vt(args[i++], line));
          i++;
        }
        if (name === 'if') this.pop('i32', 'if (the condition)', line);
        if (results.length > 1) this.fail(`${name}: at most one result`, line);
        bytes.push(results.length ? VALTYPE[results[0]] : 0x40);
        this.frames.push({ op: name, label, results, branch: name === 'loop' ? [] : results, height: this.stack.length, unreachable: false, hasElse: false, line });
        return bytes;
      }
      case 'else': {
        noArgs();
        if (top.op !== 'if' || top.hasElse) this.fail("'else' without 'if'", line);
        this.closeCheck(top, 'else', line);
        this.stack.length = top.height;
        top.unreachable = false;
        top.hasElse = true;
        return bytes;
      }
      case 'end': {
        noArgs();
        if (this.frames.length === 1) this.fail("'end' without block, loop or if (the function needs no 'end')", line);
        this.closeCheck(top, 'end', line);
        if (top.op === 'if' && !top.hasElse && top.results.length) this.fail(`'if' with a result needs an 'else' (opened on line ${top.line})`, line);
        this.frames.pop();
        this.stack.length = top.height;
        for (const t of top.results) this.push(t);
        return bytes;
      }
      case 'br': case 'br_if': {
        if (args.length !== 1) this.fail(`${name} takes one label`, line);
        const d = this.labelDepth(args[0], line);
        const target = this.frames[this.frames.length - 1 - d];
        if (name === 'br_if') this.pop('i32', 'br_if (the condition)', line);
        this.popAll(target.branch, name, line);
        if (name === 'br') this.unreachable(); else for (const t of target.branch) this.push(t);
        bytes.push(...uleb(d));
        return bytes;
      }
      case 'br_table': {
        if (args.length < 1) this.fail('br_table needs labels', line);
        const ds = args.map((a) => this.labelDepth(a, line));
        this.pop('i32', 'br_table (the index)', line);
        const def = this.frames[this.frames.length - 1 - ds[ds.length - 1]];
        this.popAll(def.branch, 'br_table', line);
        this.unreachable();
        bytes.push(...uleb(ds.length - 1), ...ds.flatMap((d) => uleb(d)));
        return bytes;
      }
      case 'return': noArgs(); this.popAll(this.fn.type.results, 'return', line); this.unreachable(); return bytes;
      case 'unreachable': noArgs(); this.unreachable(); return bytes;
      case 'call': {
        if (args.length !== 1 || args[0].k !== 'atom') this.fail('call takes one function', line);
        const i = this.cx.refFunc(args[0].v, line);
        const t = this.cx.funcTypes[i];
        this.popAll(t.params, `call ${this.cx.funcName(i)}`, line);
        for (const r of t.results) this.push(r);
        bytes.push(...uleb(i));
        return bytes;
      }
      case 'call_indirect': {
        if (!this.cx.tableSize) this.fail('call_indirect needs a (table …)', line);
        if (args[0]?.k !== '(' || args[1]?.v !== 'type' || !args[2]) this.fail('call_indirect (type $t)', line);
        const ref = args[2].v;
        const ti = this.cx.typeNames.get(ref) ?? (/^\d+$/.test(ref) ? Number(ref) : -1);
        if (ti < 0 || ti >= this.cx.types.length) this.fail(`unknown type ${ref}`, line);
        this.pop('i32', 'call_indirect (the table index)', line);
        this.popAll(this.cx.types[ti].params, 'call_indirect', line);
        for (const r of this.cx.types[ti].results) this.push(r);
        bytes.push(...uleb(ti), 0x00);
        return bytes;
      }
      case 'drop': noArgs(); this.pop('any', 'drop', line); return bytes;
      case 'select': {
        noArgs();
        this.pop('i32', 'select (the condition)', line);
        const b = this.pop('any', 'select', line);
        this.pop(b, 'select', line);
        this.push(b);
        return bytes;
      }
      case 'local.get': case 'local.set': case 'local.tee': {
        if (args.length !== 1) this.fail(`${name} takes one local`, line);
        const i = this.local(args[0], line);
        const t = this.localTypes[i];
        if (name !== 'local.get') this.pop(t, `${name} ${args[0].v}`, line);
        if (name !== 'local.set') this.push(t);
        bytes.push(...uleb(i));
        return bytes;
      }
      case 'global.get': case 'global.set': {
        if (args.length !== 1 || args[0].k !== 'atom') this.fail(`${name} takes one global`, line);
        const i = this.cx.globalIdx.get(args[0].v) ?? (/^\d+$/.test(args[0].v) ? Number(args[0].v) : -1);
        if (i < 0 || i >= this.cx.globals.length) this.fail(`unknown global ${args[0].v}`, line);
        const g = this.cx.globals[i];
        if (name === 'global.set') { if (!g.mutable) this.fail(`global ${args[0].v} is immutable`, line); this.pop(g.type, name, line); }
        else this.push(g.type);
        bytes.push(...uleb(i));
        return bytes;
      }
    }
    // the rest: plain stack signatures plus immediates
    switch (op.imm) {
      case 'mem': {
        if (!this.cx.hasMemory) this.fail(`${name} needs a (memory …)`, line);
        let offset = 0n, align = op.align!;
        for (const a of args) {
          const m = /^(offset|align)=(0x[0-9a-f]+|\d+)$/i.exec(a.v);
          if (!m || a.k !== 'atom') this.fail(`${name}: expected offset=N or align=N, found '${a.v}'`, line);
          const v = BigInt(m[2]);
          if (m[1] === 'offset') { if (v >= 1n << 32n) this.fail(`offset ${v} does not fit into 32 bits`, line); offset = v; }
          else {
            if (v & (v - 1n) || v === 0n) this.fail(`align=${v} must be a power of two`, line);
            align = Math.log2(Number(v));
            if (align > op.align!) this.fail(`align=${v} is larger than the access (${2 ** op.align!} bytes)`, line);
          }
        }
        bytes.push(...uleb(align), ...uleb(offset));
        break;
      }
      case 'i32': case 'i64': {
        if (args.length !== 1) this.fail(`${name} takes one number`, line);
        bytes.push(...sleb(parseInteger(args[0].v, op.imm === 'i32' ? 32 : 64, line)));
        break;
      }
      case 'f32': case 'f64': {
        if (args.length !== 1) this.fail(`${name} takes one number`, line);
        const v = parseFloatText(args[0].v, line);
        bytes.push(...(op.imm === 'f32' ? f32bytes(v) : f64bytes(v)));
        break;
      }
      case 'zero': noArgs(); if (!this.cx.hasMemory) this.fail(`${name} needs a (memory …)`, line); bytes.push(0x00); break;
      case 'zero2': noArgs(); if (!this.cx.hasMemory) this.fail(`${name} needs a (memory …)`, line); bytes.push(0x00, 0x00); break;
      case '': break;
      default: this.fail(`internal: ${name}`, line);
    }
    const [ins, outs] = op.sig!.split(':');
    for (let i = ins.length - 1; i >= 0; i--) this.pop(LETTER[ins[i]], name, line);
    for (const o of outs) this.push(LETTER[o]);
    return bytes;
  }

  vt(t: Tok, line: number): ValType {
    if (!(t.v in VALTYPE)) this.fail(`'${t.v}' is not a value type`, line);
    return t.v as ValType;
  }
}

import type { Token } from './lexer.ts';

// Memory access types: element size + signedness.
export type MemType = 'i8' | 'u8' | 'i16' | 'u16' | 'i32' | 'u32' | 'i64' | 'u64' | 'ptr' | 'f32' | 'f64';
export const MEM_TYPES: readonly string[] = ['i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64', 'ptr', 'f32', 'f64'];

export function memSize(t: MemType): number {
  switch (t) {
    case 'i8': case 'u8': return 1;
    case 'i16': case 'u16': return 2;
    case 'i32': case 'u32': case 'f32': return 4;
    default: return 8;
  }
}

export function memSigned(t: MemType): boolean {
  return t[0] === 'i';
}

export type BinOp =
  | '+' | '-' | '*' | '/' | '%' | '&' | '|' | '^' | '<<' | '>>' | '>>>'
  | '==' | '!=' | '<' | '<=' | '>' | '>='
  | '&&' | '||';

export type Expr =
  | { k: 'num'; v: bigint; t: Token }
  | { k: 'float'; v: number; t: Token }
  | { k: 'str'; bytes: number[]; t: Token }
  | { k: 'name'; name: string; t: Token }
  | { k: 'un'; op: '-' | '~' | '!'; e: Expr; t: Token }
  | { k: 'bin'; op: BinOp; l: Expr; r: Expr; t: Token }
  | { k: 'tern'; c: Expr; a: Expr; b: Expr; t: Token }
  | { k: 'call'; name: string; args: Expr[]; t: Token }
  | { k: 'index'; name: string; index: Expr; t: Token }
  // ty === null: size taken from the register on the other side of the assignment
  | { k: 'mem'; ty: MemType | null; addr: Expr; post: 1 | -1 | 0; t: Token }
  | { k: 'addr'; e: Expr; t: Token };

/** A raw assembler line: tokens plus the whitespace preceding each one. */
export interface RawLine {
  parts: { gap: string; tok: Token }[];
  line: number;
}

export interface LetDecl {
  name: string;
  reg: string | 'auto' | null; // null => auto
  unsigned: boolean;
  init: Expr | null;
  t: Token;
}

export type Stmt =
  | { k: 'let'; decls: LetDecl[]; t: Token }
  | { k: 'assign'; target: Expr; op: string; value: Expr; t: Token }
  | { k: 'incdec'; target: Expr; op: '++' | '--'; t: Token }
  | { k: 'expr'; e: Expr; t: Token }
  | { k: 'if'; arms: { cond: Expr; body: Stmt[] }[]; els: Stmt[] | null; t: Token }
  | { k: 'while'; cond: Expr; body: Stmt[]; label: string | null; t: Token }
  | { k: 'dowhile'; body: Stmt[]; cond: Expr; label: string | null; t: Token }
  | { k: 'loop'; body: Stmt[]; label: string | null; t: Token }
  | { k: 'for'; init: Stmt[]; cond: Expr | null; step: Stmt[]; body: Stmt[]; label: string | null; t: Token }
  | {
    k: 'forin'; v: string; reg: string | null; from: Expr; to: Expr; inclusive: boolean;
    step: Expr | null; body: Stmt[]; label: string | null; t: Token;
  }
  | { k: 'break'; label: string | null; t: Token }
  | { k: 'continue'; label: string | null; t: Token }
  | { k: 'return'; e: Expr | null; t: Token }
  | { k: 'goto'; label: string; t: Token }
  | { k: 'label'; name: string; t: Token }
  | { k: 'asm'; lines: RawLine[]; t: Token }
  | { k: 'asmtext'; text: string; t: Token }
  | { k: 'block'; body: Stmt[]; t: Token }
  | { k: 'push' | 'pop'; regs: Expr[]; t: Token }
  | { k: 'local'; name: string; ty: TypeRef; t: Token }
  | { k: 'const'; name: string; e: Expr; t: Token };

export interface TypeRef {
  name: string;          // MemType or struct name
  count: Expr | null;    // array element count
  t: Token;
}

export type DataInit =
  | { k: 'expr'; e: Expr }
  | { k: 'list'; items: Expr[] };

export interface Param {
  name: string;
  reg: string | 'auto' | null;
  ty: MemType | null;        // C-level type annotation (`n: i32`, `p: ptr`, `x: f64`)
  unsigned: boolean;
  t: Token;
}

export type Item =
  | {
    k: 'fn'; name: string; params: Param[]; body: Stmt[]; exported: boolean; naked: boolean;
    ret: string | null;      // `-> i64` / `-> f64` / `-> void` / `-> x0`: result type for C headers
    t: Token; end: Token;
  }
  | { k: 'extern'; name: string; fixed: number | null; t: Token }
  | { k: 'const'; name: string; e: Expr; exported?: boolean; t: Token }
  | { k: 'alias'; decl: LetDecl }
  | { k: 'data'; name: string; ty: TypeRef | null; init: DataInit | null; ro: boolean; exported?: boolean; t: Token }
  | { k: 'struct'; name: string; fields: { name: string; ty: TypeRef }[]; exported?: boolean; t: Token }
  | { k: 'enum'; name: string; members: { name: string; e: Expr | null; t: Token }[]; exported?: boolean; t: Token }
  | { k: 'asm'; lines: RawLine[]; t: Token };

export interface Program {
  items: Item[];
}

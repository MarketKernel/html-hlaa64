// HLA64 lexer: turns source text into a flat token list.
// Every token remembers its source span and whether a line break preceded it:
// statements in HLA64 end at a newline or ';', and raw assembler lines are
// reconstructed from the original source slice.

export type TokKind = 'ident' | 'num' | 'float' | 'str' | 'char' | 'op' | 'eof';

export interface Token {
  kind: TokKind;
  text: string;          // raw text (for 'str' — decoded value)
  value?: bigint;        // for 'num' and 'char'
  fvalue?: number;       // for 'float'
  bytes?: number[];      // for 'str' — decoded UTF-8 bytes
  start: number;         // offset in source
  end: number;
  line: number;          // 1-based
  col: number;           // 1-based
  nl: boolean;           // a newline precedes this token
}

export class CompileError extends Error {
  line: number;
  col: number;
  constructor(message: string, line: number, col: number) {
    super(message);
    this.line = line;
    this.col = col;
  }
}

// Longest operators first.
const OPS = [
  '>>>=', '<<=', '>>=', '>>>', '...', '..=',
  '==', '!=', '<=', '>=', '&&', '||', '<<', '>>', '++', '--', '+=', '-=', '*=', '/=', '%=',
  '&=', '|=', '^=', '->', '..', '::',
  '+', '-', '*', '/', '%', '&', '|', '^', '~', '!', '<', '>', '=', '(', ')', '[', ']', '{', '}',
  ',', ';', ':', '.', '#', '@', '?',
];

export function lex(src: string): Token[] {
  const toks: Token[] = [];
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;   // a UTF-8 byte order mark (PowerShell 5.1, Notepad) is not part of the program
  let line = 1;
  let lineStart = i;
  let nl = true;

  const err = (msg: string, at = i): never => {
    throw new CompileError(msg, line, at - lineStart + 1);
  };

  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { i++; line++; lineStart = i; nl = true; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const startLine = line, startCol = i - lineStart + 1;
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') { line++; lineStart = i + 1; nl = true; }
        i++;
      }
      if (i >= src.length) throw new CompileError('unterminated comment', startLine, startCol);
      i += 2;
      continue;
    }

    const start = i;
    const col = i - lineStart + 1;
    const push = (t: Omit<Token, 'start' | 'end' | 'line' | 'col' | 'nl'>) => {
      toks.push({ ...t, start, end: i, line, col, nl });
      nl = false;
    };

    if (/[A-Za-z_$]/.test(c)) {
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) i++;
      push({ kind: 'ident', text: src.slice(start, i) });
      continue;
    }

    if (/[0-9]/.test(c)) {
      let text: string;
      if (c === '0' && /[xXbBoO]/.test(src[i + 1] ?? '')) {
        i += 2;
        while (i < src.length && /[0-9A-Fa-f_]/.test(src[i])) i++;
        text = src.slice(start, i);
        const p = text[1].toLowerCase();
        const digits = text.slice(2).replace(/_/g, '');
        if (!digits) err('malformed number', start);
        const re = p === 'x' ? /^[0-9a-f]+$/i : p === 'b' ? /^[01]+$/ : /^[0-7]+$/;
        if (!re.test(digits)) err(`malformed number '${text}'`, start);
        push({ kind: 'num', text, value: BigInt('0' + p + digits) });
        continue;
      }
      while (i < src.length && /[0-9_]/.test(src[i])) i++;
      // float: digits '.' digits (but not '..' range operator)
      if (src[i] === '.' && /[0-9]/.test(src[i + 1] ?? '')) {
        i++;
        while (i < src.length && /[0-9_]/.test(src[i])) i++;
        if (/[eE]/.test(src[i] ?? '')) {
          i++;
          if (/[+-]/.test(src[i] ?? '')) i++;
          while (i < src.length && /[0-9]/.test(src[i])) i++;
        }
        text = src.slice(start, i);
        push({ kind: 'float', text, fvalue: parseFloat(text.replace(/_/g, '')) });
        continue;
      }
      text = src.slice(start, i);
      push({ kind: 'num', text, value: BigInt(text.replace(/_/g, '')) });
      continue;
    }

    if (c === '"') {
      i++;
      const bytes: number[] = [];
      while (true) {
        if (i >= src.length || src[i] === '\n') err('unterminated string', start);
        const ch = src[i];
        if (ch === '"') { i++; break; }
        if (ch === '\\') {
          i++;
          bytes.push(...readEscape());
          continue;
        }
        const cp = src.codePointAt(i)!;
        i += cp > 0xffff ? 2 : 1;
        bytes.push(...utf8(cp));
      }
      push({ kind: 'str', text: src.slice(start, i), bytes });
      continue;
    }

    if (c === "'") {
      i++;
      let v: number[];
      if (src[i] === '\\') { i++; v = readEscape(); }
      else { const cp = src.codePointAt(i)!; i += cp > 0xffff ? 2 : 1; v = utf8(cp); }
      if (src[i] !== "'") err('unterminated character literal', start);
      i++;
      let value = 0n;
      for (const b of v) value = (value << 8n) | BigInt(b);
      push({ kind: 'char', text: src.slice(start, i), value });
      continue;
    }

    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) err(`unexpected character '${c}'`);
    i += op!.length;
    push({ kind: 'op', text: op! });
  }

  toks.push({ kind: 'eof', text: '<end of file>', start: i, end: i, line, col: i - lineStart + 1, nl: true });
  return toks;

  function readEscape(): number[] {
    const e = src[i++];
    switch (e) {
      case 'n': return [10];
      case 't': return [9];
      case 'r': return [13];
      case '0': return [0];
      case 'a': return [7];
      case 'b': return [8];
      case 'e': return [27];
      case 'f': return [12];
      case 'v': return [11];
      case '\\': return [92];
      case '"': return [34];
      case "'": return [39];
      case 'x': {
        const h = src.slice(i, i + 2);
        if (!/^[0-9a-fA-F]{2}$/.test(h)) err('bad \\x escape', i - 2);
        i += 2;
        return [parseInt(h, 16)];
      }
      default:
        return err(`unknown escape '\\${e}'`, i - 2);
    }
  }
}

export function utf8(cp: number): number[] {
  if (cp < 0x80) return [cp];
  if (cp < 0x800) return [0xc0 | (cp >> 6), 0x80 | (cp & 63)];
  if (cp < 0x10000) return [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
  return [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
}

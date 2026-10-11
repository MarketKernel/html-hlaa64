// C printf formatting over emulator memory. `next()` yields the raw 64-bit
// argument slots in order (Apple arm64 passes variadic arguments on the stack).
import { bitsToF64, type Memory } from './cpu.ts';

/**
 * `llp64`: Windows data model — `long` is 32 bits (`%ld` prints 32 bits; use `%lld` or `%I64d`).
 * Default is LP64 (macOS/Linux): `long` is 64 bits.
 */
export function formatPrintf(mem: Memory, fmtAddr: number, next: () => bigint, opts: { llp64?: boolean } = {}): number[] {
  const fmt = mem.cstring(fmtAddr);
  const out: number[] = [];
  const pushStr = (s: string) => { for (const b of new TextEncoder().encode(s)) out.push(b); };
  let i = 0;
  while (i < fmt.length) {
    const ch = fmt[i++];
    if (ch !== 37 /* % */) { out.push(ch); continue; }
    let flags = '';
    while (i < fmt.length && '-+ #0'.includes(String.fromCharCode(fmt[i]))) flags += String.fromCharCode(fmt[i++]);
    let width = -1;
    if (fmt[i] === 42) { width = Number(BigInt.asIntN(32, next() & 0xffffffffn)); i++; if (width < 0) { flags += '-'; width = -width; } }
    else { let w = ''; while (fmt[i] >= 48 && fmt[i] <= 57) w += String.fromCharCode(fmt[i++]); if (w) width = Number(w); }
    let prec = -1;
    if (fmt[i] === 46) {
      i++;
      if (fmt[i] === 42) { prec = Number(BigInt.asIntN(32, next() & 0xffffffffn)); i++; }
      else { let p = ''; while (fmt[i] >= 48 && fmt[i] <= 57) p += String.fromCharCode(fmt[i++]); prec = Number(p || '0'); }
    }
    let len = '';
    // Microsoft size prefixes: %I64d, %I32d, %Id
    if (fmt[i] === 73 /* I */) {
      i++;
      if (fmt[i] === 54 && fmt[i + 1] === 52) { len = 'I64'; i += 2; }
      else if (fmt[i] === 51 && fmt[i + 1] === 50) { len = 'I32'; i += 2; }
      else len = 'I64';
    }
    while (i < fmt.length && 'hljztqL'.includes(String.fromCharCode(fmt[i]))) len += String.fromCharCode(fmt[i++]);
    const conv = String.fromCharCode(fmt[i++] ?? 0);
    const bits = len === 'hh' ? 8 : len === 'h' ? 16 : len === '' || len === 'I32' || (len === 'l' && opts.llp64) ? 32 : 64;
    const left = flags.includes('-');
    const pad = (body: string, sign = '', zeroOk = true) => {
      const total = sign.length + body.length;
      if (width <= total) return sign + body;
      if (left) return sign + body + ' '.repeat(width - total);
      if (flags.includes('0') && zeroOk) return sign + '0'.repeat(width - total) + body;
      return ' '.repeat(width - total) + sign + body;
    };
    switch (conv) {
      case '%': out.push(37); break;
      case 'd': case 'i': {
        const v = BigInt.asIntN(bits, next());
        let body = (v < 0n ? -v : v).toString();
        if (prec >= 0) body = prec === 0 && v === 0n ? '' : body.padStart(prec, '0');
        const sign = v < 0n ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
        pushStr(pad(body, sign, prec < 0));
        break;
      }
      case 'u': case 'x': case 'X': case 'o': {
        const v = BigInt.asUintN(bits, next());
        const radix = conv === 'u' ? 10 : conv === 'o' ? 8 : 16;
        let body = v.toString(radix);
        if (conv === 'X') body = body.toUpperCase();
        if (prec >= 0) body = prec === 0 && v === 0n ? '' : body.padStart(prec, '0');
        let prefix = '';
        if (flags.includes('#') && v !== 0n) prefix = conv === 'x' ? '0x' : conv === 'X' ? '0X' : conv === 'o' ? '0' : '';
        pushStr(pad(body, prefix, prec < 0));
        break;
      }
      case 'p': pushStr(pad('0x' + BigInt.asUintN(64, next()).toString(16))); break;
      case 'c': pushStr(pad(String.fromCharCode(Number(next() & 0xffn)))); break;
      case 's': {
        // C counts width and precision in bytes, not characters
        const p = Number(next());
        let s = p ? mem.cstring(p) : new TextEncoder().encode('(null)');
        if (prec >= 0) s = s.subarray(0, prec);
        const fill = Math.max(0, width - s.length);
        if (!left) for (let k = 0; k < fill; k++) out.push(32);
        for (const b of s) out.push(b);
        if (left) for (let k = 0; k < fill; k++) out.push(32);
        break;
      }
      case 'f': case 'F': case 'e': case 'E': case 'g': case 'G': case 'a': case 'A': {
        const v = bitsToF64(next());
        const sign = v < 0 || Object.is(v, -0) ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
        const a = Math.abs(v);
        let body: string;
        if (!Number.isFinite(a)) body = Number.isNaN(a) ? 'nan' : 'inf';
        else body = formatFloat(a, conv.toLowerCase(), prec < 0 ? 6 : prec, flags.includes('#'));
        if (conv === conv.toUpperCase()) body = body.toUpperCase();
        pushStr(pad(body, sign, Number.isFinite(a)));
        break;
      }
      case 'n': next(); break;
      default: out.push(37); pushStr(len + conv);
    }
  }
  return out;
}

function fixExp(s: string): string {
  // JS: 1.5e+5  ->  C: 1.5e+05
  return s.replace(/e([+-])(\d)$/, 'e$10$2');
}

function formatFloat(a: number, conv: string, prec: number, alt: boolean): string {
  if (conv === 'f') return toFixed(a, prec);
  if (conv === 'e') return fixExp(a.toExponential(prec));
  if (conv === 'a') return a.toString(16);
  // %g
  const P = prec === 0 ? 1 : prec;
  const X = a === 0 ? 0 : Math.floor(Math.log10(Number(a.toExponential(P - 1))));
  let s = P > X && X >= -4 ? toFixed(a, P - 1 - X) : fixExp(a.toExponential(P - 1));
  if (!alt) {
    if (s.includes('e')) s = s.replace(/\.?0+e/, 'e');
    else if (s.includes('.')) s = s.replace(/\.?0+$/, '');
  }
  return s;
}

function toFixed(a: number, prec: number): string {
  if (a < 1e21) return a.toFixed(Math.min(prec, 100));
  // large values: exact integer digits via BigInt
  const int = BigInt(Math.trunc(a)).toString();
  return prec > 0 ? int + '.' + '0'.repeat(prec) : int;
}

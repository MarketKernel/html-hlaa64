// x86-64 register table.

export interface XReg {
  k: 'reg';
  name: string;
  n: number;                  // 0..15 (encoding number incl. REX bit)
  size: 1 | 2 | 4 | 8 | 16;   // bytes; 16 = xmm
  xmm: boolean;
  high8: boolean;             // ah, ch, dh, bh (cannot be used with REX)
  rex8: boolean;              // spl, bpl, sil, dil (need a REX prefix)
}

const table = new Map<string, XReg>();
const add = (name: string, n: number, size: XReg['size'], extra: Partial<XReg> = {}) =>
  table.set(name, { k: 'reg', name, n, size, xmm: false, high8: false, rex8: false, ...extra });

const legacy = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'];
legacy.forEach((r, i) => {
  add('r' + r, i, 8);
  add('e' + r, i, 4);
  add(r, i, 2);
});
['al', 'cl', 'dl', 'bl'].forEach((r, i) => add(r, i, 1));
['spl', 'bpl', 'sil', 'dil'].forEach((r, i) => add(r, i + 4, 1, { rex8: true }));
['ah', 'ch', 'dh', 'bh'].forEach((r, i) => add(r, i + 4, 1, { high8: true }));
for (let i = 8; i < 16; i++) {
  add(`r${i}`, i, 8);
  add(`r${i}d`, i, 4);
  add(`r${i}w`, i, 2);
  add(`r${i}b`, i, 1);
}
for (let i = 0; i < 16; i++) add(`xmm${i}`, i, 16, { xmm: true });

export function xreg(name: string): XReg | null {
  return table.get(name.toLowerCase()) ?? null;
}

/** The same register viewed with another size (rax/eax/ax/al, r8/r8d/r8w/r8b). */
export function xview(r: XReg, size: 1 | 2 | 4 | 8): XReg {
  if (r.xmm) return r;
  for (const x of table.values()) if (!x.xmm && !x.high8 && x.n === r.n && x.size === size) return x;
  throw new Error(`no ${size}-byte view of ${r.name}`);
}

export const GPR64 = ['rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'];

/** Condition code suffixes -> 4-bit condition numbers. */
export const XCOND: Record<string, number> = {
  o: 0, no: 1, b: 2, c: 2, nae: 2, ae: 3, nb: 3, nc: 3, e: 4, z: 4, ne: 5, nz: 5, be: 6, na: 6, a: 7, nbe: 7,
  s: 8, ns: 9, p: 10, pe: 10, np: 11, po: 11, l: 12, nge: 12, ge: 13, nl: 13, le: 14, ng: 14, g: 15, nle: 15,
};

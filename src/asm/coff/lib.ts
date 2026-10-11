// Windows libraries: the Microsoft `ar` archive format (.lib) read by link.exe and lld-link.
//  * writeCoffArchive: static library made of COFF objects
//  * writeImportLibrary: import library for a DLL (import descriptor objects + short
//    import members), the same bytes llvm-lib /def and llvm-dlltool produce
import type { ArchiveMember } from '../archive.ts';

export type { ArchiveMember } from '../archive.ts';

const enc = new TextEncoder();
const MACHINE_AMD64 = 0x8664;

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** 60-byte member header; `blank` leaves date/uid/gid/mode empty (the long-name table) */
function header(name: string, size: number, mode: string, blank = false): Uint8Array {
  const f = (v: string, n: number) => v.padEnd(n, ' ').slice(0, n);
  return enc.encode(f(name, 16) + (blank ? ' '.repeat(32) : f('0', 12) + f('0', 6) + f('0', 6) + f(mode, 8)) + f(String(size), 10) + '`\n');
}

/**
 * Microsoft archive: first linker member (big-endian, symbols in member order), second
 * linker member (little-endian, symbols sorted), long-name table, members on even offsets.
 */
export function writeCoffArchive(members: ArchiveMember[]): Uint8Array {
  // long names ("/offset") for names that do not fit "name/" in 16 bytes
  const longParts: number[] = [];
  const memberNames = members.map((m) => {
    if (m.name.length <= 15) return m.name + '/';
    const off = longParts.length;
    longParts.push(...enc.encode(m.name), 0);
    return '/' + off;
  });
  const syms = members.flatMap((m, i) => m.symbols.map((s) => ({ s, i, b: enc.encode(s) })));
  const strSize = syms.reduce((a, x) => a + x.b.length + 1, 0);
  const even = (n: number) => n + (n & 1);
  // the linker members include their NUL padding in the size (like llvm-lib and lib.exe)
  const first = even(4 + 4 * syms.length + strSize);
  const second = even(4 + 4 * members.length + 4 + 2 * syms.length + strSize);
  let off = 8 + 60 + first + 60 + second + (longParts.length ? 60 + even(longParts.length) : 0);
  const offsets = members.map((m) => { const o = off; off += 60 + even(m.data.length); return o; });

  const pad = (b: Uint8Array) => (b.length & 1 ? concat([b, enc.encode('\n')]) : b);
  const strings = (list: typeof syms) => concat(list.map((x) => concat([x.b, new Uint8Array(1)])));
  const fit = (b: Uint8Array, n: number) => (b.length < n ? concat([b, new Uint8Array(n - b.length)]) : b);
  // first linker member
  const fm = new Uint8Array(4 + 4 * syms.length);
  const fv = new DataView(fm.buffer);
  fv.setUint32(0, syms.length, false);
  syms.forEach((x, k) => fv.setUint32(4 + 4 * k, offsets[x.i], false));
  // second linker member
  const sorted = [...syms].sort((a, b) => cmpBytes(a.b, b.b));
  const sm = new Uint8Array(4 + 4 * members.length + 4 + 2 * syms.length);
  const sv = new DataView(sm.buffer);
  sv.setUint32(0, members.length, true);
  offsets.forEach((o, k) => sv.setUint32(4 + 4 * k, o, true));
  sv.setUint32(4 + 4 * members.length, syms.length, true);
  sorted.forEach((x, k) => sv.setUint16(8 + 4 * members.length + 2 * k, x.i + 1, true));

  const parts: Uint8Array[] = [enc.encode('!<arch>\n'),
    header('/', first, '0'), fit(concat([fm, strings(syms)]), first),
    header('/', second, '0'), fit(concat([sm, strings(sorted)]), second)];
  if (longParts.length) parts.push(header('//', longParts.length, '', true), pad(new Uint8Array(longParts)));
  members.forEach((m, k) => parts.push(header(memberNames[k], m.data.length, '644'), pad(m.data)));
  return concat(parts);
}

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

// ---------------------------------------------------------------------------
// import library
// ---------------------------------------------------------------------------
class Buf {
  b: number[] = [];
  u8(v: number) { this.b.push(v & 0xff); }
  u16(v: number) { this.u8(v); this.u8(v >> 8); }
  u32(v: number) { this.u16(v & 0xffff); this.u16(v >>> 16); }
  name8(s: string) { const e = enc.encode(s); for (let i = 0; i < 8; i++) this.u8(e[i] ?? 0); }
  str(s: string) { for (const c of enc.encode(s)) this.u8(c); this.u8(0); }
  zero(n: number) { for (let i = 0; i < n; i++) this.u8(0); }
  bytes() { return new Uint8Array(this.b); }
}

const IDATA_RW = 0x40 | 0x40000000 | 0x80000000;   // INITIALIZED_DATA | READ | WRITE
const ALIGN_2 = 0x200000, ALIGN_4 = 0x300000, ALIGN_8 = 0x400000;

function fileHeader(b: Buf, nsect: number, symPtr: number, nsym: number): void {
  b.u16(MACHINE_AMD64); b.u16(nsect); b.u32(0); b.u32(symPtr); b.u32(nsym); b.u16(0); b.u16(0);
}

function section(b: Buf, name: string, size: number, ptr: number, relocPtr: number, nreloc: number, flags: number): void {
  b.name8(name); b.u32(0); b.u32(0); b.u32(size); b.u32(ptr); b.u32(relocPtr); b.u32(0); b.u16(nreloc); b.u16(0); b.u32(flags);
}

/** symbol whose name is at `strOff` in the string table (strOff < 0: short name) */
function symbol(b: Buf, name: string | number, sect: number, cls: number): void {
  if (typeof name === 'number') { b.u32(0); b.u32(name); } else b.name8(name);
  b.u32(0); b.u16(sect); b.u16(0); b.u8(cls); b.u8(0);
}

function stringTable(b: Buf, names: string[]): void {
  b.u32(4 + names.reduce((a, n) => a + enc.encode(n).length + 1, 0));
  for (const n of names) b.str(n);
}

const EXTERNAL = 2, STATIC = 3, SECTION = 104;

/** .idata$2 import directory entry + .idata$6 DLL name, referencing .idata$4/$5 */
function importDescriptor(dll: string, lib: string): Uint8Array {
  const b = new Buf();
  const desc = `__IMPORT_DESCRIPTOR_${lib}`, nullDesc = '__NULL_IMPORT_DESCRIPTOR', nullThunk = `\x7f${lib}_NULL_THUNK_DATA`;
  const nameLen = enc.encode(dll).length + 1;
  const hdr = 20 + 2 * 40;
  fileHeader(b, 2, hdr + 20 + 3 * 10 + nameLen, 7);
  section(b, '.idata$2', 20, hdr, hdr + 20, 3, ALIGN_4 | IDATA_RW);
  section(b, '.idata$6', nameLen, hdr + 20 + 30, 0, 0, ALIGN_2 | IDATA_RW);
  b.zero(20);
  // relocations (IMAGE_REL_AMD64_ADDR32NB): Name -> .idata$6, ILT -> .idata$4, IAT -> .idata$5
  for (const [off, sym] of [[12, 2], [0, 3], [16, 4]]) { b.u32(off); b.u32(sym); b.u16(3); }
  b.str(dll);
  symbol(b, 4, 1, EXTERNAL);
  symbol(b, '.idata$2', 1, SECTION);
  symbol(b, '.idata$6', 2, STATIC);
  symbol(b, '.idata$4', 0, SECTION);
  symbol(b, '.idata$5', 0, SECTION);
  symbol(b, 4 + enc.encode(desc).length + 1, 0, EXTERNAL);
  symbol(b, 4 + enc.encode(desc).length + 1 + enc.encode(nullDesc).length + 1, 0, EXTERNAL);
  stringTable(b, [desc, nullDesc, nullThunk]);
  return b.bytes();
}

/** the all-zero import directory entry that terminates the table */
function nullImportDescriptor(): Uint8Array {
  const b = new Buf();
  fileHeader(b, 1, 20 + 40 + 20, 1);
  section(b, '.idata$3', 20, 20 + 40, 0, 0, ALIGN_4 | IDATA_RW);
  b.zero(20);
  symbol(b, 4, 1, EXTERNAL);
  stringTable(b, ['__NULL_IMPORT_DESCRIPTOR']);
  return b.bytes();
}

/** zero entries terminating this DLL's lookup and address tables */
function nullThunk(lib: string): Uint8Array {
  const b = new Buf();
  const hdr = 20 + 2 * 40;
  fileHeader(b, 2, hdr + 16, 1);
  section(b, '.idata$5', 8, hdr, 0, 0, ALIGN_8 | IDATA_RW);
  section(b, '.idata$4', 8, hdr + 8, 0, 0, ALIGN_8 | IDATA_RW);
  b.zero(16);
  symbol(b, 4, 1, EXTERNAL);
  stringTable(b, [`\x7f${lib}_NULL_THUNK_DATA`]);
  return b.bytes();
}

/** short import member: IMPORT_OBJECT_HEADER + name + DLL name (code, imported by name) */
function shortImport(name: string, dll: string, data: boolean): Uint8Array {
  const b = new Buf();
  b.u16(0); b.u16(0xffff); b.u16(0); b.u16(MACHINE_AMD64); b.u32(0);
  b.u32(enc.encode(name).length + 1 + enc.encode(dll).length + 1);
  b.u16(0);
  b.u16((1 << 2) | (data ? 1 : 0));          // IMPORT_OBJECT_NAME, IMPORT_OBJECT_CODE / DATA
  b.str(name); b.str(dll);
  return b.bytes();
}

export interface ImportExport { name: string; data?: boolean }

/** Import library for `dll` (e.g. "mathlib.dll") exporting the given functions. */
export function writeImportLibrary(dll: string, exports: (string | ImportExport)[]): Uint8Array {
  const lib = dll.replace(/\.[^.]*$/, '');
  const members: ArchiveMember[] = [
    { name: dll, data: importDescriptor(dll, lib), symbols: [`__IMPORT_DESCRIPTOR_${lib}`] },
    { name: dll, data: nullImportDescriptor(), symbols: ['__NULL_IMPORT_DESCRIPTOR'] },
    { name: dll, data: nullThunk(lib), symbols: [`\x7f${lib}_NULL_THUNK_DATA`] },
  ];
  for (const e of exports) {
    const x = typeof e === 'string' ? { name: e } : e;
    members.push({ name: dll, data: shortImport(x.name, dll, !!x.data), symbols: x.data ? [`__imp_${x.name}`] : [`__imp_${x.name}`, x.name] });
  }
  return writeCoffArchive(members);
}

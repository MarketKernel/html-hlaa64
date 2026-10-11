// Public API of the x86-64 Windows tool chain: assembler, COFF objects, PE linker, libraries.
import { assembleX, SCN_CODE } from './assembler.ts';
import { writeCoffObject } from '../coff/object.ts';
import { linkPE, type PeOptions, type PeResult } from '../coff/pe.ts';
import { writeCoffArchive, writeImportLibrary } from '../coff/lib.ts';
import { AsmError } from '../parse.ts';

export { AsmError } from '../parse.ts';
export { assembleX } from './assembler.ts';
export { writeCoffObject } from '../coff/object.ts';
export { linkPE } from '../coff/pe.ts';
export type { PeOptions, PeResult } from '../coff/pe.ts';
export { writeCoffArchive, writeImportLibrary } from '../coff/lib.ts';

/** Assemble x86-64 (Intel syntax) source and link it into a Windows .exe. */
export function assembleExecutableX(src: string, opts: PeOptions = {}): Uint8Array {
  return linkPE(assembleX(src), opts).bytes;
}

export function assembleAndLinkX(src: string, opts: PeOptions = {}): PeResult & { instructions: number } {
  const a = assembleX(src);
  return { ...linkPE(a, opts), instructions: a.sections.reduce((n, s) => n + s.insns.length, 0) };
}

export interface WindowsLibrary {
  obj: Uint8Array;            // NAME.obj
  staticLib: Uint8Array;      // NAME_static.lib (the object in an archive)
  dll: Uint8Array | null;     // NAME.dll (null when the library needs functions only a program can supply)
  importLib: Uint8Array | null; // NAME.lib (import library for NAME.dll)
  dllError: string | null;    // why there is no DLL
  exports: string[];
}

/** Everything a C program needs to use a library on Windows, statically or as a DLL. */
export function buildWindowsLibrary(src: string, name: string): WindowsLibrary {
  // each writer resolves fixups in place, so every output gets a fresh assembly
  const obj = writeCoffObject(assembleX(src));
  const asmb = assembleX(src);
  const exports = [...asmb.symbols.values()].filter((s) => s.global).map((s) => s.name).sort();
  const isCode = (n: string) => { const s = asmb.symbols.get(n); return !!s && (s.sect.flags & SCN_CODE) !== 0; };
  let dll: Uint8Array | null = null, importLib: Uint8Array | null = null, dllError: string | null = null;
  try {
    dll = linkPE(asmb, { kind: 'dll', dllName: `${name}.dll` }).bytes;
    importLib = writeImportLibrary(`${name}.dll`, exports.map((n) => ({ name: n, data: !isCode(n) })));
  } catch (e) {
    if (!(e instanceof AsmError)) throw e;
    dllError = e.message;
  }
  return {
    obj: obj.bytes,
    staticLib: writeCoffArchive([{ name: `${name}.obj`, data: obj.bytes, symbols: obj.exports }]),
    dll, importLib, dllError, exports,
  };
}

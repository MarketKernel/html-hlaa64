// Public API of the x86-64 Linux tool chain: the x86-64 assembler with ELF objects, the ELF linker
// (executables and shared libraries) and GNU static libraries.
import { assembleX } from '../x64/assembler.ts';
import { writeElfObject } from './object.ts';
import { linkElf, type ElfOptions, type ElfResult } from './link.ts';
import { writeGnuArchive } from './archive.ts';

export { AsmError } from '../parse.ts';
export { assembleX } from '../x64/assembler.ts';
export { writeElfObject } from './object.ts';
export { linkElf, INTERP } from './link.ts';
export type { ElfOptions, ElfResult } from './link.ts';
export { writeGnuArchive } from './archive.ts';

/** Assemble x86-64 (Intel syntax) source and link it into a Linux executable. */
export function assembleExecutableElf(src: string, opts: ElfOptions = {}): Uint8Array {
  return linkElf(assembleX(src), opts).bytes;
}

export function assembleAndLinkElf(src: string, opts: ElfOptions = {}): ElfResult & { instructions: number } {
  const a = assembleX(src);
  return { ...linkElf(a, opts), instructions: a.sections.reduce((n, s) => n + s.insns.length, 0) };
}

export interface LinuxLibrary {
  obj: Uint8Array;            // NAME.o
  staticLib: Uint8Array;      // libNAME.a
  so: Uint8Array;             // libNAME.so
  exports: string[];
  imports: string[];          // what the .so needs from the program that loads it (functions the C side defines)
}

/** Everything a C program needs to use a library on Linux, statically or as a shared library. */
export function buildLinuxLibrary(src: string, name: string): LinuxLibrary {
  // each writer resolves fixups in place, so every output gets a fresh assembly
  const obj = writeElfObject(assembleX(src));
  const so = linkElf(assembleX(src), { kind: 'so', soname: `lib${name}.so` });
  return {
    obj: obj.bytes,
    staticLib: writeGnuArchive([{ name: `${name}.o`, data: obj.bytes, symbols: obj.exports }]),
    so: so.bytes,
    exports: obj.exports,
    imports: so.imports.find((i) => i.lib === '')?.names ?? [],
  };
}

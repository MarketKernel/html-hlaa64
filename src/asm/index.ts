// Public API of the built-in assembler + linker.
import { assemble } from './assembler.ts';
import { link, type LinkOptions, type LinkResult } from './macho.ts';

export { AsmError } from './parse.ts';
export { assemble } from './assembler.ts';
export { link } from './macho.ts';
export type { LinkResult } from './macho.ts';

/** Assemble AArch64 source text and link it into a signed Mach-O executable. */
export function assembleExecutable(src: string, opts: LinkOptions = {}): Uint8Array {
  return link(assemble(src), opts).bytes;
}

export function assembleAndLink(src: string, opts: LinkOptions = {}): LinkResult & { instructions: number } {
  const a = assemble(src);
  return { ...link(a, opts), instructions: a.lines };
}

export { writeObject } from './macho-object.ts';
export { writeArchive } from './archive.ts';

// Finds a C tool chain that builds Linux x86-64 executables, for `--clang` and the tests: on Linux the
// system compiler (cc, clang or gcc), elsewhere zig, whose `zig cc -target x86_64-linux-gnu` is clang + lld
// with stub glibc libraries (nothing else to install). The glibc version matches src/asm/elf/glibc.ts.
import { onPath } from './win-toolchain.ts';

let found: string[] | null | undefined;
/** The command (program and leading arguments) of a C compiler for x86_64-linux-gnu, or null. */
export function linuxCc(): string[] | null {
  if (found !== undefined) return found;
  if (process.platform === 'linux' && process.arch === 'x64') {
    for (const c of ['cc', 'clang', 'gcc']) { const p = onPath(c); if (p) return (found = [p]); }
  }
  const zig = onPath('zig');
  // zig links its own start files and ignores -nostartfiles (the entry point still comes from -e): no warning
  return (found = zig ? [zig, 'cc', '-target', 'x86_64-linux-gnu.2.35', '-Wno-unused-command-line-argument'] : null);
}

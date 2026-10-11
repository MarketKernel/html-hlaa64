// Locates the external reference tools used by the tests (clang, lld-link, llvm-*).
// macOS: system clang + Homebrew llvm@N / lld@N (keg-only); Windows: PATH, then C:\Program Files\LLVM\bin;
// Linux: PATH. MSVC (cl, link, lib, dumpbin) on Windows: msvcEnv().
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { onPath, llvmInstalled } from '../../src/win-toolchain.ts';

export { msvcEnv } from '../../src/win-toolchain.ts';
export const isMac = process.platform === 'darwin';
export const isWindows = process.platform === 'win32';

function homebrew(name: string): string | null {
  for (const root of ['/opt/homebrew/opt', '/usr/local/opt']) {
    if (!existsSync(root)) continue;
    const kegs = readdirSync(root).filter((d) => /^(llvm|lld)(@\d+)?$/.test(d)).sort().reverse();
    for (const k of kegs) {
      const p = join(root, k, 'bin', name);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

const cache = new Map<string, string | null>();
/** Path to a tool, or null when it is not installed. */
export function tool(name: 'clang' | 'lld-link' | 'llvm-dlltool' | 'llvm-readobj' | 'llvm-objdump' | 'llvm-lib' | 'llvm-mc'): string | null {
  if (cache.has(name)) return cache.get(name)!;
  let p: string | null = null;
  if (name === 'clang') p = onPath('clang');
  else if (name === 'llvm-objdump' && isMac) p = homebrew(name) ?? onPath('objdump');
  else p = homebrew(name) ?? onPath(name);
  p ??= llvmInstalled(name);
  cache.set(name, p);
  return p;
}

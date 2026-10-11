// Finds clang and the Visual Studio C++ environment on Windows, for `--clang` and the tests.
// A plain console has neither on PATH: the LLVM installer does not add itself, and cl, link and the
// INCLUDE/LIB variables (headers and C runtime, which clang needs as well) come from vcvars64.bat.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';

/** First match of `name` on PATH (where / which), or null. */
export function onPath(name: string): string | null {
  const r = spawnSync(isWindows ? 'where' : 'which', [isWindows ? name + '.exe' : name], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() || null : null;
}

/** An LLVM tool from the default install directory (C:\Program Files\LLVM\bin), or null. */
export function llvmInstalled(name: string): string | null {
  if (!isWindows) return null;
  const p = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'LLVM', 'bin', name + '.exe');
  return existsSync(p) ? p : null;
}

let msvc: NodeJS.ProcessEnv | null | undefined;
/** Environment with MSVC (cl, link, lib, dumpbin, INCLUDE, LIB): the current one when cl is already on
 *  PATH (a Native Tools prompt), else vcvars64.bat of the newest Visual Studio found by vswhere; null without it. */
export function msvcEnv(): NodeJS.ProcessEnv | null {
  if (msvc !== undefined) return msvc;
  msvc = null;
  if (!isWindows) return msvc;
  if (onPath('cl')) return (msvc = process.env);
  const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!existsSync(vswhere)) return msvc;
  const vs = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' });
  const vcvars = join(vs.stdout.trim().split(/\r?\n/)[0] ?? '', 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  if (vs.status !== 0 || !existsSync(vcvars)) return msvc;
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${vcvars}" >nul && set"`], { encoding: 'utf8', windowsVerbatimArguments: true });
  if (r.status !== 0) return msvc;
  const env: NodeJS.ProcessEnv = {};
  for (const line of r.stdout.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
  return (msvc = env);
}

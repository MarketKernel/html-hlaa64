// C interop on Windows x64, checked with clang (MSVC target) + lld-link and the x64 emulator:
//  1. mathlib.hla as a static library (mathlib_static.lib) linked into a C program
//  2. mathlib.hla as mathlib.dll + import library mathlib.lib (C compiled with MATHLIB_DLL)
//  3. app.hla (an HLA64 program) calling C functions from helpers.c
// The import library must also match llvm-lib /def byte for byte.
// On Windows the executables are run natively as well, and with Visual Studio installed the same is
// built with MSVC (cl, link) and our files are checked with lib /list and dumpbin.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileX64, compileLibraryX64 } from '../src/lang/x64/codegen.ts';
import { buildWindowsLibrary, assembleX, writeCoffObject, writeImportLibrary } from '../src/asm/x64/index.ts';
import { runPE } from '../src/emu/x64/pe-loader.ts';
import { tool, msvcEnv } from './lib/toolchain.ts';

const clang = tool('clang'), lld = tool('lld-link'), dlltool = tool('llvm-dlltool'), llvmLib = tool('llvm-lib');
if (!clang || !lld || !dlltool) { console.log('x64-lib: clang, lld-link and llvm-dlltool are needed: skipping'); process.exit(0); }
const src = 'tests/x64/lib';
const dir = mkdtempSync(join(tmpdir(), 'hla-x64lib-'));
let fails = 0;
const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: dir });
  if (r.status !== 0) throw new Error(`${cmd.split(/[\\/]/).pop()} ${args.join(' ')}\n${r.stderr}${r.stdout}`);
  return r.stdout;
};
const expect = (what: string, got: string, want: string) => {
  if (got === want) { console.log(`ok   ${what}`); return; }
  fails++;
  console.log(`FAIL ${what}\n--- got\n${got}--- want\n${want}`);
};
const exec = (what: string, exe: string, want: string, dlls: Record<string, Uint8Array> = {}) => {
  const r = runPE(new Uint8Array(readFileSync(join(dir, exe))), { dlls });
  expect(`${what} (emulator)`, r.stdout + (r.error ? `error: ${r.error}\n` : ''), want);
  if (process.platform === 'win32') {
    const nr = spawnSync(join(dir, exe), [], { encoding: 'utf8', cwd: dir });
    expect(`${what} (native)`, nr.stdout.replace(/\r\n/g, '\n'), want);   // msvcrt text mode: \r\n
  }
};

// import library for msvcrt.dll (the C runtime the programs use)
writeFileSync(join(dir, 'msvcrt.def'), 'LIBRARY msvcrt.dll\nEXPORTS\nprintf\nputs\nexit\n');
run(dlltool, ['-m', 'i386:x86-64', '-d', 'msvcrt.def', '-l', 'msvcrt.lib']);
const cc = (file: string, extra: string[] = []) =>
  run(clang, ['--target=x86_64-pc-windows-msvc', '-ffreestanding', '-O1', '-Wall', '-c', ...extra, '-I', dir, join(process.cwd(), src, file), '-o', join(dir, file.replace(/\.c$/, extra.length ? '.dll.obj' : '.obj'))]);

try {
  // ------------------------------------------------------------ the library
  const lib = compileLibraryX64(readFileSync(join(src, 'mathlib.hla'), 'utf8'), 'mathlib');
  writeFileSync(join(dir, 'mathlib.h'), lib.header);
  const built = buildWindowsLibrary(lib.asm, 'mathlib');
  if (!built.dll || !built.importLib) throw new Error('no DLL: ' + built.dllError);
  const out = { ...built, dll: built.dll, importLib: built.importLib };
  writeFileSync(join(dir, 'mathlib.obj'), out.obj);
  writeFileSync(join(dir, 'mathlib_static.lib'), out.staticLib);
  writeFileSync(join(dir, 'mathlib.dll'), out.dll);
  writeFileSync(join(dir, 'mathlib.lib'), out.importLib);
  const mainWant = readFileSync(join(src, 'main.expected'), 'utf8');

  // static
  cc('main.c');
  run(lld, ['/nologo', '/subsystem:console', '/entry:main', '/out:demo_static.exe', 'main.obj', 'mathlib_static.lib', 'msvcrt.lib']);
  exec('C + mathlib_static.lib', 'demo_static.exe', mainWant);

  // DLL through the import library
  cc('main.c', ['-DMATHLIB_DLL']);
  run(lld, ['/nologo', '/subsystem:console', '/entry:main', '/out:demo_dll.exe', 'main.dll.obj', 'mathlib.lib', 'msvcrt.lib']);
  exec('C + mathlib.dll', 'demo_dll.exe', mainWant, { 'mathlib.dll': out.dll });
  const info = run(tool('llvm-readobj') ?? 'llvm-readobj', ['--coff-exports', '--coff-imports', 'mathlib.dll', 'demo_dll.exe']);
  if (/warning|error/i.test(info)) { fails++; console.log(`FAIL llvm-readobj:\n${info}`); }

  // the import library matches llvm-lib byte for byte
  if (llvmLib) {
    const def = `LIBRARY mathlib.dll\nEXPORTS\n${out.exports.map((n) => (/call_count/.test(n) ? `${n} DATA` : n)).join('\n')}\n`;
    writeFileSync(join(dir, 'mathlib.def'), def);
    run(llvmLib, ['/nologo', '/machine:x64', '/def:mathlib.def', '/out:ref.lib']);
    const same = Buffer.compare(readFileSync(join(dir, 'ref.lib')), Buffer.from(out.importLib)) === 0;
    if (same) console.log('ok   mathlib.lib is identical to llvm-lib /def output');
    else { fails++; console.log('FAIL mathlib.lib differs from llvm-lib /def output'); }
    void writeImportLibrary;
  }

  // ------------------------------------------------------------ HLA64 program calling C
  const app = compileX64(readFileSync(join(src, 'app.hla'), 'utf8'));
  writeFileSync(join(dir, 'app.obj'), writeCoffObject(assembleX(app.asm)).bytes);
  cc('helpers.c');
  run(lld, ['/nologo', '/subsystem:console', '/entry:hla_start', '/out:app.exe', 'app.obj', 'helpers.obj', 'msvcrt.lib']);
  exec('HLA64 app + helpers.c', 'app.exe', readFileSync(join(src, 'app.expected'), 'utf8'));

  // ------------------------------------------------------------ MSVC (Windows with Visual Studio)
  const env = msvcEnv();
  if (env) {
    const ms = (cmd: string, args: string[]) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: dir, env });
      const text = r.stdout + r.stderr;
      if (r.status !== 0 || /warning/i.test(text)) throw new Error(`${cmd} ${args.join(' ')}\n${text}`);
      return text;
    };
    const native = (what: string, exe: string, want: string) => {
      const r = spawnSync(join(dir, exe), [], { encoding: 'utf8', cwd: dir });
      expect(`${what} (native)`, r.stdout.replace(/\r\n/g, '\n'), want);
    };
    // the lesson's main.c (stdio.h, full C runtime) with the static library and the DLL
    copyFileSync('docs/lessons/14-library/main.c', join(dir, 'lesson.c'));
    ms('cl', ['/nologo', '/W4', 'lesson.c', 'mathlib_static.lib', '/Fe:msvc_static.exe']);
    native('cl + mathlib_static.lib', 'msvc_static.exe', mainWant);
    ms('cl', ['/nologo', '/W4', '/DMATHLIB_DLL', '/Fo:lesson_dll.obj', 'lesson.c', 'mathlib.lib', '/Fe:msvc_dll.exe']);
    native('cl /DMATHLIB_DLL + mathlib.lib', 'msvc_dll.exe', mainWant);
    // HLA64 program + C through cl and the C runtime's entry point (main from app.obj)
    ms('cl', ['/nologo', '/W4', 'app.obj', join(process.cwd(), src, 'helpers.c'), '/Fo:helpers_msvc.obj', '/Fe:msvc_app.exe']);
    native('cl app.obj helpers.c', 'msvc_app.exe', readFileSync(join(src, 'app.expected'), 'utf8'));
    // link.exe, entry hla_start, msvcrt.dll through our own import library
    writeFileSync(join(dir, 'msvcrt_ours.lib'), writeImportLibrary('msvcrt.dll', ['printf', 'puts', 'exit']));
    ms('link', ['/nologo', '/subsystem:console', '/entry:hla_start', '/out:msvc_link.exe', 'app.obj', 'helpers.obj', 'msvcrt_ours.lib']);
    native('link /entry:hla_start + our msvcrt.lib', 'msvc_link.exe', readFileSync(join(src, 'app.expected'), 'utf8'));
    // our files through lib and dumpbin
    const members = ms('lib', ['/nologo', '/list', 'mathlib_static.lib']);
    if (members.trim() !== 'mathlib.obj') { fails++; console.log(`FAIL lib /list mathlib_static.lib:\n${members}`); }
    const exports = ms('dumpbin', ['/nologo', '/exports', 'mathlib.dll']);
    const missing = out.exports.filter((n) => !new RegExp(`\\b${n}\\b`).test(exports));
    if (missing.length) { fails++; console.log(`FAIL dumpbin /exports mathlib.dll: no ${missing.join(', ')}`); }
    for (const f of ['mathlib.obj', 'mathlib_static.lib', 'mathlib.dll', 'mathlib.lib', 'app.obj', 'app.exe', 'msvcrt_ours.lib'])
      ms('dumpbin', ['/nologo', '/all', '/unwindinfo', f]);
    console.log('ok   MSVC: lib /list, dumpbin /exports /all /unwindinfo');

    // ---------------------------------------------------------- SEH: exceptions unwind through HLA64 frames
    const sehDir = 'tests/x64/seh', sehWant = readFileSync(join(sehDir, 'seh.expected'), 'utf8');
    const seh = compileLibraryX64(readFileSync(join(sehDir, 'seh.hla'), 'utf8'), 'seh');
    writeFileSync(join(dir, 'seh.h'), seh.header);
    writeFileSync(join(dir, 'seh.s'), seh.asm);
    const sehLib = buildWindowsLibrary(seh.asm, 'seh');
    writeFileSync(join(dir, 'seh_hla.obj'), sehLib.obj);
    writeFileSync(join(dir, 'seh_static.lib'), sehLib.staticLib);
    // the library calls guarded() from seh.c: a static library only, no DLL
    if (sehLib.dll || !/'guarded'/.test(sehLib.dllError ?? '')) { fails++; console.log(`FAIL seh.dll should not link: ${sehLib.dllError}`); }
    copyFileSync(join(sehDir, 'seh.c'), join(dir, 'seh.c'));
    ms('cl', ['/nologo', '/W4', 'seh.c', 'seh_static.lib', '/Fe:seh_cl.exe']);
    native('SEH, cl', 'seh_cl.exe', sehWant);
    ms('cl', ['/nologo', '/W4', '/O2', '/Fo:seh_o2.obj', 'seh.c', 'seh_static.lib', '/Fe:seh_cl_o2.exe']);
    native('SEH, cl /O2', 'seh_cl_o2.exe', sehWant);
    const r = spawnSync(clang, ['-O1', '-Wall', 'seh.c', 'seh_static.lib', '-o', 'seh_clang.exe'], { encoding: 'utf8', cwd: dir, env });
    if (r.status !== 0 || /warning/.test(r.stderr)) throw new Error(`clang seh.c\n${r.stderr}`);
    native('SEH, clang', 'seh_clang.exe', sehWant);
    // the unwind information is what clang makes of the same assembly
    run(clang, ['--target=x86_64-pc-windows-msvc', '-c', 'seh.s', '-o', 'seh_ref.obj']);
    const unwind = (f: string) => run(tool('llvm-readobj') ?? 'llvm-readobj', ['--unwind', f]).replace(/^File:.*$/m, '');
    expect('SEH: .pdata/.xdata identical to clang', unwind('seh_hla.obj'), unwind('seh_ref.obj'));
  } else {
    console.log(`skip MSVC (${process.platform === 'win32' ? 'no Visual Studio with C++ tools' : 'Windows only'})`);
  }
} catch (e) {
  fails++;
  console.log(`FAIL ${(e as Error).message}`);
}
console.log(`x64-lib: ${fails ? fails + ' failure(s)' : 'all ok'} (files in ${dir})`);
process.exit(fails ? 1 : 0);

#!/usr/bin/env node
// HLA64 command line driver.
//   node src/cli.ts compile prog.hla [-o prog.s]       translate to assembly
//   node src/cli.ts build   prog.hla [-o prog] [--clang] translate + assemble + link
//   node src/cli.ts run     prog.hla [--clang]          build into a temp dir and run
//   node src/cli.ts asm     prog.s   [-o prog]          assemble+link an .s file with the built-in assembler
//   node src/cli.ts obj     prog.hla [-o prog.o]        relocatable object file (link it with clang/ld)
//   node src/cli.ts lib     name.hla [-o dir]           C library: name.h, name.o, libname.a, libname.dylib
//   node src/cli.ts emu     prog.hla                    run in the built-in emulator
// --target arm64-macos (default on macOS/Linux) or --target x64-windows (default on Windows):
//   x64-windows builds prog.exe / prog.obj, and lib gives name.h, name.obj, name_static.lib,
//   name.dll and its import library name.lib; run uses the x64 emulator outside Windows.
import { readFileSync, writeFileSync, chmodSync, mkdtempSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { compile, compileLibrary } from './lang/codegen.ts';
import { compileX64, compileLibraryX64 } from './lang/x64/codegen.ts';
import { CompileError } from './lang/lexer.ts';

function usage(): never {
  console.error('usage: hla <compile|build|run|asm|obj|lib|emu> <file> [-o out] [--target arm64-macos|x64-windows] [--clang] [--zip]');
  process.exit(2);
}

const args = process.argv.slice(2);
const cmd = args.shift() ?? usage();
const valueOpts = ['-o', '--target'];
const file = args.find((a, i) => !a.startsWith('-') && !valueOpts.includes(args[i - 1])) ?? usage();
const oi = args.indexOf('-o');
const out = oi >= 0 ? args[oi + 1] : null;
const useClang = args.includes('--clang');
const ti = args.indexOf('--target');
const targetArg = ti >= 0 ? args[ti + 1] : process.platform === 'win32' ? 'x64-windows' : 'arm64-macos';
const x64 = /^(x64|x86[-_]64|win|windows|amd64)/i.test(targetArg ?? '');
if (!x64 && !/^(arm64|aarch64|mac)/i.test(targetArg ?? '')) { console.error(`unknown target '${targetArg}' (arm64-macos or x64-windows)`); process.exit(2); }

function translate(path: string, lib = false): string {
  const src = readFileSync(path, 'utf8');
  try {
    const name = basename(path).replace(/\.hla$/, '');
    const r = lib ? (x64 ? compileLibraryX64(src, name) : compileLibrary(src, name)) : x64 ? compileX64(src) : compile(src);
    if (lib) libHeader = (r as unknown as { header: string }).header;
    for (const w of r.warnings) console.error(`warning: ${w}`);
    return r.asm;
  } catch (e) {
    if (e instanceof CompileError) {
      console.error(`${path}:${e.line}:${e.col}: error: ${e.message}`);
      const line = src.split('\n')[e.line - 1];
      if (line !== undefined) console.error(`  ${line}\n  ${' '.repeat(Math.max(0, e.col - 1))}^`);
      process.exit(1);
    }
    throw e;
  }
}

let libHeader = '';

async function assembleOrExit(asm: string): Promise<import('./asm/assembler.ts').Assembly> {
  const { assemble, AsmError } = await import('./asm/index.ts');
  try {
    return assemble(asm);
  } catch (e) {
    if (!(e instanceof AsmError)) throw e;
    const l = asm.split('\n')[e.line - 1];
    console.error(`assembler: line ${e.line}: ${e.message}${l !== undefined ? `\n  ${l.trim()}` : ''}`);
    process.exit(1);
  }
}

async function link(asm: string, exe: string): Promise<void> {
  if (useClang) {
    const sfile = exe + '.s';
    writeFileSync(sfile, asm);
    try {
      execFileSync('clang', ['-arch', 'arm64', sfile, '-o', exe], { stdio: 'inherit' });
    } catch {
      console.error('clang failed');
      process.exit(1);
    }
    return;
  }
  const { assembleExecutable, AsmError } = await import('./asm/index.ts');
  let bin: Uint8Array;
  try {
    bin = assembleExecutable(asm, { name: basename(exe) });
  } catch (e) {
    if (e instanceof AsmError) {
      const l = asm.split('\n')[e.line - 1];
      console.error(`assembler: line ${e.line}: ${e.message}${l !== undefined ? `\n  ${l.trim()}` : ''}`);
      process.exit(1);
    }
    throw e;
  }
  writeFileSync(exe, bin);
  chmodSync(exe, 0o755);
  if (args.includes('--zip')) {
    const { zipExecutable } = await import('../web/zip.ts');
    writeFileSync(exe + '.zip', zipExecutable(basename(exe), bin));
    console.error(`wrote ${exe}.zip (executable bit preserved)`);
  }
}

function asmFail(asm: string, e: { line: number; message: string }): never {
  const l = asm.split('\n')[e.line - 1];
  console.error(`assembler: line ${e.line}: ${e.message}${l !== undefined ? `\n  ${l.trim()}` : ''}`);
  process.exit(1);
}

/** x86-64 Windows: same commands, Windows file formats */
async function windows(): Promise<void> {
  const X = await import('./asm/x64/index.ts');
  const guard = <T>(asm: string, f: () => T): T => {
    try { return f(); } catch (e) { if (e instanceof X.AsmError) asmFail(asm, e); throw e; }
  };
  const stem = (f: string) => f.replace(/\.(hla|s|asm)$/, '');
  const exeFor = (f: string) => out ?? stem(f) + '.exe';
  const buildExe = async (asm: string, exe: string) => {
    if (useClang) {
      writeFileSync(exe.replace(/\.exe$/, '') + '.s', asm);
      try { execFileSync('clang', ['--target=x86_64-pc-windows-msvc', exe.replace(/\.exe$/, '') + '.s', '-o', exe], { stdio: 'inherit' }); }
      catch { console.error('clang failed'); process.exit(1); }
      return;
    }
    const bin = guard(asm, () => X.assembleExecutableX(asm));
    writeFileSync(exe, bin);
    if (args.includes('--zip')) {
      const { zipExecutable } = await import('../web/zip.ts');
      writeFileSync(exe + '.zip', zipExecutable(basename(exe), bin));
      console.error(`wrote ${exe}.zip`);
    }
  };
  const emulate = async (bin: Uint8Array) => {
    const { runPE } = await import('./emu/x64/pe-loader.ts');
    const r = runPE(bin, { onOutput: (t, s) => (s === 1 ? process.stdout : process.stderr).write(t) });
    if (r.error) console.error(`\nemulator: ${r.error}`);
    console.error(`[x64 emulator: ${r.steps} instructions, exit ${r.exitCode}]`);
    process.exit(r.exitCode ?? 1);
  };
  const source = () => (file.endsWith('.hla') ? translate(file) : readFileSync(file, 'utf8'));
  switch (cmd) {
    case 'compile': { const asm = translate(file); if (out) writeFileSync(out, asm); else process.stdout.write(asm); return; }
    case 'build': case 'asm': await buildExe(source(), exeFor(file)); return;
    case 'run': {
      const asm = source();
      if (process.platform !== 'win32') { console.error('(not on Windows: running in the x64 emulator)'); return emulate(guard(asm, () => X.assembleExecutableX(asm))); }
      const dir = mkdtempSync(join(tmpdir(), 'hla-'));
      const exe = join(dir, basename(stem(file)) + '.exe');
      await buildExe(asm, exe);
      const r = spawnSync(exe, args.slice(args.indexOf('--') + 1 || args.length), { stdio: 'inherit' });
      process.exit(r.status ?? 1);
    }
    case 'emu': { const asm = source(); return emulate(guard(asm, () => X.assembleExecutableX(asm))); }
    case 'obj': {
      const asm = source();
      const obj = guard(asm, () => X.writeCoffObject(X.assembleX(asm)));
      const target = out ?? stem(file) + '.obj';
      writeFileSync(target, obj.bytes);
      console.error(`${target}: exports ${obj.exports.join(' ') || '(nothing)'}${obj.imports.length ? `; needs ${obj.imports.join(' ')}` : ''}`);
      return;
    }
    case 'lib': {
      const name = basename(file).replace(/\.hla$/, '');
      const dir = out ?? '.';
      const asm = translate(file, true);
      const lib = guard(asm, () => X.buildWindowsLibrary(asm, name));
      const files: [string, Uint8Array | string][] = [
        [`${name}.h`, libHeader], [`${name}.obj`, lib.obj], [`${name}_static.lib`, lib.staticLib],
        [`${name}.dll`, lib.dll], [`${name}.lib`, lib.importLib],
      ];
      for (const [f, data] of files) writeFileSync(join(dir, f), data);
      console.error(`exported: ${lib.exports.join(', ')}`);
      console.error(`wrote ${files.map(([f]) => join(dir, f)).join(', ')}`);
      console.error(`static: clang main.c ${name}_static.lib -o app.exe`);
      console.error(`DLL:    clang -D${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_DLL main.c ${name}.lib -o app.exe   (keep ${name}.dll next to app.exe)`);
      return;
    }
    default: usage();
  }
}

if (x64) { await windows(); process.exit(0); }

switch (cmd) {
  case 'compile': {
    const asm = translate(file);
    if (out) writeFileSync(out, asm); else process.stdout.write(asm);
    break;
  }
  case 'build': {
    const asm = translate(file);
    await link(asm, out ?? file.replace(/\.hla$/, ''));
    break;
  }
  case 'asm': {
    const asm = readFileSync(file, 'utf8');
    await link(asm, out ?? file.replace(/\.s$/, ''));
    break;
  }
  case 'run': {
    const asm = translate(file);
    const dir = mkdtempSync(join(tmpdir(), 'hla-'));
    const exe = join(dir, basename(file).replace(/\.hla$/, ''));
    await link(asm, exe);
    const r = spawnSync(exe, args.slice(args.indexOf('--') + 1 || args.length), { stdio: 'inherit' });
    process.exit(r.status ?? (r.signal ? 128 : 1));
  }
  case 'obj': {
    const asm = file.endsWith('.s') ? readFileSync(file, 'utf8') : translate(file);
    const { writeObject } = await import('./asm/index.ts');
    const obj = writeObject(await assembleOrExit(asm));
    const target = out ?? file.replace(/\.(hla|s)$/, '') + '.o';
    writeFileSync(target, obj.bytes);
    console.error(`${target}: exports ${obj.exports.join(' ') || '(nothing)'}${obj.imports.length ? `; needs ${obj.imports.join(' ')}` : ''}`);
    break;
  }
  case 'lib': {
    // HLA64 library for C: header, object file, static and dynamic library
    const name = basename(file).replace(/\.hla$/, '');
    const dir = out ?? '.';
    const asm = translate(file, true);
    const { writeObject, writeArchive, link: linkImage, AsmError } = await import('./asm/index.ts');
    const obj = writeObject(await assembleOrExit(asm));
    let dylib: Uint8Array;
    try {
      dylib = linkImage(await assembleOrExit(asm), { kind: 'dylib', name, installName: `@rpath/lib${name}.dylib` }).bytes;
    } catch (e) {
      if (!(e instanceof AsmError)) throw e;
      console.error(`linker: ${e.message}`);
      process.exit(1);
    }
    const files: [string, Uint8Array | string][] = [
      [`${name}.h`, libHeader],
      [`${name}.o`, obj.bytes],
      [`lib${name}.a`, writeArchive([{ name: `${name}.o`, data: obj.bytes, symbols: obj.exports }])],
      [`lib${name}.dylib`, dylib],
    ];
    for (const [f, data] of files) writeFileSync(join(dir, f), data);
    console.error(`exported: ${obj.exports.map((s) => s.replace(/^_/, '')).join(', ')}`);
    console.error(`wrote ${files.map(([f]) => join(dir, f)).join(', ')}`);
    console.error(`static:  clang main.c lib${name}.a -o app`);
    console.error(`dynamic: clang main.c -L. -l${name} -Wl,-rpath,@executable_path -o app`);
    break;
  }
  case 'emu': {
    // run in the built-in ARM64 emulator (no macOS needed)
    const asm = file.endsWith('.s') ? readFileSync(file, 'utf8') : translate(file);
    const { assembleExecutable, AsmError } = await import('./asm/index.ts');
    const { runMachO } = await import('./emu/macho-loader.ts');
    let bin: Uint8Array;
    try {
      bin = assembleExecutable(asm, { name: basename(file) });
    } catch (e) {
      if (!(e instanceof AsmError)) throw e;
      const l = asm.split('\n')[e.line - 1];
      console.error(`assembler: line ${e.line}: ${e.message}${l !== undefined ? `\n  ${l.trim()}` : ''}`);
      process.exit(1);
    }
    const r = runMachO(bin, {
      onOutput: (t, s) => (s === 1 ? process.stdout : process.stderr).write(t),
    });
    if (r.error) console.error(`\nemulator: ${r.error}`);
    console.error(`[emulator: ${r.steps} instructions, exit ${r.exitCode}]`);
    process.exit(r.exitCode ?? 1);
  }
  default:
    usage();
}

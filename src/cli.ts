#!/usr/bin/env node
// HLA64 command line driver.
//   node src/cli.ts compile prog.hla [-o prog.s]       translate to assembly
//   node src/cli.ts build   prog.hla [-o prog] [--clang] translate + assemble + link
//   node src/cli.ts run     prog.hla [--clang] [-- args] build into a temp dir and run
//   node src/cli.ts asm     prog.s   [-o prog]          assemble+link an .s file with the built-in assembler
//   node src/cli.ts obj     prog.hla [-o prog.o]        relocatable object file (link it with clang/ld)
//   node src/cli.ts lib     name.hla [-o dir]           C library: name.h, name.o, libname.a, libname.dylib
//   node src/cli.ts emu     prog.hla [-- args]          run in the built-in emulator (also prog.s,
//                                                       a Mach-O executable, or prog.exe)
// --target arm64-macos (default on macOS), x64-windows (default on Windows) or x64-linux (default on Linux):
//   x64-windows builds prog.exe / prog.obj, and lib gives name.h, name.obj, name_static.lib,
//   name.dll and its import library name.lib; run uses the x64 emulator outside Windows.
//   x64-linux builds an ELF executable prog / prog.o, and lib gives name.h, name.o, libname.a and
//   libname.so; run uses the x64 emulator outside Linux on x86-64.
// --target wasm32: compile gives WebAssembly text (.wat), build gives prog.wasm with prog.html (a console
//   page that runs it) and prog.mjs (runs it in Node); run and emu run it here, in Node's WebAssembly;
//   asm assembles a .wat file.
import { readFileSync, writeFileSync, chmodSync, mkdtempSync, mkdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { compile, compileLibrary } from './lang/codegen.ts';
import { compileX64, compileLibraryX64, type X64Os } from './lang/x64/codegen.ts';
import { compileWasm } from './lang/wasm/codegen.ts';
import { CompileError } from './lang/lexer.ts';
import { combineSources, errorOrigin, type Combined } from './lang/include.ts';

function usage(): never {
  console.error('usage: hla <compile|build|run|asm|obj|lib|emu> <file> [-o out] [--target arm64-macos|x64-windows|x64-linux|wasm32] [--clang] [--zip] [-- program arguments]');
  process.exit(2);
}

const argv = process.argv.slice(2);
// everything after `--` goes to the program (run, emu)
const dashes = argv.indexOf('--');
const args = dashes >= 0 ? argv.slice(0, dashes) : argv;
const progArgs = dashes >= 0 ? argv.slice(dashes + 1) : [];
const cmd = args.shift() ?? usage();
const valueOpts = ['-o', '--target'];
const file = args.find((a, i) => !a.startsWith('-') && !valueOpts.includes(args[i - 1])) ?? usage();
const oi = args.indexOf('-o');
const out = oi >= 0 ? args[oi + 1] : null;
const useClang = args.includes('--clang');
const ti = args.indexOf('--target');
const targetArg = ti >= 0 ? args[ti + 1] : process.platform === 'win32' ? 'x64-windows' : process.platform === 'linux' ? 'x64-linux' : 'arm64-macos';
// a Windows program (.exe) is x86-64, an ELF file Linux and a module (.wasm, .wat) WebAssembly whatever the target says
const isElfFile = (() => { try { const b = readFileSync(file); return b.length >= 4 && b.readUInt32BE(0) === 0x7f454c46; } catch { return false; } })();
const wasm = /^(wasm|webassembly|web)/i.test(targetArg ?? '') || /\.(wasm|wat)$/i.test(file);
const linux = !wasm && (/linux|^elf$/i.test(targetArg ?? '') || isElfFile);
const x64 = !wasm && !linux && (/^(x64|x86[-_]64|win|windows|amd64)/i.test(targetArg ?? '') || /\.exe$/i.test(file));
if (!x64 && !wasm && !linux && !/^(arm64|aarch64|mac)/i.test(targetArg ?? '')) { console.error(`unknown target '${targetArg}' (arm64-macos, x64-windows, x64-linux or wasm32)`); process.exit(2); }
const os: X64Os = linux ? 'linux' : 'windows';

function translate(path: string, lib = false): string {
  // the main file and everything it includes (paths relative to the including file)
  const dir = dirname(path), main = basename(path);
  const shown = (f: string) => (dir === '.' ? f : join(dir, f));
  let c: Combined | null = null;
  try {
    c = combineSources(main, (f) => { try { return readFileSync(join(dir, f), 'utf8'); } catch { return null; } });
    const name = main.replace(/\.hla$/, '');
    const r = lib ? (x64 || linux ? compileLibraryX64(c.text, name, { os }) : compileLibrary(c.text, name)) : wasm ? compileWasm(c.text) : x64 || linux ? compileX64(c.text, { os }) : compile(c.text);
    if (lib) libHeader = (r as unknown as { header: string }).header;
    for (const w of r.warnings) console.error(`warning: ${c.files.length > 1 ? c.warning(w) : w}`);
    return r.asm;
  } catch (e) {
    if (e instanceof CompileError) {
      const o = errorOrigin(e, c, main);
      console.error(`${shown(o.file)}:${o.line}:${e.col}: error: ${e.message}`);
      const line = c?.lineText(o) ?? (e as { source?: string }).source;
      if (line !== undefined) console.error(`  ${line}\n  ${' '.repeat(Math.max(0, e.col - 1))}^`);
      process.exit(1);
    }
    throw e;
  }
}

let libHeader = '';

/** files of a program in the emulators: the disk, relative to the current directory (as when it runs natively) */
const diskFiles = {
  read: (p: string) => { try { return new Uint8Array(readFileSync(p)); } catch { return null; } },
  write: (p: string, d: Uint8Array) => writeFileSync(p, d),
};

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
      // clang assembles, lld-link links: the same entry (hla_start) and DLL imports as the built-in linker,
      // through import libraries written by writeImportLibrary, so neither Visual Studio nor its C runtime is needed
      const W = await import('./win-toolchain.ts');
      const clang = W.onPath('clang') ?? W.llvmInstalled('clang');
      if (!clang) { console.error('clang not found: install LLVM (winget install LLVM.LLVM)'); process.exit(1); }
      const s = exe.replace(/\.exe$/, '') + '.s';
      writeFileSync(s, asm);
      const tmp = mkdtempSync(join(tmpdir(), 'hla-clang-'));
      const libs = guard(asm, () => X.linkPE(X.assembleX(asm))).imports.map(({ dll, names }) => {
        const lib = join(tmp, dll.replace(/\.dll$/i, '.lib'));
        writeFileSync(lib, X.writeImportLibrary(dll, names));
        return lib;
      });
      const r = spawnSync(clang, ['--target=x86_64-pc-windows-msvc', '-fuse-ld=lld', '-nostdlib',
        '-Wl,/entry:hla_start,/subsystem:console', s, ...libs, '-o', exe], { stdio: 'inherit' });
      if (r.status !== 0) { console.error('clang failed'); process.exit(1); }
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
    const r = runPE(bin, { args: progArgs, files: diskFiles, onOutput: (t, s) => (s === 1 ? process.stdout : process.stderr).write(t) });
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
      const r = spawnSync(exe, progArgs, { stdio: 'inherit' });
      process.exit(r.status ?? 1);
    }
    case 'emu': {
      if (/\.exe$/i.test(file)) return emulate(new Uint8Array(readFileSync(file)));   // an executable built elsewhere
      const asm = source();
      return emulate(guard(asm, () => X.assembleExecutableX(asm)));
    }
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
      ];
      if (lib.dll && lib.importLib) files.push([`${name}.dll`, lib.dll], [`${name}.lib`, lib.importLib]);
      mkdirSync(dir, { recursive: true });
      for (const [f, data] of files) writeFileSync(join(dir, f), data);
      console.error(`exported: ${lib.exports.join(', ')}`);
      console.error(`wrote ${files.map(([f]) => join(dir, f)).join(', ')}`);
      console.error(`static: clang main.c ${name}_static.lib -o app.exe     (MSVC: cl main.c ${name}_static.lib)`);
      if (lib.dllError) console.error(`no DLL: ${lib.dllError}`);
      else console.error(`DLL:    clang -D${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_DLL main.c ${name}.lib -o app.exe   (MSVC: cl /D${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_DLL main.c ${name}.lib; keep ${name}.dll next to the program)`);
      if (process.platform === 'win32' && !(await import('./win-toolchain.ts')).onPath('cl'))
        console.error('(clang and cl need the Visual Studio environment: run them in the "x64 Native Tools Command Prompt")');
      return;
    }
    default: usage();
  }
}

/** x86-64 Linux: ELF executables, objects and libraries; outside Linux on x86-64 programs run in the x64 emulator */
async function linuxTarget(): Promise<void> {
  const E = await import('./asm/elf/index.ts');
  const guard = <T>(asm: string, f: () => T): T => {
    try { return f(); } catch (e) { if (e instanceof E.AsmError) asmFail(asm, e); throw e; }
  };
  const stem = (f: string) => f.replace(/\.(hla|s|asm)$/, '');
  const exeFor = (f: string) => out ?? stem(f);
  const nativeHost = process.platform === 'linux' && process.arch === 'x64';
  const buildExe = async (asm: string, exe: string) => {
    if (useClang) {
      // clang (or gcc) assembles and links against the system's glibc with the same entry point;
      // outside Linux zig cc -target x86_64-linux-gnu does the same with its own glibc stubs
      const { linuxCc } = await import('./linux-toolchain.ts');
      const cc = linuxCc();
      if (!cc) { console.error(process.platform === 'linux' ? 'no C compiler found (cc, clang or gcc)' : 'zig not found: it builds Linux executables elsewhere (brew install zig)'); process.exit(1); }
      const s = exe + '.s';
      writeFileSync(s, asm);
      const r = spawnSync(cc[0], [...cc.slice(1), '-nostartfiles', '-Wl,-e,hla_start', s, '-o', exe, '-lm'], { stdio: 'inherit' });
      if (r.status !== 0) { console.error('clang failed'); process.exit(1); }
      return;
    }
    const bin = guard(asm, () => E.assembleExecutableElf(asm));
    writeFileSync(exe, bin);
    chmodSync(exe, 0o755);
    if (args.includes('--zip')) {
      const { zipExecutable } = await import('../web/zip.ts');
      writeFileSync(exe + '.zip', zipExecutable(basename(exe), bin));
      console.error(`wrote ${exe}.zip (executable bit preserved)`);
    }
  };
  // shared libraries the program needs: next to it (like LD_LIBRARY_PATH=.)
  const libsNear = (path: string) => (name: string) => { try { return new Uint8Array(readFileSync(join(dirname(path), name))); } catch { return null; } };
  const emulate = async (bin: Uint8Array, near: string) => {
    const { runElf } = await import('./emu/x64/elf-loader.ts');
    const r = runElf(bin, { args: progArgs, files: diskFiles, libs: libsNear(near), onOutput: (t, st) => (st === 1 ? process.stdout : process.stderr).write(t) });
    if (r.error) console.error(`\nemulator: ${r.error}`);
    console.error(`[x64 emulator: ${r.steps} instructions, exit ${r.exitCode}]`);
    process.exit(r.exitCode ?? 1);
  };
  const source = () => (file.endsWith('.hla') ? translate(file) : readFileSync(file, 'utf8'));
  switch (cmd) {
    case 'compile': { const asm = translate(file); if (out) writeFileSync(out, asm); else process.stdout.write(asm); return; }
    case 'build': case 'asm': await buildExe(source(), exeFor(file)); return;
    case 'run': {
      if (isElfFile) {
        if (nativeHost) { const r = spawnSync(file.includes('/') ? file : './' + file, progArgs, { stdio: 'inherit' }); process.exit(r.status ?? 1); }
        return emulate(new Uint8Array(readFileSync(file)), file);
      }
      const asm = source();
      if (!nativeHost) { console.error('(not on Linux x86-64: running in the x64 emulator)'); return emulate(guard(asm, () => E.assembleExecutableElf(asm)), file); }
      const dir = mkdtempSync(join(tmpdir(), 'hla-'));
      const exe = join(dir, basename(stem(file)));
      await buildExe(asm, exe);
      const r = spawnSync(exe, progArgs, { stdio: 'inherit' });
      process.exit(r.status ?? (r.signal ? 128 : 1));
    }
    case 'emu': {
      if (isElfFile) return emulate(new Uint8Array(readFileSync(file)), file);   // an executable built elsewhere
      const asm = source();
      return emulate(guard(asm, () => E.assembleExecutableElf(asm)), file);
    }
    case 'obj': {
      const asm = source();
      const obj = guard(asm, () => E.writeElfObject(E.assembleX(asm)));
      const target = out ?? stem(file) + '.o';
      writeFileSync(target, obj.bytes);
      console.error(`${target}: exports ${obj.exports.join(' ') || '(nothing)'}${obj.imports.length ? `; needs ${obj.imports.join(' ')}` : ''}`);
      return;
    }
    case 'lib': {
      const name = basename(file).replace(/\.hla$/, '');
      const dir = out ?? '.';
      const asm = translate(file, true);
      const lib = guard(asm, () => E.buildLinuxLibrary(asm, name));
      const files: [string, Uint8Array | string][] = [
        [`${name}.h`, libHeader], [`${name}.o`, lib.obj], [`lib${name}.a`, lib.staticLib], [`lib${name}.so`, lib.so],
      ];
      mkdirSync(dir, { recursive: true });
      for (const [f, data] of files) writeFileSync(join(dir, f), data);
      console.error(`exported: ${lib.exports.join(', ')}`);
      if (lib.imports.length) console.error(`lib${name}.so takes ${lib.imports.join(', ')} from the program that loads it`);
      console.error(`wrote ${files.map(([f]) => join(dir, f)).join(', ')}`);
      console.error(`static:  cc main.c lib${name}.a -o app`);
      console.error(`dynamic: cc main.c -L. -l${name} -Wl,-rpath,'$ORIGIN' -o app`);
      return;
    }
    default: usage();
  }
}

/** WebAssembly: a module and the page that runs it; run here in Node's engine with the JavaScript runtime */
async function webassembly(): Promise<void> {
  const { assembleWasm, AsmError } = await import('./asm/wasm/assembler.ts');
  const stem = (f: string) => f.replace(/\.(hla|wat|wasm)$/, '');
  const text = () => (file.endsWith('.hla') ? translate(file) : readFileSync(file, 'utf8'));
  const assemble = (wat: string): Uint8Array => {
    try { return assembleWasm(wat).bytes; } catch (e) { if (e instanceof AsmError) asmFail(wat, e); throw e; }
  };
  const run = async (bytes: Uint8Array) => {
    const { runWasm } = await import('./wasm/runtime.ts');
    const r = runWasm(bytes, { name: basename(stem(file)), args: progArgs, files: diskFiles, onOutput: (t, s) => (s === 1 ? process.stdout : process.stderr).write(t) });
    if (r.error) console.error(`\nerror: ${r.error}`);
    process.exit(r.exitCode ?? 1);
  };
  switch (cmd) {
    case 'compile': { const wat = translate(file); if (out) writeFileSync(out, wat); else process.stdout.write(wat); return; }
    case 'run': case 'emu': return run(/\.wasm$/i.test(file) ? new Uint8Array(readFileSync(file)) : assemble(text()));
    case 'build': case 'asm': {
      const bytes = assemble(text());
      const target = out ?? stem(file) + '.wasm';
      const name = basename(target).replace(/\.wasm$/, '');
      const dir = dirname(target);
      const { runtimeSource } = await import('./wasm/bundle.ts');
      const { wasmPage, wasmNodeRunner, wasmProgramFiles } = await import('./wasm/page.ts');
      const runtime = await runtimeSource();
      writeFileSync(target, bytes);
      writeFileSync(join(dir, name + '.html'), wasmPage(name, runtime));
      writeFileSync(join(dir, name + '.mjs'), wasmNodeRunner(name, runtime));
      console.error(`wrote ${target} (${bytes.length} bytes), ${join(dir, name + '.html')} (open it in a browser), ${join(dir, name + '.mjs')} (node ${name}.mjs)`);
      if (args.includes('--zip')) {
        const { zipFiles } = await import('../web/zip.ts');
        writeFileSync(join(dir, name + '.zip'), zipFiles(wasmProgramFiles(name, bytes, runtime)));
        console.error(`wrote ${join(dir, name + '.zip')}`);
      }
      return;
    }
    case 'obj': case 'lib':
      console.error(`${cmd} is not available for wasm32: a WebAssembly module is a whole program (build gives prog.wasm)`);
      process.exit(2);
    default: usage();
  }
}

if (wasm) { await webassembly(); process.exit(0); }
if (linux) { await linuxTarget(); process.exit(0); }
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
    const r = spawnSync(exe, progArgs, { stdio: 'inherit' });
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
    mkdirSync(dir, { recursive: true });
    for (const [f, data] of files) writeFileSync(join(dir, f), data);
    console.error(`exported: ${obj.exports.map((s) => s.replace(/^_/, '')).join(', ')}`);
    console.error(`wrote ${files.map(([f]) => join(dir, f)).join(', ')}`);
    console.error(`static:  clang main.c lib${name}.a -o app`);
    console.error(`dynamic: clang main.c -L. -l${name} -Wl,-rpath,@executable_path -o app`);
    break;
  }
  case 'emu': {
    // run in the built-in ARM64 emulator (no macOS needed)
    const { assembleExecutable, AsmError } = await import('./asm/index.ts');
    const { runMachO } = await import('./emu/macho-loader.ts');
    const raw = readFileSync(file);
    const machO = raw.length >= 4 && raw.readUInt32LE(0) === 0xfeedfacf;   // an executable built elsewhere
    const asm = machO ? '' : file.endsWith('.s') ? raw.toString('utf8') : translate(file);
    let bin: Uint8Array;
    try {
      bin = machO ? new Uint8Array(raw) : assembleExecutable(asm, { name: basename(file) });
    } catch (e) {
      if (!(e instanceof AsmError)) throw e;
      const l = asm.split('\n')[e.line - 1];
      console.error(`assembler: line ${e.line}: ${e.message}${l !== undefined ? `\n  ${l.trim()}` : ''}`);
      process.exit(1);
    }
    const r = runMachO(bin, {
      args: progArgs,
      files: diskFiles,
      onOutput: (t, s) => (s === 1 ? process.stdout : process.stderr).write(t),
    });
    if (r.error) console.error(`\nemulator: ${r.error}`);
    console.error(`[emulator: ${r.steps} instructions, exit ${r.exitCode}]`);
    process.exit(r.exitCode ?? 1);
  }
  default:
    usage();
}

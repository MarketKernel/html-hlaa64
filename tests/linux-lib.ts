// C interop on Linux x86-64, checked with a C tool chain (cc on Linux, zig cc -target x86_64-linux-gnu
// elsewhere) and the x64 emulator:
//  1. mathlib.hla as a static library (libmathlib.a) linked into a C program, PIE and not
//  2. mathlib.hla as libmathlib.so, PIE and not; code that is not position independent copies the library's
//     variable call_count into itself (a copy relocation) and the library must use that copy
//  3. libmathlib.so made by the C compiler itself (cc -shared) from our mathlib.o
//  4. app.hla (an HLA64 program) calling C functions from helpers.c: our app.o linked by cc, with the C
//     runtime's entry point and with hla_start
//  5. our executables ask glibc for the default version of each symbol (memcpy@GLIBC_2.14), and a C shared
//     library's destructor runs when an HLA64 program linked by us exits
// llvm-readelf must read every file we write without a warning. On Linux the executables run natively too.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileX64, compileLibraryX64 } from '../src/lang/x64/codegen.ts';
import { buildLinuxLibrary, assembleX, writeElfObject, assembleExecutableElf } from '../src/asm/elf/index.ts';
import { runElf } from '../src/emu/x64/elf-loader.ts';
import { linuxCc } from './lib/toolchain.ts';

const cc = linuxCc();
if (!cc) { console.log('linux-lib: a C compiler for x86_64-linux-gnu is needed (cc on Linux, zig elsewhere): skipping'); process.exit(0); }
const readelf = ['/opt/homebrew/opt/llvm/bin/llvm-readelf', ...[21, 20, 19, 18].map((v) => `/opt/homebrew/opt/llvm@${v}/bin/llvm-readelf`), 'llvm-readelf', 'readelf']
  .find((p) => spawnSync(p, ['--version']).status === 0);
const native = process.platform === 'linux' && process.arch === 'x64';
const src = 'tests/linux/lib', x64src = 'tests/x64/lib';
const dir = mkdtempSync(join(tmpdir(), 'hla-linuxlib-'));
let fails = 0;
const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: dir });
  if (r.status !== 0) throw new Error(`${cmd.split(/[\\/]/).pop()} ${args.join(' ')}\n${r.stderr}${r.stdout}`);
  return r.stdout + r.stderr;
};
const ccRun = (args: string[]) => run(cc[0], [...cc.slice(1), '-O1', '-Wall', '-I', dir, ...args]);
const expect = (what: string, got: string, want: string) => {
  if (got === want) { console.log(`ok   ${what}`); return; }
  fails++;
  console.log(`FAIL ${what}\n--- got\n${got}--- want\n${want}`);
};
const exec = (what: string, exe: string, want: string, libs: Record<string, Uint8Array> = {}) => {
  const r = runElf(new Uint8Array(readFileSync(join(dir, exe))), { libs });
  expect(`${what} (emulator)`, r.stdout + (r.error ? `error: ${r.error}\n` : ''), want);
  if (native) {
    const nr = spawnSync(join(dir, exe), [], { encoding: 'utf8', cwd: dir, env: { ...process.env, LD_LIBRARY_PATH: dir } });
    expect(`${what} (native)`, nr.stdout + (nr.status ? `exit ${nr.status} ${nr.stderr}` : ''), want);
  }
};
const checkReadelf = (file: string) => {
  if (!readelf) return;
  const r = spawnSync(readelf, ['--all', '--wide', join(dir, file)], { encoding: 'utf8' });
  if (r.status !== 0 || /warning|error/i.test(r.stderr)) { fails++; console.log(`FAIL llvm-readelf ${file}:\n${r.stderr}`); }
};

try {
  // ------------------------------------------------------------ the library
  const lib = compileLibraryX64(readFileSync(join(x64src, 'mathlib.hla'), 'utf8'), 'mathlib', { os: 'linux' });
  writeFileSync(join(dir, 'mathlib.h'), lib.header);
  const out = buildLinuxLibrary(lib.asm, 'mathlib');
  writeFileSync(join(dir, 'mathlib.o'), out.obj);
  writeFileSync(join(dir, 'libmathlib.a'), out.staticLib);
  writeFileSync(join(dir, 'libmathlib.so'), out.so);
  for (const f of ['mathlib.o', 'libmathlib.a', 'libmathlib.so']) checkReadelf(f);
  const mainWant = readFileSync(join(src, 'main.expected'), 'utf8');
  const so = { 'libmathlib.so': out.so };
  const mainC = join(process.cwd(), src, 'main.c');

  for (const pie of [true, false]) {
    const flags = pie ? ['-fPIE', '-pie'] : ['-fno-pie', '-no-pie'];
    const tag = pie ? 'PIE' : 'no PIE';
    ccRun([...flags, mainC, 'libmathlib.a', '-o', `demo_static_${pie}`]);
    exec(`C + libmathlib.a (${tag})`, `demo_static_${pie}`, mainWant);
    ccRun([...flags, mainC, '-L', dir, '-lmathlib', '-Wl,-rpath,$ORIGIN', '-o', `demo_so_${pie}`]);
    exec(`C + libmathlib.so (${tag})`, `demo_so_${pie}`, mainWant, so);
  }
  // a copy relocation: the program owns call_count (and counter), the library follows it through the GOT
  const counter = compileLibraryX64(readFileSync(join(src, 'counter.hla'), 'utf8'), 'counter', { os: 'linux' });
  const counterLib = buildLinuxLibrary(counter.asm, 'counter');
  writeFileSync(join(dir, 'libcounter.so'), counterLib.so);
  checkReadelf('libcounter.so');
  ccRun(['-no-pie', join(process.cwd(), src, 'copyrel.s'), '-L', dir, '-lmathlib', '-lcounter', '-o', 'copyrel']);
  if (readelf && !/R_X86_64_COPY.*call_count/.test(run(readelf, ['-r', 'copyrel']))) { fails++; console.log('FAIL copyrel: no copy relocation for call_count'); }
  exec('non-PIC code + libmathlib.so, libcounter.so (copy relocations)', 'copyrel',
    'gcd = 6, call_count = 101\ncounter = 11, the table points at it: 1\n', { ...so, 'libcounter.so': counterLib.so });
  // the C compiler makes a shared library from our object file (it must be position independent)
  ccRun(['-shared', '-Wl,-soname,libmathcc.so', 'mathlib.o', '-o', 'libmathcc.so']);
  ccRun([mainC, '-L', dir, '-lmathcc', '-o', 'demo_ccso']);
  exec('C + cc -shared mathlib.o', 'demo_ccso', mainWant, { 'libmathcc.so': new Uint8Array(readFileSync(join(dir, 'libmathcc.so'))) });

  // ------------------------------------------------------------ HLA64 program calling C
  const app = compileX64(readFileSync(join(x64src, 'app.hla'), 'utf8'), { os: 'linux' });
  writeFileSync(join(dir, 'app.o'), writeElfObject(assembleX(app.asm)).bytes);
  checkReadelf('app.o');
  const appWant = readFileSync(join(x64src, 'app.expected'), 'utf8');
  ccRun(['app.o', join(process.cwd(), src, 'helpers.c'), '-o', 'app_crt']);
  exec('HLA64 app.o + helpers.c (C runtime entry)', 'app_crt', appWant);
  ccRun(['-nostartfiles', '-Wl,-e,hla_start', 'app.o', join(process.cwd(), src, 'helpers.c'), '-o', 'app_start']);
  exec('HLA64 app.o + helpers.c (hla_start)', 'app_start', appWant);

  // ------------------------------------------------------------ a C library's destructor runs at exit
  ccRun(['-shared', '-fPIC', '-Wl,-soname,libdtor.so', join(process.cwd(), src, 'dtor.c'), '-o', 'libdtor.so']);
  const dtorSo = new Uint8Array(readFileSync(join(dir, 'libdtor.so')));
  const { linkElf } = await import('../src/asm/elf/link.ts');
  writeFileSync(join(dir, 'dtorapp'), linkElf(assembleX(compileX64(readFileSync(join(src, 'dtorapp.hla'), 'utf8'), { os: 'linux' }).asm),
    { libs: { 'libdtor.so': ['dtor_hello'] } }).bytes);
  spawnSync('chmod', ['+x', join(dir, 'dtorapp')]);
  exec('HLA64 program + C library with a destructor', 'dtorapp', 'dtor_hello = 42\ndestructor of libdtor.so\n', { 'libdtor.so': dtorSo });

  // ------------------------------------------------------------ symbol versions: what ld would ask for
  {
    const prog = 'extern printf(fmt, ...), memcpy, pow, realpath\nfn main() {\n local b: u8[8]\n memcpy(&b, "abc", 4)\n xmm0 = pow(2.0, 3.0)\n printf("%s %.0f %d\\n", &b, xmm0, realpath("/", 0) != 0)\n}\n';
    writeFileSync(join(dir, 'versions'), assembleExecutableElf(compileX64(prog, { os: 'linux' }).asm));
    spawnSync('chmod', ['+x', join(dir, 'versions')]);
    checkReadelf('versions');
    if (readelf) {
      const syms = run(readelf, ['--dyn-syms', '-W', 'versions']);
      const want = ['memcpy@GLIBC_2.14', 'pow@GLIBC_2.29', 'realpath@GLIBC_2.3', 'printf@GLIBC_2.2.5'];
      const missing = want.filter((w) => !syms.includes(w));
      if (missing.length) { fails++; console.log(`FAIL symbol versions: no ${missing.join(', ')}\n${syms}`); }
      else console.log(`ok   symbol versions: ${want.join(', ')}`);
    }
    if (native) {
      // realpath with a NULL buffer: only the current version allocates one (realpath@GLIBC_2.2.5 fails)
      const nr = spawnSync(join(dir, 'versions'), [], { encoding: 'utf8' });
      expect('symbol versions (native)', nr.stdout, 'abc 8 1\n');
    }
  }

  // ------------------------------------------------------------ our own executables pass llvm-readelf
  writeFileSync(join(dir, 'sysv'), assembleExecutableElf(compileX64(readFileSync('tests/linux/cases/sysv.hla', 'utf8'), { os: 'linux' }).asm));
  checkReadelf('sysv');
  if (readelf) console.log(`ok   ${readelf.split('/').pop()} reads our .o, .a, .so and executable without warnings`);
} catch (e) {
  fails++;
  console.log(`FAIL ${(e as Error).message}`);
}
console.log(fails ? `linux-lib: ${fails} failed (files in ${dir})` : `linux-lib: all ok (files in ${dir})`);
process.exit(fails ? 1 : 0);

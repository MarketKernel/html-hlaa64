// x86-64 Linux target: HLA64 programs compiled with the x64 code generator for the System V ABI,
// assembled with the built-in x64 assembler, linked by the built-in ELF linker (dynamically, against
// glibc) and executed in the x64 emulator; on Linux they are also run natively.
//   * tests/linux/cases/*.hla  programs written for Linux (syscall(), System V details)
//   * tests/x64/cases/*.hla    the x64 programs that do not call the Windows API (same expected output)
//   * tests/cases/*.hla        programs without ARM registers (their output is the macOS one: long is 64 bits)
//   * docs/{,ru/}lessons/*.md  every lesson program that does not name ARM registers
// With --clang every program is also assembled and linked by clang + lld (`zig cc -target x86_64-linux-gnu`
// outside Linux, `cc` on Linux) with the same entry point, and our own object file is linked by the same
// linker; both executables must behave the same in the emulator.
//   node tests/linux.ts [--update] [--verbose] [--clang]
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { compileX64 } from '../src/lang/x64/codegen.ts';
import { assembleX } from '../src/asm/x64/assembler.ts';
import { linkElf } from '../src/asm/elf/link.ts';
import { writeElfObject } from '../src/asm/elf/object.ts';
import { runElf } from '../src/emu/x64/elf-loader.ts';
import { memoryFiles } from '../src/emu/files.ts';
import { combineSources } from '../src/lang/include.ts';
import { linuxCc } from './lib/toolchain.ts';

const update = process.argv.includes('--update');
const verbose = process.argv.includes('--verbose');
const native = process.platform === 'linux' && process.arch === 'x64';
const tmp = mkdtempSync(join(tmpdir(), 'hla-linux-'));
let passed = 0, failed = 0, skipped = 0, n = 0;
const withClang = process.argv.includes('--clang');
const cc = linuxCc();
if (withClang && !cc) { console.log('--clang needs zig (outside Linux) or cc (on Linux)'); process.exit(2); }

function build(src: string): { exe: Uint8Array; asm: string } {
  const asm = compileX64(combineSources('program.hla', (f) => (f === 'program.hla' ? src : null)).text, { os: 'linux' }).asm;   // std/ includes
  return { exe: linkElf(assembleX(asm)).bytes, asm };
}

// the same assembly through clang + lld, and our object file through lld; the results must behave like ours
function clangRun(asm: string, args: string[]): string[] {
  const base = join(tmp, `c${n++}`);
  writeFileSync(base + '.s', asm);
  writeFileSync(base + '.o', writeElfObject(assembleX(asm)).bytes);
  return [[base + '.s', base], [base + '.o', base + '-obj']].map(([input, exe]) => {
    const r = spawnSync(cc![0], [...cc!.slice(1), '-nostartfiles', '-Wl,-e,hla_start', input, '-o', exe, '-lm'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${input.endsWith('.o') ? 'linking our object' : 'clang'} failed: ${r.stderr || r.stdout}`);
    const e = runElf(new Uint8Array(readFileSync(exe)), { limit: 50_000_000, args, files: memoryFiles() });
    if (e.error) throw new Error(`${input.endsWith('.o') ? 'our object linked by lld' : 'clang-built executable'}: ${e.error}`);
    return e.stdout;
  });
}

function check(where: string, src: string, expected: string | null, write?: (out: string) => void): void {
  let out: string;
  const progArgs: string[] = JSON.parse(/^\/\/ args: (\[.*?\])/m.exec(src)?.[1] ?? '[]');   // the command line for main(argc, argv)
  try {
    const { exe, asm } = build(src);
    const r = runElf(exe, { limit: 50_000_000, args: progArgs, files: memoryFiles() });
    if (r.error) throw new Error('emulator: ' + r.error);
    out = r.stdout;
    if (withClang) {
      const [c, o] = clangRun(asm, progArgs);
      if (c !== out) throw new Error(`clang + lld build behaves differently:\n${c}`);
      if (o !== out) throw new Error(`our object linked by lld behaves differently:\n${o}`);
    }
    if (native) {
      const path = join(tmp, `p${n++}`);
      writeFileSync(path, exe);
      chmodSync(path, 0o755);
      const nr = spawnSync(path, progArgs, { encoding: 'utf8', cwd: tmp });   // files the program writes land in the temp dir
      if (nr.stdout !== out) throw new Error(`native output differs from the emulator (exit ${nr.status}${nr.signal ? ', ' + nr.signal : ''}):\n${nr.stdout}${nr.stderr}`);
      if (r.exitCode !== null && nr.status !== r.exitCode) throw new Error(`native exit code ${nr.status}, emulator ${r.exitCode}`);
    }
  } catch (e) {
    failed++;
    console.log(`FAIL ${where}: ${(e as Error).message.split('\n').slice(0, verbose ? 20 : 1).join('\n')}`);
    return;
  }
  if (expected === null || update) {
    if (write) { write(out); passed++; console.log(`wrote ${where}`); return; }
  }
  if (out === expected) { passed++; return; }
  failed++;
  console.log(`FAIL ${where}: output differs`);
  if (verbose) console.log(`--- got\n${out}--- expected\n${expected}`);
}

// ---------------------------------------------------------------- Linux programs
const cases = 'tests/linux/cases';
for (const f of readdirSync(cases).filter((f) => f.endsWith('.hla')).sort()) {
  const exp = join(cases, f.replace(/\.hla$/, '.expected'));
  check(join(cases, f), readFileSync(join(cases, f), 'utf8'), existsSync(exp) ? readFileSync(exp, 'utf8') : null, (o) => writeFileSync(exp, o));
}

// ---------------------------------------------------------------- x64 programs (without the Windows API)
const WINAPI = /\b(GetStdHandle|WriteFile|ExitProcess|GetCommandLineA|MessageBoxA|__getmainargs|RaiseException)\b/;
for (const f of readdirSync('tests/x64/cases').filter((f) => f.endsWith('.hla')).sort()) {
  const src = readFileSync(join('tests/x64/cases', f), 'utf8'), exp = join('tests/x64/cases', f.replace(/\.hla$/, '.expected'));
  // a raw `call` instruction passes arguments the Win64 way (tests/linux/cases has the System V versions)
  if (WINAPI.test(src) || /^\s*call\s+[A-Za-z_]\w*\s*(\/\/.*)?$/m.test(src) || !existsSync(exp)) { skipped++; continue; }
  check(join('tests/x64/cases', f), src, readFileSync(exp, 'utf8'));
}

// ---------------------------------------------------------------- portable programs from tests/cases (no ARM registers)
// syscall(SYS_write, ...) is portable (SYS_* are Linux's numbers here); syscall with a bare number is not
const ARM = /\b([xw]([0-9]|[12][0-9]|30)|[sd]([0-9]|[12][0-9]|3[01])|sp|lr|fp|xzr|wzr)\b|\basm\b|\bsyscall\s*\(\s*[^S\s]|\bnaked\b/;
for (const f of readdirSync('tests/cases').filter((f) => f.endsWith('.hla')).sort()) {
  const src = readFileSync(join('tests/cases', f), 'utf8'), exp = join('tests/cases', f.replace(/\.hla$/, '.expected'));
  if (ARM.test(src.replace(/"(\\.|[^"\\])*"|\/\/.*$/gm, '')) || !existsSync(exp)) continue;
  check(join('tests/cases', f), src, readFileSync(exp, 'utf8'));
}

// ---------------------------------------------------------------- portable lesson programs
for (const lessons of ['docs/lessons', 'docs/ru/lessons'])
for (const file of readdirSync(lessons).filter((f) => f.endsWith('.md')).sort()) {
  const md = readFileSync(join(lessons, file), 'utf8');
  const re = /```hla\n([\s\S]*?)```(\n*)(```text\n([\s\S]*?)```)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    const code = m[1];
    if (!/\bfn main\b/.test(code) || m[4] === undefined) continue;
    const where = `${join(lessons, file)}:${md.slice(0, m.index).split('\n').length}`;
    if (ARM.test(code.replace(/"(\\.|[^"\\])*"|\/\/.*$/gm, ''))) { skipped++; continue; }
    check(where, code, m[4]);
  }
}

// ---------------------------------------------------------------- imports: the library comes from the glibc export lists
function linkCheck(what: string, src: string, test: (imports: { lib: string; names: string[] }[] | null, error: string, needed: string[]) => boolean): void {
  let imports: { lib: string; names: string[] }[] | null = null, error = '', needed: string[] = [];
  try { const r = linkElf(assembleX(compileX64(src, { os: 'linux' }).asm)); imports = r.imports; needed = r.needed; } catch (e) { error = (e as Error).message; }
  if (test(imports, error, needed)) { passed++; return; }
  failed++;
  console.log(`FAIL ${what}: ${error || JSON.stringify(imports)}`);
}
linkCheck('imports by library', 'extern printf(fmt, ...), sin, stdout\nfn main() { printf("%p %f", stdout, sin(1.0)) }',
  (im, _, needed) => JSON.stringify(im) === JSON.stringify([
    { lib: 'libc.so.6', names: ['__cxa_atexit', 'exit', 'printf', 'stdout'] }, { lib: 'libm.so.6', names: ['sin'] }]) && JSON.stringify(needed) === '["libm.so.6","libc.so.6"]');
linkCheck('unknown import', 'extern prinft\nfn main() { prinft("x") }', (im, e) => !im && /undefined symbol 'prinft'/.test(e));
linkCheck('a variable is not called', 'extern stdout\nfn main() { stdout() }', (im, e) => !im && /variable of libc\.so\.6/.test(e));

// sections keep the alignment of their most aligned part (a page-aligned buffer in .bss)
{
  const asm = '.intel_syntax noprefix\n.text\n.globl hla_start\nhla_start:\n    hlt\n.data\n.byte 1\n.p2align 6\nline: .quad 1\n.bss\n.byte 0\n.p2align 12\npage: .zero 4096\n';
  const r = linkElf(assembleX(asm));
  const at = (n: string) => r.symbols.find((x) => x.name === n)!.addr;
  if (at('page') % 4096 === 0 && at('line') % 64 === 0) passed++;
  else { failed++; console.log(`FAIL section alignment: page at 0x${at('page').toString(16)}, line at 0x${at('line').toString(16)}`); }
}

console.log(`linux: ${passed} passed, ${failed} failed, ${skipped} skipped (Windows API, ARM registers or ARM assembly)${native ? ' (native + emulator)' : ' (emulator)'}${withClang ? `, also built with ${cc![0].endsWith('zig') ? 'clang + lld (zig cc)' : cc![0].split('/').pop()} from the assembly and from our objects` : ''}`);
process.exit(failed ? 1 : 0);

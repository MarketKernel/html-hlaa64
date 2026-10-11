// x86-64 Windows target: HLA64 programs compiled with the x64 code generator, assembled
// with the built-in x64 assembler, linked by the built-in PE linker and executed in the
// x64 emulator (on Windows they are also run natively).
//   * tests/x64/cases/*.hla   programs written for x64 (xmm registers, rax..., inline asm)
//   * docs/lessons/*.md       every lesson program that does not name ARM registers;
//                             %ld becomes %lld (long is 32 bits on Windows)
// With --clang every program is also assembled by clang (--target=x86_64-pc-windows-msvc) and
// linked by lld-link against import libraries made by llvm-dlltool; that executable must
// produce the same output in the emulator.
//   node tests/x64.ts [--update] [--verbose] [--clang]
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { compileX64 } from '../src/lang/x64/codegen.ts';
import { assembleX } from '../src/asm/x64/assembler.ts';
import { linkPE } from '../src/asm/coff/pe.ts';
import { runPE } from '../src/emu/x64/pe-loader.ts';
import { tool } from './lib/toolchain.ts';

const update = process.argv.includes('--update');
const verbose = process.argv.includes('--verbose');
const native = process.platform === 'win32';
const tmp = mkdtempSync(join(tmpdir(), 'hla-x64-'));
let passed = 0, failed = 0, skipped = 0, n = 0;
const withClang = process.argv.includes('--clang');
const clang = tool('clang'), lld = tool('lld-link'), dlltool = tool('llvm-dlltool');
if (withClang && !(clang && lld && dlltool)) { console.log('--clang needs clang, lld-link and llvm-dlltool'); process.exit(2); }

function build(src: string): Uint8Array {
  const asm = compileX64(src).asm;
  const pe = linkPE(assembleX(asm));
  if (withClang) clangBuild(asm, pe.imports);
  return pe.bytes;
}

// the same assembly through clang + lld-link; the result must behave like ours
let clangOut: string | null = null;
function clangBuild(asm: string, imports: { dll: string; names: string[] }[]): void {
  const base = join(tmp, `c${n++}`);
  writeFileSync(base + '.s', asm);
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${cmd.split('/').pop()} failed: ${r.stderr || r.stdout}`);
  };
  run(clang!, ['--target=x86_64-pc-windows-msvc', '-c', base + '.s', '-o', base + '.obj']);
  const libs: string[] = [];
  for (const imp of imports) {
    const name = imp.dll.replace(/\.dll$/i, '');
    writeFileSync(`${base}.${name}.def`, `LIBRARY ${imp.dll}\nEXPORTS\n${imp.names.join('\n')}\n`);
    run(dlltool!, ['-m', 'i386:x86-64', '-d', `${base}.${name}.def`, '-l', `${base}.${name}.lib`]);
    libs.push(`${base}.${name}.lib`);
  }
  run(lld!, ['/nologo', '/subsystem:console', '/entry:hla_start', `/out:${base}.exe`, base + '.obj', ...libs]);
  const r = runPE(new Uint8Array(readFileSync(base + '.exe')), { limit: 50_000_000 });
  if (r.error) throw new Error('clang-built executable: ' + r.error);
  clangOut = r.stdout;
}

function check(where: string, src: string, expected: string | null, write?: (out: string) => void): void {
  let out: string;
  clangOut = null;
  try {
    const exe = build(src);
    const r = runPE(exe, { limit: 50_000_000 });
    if (r.error) throw new Error('emulator: ' + r.error);
    out = r.stdout;
    if (withClang && clangOut !== out) throw new Error(`clang + lld-link build behaves differently:\n${clangOut}`);
    if (native) {
      const path = join(tmp, `p${n++}.exe`);
      writeFileSync(path, exe);
      const nr = spawnSync(path, [], { encoding: 'utf8' });
      // msvcrt writes \n as \r\n to a pipe (text mode)
      const native = nr.stdout.replace(/\r\n/g, '\n');
      if (native !== out) throw new Error(`native output differs from the emulator (exit ${nr.status}):\n${native}`);
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

// ---------------------------------------------------------------- x64 programs
const cases = 'tests/x64/cases';
for (const f of readdirSync(cases).filter((f) => f.endsWith('.hla')).sort()) {
  const exp = join(cases, f.replace(/\.hla$/, '.expected'));
  check(join(cases, f), readFileSync(join(cases, f), 'utf8'), existsSync(exp) ? readFileSync(exp, 'utf8') : null, (o) => writeFileSync(exp, o));
}

// ---------------------------------------------------------------- portable lesson programs
const ARM = /\b([xw]([0-9]|[12][0-9]|30)|[sd]([0-9]|[12][0-9]|3[01])|sp|lr|fp|xzr|wzr)\b|\basm\b|\bsyscall\b|\bnaked\b/;
const lessons = 'docs/lessons';
for (const file of readdirSync(lessons).filter((f) => f.endsWith('.md')).sort()) {
  const md = readFileSync(join(lessons, file), 'utf8');
  const re = /```hla\n([\s\S]*?)```(\n*)(```text\n([\s\S]*?)```)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    const code = m[1];
    if (!/\bfn main\b/.test(code) || m[4] === undefined) continue;
    const where = `${file}:${md.slice(0, m.index).split('\n').length}`;
    if (ARM.test(code.replace(/"(\\.|[^"\\])*"|\/\/.*$/gm, ''))) { skipped++; continue; }
    check(where, code.replace(/%l([dux])/g, '%ll$1'), m[4]);
  }
}

console.log(`x64: ${passed} passed, ${failed} failed, ${skipped} lesson programs skipped (ARM registers or ARM assembly)${native ? ' (native + emulator)' : ' (emulator)'}${withClang ? ', also built with clang + lld-link' : ''}`);
process.exit(failed ? 1 : 0);

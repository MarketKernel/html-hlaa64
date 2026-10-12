// WebAssembly target: HLA64 programs compiled with the wasm32 code generator, assembled into a .wasm
// module by the built-in assembler and run natively by Node's WebAssembly engine with the JavaScript
// runtime of src/wasm/runtime.ts as their system.
//   * tests/wasm/cases/*.hla  programs written for wasm32 (r/f registers, WebAssembly instructions)
//   * tests/cases, examples   programs that name no registers of another platform
//   * docs/{,ru/}lessons/*.md every lesson program without ARM/x64 registers or assembly
// When binaryen's wasm-as is installed (on PATH or in $BINARYEN), every module is also assembled from
// the same text by wasm-as; that module must print the same.
//   node tests/wasm.ts [--update] [--verbose]
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { compileWasm } from '../src/lang/wasm/codegen.ts';
import { assembleWasm } from '../src/asm/wasm/assembler.ts';
import { runWasm } from '../src/wasm/runtime.ts';
import { memoryFiles } from '../src/emu/files.ts';
import { combineSources } from '../src/lang/include.ts';
import { onPath } from '../src/win-toolchain.ts';

const update = process.argv.includes('--update');
const verbose = process.argv.includes('--verbose');
const tmp = mkdtempSync(join(tmpdir(), 'hla-wasm-'));
const wasmAs = process.env.BINARYEN && existsSync(join(process.env.BINARYEN, 'wasm-as')) ? join(process.env.BINARYEN, 'wasm-as') : onPath('wasm-as');
let passed = 0, failed = 0, skipped = 0, n = 0;

// registers and instructions of the other platforms
const FOREIGN = /\b([xw]([0-9]|[12][0-9]|30)|[sd]([0-9]|[12][0-9]|3[01])|sp|lr|fp|xzr|wzr|[re]?(ax|bx|cx|dx|si|di|bp)|r(8|9|1[0-5])[dwb]?|xmm\d+)\b|\basm\b|\bsyscall\b|\bnaked\b|^\s*(mov|ldr|str|add|sub|cmp|b\.\w+|lea|call)\s/m;
const portable = (src: string) => !FOREIGN.test(src.replace(/"(\\.|[^"\\])*"|'(\\.|[^'\\])*'|\/\/.*$/gm, ''));

function build(src: string, file = 'program.hla', read?: (f: string) => string | null): { wat: string; bytes: Uint8Array } {
  const text = combineSources(file, (f) => (f === file ? src : read?.(f) ?? null)).text;
  const wat = compileWasm(text).asm;
  return { wat, bytes: assembleWasm(wat).bytes };
}

function check(where: string, src: string, expected: string | null, write?: (out: string) => void, read?: (f: string) => string | null): void {
  let out: string;
  const args: string[] = JSON.parse(/^\/\/ args: (\[.*?\])/m.exec(src)?.[1] ?? '[]');
  try {
    const { wat, bytes } = build(src, basename(where), read);
    const r = runWasm(bytes, { args, files: memoryFiles(), name: basename(where).replace(/\.hla$/, '') });
    if (r.error) throw new Error('runtime: ' + r.error);
    out = r.stdout;
    if (wasmAs) {
      const base = join(tmp, `m${n++}`);
      writeFileSync(base + '.wat', wat);
      const as = spawnSync(wasmAs, ['--enable-sign-ext', '--enable-nontrapping-float-to-int', '--enable-bulk-memory', base + '.wat', '-o', base + '.wasm'], { encoding: 'utf8' });
      if (as.status !== 0) throw new Error(`wasm-as rejects the text: ${as.stderr}`);
      const r2 = runWasm(new Uint8Array(readFileSync(base + '.wasm')), { args, files: memoryFiles(), name: basename(where).replace(/\.hla$/, '') });
      if (r2.stdout !== out || r2.exitCode !== r.exitCode) throw new Error(`the module from wasm-as behaves differently:\n${r2.stdout}${r2.error ?? ''}`);
    }
  } catch (e) {
    failed++;
    console.log(`FAIL ${where}: ${(e as Error).message.split('\n').slice(0, verbose ? 20 : 2).join('\n')}`);
    return;
  }
  if ((expected === null || update) && write) { write(out); passed++; console.log(`wrote ${where}`); return; }
  if (out === expected) { passed++; return; }
  failed++;
  console.log(`FAIL ${where}: output differs`);
  if (verbose) console.log(`--- got\n${out}--- expected\n${expected}`);
}

// ---------------------------------------------------------------- wasm32 programs
const cases = 'tests/wasm/cases';
for (const f of readdirSync(cases).filter((f) => f.endsWith('.hla')).sort()) {
  const exp = join(cases, f.replace(/\.hla$/, '.expected'));
  check(join(cases, f), readFileSync(join(cases, f), 'utf8'), existsSync(exp) ? readFileSync(exp, 'utf8') : null, (o) => writeFileSync(exp, o));
}

// ---------------------------------------------------------------- portable programs
for (const d of ['examples', 'tests/cases']) {
  for (const f of readdirSync(d).filter((f) => f.endsWith('.hla')).sort()) {
    const src = readFileSync(join(d, f), 'utf8'), exp = join(d, f.replace(/\.hla$/, '.expected'));
    if (!existsSync(exp)) continue;
    if (!portable(src)) { skipped++; continue; }
    check(join(d, f), src, readFileSync(exp, 'utf8'), undefined, (inc) => { try { return readFileSync(join(dirname(join(d, f)), inc), 'utf8'); } catch { return null; } });
  }
}
{
  const dir = 'tests/include';
  check(join(dir, 'main.hla'), readFileSync(join(dir, 'main.hla'), 'utf8'), readFileSync(join(dir, 'main.expected'), 'utf8'), undefined,
    (inc) => { try { return readFileSync(join(dir, inc), 'utf8'); } catch { return null; } });
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
    if (!portable(code)) { skipped++; continue; }
    check(where, code, m[4]);
  }
}

// ---------------------------------------------------------------- the self-hosted toolchain as WebAssembly
// hlc and hlas (selfhost/) built for wasm32 translate hello.hla and assemble hello.s: the same files as
// the TypeScript toolchain (the assemblers) and the reference outputs in selfhost/ (the translators)
{
  const read = (f: string) => { try { return readFileSync(join('selfhost', f), 'utf8'); } catch { return null; } };
  const tool = (main: string, args: string[], expect: Uint8Array | string, what: string) => {
    try {
      const bytes = build(read(main)!, main, read).bytes;
      const files = memoryFiles({ [args[0]]: read(args[0])! });
      const r = runWasm(bytes, { args, files, name: main.replace(/\.hla$/, '') });
      if (r.error || r.exitCode !== 0) throw new Error(`exit ${r.exitCode} ${r.error ?? ''}\n${r.stdout}`);
      const got = files.files.get(args[1]);
      const want = typeof expect === 'string' ? new TextEncoder().encode(expect) : expect;
      if (!got || got.length !== want.length || got.some((b, i) => b !== want[i])) throw new Error(`${args[1]} differs (${got?.length ?? 0} bytes, expected ${want.length})`);
      passed++;
    } catch (e) {
      failed++;
      console.log(`FAIL selfhost ${what}: ${(e as Error).message.split('\n').slice(0, verbose ? 20 : 2).join('\n')}`);
    }
  };
  const { assembleExecutable } = await import('../src/asm/index.ts');
  const { assembleExecutableX } = await import('../src/asm/x64/index.ts');
  tool('hlc-arm.hla', ['hello.hla', 'hello.s'], read('hello.s')!, 'hlc-arm: hello.hla → hello.s');
  tool('hlc-x64.hla', ['hello.hla', 'hello-x64.s'], read('hello-x64.s')!, 'hlc-x64: hello.hla → hello-x64.s');
  tool('hlas-arm.hla', ['hello.s', 'hello'], assembleExecutable(read('hello.s')!, { name: 'hello' }), 'hlas-arm: hello.s → Mach-O');
  tool('hlas-x64.hla', ['hello-x64.s', 'hello.exe'], assembleExecutableX(read('hello-x64.s')!), 'hlas-x64: hello-x64.s → PE');
}

// ---------------------------------------------------------------- errors the target reports
function errorCheck(what: string, src: string, re: RegExp): void {
  let msg = '';
  try { build(src); } catch (e) { msg = (e as Error).message; }
  if (re.test(msg)) { passed++; return; }
  failed++;
  console.log(`FAIL ${what}: ${msg || 'no error'}`);
}
errorCheck('unknown system function', 'extern prinft\nfn main() { prinft("x") }', /'prinft' is not a function of the wasm32 system/);
errorCheck('goto into a block', 'fn main() {\n  goto inner\n  if 1 {\n    inner:\n  }\n}', /goto inner jumps into another block/);
errorCheck('wrong instruction type', 'fn main() {\n  let x: r1 = 1\n  local.get x\n  f64.neg\n  drop\n}', /f64\.neg: expected f64, found i64/);
errorCheck('unbalanced stack', 'fn main() {\n  i64.const 1\n}', /value\(s\) left on the stack/);

console.log(`wasm32: ${passed} passed, ${failed} failed, ${skipped} programs skipped (registers or assembly of another platform)${wasmAs ? ', also assembled by binaryen wasm-as' : ''}`);
process.exit(failed ? 1 : 0);

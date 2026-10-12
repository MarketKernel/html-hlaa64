// Differential fuzzing of the HLA64 code generator.
// Random 64-bit integer expressions over register variables are compiled, assembled
// with the built-in assembler and executed natively and in the emulator; every
// result is compared with an independent BigInt evaluator. The same programs are also
// compiled for x86-64 Windows and executed in the x64 emulator, and for wasm32 and executed
// by Node's WebAssembly engine.
//   node tests/fuzz.ts [seed] [programs]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../src/lang/codegen.ts';
import { assembleExecutable } from '../src/asm/index.ts';
import { runMachO } from '../src/emu/macho-loader.ts';
import { compileX64 } from '../src/lang/x64/codegen.ts';
import { assembleX } from '../src/asm/x64/assembler.ts';
import { linkPE } from '../src/asm/coff/pe.ts';
import { runPE } from '../src/emu/x64/pe-loader.ts';
import { compileWasm } from '../src/lang/wasm/codegen.ts';
import { assembleWasm } from '../src/asm/wasm/assembler.ts';
import { runWasm } from '../src/wasm/runtime.ts';

const S64 = (v: bigint) => BigInt.asIntN(64, v);
let seed = Number(process.argv[2] ?? 12345);
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];

type E = { s: string; v: bigint; simple: boolean };
const VARS = ['a', 'b', 'c', 'd', 'e', 'f'];

function randConst(): bigint {
  const r = rnd();
  if (r < 0.3) return BigInt(Math.floor(rnd() * 20) - 5);
  if (r < 0.6) return BigInt(Math.floor(rnd() * 70000) - 1000);
  if (r < 0.8) return BigInt(Math.floor(rnd() * 2 ** 31)) * (rnd() < 0.5 ? -1n : 1n);
  return S64(BigInt(Math.floor(rnd() * 2 ** 32)) << 32n | BigInt(Math.floor(rnd() * 2 ** 32)));
}

function gen(env: Map<string, bigint>, depth: number): E {
  if (depth <= 0 || rnd() < 0.25) {
    if (rnd() < 0.6) { const n = pick(VARS); return { s: n, v: env.get(n)!, simple: true }; }
    const c = randConst();
    return { s: c < 0n ? `(${c})` : `${c}`, v: c, simple: true };
  }
  const kind = rnd();
  if (kind < 0.55) {
    const op = pick(['+', '-', '*', '&', '|', '^', '<<', '>>', '>>>', '/', '%', '+', '-', '&']);
    const l = gen(env, depth - 1);
    if (op === '<<' || op === '>>' || op === '>>>') {
      // shift by a constant 0..63 or by (x & 63)
      let r: E;
      if (rnd() < 0.5) { const k = BigInt(Math.floor(rnd() * 64)); r = { s: `${k}`, v: k, simple: true }; }
      else { const x = gen(env, depth - 1); r = { s: `(${x.s} & 63)`, v: x.v & 63n, simple: false }; }
      const sh = r.v;
      const v = op === '<<' ? S64(l.v << sh) : op === '>>' ? S64(l.v >> sh) : S64(BigInt.asUintN(64, l.v) >> sh);
      return { s: `(${l.s} ${op} ${r.s})`, v, simple: false };
    }
    if (op === '/' || op === '%') {
      // divisor must be non-zero: (x | 1)
      const x = gen(env, depth - 1);
      const d = x.v | 1n;
      if (l.v === -(1n << 63n) && d === -1n) return l;
      const v = op === '/' ? l.v / d : l.v % d;
      return { s: `(${l.s} ${op} (${x.s} | 1))`, v: S64(v), simple: false };
    }
    const r = gen(env, depth - 1);
    const v = op === '+' ? l.v + r.v : op === '-' ? l.v - r.v : op === '*' ? l.v * r.v : op === '&' ? l.v & r.v : op === '|' ? l.v | r.v : l.v ^ r.v;
    return { s: `(${l.s} ${op} ${r.s})`, v: S64(v), simple: false };
  }
  if (kind < 0.65) {
    const op = pick(['-', '~', '!']);
    const x = gen(env, depth - 1);
    const v = op === '-' ? S64(-x.v) : op === '~' ? ~x.v : x.v === 0n ? 1n : 0n;
    return { s: `${op}(${x.s})`, v, simple: false };
  }
  if (kind < 0.8) {
    const op = pick(['==', '!=', '<', '<=', '>', '>=']);
    const l = gen(env, depth - 1), r = gen(env, depth - 1);
    const t = op === '==' ? l.v === r.v : op === '!=' ? l.v !== r.v : op === '<' ? l.v < r.v : op === '<=' ? l.v <= r.v : op === '>' ? l.v > r.v : l.v >= r.v;
    if (rnd() < 0.5) {
      const a = gen(env, depth - 1), b = gen(env, depth - 1);
      return { s: `(${l.s} ${op} ${r.s} ? ${a.s} : ${b.s})`, v: t ? a.v : b.v, simple: false };
    }
    return { s: `(${l.s} ${op} ${r.s})`, v: t ? 1n : 0n, simple: false };
  }
  if (kind < 0.88) {
    const op = pick(['&&', '||']);
    const l = gen(env, depth - 1), r = gen(env, depth - 1);
    const v = op === '&&' ? (l.v !== 0n && r.v !== 0n ? 1n : 0n) : (l.v !== 0n || r.v !== 0n ? 1n : 0n);
    return { s: `(${l.s} ${op} ${r.s})`, v, simple: false };
  }
  const fn = pick(['min', 'max', 'abs']);
  if (fn === 'abs') {
    const x = gen(env, 0);
    return { s: `abs(${x.s})`, v: S64(x.v < 0n ? -x.v : x.v), simple: false };
  }
  const x = gen(env, 0), y = gen(env, 0);
  return { s: `${fn}(${x.s}, ${y.s})`, v: fn === 'min' ? (x.v < y.v ? x.v : y.v) : (x.v > y.v ? x.v : y.v), simple: false };
}

const programs = Number(process.argv[3] ?? 6);
const perProgram = 150;
const dir = mkdtempSync(join(tmpdir(), 'hla-fuzz-'));
let total = 0, failures = 0, compileErrors = 0, tooComplex = 0;
for (let p = 0; p < programs; p++) {
  const env = new Map<string, bigint>();
  for (const v of VARS) env.set(v, randConst());
  const lines: string[] = [
    'extern printf(fmt, ...)', 'data fails: i64 = 0', '',
    'fn check(got, want, id) {', '    if got != want {',
    '        printf("FAIL %lld: got %lld want %lld\\n", id, got, want)', '        fails++', '    }', '}', '',
    'fn main() {',
    ...VARS.map((v) => `    let ${v} = ${env.get(v)! < 0n ? `(${env.get(v)})` : env.get(v)}`),
  ];
  const exprs: E[] = [];
  for (let i = 0; i < perProgram; i++) {
    const e = gen(env, 1 + Math.floor(rnd() * 4));
    // keep each candidate only if the compiler accepts it on its own
    try {
      const probe = ['fn check(got, want, id) {}', 'fn main() {', ...VARS.map((v) => `let ${v} = 1`), `check(${e.s}, 0, 0)`, '}'].join('\n');
      compile(probe);
      compileX64(probe);
      compileWasm(probe);
    } catch (err) {
      if (/too complex/.test((err as Error).message)) tooComplex++; else { console.log('compile error:', (err as Error).message, '\n  ', e.s); compileErrors++; }
      continue;
    }
    exprs.push(e);
    lines.push(`    check(${e.s}, ${e.v < 0n ? `(${e.v})` : e.v}, ${exprs.length})`);
  }
  lines.push('    printf("done %lld\\n", fails)', '}');
  const src = lines.join('\n');
  writeFileSync(join(dir, `p${p}.hla`), src);
  const bin = assembleExecutable(compile(src).asm, { name: `fuzz${p}` });
  const exe = join(dir, `p${p}`);
  writeFileSync(exe, bin);
  chmodSync(exe, 0o755);
  const emuOut = runMachO(bin).stdout;
  const native = process.platform === 'darwin' ? spawnSync(exe, [], { encoding: 'utf8' }).stdout : emuOut;
  const emu = emuOut;
  total += exprs.length;
  const report = (name: string, out: string) => {
    for (const l of out.split('\n')) {
      const m = /^FAIL (\d+)/.exec(l);
      if (m) { failures++; console.log(`[${name}] ${l}\n    expr: ${exprs[Number(m[1]) - 1].s}`); }
    }
    if (!/done/.test(out)) { failures++; console.log(`[${name}] program p${p} did not finish`); }
  };
  const x64 = runPE(linkPE(assembleX(compileX64(src).asm)).bytes);
  report('native', native);
  report('emu', emu);
  report('x64', x64.stdout + (x64.error ? `\nx64 emulator: ${x64.error}\n` : ''));
  if (x64.error) console.log(`p${p}: x64 emulator: ${x64.error}`);
  const wasm = runWasm(assembleWasm(compileWasm(src).asm).bytes);
  report('wasm', wasm.stdout + (wasm.error ? `\nwasm: ${wasm.error}\n` : ''));
  if (native !== emu) console.log(`p${p}: native and emulator outputs differ`);
}
console.log(`${total} random expressions, ${failures} failures, ${compileErrors} unexpected compile errors, ${tooComplex} rejected as too complex (programs in ${dir})`);
process.exit(failures || compileErrors ? 1 : 0);

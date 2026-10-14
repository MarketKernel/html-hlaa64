// Pair transfers are instruction sugar, not general tuple values or two scalar accesses.
import assert from 'node:assert/strict';
import { compile } from '../src/lang/codegen.ts';
import { compileX64 } from '../src/lang/x64/codegen.ts';
import { compileWasm } from '../src/lang/wasm/codegen.ts';

const body = (s: string) => `naked fn pair_check() {\n${s}\nreturn\n}`;
const instructions = (s: string) => compile(body(s)).asm.split('\n').map(l => l.trim()).filter(l => /^(?:stp|ldp|ret)\b/.test(l));
const valid: [string, string][] = [
  ['u64[sp + 0x60] = (x29, x30)', 'stp x29, x30, [sp, #96]'],
  ['(fp, lr) = u64[sp + 0x60]', 'ldp x29, x30, [sp, #96]'],
  ['u64[sp - 0x70]! = (x29, x30)', 'stp x29, x30, [sp, #-112]!'],
  ['(x0, x1) = u64[x10]!', 'ldp x0, x1, [x10, #0]!'],
  ['u64[x10 - 512] = (x0, x1)', 'stp x0, x1, [x10, #-512]'],
  ['(w0, w1) = u32[x10 + 252]', 'ldp w0, w1, [x10, #252]'],
  ['u32[x10++] = (w0, w1)', 'stp w0, w1, [x10], #8'],
  ['(s0, s1) = f32[x10--]', 'ldp s0, s1, [x10], #-8'],
  ['f64[sp] = (d0, d1)', 'stp d0, d1, [sp]'],
  ['[x10] = (xzr, xzr)', 'stp xzr, xzr, [x10]'],
  ['(x10, x0) = ptr[x10]', 'ldp x10, x0, [x10]'],
  ['alias p = sp\nalias a = x29\nalias b = x30\nconst OFF = 96\nu64[p + OFF] = (a, b)', 'stp x29, x30, [sp, #96]'],
  ['u64[8 + x10 - 16] = (x0, x1)', 'stp x0, x1, [x10, #-8]'],
];
for (const [source, expected] of valid) assert.deepEqual(instructions(source), [expected, 'ret'], source);

const invalid: [string, RegExp][] = [
  ['u64[x10] = (x0, w1)', /same class and width/],
  ['u64[x10] = (x0, d1)', /same class and width/],
  ['u64[x10] = (sp, x1)', /excluding SP/],
  ['u64[x10] = (x0, 1)', /two registers/],
  ['u64[x10] = (x0 + 1, x1)', /two registers/],
  ['u32[x10] = (x0, x1)', /element type/],
  ['f64[x10] = (x0, x1)', /element type/],
  ['u64[x10] = (d0, d1)', /element type/],
  ['u8[x10] = (w0, w1)', /element type/],
  ['(x0, x0) = u64[x10]', /destinations must be different/],
  ['alias a = x0\n(x0, a) = u64[x10]', /destinations must be different/],
  ['(d0, d0) = f64[x10]', /destinations must be different/],
  ['u64[x10 + 1] = (x0, x1)', /multiple of 8/],
  ['u64[x10 + 512] = (x0, x1)', /-512..504/],
  ['u64[x10 - 520] = (x0, x1)', /-512..504/],
  ['u64[xzr] = (x0, x1)', /64-bit base/],
  ['u64[w10] = (x0, x1)', /64-bit base/],
  ['u64[x10 + x11] = (x0, x1)', /64-bit base/],
  ['u64[x10 + foo()] = (x0, x1)', /64-bit base/],
  ['u64[x10++] = (x10, x1)', /writeback base/],
  ['(w10, w1) = u32[x10--]', /writeback base/],
  ['u64[x10 + 8]! = (x0, x10)', /writeback base/],
  ['u64[x10++]! = (x0, x1)', /both pre-index and post-index/],
  ['u64[x10 + 8++] = (x0, x1)', /post-increment needs a register/],
  ['u64[x10] += (x0, x1)', /simple memory assignment/],
  ['(x0, x1) = 42', /memory reference/],
];
for (const [source, message] of invalid) assert.throws(() => compile(body(source)), message, source);

// Existing grouped arithmetic stays an expression; tuples don't leak into it.
assert.match(compile(body('x0 = (x1 + x2) * 3')).asm, /add/);
assert.throws(() => compileX64('fn main() { u64[rax] = (rcx, rdx) }'), /only by the AArch64 target/);
assert.throws(() => compileWasm('fn main() { u64[r0] = (r1, r2) }'), /only by the AArch64 target/);
console.log(`Pair memory: ${valid.length} native instruction forms, ${invalid.length} invalid forms and target boundaries passed.`);

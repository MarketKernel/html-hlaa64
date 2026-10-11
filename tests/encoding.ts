// Cross-checks the built-in instruction encoder against clang's integrated assembler.
// Every line below is assembled by both; the 32-bit words must match exactly.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encode } from '../src/asm/encode.ts';
import { parseOperand, splitOperands } from '../src/asm/parse.ts';
import { tool } from './lib/toolchain.ts';

const INSNS = `
mov x0, x1
mov w3, w4
mov x29, sp
mov sp, x29
mov x0, #0
mov x0, #1
mov x0, #65535
mov x0, #0x10000
mov x0, #0xffff0000
mov x0, #-1
mov x0, #-2
mov w0, #-1
mov w0, #0xffffffff
mov w0, #0x7fffffff
mov x0, #0xff00ff00ff00ff00
mov x9, #0x5555555555555555
mov x0, #0x123400000000
movz x0, #0x1234, lsl #16
movk x0, #0xbeef, lsl #48
movn w5, #7
movz w1, #3
add x0, x1, x2
add w0, w1, w2
add x0, x1, #4095
add x0, x1, #4096
add x0, x1, #1, lsl #12
add x0, x1, #-8
sub x0, x1, #16
sub sp, sp, #32
add sp, sp, #32
sub sp, x29, #48
add x0, sp, #8
sub sp, sp, x16
add x0, x1, x2, lsl #3
sub x0, x1, x2, asr #1
add x0, x1, x2, lsr #63
add x0, x1, w2, sxtw
add x0, x1, w2, uxtw #2
adds x0, x1, #1
subs w0, w1, w2
cmp x0, #0
cmp x0, #4095
cmp w1, w2
cmp x1, x2, lsl #2
cmp x16, w10, sxtw
cmp x0, #-1
cmn x0, #5
cmn w0, w1
neg x0, x1
neg w0, w1
negs x2, x3
and x0, x1, x2
and x0, x1, #0xff
and w0, w1, #1
and x0, x1, #0xfffffffffffffff0
orr x0, x1, x2
orr w0, w1, #0x80000000
eor x0, x1, #0x5555555555555555
eor x0, x1, x2, ror #4
ands x0, x1, x2
bic x0, x1, x2
orn x0, x1, x2
eon w0, w1, w2
bics x0, x1, x2
tst x0, #1
tst w0, #0x80
tst x0, x1
mvn x0, x1
mvn w2, w3
lsl x0, x1, #3
lsl w0, w1, #31
lsr x0, x1, #1
lsr w0, w1, #4
asr x0, x1, #63
asr w0, w1, #4
ror x0, x1, #7
lsl x0, x1, x2
lsr w0, w1, w2
asr x0, x1, x2
ror x0, x1, x2
sxtb x0, w1
sxth w0, w1
sxtw x0, w1
uxtb w0, w1
uxth w0, w1
ubfx x0, x1, #4, #8
sbfx w0, w1, #3, #5
ubfiz x0, x1, #2, #10
bfi x0, x1, #8, #16
bfxil w0, w1, #2, #3
extr x0, x1, x2, #12
mul x0, x1, x2
mul w0, w1, w2
madd x0, x1, x2, x3
msub x0, x1, x2, x3
mneg x0, x1, x2
smull x0, w1, w2
umull x0, w1, w2
smulh x0, x1, x2
umulh x0, x1, x2
sdiv x0, x1, x2
udiv w0, w1, w2
clz x0, x1
clz w0, w1
cls x0, x1
rbit x0, x1
rbit w0, w1
rev x0, x1
rev w0, w1
rev16 x0, x1
rev32 x0, x1
csel x0, x1, x2, eq
csel w0, w1, w2, lt
csinc x0, x1, x2, ne
csinv x0, x1, x2, ge
csneg x0, x1, x2, hi
cset x0, eq
cset w0, lo
csetm x0, gt
cinc x0, x1, le
cneg x0, x1, mi
cinv x0, x1, vs
ccmp x0, #3, #4, ne
ccmp x0, x1, #0, eq
ccmn w0, #1, #2, ge
br x16
blr x9
ret
ret x1
svc #0x80
brk #1
nop
ldr x0, [x1]
ldr x0, [x1, #8]
ldr x0, [x1, #32760]
ldr w0, [x1, #4]
ldr x0, [x1, #-8]
ldr x0, [x29, #-16]
ldr x0, [x1, #3]
ldur x0, [x1, #-1]
str x0, [sp, #16]
str w0, [x2, #-4]
str x19, [sp]
stur w0, [x1, #1]
ldrb w0, [x1]
ldrb w0, [x1, #4095]
ldrb w0, [x1, #-1]
strb w0, [x1, #3]
ldrh w0, [x1, #2]
ldrh w0, [x1, #3]
strh w0, [x1, #-2]
ldrsb x0, [x1]
ldrsb w0, [x1, #1]
ldrsh x0, [x1, #2]
ldrsh w0, [x1]
ldrsw x0, [x1, #4]
ldrsw x0, [x1, #-4]
ldr x0, [x1], #8
ldr x0, [x1, #8]!
str x0, [sp, #-16]!
ldr x0, [sp], #16
ldrb w0, [x9], #1
strb w0, [x9], #-1
ldr x0, [x1, x2]
ldr x0, [x1, x2, lsl #3]
ldr w0, [x1, x2, lsl #2]
ldrb w0, [x1, x2]
ldrh w0, [x1, x2, lsl #1]
ldrsw x0, [x1, x2, lsl #2]
ldr x0, [x1, w2, sxtw]
ldr x0, [x1, w2, sxtw #3]
ldr w0, [x1, w2, uxtw #2]
str x0, [x1, x2, lsl #3]
strb w0, [x16, x19]
strh w0, [x1, x2]
ldr d0, [x1]
ldr d0, [x1, #8]
ldr s0, [x1, #4]
str d8, [sp, #8]
str s1, [x2, #-4]
ldr q0, [x1, #16]
str q1, [sp, #32]
ldr d0, [x1, x2, lsl #3]
ldr d1, [sp], #16
str d1, [sp, #-16]!
ldp x29, x30, [sp], #16
stp x29, x30, [sp, #-16]!
stp x19, x20, [sp, #16]
ldp x19, x20, [x29, #-16]
stp w0, w1, [sp, #8]
ldp w0, w1, [x1]
stp d8, d9, [sp, #-32]!
ldp d8, d9, [sp, #16]
stp q0, q1, [sp, #32]
ldp x0, x1, [x2, #504]
ldp x0, x1, [x2, #-512]
fmov d0, d1
fmov s0, s1
fmov d0, x1
fmov x0, d1
fmov s0, w1
fmov w0, s1
fmov d0, #1.0
fmov d0, #2.5
fmov d0, #-0.125
fmov s0, #31.0
fmov d1, #0.5
fadd d0, d1, d2
fadd s0, s1, s2
fsub d0, d1, d2
fmul d0, d1, d2
fdiv d0, d1, d2
fmax d0, d1, d2
fmin d0, d1, d2
fmaxnm d0, d1, d2
fminnm s0, s1, s2
fnmul d0, d1, d2
fneg d0, d1
fabs d0, d1
fsqrt d0, d1
fsqrt s0, s1
frintz d0, d1
frintm d0, d1
frintp d0, d1
frintn d0, d1
frinta d0, d1
fcvt d0, s1
fcvt s0, d1
fcmp d0, d1
fcmp s0, s1
fcmp d0, #0.0
fcmpe d0, d1
fcsel d0, d1, d2, gt
fmadd d0, d1, d2, d3
fmsub d0, d1, d2, d3
fnmadd d0, d1, d2, d3
scvtf d0, x1
scvtf d0, w1
scvtf s0, x1
ucvtf d0, x1
fcvtzs x0, d1
fcvtzs w0, d1
fcvtzs x0, s1
fcvtzu x0, d1
fcvtas x0, d1
fcvtms x0, d1
fcvtps x0, d1
fcvtns x0, d1
`.trim().split('\n').map((l) => l.trim()).filter(Boolean);

const dir = mkdtempSync(join(tmpdir(), 'hla-enc-'));
writeFileSync(join(dir, 't.s'), '.text\n' + INSNS.join('\n') + '\n');
// --target (not -arch, which only Apple's clang driver understands) so this also runs with LLVM on Windows/Linux
execFileSync(tool('clang') ?? 'clang', ['--target=arm64-apple-macos', '-c', join(dir, 't.s'), '-o', join(dir, 't.o')]);
const obj = readFileSync(join(dir, 't.o'));

// locate __text in the object file
function textSection(buf: Buffer): Buffer {
  const ncmds = buf.readUInt32LE(16);
  let off = 32;
  for (let i = 0; i < ncmds; i++) {
    const cmd = buf.readUInt32LE(off), size = buf.readUInt32LE(off + 4);
    if (cmd === 0x19) {
      const nsects = buf.readUInt32LE(off + 64);
      for (let s = 0; s < nsects; s++) {
        const so = off + 72 + s * 80;
        const name = buf.toString('latin1', so, so + 16).replace(/\0.*$/, '');
        if (name === '__text') {
          const sz = Number(buf.readBigUInt64LE(so + 40));
          const fo = buf.readUInt32LE(so + 48);
          return buf.subarray(fo, fo + sz);
        }
      }
    }
    off += size;
  }
  throw new Error('no __text');
}

const text = textSection(obj);
let bad = 0;
INSNS.forEach((line, i) => {
  const want = text.readUInt32LE(i * 4);
  const m = /^(\S+)\s*(.*)$/.exec(line)!;
  let got: number | string;
  try {
    const ops = m[2] ? splitOperands(m[2]).map((o) => parseOperand(o, i + 1)) : [];
    got = encode(m[1], ops, i + 1).word >>> 0;
  } catch (e) {
    got = 'error: ' + (e as Error).message;
  }
  if (got !== want) {
    bad++;
    console.log(`MISMATCH ${line.padEnd(34)} clang=${want.toString(16).padStart(8, '0')} ours=${typeof got === 'number' ? got.toString(16).padStart(8, '0') : got}`);
  }
});
console.log(`${INSNS.length - bad}/${INSNS.length} instructions encode identically to clang`);
process.exit(bad ? 1 : 0);

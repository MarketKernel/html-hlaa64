// Cross-checks the x86-64 encoder against clang (`--target=x86_64-pc-windows-msvc`).
// Every line is encoded by both; the bytes must match exactly.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeX, parseXOperands } from '../src/asm/x64/encode.ts';
import { tool } from './lib/toolchain.ts';

const regs64 = ['rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'];
const lines: string[] = [];
const add = (...l: string[]) => lines.push(...l);

// register-register forms over all registers
for (const op of ['mov', 'add', 'sub', 'and', 'or', 'xor', 'cmp', 'test', 'adc', 'sbb']) {
  for (const a of ['rax', 'rbx', 'r8', 'r15', 'rsp']) for (const b of ['rcx', 'rdi', 'r9', 'r12']) add(`${op} ${a}, ${b}`);
  add(`${op} eax, ecx`, `${op} r10d, esi`, `${op} ax, bx`, `${op} al, cl`, `${op} sil, dil`, `${op} r8b, al`);
}
// immediates
for (const op of ['add', 'sub', 'and', 'or', 'xor', 'cmp']) {
  for (const v of ['1', '-1', '127', '-128', '128', '1000', '0x7fffffff', '-0x80000000']) {
    add(`${op} rax, ${v}`, `${op} rbx, ${v}`, `${op} r11, ${v}`);
  }
  add(`${op} eax, 5`, `${op} ecx, 0x12345`, `${op} al, 7`, `${op} bl, 200`, `${op} ax, 1000`, `${op} dx, 3`);
  add(`${op} qword ptr [rbx], 5`, `${op} dword ptr [rbp - 8], 1000`, `${op} byte ptr [rax + rcx], 1`);
}
add('test rax, 1', 'test eax, 0x100', 'test rcx, 8', 'test al, 1', 'test bl, 0x80', 'test r9d, 3', 'test qword ptr [rsp + 8], 1');
// mov forms
for (const r of regs64) add(`mov ${r}, 5`, `mov ${r}, -1`, `mov ${r}, 0x123456789`);
add('mov rax, 0xffffffff', 'mov eax, 0xffffffff', 'mov r9d, 7', 'mov ax, 9', 'mov al, 1', 'mov r12b, 3', 'mov sil, 4');
add('movabs rax, 0x1122334455667788', 'movabs r15, 5');
// memory addressing
for (const b of regs64) {
  add(`mov rax, qword ptr [${b}]`, `mov rax, qword ptr [${b} + 8]`, `mov rax, qword ptr [${b} - 300]`, `mov qword ptr [${b} + 16], rcx`);
  if (b !== 'rsp') add(`lea rax, [rbx + 8*${b} + 4]`, `mov ecx, dword ptr [r13 + 4*${b}]`);
}
add('mov rax, qword ptr [rsp + 0x1000]', 'lea rax, [rax + rax*2]', 'lea r8, [r9 + r10*8 - 1]', 'mov byte ptr [rdi], al', 'mov word ptr [rsi + 2], cx',
  'mov dword ptr [r8 + 4], r9d', 'mov qword ptr [rsp], 0', 'mov dword ptr [rax], -1', 'mov byte ptr [rcx + 1], 255', 'mov word ptr [rdx], 1000',
  'mov al, byte ptr [rbx + rcx]', 'mov r10b, byte ptr [r11]', 'mov sil, byte ptr [rsi]');
add('movzx eax, byte ptr [rcx]', 'movzx rax, byte ptr [rcx]', 'movzx eax, word ptr [rdx + 2]', 'movzx ecx, al', 'movzx r8d, r9b', 'movzx eax, sil', 'movzx rax, cx',
  'movsx rax, byte ptr [rbx]', 'movsx eax, byte ptr [rbx]', 'movsx rax, word ptr [rbx]', 'movsx rcx, dl', 'movsx r12, r13w', 'movsxd rax, dword ptr [rcx + 8]', 'movsxd rax, ecx', 'movsxd r9, r10d');
add('lea rax, [rbp - 16]', 'lea rcx, [rsp + 32]', 'lea r12, [r12]', 'lea eax, [rcx + 1]');
// unary, multiply, divide
for (const op of ['not', 'neg', 'inc', 'dec', 'mul', 'div', 'idiv']) add(`${op} rax`, `${op} r11`, `${op} ecx`, `${op} qword ptr [rbx]`, `${op} bl`);
add('imul rax, rbx', 'imul r8, qword ptr [rcx]', 'imul ecx, edx', 'imul rax, rbx, 10', 'imul rax, rbx, 1000', 'imul r9, r9, -3', 'imul rcx', 'imul rax, 7');
add('cqo', 'cdq', 'cdqe', 'cwde');
// shifts and bits
for (const op of ['shl', 'shr', 'sar', 'rol', 'ror']) add(`${op} rax, 1`, `${op} rax, 5`, `${op} r10, 63`, `${op} ecx, 3`, `${op} rax, cl`, `${op} r9d, cl`, `${op} bl, 2`, `${op} qword ptr [rsp], 4`);
add('shl rax', 'sar r8');
add('bt rax, 3', 'bt rcx, 63', 'bt eax, 31', 'bts rax, 1', 'btr r9, 2', 'btc rbx, 63', 'bt rax, rcx', 'bswap rax', 'bswap r9', 'bswap ecx',
  'bsr rax, rcx', 'bsf r8, r9', 'lzcnt rax, rbx', 'tzcnt rcx, rdx', 'popcnt rax, r15', 'lzcnt eax, ecx');
// stack, control
for (const r of regs64) add(`push ${r}`, `pop ${r}`);
add('push 5', 'push 1000', 'push qword ptr [rax]', 'call rax', 'call r11', 'call qword ptr [rbx + 8]', 'jmp rax', 'jmp qword ptr [rcx]', 'ret', 'ret 8',
  'nop', 'int3', 'ud2', 'leave', 'xchg rax, rbx', 'xchg rcx, qword ptr [rdx]', 'syscall', 'hlt');
for (const cc of ['e', 'ne', 'l', 'le', 'g', 'ge', 'b', 'be', 'a', 'ae', 's', 'ns', 'o', 'no', 'p', 'np']) {
  add(`set${cc} al`, `set${cc} r9b`, `set${cc} sil`, `cmov${cc} rax, rbx`, `cmov${cc} r8, qword ptr [rcx]`, `cmov${cc} eax, edx`);
}
// SSE
for (const op of ['addsd', 'subsd', 'mulsd', 'divsd', 'minsd', 'maxsd', 'sqrtsd', 'addss', 'mulss', 'sqrtss', 'ucomisd', 'comisd', 'ucomiss', 'xorps', 'xorpd', 'andpd', 'cvtss2sd', 'cvtsd2ss']) {
  add(`${op} xmm0, xmm1`, `${op} xmm8, xmm15`, `${op} xmm2, xmm9`);
}
add('addsd xmm0, qword ptr [rax]', 'mulsd xmm3, qword ptr [rsp + 8]', 'ucomisd xmm1, qword ptr [rcx + 8*rdx]', 'movsd xmm0, xmm1', 'movsd xmm8, xmm2', 'movsd xmm0, qword ptr [rbx]',
  'movsd qword ptr [rsp + 16], xmm7', 'movsd qword ptr [r12], xmm9', 'movss xmm0, dword ptr [rax]', 'movss dword ptr [rax], xmm1', 'movaps xmm0, xmm1', 'movaps xmm9, xmm10',
  'movaps xmmword ptr [rsp + 32], xmm6', 'movaps xmm6, xmmword ptr [rsp + 32]', 'movapd xmm1, xmm2', 'movups xmm0, xmmword ptr [rcx]',
  'movq xmm0, rax', 'movq rax, xmm0', 'movq xmm9, r10', 'movq r11, xmm12', 'movq xmm0, xmm1', 'movq xmm0, qword ptr [rax]', 'movq qword ptr [rax], xmm0', 'movd xmm0, eax', 'movd eax, xmm1',
  'cvtsi2sd xmm0, rax', 'cvtsi2sd xmm1, ecx', 'cvtsi2sd xmm9, r8', 'cvtsi2sd xmm0, qword ptr [rbx]', 'cvttsd2si rax, xmm0', 'cvttsd2si ecx, xmm1', 'cvttsd2si r9, xmm10', 'cvtsd2si rax, xmm0',
  'cvtsi2ss xmm0, rax', 'cvttss2si rax, xmm1', 'pxor xmm0, xmm0');

const clang = tool('clang');
if (!clang) { console.log('clang not found: skipping'); process.exit(0); }
const dir = mkdtempSync(join(tmpdir(), 'hla-x64enc-'));
writeFileSync(join(dir, 't.s'), '.intel_syntax noprefix\n.text\n' + lines.join('\n') + '\n');
execFileSync(clang, ['--target=x86_64-pc-windows-msvc', '-c', join(dir, 't.s'), '-o', join(dir, 't.obj')]);
const obj = readFileSync(join(dir, 't.obj'));
const nsec = obj.readUInt16LE(2);
let text: Buffer | null = null;
for (let i = 0; i < nsec; i++) {
  const o = 20 + i * 40;
  if (obj.toString('latin1', o, o + 8).replace(/\0.*$/, '') === '.text') {
    const size = obj.readUInt32LE(o + 16), ptr = obj.readUInt32LE(o + 20);
    text = obj.subarray(ptr, ptr + size);
  }
}
if (!text) throw new Error('no .text');
let pos = 0, bad = 0;
const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
for (const [i, line] of lines.entries()) {
  const m = /^(\S+)\s*(.*)$/.exec(line)!;
  let ours: number[];
  try {
    ours = encodeX(m[1], parseXOperands(m[2], i + 1), i + 1).bytes;
  } catch (e) {
    console.log(`ERROR    ${line.padEnd(44)} ${(e as Error).message}`);
    bad++;
    break;   // instruction boundaries are lost after an error
  }
  const want = text.subarray(pos, pos + ours.length);
  if (hex(ours) !== hex(want)) {
    console.log(`MISMATCH ${line.padEnd(44)} clang=${hex(text.subarray(pos, pos + 15))}… ours=${hex(ours)}`);
    bad++;
    break;
  }
  pos += ours.length;
}
if (!bad && pos !== text.length) { console.log(`length mismatch: ${pos} vs ${text.length}`); bad++; }
console.log(`${bad ? 'stopped at first difference; ' : ''}${lines.length} x86-64 instruction forms${bad ? '' : ' encode identically to clang'}`);
process.exit(bad ? 1 : 0);

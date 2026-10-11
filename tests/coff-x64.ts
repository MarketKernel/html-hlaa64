// Compares the x86-64 assembler + COFF writer with clang on tests/x64/*.s:
// section bytes, relocations and unwind info must agree; our object must link with lld-link.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleX } from '../src/asm/x64/assembler.ts';
import { writeCoffObject } from '../src/asm/coff/object.ts';
import { runPE } from '../src/emu/x64/pe-loader.ts';
import { linkPE } from '../src/asm/coff/pe.ts';
import { tool } from './lib/toolchain.ts';

const clang = tool('clang'), readobj = tool('llvm-readobj'), lld = tool('lld-link'), dlltool = tool('llvm-dlltool');
if (!clang || !readobj) { console.log('clang/llvm-readobj not found: skipping'); process.exit(0); }
const dir = mkdtempSync(join(tmpdir(), 'hla-coff-'));
let fails = 0;
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8' });

// Normalized description of an object: section bytes (with relocated fields blanked),
// relocations resolved to "section+offset" or "external+addend", and unwind info.
function describe(obj: string): { sections: string; relocs: string; unwind: string } {
  const buf = readFileSync(obj);
  const n = buf.readUInt16LE(2), symOff = buf.readUInt32LE(8), nsym = buf.readUInt32LE(12);
  const strOff = symOff + nsym * 18;
  const nameAt = (o: number) => {
    if (buf.readUInt32LE(o) === 0) { const so = strOff + buf.readUInt32LE(o + 4); return buf.toString('latin1', so, buf.indexOf(0, so)); }
    return buf.toString('latin1', o, o + 8).replace(/\0.*$/, '');
  };
  const secNames: string[] = [];
  for (let i = 0; i < n; i++) {
    let nm = buf.toString('latin1', 20 + i * 40, 28 + i * 40).replace(/\0.*$/, '');
    if (nm.startsWith('/')) { const so = strOff + Number(nm.slice(1)); nm = buf.toString('latin1', so, buf.indexOf(0, so)); }
    secNames.push(nm);
  }
  const syms: { name: string; value: number; sect: number }[] = [];
  for (let i = 0; i < nsym; i++) {
    const o = symOff + i * 18;
    syms[i] = { name: nameAt(o), value: buf.readUInt32LE(o + 8), sect: buf.readInt16LE(o + 12) };
    i += buf[o + 17];
  }
  const secs: string[] = [], rels: string[] = [];
  for (let i = 0; i < n; i++) {
    const o = 20 + i * 40;
    const nm = secNames[i];
    if (nm === '.llvm_addrsig') continue;
    const size = buf.readUInt32LE(o + 16), ptr = buf.readUInt32LE(o + 20), rptr = buf.readUInt32LE(o + 24), nrel = buf.readUInt16LE(o + 32);
    const data = ptr ? Buffer.from(buf.subarray(ptr, ptr + size)) : null;
    for (let r = 0; r < nrel; r++) {
      const ro = rptr + r * 10;
      const at = buf.readUInt32LE(ro), si = buf.readUInt32LE(ro + 4), type = buf.readUInt16LE(ro + 8);
      const width = type === 1 ? 8 : 4;
      let addend = data ? (width === 8 ? Number(data.readBigInt64LE(at)) : data.readInt32LE(at)) : 0;
      if (type === 4) addend += 4;   // REL32: normalize to "relative to the field"
      const sy = syms[si];
      const target = sy.sect > 0 ? `${secNames[sy.sect - 1]}+${sy.value + addend}` : `${sy.name}+${addend}`;
      rels.push(`${nm}+0x${at.toString(16)} type=${type} -> ${target}`);
      if (data) data.fill(0, at, at + width);
    }
    const ch = buf.readUInt32LE(o + 36) >>> 0;
    secs.push(`${nm} flags=${ch.toString(16)} ${data ? data.toString('hex') : `zero(${size})`}`);
  }
  const unwind = run(readobj!, ['--unwind', obj]).split('\n').filter((l) => /Version|Flags|Size of prolog|Number of Codes|Frame|Unwind Codes|0x[0-9A-F]+: /.test(l)).map((l) => l.trim()).join('\n');
  return { sections: secs.sort().join('\n'), relocs: rels.sort().join('\n'), unwind };
}

for (const f of readdirSync('tests/x64').filter((x) => x.endsWith('.s'))) {
  const src = readFileSync(join('tests/x64', f), 'utf8');
  const theirs = join(dir, f + '.clang.obj'), ours = join(dir, f + '.ours.obj');
  run(clang, ['--target=x86_64-pc-windows-msvc', '-c', join('tests/x64', f), '-o', theirs]);
  writeFileSync(ours, writeCoffObject(assembleX(src)).bytes);
  const a = describe(theirs), b = describe(ours);
  for (const k of ['sections', 'relocs', 'unwind'] as const) {
    if (a[k] !== b[k]) {
      fails++;
      console.log(`FAIL ${f}: ${k} differ`);
      const al = a[k].split('\n'), bl = b[k].split('\n');
      for (let i = 0; i < Math.max(al.length, bl.length); i++) if (al[i] !== bl[i]) { console.log(`  clang: ${al[i]}\n  ours:  ${bl[i]}`); break; }
    }
  }
  // our own PE linker: run in the emulator, check the structure with llvm-readobj
  {
    const own = linkPE(assembleX(src), { entry: 'main' });
    const exe = join(dir, f + '.own.exe');
    writeFileSync(exe, own.bytes);
    const want = readFileSync(join('tests/x64', f.replace(/\.s$/, '.expected')), 'utf8');
    for (const base of [undefined, 0x7ff612340000]) {
      const r = runPE(own.bytes, { base });
      const got = r.stdout + `exit ${r.exitCode}\n`;
      if (got !== want || r.error) { fails++; console.log(`FAIL own linker ${f}${base ? ' (rebased)' : ''}: ${r.error ?? ''}\n${got}`); }
    }
    const info = run(readobj, ['--file-headers', '--coff-imports', '--coff-basereloc', '--unwind', exe]);
    if (/warning|error|invalid/i.test(info)) { fails++; console.log(`FAIL own linker ${f}: llvm-readobj complains\n${info}`); }
  }
  if (lld && dlltool) {
    writeFileSync(join(dir, 'msvcrt.def'), 'LIBRARY msvcrt.dll\nEXPORTS\nputs\nprintf\nexit\n');
    run(dlltool, ['-m', 'i386:x86-64', '-d', join(dir, 'msvcrt.def'), '-l', join(dir, 'msvcrt.lib')]);
    try {
      run(lld, ['/nologo', '/subsystem:console', '/entry:main', `/out:${join(dir, f + '.exe')}`, ours, join(dir, 'msvcrt.lib')]);
      run(lld, ['/nologo', '/subsystem:console', '/entry:main', `/out:${join(dir, f + '.clang.exe')}`, theirs, join(dir, 'msvcrt.lib')]);
      // both executables must behave the same in the emulator (and match the expected output)
      const expFile = join('tests/x64', f.replace(/\.s$/, '.expected'));
      const want = readFileSync(expFile, 'utf8');
      for (const exe of [f + '.exe', f + '.clang.exe']) {
        for (const base of [undefined, 0x180000000]) {
          const r = runPE(new Uint8Array(readFileSync(join(dir, exe))), { base });
          const got = r.stdout + `exit ${r.exitCode}\n`;
          if (got !== want || r.error) { fails++; console.log(`FAIL ${exe}${base ? ' (rebased)' : ''}: ${r.error ?? ''}\n${got}`); }
        }
      }
    } catch (e) { fails++; console.log(`FAIL ${f}: ${(e as { stdout?: string }).stdout ?? e}`); }
  }
  if (!fails) console.log(`ok   ${f}: sections, relocations and unwind info match clang${lld ? '; links with lld-link; runs in the emulator (also rebased); own PE linker works' : ''}`);
}
console.log(`objects in ${dir}`);
process.exit(fails ? 1 : 0);

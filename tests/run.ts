// Test runner: every examples/*.hla and tests/cases/*.hla that has a matching
// .expected file is translated, built (with clang and/or the built-in
// assembler), executed, and its stdout compared with the expectation.
import { readdirSync, readFileSync, existsSync, writeFileSync, mkdtempSync, chmodSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compile } from '../src/lang/codegen.ts';
import { runMachO } from '../src/emu/macho-loader.ts';

const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
// clang builds and native runs of arm64 Mach-O programs are only possible on macOS
const modes = (only ? only.split(',') : ['clang', 'own', 'emu']).filter((m) => m === 'emu' || process.platform === 'darwin');
const filter = process.argv.slice(2).find((a) => !a.startsWith('--'));
const dir = mkdtempSync(join(tmpdir(), 'hla-test-'));
let pass = 0, fail = 0;

const files = ['examples', 'tests/cases'].flatMap((d) =>
  readdirSync(d).filter((f) => f.endsWith('.hla')).map((f) => join(d, f)));

let assemble: ((asm: string, o: { name: string }) => Uint8Array) | null = null;
if (modes.includes('own') || modes.includes('emu')) {
  try { assemble = (await import('../src/asm/index.ts')).assembleExecutable; } catch (e) { console.log('built-in assembler unavailable:', (e as Error).message); }
}

for (const file of files) {
  if (filter && !file.includes(filter)) continue;
  const expFile = file.replace(/\.hla$/, '.expected');
  if (!existsSync(expFile)) continue;
  const expected = readFileSync(expFile, 'utf8');
  const name = file.replace(/[/\\]/g, '_').replace(/\.hla$/, '');
  let asm: string;
  try {
    asm = compile(readFileSync(file, 'utf8')).asm;
  } catch (e) {
    console.log(`FAIL ${file}: compile error: ${(e as Error).message}`);
    fail++;
    continue;
  }
  for (const mode of modes) {
    const exe = join(dir, `${name}-${mode}`);
    if (mode === 'emu') {
      if (!assemble) continue;
      const t0 = performance.now();
      let r;
      try {
        r = runMachO(assemble(asm, { name }));
      } catch (e) {
        console.log(`FAIL ${file} [emu]: ${(e as Error).message}`);
        fail++;
        continue;
      }
      const ms = (performance.now() - t0).toFixed(0);
      if (r.stdout === expected && r.exitCode === 0 && !r.error) {
        pass++;
        console.log(`ok   ${file} [emu] ${r.steps} instructions, ${ms} ms`);
      } else {
        fail++;
        console.log(`FAIL ${file} [emu]: exit=${r.exitCode} error=${r.error}`);
        const got = r.stdout.split('\n'), want = expected.split('\n');
        for (let i = 0; i < Math.max(got.length, want.length); i++) {
          if (got[i] !== want[i]) { console.log(`  line ${i + 1}:\n    got:  ${got[i]}\n    want: ${want[i]}`); break; }
        }
      }
      continue;
    }
    try {
      if (mode === 'clang') {
        writeFileSync(exe + '.s', asm);
        execFileSync('clang', ['-arch', 'arm64', exe + '.s', '-o', exe], { stdio: 'pipe' });
      } else {
        if (!assemble) continue;
        writeFileSync(exe, assemble(asm, { name }));
        chmodSync(exe, 0o755);
      }
    } catch (e) {
      const err = e as { stderr?: Buffer; message: string };
      console.log(`FAIL ${file} [${mode}]: build error: ${err.stderr?.toString() ?? err.message}`);
      fail++;
      continue;
    }
    const r = spawnSync(exe, [], { encoding: 'utf8', timeout: 10000 });
    if (r.stdout === expected && r.status === 0) {
      pass++;
      console.log(`ok   ${file} [${mode}]`);
    } else {
      fail++;
      console.log(`FAIL ${file} [${mode}]: status=${r.status} signal=${r.signal}`);
      const got = r.stdout.split('\n'), want = expected.split('\n');
      for (let i = 0; i < Math.max(got.length, want.length); i++) {
        if (got[i] !== want[i]) { console.log(`  line ${i + 1}:\n    got:  ${got[i]}\n    want: ${want[i]}`); break; }
      }
    }
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

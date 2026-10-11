// Programs in several files (`include`): tests/include/main.hla on both targets (emulators; on Windows also
// natively), and the locations of errors and warnings in included files.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { combineSources, errorOrigin, type Combined } from '../src/lang/include.ts';
import { CompileError } from '../src/lang/lexer.ts';
import { compile } from '../src/lang/codegen.ts';
import { compileX64 } from '../src/lang/x64/codegen.ts';
import { assembleExecutable } from '../src/asm/index.ts';
import { linkPE } from '../src/asm/coff/pe.ts';
import { assembleX } from '../src/asm/x64/assembler.ts';
import { runMachO } from '../src/emu/macho-loader.ts';
import { runPE } from '../src/emu/x64/pe-loader.ts';

let fails = 0;
const expect = (what: string, got: string, want: string) => {
  if (got === want) { console.log(`ok   ${what}`); return; }
  fails++;
  console.log(`FAIL ${what}\n--- got\n${got}\n--- want\n${want}`);
};

// ---------------------------------------------------------------- the multi-file program
const dir = 'tests/include';
const fromDisk = (f: string) => { try { return readFileSync(join(dir, f), 'utf8'); } catch { return null; } };
const c = combineSources('main.hla', fromDisk);
expect('include order, every file once', c.files.join(' '), 'main.hla util/text.hla geometry.hla');
const want = readFileSync(join(dir, 'main.expected'), 'utf8');
expect('arm64 emulator', runMachO(assembleExecutable(compile(c.text).asm, { name: 'main' })).stdout, want);
const exe = linkPE(assembleX(compileX64(c.text).asm)).bytes;
expect('x64 emulator', runPE(exe).stdout, want);
if (process.platform === 'win32') {
  const path = join(mkdtempSync(join(tmpdir(), 'hla-include-')), 'main.exe');
  writeFileSync(path, exe);
  expect('x64 native', spawnSync(path, [], { encoding: 'utf8' }).stdout.replace(/\r\n/g, '\n'), want);
}

// ---------------------------------------------------------------- locations in the original files
const project: Record<string, string> = {
  'main.hla': 'include "lib/a.hla"\nfn main() {\n    helper()\n}\n',
  'lib/a.hla': '// a\ninclude "b.hla"\nfn helper() {\n    let x = 1 +\n}\n',
  'lib/b.hla': 'const B = 1\n',
};
const read = (f: string) => project[f] ?? null;
const located = (files: Record<string, string>): string => {
  let comb: Combined | null = null;
  try {
    comb = combineSources('main.hla', (f) => files[f] ?? null);
    compileX64(comb.text);
    return 'no error';
  } catch (e) {
    if (!(e instanceof CompileError)) throw e;
    const o = errorOrigin(e, comb, 'main.hla');
    return `${o.file}:${o.line} ${(comb?.lineText(o) ?? (e as { source?: string }).source)?.trim() ?? ''}`;
  }
};
expect('error in an included file', located(project), 'lib/a.hla:5 }');
expect('missing include', located({ ...project, 'lib/a.hla': 'include "nope.hla"\n' }), 'lib/a.hla:1 include "nope.hla"');
const cw = combineSources('main.hla', read);
const nested = combineSources('main.hla', (f) => ({ ...project, 'lib/a.hla': 'include "b.hla"\nfn helper() { }\n' })[f] ?? null);
expect('nested path resolution', nested.files.join(' '), 'main.hla lib/a.hla lib/b.hla');
expect('warning location', cw.warning(`line ${cw.text.split('\n').indexOf('fn helper() {') + 1}: something`), 'lib/a.hla:3: something');

console.log(fails ? `include: ${fails} failure(s)` : 'include: all ok');
process.exit(fails ? 1 : 0);

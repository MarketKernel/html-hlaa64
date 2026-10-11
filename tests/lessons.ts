// Checks every complete program in docs/lessons/*.md and its Russian copy docs/ru/lessons/*.md.
// A program is an ```hla block that contains `fn main`; if the next block is
// ```text, it is the expected output. With --update the text blocks are
// (re)written from the actual output of the emulator.
//   node tests/lessons.ts            check
//   node tests/lessons.ts --update   fill in outputs
//   node tests/lessons.ts --native   also build with the built-in assembler and run on macOS
// Lesson directories with a build.sh (lessons that need clang, e.g. C interop) are built in a
// temporary copy and their stdout compared with expected.txt; code blocks tagged ```lang file=NAME
// must match the file NAME in that directory exactly.
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, chmodSync, statSync, cpSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { compile } from '../src/lang/codegen.ts';
import { assembleExecutable } from '../src/asm/index.ts';
import { runMachO } from '../src/emu/macho-loader.ts';

const update = process.argv.includes('--update');
const native = process.argv.includes('--native') && process.platform === 'darwin';
const dir = 'docs/lessons';
const dirs = [dir, 'docs/ru/lessons'];
const tmp = mkdtempSync(join(tmpdir(), 'hla-lessons-'));
let programs = 0, failures = 0, n = 0;

for (const d of dirs)
for (const file of readdirSync(d).filter((f) => f.endsWith('.md')).sort()) {
  const path = join(d, file);
  const md = readFileSync(path, 'utf8');
  const re = /```hla\n([\s\S]*?)```(\n*)(```text\n([\s\S]*?)```)?/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    const code = m[1];
    if (!/\bfn main\b/.test(code)) continue;
    programs++;
    const line = md.slice(0, m.index).split('\n').length;
    const where = `${path}:${line}`;
    let got: string;
    try {
      const bin = assembleExecutable(compile(code).asm, { name: 'lesson' });
      const r = runMachO(bin, { limit: 50_000_000 });
      if (r.error) throw new Error('runtime: ' + r.error);
      got = r.stdout;
      if (native) {
        const exe = join(tmp, `p${n++}`);
        writeFileSync(exe, bin);
        chmodSync(exe, 0o755);
        const nr = spawnSync(exe, [], { encoding: 'utf8' });
        if (nr.stdout !== got) { failures++; console.log(`FAIL ${where}: native output differs from the emulator`); }
      }
    } catch (e) {
      failures++;
      console.log(`FAIL ${where}: ${(e as Error).message.split('\n')[0]}`);
      continue;
    }
    if (update) {
      const block = '```text\n' + (got.endsWith('\n') || got === '' ? got : got + '\n') + '```';
      out += md.slice(last, m.index) + '```hla\n' + code + '```\n\n' + block;
      last = m.index + m[0].length;
    } else if (m[3] === undefined) {
      failures++;
      console.log(`FAIL ${where}: no \`\`\`text output block after the program`);
    } else if (m[4] !== (got.endsWith('\n') || got === '' ? got : got + '\n')) {
      failures++;
      console.log(`FAIL ${where}: output differs\n--- expected\n${m[4]}--- got\n${got}`);
    }
  }
  if (update) writeFileSync(path, out + md.slice(last));
}
// ------------------------------------------------------------------ lesson directories
const allMd = dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.md')).map((f) => readFileSync(join(d, f), 'utf8'))).join('\n');
let builds = 0;
for (const sub of readdirSync(dir)) {
  const d = join(dir, sub);
  if (!statSync(d).isDirectory() || !existsSync(join(d, 'build.sh'))) continue;
  if (process.platform !== 'darwin') { console.log(`skip ${d}: needs macOS (clang, arm64)`); continue; }
  builds++;
  const work = mkdtempSync(join(tmpdir(), `hla-${sub}-`));
  cpSync(d, work, { recursive: true });
  const r = spawnSync('sh', ['build.sh'], {
    cwd: work, encoding: 'utf8', env: { ...process.env, HLA: `node ${resolve('src/cli.ts')}` },
  });
  // tagged code blocks must match the files (sources and generated ones, after the build)
  for (const m of allMd.matchAll(/```\w+ file=([\w.-]+)\n([\s\S]*?)```/g)) {
    const f = join(work, m[1]);
    if (!existsSync(f)) { failures++; console.log(`FAIL ${m[1]}: no such file in ${d} after build.sh`); continue; }
    if (readFileSync(f, 'utf8') !== m[2]) { failures++; console.log(`FAIL ${m[1]}: the code block in the lesson differs from the file`); }
  }
  const expected = readFileSync(join(d, 'expected.txt'), 'utf8');
  if (r.status !== 0 || r.stdout !== expected) {
    failures++;
    console.log(`FAIL ${d}/build.sh: status ${r.status}\n${r.stderr}\n--- expected\n${expected}--- got\n${r.stdout}`);
  }
}

console.log(`${programs} lesson programs, ${builds} lesson builds, ${failures} failures${update ? ' (outputs updated)' : ''}`);
process.exit(failures ? 1 : 0);

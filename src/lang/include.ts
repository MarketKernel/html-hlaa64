// Several source files: `include "util.hla"` puts the text of another file in place of the line, like C's
// #include, but every file is included once (a second include of the same file, and include cycles, are
// skipped). The result is one program text plus a map from its lines back to the files they came from,
// so errors and warnings name the right file and line.
//   include "util.hla"           // relative to the including file
//   include "lib/strings.hla"    // forward slashes, also on Windows
//   include "std/file.hla"       // built in (src/lang/stdlib.ts) unless the project has its own
import { CompileError } from './lexer.ts';
import { STD_FILES } from './stdlib.ts';

/** A file of a project: its normalized path ('main.hla', 'lib/util.hla') and its text, or null when missing. */
export type ReadFile = (path: string) => string | null;

export interface Origin { file: string; line: number }

export interface Combined {
  text: string;               // the program the compiler sees
  files: string[];            // the files used, in include order (the main file first)
  origin(line: number): Origin;               // 1-based line of `text` -> file and 1-based line there
  /** error/warning location in the original files: "util.hla:12:5" */
  where(line: number, col?: number): string;
  /** a warning text with its leading "line N:" turned into "file:N:" */
  warning(w: string): string;
  /** the text of an original line (for the caret under an error) */
  lineText(o: Origin): string | undefined;
}

const INCLUDE = /^\s*include\s+"([^"]*)"\s*(?:\/\/.*)?$/;

/** 'a/b/../c.hla' -> 'a/c.hla'; backslashes become slashes */
export function normalizePath(p: string): string {
  const out: string[] = [];
  for (const part of p.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(part);   // '..' above the main file's directory stays (the CLI can read there)
  }
  return out.join('/');
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');

/** Combine `main` and everything it includes into one program. Throws CompileError (with the
 *  location already in the message's origin) when an included file is missing. */
export function combineSources(main: string, read: ReadFile): Combined {
  const lines: string[] = [];
  const origins: Origin[] = [];
  const texts = new Map<string, string[]>();
  const seen = new Set<string>();
  const files: string[] = [];

  const load = (p: string): string | null => read(p) ?? STD_FILES[p] ?? null;
  const visit = (path: string, from: Origin | null) => {
    if (seen.has(path)) return;
    const raw = load(path);
    if (raw === null) {
      const err = new CompileError(`cannot find included file '${path}'`, from?.line ?? 1, 1);
      Object.assign(err, { file: from?.file ?? path, source: from ? texts.get(from.file)?.[from.line - 1] : undefined });
      throw err;
    }
    seen.add(path);
    files.push(path);
    const own = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).split(/\r?\n/);
    texts.set(path, own);
    own.forEach((l, i) => {
      const m = INCLUDE.exec(l);
      if (m) {
        lines.push('');                 // the include line itself becomes empty; every line keeps its origin
        origins.push({ file: path, line: i + 1 });
        // relative to the including file; "std/..." falls back to the files built into the translator
        let target = normalizePath(dirOf(path) + m[1]);
        if (load(target) === null && STD_FILES[normalizePath(m[1])] !== undefined) target = normalizePath(m[1]);
        visit(target, { file: path, line: i + 1 });
      } else {
        lines.push(l);
        origins.push({ file: path, line: i + 1 });
      }
    });
  };
  visit(normalizePath(main), null);

  const origin = (line: number): Origin => origins[line - 1] ?? { file: files[0], line };
  return {
    text: lines.join('\n'),
    files,
    origin,
    where: (line, col) => { const o = origin(line); return `${o.file}:${o.line}${col ? ':' + col : ''}`; },
    warning: (w) => w.replace(/^line (\d+)/, (_, n) => origin(Number(n)).file + ':' + origin(Number(n)).line),
    lineText: (o) => texts.get(o.file)?.[o.line - 1],
  };
}

/** Position of a CompileError thrown by combineSources itself (a missing file) or by the compiler. */
export function errorOrigin(e: CompileError, c: Combined | null, main: string): Origin {
  const own = (e as CompileError & { file?: string }).file;
  if (own) return { file: own, line: e.line };
  return c ? c.origin(e.line) : { file: main, line: e.line };
}

// Files for programs in the emulators: fopen/fread/fwrite/fseek/ftell/fclose of both C runtimes are
// served from a FileTable over an EmuFiles store, which decides where the files live: the disk (CLI),
// a Map (tests) or the files of a project (the web page). A file's data is kept in memory while it is
// open and handed to the store on fclose (and for files still open when the program ends, like exit()).

export interface EmuFiles {
  /** the bytes of a file, or null when it does not exist */
  read(path: string): Uint8Array | null;
  /** create or replace a file */
  write(path: string, data: Uint8Array): void;
}

/** files in a Map: for tests, and for the web page (a project's files; `written` collects what the program
 *  wrote). Paths are taken like project paths: "./a.txt" and "a.txt" are the same file, "\" is "/". */
export function memoryFiles(init: Record<string, string | Uint8Array> = {}): EmuFiles & { files: Map<string, Uint8Array>; written: Set<string> } {
  const key = (p: string) => p.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  const files = new Map<string, Uint8Array>();
  const written = new Set<string>();
  for (const [k, v] of Object.entries(init)) files.set(key(k), typeof v === 'string' ? new TextEncoder().encode(v) : v);
  return { files, written, read: (p) => files.get(key(p)) ?? null, write: (p, d) => { files.set(key(p), d); written.add(key(p)); } };
}

/** what a program wrote, as text (the web page keeps project files as text) */
export function writtenText(m: ReturnType<typeof memoryFiles>): Record<string, string> {
  const dec = new TextDecoder();
  return Object.fromEntries([...m.written].map((p) => [p, dec.decode(m.files.get(p))]));
}

interface Open { path: string; data: Uint8Array; size: number; pos: number; read: boolean; write: boolean; append: boolean; dirty: boolean; eof: boolean }

export class FileTable {
  private open = new Map<number, Open>();
  private next: number;
  private fs: EmuFiles | undefined;

  /** handles are fake FILE* values from `base` on (16 bytes apart; programs never look inside) */
  constructor(fs: EmuFiles | undefined, base: number) { this.fs = fs; this.next = base; }

  has(h: number): boolean { return this.open.has(h); }

  /** fopen: 0 when the file cannot be opened (or there is no file store) */
  fopen(path: string, mode: string): number {
    if (!this.fs || !path) return 0;
    const m = mode.replace(/[bt]/g, '');
    const plus = m.includes('+');
    let data: Uint8Array;
    if (m[0] === 'r') {
      const d = this.fs.read(path);
      if (!d) return 0;
      data = d.slice();
    } else if (m[0] === 'w') data = new Uint8Array(0);
    else if (m[0] === 'a') data = this.fs.read(path)?.slice() ?? new Uint8Array(0);
    else return 0;
    const f: Open = {
      path, data, size: data.length, pos: m[0] === 'a' ? data.length : 0,
      read: m[0] === 'r' || plus, write: m[0] !== 'r' || plus, append: m[0] === 'a', dirty: m[0] !== 'r', eof: false,
    };
    const h = (this.next += 16);
    this.open.set(h, f);
    return h;
  }

  fread(h: number, n: number): Uint8Array | null {
    const f = this.open.get(h);
    if (!f || !f.read) return null;
    const got = f.data.subarray(f.pos, Math.min(f.size, f.pos + n));
    f.pos += got.length;
    if (got.length < n) f.eof = true;
    return got.slice();
  }

  fwrite(h: number, bytes: Uint8Array): number {
    const f = this.open.get(h);
    if (!f || !f.write) return 0;
    if (f.append) f.pos = f.size;
    const end = f.pos + bytes.length;
    if (end > f.data.length) {
      const grown = new Uint8Array(Math.max(end, f.data.length * 2, 256));
      grown.set(f.data.subarray(0, f.size));
      f.data = grown;
    }
    f.data.set(bytes, f.pos);
    f.pos = end;
    f.size = Math.max(f.size, end);
    f.dirty = true;
    return bytes.length;
  }

  /** whence: 0 SEEK_SET, 1 SEEK_CUR, 2 SEEK_END; 0 on success, -1 on error */
  fseek(h: number, off: number, whence: number): number {
    const f = this.open.get(h);
    if (!f) return -1;
    const p = (whence === 0 ? 0 : whence === 1 ? f.pos : f.size) + off;
    if (p < 0 || whence < 0 || whence > 2) return -1;
    f.pos = p;
    f.eof = false;
    return 0;
  }

  ftell(h: number): number { return this.open.get(h)?.pos ?? -1; }

  feof(h: number): boolean { return this.open.get(h)?.eof ?? false; }

  /** fclose: 0, or -1 for an unknown handle */
  fclose(h: number): number {
    const f = this.open.get(h);
    if (!f) return -1;
    this.flush(f);
    this.open.delete(h);
    return 0;
  }

  /** the program ended: like exit(), write what is still open */
  closeAll(): void {
    for (const f of this.open.values()) this.flush(f);
    this.open.clear();
  }

  private flush(f: Open): void {
    if (f.dirty && this.fs) this.fs.write(f.path, f.data.slice(0, f.size));
    f.dirty = false;
  }
}

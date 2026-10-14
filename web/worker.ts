// Web Worker: runs a Mach-O image in the ARM64 emulator, a PE or ELF image in the x64 emulator or a
// WebAssembly module natively (with the JavaScript runtime as its system), streaming its output. The program sees the project's files and its command line arguments; the files
// it writes come back in `written` (text) and `binary`.
import { runMachO } from '../src/emu/macho-loader.ts';
import { runPE } from '../src/emu/x64/pe-loader.ts';
import { runElf } from '../src/emu/x64/elf-loader.ts';
import { runWasm } from '../src/wasm/runtime.ts';
import { memoryFiles, writtenFiles } from '../src/emu/files.ts';

self.onmessage = (ev: MessageEvent<{ bytes: ArrayBuffer; limit: number; format?: 'macho' | 'pe' | 'elf' | 'wasm'; name?: string; files?: Record<string, string>; args?: string[] }>) => {
  let buf = '';
  let last = performance.now();
  const flush = () => { if (buf) { postMessage({ type: 'out', text: buf }); buf = ''; } last = performance.now(); };
  const t0 = performance.now();
  const files = memoryFiles(ev.data.files ?? {});
  const done = (r: { exitCode: number | null; steps: number; error: string | null }) => {
    flush();
    const w = writtenFiles(files);
    const binary = Object.values(w.binary).map((d) => d.slice());
    postMessage({ type: 'done', ...r, ms: performance.now() - t0, written: w.text, binary: Object.fromEntries(Object.keys(w.binary).map((k, i) => [k, binary[i]])) },
      { transfer: binary.map((d) => d.buffer) });
  };
  try {
    const opts = {
      limit: ev.data.limit,
      files,
      args: ev.data.args ?? [],
      onOutput: (t: string) => { buf += t; if (buf.length > 4096 || performance.now() - last > 40) flush(); },
    };
    const bytes = new Uint8Array(ev.data.bytes);
    const r = ev.data.format === 'wasm' ? runWasm(bytes, { ...opts, name: ev.data.name }) : ev.data.format === 'pe' ? runPE(bytes, opts)
      : ev.data.format === 'elf' ? runElf(bytes, opts) : runMachO(bytes, opts);
    done({ exitCode: r.exitCode, steps: r.steps, error: r.error });
  } catch (e) {
    done({ exitCode: null, steps: 0, error: (e as Error).message });
  }
};

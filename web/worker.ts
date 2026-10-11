// Web Worker: runs a Mach-O image in the ARM64 emulator or a PE image in the x64 emulator,
// streaming its output.
import { runMachO } from '../src/emu/macho-loader.ts';
import { runPE } from '../src/emu/x64/pe-loader.ts';

self.onmessage = (ev: MessageEvent<{ bytes: ArrayBuffer; limit: number; format?: 'macho' | 'pe' }>) => {
  let buf = '';
  let last = performance.now();
  const flush = () => { if (buf) { postMessage({ type: 'out', text: buf }); buf = ''; } last = performance.now(); };
  const t0 = performance.now();
  try {
    const opts = {
      limit: ev.data.limit,
      onOutput: (t: string) => { buf += t; if (buf.length > 4096 || performance.now() - last > 40) flush(); },
    };
    const bytes = new Uint8Array(ev.data.bytes);
    const r = ev.data.format === 'pe' ? runPE(bytes, opts) : runMachO(bytes, opts);
    flush();
    postMessage({ type: 'done', exitCode: r.exitCode, steps: r.steps, error: r.error, ms: performance.now() - t0 });
  } catch (e) {
    flush();
    postMessage({ type: 'done', exitCode: null, steps: 0, error: (e as Error).message, ms: performance.now() - t0 });
  }
};

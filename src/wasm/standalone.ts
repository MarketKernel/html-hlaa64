// Entry of the runtime bundle that ships with a downloaded program (the page and run.mjs):
// esbuild turns it into one script that defines the global HLA.
export { runWasm, runWasmAsync } from './runtime.ts';
export { memoryFiles, writtenFiles } from '../emu/files.ts';

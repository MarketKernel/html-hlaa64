// The runtime as one script (var HLA = …) for the files that come with a program: built with esbuild,
// which is a development dependency (the web build and the CLI run where node_modules is installed).
import { fileURLToPath } from 'node:url';

export async function runtimeSource(): Promise<string> {
  const { build } = await import('esbuild');
  const r = await build({
    entryPoints: [fileURLToPath(new URL('./standalone.ts', import.meta.url))],
    bundle: true, write: false, minify: true, format: 'iife', globalName: 'HLA', target: 'es2022', legalComments: 'none',
  });
  return r.outputFiles[0].text;
}

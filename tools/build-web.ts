// Bundles the workbench into one self-contained HTML file (works offline from file://).
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const common = { bundle: true, write: false, minify: true, target: 'es2022', loader: { '.hla': 'text' as const, '.c': 'text' as const }, legalComments: 'none' as const };

const worker = await build({ ...common, entryPoints: ['web/worker.ts'], format: 'iife' });
const workerSrc = worker.outputFiles![0].text;

async function bundle(artifact: boolean): Promise<string> {
  const app = await build({
    ...common,
    entryPoints: ['web/main.ts'],
    format: 'iife',
    define: { __WORKER_SRC__: JSON.stringify(workerSrc), __ARTIFACT__: String(artifact) },
  });
  return app.outputFiles![0].text.replace(/<\/script/gi, '<\\/script');
}

const template = readFileSync('web/template.html', 'utf8');
const mainJs = await bundle(false);
const html = template.replace('/*__APP__*/', () => mainJs);
mkdirSync('dist', { recursive: true });
writeFileSync('dist/hla64.html', html);
console.log(`dist/hla64.html: ${(html.length / 1024).toFixed(0)} KB (worker ${(workerSrc.length / 1024).toFixed(0)} KB)`);

// optional: a variant for hosted artifact viewers (no document wrapper, no download button)
const ai = process.argv.indexOf('--artifact');
if (ai > 0) {
  const js = await bundle(true);
  const head = /<title>[\s\S]*?<\/style>/.exec(template)![0];
  const body = /<body>([\s\S]*)<\/body>/.exec(template)![1].replace('/*__APP__*/', () => js);
  writeFileSync(process.argv[ai + 1], head + '\n' + body);
  console.log(`${process.argv[ai + 1]}: artifact variant`);
}

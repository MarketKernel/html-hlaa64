// Bundles the workbench into one self-contained HTML file (works offline from file://),
// and next to it dist/pages/: the same page as an installable PWA for GitHub Pages.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

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

const icon = readFileSync('assets/icon.svg', 'utf8').trim();
const favicon = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${Buffer.from(icon).toString('base64')}">`;
const template = readFileSync('web/template.html', 'utf8').replace('</head>', () => `${favicon}\n</head>`);
const mainJs = await bundle(false);
const html = template.replace('/*__APP__*/', () => mainJs);
mkdirSync('dist', { recursive: true });
writeFileSync('dist/hla64.html', html);
console.log(`dist/hla64.html: ${(html.length / 1024).toFixed(0)} KB (worker ${(workerSrc.length / 1024).toFixed(0)} KB)`);

// dist/pages/: the page plus a manifest, icons and a service worker. Every path is relative,
// so it works under a project site's /<repo>/ prefix.
const PWA_ICONS = ['pwa/icon-192.png', 'pwa/icon-512.png', 'pwa/icon-maskable-512.png', 'pwa/apple-touch-icon.png'];
const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const pwaHead = [
  '<link rel="manifest" href="manifest.webmanifest">',
  '<link rel="apple-touch-icon" href="apple-touch-icon.png">',
  '<meta name="theme-color" content="#eef1f4" media="(prefers-color-scheme: light)">',
  '<meta name="theme-color" content="#0d1217" media="(prefers-color-scheme: dark)">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-title" content="HLA64">',
].join('\n');
const register = `<script>if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));</script>`;
const page = html.replace('</head>', () => `${pwaHead}\n</head>`).replace('</body>', () => `${register}\n</body>`);
// a deploy between two releases changes the page, not the version: the hash tells them apart
const cache = `${version}-${createHash('sha256').update(page).digest('hex').slice(0, 12)}`;
const manifest = {
  name: 'HLA64 Workbench',
  short_name: 'HLA64',
  description: 'HLA64 translator, ARM64/x64 assembler, linker and emulator that run offline in the browser',
  id: './',
  start_url: './',
  scope: './',
  display: 'standalone',
  background_color: '#eef1f4',
  theme_color: '#15202b',
  icons: [
    { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};
rmSync('dist/pages', { recursive: true, force: true });
mkdirSync('dist/pages', { recursive: true });
writeFileSync('dist/pages/index.html', page);
// the single file too, to download from the site
writeFileSync('dist/pages/hla64.html', html);
writeFileSync('dist/pages/sw.js', readFileSync('web/sw.js', 'utf8').replaceAll('__CACHE__', cache));
writeFileSync('dist/pages/manifest.webmanifest', JSON.stringify(manifest, null, 2) + '\n');
// without it Pages runs the files through Jekyll, which is only wasted time here
writeFileSync('dist/pages/.nojekyll', '');
copyFileSync('assets/icon.svg', 'dist/pages/icon.svg');
for (const path of PWA_ICONS) copyFileSync(`assets/${path}`, `dist/pages/${path.slice(4)}`);
console.log(`dist/pages/: PWA for GitHub Pages (cache ${cache})`);

// optional: a variant for hosted artifact viewers (no document wrapper, no download button)
const ai = process.argv.indexOf('--artifact');
if (ai > 0) {
  const js = await bundle(true);
  const head = /<title>[\s\S]*?<\/style>/.exec(template)![0];
  const body = /<body>([\s\S]*)<\/body>/.exec(template)![1].replace('/*__APP__*/', () => js);
  writeFileSync(process.argv[ai + 1], head + '\n' + body);
  console.log(`${process.argv[ai + 1]}: artifact variant`);
}

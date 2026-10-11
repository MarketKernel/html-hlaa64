// Service worker of the GitHub Pages build (dist/pages/): keeps the workbench working offline.
// tools/build-web.ts writes the version and a hash of the page into CACHE, so every deploy
// changes this file and the browser installs the new worker, which drops the old caches.
const CACHE = 'hla64-__CACHE__';
const FONTS = 'hla64-fonts';
const SHELL = ['./', 'hla64.html', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  // past the HTTP cache: Pages may still serve the previous deploy for a few minutes
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('hla64-') && k !== CACHE && k !== FONTS).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // the page: the network first, so an online visit gets the latest deploy; the cache when offline
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request, { cache: 'no-cache' })
      .then((response) => {
        if (response.ok && url.origin === location.origin && !url.pathname.endsWith('/hla64.html')) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('./', copy));
        }
        return response;
      })
      .catch(() => caches.open(CACHE).then((cache) => cache.match(url.pathname.endsWith('/hla64.html') ? 'hla64.html' : './')))
      .then((response) => response ?? Response.error()));
    return;
  }
  // Google Fonts (the page's stylesheet and the font files): kept after the first visit
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(caches.open(FONTS).then((cache) => cache.match(request).then((hit) => hit ?? fetch(request).then((response) => {
      if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
      return response;
    }))));
    return;
  }
  if (url.origin === location.origin) {
    event.respondWith(caches.open(CACHE).then((cache) => cache.match(request, { ignoreSearch: true })).then((hit) => hit ?? fetch(request)));
  }
});

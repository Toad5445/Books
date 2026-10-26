// Offline support: the app shell and libraries are cached so the app opens
// (and downloaded books play) without a connection. GitHub API calls are never cached.
const VERSION = 'books-v5';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/main.js', 'js/ui.js', 'js/icons.js', 'js/db.js', 'js/settings.js', 'js/voices.js', 'js/github.js',
  'js/library.js', 'js/pc.js', 'js/ambient.js', 'js/views/ambient-sheet.js', 'sounds/index.json', 'js/bookinfo.js', 'js/preview.js', 'js/preview-worker.js',
  'js/views/shelf.js', 'js/views/add.js', 'js/views/voice-picker.js', 'js/views/book-sheet.js',
  'js/views/settings.js', 'js/views/player.js', 'js/views/text-reader.js', 'js/views/pdf-reader.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];
const CDN = ['https://cdn.jsdelivr.net/'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('books-') && k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (CDN.some((p) => req.url.startsWith(p))) {
    // Versioned library files never change: cache first.
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  if (url.origin !== location.origin) return;
  if (req.headers.has('range')) return; // streamed music: straight from the network
  // App files: answer from cache straight away, refresh it in the background.
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const hit = await cache.match(req, { ignoreSearch: true });
    const fresh = fetch(req).then((res) => { if (res.status === 200) cache.put(req, res.clone()); return res; }).catch(() => null);
    return hit || (await fresh) || cache.match('index.html');
  }));
});

// Only these small application files enter Cache Storage. Never gallery bytes.
const CACHE = 'gallery-offline-shell-v7';
const SHELL = ['./', './index.html', './style.css', './app.js', './worker.js', './storage.js', './manifest.webmanifest', './icon.svg'];
const urls = new Set(SHELL.map(p => new URL(p, self.registration.scope).href));
self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
    // No skipWaiting: an update must not replace a worker during a download.
});
self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        for (const key of await caches.keys()) {
            if (key.startsWith('gallery-offline-shell-') && key !== CACHE) await caches.delete(key);
        }
        await self.clients.claim();
    })());
});
self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);
    url.hash = '';
    // Real document navigation for bfcache, with a narrowly scoped offline shell
    // fallback for our library/reader query URLs only. Never match other paths.
    if (event.request.mode === 'navigate' && url.origin === new URL(self.registration.scope).origin && url.pathname === '/') url.search = '';
    // No broad navigation fallback and no interception of /offline-api or media.
    if (!urls.has(url.href)) return;
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(url.href)) || fetch(event.request)));
});

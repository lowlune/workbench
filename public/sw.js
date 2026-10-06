const CACHE = 'workbench-shell-v6';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (event.request.method !== 'GET') return;
  const network = fetch(event.request);
  event.waitUntil(network.then((response) => caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()))).catch(() => {}));
  event.respondWith(network.catch(async () => (await caches.match(event.request)) || Response.error()));
});

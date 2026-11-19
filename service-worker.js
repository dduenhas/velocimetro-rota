const CACHE = 'rota-shell-v7';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './vehicles.js',
  './receipt.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
  './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/layers-2x.png'
];

async function storeAsset(cache, asset) {
  const response = await fetch(new Request(asset, { cache: 'reload', redirect: 'follow' }));
  if (!response.ok) throw new Error('Falha ao cachear ' + asset);
  const headers = new Headers(response.headers);
  const body = await response.arrayBuffer();
  await cache.put(asset, new Response(body, {
    status: 200,
    statusText: 'OK',
    headers: headers
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(ASSETS.map((asset) => storeAsset(cache, asset)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then((windowClients) => Promise.all(windowClients.map((client) => {
        if (!client.navigate) return null;
        return client.navigate(client.url).catch(() => null);
      })))
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.cache === 'reload' || event.request.cache === 'no-store') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;

  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        if (response && response.ok) {
          const cache = await caches.open(CACHE);
          await cache.put(event.request, response.clone());
          await cache.put('./index.html', response.clone());
        }
        return response;
      } catch (error) {
        return (await caches.match(event.request))
          || (await caches.match('./index.html'))
          || (await caches.match('./'));
      }
    })());
    return;
  }

  event.respondWith(
    caches.match(event.request).then((hit) => {
      if (hit) return hit;
      return fetch(event.request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});

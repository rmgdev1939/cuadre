/* Cuadre — Service Worker
 * Precachea el "app shell" y lo sirve cache-first para que la app funcione sin conexión.
 * Al cambiar cualquier archivo del shell, sube CACHE_VERSION para forzar la actualización.
 */
const CACHE_VERSION = 'v10';
const CACHE_NAME = `cuadre-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './pagomovil.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // cache: 'reload' evita guardar copias viejas que estén en la caché HTTP del navegador.
      .then((cache) => cache.addAll(PRECACHE_URLS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('cuadre-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request, { ignoreSearch: request.mode === 'navigate' }).then((cached) => {
      if (cached) return cached;

      return fetch(request)
        .then((response) => {
          // Guarda en caché las respuestas válidas que no estaban precacheadas.
          if (response && response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => {
          // Sin conexión: cualquier navegación vuelve a la página principal. Se redirige
          // (en vez de servir index.html en la ruta pedida) para que sus rutas relativas resuelvan bien.
          if (request.mode === 'navigate') return Response.redirect(self.registration.scope, 302);
          return Response.error();
        });
    })
  );
});

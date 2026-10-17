// Сервис-воркер «Замер Про»: приложение открывается из памяти телефона мгновенно,
// даже без интернета или при плохой связи; обновления скачиваются в фоне.

const CACHE = 'zamershik-v11';

// Файлы приложения, которые сохраняются в телефон при установке
const PRECACHE_LIST = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/editor.js',
  './js/db.js',
  './js/geom.js',
  './js/pdf.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // cache: 'reload' — берём свежие файлы с сервера, а не из кэша браузера
      .then((cache) => cache.addAll(PRECACHE_LIST.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

// Скачать свежую версию файла и положить в кэш (в фоне)
function refresh(request) {
  return fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return response;
  });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || !request.url.startsWith(self.location.origin)) return;

  // Открытие приложения: сразу страница из памяти, без ожидания сети
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then((cached) => {
        const fresh = refresh(request).catch(() => cached);
        return cached || fresh;
      }),
    );
    return;
  }

  // Остальные файлы: из памяти, если есть; в фоне — обновление
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      const fresh = refresh(request).catch(() => cached || new Response('', { status: 503 }));
      if (cached) {
        event.waitUntil(fresh.catch(() => {}));
        return cached;
      }
      return fresh;
    }),
  );
});

// Сервис-воркер для приложения «Замер Про»
// Обеспечивает работу приложения в офлайн режиме

const CACHE = 'zamershik-v10';

// Список файлов для кэширования при установке
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
  './icons/icon-maskable-512.png'
];

// Событие установки воркера
self.addEventListener('install', event => {
  console.log('[SW] Установка сервис-воркера');
  event.waitUntil(
    caches.open(CACHE).then(cache => {
      console.log('[SW] Кэширование ресурсов');
      return cache.addAll(PRECACHE_LIST);
    }).then(() => {
      // Сразу активировать новый воркер
      return self.skipWaiting();
    })
  );
});

// Событие активации воркера
self.addEventListener('activate', event => {
  console.log('[SW] Активация сервис-воркера');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          // Удаляем старые версии кэша
          if (cacheName !== CACHE) {
            console.log('[SW] Удаление устаревшего кэша:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      // Берём контроль над всеми открытыми клиентами
      return self.clients.claim();
    })
  );
});

// Событие получения запроса (fetch)
self.addEventListener('fetch', event => {
  const { request } = event;

  // Обрабатываем только GET запросы и только к своему источнику
  if (request.method !== 'GET' || !request.url.startsWith(self.location.origin)) {
    return;
  }

  // Стратегия: сначала сеть, потом кэш
  event.respondWith(
    fetch(request).then(response => {
      // Кэшируем успешные ответы
      if (response.status === 200) {
        const responseToCache = response.clone();
        caches.open(CACHE).then(cache => {
          cache.put(request, responseToCache);
        });
      }
      return response;
    }).catch(() => {
      // Если нет интернета, пробуем кэш
      return caches.match(request, { ignoreSearch: true }).then(cachedResponse => {
        if (cachedResponse) {
          return cachedResponse;
        }

        // Если это навигационный запрос (страница), возвращаем index.html
        if (request.mode === 'navigate') {
          return caches.match('./index.html');
        }

        // Иначе возвращаем ошибку (дальше браузер покажет свою страницу ошибки)
        return new Response('Ресурс недоступен', {
          status: 503,
          statusText: 'Service Unavailable'
        });
      });
    })
  );
});

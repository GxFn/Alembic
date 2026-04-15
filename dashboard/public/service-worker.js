/**
 * Service Worker - 处理离线支持和缓存策略
 * 将此文件放在 public 目录：public/service-worker.js
 */

const CACHE_NAME = 'alembic-v1';
const DYNAMIC_CACHE = 'alembic-dynamic-v1';
const ASSETS_TO_CACHE = [
  '/', // HTML 页面
  '/index.html',
  '/manifest.json',
  '/favicon.ico',
];

// 安装事件 - 缓存关键资源
self.addEventListener('install', (event) => {
  console.log('[Service Worker] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Caching app shell');
      return cache.addAll(ASSETS_TO_CACHE).catch((error) => {
        console.log('[Service Worker] Error caching assets:', error);
        // 不要在安装失败时抛出错误
      });
    })
  );
  self.skipWaiting();
});

// 激活事件 - 清理旧缓存
self.addEventListener('activate', (event) => {
  console.log('[Service Worker] Activating...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((cacheName) => cacheName !== CACHE_NAME && cacheName !== DYNAMIC_CACHE)
          .map((cacheName) => {
            console.log('[Service Worker] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          })
      );
    })
  );
  self.clients.claim();
});

// 获取事件 - 网络优先，降级到缓存
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // 忽略非 GET 请求
  if (request.method !== 'GET') {
    return;
  }

  // API 请求：网络优先，离线时返回模拟数据
  if (request.url.includes('/api/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // 缓存成功的响应
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(DYNAMIC_CACHE).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return response;
        })
        .catch(() => {
          // 网络失败，尝试从缓存获取
          return caches.match(request).then((cachedResponse) => {
            if (cachedResponse) {
              return cachedResponse;
            }
            // 返回离线页面或空响应
            return new Response(
              JSON.stringify({
                success: false,
                error: {
                  code: 'OFFLINE',
                  message: 'You are currently offline. Some data may be unavailable.',
                },
              }),
              {
                status: 503,
                statusText: 'Service Unavailable',
                headers: new Headers({
                  'Content-Type': 'application/json',
                }),
              }
            );
          });
        })
    );
  } else {
    // 静态资源：缓存优先，降级到网络
    event.respondWith(
      caches.match(request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(request).then((response) => {
          // 缓存新的响应
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(DYNAMIC_CACHE).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return response;
        });
      })
    );
  }
});

// 后台同步（示例）
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-data') {
    event.waitUntil(
      // 同步待上传的数据
      console.log('[Service Worker] Syncing data...')
    );
  }
});

console.log('[Service Worker] Loaded');

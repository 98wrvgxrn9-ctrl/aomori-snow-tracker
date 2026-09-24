const CACHE_NAME = 'snow-tracker-v4';
const SHELL_ASSETS = [
  './',
  './index.html',
  './js/app.js',
  './js/face-score.js',
  './js/road-condition-predict.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

// インストール時にシェルをキャッシュ
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(SHELL_ASSETS);
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

// 古いキャッシュを削除
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) { return key !== CACHE_NAME; })
            .map(function(key) { return caches.delete(key); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// Network-first戦略（オフライン時はキャッシュにフォールバック）
self.addEventListener('fetch', function(event) {
  // POST等はスキップ
  if (event.request.method !== 'GET') return;

  // 外部リソース（タイルURL等）はSWを介さずブラウザに任せる
  var url = new URL(event.request.url);
  if (url.origin !== location.origin) return;

  event.respondWith(
    fetch(event.request).then(function(response) {
      // 成功したらキャッシュを更新
      if (response.ok) {
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(event.request, clone);
        });
      }
      return response;
    }).catch(function() {
      // オフライン時はキャッシュから返す
      return caches.match(event.request).then(function(cached) {
        return cached || new Response('オフラインです。接続を確認してください。', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      });
    })
  );
});

/* ZC-GURA Service Worker (v2.32)
 * - 离线：页面导航「网络优先，失败回退缓存」，静态资源「缓存优先 + 后台更新」
 * - 绝不缓存 /__zc_* 接口（登录、代理、同步等一律直连网络）
 */
/* 缓存名里的版本号由 Worker 在返回 /sw.js 时自动替换成 ZC_VERSION（_worker.js 里的 zcServeSw），发版只需改 ZC_VERSION；
 * 这里写的值只是直接打开静态文件时的兜底，test_v32.mjs 会校验它与 package.json / ZC_VERSION 一致。 */
const VER = 'zc-gura-v2.34.2';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VER).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => { })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VER).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const OFFLINE = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>离线</title>'
  + '<body style="font:16px/1.7 -apple-system,sans-serif;padding:32px;text-align:center"><h2>当前处于离线状态</h2><p>联网后刷新即可继续使用。已缓存的页面会在下次打开时自动恢复。</p></body>';

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.indexOf('/__zc_') === 0 || url.pathname === '/sw.js') return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => {
      if (r && r.ok) { const copy = r.clone(); caches.open(VER).then((c) => c.put('/', copy)).catch(() => { }); }
      return r;
    }).catch(() => caches.match('/').then((r) => r || new Response(OFFLINE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }))));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => {
    const net = fetch(req).then((r) => { if (r && r.ok) { const copy = r.clone(); caches.open(VER).then((c) => c.put(req, copy)).catch(() => { }); } return r; }).catch(() => hit);
    return hit || net;
  }));
});

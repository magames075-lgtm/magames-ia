// MaGames IA — service worker v2
// - HTML sempre da rede (com cópia offline de reserva) → nunca fica preso numa versão quebrada
// - assets com hash (/assets/*) em cache: são imutáveis
// - NUNCA guarda chamadas de API nem arquivos de outros domínios
const VERSION = 'mgia-v2.1.0';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];
self.addEventListener('install', (e) => {
  // ativa na hora: HTML vem sempre da rede e assets têm hash, então trocar de versão é seguro
  // (tira celulares presos no service worker antigo v1, que servia tudo do cache)
  self.skipWaiting();
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).catch(() => {}));
});
self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // backend, CDNs: direto na rede
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => { if (r.ok) { const cp = r.clone(); caches.open(VERSION).then((c) => c.put('./index.html', cp)); } return r; })
      .catch(() => caches.match('./index.html')));
    return;
  }
  if (url.pathname.includes('/assets/') || url.pathname.includes('/icons/')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => {
      if (r.ok && r.status === 200 && r.type === 'basic') { const cp = r.clone(); caches.open(VERSION).then((c) => c.put(req, cp)); }
      return r;
    })));
  }
  // demais (sw.js, manifest): rede padrão
});

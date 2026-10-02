// Hi There — сервис-воркер: приложение открывается быстро и без интернета
const V = "hithere-v66";
const TTS_CACHE = "hithere-tts";   // записи голоса — отдельно, переживают обновления приложения
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./maskable-512.png", "./apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V && k !== TTS_CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const r = e.request, u = new URL(r.url);
  if (r.method === "GET" && u.pathname.includes("/storage/v1/object/public/tts/")) {  // озвучка: файл не меняется — берём из кэша
    e.respondWith(caches.open(TTS_CACHE).then(c => c.match(r).then(hit => hit || fetch(r).then(res => { if (res.ok) c.put(r, res.clone()); return res; }))));
    return;
  }
  if (r.method !== "GET" || u.hostname.endsWith("supabase.co")) return;          // база — всегда напрямую
  if (r.mode === "navigate") {                                                       // страница: сначала сеть (свежая версия), без сети — из кэша
    e.respondWith(fetch(r).then(res => { const c = res.clone(); caches.open(V).then(x => x.put("./index.html", c)); return res; })
      .catch(() => caches.match("./index.html")));
    return;
  }
  if (/fonts\.(googleapis|gstatic)\.com$/.test(u.hostname) || u.origin === location.origin) { // шрифты и иконки: из кэша, обновляем в фоне
    e.respondWith(caches.match(r).then(hit => {
      const net = fetch(r).then(res => { if (res.ok || res.type === "opaque") { const c = res.clone(); caches.open(V).then(x => x.put(r, c)); } return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});

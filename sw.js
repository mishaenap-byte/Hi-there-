// Hi There — сервис-воркер: приложение открывается быстро и без интернета
const V = "hithere-v100";
const TTS_CACHE = "hithere-tts";   // записи голоса — отдельно, переживают обновления приложения
const BOOK_CACHE = "hithere-books";
const INBOX = "hithere-inbox";     // пришедшие уведомления: приложение забирает их в личные сообщения от «Hi There» // аудио книг: файлы не меняются, после обновления приложения качать заново не нужно
const SHELL = ["./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./maskable-512.png", "./apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V && k !== TTS_CACHE && k !== BOOK_CACHE && k !== INBOX).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const r = e.request, u = new URL(r.url);
  if (r.method === "GET" && u.pathname.includes("/storage/v1/object/public/tts/")) {  // озвучка: файл не меняется — берём из кэша
    e.respondWith(caches.open(TTS_CACHE).then(c => c.match(r).then(hit => hit || fetch(r).then(res => { if (res.ok) c.put(r, res.clone()); return res; }))));
    return;
  }
  if (r.method === "GET" && u.origin === location.origin && /\/books\/.+\.mp3$/.test(u.pathname)) {  // книги: из кэша, без интернета тоже
    if (r.headers.has("range")) return;                                              // запросы кусками — напрямую в сеть
    e.respondWith(caches.open(BOOK_CACHE).then(c => c.match(r).then(hit => hit || fetch(r).then(res => { if (res.status === 200) c.put(r, res.clone()); return res; }))));
    return;
  }
  if (r.method !== "GET" || u.hostname.endsWith("supabase.co")) return;          // база — всегда напрямую
  if (r.mode === "navigate") {   // страница: сначала сеть (свежая версия); без сети или если сеть молчит 4 с — из кэша
    const net = fetch(r);
    e.waitUntil(net.then(res => res.ok && res.type === "basic" ? caches.open(V).then(x => x.put("./index.html", res.clone())) : null).catch(() => {}));
    e.respondWith(caches.match("./index.html").then(hit => {
      if (!hit) return net;
      const slow = new Promise(ok => setTimeout(() => ok(hit), 4000));
      return Promise.race([net.then(res => res.ok ? res : hit, () => hit), slow]);
    }));
    return;
  }
  if (/fonts\.(googleapis|gstatic)\.com$/.test(u.hostname) || u.origin === location.origin) { // шрифты и иконки: из кэша, обновляем в фоне
    e.respondWith(caches.match(r).then(hit => {
      const net = fetch(r).then(res => { if (res.ok || res.type === "opaque") { const c = res.clone(); caches.open(V).then(x => x.put(r, c)); } return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});
// пуш-уведомления: показываем, даже когда приложение закрыто; по нажатию открываем приложение на нужном экране
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : "" }; }
  // телефон сам пишет «from Hi There» — заголовок «Hi There» повторял бы его: тогда заголовком делаем сам текст
  let title = (d.title || "").trim(), body = (d.body || "").trim();
  if (!title || title === "Hi There") { if (body.length <= 60) { title = body || "Hi There"; body = ""; } else title = "📣 Новое сообщение"; }
  const item = { id: Date.now() + "-" + Math.random().toString(36).slice(2, 7), title, body, tab: d.tab || "", at: Date.now() };
  e.waitUntil(Promise.all([
    self.registration.showNotification(item.title, {
      body: item.body, icon: "./icon-192.png", badge: "./icon-192.png", tag: d.tag || "hithere", data: { tab: item.tab || "dm" }
    }),
    // сохраняем текст, чтобы его можно было прочитать в приложении: «Сообщения» → «Hi There»
    caches.open(INBOX).then(c => c.match("./__inbox").then(r => r ? r.json() : []).catch(() => []).then(list => {
      list.push(item); return c.put("./__inbox", new Response(JSON.stringify(list.slice(-50)), { headers: { "Content-Type": "application/json" } }));
    })).then(() => self.clients.matchAll({ type: "window", includeUncontrolled: true })).then(ws => ws.forEach(w => w.postMessage({ push: "inbox" })))
  ]));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const tab = (e.notification.data && e.notification.data.tab) || "dm";
  const url = new URL("./" + (tab ? "?tab=" + encodeURIComponent(tab) : ""), self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(ws => {
    const w = ws.find(x => "focus" in x);
    if (w) { if (tab) w.postMessage({ push: "open", tab }); return w.focus(); }
    return self.clients.openWindow(url);
  }));
});

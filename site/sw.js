// League HQ offline support.
// Pages and league data are fetched from the network first and saved as they come in; when there's no connection,
// the last saved copy is used instead, so the site still opens with the latest scores it saw.
const SW_BUILD = "dev"; // replaced with the commit id at deploy time, so each deploy installs fresh
const CACHE = "league-hq-" + SW_BUILD;
const SHELL = ["./", "index.html", "app.js?v=" + SW_BUILD, "style.css?v=" + SW_BUILD, "config.js?v=" + SW_BUILD,
  "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith("league-hq-") && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

// Save under the address without its ?t= / ?v= cache-busting part, so the newest copy of each file replaces the last.
const keyFor = url => {
  const u = new URL(url);
  u.search = "";
  return u.toString();
};

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(keyFor(request.url), res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(keyFor(request.url));
    if (hit) return hit;
    if (request.mode === "navigate") {
      const page = await cache.match(keyFor(new URL("index.html", self.registration.scope).toString()));
      if (page) return page;
    }
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(keyFor(request.url));
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(keyFor(request.url), res.clone());
  return res;
}

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameSite = url.origin === self.location.origin && url.pathname.startsWith(new URL(self.registration.scope).pathname);
  if (sameSite) {
    // logos and icons rarely change: saved copy first. Everything else (pages, code, data): network first.
    if (/\/(logos|icons)\//.test(url.pathname)) event.respondWith(cacheFirst(req));
    else event.respondWith(networkFirst(req));
  } else if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(cacheFirst(req));
  }
  // anything else (the live worker, ESPN images) goes straight to the network
});

// Game-day alerts (Settings → Alerts): the live worker sends { title, body, url, tag }; tapping one opens that page.
self.addEventListener("push", event => {
  let m = {};
  try { m = event.data ? event.data.json() : {}; } catch (_) { m = { body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(m.title || "League HQ", {
    body: m.body || "", tag: m.tag || undefined, renotify: !!m.tag,
    icon: "icons/icon-192.png", badge: "icons/icon-192.png", data: { url: m.url || "" },
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL(event.notification.data && event.notification.data.url || "", self.registration.scope).toString();
  event.waitUntil((async () => {
    // a link off the site (the admin watchdog's GitHub links) opens on its own, leaving the site where it was
    if (!target.startsWith(self.registration.scope)) return self.clients.openWindow(target);
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = wins.find(w => w.url.startsWith(self.registration.scope));
    if (open) { await open.focus(); return open.navigate ? open.navigate(target).catch(() => {}) : null; }
    return self.clients.openWindow(target);
  })());
});

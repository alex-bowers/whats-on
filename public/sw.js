// Service worker: lets the app be installed and open without a connection, shows push notifications,
// and opens the right page when one is tapped.
const CACHE = "whats-on-v1";
const SHELL = ["/", "/app.js", "/styles.css", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// The app's own files come from the network when it's reachable, so a new version shows straight away,
// and from the cache when it isn't. Show data (/api) is never cached here.
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && url.search === "") {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
        }
        return response;
      })
      .catch(async () => (await caches.match(request, { ignoreSearch: request.mode === "navigate" }))
        || (request.mode === "navigate" ? caches.match("/") : Response.error())),
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* a malformed message still gets a notification */ }
  event.waitUntil(
    self.registration.showNotification(data.title || "What's On in Stoke", {
      body: data.body || "There's something new on the calendar.",
      tag: data.tag,
      icon: "/icon-192.png",
      badge: "/badge-96.png",
      data: { url: data.url || "/?view=new" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin);
  // Only ever open this app or an https page.
  const url = target.protocol === "https:" || target.origin === self.location.origin ? target.href : "/";
  event.waitUntil(self.clients.openWindow(url));
});

// Service worker: shows push notifications and opens the right page when one is tapped.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

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

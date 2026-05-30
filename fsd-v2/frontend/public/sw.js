/*
 * FSD MRBS v2 — push service worker.
 *
 * Mirrors v1's src/presentation/web/spa/public/push-sw.js semantics:
 * the SPA registers this worker once per device; on `push` we surface a
 * Notification from the JSON payload, and on `notificationclick` we
 * focus an existing SPA tab (or open one) and navigate to payload.url.
 *
 * No offline caching — Web Push doesn't need it and skipping the cache
 * avoids stale-asset bugs after a deploy.
 */

self.addEventListener('install', (event) => {
  // Activate immediately so a freshly registered worker handles the
  // next push without requiring an extra reload.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) { /* non-JSON push */ }
  const title = payload.title || 'FSD MRBS';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/favicon.ico',
    badge: payload.badge || '/favicon.ico',
    tag: payload.tag || 'mrbs',
    renotify: !!payload.tag, // collapse duplicates by tag, but still alert
    data: { url: payload.url || '/app/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/app/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      // Focus an existing SPA tab if one is already open.
      if (c.url.includes('/app/') && 'focus' in c) {
        await c.focus();
        if ('navigate' in c) try { await c.navigate(target); } catch (e) { /* cross-origin */ }
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

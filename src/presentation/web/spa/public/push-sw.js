/*
 * FSD MRBS — push service worker.
 *
 * The SPA registers this worker once per device. When the notification
 * worker dispatches a Web Push the browser wakes this worker and we
 * surface a notification through self.registration.showNotification.
 *
 * Click handling sends focus back to the SPA, deep-linking to the
 * booking referenced in the payload's `data.url` field so the user
 * lands on the right view (e.g. /app/approvals/abc-123).
 */

self.addEventListener('install', (event) => {
  // Activate immediately so the new worker takes over without requiring
  // an extra page reload. We don't cache anything — pushes don't need
  // offline support.
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
      // Focus an existing tab if it's already on the SPA.
      if (c.url.includes('/app/') && 'focus' in c) {
        await c.focus();
        if ('navigate' in c) try { await c.navigate(target); } catch (e) { /* cross-origin */ }
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

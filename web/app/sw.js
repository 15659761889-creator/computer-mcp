// 万机 service worker: shows pushes and opens the app on tap. Nothing is cached:
// the app needs the live connection anyway, and a stale copy could hide an update.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: '万机', body: event.data?.text() || '' }; }
  const title = data.title || '万机';
  event.waitUntil((async () => {
    await self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || 'wanji',
      renotify: true,
      icon: 'icon-180.png',
      badge: 'icon-180.png',
      data: { kind: data.kind || '', computer: data.computer || '' },
    });
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) client.postMessage({ type: 'push', data });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { kind, computer } = event.notification.data || {};
  const hash = kind === 'takeover' && computer ? `#takeover=${encodeURIComponent(computer)}` : kind === 'secret' ? '#secret' : '';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      client.postMessage({ type: 'open', kind, computer });
      if ('focus' in client) return client.focus();
    }
    return self.clients.openWindow(`/app/${hash}`);
  })());
});

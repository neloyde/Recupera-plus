// Recupera+ Service Worker — Web Push notifications
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(clients.claim()); });

// Recebe a mensagem push do servidor e mostra uma notificação
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch(e) {}
  const title = data.title || 'Recupera+';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/badge.png',
    vibrate: [100, 50, 100],
    data: data.data || { url: '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Clique na notificação → abre/foca a app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) { c.focus(); return; } }
      return clients.openWindow(url);
    })
  );
});

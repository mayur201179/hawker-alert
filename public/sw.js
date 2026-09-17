// This runs in the background, separate from the page — it's what lets an alert
// reach a phone even if the hawker doesn't have the app open at that moment.

self.addEventListener('push', event => {
  let data = { title: '🚨 Hawker Alert', body: 'BMC team spotted nearby!' };
  try {
    if (event.data) data = event.data.json();
  } catch (e) { /* fall back to default text above */ }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: undefined,
      tag: 'hawker-alert',       // replaces any earlier alert notification instead of stacking
      renotify: true,             // ...but still re-alerts (sound/vibrate) each time
      requireInteraction: true,   // stays on screen until they dismiss it, not just a few seconds
      vibrate: [300, 100, 300, 100, 300]
    })
  );
});

// Tapping the notification opens (or focuses) the app instead of just dismissing it.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});

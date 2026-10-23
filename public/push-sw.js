// Task 2.6: phone alerts. Loaded into the app's service worker (vite.config.ts → workbox.importScripts).
// Shows each alert the Control Tower sends, and opens the right page when it is tapped.

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }
  const title = data.title || 'Agent Control Tower'
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'Something needs your attention.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag, // a newer alert about the same request replaces the older one
    renotify: Boolean(data.tag),
    data: { url: data.url || '/approvals' },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.url || '/approvals', self.location.origin).href
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const w of windows) {
      if (new URL(w.url).origin === self.location.origin && 'focus' in w) {
        await w.focus()
        if ('navigate' in w) await w.navigate(url).catch(() => undefined)
        return
      }
    }
    await self.clients.openWindow(url)
  })())
})

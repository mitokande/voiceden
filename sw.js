/* VoiceDen service worker — Web Push only (no offline cache).
 *
 * The server sends one push per new message the person should hear about.
 * If the app is already in front, the page itself shows a toast from its next
 * poll, so the push only nudges that poll. Otherwise a system notification
 * is shown, one per channel: later messages update it quietly ("+2 mesaj daha"),
 * a mention makes it ring again. Clicking opens the channel.
 */
'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

const scoped = path => new URL(path, self.registration.scope).href;

// pushes are handled one at a time, so a burst still adds up to "+N mesaj daha"
let queue = Promise.resolve();

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(queue = queue.catch(() => {}).then(async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (!d.test && wins.some(w => w.focused && w.visibilityState === 'visible')) {
      wins.forEach(w => w.postMessage({ type: 'push', data: d }));
      return;
    }
    const tag = d.ch ? 'ch' + d.ch : (d.test ? 'test' : 'voiceden');
    const prev = d.ch ? await self.registration.getNotifications({ tag }) : [];
    const count = prev.length && prev[0].data ? (prev[0].data.count || 1) + 1 : 1;
    await self.registration.showNotification(d.title || 'VoiceDen', {
      body: count > 1 ? `${d.body || ''}\n+${count - 1} mesaj daha` : (d.body || ''),
      tag,
      renotify: !!d.m,
      icon: scoped(d.icon || 'icons/icon-192.png'),
      badge: scoped('icons/badge-72.png'),
      timestamp: Date.now(),
      data: { url: scoped(d.url || './'), count, ch: d.ch || 0 },
    });
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = wins.find(w => w.url.startsWith(self.registration.scope) && !/admin\.html|classic\.html/.test(w.url));
    if (app) {
      await app.focus();
      app.postMessage({ type: 'open', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});

// the browser rotated the subscription: subscribe again and tell the server
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    const res = await fetch('api.php?a=push_key', { credentials: 'include' });
    if (!res.ok) return;
    const { key } = await res.json();
    const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((key.length + 3) % 4));
    const sub = await self.registration.pushManager.subscribe({
      userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, c => c.charCodeAt(0)),
    });
    await fetch('api.php?a=push_subscribe', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-VoiceDen': '1' },
      body: JSON.stringify(sub.toJSON()),
    });
  })());
});

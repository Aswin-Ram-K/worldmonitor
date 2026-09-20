// Service worker push handler (Phase 6).
//
// Imported by VitePWA's generated sw.js via workbox.importScripts:
// ['/push-handler.js']. Runs in the SW global scope — has access to
// self.addEventListener, self.registration.showNotification,
// clients.openWindow, etc.
//
// Payload contract (sent by scripts/notification-relay.cjs):
//   { title: string, body: string, url?: string, tag?: string,
//     icon?: string, badge?: string }
//
// Any deviation from that shape falls back to a safe default so a
// malformed payload still renders something readable instead of
// silently dropping the notification.

/* eslint-env serviceworker */
/* global self, clients */

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_err) {
    // Non-JSON payload: treat the text body as the notification body.
    try {
      data = { title: 'WorldMonitor', body: event.data ? event.data.text() : '' };
    } catch {
      data = {};
    }
  }

  const title = typeof data.title === 'string' && data.title.length > 0
    ? data.title
    : 'WorldMonitor';
  const body = typeof data.body === 'string' ? data.body : '';
  const url = typeof data.url === 'string' ? data.url : '/';
  const tag = typeof data.tag === 'string' ? data.tag : 'worldmonitor-generic';
  const icon = typeof data.icon === 'string'
    ? data.icon
    : '/favico/android-chrome-192x192.png';
  const badge = typeof data.badge === 'string'
    ? data.badge
    : '/favico/android-chrome-192x192.png';

  const opts = {
    body,
    icon,
    badge,
    tag,
    // requireInteraction keeps the notification on screen until the
    // user acts on it. Critical for brief_ready where we want the
    // reader to actually open the magazine, not dismiss it from the
    // lock screen.
    requireInteraction: data.eventType === 'brief_ready',
    data: { url, eventType: data.eventType ?? 'unknown' },
  };

  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  const tag = (event.notification.data && event.notification.data.tag)
    || (typeof event.notification.tag === 'string' ? event.notification.tag : '');
  // The blocked notice itself carries tag 'suppressed:*': bypass the check
  // so its click can never re-enter the suppression path.
  if (typeof tag === 'string' && tag.startsWith('suppressed:')) {
    event.waitUntil((async () => {
      try {
        if (clients.openWindow) await clients.openWindow('/');
      } catch {
        // Swallow — nothing to do beyond failing silently.
      }
    })());
    return;
  }
  event.waitUntil((async () => {
    // Operator revoke path (#8401): an already-delivered push payload
    // carries its URL on-device. When the operator blocks that URL after
    // delivery, the click must not navigate to it — show the blocked
    // notice instead. Fail-open: when the check file is absent (old SW)
    // or the endpoint is unreachable, navigate as before.
    try {
      const suppression = self.wmLinkSuppression;
      if (suppression && typeof suppression.checkLinkSuppressed === 'function') {
        const blocked = await suppression.checkLinkSuppressed(target);
        if (blocked) {
          if (typeof self.wmShowBlockedNotice === 'function') {
            try {
              await self.wmShowBlockedNotice(tag);
            } catch {
              // The blocked decision is terminal even when the replacement
              // notice cannot be shown. Never fall through to the blocked URL.
            }
          }
          return;
        }
      }
    } catch {
      // Suppression-check failure must never strand the click.
    }
    try {
      const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      // If an existing window points at our origin, focus it and
      // navigate rather than spawning a new tab. Cheaper for the
      // user, less duplicated app state.
      for (const c of all) {
        try {
          const sameOrigin = new URL(c.url).origin === self.location.origin;
          if (sameOrigin && 'focus' in c) {
            if ('navigate' in c && typeof c.navigate === 'function') {
              await c.navigate(target);
            }
            return c.focus();
          }
        } catch {
          // URL parse failure or cross-origin — fall through to open.
        }
      }
      if (clients.openWindow) return clients.openWindow(target);
    } catch {
      // Swallow — nothing to do beyond failing silently.
    }
  })());
});

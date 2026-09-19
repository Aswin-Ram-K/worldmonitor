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

// Classify a click target. Payload URLs come from event.payload.link, which
// is published verbatim by Pro accounts through /api/notify or ingested
// verbatim from external RSS feeds, so the target is not trusted.
//
//   crossOrigin: false — reuse the open dashboard tab (focus + navigate)
//   crossOrigin: true  — the article opens in its OWN tab
//
// The distinction is the whole guard: navigating the already-open dashboard
// to an attacker-supplied link replaces a trusted surface with a page
// WorldMonitor does not control. Opening a fresh tab is the same thing the
// email / Telegram / Slack channels already do with the link in the message.
// Anything that is neither same-origin nor https collapses to the dashboard,
// so a javascript: or data: target can never become a navigation.
function classifyClickTarget(raw) {
  const dashboard = { url: '/', crossOrigin: false };
  if (typeof raw !== 'string' || raw.length === 0) return dashboard;
  let parsed;
  try {
    parsed = new URL(raw, self.location.origin);
  } catch {
    return dashboard;
  }
  // Embedded credentials (https://worldmonitor.app@evil.com/) exist only to
  // make a hostile host read as ours. No real article link carries them.
  if (parsed.username || parsed.password) return dashboard;
  if (parsed.origin === self.location.origin) return { url: raw, crossOrigin: false };
  if (parsed.protocol !== 'https:') return dashboard;
  return { url: parsed.href, crossOrigin: true };
}

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
  const url = classifyClickTarget(data.url).url;
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
  const { url: target, crossOrigin } = classifyClickTarget(
    event.notification.data && event.notification.data.url,
  );
  event.waitUntil((async () => {
    try {
      // An off-origin article always gets a fresh tab. Never hand it the
      // dashboard's — that tab is a trusted surface the user came back to.
      if (crossOrigin) {
        if (clients.openWindow) return clients.openWindow(target);
        return;
      }
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

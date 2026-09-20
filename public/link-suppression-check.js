// Operator link-suppression check for already-delivered push payloads (#8401).
//
// Imported by VitePWA's generated sw.js via workbox.importScripts alongside
// /push-handler.js. Runs in the SW global scope — same constraints as the
// push handler (no modules, no build step; plain script).
//
// The relay stops blocked links BEFORE delivery, but a push notification
// already sitting on a device carries its URL in `notification.data.url`.
// This module consults the anonymous edge endpoint
// (api/notification-suppressions.js) on click, and when the click target is
// suppressed the SW shows a "link blocked" notice instead of navigating —
// the operator's revoke path for the already-delivered case.
//
// Fail-open by design: when the endpoint is unreachable or reports
// `unavailable: true`, the click navigates as before. A suppression control
// that cannot be read must not strand every notification click during a
// Redis or network outage. The cached snapshot is the incident control;
// the network is just its refresh path.

/* eslint-env serviceworker */
/* global self, fetch, caches */

(function () {
  'use strict';

  var ENDPOINT = '/api/notification-suppressions';
  var CACHE_NAME = 'wm-link-suppressions-v1';
  var CACHE_TTL_MS = 60 * 1000;
  var FETCH_TIMEOUT_MS = 3_000;
  var FALLBACK_BODY = 'This link was blocked by WorldMonitor after delivery. Open the dashboard for the latest safe update.';

  function normalizeUrl(raw, origin) {
    if (typeof raw !== 'string') return null;
    var trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.length > 2048) return null;
    var parsed;
    try {
      parsed = new URL(trimmed, origin);
    } catch (_e) {
      return null;
    }
    var protocol = parsed.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    var host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
    if (host.length === 0) return null;
    var isDefaultPort =
      (protocol === 'http:' && parsed.port === '80') ||
      (protocol === 'https:' && parsed.port === '443');
    if (parsed.port && !isDefaultPort) host += ':' + parsed.port;
    var path = parsed.pathname || '/';
    try {
      path = decodeURI(path);
    } catch (_e2) {
      // Malformed % sequences stay encoded — still comparable.
    }
    return { href: protocol + '//' + host + path + parsed.search + parsed.hash, host: parsed.hostname.toLowerCase().replace(/\.+$/, '') };
  }

  function isSuppressed(candidate, snapshot, origin) {
    if (!snapshot || snapshot.unavailable) return false;
    var norm = normalizeUrl(candidate, origin);
    if (!norm) return false;
    var urls = Array.isArray(snapshot.suppressed) ? snapshot.suppressed : [];
    var hosts = Array.isArray(snapshot.hosts) ? snapshot.hosts : [];
    for (var i = 0; i < urls.length; i++) {
      if (typeof urls[i] !== 'string') continue;
      var entry = normalizeUrl(urls[i], origin);
      if (entry && entry.href === norm.href) return true;
    }
    for (var j = 0; j < hosts.length; j++) {
      var host = typeof hosts[j] === 'string' ? hosts[j].trim().toLowerCase().replace(/\.+$/, '') : '';
      if (!host) continue;
      if (norm.host === host || norm.host.slice(-host.length - 1) === '.' + host) return true;
    }
    return false;
  }

  function readCachedSnapshot() {
    try {
      if (typeof caches === 'undefined' || !caches.match) return Promise.resolve(null);
      return caches.match(ENDPOINT, { ignoreSearch: false }).then(function (res) {
        if (!res) return null;
        var fetchedAt = Date.parse(res.headers.get('wm-suppressions-fetched-at') || '');
        if (!Number.isFinite(fetchedAt) || Date.now() - fetchedAt > CACHE_TTL_MS) return null;
        return res.json().catch(function () { return null; });
      }).catch(function () { return null; });
    } catch (_e) {
      return Promise.resolve(null);
    }
  }

  function storeCachedSnapshot(payload) {
    try {
      if (typeof caches === 'undefined' || !caches.open) return Promise.resolve();
      var headers = new Headers({ 'Content-Type': 'application/json' });
      headers.set('wm-suppressions-fetched-at', new Date().toISOString());
      return caches.open(CACHE_NAME).then(function (cache) {
        return cache.put(ENDPOINT, new Response(JSON.stringify(payload), { headers: headers }));
      }).catch(function () {});
    } catch (_e) {
      return Promise.resolve();
    }
  }

  function fetchSnapshot() {
    var controller = null;
    var timeoutId = 0;
    var signal;
    try {
      if (typeof AbortController !== 'undefined') {
        controller = new AbortController();
        signal = controller.signal;
        timeoutId = setTimeout(function () {
          try { controller.abort(); } catch (_e) { /* already settled */ }
        }, FETCH_TIMEOUT_MS);
      }
    } catch (_e) {
      controller = null;
    }
    var opts = { method: 'GET', credentials: 'omit' };
    if (signal) opts.signal = signal;
    return fetch(ENDPOINT, opts).then(function (res) {
      if (!res.ok) return null;
      return res.json().catch(function () { return null; });
    }).then(function (payload) {
      if (payload && !payload.unavailable) storeCachedSnapshot(payload);
      return payload;
    }).catch(function () {
      return null;
    }).finally(function () {
      if (timeoutId) clearTimeout(timeoutId);
    });
  }

  function checkLinkSuppressed(url) {
    var origin = null;
    try {
      origin = self.location.origin;
    } catch (_e) {
      origin = null;
    }
    return readCachedSnapshot().then(function (cached) {
      // A fresh cache hit answers synchronously — clicks must not wait on
      // the network when the incident control is already on-device.
      var revalidate = fetchSnapshot();
      if (cached) {
        // Refresh in the background; the click decision uses the cached set.
        // An unhandled rejection here would surface as an SW error ping.
        if (revalidate && typeof revalidate.catch === 'function') revalidate.catch(function () {});
        return isSuppressed(url, cached, origin);
      }
      return revalidate.then(function (fresh) {
        return isSuppressed(url, fresh, origin);
      });
    }).catch(function () {
      // Any failure in the check path fails open to navigation.
      return false;
    });
  }

  function showBlockedNotice(tag) {
    try {
      return self.registration.showNotification('Link blocked by WorldMonitor', {
        body: FALLBACK_BODY,
        tag: typeof tag === 'string' && tag.length > 0 ? 'suppressed:' + tag : 'suppressed:link',
        data: { url: '/' },
      });
    } catch (_e) {
      return Promise.resolve();
    }
  }

  // Exposed for the vm-sandbox unit test (public/push-handler.js pattern).
  // The notificationclick listener in push-handler.js calls this when
  // present; when this file is not loaded (old SW), clicks behave as before.
  try {
    self.wmLinkSuppression = {
      checkLinkSuppressed: checkLinkSuppressed,
      isSuppressed: isSuppressed,
      normalizeUrl: normalizeUrl,
    };
    self.wmShowBlockedNotice = showBlockedNotice;
  } catch (_e) {
    // Non-SW context (unit test sandbox without self) — ignore.
  }
})();

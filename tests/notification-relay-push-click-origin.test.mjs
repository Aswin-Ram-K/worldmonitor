/**
 * REGRESSION: notification click targets must stay on the WorldMonitor origin.
 *
 * Web-push payload URLs come from `event.payload.link`, which is either
 * published verbatim by a Pro account through /api/notify or ingested
 * verbatim from an external RSS feed. The service worker navigates the
 * user's already-open dashboard tab to that URL, so an attacker-supplied
 * link would replace a trusted tab with an arbitrary external page.
 *
 * Article links stay reachable: the relay keeps off-origin https targets and
 * public/push-handler.js opens them in their OWN tab, never navigating the
 * dashboard (tests/brief-web-push.test.mjs). The relay's half is scheme
 * discipline — javascript:, data:, http: and credential-bearing URLs can
 * never reach a notification payload.
 *
 * Run: node --test tests/notification-relay-push-click-origin.test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

let safePushClickUrl;

before(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
  process.env.CONVEX_URL = 'https://convex.test';
  process.env.CONVEX_SITE_URL = 'https://convex.test';
  process.env.CONVEX_NOTIFICATION_RELAY_SECRET = 'relay-secret';
  process.env.RESEND_API_KEY = 'resend-key';
  const relayPath = require.resolve('../scripts/notification-relay.cjs');
  delete require.cache[relayPath];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, ...rest) {
    if (request === 'resend') {
      return { Resend: class { emails = { send: async () => ({ data: { id: 'sent' }, error: null }) }; } };
    }
    return originalLoad.call(this, request, parent, ...rest);
  };
  try {
    ({ safePushClickUrl } = require(relayPath));
  } finally {
    Module._load = originalLoad;
  }
});

describe('safePushClickUrl', () => {
  it('keeps WorldMonitor URLs intact', () => {
    assert.equal(
      safePushClickUrl('https://worldmonitor.app/api/brief/u/2026-09-19?t=x'),
      'https://worldmonitor.app/api/brief/u/2026-09-19?t=x',
    );
  });

  it('resolves relative paths against the dashboard origin', () => {
    assert.equal(safePushClickUrl('/dashboard'), 'https://worldmonitor.app/dashboard');
    // A bare string is a relative path, so it stays on-origin — harmless.
    assert.equal(safePushClickUrl('not a url'), 'https://worldmonitor.app/not%20a%20url');
  });

  it('keeps off-origin https article links — the SW gives them their own tab', () => {
    // The article is the point of an rss_alert. Reachability is preserved
    // here; public/push-handler.js is what stops the open dashboard tab
    // from being navigated to it (tests/brief-web-push.test.mjs).
    assert.equal(safePushClickUrl('https://reuters.com/world/story'), 'https://reuters.com/world/story');
    assert.equal(safePushClickUrl('//example.com/wm-verify-account'), 'https://example.com/wm-verify-account');
  });

  it('substitutes the dashboard for schemes that must never navigate', () => {
    for (const hostile of [
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      // http: would be a downgrade from the https dashboard.
      'http://example.com/',
      // Embedded credentials exist only to make a hostile host read as ours.
      'https://worldmonitor.app@example.com/',
    ]) {
      assert.equal(safePushClickUrl(hostile), 'https://worldmonitor.app/', `must reject ${hostile}`);
    }
  });

  it('falls back to the dashboard for missing or unparseable input', () => {
    assert.equal(safePushClickUrl(''), 'https://worldmonitor.app/');
    assert.equal(safePushClickUrl(undefined), 'https://worldmonitor.app/');
    assert.equal(safePushClickUrl(null), 'https://worldmonitor.app/');
    assert.equal(safePushClickUrl({ toString: () => 'https://example.com' }), 'https://worldmonitor.app/');
  });

  it('sendWebPush routes its click URL through the guard', () => {
    const { readFileSync } = require('node:fs');
    const src = readFileSync(require.resolve('../scripts/notification-relay.cjs'), 'utf-8');
    const fn = src.match(/async function sendWebPush\([\s\S]+?\n\}/);
    assert.ok(fn, 'sendWebPush must exist');
    assert.match(fn[0], /url: safePushClickUrl\(payload\.url\)/,
      'sendWebPush must sanitize the click URL for every call site');
  });
});

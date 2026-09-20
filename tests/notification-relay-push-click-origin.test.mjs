/**
 * REGRESSION: the relay must not stamp an origin onto push click URLs.
 *
 * Web-push payload URLs come from `event.payload.link`, which is either
 * published verbatim by a Pro account through /api/notify or ingested verbatim
 * from an external RSS feed — so every input here is attacker-supplied.
 *
 * The relay used to absolutize every first-party target onto a hardcoded apex
 * origin. The service worker runs on www and on five vertical subdomains, never
 * the apex, so those URLs read as cross-origin and opened a duplicate tab
 * instead of reusing the dashboard. The relay cannot name the right origin —
 * it is a root-level CJS script that cannot import the app's CANONICAL_ORIGIN,
 * so any origin it names is a hand-copied constant, the exact drift 066d7e6c3
 * calls out. So it names none: first-party targets go out as relative paths and
 * each worker resolves against whatever origin is serving it.
 *
 * One absolute constant survives as a PARSE BASE — `new URL('/x', '/')` throws,
 * a relative base is not a legal base — but it is never returned.
 *
 * Run: node --test tests/notification-relay-push-click-origin.test.mjs
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import {
  FIRST_PARTY_PATH_LAUNDERING,
  UNPARSEABLE,
  HOSTILE_SCHEMES,
  LOOKALIKE_HOSTS,
} from './fixtures/hostile-push-urls.mjs';
import {
  makeSwSandbox,
  loadHandlerInto,
  addWindowClient,
  clickNotification,
  SERVING_ORIGINS,
} from './helpers/sw-sandbox.mjs';

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
  it('emits first-party targets as relative paths, carrying no origin', () => {
    assert.equal(
      safePushClickUrl('https://worldmonitor.app/api/brief/u/2026-09-19?t=x'),
      '/api/brief/u/2026-09-19?t=x',
    );
    assert.equal(safePushClickUrl('https://www.worldmonitor.app/dashboard'), '/dashboard');
    assert.equal(safePushClickUrl('https://worldmonitor.app/'), '/');
  });

  it('preserves query and fragment', () => {
    assert.equal(
      safePushClickUrl('https://worldmonitor.app/brief?t=signed#section'),
      '/brief?t=signed#section',
    );
  });

  it('leaves a relative path relative', () => {
    assert.equal(safePushClickUrl('/dashboard'), '/dashboard');
    // A bare string is a relative path, so it stays on-origin — harmless.
    assert.equal(safePushClickUrl('not a url'), '/not%20a%20url');
  });

  it('keeps off-origin https article links absolute — the SW gives them their own tab', () => {
    assert.equal(safePushClickUrl('https://reuters.com/world/story'), 'https://reuters.com/world/story');
    assert.equal(safePushClickUrl('//example.com/wm-verify-account'), 'https://example.com/wm-verify-account');
  });

  it('keeps vertical-subdomain targets absolute — a different surface is not ours to relativize', () => {
    assert.equal(
      safePushClickUrl('https://tech.worldmonitor.app/dashboard'),
      'https://tech.worldmonitor.app/dashboard',
    );
  });

  it('keeps apex-exempt paths absolute on the apex', () => {
    // Cloudflare serves these on the apex and must never see them rewritten:
    // /oauth/* turned into a www redirect makes a registration POST a GET (405,
    // #4938). Relativizing would destroy the apex origin before the worker,
    // which can only recognize an ABSOLUTE apex URL, ever gets a say.
    for (const path of ['/mcp', '/oauth/register', '/.well-known/api-catalog', '/robots.txt']) {
      assert.equal(
        safePushClickUrl(`https://worldmonitor.app${path}`),
        `https://worldmonitor.app${path}`,
        `${path} is apex-served`,
      );
    }
  });

  it('substitutes the dashboard for schemes that must never navigate', () => {
    for (const { raw, why } of HOSTILE_SCHEMES) {
      assert.equal(safePushClickUrl(raw), '/', `must reject ${raw} (${why})`);
    }
  });

  it('does not launder a first-party URL into an off-origin link', () => {
    // These are first-party BY HOST but their pathname is //evil.com, so
    // stripping the origin emits a protocol-relative reference. Asserting the
    // re-resolved ORIGIN is the point: the backslash spelling does not start
    // with `//` and still resolves to evil.com, so a prefix check passes while
    // the guard is bypassed.
    for (const { raw, why } of FIRST_PARTY_PATH_LAUNDERING) {
      const out = safePushClickUrl(raw);
      for (const origin of SERVING_ORIGINS) {
        assert.equal(
          new URL(out, origin).origin,
          origin,
          `${raw} (${why}) resolved off-origin as ${out}`,
        );
      }
    }
  });

  it('falls back to the dashboard for missing input', () => {
    assert.equal(safePushClickUrl(''), '/');
    assert.equal(safePushClickUrl(undefined), '/');
    assert.equal(safePushClickUrl(null), '/');
    assert.equal(safePushClickUrl({ toString: () => 'https://example.com' }), '/');
  });

  it('falls back to the dashboard when the URL itself is unparseable', () => {
    // The cases above all short-circuit on the typeof guard and never reach
    // new URL(). These actually throw from it, even with a base supplied, so
    // they are what exercises the parse-failure branch.
    for (const { raw, why } of UNPARSEABLE) {
      assert.equal(safePushClickUrl(raw), '/', `must reject ${raw} (${why})`);
    }
  });

  it('does not treat lookalike hosts as first-party', () => {
    for (const { raw } of LOOKALIKE_HOSTS) {
      assert.equal(safePushClickUrl(raw), raw, `${raw} must stay absolute and off-origin`);
    }
  });
});

describe('safePushClickUrl — rejection logging', () => {
  let warnings;
  let originalWarn;

  beforeEach(() => {
    warnings = [];
    originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
  });
  afterEach(() => { console.warn = originalWarn; });

  it('logs a rejection with the reason and the user, like its sibling guards', () => {
    // Every other outbound-URL guard in this file logs when it rejects
    // (Slack/Discord/webhook). This one was the only silent guard, so a false
    // positive or a bypass regression left no breadcrumb anywhere — it would
    // surface only as "push links stopped working".
    safePushClickUrl('javascript:alert(1)', 'user_abc');
    assert.equal(warnings.length, 1, 'a rejected scheme must be logged');
    assert.match(warnings[0], /push click URL rejected/i);
    assert.match(warnings[0], /user_abc/);
  });

  it('does not log the ordinary missing-url default', () => {
    // Every plain brief_ready push omits a link. Logging that would be noise,
    // not signal.
    safePushClickUrl(undefined, 'user_abc');
    safePushClickUrl('', 'user_abc');
    assert.deepEqual(warnings, []);
  });
});

describe('relay -> service worker contract', () => {
  it('sendWebPush routes its click URL through the guard', () => {
    const { readFileSync } = require('node:fs');
    const src = readFileSync(require.resolve('../scripts/notification-relay.cjs'), 'utf-8');
    const fn = src.match(/async function sendWebPush\([\s\S]+?\n\}/);
    assert.ok(fn, 'sendWebPush must exist');
    assert.match(fn[0], /url: safePushClickUrl\(payload\.url, userId\)/,
      'sendWebPush must sanitize the click URL for every call site');
  });

  it('the relay dashboard fallback reuses the open tab on every serving origin', async () => {
    // THE assertion whose absence let the regression ship. Each suite used to
    // assert against its own fixture origin and neither crossed the boundary,
    // so the relay and the worker could disagree in production while both
    // stayed green. This drives the real handler with the real relay output.
    for (const origin of SERVING_ORIGINS) {
      const relayOutput = safePushClickUrl(undefined, 'user_abc');
      const box = makeSwSandbox(origin);
      const client = addWindowClient(box);
      loadHandlerInto(box);
      await clickNotification(box, { url: relayOutput });
      assert.equal(box.opened, null, `must not open a second tab on ${origin}`);
      assert.equal(client.navigated, '/', `must reuse the open dashboard tab on ${origin}`);
    }
  });

  it('a relay-emitted article link still gets its own tab', async () => {
    const relayOutput = safePushClickUrl('https://reuters.com/world/story', 'user_abc');
    const box = makeSwSandbox();
    const client = addWindowClient(box);
    loadHandlerInto(box);
    await clickNotification(box, { url: relayOutput });
    assert.equal(client.navigated, null, 'the dashboard tab is never handed an article');
    assert.equal(box.opened, 'https://reuters.com/world/story');
  });

  it('a relay-emitted apex-exempt target keeps its apex through the worker', async () => {
    const relayOutput = safePushClickUrl('https://worldmonitor.app/oauth/register', 'user_abc');
    const box = makeSwSandbox();
    const client = addWindowClient(box);
    loadHandlerInto(box);
    await clickNotification(box, { url: relayOutput });
    assert.equal(client.navigated, null, 'must not be navigated onto the serving origin');
    assert.equal(box.opened, 'https://worldmonitor.app/oauth/register');
  });
});

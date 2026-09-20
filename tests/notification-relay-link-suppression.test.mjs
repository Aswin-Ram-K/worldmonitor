/**
 * Failing-first proof for #8401, relay half: an event whose payload link is
 * operator-blocked must not reach any delivery channel.
 *
 * Drives the REAL `processEvent` from scripts/notification-relay.cjs (same
 * loader-stub pattern as notification-relay-telegram-retry.test.mjs) with a
 * stubbed Upstash SMEMBERS snapshot. Asserts:
 *   - blocked exact URL → zero channel sends + a [relay][link-suppressed]
 *     log line + a ZADD record on the suppression log key (blast-radius log);
 *   - blocked host → same;
 *   - unblocked link → delivery proceeds;
 *   - unreadable set (Redis down) → fail-open delivery + loud unreadable log.
 *
 * Run: node --test tests/notification-relay-link-suppression.test.mjs
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

process.env.UPSTASH_REDIS_REST_URL ??= 'https://stub.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN ??= 'stub-token';
process.env.CONVEX_URL ??= 'https://stub.convex.cloud';
process.env.CONVEX_NOTIFICATION_RELAY_SECRET ??= 'stub-secret';
process.env.TELEGRAM_BOT_TOKEN ??= 'stub-bot-token';

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, ...rest) {
  if (request === 'resend') return { Resend: class {} };
  if (request === 'convex/browser') {
    return { ConvexHttpClient: class { async query() {} } };
  }
  return originalLoad.call(this, request, parent, ...rest);
};

let relay;
let originalFetch;

before(() => {
  relay = require(resolve(__dirname, '..', 'scripts', 'notification-relay.cjs'));
  for (const name of ['processEvent', 'eventLinks', 'BLOCKED_LINKS_KEY', 'BLOCKED_LINKS_LOG_KEY', '__resetBlockedLinkCacheForTests']) {
    assert.ok(relay[name] !== undefined, `${name} export missing from notification-relay.cjs`);
  }
});

beforeEach(() => {
  originalFetch = globalThis.fetch;
  relay.__resetBlockedLinkCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const EVIL = 'https://evil.example/phish?x=1';

// Monotonic nonce so every processEvent call in this file uses a distinct
// title. The relay's per-user dedup keys on eventType+title, and the stub
// Upstash below returns miss/null for every SET NX — but the relay also
// keeps no in-process state across harnesses, so without distinct titles a
// second test replays the first test's dedup key and drops as a duplicate.
let eventSeq = 0;

function makeEvent(link = EVIL) {
  eventSeq++;
  return {
    eventType: 'rss_alert',
    severity: 'critical',
    payload: { title: `Verify your account #${eventSeq}`, source: 'WorldMonitor Security', link },
  };
}

let harnessSeq = 0;

function installHarness({ smembers = [], smembersOk = true, pipelineOk = true } = {}) {
  const calls = { telegram: 0, pipeline: [], smembers: 0 };
  const logs = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args) => { logs.push(args.join(' ')); };
  console.warn = (...args) => { logs.push(args.join(' ')); };
  // Dedup keys are per-user+title: give each test a unique title so the
  // shared stub-Upstash dedup (which returns miss/null for every SET NX)
  // cannot leak a "hit" across tests. Titles carry a per-harness nonce.
  const nonce = `t${++harnessSeq}`;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/relay/enabled-rules')) {
      return { ok: true, json: async () => [{ userId: 'user-1', digestMode: 'realtime', eventTypes: [], sensitivity: 'all', countries: [], tickers: [], channels: ['telegram'], variant: 'full' }] };
    }
    if (u.includes('/relay/entitlement')) {
      return { ok: true, json: async () => ({ tier: 1 }) };
    }
    if (u.includes('/relay/channels')) {
      return { ok: true, json: async () => [{ channelType: 'telegram', verified: true, telegramOwnership: 'verified_callback', chatId: 'chat-1' }] };
    }
    if (u.includes('api.telegram.org')) {
      calls.telegram++;
      return { status: 200, ok: true, json: async () => ({ ok: true }) };
    }
    if (u.endsWith(`/SMEMBERS/${encodeURIComponent(relay.BLOCKED_LINKS_KEY)}`)) {
      calls.smembers++;
      if (!smembersOk) return { ok: false, status: 500 };
      return { ok: true, json: async () => ({ result: smembers }) };
    }
    if (u.endsWith('/pipeline')) {
      let body = [];
      try { body = JSON.parse(opts.body); } catch { /* keep empty */ }
      calls.pipeline.push(body);
      return { ok: pipelineOk, status: pipelineOk ? 200 : 500, json: async () => [] };
    }
    // Upstash generic REST (GET/SET for entitlement cache, dedup SET NX).
    // Dedup MUST report "new" (Upstash "OK") — the relay's fail-open
    // fallback treats anything else as a duplicate on the second call.
    if (u.includes('/SET/')) {
      return { ok: true, json: async () => ({ result: 'OK' }) };
    }
    return { ok: true, json: async () => ({ result: null }) };
  };
  return {
    calls,
    logs,
    restore() { console.log = origLog; console.warn = origWarn; },
  };
}

describe('notification-relay link suppression (#8401)', () => {
  it('drops a blocked exact-URL event before any channel send, and logs the blast radius', async () => {
    const h = installHarness({ smembers: [EVIL] });
    try {
      await relay.processEvent(makeEvent());
      assert.equal(h.calls.telegram, 0, 'blocked link must not reach Telegram');
      assert.ok(h.logs.some((l) => l.includes('[relay][link-suppressed]')), 'must log [relay][link-suppressed]');
      const zadds = h.calls.pipeline.flat().filter((cmd) => cmd[0] === 'ZADD' && cmd[1] === relay.BLOCKED_LINKS_LOG_KEY);
      assert.equal(zadds.length, 1, 'must ZADD one suppression record for incident scoping');
      const record = JSON.parse(zadds[0][3]);
      assert.equal(record.eventType, 'rss_alert');
      assert.ok(Array.isArray(record.link) && record.link[0].includes('evil.example'), 'record must carry the suppressed link');
      assert.equal(record.suppressedChannels, 1);
    } finally {
      h.restore();
    }
  });

  it('drops events matching a host: entry, including subdomains', async () => {
    const h = installHarness({ smembers: ['host:evil.example'] });
    try {
      await relay.processEvent(makeEvent('https://www.evil.example/other'));
      assert.equal(h.calls.telegram, 0, 'host-blocked link must not reach Telegram');
      assert.ok(h.logs.some((l) => l.includes('[relay][link-suppressed]')));
    } finally {
      h.restore();
    }
  });

  it('delivers when the link is not blocked', async () => {
    const h = installHarness({ smembers: ['https://other.example/unrelated'] });
    try {
      await relay.processEvent(makeEvent());
      assert.equal(h.calls.telegram, 1, 'unblocked link must still deliver');
      assert.ok(!h.logs.some((l) => l.includes('[relay][link-suppressed]')));
    } finally {
      h.restore();
    }
  });

  it('delivers events with no link without consulting the set', async () => {
    const h = installHarness({ smembers: [EVIL] });
    try {
      const event = makeEvent();
      delete event.payload.link;
      await relay.processEvent(event);
      assert.equal(h.calls.smembers, 0, 'linkless events must skip the SMEMBERS read');
      assert.equal(h.calls.telegram, 1, 'linkless events must still deliver');
    } finally {
      h.restore();
    }
  });

  it('fails open with a loud log when the set is unreadable', async () => {
    const h = installHarness({ smembersOk: false });
    try {
      await relay.processEvent(makeEvent());
      assert.equal(h.calls.telegram, 1, 'unreadable set must fail open to delivery');
      assert.ok(h.logs.some((l) => l.includes('[relay][link-suppressed-unreadable]')), 'must log the unreadable control loudly');
      assert.ok(!h.logs.some((l) => l.includes('[relay][link-suppressed] ')), 'must not log a suppression that did not happen');
    } finally {
      h.restore();
    }
  });

  it('negative-caches the unreadable set within the TTL window (no hot loop)', async () => {
    const h = installHarness({ smembersOk: false });
    try {
      await relay.processEvent(makeEvent());
      await relay.processEvent(makeEvent());
      assert.equal(h.calls.smembers, 1, 'second event inside the TTL must reuse the negative cache');
      const unreadableLogs = h.logs.filter((l) => l.includes('[relay][link-suppressed-unreadable]'));
      assert.equal(unreadableLogs.length, 1, 'unreadable control must log once per TTL window, not per event');
    } finally {
      h.restore();
    }
  });
});

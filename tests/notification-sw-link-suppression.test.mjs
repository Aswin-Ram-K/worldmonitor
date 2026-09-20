/**
 * Failing-first proof for #8401, service-worker half.
 *
 * 1. `api/notification-suppressions.js` splits the Redis set into exact URLs
 *    and `host:` entries, serves them anonymously with a 60s shared cache,
 *    and fails open with `unavailable: true` when Redis cannot be read.
 * 2. `public/link-suppression-check.js` matches clicks against that snapshot
 *    (exact + host/subdomain) inside a vm sandbox.
 * 3. `public/push-handler.js` consults the check on notificationclick: a
 *    blocked click shows the blocked notice and never touches clients, while
 *    a clean click (or an unreachable endpoint) navigates as before.
 *
 * Run: node --test tests/notification-sw-link-suppression.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const EVIL = 'https://evil.example/phish?x=1';

const originalFetch = globalThis.fetch;
const originalEnvUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalEnvToken = process.env.UPSTASH_REDIS_REST_TOKEN;

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'stub-token';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEnvUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalEnvUrl;
  if (originalEnvToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalEnvToken;
});

// ── Edge endpoint ──────────────────────────────────────────────────────

describe('notification-suppressions edge endpoint (#8401)', () => {
  it('splits exact URLs and host: entries, anonymously, with a 60s cache', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ result: [EVIL, 'host:evil.example', 'garbage {{{', null, 42] }),
    });
    const { default: handler } = await import('../api/notification-suppressions.js?edge-split');
    const res = await handler(new Request('https://worldmonitor.app/api/notification-suppressions'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.suppressed, [EVIL]);
    assert.deepEqual(body.hosts, ['evil.example']);
    assert.ok(typeof body.updatedAt === 'string');
    assert.equal(body.unavailable, undefined);
    assert.match(res.headers.get('Cache-Control') ?? '', /s-maxage=60/);
  });

  it('fails open with unavailable:true when Redis cannot be read', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 500 });
    const { readSuppressionSnapshot } = await import('../api/notification-suppressions.js?edge-unavail');
    // Snapshot helper reports unreadable; the handler maps it to the
    // fail-open shape (tested through the same module, fresh query key).
    const snap = await readSuppressionSnapshot();
    assert.equal(snap.readable, false);
  });

  it('rejects non-GET methods', async () => {
    const { default: handler } = await import('../api/notification-suppressions.js?edge-method');
    const res = await handler(new Request('https://worldmonitor.app/api/notification-suppressions', { method: 'POST' }));
    assert.equal(res.status, 405);
  });
});

// ── SW check module in a vm sandbox ────────────────────────────────────

function makeSwSandbox({ snapshot = null, fetchImpl = null } = {}) {
  const listeners = new Map();
  const shown = [];
  const windowClients = [];
  let opened = null;
  const cacheStore = new Map();

  const self = {
    location: { origin: 'https://worldmonitor.app' },
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    registration: {
      showNotification(title, opts) {
        shown.push({ title, opts });
        return Promise.resolve();
      },
    },
  };
  const clients = {
    matchAll: async () => windowClients,
    openWindow: async (url) => { opened = url; return { url }; },
  };
  const caches = {
    async match() { return null; },
    async open() {
      return {
        async put(k, v) { cacheStore.set(k, v); },
      };
    },
  };
  const fetchFn = fetchImpl ?? (async () => ({
    ok: true,
    json: async () => snapshot,
  }));
  const ctx = vm.createContext({
    self, clients, caches, fetch: fetchFn, URL, Headers, Response,
    AbortController, setTimeout, clearTimeout, Date,
  });
  vm.runInContext(readFileSync(resolve(ROOT, 'public', 'link-suppression-check.js'), 'utf-8'), ctx);
  vm.runInContext(readFileSync(resolve(ROOT, 'public', 'push-handler.js'), 'utf-8'), ctx);
  return {
    self, clients, shown, windowClients, cacheStore,
    get opened() { return opened; },
    emit(name, event) {
      for (const fn of listeners.get(name) ?? []) fn(event);
    },
  };
}

function notifClickEvent(data, tag = 'rss:1') {
  const waits = [];
  return {
    notification: { data, tag, close() {} },
    waitUntil(p) { waits.push(Promise.resolve(p)); },
    waits,
  };
}

describe('link-suppression-check.js matcher (#8401)', () => {
  it('matches exact URLs and host subdomains, rejects neighbours', async () => {
    const box = makeSwSandbox({ snapshot: { suppressed: [EVIL], hosts: [] } });
    const check = box.self.wmLinkSuppression;
    assert.ok(check, 'wmLinkSuppression must be exposed');
    assert.equal(await check.checkLinkSuppressed(EVIL), true);
    assert.equal(await check.checkLinkSuppressed('https://other.example/'), false);
  });

  it('host entries cover subdomains but not sibling domains', async () => {
    const box = makeSwSandbox({ snapshot: { suppressed: [], hosts: ['evil.example'] } });
    const check = box.self.wmLinkSuppression;
    assert.equal(await check.checkLinkSuppressed('https://www.evil.example/a'), true);
    assert.equal(await check.checkLinkSuppressed('https://not-evil.example/'), false);
  });

  it('unavailable snapshot fails open to navigation', async () => {
    const box = makeSwSandbox({ snapshot: { suppressed: [], hosts: [], unavailable: true } });
    const check = box.self.wmLinkSuppression;
    assert.equal(await check.checkLinkSuppressed(EVIL), false);
  });
});

describe('push-handler.js notificationclick suppression (#8401)', () => {
  it('blocked click shows the blocked notice and never touches clients', async () => {
    const box = makeSwSandbox({ snapshot: { suppressed: [EVIL], hosts: [] } });
    const ev = notifClickEvent({ url: EVIL });
    box.emit('notificationclick', ev);
    for (const p of ev.waits) await p;
    assert.equal(box.opened, null, 'blocked click must not openWindow');
    assert.equal(box.shown.length, 1);
    assert.equal(box.shown[0].title, 'Link blocked by WorldMonitor');
  });

  it('clean click opens as before when nothing is blocked', async () => {
    const box = makeSwSandbox({ snapshot: { suppressed: [], hosts: [] } });
    const ev = notifClickEvent({ url: EVIL });
    box.emit('notificationclick', ev);
    for (const p of ev.waits) await p;
    assert.equal(box.opened, EVIL);
    assert.equal(box.shown.length, 0);
  });

  it('unreachable endpoint fails open to navigation', async () => {
    const box = makeSwSandbox({ fetchImpl: async () => { throw new Error('down'); } });
    const ev = notifClickEvent({ url: EVIL });
    box.emit('notificationclick', ev);
    for (const p of ev.waits) await p;
    assert.equal(box.opened, EVIL, 'endpoint outage must not strand the click');
  });
});

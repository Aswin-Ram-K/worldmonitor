/**
 * Gateway-level regression tests for LeadsService public access.
 *
 * Regression: the enterprise contact form on the /pro marketing page POSTs
 * to /api/leads/v1/submit-contact with NO credentials (no wms_ session, no
 * API key) — by design, since the audience is anonymous prospects. The
 * gateway 401'd these requests because the leads paths were missing from
 * PUBLIC_NO_AUTH_RPC_PATHS, so the handler's own anti-abuse stack
 * (server-side Turnstile, honeypot, free-email rejection, per-IP and
 * per-email rate limits) never ran. Same class of breakage for
 * register-interest, which the desktop runtime deliberately calls key-free
 * (src/services/runtime.ts isKeyFreeApiTarget).
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { installRedis } from './helpers/fake-upstash-redis.mts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.keys(process.env).forEach((k) => {
    if (!(k in originalEnv)) delete process.env[k];
  });
  Object.assign(process.env, originalEnv);
});

async function loadLeadsGateway({ withRedis = true }: { withRedis?: boolean } = {}) {
  const [{ createDomainGateway, PUBLIC_NO_AUTH_RPC_PATHS, serverOptions }, generated, { leadsHandler }, { PREMIUM_RPC_PATHS }] = await Promise.all([
    import('../server/gateway.ts'),
    import('../src/generated/server/worldmonitor/leads/v1/service_server.ts'),
    import('../server/worldmonitor/leads/v1/handler.ts'),
    import('../src/shared/premium-paths.ts'),
  ]);
  delete process.env.WORLDMONITOR_VALID_KEYS;
  // The endpoint rate limiter fails closed (503) when Redis is unconfigured;
  // install the fake so the request reaches the handler like in production.
  // `withRedis: false` deliberately omits it to assert that fail-closed
  // behavior is still intact for these routes (see the #8385 case below).
  if (withRedis) {
    installRedis({});
  } else {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
  return {
    PUBLIC_NO_AUTH_RPC_PATHS,
    PREMIUM_RPC_PATHS,
    gateway: createDomainGateway(generated.createLeadsServiceRoutes(leadsHandler, serverOptions)),
  };
}

describe('leads gateway public access', { concurrency: 1 }, () => {
  it('declares both leads RPCs public-no-auth and non-premium', async () => {
    const { PUBLIC_NO_AUTH_RPC_PATHS, PREMIUM_RPC_PATHS } = await loadLeadsGateway();
    assert.equal(PUBLIC_NO_AUTH_RPC_PATHS.has('/api/leads/v1/submit-contact'), true);
    assert.equal(PUBLIC_NO_AUTH_RPC_PATHS.has('/api/leads/v1/register-interest'), true);
    assert.equal(PREMIUM_RPC_PATHS.has('/api/leads/v1/submit-contact'), false);
    assert.equal(PREMIUM_RPC_PATHS.has('/api/leads/v1/register-interest'), false);
  });

  it('accepts an anonymous submit-contact POST (no API key, no session token)', async () => {
    const { gateway } = await loadLeadsGateway();

    // Honeypot-filled body: the handler short-circuits to a silent success
    // without touching Turnstile/Convex/Resend, so this exercises ONLY the
    // gateway auth pipeline — exactly the layer that regressed.
    const res = await gateway(new Request('https://api.worldmonitor.app/api/leads/v1/submit-contact', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://worldmonitor.app',
      },
      body: JSON.stringify({
        email: 'lead@example-corp.com',
        name: 'Lead',
        organization: 'ExampleCorp',
        phone: '+1 555 123 4567',
        message: 'hello',
        source: 'enterprise-contact',
        website: 'http://honeypot-filled.example',
        // The generated request validator requires a non-empty token; the
        // honeypot still short-circuits before the handler verifies it.
        turnstileToken: 'test-token',
      }),
    }));

    assert.notEqual(res.status, 401, 'gateway must not 401 anonymous contact submissions');
    const bodyText = await res.text();
    assert.equal(res.status, 200, bodyText);
    const body = JSON.parse(bodyText) as { status?: string };
    assert.equal(body.status, 'sent');
  });

  it('accepts an anonymous register-interest POST (no API key, no session token)', async () => {
    const { gateway } = await loadLeadsGateway();

    // Same honeypot short-circuit as submit-contact: registerInterest returns
    // a silent success before Turnstile/desktop-HMAC/Convex, isolating the
    // gateway auth layer for the waitlist path too.
    const res = await gateway(new Request('https://api.worldmonitor.app/api/leads/v1/register-interest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://worldmonitor.app',
      },
      body: JSON.stringify({
        email: 'lead@example-corp.com',
        source: 'pro-waitlist',
        website: 'http://honeypot-filled.example',
        turnstileToken: '',
      }),
    }));

    assert.notEqual(res.status, 401, 'gateway must not 401 anonymous waitlist signups');
    assert.equal(res.status, 200);
    const body = await res.json() as { status?: string };
    assert.equal(body.status, 'registered');
  });

  // #8385: the gateway's CDN-shield opt-out must not reach these routes.
  //
  // Being PUBLIC_NO_AUTH means "reachable without a credential", NOT "safe to
  // fail open". Both routes write to Convex and send email, the registry pins
  // them fail-closed at 3/h and 5/h, the global fallback limiter is skipped for
  // any path that already has an endpoint policy, and neither handler has an
  // in-handler per-IP cap on its public path (register-interest's scoped limit
  // guards only the desktop HMAC source). So the endpoint limiter is the ONLY
  // per-IP bound, and it has to survive a Redis outage as a 503.
  //
  // This goes red if the opt-out is keyed on the AUTH predicate
  // (isPublicNoAuthRpc) instead of the CDN-shielded `public=1` SHAPE
  // (isPublicSharedRpcRequest) — the request sails through to a 200 instead.
  for (const [pathname, body] of [
    ['/api/leads/v1/submit-contact', {
      email: 'lead@example-corp.com',
      name: 'Lead',
      organization: 'ExampleCorp',
      message: 'hello',
      source: 'enterprise-contact',
      website: 'http://honeypot-filled.example',
      turnstileToken: 'test-token',
    }],
    ['/api/leads/v1/register-interest', {
      email: 'lead@example-corp.com',
      source: 'pro-waitlist',
      website: 'http://honeypot-filled.example',
      turnstileToken: '',
    }],
  ] as const) {
    it(`${pathname} still fails closed (503) when Redis is unavailable`, async () => {
      const { gateway } = await loadLeadsGateway({ withRedis: false });

      const res = await gateway(new Request(`https://api.worldmonitor.app${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://worldmonitor.app' },
        body: JSON.stringify(body),
      }));

      assert.equal(
        res.status,
        503,
        `${pathname} must fail closed on a Redis outage — it is the only per-IP bound on an anonymous route that writes to Convex and sends email`,
      );
      assert.equal(res.headers.get('X-RateLimit-Mode'), 'degraded');
    });
  }
});

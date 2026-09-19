/**
 * Unit + gateway tests for the generic REST batch endpoint
 * (POST /api/batch/v1/execute, server/worldmonitor/batch/v1/execute-batch.ts).
 *
 * The handler re-dispatches each operation as a same-origin GET through the
 * public gateway, so the security posture rests on four invariants pinned
 * here:
 *   1. only same-origin, documented-RPC-shaped paths are fetched (SSRF guard);
 *   2. only credential/negotiation headers cross into sub-requests — cookies
 *      and gateway trust markers (x-user-id) never do;
 *   3. a batch can never recurse (marker header + /api/batch/* path both
 *      refuse);
 *   4. the endpoint itself is NOT public — anonymous callers get 401 from the
 *      gateway before the fan-out runs;
 *   5. every sub-operation is charged to the BATCH CALLER's own rate-limit
 *      bucket before dispatch. The sub-request's own gateway pass keys its
 *      limits to the platform's fetch egress IP, so without this pre-charge a
 *      batch is a per-IP quota bypass.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  createExecuteBatch,
  BATCH_MARKER_HEADER,
  MAX_BATCH_OPERATIONS,
  MAX_SUB_RESPONSE_BYTES,
} from '../server/worldmonitor/batch/v1/execute-batch.ts';
import type { FetchLike } from '../server/worldmonitor/batch/v1/execute-batch.ts';
import {
  __resetRateLimitForTest,
  hasEndpointRatePolicy,
  TRUSTED_RATE_LIMIT_PRINCIPAL_HEADER,
} from '../server/_shared/rate-limit.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';

const ORIGIN = 'https://www.worldmonitor.app';
const CALLER_IP = '203.0.113.9';

function makeCtx(headers: Record<string, string> = {}) {
  const request = new Request(`${ORIGIN}/api/batch/v1/execute`, {
    method: 'POST',
    headers: { 'x-real-ip': CALLER_IP, ...headers },
  });
  return { request, pathParams: {}, headers: Object.fromEntries(request.headers.entries()) };
}

type RecordedCall = { url: string; init: RequestInit };

function recordingFetch(
  respond: (url: string) => Response | Promise<Response> = () =>
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
): { calls: RecordedCall[]; fetchImpl: FetchLike } {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    return respond(url);
  };
  return { calls, fetchImpl };
}

describe('executeBatch handler', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // The pre-dispatch caller charge is a real limiter call. The shared fake is
    // always-allow, so these tests exercise the admitted path; the refusal
    // paths install their own transport below.
    __resetRateLimitForTest();
    installRedis({});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    __resetRateLimitForTest();
  });

  it('fans out operations as same-origin GETs and aggregates results in order', async () => {
    const { calls, fetchImpl } = recordingFetch((url) =>
      url.includes('get-fear-greed-index')
        ? new Response(JSON.stringify({ compositeScore: 42 }), { status: 200 })
        : new Response(JSON.stringify({ message: 'not found' }), { status: 404 }),
    );
    const executeBatch = createExecuteBatch(fetchImpl);

    const res = await executeBatch(makeCtx(), {
      operations: [
        { id: 'fg', path: '/api/market/v1/get-fear-greed-index' },
        { id: '', path: '/api/market/v1/list-market-quotes' },
      ],
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.url, `${ORIGIN}/api/market/v1/get-fear-greed-index`);
    assert.equal(calls[0]!.init.method, 'GET');
    assert.deepEqual(res.results[0], { id: 'fg', status: 200, body: { compositeScore: 42 }, error: '' });
    // Blank id defaults to the zero-based index.
    assert.equal(res.results[1]!.id, '1');
    assert.equal(res.results[1]!.status, 404);
    assert.equal(res.succeeded, 1);
    assert.equal(res.failed, 1);
  });

  it('preserves query strings (filters + jmespath projections) on sub-requests', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const executeBatch = createExecuteBatch(fetchImpl);

    await executeBatch(makeCtx(), {
      operations: [{ id: 'r', path: '/api/intelligence/v1/get-country-risk?country=DE&jmespath=score' }],
    });

    assert.equal(calls[0]!.url, `${ORIGIN}/api/intelligence/v1/get-country-risk?country=DE&jmespath=score`);
  });

  it('forwards only credential/negotiation headers and stamps the batch marker', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const executeBatch = createExecuteBatch(fetchImpl);

    await executeBatch(
      makeCtx({
        Authorization: 'Bearer wm_deadbeef',
        'X-WorldMonitor-Key': 'wm_cafebabe',
        Cookie: 'session=secret',
        'x-user-id': 'user_123',
        'User-Agent': 'my-agent/2.0',
      }),
      { operations: [{ id: 'a', path: '/api/market/v1/get-fear-greed-index' }] },
    );

    const sent = new Headers(calls[0]!.init.headers as HeadersInit);
    assert.equal(sent.get('authorization'), 'Bearer wm_deadbeef');
    assert.equal(sent.get('x-worldmonitor-key'), 'wm_cafebabe');
    assert.equal(sent.get(BATCH_MARKER_HEADER), '1');
    assert.equal(sent.get('accept'), 'application/json');
    assert.equal(sent.get('user-agent'), 'my-agent/2.0');
    // Cookies and gateway trust markers must never cross into sub-requests.
    assert.equal(sent.get('cookie'), null);
    assert.equal(sent.get('x-user-id'), null);
  });

  it('sends a descriptive default User-Agent when the caller omits one (CF WAF rejects generic UAs)', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const executeBatch = createExecuteBatch(fetchImpl);

    await executeBatch(makeCtx(), { operations: [{ id: 'a', path: '/api/market/v1/get-fear-greed-index' }] });

    const sent = new Headers(calls[0]!.init.headers as HeadersInit);
    assert.match(sent.get('user-agent') ?? '', /WorldMonitor-Batch/);
  });

  it('rejects non-RPC and cross-origin paths per-operation without fetching', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const executeBatch = createExecuteBatch(fetchImpl);

    const res = await executeBatch(makeCtx(), {
      operations: [
        { id: 'abs', path: 'https://evil.com/api/market/v1/get-fear-greed-index' },
        { id: 'scheme-rel', path: '//evil.com/api/market/v1/get-fear-greed-index' },
        { id: 'no-slash', path: 'api/market/v1/get-fear-greed-index' },
        { id: 'not-rpc', path: '/api/mcp' },
        { id: 'upper', path: '/API/market/v1/get-fear-greed-index' },
        { id: 'ok', path: '/api/v2/shipping/route-intelligence' },
      ],
    });

    // Only the valid v2 path reached fetch.
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, `${ORIGIN}/api/v2/shipping/route-intelligence`);
    for (const bad of res.results.slice(0, 5)) {
      assert.equal(bad.status, 0);
      assert.equal(bad.error, 'invalid_path');
    }
    assert.equal(res.failed, 5);
  });

  it('refuses nested batches: batched /api/batch/* paths and marked inbound requests', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const executeBatch = createExecuteBatch(fetchImpl);

    const res = await executeBatch(makeCtx(), {
      operations: [{ id: 'n', path: '/api/batch/v1/execute' }],
    });
    assert.equal(calls.length, 0);
    assert.deepEqual(res.results[0], { id: 'n', status: 0, error: 'nested_batch' });

    await assert.rejects(
      executeBatch(makeCtx({ [BATCH_MARKER_HEADER]: '1' }), {
        operations: [{ id: 'a', path: '/api/market/v1/get-fear-greed-index' }],
      }),
      (err: Error & { statusCode?: number }) => err.name === 'ApiError' && err.statusCode === 400,
    );
  });

  it('rejects empty, oversized, and duplicate-id batches with a ValidationError', async () => {
    const executeBatch = createExecuteBatch(recordingFetch().fetchImpl);

    await assert.rejects(
      executeBatch(makeCtx(), { operations: [] }),
      (err: Error) => err.name === 'ValidationError',
    );
    await assert.rejects(
      executeBatch(makeCtx(), {
        operations: Array.from({ length: MAX_BATCH_OPERATIONS + 1 }, (_, i) => ({
          id: String(i),
          path: '/api/market/v1/get-fear-greed-index',
        })),
      }),
      (err: Error) => err.name === 'ValidationError',
    );
    await assert.rejects(
      executeBatch(makeCtx(), {
        operations: [
          { id: 'dup', path: '/api/market/v1/get-fear-greed-index' },
          { id: 'dup', path: '/api/market/v1/list-market-quotes' },
        ],
      }),
      (err: Error) => err.name === 'ValidationError',
    );
  });

  it('maps transport failures to per-operation error codes', async () => {
    const timeoutErr = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const executeBatch = createExecuteBatch(async (url) => {
      if (url.includes('list-market-quotes')) throw timeoutErr;
      if (url.includes('get-fear-greed-index')) throw new TypeError('fetch failed');
      return new Response('not json at all', { status: 200 });
    });

    const res = await executeBatch(makeCtx(), {
      operations: [
        { id: 'to', path: '/api/market/v1/list-market-quotes' },
        { id: 'net', path: '/api/market/v1/get-fear-greed-index' },
        { id: 'bad', path: '/api/market/v1/list-crypto-quotes' },
      ],
    });

    assert.deepEqual(res.results[0], { id: 'to', status: 0, error: 'timeout' });
    assert.deepEqual(res.results[1], { id: 'net', status: 0, error: 'fetch_failed' });
    assert.equal(res.results[2]!.error, 'invalid_json');
    assert.equal(res.results[2]!.status, 200);
    assert.equal(res.succeeded, 0);
    assert.equal(res.failed, 3);
  });

  it('charges every sub-operation to the CALLER\'s bucket, not the platform egress', async () => {
    // The limiter key proves attribution: it must carry the sub-operation's
    // own path AND the inbound caller's IP. A key derived inside the
    // re-dispatched sub-request would carry the platform's egress IP instead.
    const redis = installRedis({});
    const base = redis.fetchImpl;
    let admissions = 0;
    const keys: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      admissions += [...body.matchAll(/evalsha/gi)].length;
      // Concurrent limiter calls are auto-pipelined into one HTTP request, and
      // the sliding window touches two window keys per admission — so count
      // EVALSHA commands and assert separately on the key SHAPE.
      for (const match of body.matchAll(/"(rl:[^"]+)"/g)) keys.push(match[1]!);
      return base(input, init);
    }) as typeof fetch;

    const { calls, fetchImpl } = recordingFetch();
    const executeBatch = createExecuteBatch(fetchImpl);

    await executeBatch(makeCtx(), {
      operations: [
        { id: 'a', path: '/api/market/v1/list-market-quotes' },
        { id: 'b', path: '/api/market/v1/list-market-quotes?symbols=AAPL' },
      ],
    });

    assert.equal(calls.length, 2, 'admitted operations still dispatch');
    assert.equal(admissions, 2, 'each operation charges its own admission');
    assert.ok(keys.length > 0, 'the caller charge must reach the limiter');
    for (const key of keys) {
      assert.match(
        key,
        new RegExp(`^rl:ep:/api/market/v1/list-market-quotes:ip:${CALLER_IP}(:|$)`),
        `limiter key must name the sub-operation path and the caller's identity, got ${key}`,
      );
    }
  });

  it('refuses a policy-backed sub-operation without dispatching when the limiter is unavailable', async () => {
    // The endpoint registry fails closed by design; that posture has to extend
    // to batch fan-out, or the batch becomes the way around it during an
    // Upstash outage.
    const policyPath = '/api/market/v1/list-market-quotes';
    const unguardedPath = '/api/market/v1/get-fear-greed-index';
    assert.equal(hasEndpointRatePolicy(policyPath), true);
    assert.equal(hasEndpointRatePolicy(unguardedPath), false);

    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    __resetRateLimitForTest();

    const { calls, fetchImpl } = recordingFetch();
    const executeBatch = createExecuteBatch(fetchImpl);

    const res = await executeBatch(makeCtx(), {
      operations: [
        { id: 'guarded', path: policyPath },
        { id: 'unguarded', path: unguardedPath },
      ],
    });

    assert.equal(res.results[0]!.status, 503);
    assert.deepEqual(res.results[0]!.body, { error: 'Rate-limit service temporarily unavailable' });
    // The global fallback stays availability-first, exactly as at the gateway.
    assert.equal(res.results[1]!.status, 200);
    assert.deepEqual(calls.map((call) => call.url), [`${ORIGIN}${unguardedPath}`]);
  });

  it('returns the 429 a direct call would have received, without dispatching', async () => {
    const redis = installRedis({});
    const base = redis.fetchImpl;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await base(input, init);
      const commands = JSON.parse(typeof init?.body === 'string' ? init.body : 'null');
      if (!Array.isArray(commands) || !Array.isArray(commands[0])) return response;
      const results = await response.json();
      for (let i = 0; i < commands.length; i += 1) {
        // The shared fake is always-allow; model an exhausted window instead.
        if (String(commands[i][0]).toUpperCase() === 'EVALSHA') {
          results[i] = { result: [-1, Date.now() + 60_000] };
        }
      }
      return Response.json(results);
    }) as typeof fetch;
    __resetRateLimitForTest();

    const { calls, fetchImpl } = recordingFetch();
    const executeBatch = createExecuteBatch(fetchImpl);

    const res = await executeBatch(makeCtx(), {
      operations: [{ id: 'over', path: '/api/market/v1/list-market-quotes' }],
    });

    assert.equal(calls.length, 0, 'a refused operation must never reach the gateway');
    assert.equal(res.results[0]!.status, 429);
    assert.deepEqual(res.results[0]!.body, { error: 'Too many requests' });
    assert.equal(res.succeeded, 0);
    assert.equal(res.failed, 1);
  });

  it('charges the gateway-stamped principal, not a guess from raw credential headers', async () => {
    // The gateway stamps the principal it actually charged. A raw `wm_` header
    // is unvalidated, so inferring `api_key` from it would let a session caller
    // select the separate api_key bucket and split traffic across two budgets.
    const redis = installRedis({});
    const base = redis.fetchImpl;
    const keys: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      for (const match of body.matchAll(/"(rl:[^"]+)"/g)) keys.push(match[1]!);
      return base(input, init);
    }) as typeof fetch;

    const { calls, fetchImpl } = recordingFetch();
    const executeBatch = createExecuteBatch(fetchImpl);

    await executeBatch(
      makeCtx({
        [TRUSTED_RATE_LIMIT_PRINCIPAL_HEADER]: 'api_key:user_stamped',
        // Deliberately contradicts the stamp; the handler must ignore it.
        'X-WorldMonitor-Key': 'wm_unvalidated',
      }),
      { operations: [{ id: 'a', path: '/api/market/v1/list-market-quotes' }] },
    );

    assert.ok(keys.length > 0, 'the caller charge must reach the limiter');
    for (const key of keys) {
      assert.match(key, /:apikey-user:user_stamped(:|$)/, `expected the stamped principal, got ${key}`);
      assert.ok(!key.includes(CALLER_IP), 'a stamped principal must not fall back to IP');
    }
    // The trust marker is gateway-internal and must never cross into a sub-request.
    const sent = new Headers(calls[0]!.init.headers as HeadersInit);
    assert.equal(sent.get(TRUSTED_RATE_LIMIT_PRINCIPAL_HEADER), null);
  });

  it('falls back to the caller IP when the stamped principal is absent or malformed', async () => {
    const redis = installRedis({});
    const base = redis.fetchImpl;
    const keys: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      for (const match of body.matchAll(/"(rl:[^"]+)"/g)) keys.push(match[1]!);
      return base(input, init);
    }) as typeof fetch;

    const executeBatch = createExecuteBatch(recordingFetch().fetchImpl);

    // An unknown scope must not become a principal — it degrades to IP, never
    // to an attacker-named bucket.
    await executeBatch(
      makeCtx({ [TRUSTED_RATE_LIMIT_PRINCIPAL_HEADER]: 'enterprise:user_forged' }),
      { operations: [{ id: 'a', path: '/api/market/v1/list-market-quotes' }] },
    );

    assert.ok(keys.length > 0, 'the caller charge must reach the limiter');
    for (const key of keys) {
      assert.ok(key.includes(`:ip:${CALLER_IP}`), `expected an IP bucket, got ${key}`);
      assert.ok(!key.includes('user_forged'), 'an unrecognised scope must not name the bucket');
    }
  });

  it('caps per-operation response size via Content-Length', async () => {
    const executeBatch = createExecuteBatch(async () =>
      new Response('{}', {
        status: 200,
        headers: { 'Content-Length': String(MAX_SUB_RESPONSE_BYTES + 1) },
      }),
    );

    const res = await executeBatch(makeCtx(), {
      operations: [{ id: 'big', path: '/api/market/v1/get-fear-greed-index' }],
    });

    assert.equal(res.results[0]!.error, 'response_too_large');
    assert.equal(res.failed, 1);
  });
});

describe('batch gateway access', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  it('strips a client-supplied rate-limit principal before the fan-out charges it', async () => {
    // The stamp is gateway-internal. If an inbound copy survived to the
    // handler, any caller could name the bucket their batch is charged to.
    const [{ createDomainGateway, serverOptions }, generated, { batchHandler }] = await Promise.all([
      import('../server/gateway.ts'),
      import('../src/generated/server/worldmonitor/batch/v1/service_server.ts'),
      import('../server/worldmonitor/batch/v1/handler.ts'),
    ]);
    delete process.env.WORLDMONITOR_VALID_KEYS;
    process.env.WM_SESSION_SECRET = 'synthetic-batch-principal-secret-at-least-32-bytes';
    const redis = installRedis({});
    __resetRateLimitForTest();
    const { issueSessionToken } = await import('../api/_session.js');

    const keys: string[] = [];
    const base = redis.fetchImpl;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/market/v1/')) {
        return Response.json({ ok: true });
      }
      const body = typeof init?.body === 'string' ? init.body : '';
      for (const match of body.matchAll(/"(rl:[^"]+)"/g)) keys.push(match[1]!);
      return base(input, init);
    }) as typeof fetch;

    const token = (await issueSessionToken()).token;
    const gateway = createDomainGateway(generated.createBatchServiceRoutes(batchHandler, serverOptions));
    const res = await gateway(
      new Request(`${ORIGIN}/api/batch/v1/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          'X-WorldMonitor-Key': token,
          'x-real-ip': CALLER_IP,
          [TRUSTED_RATE_LIMIT_PRINCIPAL_HEADER]: 'api_key:user_forged',
        },
        body: JSON.stringify({ operations: [{ id: 'a', path: '/api/market/v1/list-market-quotes' }] }),
      }),
    );

    assert.equal(res.status, 200);
    const subOpKeys = keys.filter((key) => key.includes('/api/market/v1/list-market-quotes'));
    assert.ok(subOpKeys.length > 0, 'the sub-operation must be charged');
    for (const key of keys) {
      assert.ok(!key.includes('user_forged'), `a forged principal reached the limiter: ${key}`);
    }
    for (const key of subOpKeys) {
      assert.ok(key.includes(`:ip:${CALLER_IP}`), `expected the caller's IP bucket, got ${key}`);
    }
  });

  it('is NOT public and not premium: anonymous POST gets 401 before any fan-out', async () => {
    const [{ createDomainGateway, PUBLIC_NO_AUTH_RPC_PATHS, serverOptions }, generated, { batchHandler }, { PREMIUM_RPC_PATHS }] = await Promise.all([
      import('../server/gateway.ts'),
      import('../src/generated/server/worldmonitor/batch/v1/service_server.ts'),
      import('../server/worldmonitor/batch/v1/handler.ts'),
      import('../src/shared/premium-paths.ts'),
    ]);
    delete process.env.WORLDMONITOR_VALID_KEYS;
    installRedis({});

    assert.equal(PUBLIC_NO_AUTH_RPC_PATHS.has('/api/batch/v1/execute'), false);
    assert.equal(PREMIUM_RPC_PATHS.has('/api/batch/v1/execute'), false);

    const gateway = createDomainGateway(generated.createBatchServiceRoutes(batchHandler, serverOptions));
    const res = await gateway(
      new Request('https://www.worldmonitor.app/api/batch/v1/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operations: [{ id: 'a', path: '/api/market/v1/get-fear-greed-index' }] }),
      }),
    );
    assert.equal(res.status, 401);
  });
});

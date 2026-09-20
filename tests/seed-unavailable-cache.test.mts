import assert from 'node:assert/strict';
import { after, before, beforeEach, it } from 'node:test';
import { createDomainGateway, serverOptions } from '../server/gateway';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';
import { issueSessionToken } from '../api/_session.js';
import { createMarketServiceRoutes } from '../src/generated/server/worldmonitor/market/v1/service_server';
import { createClimateServiceRoutes } from '../src/generated/server/worldmonitor/climate/v1/service_server';
import { createEconomicServiceRoutes } from '../src/generated/server/worldmonitor/economic/v1/service_server';
import { createIntelligenceServiceRoutes } from '../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { listCryptoSectors } from '../server/worldmonitor/market/v1/list-crypto-sectors';
import { listEtfFlows } from '../server/worldmonitor/market/v1/list-etf-flows';
import { listGulfQuotes } from '../server/worldmonitor/market/v1/list-gulf-quotes';
import { listAirQualityData } from '../server/worldmonitor/climate/v1/list-air-quality-data';
import { getOilInventories } from '../server/worldmonitor/economic/v1/get-oil-inventories';
import { getPizzintStatus } from '../server/worldmonitor/intelligence/v1/get-pizzint-status';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const cache = new Map<string, unknown>();
let mode: 'hit' | 'miss' | 'http-error' | 'timeout' | 'malformed' = 'miss';
let token: string;
const gateway = createDomainGateway([
  ...createMarketServiceRoutes({ listCryptoSectors, listEtfFlows, listGulfQuotes } as never, serverOptions),
  ...createClimateServiceRoutes({ listAirQualityData } as never, serverOptions),
  ...createEconomicServiceRoutes({ getOilInventories } as never, serverOptions),
  ...createIntelligenceServiceRoutes({ getPizzintStatus } as never, serverOptions),
]);

before(async () => {
  process.env.WM_SESSION_SECRET = 'synthetic-cache-session-secret-at-least-32-characters';
  token = (await issueSessionToken()).token;
});
beforeEach(() => {
  cache.clear();
  mode = 'miss';
  delete process.env.LOCAL_API_MODE;
  process.env.VERCEL_ENV = 'production';
  process.env.UPSTASH_REDIS_REST_URL = 'https://cache-redis.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic';
  const { fetchImpl } = createRedisFetch({});
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://cache-redis.invalid');
    if (!url.pathname.startsWith('/get/')) return fetchImpl(input, init);
    if (mode === 'http-error') return new Response('', { status: 503 });
    if (mode === 'timeout') throw new DOMException('Fixture timeout', 'TimeoutError');
    const key = decodeURIComponent(url.pathname.slice(5));
    return Response.json({ result: mode === 'malformed' ? '{invalid' : mode === 'hit' && cache.has(key) ? JSON.stringify(cache.get(key)) : null });
  };
});
after(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

function request(path: string) {
  return gateway(new Request(`https://worldmonitor.app/api/${path}`, {
    headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': token },
  }));
}
function assertNoStore(response: Response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('CDN-Cache-Control'), null);
  assert.equal(response.headers.get('Vercel-CDN-Cache-Control'), null);
}
const cases = [
  { path: 'market/v1/list-crypto-sectors', key: 'market:crypto-sectors:v1', payload: { sectors: [{ id: 'ai', name: 'AI', change: 1 }] }, field: 'sectors' },
  { path: 'market/v1/list-etf-flows', key: 'market:etf-flows:v1', payload: { etfs: [], timestamp: '2026-09-01T00:00:00Z', rateLimited: false }, field: 'etfs' },
  { path: 'market/v1/list-gulf-quotes', key: 'market:gulf-quotes:v1', payload: { quotes: [], rateLimited: false }, field: 'quotes' },
  { path: 'climate/v1/list-air-quality-data', key: 'climate:air-quality:v1', payload: { stations: [], fetchedAt: 123 }, field: 'stations' },
  { path: 'economic/v1/get-oil-inventories', key: 'economic:crude-inventories:v1', payload: { weeks: [{ period: '2026-09-01', stocksMb: 440 }] }, field: 'crudeWeeks' },
  { path: 'intelligence/v1/get-pizzint-status', key: 'intelligence:pizzint:seed:v1', payload: { pizzint: { locations: [], defconLevel: 5 }, tensionPairs: [] }, field: 'tensionPairs' },
];
for (const entry of cases) {
  for (const failure of ['miss', 'http-error', 'timeout', 'malformed'] as const) {
    if (entry.path.includes('pizzint') && failure === 'miss') continue;
    it(`${entry.path} keeps ${failure} out of HTTP caches and recovers on the next request`, async () => {
      mode = failure;
      const response = await request(entry.path);
      assertNoStore(response);
      const body = await response.json();
      assert.deepEqual(body[entry.field], []);
      if (entry.path.includes('etf')) assert.equal(body.timestamp, '');
      if (entry.path.includes('oil-inventories')) assert.equal(body.updatedAt, '');
      mode = 'hit';
      cache.set(entry.key, entry.payload);
      const recovered = await request(entry.path);
      assert.equal(recovered.status, 200);
      assert.match(recovered.headers.get('Cache-Control') ?? '', /^private, max-age=300(?:,|$)/);
      const recoveredBody = await recovered.json();
      if (entry.field === 'crudeWeeks') assert.equal(recoveredBody.crudeWeeks[0].stocksMb, 440);
      else if (entry.field === 'tensionPairs') assert.equal(recoveredBody.pizzint.defconLevel, 5);
      else assert.deepEqual(recoveredBody[entry.field], entry.payload[entry.field]);
    });
  }
}
it('preserves a genuine PizzINT miss as a cacheable empty response', async () => {
  const response = await request('intelligence/v1/get-pizzint-status');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Cache-Control') ?? '', /^private, max-age=300(?:,|$)/);
  assert.deepEqual(await response.json(), { tensionPairs: [] });
});
it('preserves PizzINT includeGdelt filtering on a valid seed', async () => {
  mode = 'hit';
  const payload = { pizzint: { locations: [], defconLevel: 5 }, tensionPairs: [{ pair: 'usa_china' }] };
  cache.set('intelligence:pizzint:seed:v1', payload);
  assert.deepEqual((await (await request('intelligence/v1/get-pizzint-status?include_gdelt=true')).json()).tensionPairs, payload.tensionPairs);
  assert.deepEqual((await (await request('intelligence/v1/get-pizzint-status?include_gdelt=false')).json()).tensionPairs, []);
});
for (const entry of cases.filter(entry => !entry.path.includes('pizzint'))) {
  it(`${entry.path} does not cache a missing Redis configuration`, async () => {
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    assertNoStore(await request(entry.path));
  });
}
for (const entry of cases.filter(entry => entry.path.startsWith('market/') || entry.path.startsWith('climate/'))) {
  it(`${entry.path} rejects a seed without its collection`, async () => {
    mode = 'hit';
    cache.set(entry.key, {});
    assertNoStore(await request(entry.path));
  });
}
it('preserves a valid empty crypto sector collection', async () => {
  mode = 'hit';
  cache.set('market:crypto-sectors:v1', { sectors: [] });
  const response = await request('market/v1/list-crypto-sectors');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Cache-Control') ?? '', /^private, max-age=300(?:,|$)/);
  assert.deepEqual(await response.json(), { sectors: [] });
});

it('keeps a partial oil snapshot over a failed section read out of HTTP caches', async () => {
  // One errored section (SPR 503) with the other keys hitting must not look
  // like "SPR does not exist": the partial body carries a fresh updatedAt but
  // must be no-store so the slow-tier cache cannot persist the partial lie.
  const key = 'economic:crude-inventories:v1';
  cache.set(key, { weeks: [{ period: '2026-09-01', stocksMb: 440 }] });
  const sprUrl = 'https://cache-redis.invalid/get/economic%3Aspr%3Av1';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    if (String(input) === sprUrl) return new Response('', { status: 503 });
    return (realFetch as typeof fetch)(input as never, init as never);
  }) as typeof fetch;
  try {
    mode = 'hit';
    const partial = await request('economic/v1/get-oil-inventories');
    assertNoStore(partial);
    const partialBody = await partial.json();
    assert.equal(partialBody.crudeWeeks[0].stocksMb, 440);
    assert.equal(partialBody.spr, undefined);
    // The absent section is UNKNOWN, not empty, so the snapshot must not claim
    // an as-of-now freshness the failed read cannot support. The no-store
    // header stops HTTP caches; blanking updatedAt is what tells the caller,
    // matching the two sibling failure branches in the same handler.
    assert.equal(partialBody.updatedAt, '', 'a partial snapshot must not claim a fresh timestamp');
  } finally {
    globalThis.fetch = realFetch;
  }
});

it('keeps an oil mapping exception out of HTTP caches without a fresh timestamp', async () => {
  mode = 'hit';
  cache.set('economic:crude-inventories:v1', { weeks: [null] });
  const response = await request('economic/v1/get-oil-inventories');
  assertNoStore(response);
  assert.deepEqual(await response.json(), { crudeWeeks: [], natGasWeeks: [], updatedAt: '' });
});

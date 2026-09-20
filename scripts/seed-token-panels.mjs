#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { loadEnvFile, loadSharedConfig, CHROME_UA, runSeed, sleep, fetchCoinPaprikaTickersById, coingeckoEndpoint } from './_seed-utils.mjs';

const defiConfig = loadSharedConfig('defi-tokens.json');
const aiConfig = loadSharedConfig('ai-tokens.json');
const otherConfig = loadSharedConfig('other-tokens.json');

loadEnvFile(import.meta.url);

const DEFI_KEY = 'market:defi-tokens:v1';
const AI_KEY = 'market:ai-tokens:v1';
const OTHER_KEY = 'market:other-tokens:v1';
const CACHE_TTL = 5400; // 90min — 1h buffer over 30min cron cadence (was 60min = 30min buffer)

const ALL_IDS = [...new Set([...defiConfig.ids, ...aiConfig.ids, ...otherConfig.ids])];
const COINPAPRIKA_ID_MAP = { ...defiConfig.coinpaprika, ...aiConfig.coinpaprika, ...otherConfig.coinpaprika };

// #8426: CoinGecko's historical 429 ladder slept 10+20+30+40+50 = 150s, which
// exceeds Token-Panels timeoutMs (120s) in seed-bundle-market-backup.mjs. The
// process was SIGTERMed before fetchFromCoinGecko could throw, so the
// CoinPaprika fallback never ran. Bound the CoinGecko phase and reserve the
// derived CoinPaprika worst case under the section timeout:
//   CoinGecko 45s + CoinPaprika ceil(16/4)*15s = 60s + 15s slack = 120s.
export const COINGECKO_PHASE_BUDGET_MS = 45_000;
export const COINGECKO_REQUEST_TIMEOUT_MS = 15_000;
export const COINPAPRIKA_REQUEST_TIMEOUT_MS = 15_000;
export const COINPAPRIKA_CONCURRENCY = 4;

/** Worst-case CoinPaprika wall time for a mapped-id fanout. */
export function coinPaprikaWorstCaseMs(mappedIdCount, {
  concurrency = COINPAPRIKA_CONCURRENCY,
  timeoutMs = COINPAPRIKA_REQUEST_TIMEOUT_MS,
} = {}) {
  const count = Math.max(0, Math.floor(Number(mappedIdCount) || 0));
  if (count === 0) return 0;
  const workers = Math.max(1, Math.min(Math.floor(Number(concurrency) || 1), count));
  return Math.ceil(count / workers) * timeoutMs;
}

export function tokenPanelsMappedPaprikaCount() {
  return ALL_IDS.map((id) => COINPAPRIKA_ID_MAP[id]).filter(Boolean).length;
}

export async function fetchWithRateLimitRetry(url, options = {}) {
  const {
    maxAttempts = 5,
    headers = { Accept: 'application/json', 'User-Agent': CHROME_UA },
    budgetMs = COINGECKO_PHASE_BUDGET_MS,
    requestTimeoutMs = COINGECKO_REQUEST_TIMEOUT_MS,
    fetchFn = (...args) => globalThis.fetch(...args),
    sleepFn = sleep,
    now = () => Date.now(),
  } = options;

  const deadlineAt = now() + budgetMs;
  for (let i = 0; i < maxAttempts; i++) {
    // Reserve the full per-attempt timeout so a late start cannot run past the
    // CoinGecko ceiling and eat the CoinPaprika reservation (#8426).
    if (now() + requestTimeoutMs > deadlineAt) {
      throw new Error('CoinGecko phase budget exhausted');
    }
    const resp = await fetchFn(url, {
      headers,
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (resp.status === 429) {
      const wait = Math.min(10_000 * (i + 1), 60_000);
      // Same reservation for the sleep + next attempt. Throwing here is what
      // lets fetchTokenPanels reach CoinPaprika under sustained rate limits.
      if (now() + wait + requestTimeoutMs > deadlineAt) {
        throw new Error('CoinGecko phase budget exhausted');
      }
      console.warn(`  CoinGecko 429 — waiting ${wait / 1000}s (attempt ${i + 1}/${maxAttempts})`);
      await sleepFn(wait);
      continue;
    }
    if (!resp.ok) throw new Error(`CoinGecko HTTP ${resp.status}`);
    return resp;
  }
  throw new Error('CoinGecko rate limit exceeded after retries');
}

async function fetchFromCoinGecko(options = {}) {
  const {
    coingeckoUrl,
    coingeckoHeaders,
    ...retryOptions
  } = options;
  const endpoint = coingeckoUrl
    ? { headers: coingeckoHeaders || { Accept: 'application/json', 'User-Agent': CHROME_UA } }
    : coingeckoEndpoint();
  const url = coingeckoUrl
    || `${endpoint.baseUrl}/coins/markets?vs_currency=usd&ids=${ALL_IDS.join(',')}&order=market_cap_desc&sparkline=false&price_change_percentage=24h,7d`;

  const resp = await fetchWithRateLimitRetry(url, { ...retryOptions, headers: endpoint.headers });
  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) throw new Error('CoinGecko returned no data');
  return data;
}

async function fetchFromCoinPaprika(options = {}) {
  console.log('  [CoinPaprika] Falling back to CoinPaprika...');
  const paprikaIds = ALL_IDS.map((id) => COINPAPRIKA_ID_MAP[id]).filter(Boolean);
  const tickers = await fetchCoinPaprikaTickersById(paprikaIds, {
    timeoutMs: options.coinpaprikaTimeoutMs ?? COINPAPRIKA_REQUEST_TIMEOUT_MS,
    concurrency: options.coinpaprikaConcurrency ?? COINPAPRIKA_CONCURRENCY,
    fetchFn: options.fetchFn,
  });
  const reverseMap = new Map(Object.entries(COINPAPRIKA_ID_MAP).map(([g, p]) => [p, g]));
  return tickers
    .map((t) => ({
      id: reverseMap.get(t.id) || t.id,
      current_price: t.quotes.USD.price,
      price_change_percentage_24h: t.quotes.USD.percent_change_24h,
      price_change_percentage_7d_in_currency: t.quotes.USD.percent_change_7d,
      symbol: t.symbol.toLowerCase(),
      name: t.name,
    }));
}

function mapTokens(ids, meta, byId) {
  const tokens = [];
  for (const id of ids) {
    const coin = byId.get(id);
    if (!coin) continue;
    const m = meta[id];
    tokens.push({
      name: m?.name || coin.name || id,
      symbol: m?.symbol || (coin.symbol || id).toUpperCase(),
      price: coin.current_price ?? 0,
      change24h: coin.price_change_percentage_24h ?? 0,
      change7d: coin.price_change_percentage_7d_in_currency ?? 0,
    });
  }
  return tokens;
}

export async function fetchTokenPanels(options = {}) {
  let raw;
  try {
    raw = await fetchFromCoinGecko(options);
  } catch (err) {
    console.warn(`  [CoinGecko] Failed: ${err.message}`);
    raw = await fetchFromCoinPaprika(options);
  }

  const byId = new Map(raw.map((c) => [c.id, c]));
  const defi = { tokens: mapTokens(defiConfig.ids, defiConfig.meta, byId) };
  const ai = { tokens: mapTokens(aiConfig.ids, aiConfig.meta, byId) };
  const other = { tokens: mapTokens(otherConfig.ids, otherConfig.meta, byId) };
  const total = defi.tokens.length + ai.tokens.length + other.tokens.length;

  if (total === 0) throw new Error('All token panels returned empty');

  return { defi, ai, other, total };
}

// validate() runs on the POST-publishTransform payload (the canonical defi
// panel itself, shape {tokens, ...}) — NOT the pre-transform {defi, ai, other}
// shape. The prior body checked data.defi/.ai/.other and silently forced the
// skipped-write path every run. AI/OTHER panels are validated implicitly by
// their own extraKey declareRecords on write.
export function validate(data) {
  return (
    Array.isArray(data?.tokens) &&
    data.tokens.length >= 1 &&
    data.tokens.some((t) => t.price > 0)
  );
}

// Canonical key (DEFI_KEY) holds the defi panel object `{tokens, ...}` after
// publishTransform. declareRecords must match the POST-transform shape;
// counting `data.defi/ai/other` on the transformed payload returned 0 and
// forced runSeed into RETRY, leaving all 3 token keys stale.
export function declareRecords(data) {
  return Array.isArray(data?.tokens) ? data.tokens.length : 0;
}

// Each panel has its own {tokens, ...} shape — reuse canonical declareRecords
// since the transformed extra-key payloads are structurally identical to the
// canonical one (a single panel). `skipWhenEmpty` guards against a partial
// upstream fetch (CoinGecko dropping the AI or Other IDs for a cycle while DeFi
// still resolves, so validateFn passes on the canonical panel): without it,
// runSeed would clobber the good cached AI/Other panel with a recordCount=0
// write — blanking the UI panel and tripping the seed-contract probe's
// minRecords:1 floor (false 503). Exported so a test can assert the guard.
export const TOKEN_PANEL_EXTRA_KEYS = [
  { key: AI_KEY,    transform: (data) => data.ai,    ttl: CACHE_TTL, declareRecords, skipWhenEmpty: true },
  { key: OTHER_KEY, transform: (data) => data.other, ttl: CACHE_TTL, declareRecords, skipWhenEmpty: true },
];

// isMain guard — required so tests/agents can `import` declareRecords without
// firing runSeed on module load (which would touch Redis and process.exit).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) runSeed('market', 'token-panels', DEFI_KEY, fetchTokenPanels, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'coingecko-paprika-fallback',
  recordCount: (data) => data.total,
  publishTransform: (data) => data.defi,
  extraKeys: TOKEN_PANEL_EXTRA_KEYS,

  declareRecords,
  schemaVersion: 1,
  maxStaleMin: 90,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});

// Token-Panels CoinGecko retry ladder must leave room for the CoinPaprika
// fallback under the market-backup section timeout (#8426).
//
// Production crash 2026-09-20: five 429 backoffs slept 10+20+30+40+50 = 150s
// against a 120s Token-Panels timeoutMs. The child was SIGTERMed before
// fetchFromCoinGecko could throw, so fetchFromCoinPaprika never ran — the
// fallback added in #1977 was unreachable under sustained rate-limiting.
//
// Fix contract:
//   - CoinGecko phase is deadline-bounded (45s ceiling, declared as data)
//   - CoinPaprika worst case is derived (ceil(mapped/concurrency) * timeout)
//   - sum of both phases fits the section timeout read from the manifest

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COINGECKO_PHASE_BUDGET_MS,
  COINGECKO_REQUEST_TIMEOUT_MS,
  COINPAPRIKA_CONCURRENCY,
  COINPAPRIKA_REQUEST_TIMEOUT_MS,
  coinPaprikaWorstCaseMs,
  fetchTokenPanels,
  fetchWithRateLimitRetry,
  tokenPanelsMappedPaprikaCount,
} from '../scripts/seed-token-panels.mjs';
import {
  extractBundleSections,
  resolveExpr,
} from './helpers/bundle-section-parser.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function createVirtualClock(startMs = 0) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (ms) => {
      nowMs += ms;
    },
    async sleep(ms) {
      nowMs += ms;
    },
  };
}

function always429Fetch() {
  return async () => ({
    ok: false,
    status: 429,
    async json() {
      return {};
    },
  });
}

function paprikaOkFetch() {
  return async (url) => {
    const id = decodeURIComponent(url.match(/tickers\/([^?]+)/)[1]);
    return {
      ok: true,
      async json() {
        return {
          id,
          symbol: id.slice(0, 3),
          name: id,
          quotes: {
            USD: {
              price: 1.5,
              percent_change_24h: 0.1,
              percent_change_7d: 0.2,
            },
          },
        };
      },
    };
  };
}

describe('token-panels CoinGecko phase budget (#8426)', () => {
  it('declares a 45s CoinGecko ceiling and derives CoinPaprika worst case from mapped ids', () => {
    assert.equal(COINGECKO_PHASE_BUDGET_MS, 45_000);
    assert.equal(COINGECKO_REQUEST_TIMEOUT_MS, 15_000);
    assert.equal(COINPAPRIKA_REQUEST_TIMEOUT_MS, 15_000);
    assert.equal(COINPAPRIKA_CONCURRENCY, 4);

    const mapped = tokenPanelsMappedPaprikaCount();
    assert.equal(mapped, 16, 'shared token configs currently map 16 CoinGecko ids to CoinPaprika');
    assert.equal(
      coinPaprikaWorstCaseMs(mapped),
      Math.ceil(16 / 4) * 15_000,
      'CoinPaprika worst case is ceil(mapped/concurrency) * per-request timeout',
    );
  });

  it('CoinGecko + CoinPaprika worst case fits Token-Panels timeoutMs from the market-backup manifest', () => {
    const bundleSrc = readFileSync(join(ROOT, 'scripts/seed-bundle-market-backup.mjs'), 'utf8');
    const section = extractBundleSections(bundleSrc).find((entry) => entry.label === 'Token-Panels');
    assert.ok(section, 'Token-Panels must be listed in seed-bundle-market-backup.mjs');
    assert.ok(section.timeoutMsExpr, 'Token-Panels must declare timeoutMs');

    const sectionTimeoutMs = resolveExpr(bundleSrc, section.timeoutMsExpr);
    assert.equal(sectionTimeoutMs, 120_000);

    const paprikaBudgetMs = coinPaprikaWorstCaseMs(tokenPanelsMappedPaprikaCount());
    const reservedMs = COINGECKO_PHASE_BUDGET_MS + paprikaBudgetMs;
    assert.ok(
      reservedMs <= sectionTimeoutMs,
      `CoinGecko ${COINGECKO_PHASE_BUDGET_MS}ms + CoinPaprika ${paprikaBudgetMs}ms = ${reservedMs}ms `
      + `must fit Token-Panels timeoutMs ${sectionTimeoutMs}ms`,
    );
    assert.ok(
      sectionTimeoutMs - reservedMs >= 15_000,
      `expected at least 15s slack under the section timeout; got ${sectionTimeoutMs - reservedMs}ms`,
    );
  });

  it('fetchWithRateLimitRetry abandons CoinGecko inside the phase budget instead of sleeping the full ladder', async () => {
    const clock = createVirtualClock();
    const waits = [];
    await assert.rejects(
      () => fetchWithRateLimitRetry('https://example.test/markets', {
        fetchFn: always429Fetch(),
        sleepFn: async (ms) => {
          waits.push(ms);
          await clock.sleep(ms);
        },
        now: clock.now,
        budgetMs: COINGECKO_PHASE_BUDGET_MS,
        requestTimeoutMs: COINGECKO_REQUEST_TIMEOUT_MS,
      }),
      /CoinGecko phase budget exhausted/,
    );

    assert.ok(clock.now() <= COINGECKO_PHASE_BUDGET_MS,
      `virtual elapsed ${clock.now()}ms must stay within the ${COINGECKO_PHASE_BUDGET_MS}ms CoinGecko ceiling`);
    // Unbounded ladder would sleep 10+20+30+40+50 = 150_000 before throwing.
    assert.ok(waits.reduce((sum, ms) => sum + ms, 0) < 150_000,
      'must not sleep the full historical 150s 429 ladder');
    assert.deepEqual(waits, [10_000, 20_000],
      'only retries that still leave room for another request timeout may sleep');
  });

  it('fetchTokenPanels reaches CoinPaprika after a budget-exhausted CoinGecko phase', async () => {
    const clock = createVirtualClock();
    let paprikaCalls = 0;
    const geckoFetch = always429Fetch();
    const paprikaFetch = async (url, options) => {
      paprikaCalls += 1;
      return paprikaOkFetch()(url, options);
    };

    // Drive only the provider chain: inject endpoints so we never touch Redis
    // or real CoinGecko/CoinPaprika hosts.
    const result = await fetchTokenPanels({
      coingeckoUrl: 'https://example.test/coingecko',
      coingeckoHeaders: { Accept: 'application/json' },
      fetchFn: async (url, options) => {
        if (String(url).includes('example.test/coingecko')) {
          return geckoFetch(url, options);
        }
        return paprikaFetch(url, options);
      },
      sleepFn: clock.sleep,
      now: clock.now,
      budgetMs: COINGECKO_PHASE_BUDGET_MS,
    });

    assert.ok(paprikaCalls > 0, 'CoinPaprika fallback must run after CoinGecko budget exhaustion');
    assert.ok(result.total >= 1, 'fallback must produce at least one priced token panel row');
    assert.ok(clock.now() <= COINGECKO_PHASE_BUDGET_MS,
      'CoinGecko phase must end inside its ceiling before the fallback starts');
  });
});

import type {
  ListConsumerPriceMoversRequest,
  ListConsumerPriceMoversResponse,
} from '../../../../src/generated/server/worldmonitor/consumer_prices/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

import { normalizeMarketCode } from './_market-code';

const DEFAULT_RANGE = '30d';
const VALID_RANGES = new Set(['7d', '30d', '90d']);

export async function listConsumerPriceMovers(
  _ctx: unknown,
  req: ListConsumerPriceMoversRequest,
): Promise<ListConsumerPriceMoversResponse> {
  // Seed keys are lowercase (`consumer-prices:movers:ae:30d`); the OpenAPI
  // contract documents ISO 3166-1 alpha-2, which callers send as "US"/"AE".
  // The shared helper normalizes case AND validates the shape, the same way
  // `range` is guarded by VALID_RANGES one line below — see _market-code.ts for
  // the two defects that motivated it (uppercase miss, whitespace-only code
  // producing an empty key segment).
  const market = normalizeMarketCode(req.marketCode);
  const range = VALID_RANGES.has(req.range ?? '') ? req.range! : DEFAULT_RANGE;
  const key = `consumer-prices:movers:${market}:${range}`;

  const EMPTY: ListConsumerPriceMoversResponse = {
    marketCode: market,
    asOf: '0',
    range,
    risers: [],
    fallers: [],
    upstreamUnavailable: true,
  };

  try {
    const cached = await getCachedJson(key, true) as ListConsumerPriceMoversResponse | null;
    if (!cached) return EMPTY;

    const limit = req.limit > 0 ? Math.min(Math.max(1, Math.floor(req.limit)), 10) : 10;
    const filterCategory = req.categorySlug;

    const filter = (movers: typeof cached.risers) =>
      (filterCategory ? movers.filter((m) => m.category === filterCategory) : movers).slice(0, limit);

    return { ...cached, risers: filter(cached.risers), fallers: filter(cached.fallers) };
  } catch {
    return EMPTY;
  }
}

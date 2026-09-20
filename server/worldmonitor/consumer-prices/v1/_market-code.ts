// One market-code normalizer for every consumer-prices RPC.
//
// #8385 review: the six handlers in this directory each built their Redis key
// from `req.marketCode || DEFAULT_MARKET` verbatim, and the fix for the
// uppercase-miss bug landed in only ONE of them (list-consumer-price-movers).
// That left a caller sending the contract's own documented example (`US` —
// OpenAPI says ISO 3166-1 alpha-2) getting real movers data beside five empty
// stubs for the identical input. scripts/seed-consumer-prices.mjs seeds every
// consumer-prices key from one lowercase market, so an uppercase code
// structurally cannot hit a seeded row.
//
// Two separate defects are closed here, which is why this validates rather than
// just lowercases:
//   - CASE: "US" must reach `consumer-prices:*:us`.
//   - SHAPE: `'  '` is truthy, so `(req.marketCode || DEFAULT_MARKET).trim()`
//     skipped the default and produced an EMPTY key segment
//     (`consumer-prices:movers::30d`). Any other junk string likewise reached
//     the cache key unbounded. Validating against the documented alpha-2 shape
//     and falling back to the default mirrors how `range` is already guarded
//     with VALID_RANGES in list-consumer-price-movers.
export const DEFAULT_MARKET = 'ae';

const ISO_ALPHA2_RE = /^[a-z]{2}$/;

/** Lowercased ISO 3166-1 alpha-2 market code, or DEFAULT_MARKET when unusable. */
export function normalizeMarketCode(raw: string | undefined | null): string {
  const normalized = String(raw ?? '').trim().toLowerCase();
  return ISO_ALPHA2_RE.test(normalized) ? normalized : DEFAULT_MARKET;
}

#!/usr/bin/env node
// Swiss National Bank daily spot rates on Confederation bonds (NSS fitted),
// daily since 1988-01-01, tenors 1–10Y 20Y 30Y.
// Cube rendeiduebd is one ~14 MB CSV covering the full history. Only the
// D0="CHF" rows are the Confederation-bond curve.

import { CHROME_UA, loadEnvFile, runSeed } from './_seed-utils.mjs';
import { parseSnbRendeiduebdCsv } from './lib/yield-curves/snb.mjs';
import { countCurves } from './lib/yield-curves/model.mjs';
import { YIELD_CURVE_MAX_CONTENT_AGE_MIN, YIELD_CURVE_MAX_STALE_MIN, YIELD_CURVE_TTL_SECONDS, canonicalKey, latestExtraKeyEntry, makeValidate, markYieldCurveActivated, contentMeta, seedResource, yearExtraKeyEntry } from './seed-yield-curves-shared.mjs';

loadEnvFile(import.meta.url);

const SNB_CSV = 'https://data.snb.ch/api/cube/rendeiduebd/data/csv/en';

export async function fetchSnbCurve() {
  const response = await fetch(SNB_CSV, {
    headers: { Accept: 'text/csv, text/plain, */*', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`SNB HTTP ${response.status}`);
  const csv = await response.text();
  const curves = parseSnbRendeiduebdCsv(csv);
  if (curves.length === 0) throw new Error('SNB cube parsed no business days');
  console.log(`  SNB: ${curves.length} business days, ${curves[0].date} → ${curves.at(-1).date}`);
  return { curves };
}

if (process.argv[1]?.endsWith('seed-yield-curve-ch.mjs')) {
  const extraKeys = [latestExtraKeyEntry('CH')];
  const endYear = new Date().getUTCFullYear();
  for (let year = 1988; year <= endYear; year += 1) {
    extraKeys.push(yearExtraKeyEntry('CH', year, year === endYear));
  }
  runSeed('economic', seedResource('CH'), canonicalKey('CH'), fetchSnbCurve, {
    validateFn: makeValidate(3000, '1988-01'),
    ttlSeconds: YIELD_CURVE_TTL_SECONDS,
    sourceVersion: 'snb-rendeiduebd-csv-v1',
    schemaVersion: 1,
    maxStaleMin: YIELD_CURVE_MAX_STALE_MIN,
    recordCount: countCurves,
    declareRecords: countCurves,
    contentMeta,
    maxContentAgeMin: YIELD_CURVE_MAX_CONTENT_AGE_MIN,
    extraKeys,
    afterPublish: markYieldCurveActivated('CH'),

    lockTtlMs: 300_000,
    fetchPhaseTimeoutMs: 280_000,  }).catch((err) => {
    console.error('FATAL:', err?.message || err);
    process.exit(1);
  });
}

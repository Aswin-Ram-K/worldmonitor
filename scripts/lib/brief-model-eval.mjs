// Pure helpers behind scripts/eval-brief-model.mjs and its tests: the pass/fail checks
// run on each raw brief output, and the per-surface summary of a captured run.
//
// Every check is binary and maps to a failure a shipped brief actually had. The raw
// output is checked BEFORE the production validators repair or reject it, so a model
// that fabricates is visible even when the validators save the brief; `rejected`
// separately counts the outputs production threw away (the reader got the stub).
import { createHash } from 'node:crypto';

import { validateNoHallucinatedStatusQualifiers } from '../../shared/brief-llm-core.js';
import { LEAD_STITCHING_STEM_RE } from './brief-llm.mjs';

export const SURFACES = ['digest', 'description', 'whyMatters'];

export const CHECKS = {
  // callLLM returned nothing: timeout, HTTP error, empty content or finish_reason=length.
  no_output: 'the transport returned no text',
  // The digest must be a JSON object with a string lead.
  invalid_json: 'the digest is not a JSON object with a string lead',
  // Sep 20: "former President Trump" for a sitting president.
  status_qualifier: 'a tenure qualifier (former, acting, late, ...) the stories do not carry',
  // Sep 20 and May 17: "This development comes as" stapling two stories together.
  stitch: 'the digest lead uses a stitching connective',
  // Production discarded the output and shipped the stub.
  rejected: 'production rejected the output',
};

export const promptSha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

// Prompts carry today's date; hash them with it masked so a run's hash only moves when
// the prompt text does.
export const maskDates = (text) => text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, 'YYYY-MM-DD');

export function groundTexts(stories) {
  return stories.map((s) => [s.headline, s.description].filter(Boolean).join(' '));
}

export function parseRawDigest(text) {
  if (typeof text !== 'string') return null;
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  for (const candidate of [unfenced, unfenced.match(/\{[\s\S]*\}/)?.[0]]) {
    if (!candidate) continue;
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === 'object' && typeof obj.lead === 'string') return obj;
    } catch { /* try the next candidate */ }
  }
  return null;
}

// Every prose string the reader can see in a digest: lead, thread teasers, signals.
export function digestProse(obj) {
  const threads = Array.isArray(obj.threads) ? obj.threads.map((t) => t?.teaser).filter((t) => typeof t === 'string') : [];
  const signals = Array.isArray(obj.signals) ? obj.signals.filter((s) => typeof s === 'string') : [];
  return [obj.lead, ...threads, ...signals];
}

const hasStatusQualifier = (texts, grounds) =>
  texts.some((t) => !validateNoHallucinatedStatusQualifiers(t, grounds).ok);

// surface: 'digest' | 'description' | 'whyMatters'
// raw: the text callLLM returned (null when it returned nothing)
// delivered: whether the production generator returned prose rather than null
// stories: the digest's pool, or the one story a description/whyMatters was written for
export function checkSample({ surface, raw, delivered, stories }) {
  const fails = [];
  if (raw == null) fails.push('no_output');
  else if (surface === 'digest') {
    const obj = parseRawDigest(raw);
    if (!obj) fails.push('invalid_json');
    else {
      if (hasStatusQualifier(digestProse(obj), groundTexts(stories))) fails.push('status_qualifier');
      if (LEAD_STITCHING_STEM_RE.test(obj.lead)) fails.push('stitch');
    }
  } else if (hasStatusQualifier([raw], groundTexts(stories))) {
    fails.push('status_qualifier');
  }
  if (!delivered) fails.push('rejected');
  return fails;
}

const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);

// samples: [{ surface, pool, fails, ms, provider, costUsd }]
export function summarizeRun(samples) {
  const out = {};
  for (const surface of SURFACES) {
    const rows = samples.filter((s) => s.surface === surface);
    if (rows.length === 0) continue;
    const failCounts = Object.fromEntries(Object.keys(CHECKS).map((c) => [c, rows.filter((r) => r.fails.includes(c)).length]));
    const ms = rows.map((r) => r.ms).filter((m) => typeof m === 'number').sort((a, b) => a - b);
    const providers = {};
    for (const r of rows) if (r.provider) providers[r.provider] = (providers[r.provider] ?? 0) + 1;
    out[surface] = {
      n: rows.length,
      delivered: rows.length - failCounts.rejected,
      // Output the model produced that production threw away: a content failure. The rest
      // of `rejected` is no_output, which is transport latency and comes in bursts.
      rejectedWithOutput: rows.filter((r) => r.fails.includes('rejected') && !r.fails.includes('no_output')).length,
      fails: failCounts,
      p50Ms: quantile(ms, 0.5),
      p95Ms: quantile(ms, 0.95),
      maxMs: ms.length ? ms[ms.length - 1] : null,
      providers,
      costUsd: +rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0).toFixed(5),
    };
  }
  return out;
}

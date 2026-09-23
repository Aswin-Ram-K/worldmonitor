// The email brief's prose model is chosen on scripts/eval-brief-model.mjs runs over the
// pools in tests/fixtures/brief-model-eval.json. This file pins the pass/fail checks to
// the failures they stand for, and pins the shipped model to a captured run, so the model
// cannot change without re-running the eval.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkSample, maskDates, parseRawDigest, summarizeRun } from '../scripts/lib/brief-model-eval.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/brief-model-eval.json'), 'utf8'));
const sep20 = fixture.pools['sep20-former-president'].stories;

// Verbatim from the 2026-09-20 email (tests/brief-llm.test.mjs keeps the same strings).
const CAPTURED_LEAD =
  'Good morning. Iran has declared its terms for peace, demanding a complete cessation of Saudi-led military operations and the lifting of all sanctions, following an attempted attack on Riyadh that Saudi forces claim to have foiled. This development comes as former President Trump returns to the UN, with the ongoing conflict in the Persian Gulf spreading to critical shipping chokepoints, directly impacting global trade and energy security.';
const CAPTURED_TEASER = 'Former President Trump re-engages with the UN as the Iran conflict intensifies, impacting international relations and global stability.';
const CAPTURED_CARD = 'Former President Trump returned to the UN General Assembly amidst escalating maritime tensions as Iranian-linked attacks on shipping chokepoints intensified globally.';
const GROUNDED_LEAD = 'Good morning. Iran has declared its terms for peace after Saudi forces foiled an attack on Riyadh.';

const digest = (lead, teasers = ['Iran outlines peace terms.']) =>
  JSON.stringify({ lead, threads: teasers.map((teaser) => ({ tag: 'Conflict', teaser })), signals: ['Watch Hormuz.'] });

describe('checkSample: digest', () => {
  it('flags the Sep 20 lead for both the qualifier and the stitch', () => {
    const fails = checkSample({ surface: 'digest', raw: digest(CAPTURED_LEAD), delivered: true, stories: sep20 });
    assert.deepEqual(fails, ['status_qualifier', 'stitch']);
  });

  it('flags a qualifier that only appears in a thread teaser', () => {
    const fails = checkSample({ surface: 'digest', raw: digest(GROUNDED_LEAD, [CAPTURED_TEASER]), delivered: true, stories: sep20 });
    assert.deepEqual(fails, ['status_qualifier']);
  });

  it('passes a grounded digest, fenced or not', () => {
    assert.deepEqual(checkSample({ surface: 'digest', raw: digest(GROUNDED_LEAD), delivered: true, stories: sep20 }), []);
    assert.deepEqual(checkSample({ surface: 'digest', raw: `\`\`\`json\n${digest(GROUNDED_LEAD)}\n\`\`\``, delivered: true, stories: sep20 }), []);
  });

  it('scores the raw text even when production repaired or rejected it', () => {
    const fails = checkSample({ surface: 'digest', raw: digest(CAPTURED_LEAD), delivered: false, stories: sep20 });
    assert.deepEqual(fails, ['status_qualifier', 'stitch', 'rejected']);
  });

  it('separates no output from unparseable output', () => {
    assert.deepEqual(checkSample({ surface: 'digest', raw: null, delivered: false, stories: sep20 }), ['no_output', 'rejected']);
    assert.deepEqual(checkSample({ surface: 'digest', raw: 'Iran set terms.', delivered: false, stories: sep20 }), ['invalid_json', 'rejected']);
    assert.equal(parseRawDigest('{"threads": []}'), null, 'a digest without a string lead is not a digest');
  });
});

describe('checkSample: per-story prose', () => {
  const trumpStory = [sep20[1]];

  it('flags the Sep 20 story card', () => {
    assert.deepEqual(checkSample({ surface: 'description', raw: CAPTURED_CARD, delivered: true, stories: trumpStory }), ['status_qualifier']);
  });

  it('passes the same sentence without the invented qualifier', () => {
    const raw = 'President Trump returned to the UN General Assembly as attacks on shipping chokepoints spread.';
    assert.deepEqual(checkSample({ surface: 'whyMatters', raw, delivered: true, stories: trumpStory }), []);
  });

  it('grounds a qualifier the story itself carries', () => {
    const story = [{ ...sep20[1], headline: 'Former President Trump Returns to UN' }];
    assert.deepEqual(checkSample({ surface: 'description', raw: CAPTURED_CARD, delivered: true, stories: story }), []);
  });
});

describe('summarizeRun', () => {
  it('counts deliveries, per-check failures, latency and serving providers per surface', () => {
    const s = summarizeRun([
      { surface: 'digest', fails: [], ms: 100, provider: 'A', costUsd: 0.001 },
      { surface: 'digest', fails: ['stitch'], ms: 300, provider: 'A', costUsd: 0.001 },
      { surface: 'digest', fails: ['no_output', 'rejected'], ms: 15000, provider: null },
      { surface: 'description', fails: [], ms: 50, provider: 'B' },
    ]);
    assert.equal(s.digest.n, 3);
    assert.equal(s.digest.delivered, 2);
    assert.equal(s.digest.fails.stitch, 1);
    assert.equal(s.digest.fails.no_output, 1);
    assert.equal(s.digest.p50Ms, 300);
    assert.equal(s.digest.maxMs, 15000);
    assert.deepEqual(s.digest.providers, { A: 2 });
    assert.equal(s.digest.costUsd, 0.002);
    assert.equal(s.description.n, 1);
    assert.equal(s.whyMatters, undefined);
  });
});

it('maskDates hides the date line so the prompt hash moves only with the prompt', () => {
  assert.equal(maskDates('Today is 2026-09-23. Stories from 2026-09-20.'), 'Today is YYYY-MM-DD. Stories from YYYY-MM-DD.');
});

describe('the shipped brief model has a clean captured run', () => {
  const briefSrc = readFileSync(resolve(root, 'scripts/lib/brief-llm.mjs'), 'utf8');
  const shipped = briefSrc.match(/^const BRIEF_LLM_OPENROUTER_MODEL = process\.env\.BRIEF_LLM_OPENROUTER_MODEL \|\| '([^']+)';/m)?.[1];

  it('reads the default model out of source', () => {
    assert.ok(shipped, 'BRIEF_LLM_OPENROUTER_MODEL default not found; scripts/eval-brief-model.mjs reads it the same way');
  });

  const runs = Object.entries(fixture.runs).filter(([, r]) => r.model === shipped);
  const samples = runs.flatMap(([, r]) => r.samples);

  it('was measured', () => {
    assert.ok(runs.length > 0, `no run in tests/fixtures/brief-model-eval.json for ${shipped}; capture one with scripts/eval-brief-model.mjs --live --capture`);
  });

  // Fabrication is gated per sample, on every run: one shipped "former President" is the
  // incident. The digest validator repairs a qualifier sentence out of the lead, so there
  // the RAW rate is held to zero; per-story prose is gated on what was delivered.
  it('no run shows a fabricated tenure qualifier the reader would see', () => {
    const digestRaw = samples.filter((x) => x.surface === 'digest' && x.fails.includes('status_qualifier'));
    const deliveredStory = samples.filter((x) => x.surface !== 'digest' && x.fails.includes('status_qualifier') && !x.fails.includes('rejected'));
    assert.deepEqual(digestRaw.map((x) => x.raw), [], 'digest: raw fabricated qualifiers');
    assert.deepEqual(deliveredStory.map((x) => `${x.surface}: ${x.raw}`), [], 'delivered per-story prose with a fabricated qualifier');
  });

  // Delivery is pooled across the model's runs: a 5% bar on 24 digests is one sample.
  // Only output production threw away counts. no_output is transport latency, which
  // comes in provider-side bursts one run cannot measure (the first Gemini capture hit
  // one); that needs llm_call telemetry from the digest cron (#8440).
  for (const surface of ['digest', 'description', 'whyMatters']) {
    it(`${surface}: production rejects at most 5% of the prose the model produced`, () => {
      const rows = samples.filter((x) => x.surface === surface && !x.fails.includes('no_output'));
      const rejected = rows.filter((x) => x.fails.includes('rejected')).length;
      assert.ok(rows.length >= 20, `${surface}: only ${rows.length} samples with output`);
      assert.ok(rejected / rows.length <= 0.05, `${surface}: ${rejected}/${rows.length} rejected`);
    });
  }
});

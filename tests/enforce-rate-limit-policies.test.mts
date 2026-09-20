import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  SANCTIONED_MARKER,
  findEndpointRateLimitFailOpenOptOuts,
  scanSourceForFailOpenOptOuts,
} from '../scripts/enforce-rate-limit-policies.mjs';

// #8385 review: the fail-open guard shipped with an exemption that silently
// absolved EVERY `failClosed: false` anywhere in server/gateway.ts. Two defects
// combined: the old regex matched a whole `checkEndpointRateLimit(...)` span
// non-greedily (so a later match STARTED at an unrelated earlier call and its
// 12-before/6-after marker window landed on the sanctioned comment regardless
// of where the new opt-out was), and `failClosed\s*:\s*false` also matched the
// marker COMMENT's own prose. Both mutants below reported zero findings before
// the fix. These tests exist so the guard can never go quiet again.

const REL = 'server/gateway.ts';
const OPTOUT = '  const r = await checkEndpointRateLimit(request, pathname, corsHeaders, { failClosed: false });';
const SANCTIONED_BLOCK = [
  `  // ${SANCTIONED_MARKER}`,
  OPTOUT,
].join('\n');

const PREAMBLE = [
  'export async function handler(request, pathname, corsHeaders) {',
  '  const a = await checkEndpointRateLimit(request, pathname, corsHeaders, {',
  "    principalUserId: 'u1',",
  "    principalScope: 'session',",
  '  });',
].join('\n');

describe('enforce-rate-limit-policies fail-open guard', () => {
  it('exempts the single marked gateway call site', () => {
    const src = [PREAMBLE, SANCTIONED_BLOCK, '}'].join('\n');
    const result = scanSourceForFailOpenOptOuts(src, REL);
    assert.deepEqual(result.findings, []);
    assert.equal(result.sanctionedExemptions, 1);
  });

  it('flags an unsanctioned opt-out far BELOW the marked call site', () => {
    // The regression: the old span regex started this match at an earlier call
    // and inherited the sanctioned marker's window, reporting nothing.
    const src = [PREAMBLE, SANCTIONED_BLOCK, ...Array(40).fill('  // filler'), OPTOUT, '}'].join('\n');
    const result = scanSourceForFailOpenOptOuts(src, REL);
    assert.equal(result.findings.length, 1, 'an unmarked opt-out below the marker must be flagged');
    assert.equal(result.sanctionedExemptions, 1);
  });

  it('flags an unsanctioned opt-out immediately below the marked call site', () => {
    const src = [PREAMBLE, SANCTIONED_BLOCK, OPTOUT, '}'].join('\n');
    assert.equal(scanSourceForFailOpenOptOuts(src, REL).findings.length, 1);
  });

  it('flags an opt-out whose marker sits one line too far above', () => {
    // The marker must be DIRECTLY adjacent; a drifting window is what broke it.
    const src = [
      PREAMBLE,
      `  // ${SANCTIONED_MARKER}`,
      '  // an unrelated comment pushed in between',
      OPTOUT,
      '}',
    ].join('\n');
    assert.equal(scanSourceForFailOpenOptOuts(src, REL).findings.length, 1);
  });

  it('does not treat prose mentioning failClosed: false as a call site', () => {
    const src = [
      PREAMBLE,
      '  // Historically this passed { failClosed: false } and must never again.',
      '}',
    ].join('\n');
    const result = scanSourceForFailOpenOptOuts(src, REL);
    assert.deepEqual(result.findings, []);
    assert.equal(result.sanctionedExemptions, 0);
  });

  it('ignores a failClosed: false handed to a different limiter', () => {
    const src = [
      'export async function handler(request, pathname, corsHeaders) {',
      '  await checkEndpointRateLimit(request, pathname, corsHeaders);',
      "  const s = await checkScopedRateLimit('scope', 5, '1 h', ip, { failClosed: false });",
      '}',
    ].join('\n');
    assert.deepEqual(scanSourceForFailOpenOptOuts(src, REL).findings, []);
  });

  it('does not exempt a marked opt-out outside server/gateway.ts', () => {
    const src = [PREAMBLE, SANCTIONED_BLOCK, '}'].join('\n');
    const result = scanSourceForFailOpenOptOuts(src, 'server/worldmonitor/news/v1/list-feed-digest.ts');
    assert.equal(result.findings.length, 1, 'the marker is only honored in server/gateway.ts');
    assert.equal(result.sanctionedExemptions, 0);
  });

  it('reports the repo as clean today', () => {
    assert.deepEqual(findEndpointRateLimitFailOpenOptOuts(), []);
  });

  it('keeps the sanctioned marker adjacent to the real gateway call site', () => {
    // Source-text pin: if someone reflows the comment away from the call, the
    // lint starts flagging the legitimate site and this fails first with a
    // clearer reason than a red CI lint.
    const gateway = readFileSync(new URL('../server/gateway.ts', import.meta.url), 'utf8');
    const lines = gateway.split('\n');
    const optOutLines = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /failClosed\s*:\s*false/.test(line) && !line.trim().startsWith('//'));
    assert.equal(optOutLines.length, 1, 'gateway.ts must carry exactly one failClosed:false call site');
    assert.ok(
      (lines[optOutLines[0]!.index - 1] ?? '').includes(SANCTIONED_MARKER),
      'the sanctioned marker must sit on the line directly above the opt-out',
    );
  });
});

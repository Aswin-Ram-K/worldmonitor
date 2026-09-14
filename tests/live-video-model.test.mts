import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyAttempt,
  LIVE_VIDEO_TIMING,
  parseSourceEntry,
  type PlayerObservation,
  type YouTubeVideoSnapshot,
} from '../src/services/live-video/model.ts';

describe('parseSourceEntry', () => {
  const accepted: ReadonlyArray<readonly [string, string, Record<string, string>]> = [
    ['bare video id', 'z_fY1pj1VBw', { kind: 'video', videoId: 'z_fY1pj1VBw' }],
    ['bare video id with whitespace', '  z_fY1pj1VBw\n', { kind: 'video', videoId: 'z_fY1pj1VBw' }],
    ['watch URL', 'https://www.youtube.com/watch?v=z_fY1pj1VBw', { kind: 'video', videoId: 'z_fY1pj1VBw' }],
    ['watch URL with extra params', 'https://m.youtube.com/watch?t=5&v=-xzg3wujOVM&ab_channel=X', { kind: 'video', videoId: '-xzg3wujOVM' }],
    ['watch URL without a scheme', 'youtube.com/watch?v=z_fY1pj1VBw', { kind: 'video', videoId: 'z_fY1pj1VBw' }],
    ['short link', 'https://youtu.be/z_fY1pj1VBw?si=abc', { kind: 'video', videoId: 'z_fY1pj1VBw' }],
    ['live URL', 'https://www.youtube.com/live/z_fY1pj1VBw', { kind: 'video', videoId: 'z_fY1pj1VBw' }],
    ['embed URL', 'https://www.youtube.com/embed/z_fY1pj1VBw?autoplay=1', { kind: 'video', videoId: 'z_fY1pj1VBw' }],
    ['nocookie embed URL', 'https://www.youtube-nocookie.com/embed/z_fY1pj1VBw', { kind: 'video', videoId: 'z_fY1pj1VBw' }],
    ['channel URL', 'https://www.youtube.com/channel/UCNye-wNBqNL5ZzHSJj3l8Bg', { kind: 'channel', channelId: 'UCNye-wNBqNL5ZzHSJj3l8Bg' }],
    ['channel live URL', 'https://www.youtube.com/channel/UCNye-wNBqNL5ZzHSJj3l8Bg/live', { kind: 'channel', channelId: 'UCNye-wNBqNL5ZzHSJj3l8Bg' }],
    ['channel live embed', 'https://www.youtube.com/embed/live_stream?channel=UCknLrEdhRCp1aegoMqRaCZg', { kind: 'channel', channelId: 'UCknLrEdhRCp1aegoMqRaCZg' }],
    ['bare channel id', 'UCknLrEdhRCp1aegoMqRaCZg', { kind: 'channel', channelId: 'UCknLrEdhRCp1aegoMqRaCZg' }],
    ['https manifest', 'https://live-hls-apps-aje-fa.getaj.net/AJE/index.m3u8', { kind: 'hls', url: 'https://live-hls-apps-aje-fa.getaj.net/AJE/index.m3u8' }],
    ['https manifest with a query', 'https://stream.ads.ottera.tv/playlist.m3u8?network_id=2116', { kind: 'hls', url: 'https://stream.ads.ottera.tv/playlist.m3u8?network_id=2116' }],
  ];

  for (const [label, entry, candidate] of accepted) {
    it(`accepts a ${label}`, () => {
      assert.deepEqual(parseSourceEntry(entry), { ok: true, entry, candidate });
    });
  }

  const rejected: ReadonlyArray<readonly [string, string, string]> = [
    ['an http manifest', 'http://example.com/live/index.m3u8', 'not-https'],
    ['a googlevideo manifest', 'https://manifest.googlevideo.com/api/manifest/hls_variant/id/index.m3u8', 'youtube-manifest'],
    ['a youtube.com manifest', 'https://www.youtube.com/api/manifest/hls_playlist/id/playlist.m3u8', 'youtube-manifest'],
    ['an @handle', '@CNN', 'needs-channel-url'],
    ['a handle live URL', 'https://www.youtube.com/@CNN/live', 'needs-channel-url'],
    ['a /c/ URL', 'https://www.youtube.com/c/CNN', 'needs-channel-url'],
    ['a /user/ URL', 'https://www.youtube.com/user/CNN', 'needs-channel-url'],
    ['an empty string', '   ', 'unrecognized'],
    ['free text', 'CNN live', 'unrecognized'],
    ['a watch URL with a short id', 'https://www.youtube.com/watch?v=short', 'unrecognized'],
    ['a live embed without a channel id', 'https://www.youtube.com/embed/live_stream?channel=CNN', 'unrecognized'],
    ['a non-YouTube page', 'https://example.com/watch?v=z_fY1pj1VBw', 'unrecognized'],
    ['a javascript URL', 'javascript:alert(1)', 'unrecognized'],
  ];

  for (const [label, entry, problem] of rejected) {
    it(`rejects ${label} as ${problem}`, () => {
      assert.deepEqual(parseSourceEntry(entry), { ok: false, entry, problem });
    });
  }
});

function video(overrides: Partial<YouTubeVideoSnapshot> = {}): YouTubeVideoSnapshot {
  return { videoId: 'gCNeDWCI0vo', isLive: true, title: 'Al Jazeera English | Live', author: 'Al Jazeera English', ...overrides };
}

function youtube(overrides: Partial<Extract<PlayerObservation, { api: 'loaded' }>> = {}): PlayerObservation {
  return {
    transport: 'youtube',
    api: 'loaded',
    candidate: 'video',
    elapsedMs: 3_000,
    frameLoaded: true,
    readyAtMs: 900,
    errorCode: null,
    video: null,
    durations: [],
    ...overrides,
  };
}

function hls(overrides: Partial<Extract<PlayerObservation, { transport: 'hls' }>> = {}): PlayerObservation {
  return { transport: 'hls', elapsedMs: 800, manifest: 'unknown', failure: null, ...overrides };
}

describe('classifyAttempt: YouTube', () => {
  it('calls an isLive stream live (Al Jazeera gCNeDWCI0vo, duration 4,056,940 s)', () => {
    const snapshot = video();
    assert.deepEqual(
      classifyAttempt(youtube({ video: snapshot, durations: [{ atMs: 2_000, seconds: 4_056_940 }] })),
      { verdict: 'live', video: snapshot },
    );
  });

  it('calls an ended stream a recording (Kyiv -Q7FuPINDjA, isLive=false, duration 24,181 s)', () => {
    const snapshot = video({ videoId: '-Q7FuPINDjA', isLive: false, author: 'DW News' });
    assert.deepEqual(
      classifyAttempt(youtube({ video: snapshot, durations: [{ atMs: 2_000, seconds: 24_181 }] })),
      { verdict: 'recording', video: snapshot },
    );
  });

  it('calls a short ended stream a recording (Shanghai 76EwqI5XZIc, duration 1,678 s)', () => {
    const snapshot = video({ videoId: '76EwqI5XZIc', isLive: false });
    assert.equal(classifyAttempt(youtube({ video: snapshot, durations: [{ atMs: 2_000, seconds: 1_678 }] })).verdict, 'recording');
  });

  it('keeps isLive=false pending while no positive duration has been sampled', () => {
    const snapshot = video({ isLive: false });
    assert.deepEqual(classifyAttempt(youtube({ video: snapshot })), { verdict: 'pending' });
    assert.deepEqual(classifyAttempt(youtube({ video: snapshot, durations: [{ atMs: 1_500, seconds: 0 }] })), { verdict: 'pending' });
  });

  for (const code of [2, 5, 100, 101, 150, 152, 153]) {
    it(`fails on player error ${code}`, () => {
      assert.deepEqual(classifyAttempt(youtube({ errorCode: code })), {
        verdict: 'failed',
        outcome: { kind: 'player-error', code },
      });
    });
  }

  it('lets a player error win over a live snapshot', () => {
    assert.equal(classifyAttempt(youtube({ errorCode: 150, video: video() })).verdict, 'failed');
  });

  it('reports a blocked IFrame API as unverifiable', () => {
    assert.deepEqual(classifyAttempt({ transport: 'youtube', api: 'blocked' }), {
      verdict: 'unverifiable',
      reason: 'player-api-blocked',
    });
  });

  it('fails a channel embed that stays ready with no video for the grace period', () => {
    const empty = video({ videoId: '', isLive: undefined, title: '', author: '' });
    const readyAtMs = 1_000;
    assert.deepEqual(
      classifyAttempt(youtube({ candidate: 'channel', video: empty, readyAtMs, elapsedMs: readyAtMs + LIVE_VIDEO_TIMING.channelEmptyGraceMs - 1 })),
      { verdict: 'pending' },
    );
    assert.deepEqual(
      classifyAttempt(youtube({ candidate: 'channel', video: empty, readyAtMs, elapsedMs: readyAtMs + LIVE_VIDEO_TIMING.channelEmptyGraceMs })),
      { verdict: 'failed', outcome: { kind: 'channel-not-live' } },
    );
  });

  it('never calls a video candidate channel-not-live', () => {
    const empty = video({ videoId: '', isLive: undefined });
    assert.deepEqual(classifyAttempt(youtube({ video: empty, readyAtMs: 1_000, elapsedMs: 9_000 })), { verdict: 'pending' });
  });

  describe('when YouTube stops exposing isLive', () => {
    const noFlag = video({ isLive: undefined });
    const windowMs = LIVE_VIDEO_TIMING.durationGrowthWindowMs;

    it('calls a duration that grows with wall time live', () => {
      assert.deepEqual(
        classifyAttempt(youtube({
          video: noFlag,
          elapsedMs: 8_000,
          durations: [{ atMs: 1_000, seconds: 100 }, { atMs: 1_000 + windowMs, seconds: 100 + windowMs / 1000 }],
        })),
        { verdict: 'live', video: noFlag },
      );
    });

    it('calls a flat positive duration a recording', () => {
      assert.deepEqual(
        classifyAttempt(youtube({
          video: noFlag,
          elapsedMs: 8_000,
          durations: [{ atMs: 1_000, seconds: 500 }, { atMs: 1_000 + windowMs, seconds: 500 }],
        })),
        { verdict: 'recording', video: noFlag },
      );
    });

    it('waits until the samples span the growth window', () => {
      assert.deepEqual(
        classifyAttempt(youtube({
          video: noFlag,
          durations: [{ atMs: 1_000, seconds: 100 }, { atMs: 1_000 + windowMs - 1, seconds: 106 }],
        })),
        { verdict: 'pending' },
      );
    });

    it('stays pending when the duration grows too slowly to be live', () => {
      assert.deepEqual(
        classifyAttempt(youtube({
          video: noFlag,
          durations: [{ atMs: 1_000, seconds: 100 }, { atMs: 1_000 + windowMs, seconds: 101 }],
        })),
        { verdict: 'pending' },
      );
    });
  });

  it('reports a loaded frame whose player never becomes ready as unverifiable at the deadline', () => {
    const deadline = LIVE_VIDEO_TIMING.verdictDeadlineMs;
    assert.deepEqual(classifyAttempt(youtube({ readyAtMs: null, elapsedMs: deadline - 1 })), { verdict: 'pending' });
    assert.deepEqual(classifyAttempt(youtube({ readyAtMs: null, elapsedMs: deadline })), {
      verdict: 'unverifiable',
      reason: 'player-api-silent',
    });
  });

  it('times out when the frame never loads', () => {
    assert.deepEqual(
      classifyAttempt(youtube({ frameLoaded: false, readyAtMs: null, elapsedMs: LIVE_VIDEO_TIMING.verdictDeadlineMs })),
      { verdict: 'failed', outcome: { kind: 'timeout' } },
    );
  });

  it('times out a ready player that never produced a verdict', () => {
    assert.deepEqual(
      classifyAttempt(youtube({ video: video({ isLive: false }), elapsedMs: LIVE_VIDEO_TIMING.verdictDeadlineMs })),
      { verdict: 'failed', outcome: { kind: 'timeout' } },
    );
  });
});

describe('classifyAttempt: HLS', () => {
  it('calls a live media playlist live', () => {
    assert.deepEqual(classifyAttempt(hls({ manifest: 'live' })), { verdict: 'live', video: null });
  });

  it('calls a VOD playlist a recording', () => {
    assert.deepEqual(classifyAttempt(hls({ manifest: 'vod' })), { verdict: 'recording', video: null });
  });

  it('fails on an HTTP status', () => {
    assert.deepEqual(classifyAttempt(hls({ failure: { kind: 'http', status: 404 } })), {
      verdict: 'failed',
      outcome: { kind: 'hls-http', status: 404 },
    });
  });

  it('fails on a fatal error', () => {
    assert.deepEqual(classifyAttempt(hls({ failure: { kind: 'fatal', detail: 'manifestParsingError' } })), {
      verdict: 'failed',
      outcome: { kind: 'hls-fatal', detail: 'manifestParsingError' },
    });
  });

  it('waits for an unknown manifest until the deadline, then times out', () => {
    assert.deepEqual(classifyAttempt(hls()), { verdict: 'pending' });
    assert.deepEqual(classifyAttempt(hls({ elapsedMs: LIVE_VIDEO_TIMING.verdictDeadlineMs })), {
      verdict: 'failed',
      outcome: { kind: 'timeout' },
    });
  });
});

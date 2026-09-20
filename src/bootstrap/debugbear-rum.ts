export const DEBUGBEAR_RUM_SCRIPT_SRC = 'https://cdn.debugbear.com/lpMwA9KpC6pf.js';
// 10% sampling. 100% overran the DebugBear RUM monthly quota (~529k/500k, 2026-07).
// Bootstrap transfer evidence and ongoing web-vitals RUM need only a fraction.
// Keep in sync with pro-test/src/debugbear-rum.ts (asserted by the test).
export const DEBUGBEAR_RUM_SAMPLE_RATE = 10;
const DEBUGBEAR_RUM_SCRIPT_PATHNAME = new URL(DEBUGBEAR_RUM_SCRIPT_SRC).pathname;
/** Every production host the RUM script loads on. Exported so
 * `tests/sentry-allow-urls.test.mts` can assert the Sentry ingest allowlist
 * covers the same population instead of restating it (#6545). */
export const DEBUGBEAR_RUM_HOSTS = new Set([
  'worldmonitor.app',
  'www.worldmonitor.app',
  'tech.worldmonitor.app',
  'finance.worldmonitor.app',
  'commodity.worldmonitor.app',
  'happy.worldmonitor.app',
  'energy.worldmonitor.app',
]);

import type { BootstrapTransferRumSample } from './bootstrap-transfer-rum';

type DebugBearRumEvent =
  | ['presampling', number]
  | ['error' | 'unhandledrejection', DebugBearRumErrorSnapshot]
  | ['metric1' | 'metric2' | 'metric3', number]
  | ['tag1' | 'tag2' | 'tag3', string];

/** Primitive snapshot of an error event. The vendor queue must never retain
 * live Event/Error/DOM references — only the fields triage needs.
 *
 * The field set is dictated by the collector's decoder, which reads a queued
 * entry as a duck-typed Event. Verified against cdn.debugbear.com's shipped
 * bundle, whose per-error mapper emits
 * `[Math.round(t.timeStamp), message, filename, funcName, lineNo, colNo]`:
 *
 *  - `timeStamp` is read unconditionally, so omitting it yields NaN -> null.
 *  - message resolution is `e = (t instanceof ErrorEvent) ? t.error : t.reason`,
 *    then `e == null ? ('message' in t ? t.message : 'Message unknown') : String(e)`.
 *    A plain object is never an ErrorEvent, so a **present** `reason` always
 *    wins — an empty-string `reason` would shadow `message` and decode to "".
 *    `reason` is therefore OPTIONAL and must stay absent for plain errors.
 *  - `filename`/`lineno`/`colno` are read directly and need no adaptation.
 *
 * Stack traces are deliberately not forwarded: the decoder only reads a stack
 * off `t.error`/`t.reason` (i.e. a live Error), which is exactly the retention
 * this snapshot exists to avoid. Sentry is the stack-trace source of truth —
 * sentry-defer.ts installs its own independent listeners with full stacks. */
export interface DebugBearRumErrorSnapshot {
  type: string;
  timeStamp: number;
  message: string;
  filename: string;
  lineno: number;
  colno: number;
  reason?: string;
}

/** Same bound as the sibling Sentry pre-init queue in sentry-defer.ts: an
 * adversarial extension or noisy error loop must not grow the vendor array
 * without bound while the CDN script is blocked or after it drains the queue. */
export const DEBUGBEAR_RUM_ERROR_QUEUE_MAX = 50;

declare global {
  interface Window {
    dbbRum?: DebugBearRumEvent[];
  }
}

let debugBearRumStarted = false;

export function shouldEnableDebugBearRum(hostname: string): boolean {
  return DEBUGBEAR_RUM_HOSTS.has(hostname.toLowerCase());
}

/** Identifies a Sentry frame emitted by the configured DebugBear collector. */
export function isDebugBearRumScriptFrame(filename: string): boolean {
  return filename.endsWith(DEBUGBEAR_RUM_SCRIPT_PATHNAME) || /debugbear/i.test(filename);
}

/** Returns the collector script element and whether THIS call created it.
 * The distinction is load-bearing: a script that was already in the DOM may
 * have already fired 'load'/'error', and those events never fire again — so
 * a teardown attached to a pre-existing element can never run. */
function loadDebugBearRumScript(): { script: HTMLScriptElement | null; isNew: boolean } {
  if (typeof document === 'undefined') return { script: null, isNew: false };
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${DEBUGBEAR_RUM_SCRIPT_SRC}"]`);
  if (existing) return { script: existing, isNew: false };

  const script = document.createElement('script');
  script.async = true;
  script.src = DEBUGBEAR_RUM_SCRIPT_SRC;
  if ('fetchPriority' in script) {
    script.fetchPriority = 'low';
  }
  document.head.appendChild(script);
  return { script, isNew: true };
}

export function initDebugBearRum(): void {
  if (debugBearRumStarted || typeof window === 'undefined' || typeof document === 'undefined') return;
  if (!shouldEnableDebugBearRum(window.location.hostname)) return;
  if (Math.random() * 100 >= DEBUGBEAR_RUM_SAMPLE_RATE) return;

  debugBearRumStarted = true;
  const queue = window.dbbRum ?? [];
  window.dbbRum = queue;
  queue.push(['presampling', DEBUGBEAR_RUM_SAMPLE_RATE]);

  const { script, isNew } = loadDebugBearRumScript();
  // Only buffer while a script WE started is still in flight. A pre-existing
  // element may have already fired 'load'/'error' — those never fire again,
  // so a teardown hung off it would never run and both window listeners would
  // stay attached for the page lifetime, pushing into an array the collector
  // has already drained. In that case the collector either owns error capture
  // already or never will, so there is nothing for us to buffer.
  if (!isNew) return;

  const onRumError = (event: Event): void => {
    pushBounded(queue, ['error', snapshotRumError(event)]);
  };
  const onRumRejection = (event: Event): void => {
    pushBounded(queue, ['unhandledrejection', snapshotRumError(event)]);
  };
  window.addEventListener('error', onRumError);
  window.addEventListener('unhandledrejection', onRumRejection);

  // Detach once the vendor script loads — its own handlers own error capture
  // from there on — and also on load failure (adblock/CDN outage) so a
  // page-lifetime push path into a stale array never stays attached.
  // reportBootstrapTransferRum keeps working: it writes metrics/tags
  // directly, not through these listeners.
  const teardown = (): void => {
    window.removeEventListener('error', onRumError);
    window.removeEventListener('unhandledrejection', onRumRejection);
  };
  script?.addEventListener?.('load', teardown, { once: true });
  script?.addEventListener?.('error', teardown, { once: true });
}

function pushBounded(queue: DebugBearRumEvent[], entry: DebugBearRumEvent): void {
  // Evict the oldest ERROR entry by kind, never by index. The collector reads
  // queued entries by name (`presampling`, `metric1`..`tag3`), so those slots
  // carry page-level measurements that cannot be re-derived, while error
  // snapshots are individually expendable. Evicting index 1 unconditionally
  // discarded the bootstrap transfer sample once ~44 errors had accumulated
  // after it was reported — losing the RUM data precisely on the noisiest
  // pages, which is when it is most worth having. The array is the vendor's
  // protocol buffer, so evict rather than refuse.
  if (queue.length >= DEBUGBEAR_RUM_ERROR_QUEUE_MAX) {
    const oldestError = queue.findIndex(
      ([kind]) => kind === 'error' || kind === 'unhandledrejection',
    );
    // No error to drop means the queue is all named slots; refuse rather than
    // evict a measurement.
    if (oldestError < 0) return;
    queue.splice(oldestError, 1);
  }
  queue.push(entry);
}

export function snapshotRumError(event: Event): DebugBearRumErrorSnapshot {
  const asRecord = event as unknown as Record<string, unknown>;
  const reason = asRecord['reason'];
  const error = asRecord['error'];
  const readString = (value: unknown): string =>
    typeof value === 'string' ? value.slice(0, 500) : '';
  const readNumber = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const snapshot: DebugBearRumErrorSnapshot = {
    type: typeof event.type === 'string' ? event.type.slice(0, 32) : 'error',
    // Read unconditionally by the collector's decoder; absent -> NaN -> null.
    timeStamp: readNumber(asRecord['timeStamp']),
    message: readString(asRecord['message'])
      || (error instanceof Error ? error.message.slice(0, 500) : ''),
    filename: readString(asRecord['filename']),
    lineno: readNumber(asRecord['lineno']),
    colno: readNumber(asRecord['colno']),
  };
  // Set `reason` ONLY for a genuine rejection. A present reason — even '' —
  // shadows `message` in the collector's decoder, which is what made ordinary
  // errors decode with an empty message.
  if (reason !== undefined && reason !== null) {
    snapshot.reason = reason instanceof Error
      ? reason.message.slice(0, 500)
      : String(reason).slice(0, 500);
  }
  return snapshot;
}

export function isDebugBearRumActive(): boolean {
  return debugBearRumStarted;
}

/**
 * Page-level bootstrap transfer fields. One tier is selected per page so a
 * later tier cannot overwrite the same DebugBear custom slots. The payload
 * contains only closed tags and numeric measurements; no request or stable ID.
 */
export function reportBootstrapTransferRum(sample: BootstrapTransferRumSample): void {
  if (!debugBearRumStarted || typeof window === 'undefined' || !window.dbbRum) return;
  const queue = window.dbbRum;
  for (const entry of [
    ['metric1', sample.duration_ms],
    ['metric2', sample.decoded_bytes],
    ['metric3', sample.encoded_bytes],
    ['tag1', sample.tier],
    ['tag2', sample.outcome],
    ['tag3', sample.device_class],
  ] as DebugBearRumEvent[]) {
    pushBounded(queue, entry);
  }
}

export function resetDebugBearRumForTesting(): void {
  debugBearRumStarted = false;
}

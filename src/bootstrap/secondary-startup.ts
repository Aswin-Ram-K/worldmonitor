import { scheduleAfterFirstPaint } from '@/utils/after-paint';
import type { BeforeSendEvent } from '@vercel/analytics';

let vercelAnalyticsScheduled = false;
let dashboardFontsScheduled = false;

export interface DashboardFontContext {
  variant?: string | null;
  lang?: string | null;
  dir?: string | null;
}

export type DashboardFontFamily = 'nunito' | 'tajawal';

// Which web-font families the dashboard actually needs for a given variant/locale.
// The default (full variant, LTR/non-Arabic) needs none — its body font is the
// system/mono stack — so those users download zero web fonts.
export function dashboardFontFamilies(context: DashboardFontContext = {}): DashboardFontFamily[] {
  const variant = (context.variant || 'full').toLowerCase();
  const lang = (context.lang || 'en').split('-')[0]?.toLowerCase() || 'en';
  const dir = (context.dir || '').toLowerCase();
  const families: DashboardFontFamily[] = [];

  if (variant === 'happy') families.push('nunito');             // happy theme body font
  if (dir === 'rtl' || lang === 'ar') families.push('tajawal'); // Arabic body font

  return families;
}

// Self-hosted @fontsource loaders — Vite bundles these to hashed /assets/*.woff2,
// served immutable (vercel.json) and therefore cached at the CDN/Cloudflare edge
// (unlike fonts.gstatic.com, a third-party origin). Each family pulls only the
// weights the UI actually uses.
const DASHBOARD_FONT_LOADERS: Record<DashboardFontFamily, () => Promise<unknown>> = {
  nunito: () => Promise.all([
    import('@fontsource/nunito/400.css'),
    import('@fontsource/nunito/600.css'),
    import('@fontsource/nunito/700.css'),
    import('@fontsource/nunito/400-italic.css'),
  ]),
  tajawal: () => Promise.all([
    import('@fontsource/tajawal/400.css'),
    import('@fontsource/tajawal/500.css'),
    import('@fontsource/tajawal/700.css'),
  ]),
};

function getBuildVariant(): string {
  try {
    return import.meta.env.VITE_VARIANT || 'full';
  } catch {
    return 'full';
  }
}

let dashboardFontsLoaded = false;

function loadDeferredDashboardFonts(): void {
  if (typeof document === 'undefined' || dashboardFontsLoaded) return;

  const root = document.documentElement;
  const families = dashboardFontFamilies({
    variant: root.dataset.variant || getBuildVariant(),
    lang: root.lang || 'en',
    dir: root.dir || '',
  });
  if (families.length === 0) return;

  dashboardFontsLoaded = true;
  void Promise.all(families.map((family) => DASHBOARD_FONT_LOADERS[family]())).catch(() => {
    // Self-hosted fonts are best-effort; the system fallback stack covers failures.
  });
}

export function initDeferredDashboardFonts(): void {
  if (dashboardFontsScheduled) return;
  dashboardFontsScheduled = true;
  scheduleAfterFirstPaint(loadDeferredDashboardFonts, 3000);
}

export function initVercelAnalytics(): void {
  if (vercelAnalyticsScheduled || typeof window === 'undefined') return;
  vercelAnalyticsScheduled = true;
  scheduleAfterFirstPaint(() => {
    void import('@vercel/analytics')
      .then(({ inject }) => {
        inject({
          beforeSend: (event) => {
            const redacted = redactAnalyticsUrl(event);
            // Sampling is a cost control, not a privacy control — the
            // redaction above must hold for every sampled event.
            return Math.random() > 0.1 ? null : redacted;
          },
        });
      })
      .catch(() => {
        // Analytics is best-effort. Ad blockers/offline users should not affect boot.
      });
  }, 3000);
}

/**
 * Query keys that must never reach Vercel Analytics: checkout/provisioning
 * secrets, the Business Pro invite token, referral codes, Clerk handshake
 * material, and checkout-funnel params (discount/referral codes). Vercel's
 * beforeSend exists to redact event.url before ingest; sampling does not.
 *
 * This is the ANALYTICS-ONLY list. The boot-time live-URL strip below uses a
 * much narrower list: anything a deferred consumer still needs to read
 * (referral codes, checkout-intent params, invite tokens, Dodo IDs) must
 * survive until that consumer runs, so it can never be stripped at boot.
 */
const SENSITIVE_ANALYTICS_QUERY_RE = /^(token|access_token|id_token|refresh_token|auth_token|invite_token|accept-business-invite|email|user_email|customer_email|license_key|licensekey|subscription_id|payment_id|ref|wm_referral|checkoutproduct|checkoutreferral|checkoutdiscount|checkout_product|checkout_referral|checkout_discount|__clerk[a-z_]*|affonso_referral|discount|coupon|promo|voucher)$/i;

const SENSITIVE_ANALYTICS_HASH_RE = /^(token|access_token|id_token|refresh_token|__clerk[a-z_]*|email|license_key)$/i;

/**
 * Params safe to strip from the live URL at boot: read by nobody.
 * handleCheckoutReturn() only DELETES email/license_key (never branches on
 * them), so removing these before analytics/RUM init cannot break referral
 * capture, checkout-intent resume, the invite acceptor, or Dodo returns.
 *
 * `__clerk*` is deliberately NOT here. The Clerk SDK reads its own params off
 * `window.location.href` when it loads, and it loads LATE — scheduleClerkLoad
 * defers it to requestIdleCallback, long after this runs synchronously at
 * main.ts module scope. Verified against the shipped @clerk/clerk-js bundle:
 * `__clerk_status` / `__clerk_created_session` (email-link verification) and
 * `__clerk_ticket` (ticket sign-in/up) are read with no dev/prod/satellite
 * gating, so stripping them here breaks those flows on the production primary
 * domain. Only `__clerk_db_jwt` is dev-instance-gated, and `__clerk_handshake`
 * is only ever deleted by the SDK, never read.
 *
 * Clerk params are still kept out of telemetry: SENSITIVE_ANALYTICS_QUERY_RE
 * redacts `__clerk[a-z_]*` per-event in beforeSend, which is the vector this
 * boot strip was reaching for. The live URL must be left alone.
 */
const STRIPPABLE_AT_BOOT_RE = /^(email|license_key|licensekey)$/i;

/** Delete every key matching `pattern`. The single place that decides what
 * "sensitive" means, so a caller's key list can never be silently ignored by
 * one of several copies of this loop. */
function scrubParams(params: URLSearchParams, pattern: RegExp): boolean {
  let changed = false;
  for (const key of [...params.keys()]) {
    if (pattern.test(key)) {
      params.delete(key);
      changed = true;
    }
  }
  return changed;
}

function scrubUrlSearchParams(parsed: URL, pattern: RegExp): boolean {
  return scrubParams(parsed.searchParams, pattern);
}

/** Scrub secret-bearing key=value pairs from a hash fragment, covering both
 * `#head?k=v` and OAuth-style `#k=v&k2=v2` shapes. Returns the scrubbed
 * fragment (without the leading #), or null when nothing was sensitive.
 *
 * `pattern` is the CALLER's key list, not a hardcoded one: the boot-time
 * strip deliberately uses a much narrower list than the analytics redaction,
 * and hardcoding the analytics list here made the boot strip delete
 * fragment-carried params its own contract promises to preserve. */
function scrubHashFragment(fragment: string, pattern: RegExp): string | null {
  const qIndex = fragment.indexOf('?');
  if (qIndex >= 0) {
    const head = fragment.slice(0, qIndex);
    const hashParams = new URLSearchParams(fragment.slice(qIndex + 1));
    if (!scrubParams(hashParams, pattern)) return null;
    const rebuilt = hashParams.toString();
    return rebuilt ? `${head}?${rebuilt}` : head;
  }
  // No '?' — OAuth implicit-flow style `#access_token=..&token_type=..`.
  if (!fragment.includes('=') && !fragment.includes('&')) {
    return pattern.test(fragment) ? '' : null;
  }
  const hashParams = new URLSearchParams(fragment);
  return scrubParams(hashParams, pattern) ? hashParams.toString() : null;
}

/** Key list for the analytics hash path: the query list plus the hash-only
 * additions. Built once so the two regexes cannot drift apart at a call site. */
const SENSITIVE_ANALYTICS_HASH_COMBINED_RE = new RegExp(
  `(${SENSITIVE_ANALYTICS_QUERY_RE.source})|(${SENSITIVE_ANALYTICS_HASH_RE.source})`,
  'i',
);

export function redactAnalyticsUrl(event: BeforeSendEvent): BeforeSendEvent {
  const raw = event.url;
  if (typeof raw !== 'string' || raw.length === 0) return event;
  // Decide the output shape from the INPUT, not the serialized output. A
  // browser always has window.location.origin set and production event.url is
  // an absolute same-origin URL, so testing the output's prefix made the
  // rewrite fire on every redacted event — reporting exactly the events that
  // carried a secret with a path-only URL while clean events stayed absolute.
  const wasAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//');
  let parsed: URL;
  try {
    // Relative analytics URLs resolve against the current origin in the
    // browser; without a window (tests) only absolute URLs parse, which is
    // all production pageview events carry. Deliberately no hardcoded
    // parse-base host here: a literal would read as a fetched host to the
    // source-attribution scanner and stale the manifest.
    const base = typeof window !== 'undefined' ? window.location.origin : undefined;
    parsed = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return event;
  }
  let changed = scrubUrlSearchParams(parsed, SENSITIVE_ANALYTICS_QUERY_RE);
  if (parsed.hash) {
    const scrubbed = scrubHashFragment(parsed.hash.slice(1), SENSITIVE_ANALYTICS_HASH_COMBINED_RE);
    if (scrubbed !== null) {
      parsed.hash = scrubbed ? `#${scrubbed}` : '';
      changed = true;
    }
  }
  if (!changed) return event;
  const redacted = parsed.toString();
  // Strip the parse-only base ONLY when the incoming url was itself relative,
  // so a redacted event keeps the same shape as an unredacted one.
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const url = !wasAbsolute && origin && redacted.startsWith(origin)
    ? redacted.slice(origin.length) || '/'
    : redacted;
  return { ...event, url };
}

/**
 * Strip unread secret params from the live URL at startup — runs from main.ts
 * before analytics/RUM init, not after App.init's network awaits. Only keys
 * no deferred consumer reads (STRIPPABLE_AT_BOOT_RE): referral codes,
 * checkout-intent params, invite tokens, and Dodo IDs must survive until
 * captureReferralFromUrl / capturePendingCheckoutIntentFromUrl / the invite
 * acceptor / handleCheckoutReturn run, and those consumers delete their own
 * params afterwards. This is the early backstop so RUM pageviews can never
 * carry the unread secrets; the per-event beforeSend above covers the rest.
 */
export function stripSensitiveParamsFromUrl(): void {
  if (typeof window === 'undefined') return;
  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch {
    return;
  }
  let changed = scrubUrlSearchParams(url, STRIPPABLE_AT_BOOT_RE);
  if (url.hash) {
    const scrubbed = scrubHashFragment(url.hash.slice(1), STRIPPABLE_AT_BOOT_RE);
    if (scrubbed !== null) {
      url.hash = scrubbed ? `#${scrubbed}` : '';
      changed = true;
    }
  }
  if (!changed) return;
  const clean = url.pathname
    + (url.searchParams.toString() ? `?${url.searchParams.toString()}` : '')
    + url.hash;
  try {
    window.history.replaceState({}, '', clean);
  } catch (error) {
    // History API unavailable (extreme embed/iframe cases). This is the one
    // failure that silently defeats the strip — the secrets stay in the live
    // URL and RUM reads them — so it must leave a trace rather than a guess.
    // enqueueSentryCall buffers until Sentry initialises, so this is safe on
    // the boot path.
    void import('@/bootstrap/sentry-defer')
      .then(({ enqueueSentryCall }) => {
        enqueueSentryCall((s) => {
          s.captureException(error, { tags: { kind: 'boot_url_strip_failed' } });
        });
      })
      .catch(() => {
        // Reporting is best-effort; never let it break boot.
      });
  }
}

export function resetVercelAnalyticsForTesting(): void {
  vercelAnalyticsScheduled = false;
}

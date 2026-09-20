/**
 * Anonymous read of the operator notification-link suppression set (#8401).
 *
 * GET /api/notification-suppressions → { suppressed: string[], hosts: string[], updatedAt }
 *
 * The service worker consults this on notification click so an already-
 * delivered push payload stops navigating once its URL is blocked. It is
 * intentionally anonymous and uncached-per-user: the payload is an operator
 * incident control, not user data, and the SW has no auth context at click
 * time. Entries are stored normalized (see
 * scripts/shared/notification-link-suppression.cjs) so the set is safe to
 * expose verbatim — it contains only blocked URLs/hosts, no user state.
 *
 * Fail-open with `unavailable: true` when Redis cannot be read: the SW
 * treats that as "no information" and still navigates, rather than
 * stranding every notification click during a Redis outage.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from './_json-response.js';
// @ts-expect-error — JS module, no declaration file
import { getRedisCredentials } from './_upstash-json.js';

const SUPPRESSIONS_KEY = 'notif:blocked-links:v1';
const HOST_PREFIX = 'host:';

function normalizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return null;
  let host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (host.length === 0) return null;
  const isDefaultPort =
    (protocol === 'http:' && parsed.port === '80') ||
    (protocol === 'https:' && parsed.port === '443');
  if (parsed.port && !isDefaultPort) host += `:${parsed.port}`;
  let path = parsed.pathname || '/';
  try {
    path = decodeURI(path);
  } catch {
    // Malformed % sequences stay encoded — still comparable, just verbatim.
  }
  return `${protocol}//${host}${path}${parsed.search}${parsed.hash}`;
}

function normalizeHost(raw) {
  if (typeof raw !== 'string') return null;
  const host = raw.trim().toLowerCase().replace(/\.+$/, '');
  if (host.length === 0 || host.length > 253) return null;
  if (host.includes('/') || host.includes(':') || host.includes('?') || host.includes('#')) return null;
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)) return null;
  return host;
}

function splitEntries(entries) {
  const suppressed = [];
  const hosts = [];
  if (!Array.isArray(entries)) return { suppressed, hosts };
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.toLowerCase().startsWith(HOST_PREFIX)) {
      const host = normalizeHost(trimmed.slice(HOST_PREFIX.length));
      if (host && !hosts.includes(host)) hosts.push(host);
      continue;
    }
    const url = normalizeUrl(trimmed);
    if (url && !suppressed.includes(url)) suppressed.push(url);
  }
  return { suppressed, hosts };
}

export async function readSuppressionSnapshot(fetchImpl = (...args) => globalThis.fetch(...args)) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { readable: false, entries: null };
  try {
    const res = await fetchImpl(`${url}/SMEMBERS/${encodeURIComponent(SUPPRESSIONS_KEY)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'worldmonitor-edge/1.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { readable: false, entries: null };
    const json = await res.json().catch(() => null);
    const entries = json && Object.prototype.hasOwnProperty.call(json, 'result') ? json.result : undefined;
    if (!Array.isArray(entries)) return { readable: false, entries: null };
    return { readable: true, entries };
  } catch {
    return { readable: false, entries: null };
  }
}

export default async function handler(req) {
  const cors = getCorsHeaders(req, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  const creds = getRedisCredentials();
  if (!creds) {
    return jsonResponse({ suppressed: [], hosts: [], updatedAt: null, unavailable: true }, 200, {
      ...cors,
      // Never cache the fail-open shape: during a Redis blip the first miss
      // would otherwise poison the CDN and keep answering unavailable:true
      // (navigate) after Redis recovers — delaying the revoke exactly when
      // it matters.
      'Cache-Control': 'no-store',
    });
  }

  const snapshot = await readSuppressionSnapshot();
  if (!snapshot.readable) {
    return jsonResponse({ suppressed: [], hosts: [], updatedAt: null, unavailable: true }, 200, {
      ...cors,
      'Cache-Control': 'no-store',
    });
  }
  const { suppressed, hosts } = splitEntries(snapshot.entries);
  return jsonResponse({ suppressed, hosts, updatedAt: new Date().toISOString() }, 200, {
    ...cors,
    // 60s shared cache: fast enough for incident response (the SW also
    // revalidates per click past its own TTL), slow enough to absorb a
    // click storm on one hostile notification.
    'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=30',
  });
}

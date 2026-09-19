/**
 * RPC: executeBatch -- Runs up to 20 documented GET operations in one request.
 *
 * The generic REST batch endpoint (POST /api/batch/v1/execute): agents acting
 * on many items send an array of operations instead of looping single calls.
 * Each operation is re-dispatched as a same-origin GET through the public
 * gateway, so per-endpoint auth, entitlements, caching, and usage telemetry
 * all apply to every sub-request exactly as if it were sent directly (a batch
 * is a transport optimization, not a quota bypass). Rate limits are the one
 * control the re-dispatch cannot inherit — the gateway would key them to the
 * platform's egress IP — so each operation is charged to the CALLER's own
 * budget here, before dispatch (see chargeCaller).
 */

import type {
  ServerContext,
  ExecuteBatchRequest,
  ExecuteBatchResponse,
  BatchOperation,
  BatchOperationBody,
  BatchOperationResult,
  FieldViolation,
} from '../../../../src/generated/server/worldmonitor/batch/v1/service_server';
import {
  ApiError,
  ValidationError,
} from '../../../../src/generated/server/worldmonitor/batch/v1/service_server';
import type { EndpointRateLimitOptions } from '../../../_shared/rate-limit';
import {
  checkEndpointRateLimit,
  checkRateLimit,
  hasEndpointRatePolicy,
} from '../../../_shared/rate-limit';
import { TRUSTED_USER_ID_HEADER } from '../../../_shared/mcp-internal-hmac';

export const MAX_BATCH_OPERATIONS = 20;
export const MAX_OPERATION_ID_LENGTH = 64;
export const MAX_OPERATION_PATH_LENGTH = 2048;
export const SUB_REQUEST_TIMEOUT_MS = 10_000;
// Per-operation response ceiling. Callers needing large payloads should batch
// fewer operations or trim each body with a ?jmespath= projection.
export const MAX_SUB_RESPONSE_BYTES = 1_048_576;
// Marks gateway-bound sub-requests so a batched /api/batch/* call can never
// recurse even if path validation regresses.
export const BATCH_MARKER_HEADER = 'x-wm-batch';

// Only credentials + content negotiation cross into sub-requests. Everything
// else (cookies, tracing, internal trust markers) is dropped by allowlist —
// the gateway re-derives what it needs per sub-request.
const FORWARDED_HEADERS = ['authorization', 'x-worldmonitor-key', 'x-api-key', 'accept-language'] as const;

// A batched path must name a documented RPC: /api/<domain>/v<N>/<rpc> (proto
// domains) or /api/v2/<domain>/<rpc> (partner v2). Query strings are allowed
// and pass through untouched (filters, pagination, ?jmespath= projections).
const RPC_PATH_RE = /^\/api\/[a-z][a-z0-9-]*\/v\d+\/[a-z][a-z0-9-]*$/;
const V2_PATH_RE = /^\/api\/v2\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

// The Cloudflare WAF in front of api.worldmonitor.app rejects generic
// user agents, so sub-requests always carry a descriptive one.
const DEFAULT_SUB_REQUEST_USER_AGENT =
  'WorldMonitor-Batch/1.0 (+https://www.worldmonitor.app/openapi.json)';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type ValidatedOperation = {
  id: string;
  /** Fully resolved same-origin URL, or null when the path was rejected. */
  target: URL | null;
  /** Per-operation failure reason when target is null. */
  error: 'invalid_path' | 'nested_batch' | null;
};

function validateOperations(operations: BatchOperation[], origin: string): {
  validated: ValidatedOperation[];
  violations: FieldViolation[];
} {
  const validated: ValidatedOperation[] = [];
  const violations: FieldViolation[] = [];
  const seenIds = new Set<string>();

  operations.forEach((op, index) => {
    const rawId = typeof op.id === 'string' ? op.id.trim() : '';
    const id = rawId || String(index);
    if (id.length > MAX_OPERATION_ID_LENGTH) {
      violations.push({
        field: `operations[${index}].id`,
        description: `must be at most ${MAX_OPERATION_ID_LENGTH} characters`,
      });
      return;
    }
    if (seenIds.has(id)) {
      violations.push({
        field: `operations[${index}].id`,
        description: `duplicate id "${id}" — results would be ambiguous`,
      });
      return;
    }
    seenIds.add(id);

    const path = typeof op.path === 'string' ? op.path : '';
    if (!path || path.length > MAX_OPERATION_PATH_LENGTH || !path.startsWith('/')) {
      validated.push({ id, target: null, error: 'invalid_path' });
      return;
    }

    let target: URL;
    try {
      target = new URL(path, origin);
    } catch {
      validated.push({ id, target: null, error: 'invalid_path' });
      return;
    }
    // `new URL('//evil.com/x', origin)` resolves to a foreign origin — the
    // origin equality check is the SSRF guard, the regexes are the contract.
    if (target.origin !== origin) {
      validated.push({ id, target: null, error: 'invalid_path' });
      return;
    }
    if (target.pathname.startsWith('/api/batch/')) {
      validated.push({ id, target: null, error: 'nested_batch' });
      return;
    }
    if (!RPC_PATH_RE.test(target.pathname) && !V2_PATH_RE.test(target.pathname)) {
      validated.push({ id, target: null, error: 'invalid_path' });
      return;
    }
    validated.push({ id, target, error: null });
  });

  return { validated, violations };
}

function buildSubRequestHeaders(inbound: Headers): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = inbound.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('accept', 'application/json');
  headers.set('user-agent', inbound.get('user-agent') ?? DEFAULT_SUB_REQUEST_USER_AGENT);
  headers.set(BATCH_MARKER_HEADER, '1');
  return headers;
}

/**
 * Rate-limit identity of the BATCH CALLER, mirroring the gateway's own
 * attribution so a batched operation charges the same bucket a direct call
 * would: a validated wm_ user key is scoped `api_key`, any other
 * gateway-authenticated principal is the session, and everything else falls
 * back to the caller's IP inside the limiter.
 */
function callerRateLimitOptions(inbound: Headers): EndpointRateLimitOptions {
  const principalUserId = inbound.get(TRUSTED_USER_ID_HEADER);
  if (!principalUserId) return {};
  const wmKey = inbound.get('x-worldmonitor-key') ?? inbound.get('x-api-key') ?? '';
  return { principalUserId, principalScope: wmKey.startsWith('wm_') ? 'api_key' : 'session' };
}

/**
 * Charges one sub-operation against the batch caller's own budget BEFORE it is
 * dispatched. Sub-requests are re-dispatched as same-origin GETs, so the
 * gateway re-derives their identity from the platform's fetch egress IP — a
 * bucket the caller does not own. Without this pre-charge a single batch buys
 * up to MAX_BATCH_OPERATIONS endpoint admissions that never touch the caller's
 * per-IP/per-principal budget, which is exactly the "each operation is
 * rate-limited as if sent directly" contract this endpoint publishes.
 *
 * Refusals are returned as the sub-result the caller would have received had
 * the operation been sent directly (429, or 503 when the limiter itself is
 * unavailable and the endpoint policy fails closed), and the operation is not
 * dispatched.
 */
async function chargeCaller(
  op: ValidatedOperation,
  inbound: Request,
  opts: EndpointRateLimitOptions,
): Promise<BatchOperationResult | null> {
  if (!op.target) return null;
  const pathname = op.target.pathname;
  // Mirror the gateway's two-phase order: an explicit endpoint policy governs
  // the path on its own; everything else charges the global per-IP fallback.
  const refusal = hasEndpointRatePolicy(pathname)
    ? await checkEndpointRateLimit(inbound, pathname, {}, opts)
    : await checkRateLimit(inbound, {}, opts);
  if (!refusal) return null;

  let body: unknown;
  try {
    body = await refusal.json();
  } catch {
    body = {};
  }
  return { id: op.id, status: refusal.status, body: body as BatchOperationBody, error: '' };
}

async function runOperation(
  op: ValidatedOperation,
  headers: Headers,
  fetchImpl: FetchLike,
): Promise<BatchOperationResult> {
  if (!op.target) {
    return { id: op.id, status: 0, error: op.error ?? 'invalid_path' };
  }

  let response: Response;
  try {
    response = await fetchImpl(op.target.toString(), {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(SUB_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { id: op.id, status: 0, error: isTimeout ? 'timeout' : 'fetch_failed' };
  }

  const contentLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_SUB_RESPONSE_BYTES) {
    try { await response.body?.cancel(); } catch { /* already drained */ }
    return { id: op.id, status: response.status, error: 'response_too_large' };
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    return { id: op.id, status: response.status, error: 'fetch_failed' };
  }
  if (text.length > MAX_SUB_RESPONSE_BYTES) {
    return { id: op.id, status: response.status, error: 'response_too_large' };
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { id: op.id, status: response.status, error: 'invalid_json' };
  }

  return { id: op.id, status: response.status, body: body as BatchOperationBody, error: '' };
}

export function createExecuteBatch(
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
) {
  return async function executeBatch(
    ctx: ServerContext,
    req: ExecuteBatchRequest,
  ): Promise<ExecuteBatchResponse> {
    // Recursion guard: the gateway forwards the marker untouched, so a batch
    // arriving with it was issued BY a batch — refuse regardless of the
    // per-path nested_batch check below.
    if (ctx.request.headers.has(BATCH_MARKER_HEADER)) {
      throw new ApiError(400, 'Nested batch requests are not allowed', '');
    }

    const operations = Array.isArray(req.operations) ? req.operations : [];
    if (operations.length < 1 || operations.length > MAX_BATCH_OPERATIONS) {
      throw new ValidationError([{
        field: 'operations',
        description: `must contain between 1 and ${MAX_BATCH_OPERATIONS} operations`,
      }]);
    }

    const origin = new URL(ctx.request.url).origin;
    const { validated, violations } = validateOperations(operations, origin);
    if (violations.length > 0) {
      throw new ValidationError(violations);
    }

    const headers = buildSubRequestHeaders(ctx.request.headers);
    const rateLimitOpts = callerRateLimitOptions(ctx.request.headers);
    const results = await Promise.all(
      validated.map(async (op) => {
        const refused = await chargeCaller(op, ctx.request, rateLimitOpts);
        return refused ?? runOperation(op, headers, fetchImpl);
      }),
    );

    const succeeded = results.filter((r) => r.status >= 200 && r.status < 300 && !r.error).length;
    return { results, succeeded, failed: results.length - succeeded };
  };
}

export const executeBatch = createExecuteBatch();

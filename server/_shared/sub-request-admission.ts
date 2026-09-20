import { runRedisPipeline } from './redis';
import { canonicalGatewayQueryString, sha256Hex } from './mcp-internal-hmac';

export const SUB_REQUEST_MARKER_HEADER = 'x-wm-sub-request';
const ADMISSION_TTL_SECONDS = 30;
const ADMISSION_PREFIX = 'sub-request-admission:v1:';

// Bind admission to the charged principal (null means IP), GET and credentials.
// Store only a digest: credentials must never enter the Redis value or key.
async function requestDigest(request: Request, principal: string | null): Promise<string> {
  const url = new URL(request.url);
  return sha256Hex(JSON.stringify([
    principal,
    request.method,
    url.origin,
    url.pathname,
    canonicalGatewayQueryString(url),
    request.headers.get('authorization'),
    request.headers.get('x-worldmonitor-key'),
    request.headers.get('x-api-key'),
  ]));
}

/** Issue only after the caller has paid the endpoint/global admission. */
export async function issueSubRequestAdmission(request: Request, principal: string | null = null): Promise<string | null> {
  if (request.method !== 'GET') return null;
  const token = crypto.randomUUID();
  const digest = await requestDigest(request, principal);
  const [stored] = await runRedisPipeline([
    ['SET', `${ADMISSION_PREFIX}${token}`, digest, 'EX', ADMISSION_TTL_SECONDS, 'NX'],
  ], true);
  return stored?.result === 'OK' && !stored.error ? token : null;
}

/** GETDEL makes concurrent replays fail. Invalid proofs never waive a limit. */
export async function consumeSubRequestAdmission(request: Request, principal: string | null = null): Promise<boolean> {
  const token = request.headers.get(SUB_REQUEST_MARKER_HEADER);
  if (request.method !== 'GET' || !token || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token)) return false;
  const [stored] = await runRedisPipeline([['GETDEL', `${ADMISSION_PREFIX}${token}`]], true);
  return !stored?.error && typeof stored?.result === 'string'
    && stored.result === await requestDigest(request, principal);
}

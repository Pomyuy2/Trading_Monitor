import {
  ProviderAuthError,
  ProviderNetworkError,
  ProviderResponseError,
  ProviderServerError,
  ProviderTimeoutError,
  RateLimitError,
} from '../providers/types.js';
import { quotaLedger } from '../quota/ledger.js';

/**
 * Per-provider "limit reached" back-off (circuit breaker). After a 429 we stop calling that
 * provider for a while — 1 min, then 2, 4 … up to 30 min while it keeps refusing (e.g. FMP's
 * daily allowance is used up) — and fail fast instead, so callers serve cached data at once.
 */
const MAX_BLOCK_MS = 30 * 60_000;
const blocked = new Map<string, { until: number; strikes: number }>();

export function rateLimitState(provider: string): { until: number; strikes: number } | undefined {
  const mem = blocked.get(provider);
  if (mem && mem.until > Date.now()) return mem;
  const ledgerCheck = quotaLedger.isBlocked(provider);
  if (ledgerCheck.blocked && ledgerCheck.retryAfterMs) {
    return { until: Date.now() + ledgerCheck.retryAfterMs, strikes: 1 };
  }
  return undefined;
}

/** For tests. */
export function resetRateLimits() {
  blocked.clear();
  quotaLedger.reset();
}

/**
 * GET JSON from a provider. Never includes the URL (which may carry an API key)
 * in thrown errors or logs.
 */
export async function getJson<T>(provider: string, url: string, headers: Record<string, string> = {}, timeoutMs = 10_000): Promise<T> {
  const ledgerCheck = quotaLedger.isBlocked(provider);
  if (ledgerCheck.blocked) {
    throw new RateLimitError(provider, ledgerCheck.retryAfterMs);
  }

  const b = blocked.get(provider);
  if (b && b.until > Date.now()) throw new RateLimitError(provider, b.until - Date.now());

  quotaLedger.recordRequest(provider);

  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const errorName = (err as Error)?.name;
    if (errorName === 'TimeoutError' || errorName === 'AbortError') {
      throw new ProviderTimeoutError(provider, timeoutMs);
    }
    throw new ProviderNetworkError(provider, (err as Error)?.message || errorName || 'Network request failed');
  }
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'));
    const strikes = (b?.strikes ?? 0) + 1;
    const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(60_000 * 2 ** (strikes - 1), MAX_BLOCK_MS);
    blocked.set(provider, { until: Date.now() + wait, strikes });
    quotaLedger.recordRateLimit(provider, wait).catch(() => {});
    throw new RateLimitError(provider, wait);
  }
  if (res.status === 401 || res.status === 402 || res.status === 403) {
    throw new ProviderAuthError(provider, res.status);
  }
  if (res.status >= 500) {
    throw new ProviderServerError(provider, res.status);
  }
  if (!res.ok) throw new Error(`${provider} HTTP ${res.status}`);
  blocked.delete(provider); // the provider answered normally again
  quotaLedger.recordSuccess(provider, 'default', res.headers);

  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new ProviderResponseError(provider, (err as Error)?.message || 'Invalid JSON response');
  }
}

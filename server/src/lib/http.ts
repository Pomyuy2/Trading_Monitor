import { ProviderAuthError, RateLimitError } from '../providers/types.js';

/**
 * Per-provider "limit reached" back-off (circuit breaker). After a 429 we stop calling that
 * provider for a while — 1 min, then 2, 4 … up to 30 min while it keeps refusing (e.g. FMP's
 * daily allowance is used up) — and fail fast instead, so callers serve cached data at once.
 */
const MAX_BLOCK_MS = 30 * 60_000;
const blocked = new Map<string, { until: number; strikes: number }>();

export function rateLimitState(provider: string): { until: number; strikes: number } | undefined {
  return blocked.get(provider);
}

/** For tests. */
export function resetRateLimits() {
  blocked.clear();
}

/**
 * GET JSON from a provider. Never includes the URL (which may carry an API key)
 * in thrown errors or logs.
 */
export async function getJson<T>(provider: string, url: string, headers: Record<string, string> = {}, timeoutMs = 10_000): Promise<T> {
  const b = blocked.get(provider);
  if (b && b.until > Date.now()) throw new RateLimitError(provider, b.until - Date.now());

  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(`${provider} request failed: ${(err as Error).name}`);
  }
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'));
    const strikes = (b?.strikes ?? 0) + 1;
    const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(60_000 * 2 ** (strikes - 1), MAX_BLOCK_MS);
    blocked.set(provider, { until: Date.now() + wait, strikes });
    throw new RateLimitError(provider, wait);
  }
  if (res.status === 401 || res.status === 402 || res.status === 403) {
    throw new ProviderAuthError(provider, res.status);
  }
  if (!res.ok) throw new Error(`${provider} HTTP ${res.status}`);
  blocked.delete(provider); // the provider answered normally again
  return (await res.json()) as T;
}

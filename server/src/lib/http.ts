import { ProviderAuthError, RateLimitError } from '../providers/types.js';

/**
 * GET JSON from a provider. Never includes the URL (which may carry an API key)
 * in thrown errors or logs.
 */
export async function getJson<T>(provider: string, url: string, headers: Record<string, string> = {}, timeoutMs = 10_000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(`${provider} request failed: ${(err as Error).name}`);
  }
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'));
    throw new RateLimitError(provider, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
  }
  if (res.status === 401 || res.status === 402 || res.status === 403) {
    throw new ProviderAuthError(provider, res.status);
  }
  if (!res.ok) throw new Error(`${provider} HTTP ${res.status}`);
  return (await res.json()) as T;
}

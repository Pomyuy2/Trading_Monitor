import { RateLimitError } from '../providers/types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_INLINE_WAIT_MS = 5_000;

/**
 * Retry only on provider rate limits (HTTP 429), with exponential backoff.
 * If the provider asks us to wait longer than a few seconds, give up at once so
 * the caller can serve cached ("stale") data instead of hanging the request.
 */
export async function withRateLimitRetry<T>(fn: () => Promise<T>, retries = 2, baseMs = 500): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof RateLimitError) || attempt >= retries) throw err;
      const wait = err.retryAfterMs ?? baseMs * 2 ** attempt;
      if (wait > MAX_INLINE_WAIT_MS) throw err;
      await sleep(wait);
    }
  }
}

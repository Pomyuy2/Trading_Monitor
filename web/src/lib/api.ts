'use client';

import type {
  CandleSeries,
  InsightResponse,
  Lang,
  MetaResponse,
  NewsResponse,
  Quote,
  Range,
  SymbolMatch,
  WatchlistItem,
} from '@tm/shared';
import useSWR, { mutate } from 'swr';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {}
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

const enc = encodeURIComponent;
const noRetryOn404 = {
  onErrorRetry: (err: unknown, _key: string, _cfg: unknown, revalidate: (o: { retryCount: number }) => void, { retryCount }: { retryCount: number }) => {
    if (err instanceof ApiError && err.status < 500) return;
    if (retryCount >= 4) return;
    setTimeout(() => revalidate({ retryCount }), 2000 * 2 ** retryCount);
  },
};

/** `detail` adds key stats from a second provider (e.g. volume); only the main symbol needs it. */
export function useQuote(symbol: string | null, detail = false) {
  return useSWR<Quote>(symbol ? `/api/quote/${enc(symbol)}${detail ? '?detail=1' : ''}` : null, fetchJson, { refreshInterval: 30_000, ...noRetryOn404 });
}

export function useCandles(symbol: string | null, range: Range) {
  return useSWR<CandleSeries>(symbol ? `/api/candles/${enc(symbol)}?range=${range}` : null, fetchJson, {
    revalidateOnFocus: false,
    keepPreviousData: true,
    ...noRetryOn404,
  });
}

export function useNews(symbol: string, lang: Lang) {
  return useSWR<NewsResponse>(`/api/news/${enc(symbol)}?lang=${lang}`, fetchJson, { refreshInterval: 5 * 60_000, ...noRetryOn404 });
}

export function useInsight(symbol: string, lang: Lang) {
  return useSWR<InsightResponse>(`/api/insight/${enc(symbol)}?lang=${lang}`, fetchJson, { revalidateOnFocus: false, ...noRetryOn404 });
}

export function useSearch(q: string) {
  const t = q.trim();
  return useSWR<SymbolMatch[]>(t ? `/api/search?q=${enc(t)}` : null, fetchJson, { keepPreviousData: true, dedupingInterval: 10_000 });
}

export function useMeta() {
  return useSWR<MetaResponse>('/api/meta', fetchJson, { revalidateOnFocus: false });
}

const WATCHLIST_KEY = '/api/watchlist';

export function useWatchlist() {
  return useSWR<WatchlistItem[]>(WATCHLIST_KEY, fetchJson);
}

export async function addToWatchlist(symbol: string) {
  const list = await fetchJson<WatchlistItem[]>(WATCHLIST_KEY, { method: 'POST', body: JSON.stringify({ symbol }) });
  await mutate(WATCHLIST_KEY, list, { revalidate: false });
}

export async function removeFromWatchlist(symbol: string) {
  // optimistic update
  await mutate<WatchlistItem[]>(
    WATCHLIST_KEY,
    async (cur) => {
      await fetch(`${WATCHLIST_KEY}/${enc(symbol)}`, { method: 'DELETE' });
      return (cur ?? []).filter((i) => i.symbol !== symbol);
    },
    { optimisticData: (cur) => (cur ?? []).filter((i) => i.symbol !== symbol), rollbackOnError: true, revalidate: false },
  );
}

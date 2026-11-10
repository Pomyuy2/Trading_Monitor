'use client';

import type {
  Alert,
  CandleSeries,
  EventsResponse,
  NewAlert,
  InsightResponse,
  Lang,
  LevelsResponse,
  MetaResponse,
  NewsResponse,
  Quote,
  Range,
  Sparkline,
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

/** Several quotes in one request (watchlist). */
export function useQuotes(symbols: string[]) {
  const key = symbols.length ? `/api/quotes?symbols=${symbols.map(enc).join(',')}` : null;
  return useSWR<Quote[]>(key, fetchJson, { refreshInterval: 30_000, keepPreviousData: true });
}

/** ~1 month of daily closes per symbol, for watchlist trend lines (cached 12 h on the server). */
export function useSparklines(symbols: string[]) {
  const key = symbols.length ? `/api/sparklines?symbols=${[...symbols].sort().map(enc).join(',')}` : null;
  return useSWR<Sparkline[]>(key, fetchJson, { revalidateOnFocus: false, refreshInterval: 30 * 60_000, keepPreviousData: true });
}

export function useCandles(symbol: string | null, range: Range) {
  return useSWR<CandleSeries>(symbol ? `/api/candles/${enc(symbol)}?range=${range}` : null, fetchJson, {
    revalidateOnFocus: false,
    keepPreviousData: true,
    ...noRetryOn404,
  });
}

export function useLevels(symbol: string | null, range: Range) {
  const intraday = range === '1H' || range === '1D' || range === '1W' || range === '1M';
  return useSWR<LevelsResponse>(symbol ? `/api/levels/${enc(symbol)}?range=${range}` : null, fetchJson, {
    refreshInterval: intraday ? 60_000 : 0, // levels follow new candles
    revalidateOnFocus: false,
    keepPreviousData: true,
    ...noRetryOn404,
  });
}

export function useEvents(symbol: string) {
  return useSWR<EventsResponse>(`/api/events/${enc(symbol)}`, fetchJson, { revalidateOnFocus: false, ...noRetryOn404 });
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

// ---------- alerts ----------
const ALERTS_KEY = '/api/alerts';

/** All alerts (active + triggered), newest first. Pushed updates arrive over the WebSocket. */
export function useAlerts() {
  return useSWR<Alert[]>(ALERTS_KEY, fetchJson, { refreshInterval: 60_000 });
}

export async function createAlert(input: NewAlert): Promise<Alert> {
  const alert = await fetchJson<Alert>(ALERTS_KEY, { method: 'POST', body: JSON.stringify(input) });
  await mutate<Alert[]>(ALERTS_KEY, (cur) => [alert, ...(cur ?? [])], { revalidate: false });
  return alert;
}

export async function deleteAlert(id: string) {
  await mutate<Alert[]>(
    ALERTS_KEY,
    async (cur) => {
      await fetch(`${ALERTS_KEY}/${enc(id)}`, { method: 'DELETE' });
      return (cur ?? []).filter((x) => x.id !== id);
    },
    { optimisticData: (cur) => (cur ?? []).filter((x) => x.id !== id), rollbackOnError: true, revalidate: false },
  );
}

export async function markAlertSeen(id: string) {
  await fetch(`${ALERTS_KEY}/${enc(id)}/seen`, { method: 'POST' });
  await mutate<Alert[]>(ALERTS_KEY, (cur) => (cur ?? []).map((x) => (x.id === id ? { ...x, seen: true } : x)), { revalidate: false });
}

/** Merge a pushed (triggered) alert into the cached list. */
export function applyAlertUpdate(alert: Alert) {
  void mutate<Alert[]>(ALERTS_KEY, (cur) => {
    const list = cur ?? [];
    return list.some((x) => x.id === alert.id) ? list.map((x) => (x.id === alert.id ? alert : x)) : [alert, ...list];
  }, { revalidate: false });
}

/** Save "My order" (optimistic). */
export async function reorderWatchlist(symbols: string[]) {
  await mutate<WatchlistItem[]>(
    WATCHLIST_KEY,
    async () => fetchJson<WatchlistItem[]>(`${WATCHLIST_KEY}/order`, { method: 'PUT', body: JSON.stringify({ symbols }) }),
    {
      optimisticData: (cur) => {
        const list = [...(cur ?? [])];
        return list.map((i) => ({ ...i, position: symbols.indexOf(i.symbol) === -1 ? i.position + symbols.length : symbols.indexOf(i.symbol) })).sort((x, y) => x.position - y.position);
      },
      rollbackOnError: true,
      revalidate: false,
    },
  );
}

/** Put a symbol in a group (null = no group). */
export async function setWatchlistGroup(symbol: string, group: string | null) {
  await mutate<WatchlistItem[]>(
    WATCHLIST_KEY,
    async () => fetchJson<WatchlistItem[]>(`${WATCHLIST_KEY}/${enc(symbol)}`, { method: 'PATCH', body: JSON.stringify({ group }) }),
    {
      optimisticData: (cur) => (cur ?? []).map((i) => (i.symbol === symbol ? { ...i, group: group?.trim() || null } : i)),
      rollbackOnError: true,
      revalidate: false,
    },
  );
}

'use client';

import type {
  AgentStreamEvent,
  Alert,
  AskAiRequest,
  AskAiResponse,
  AskResolveResponse,
  CandleSeries,
  ChatContextMode,
  ChatMessage,
  ConversationDetail,
  ConversationSummary,
  EventsResponse,
  NewAlert,
  InsightResponse,
  Lang,
  LevelsResponse,
  MetaResponse,
  NewsResponse,
  PortfolioSummary,
  Quote,
  Range,
  RebalanceAction,
  Sparkline,
  SymbolMatch,
  UserProfileData,
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

const AI_POLL_MS = 5_000;

export function useNews(symbol: string, lang: Lang) {
  // While the AI is still writing (aiPending), ask again every few seconds.
  return useSWR<NewsResponse>(`/api/news/${enc(symbol)}?lang=${lang}`, fetchJson, {
    refreshInterval: (d?: NewsResponse) => (d?.aiPending ? AI_POLL_MS : 2 * 60_000),
    ...noRetryOn404,
  });
}

export function useInsight(symbol: string, lang: Lang) {
  return useSWR<InsightResponse>(`/api/insight/${enc(symbol)}?lang=${lang}`, fetchJson, {
    revalidateOnFocus: false,
    refreshInterval: (d?: InsightResponse) => (d?.guidanceStatus === 'pending' ? AI_POLL_MS : 0),
    ...noRetryOn404,
  });
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

/** Ask AI question about a symbol or general research query (supports both object and positional params). */
export async function askAi(
  symbolOrReq: string | undefined | AskAiRequest,
  question?: string,
  lang?: Lang,
  history?: { role: 'user' | 'assistant'; content: string }[],
  options?: {
    contextMode?: ChatContextMode;
    contextRef?: string | null;
    conversationId?: string;
    agentVersion?: 'v1' | 'v2';
  },
): Promise<AskAiResponse> {
  if (typeof symbolOrReq === 'object' && symbolOrReq !== null && 'question' in symbolOrReq) {
    return fetchJson<AskAiResponse>('/api/ai/ask', {
      method: 'POST',
      body: JSON.stringify(symbolOrReq),
    });
  }
  return fetchJson<AskAiResponse>('/api/ai/ask', {
    method: 'POST',
    body: JSON.stringify({
      symbol: symbolOrReq || undefined,
      question: question ?? '',
      lang: lang ?? 'en',
      history,
      contextMode: options?.contextMode,
      contextRef: options?.contextRef,
      conversationId: options?.conversationId,
      agentVersion: options?.agentVersion,
    }),
  });
}

/** Which stocks a question would look up (shown under the input while typing; no AI call). */
export function useAskResolve(question: string, context: string[], pageSymbol: string) {
  const q = question.trim();
  return useSWR<AskResolveResponse>(
    q ? ['/api/ai/resolve', q, context.join(','), pageSymbol] : null,
    ([url]: [string]) => fetchJson<AskResolveResponse>(url, { method: 'POST', body: JSON.stringify({ question: q, context, pageSymbol }) }),
    { keepPreviousData: true, revalidateOnFocus: false, dedupingInterval: 30_000 },
  );
}

/**
 * Stream AI research response over Server-Sent Events (SSE).
 */
export async function askAiStream(
  symbol: string | undefined,
  question: string,
  lang: Lang,
  history: { role: 'user' | 'assistant'; content: string }[] | undefined,
  onEvent: (event: AgentStreamEvent) => void,
  signal?: AbortSignal,
  options?: {
    contextMode?: ChatContextMode;
    contextRef?: string | null;
    conversationId?: string;
    agentVersion?: 'v1' | 'v2';
  },
): Promise<void> {
  const res = await fetch('/api/ai/ask/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify({
      symbol: symbol || undefined,
      question,
      lang,
      history,
      contextMode: options?.contextMode,
      contextRef: options?.contextRef,
      conversationId: options?.conversationId,
      agentVersion: options?.agentVersion,
    }),
    signal,
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new ApiError(res.status, `AI stream failed (HTTP ${res.status}): ${errorText}`);
  }

  if (!res.body) {
    throw new Error('No response body received from AI stream');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Match complete SSE messages separated by double newlines (\n\n or \r\n\r\n)
      let match: RegExpExecArray | null;
      while ((match = /(?:\r?\n){2}/.exec(buffer)) !== null) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);

        let eventType = '';
        let dataText = '';

        const lines = block.split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue; // Skip comments and empty lines
          if (trimmed.startsWith('event:')) {
            eventType = trimmed.slice(6).trim();
          } else if (trimmed.startsWith('data:')) {
            const d = trimmed.slice(5).trim();
            dataText = dataText ? `${dataText}\n${d}` : d;
          }
        }

        if (dataText) {
          try {
            const parsedData = JSON.parse(dataText);
            onEvent({ type: (eventType || 'text_delta') as any, data: parsedData });
          } catch {
            // ignore malformed frame
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---- Portfolio Ledger APIs ----
export async function fetchPortfolios(): Promise<PortfolioSummary[]> {
  return fetchJson<PortfolioSummary[]>('/api/portfolio');
}

export async function fetchPortfolio(id: string): Promise<PortfolioSummary> {
  return fetchJson<PortfolioSummary>(`/api/portfolio/${enc(id)}`);
}

export async function createPortfolio(name: string, currency = 'USD', description?: string): Promise<{ id: string; name: string }> {
  return fetchJson<{ id: string; name: string }>('/api/portfolio', {
    method: 'POST',
    body: JSON.stringify({ name, currency, description }),
  });
}

export async function deletePortfolio(id: string): Promise<{ ok: boolean }> {
  return fetchJson<{ ok: boolean }>(`/api/portfolio/${enc(id)}`, { method: 'DELETE' });
}

export async function addPortfolioTransaction(
  portfolioId: string,
  tx: {
    type: 'BUY' | 'SELL' | 'CASH_DEPOSIT' | 'CASH_WITHDRAWAL' | 'DIVIDEND' | 'FEE';
    symbol?: string | null;
    quantity?: number;
    price?: number;
    fee?: number;
    timestamp?: string;
    notes?: string;
  },
) {
  return fetchJson(`/api/portfolio/${enc(portfolioId)}/transactions`, {
    method: 'POST',
    body: JSON.stringify(tx),
  });
}

export async function simulateRebalancing(
  portfolioId: string,
  targets: { symbol: string; targetWeight: number }[],
): Promise<{ totalValue: number; actions: RebalanceAction[]; warnings: string[] }> {
  return fetchJson(`/api/portfolio/${enc(portfolioId)}/rebalance`, {
    method: 'POST',
    body: JSON.stringify({ targets }),
  });
}

export async function fetchInvestmentProfile(): Promise<UserProfileData> {
  return fetchJson<UserProfileData>('/api/portfolio/profile');
}

export async function updateInvestmentProfile(profile: Partial<UserProfileData>): Promise<UserProfileData> {
  return fetchJson<UserProfileData>('/api/portfolio/profile', {
    method: 'PUT',
    body: JSON.stringify(profile),
  });
}

// ---- AI Conversation APIs ----
export async function fetchConversations(): Promise<ConversationSummary[]> {
  return fetchJson<ConversationSummary[]>('/api/ai/conversations');
}

export async function fetchConversation(id: string): Promise<ConversationDetail> {
  return fetchJson<ConversationDetail>(`/api/ai/conversations/${enc(id)}`);
}

export async function createConversation(data: {
  title?: string;
  contextMode?: ChatContextMode;
  contextRef?: string | null;
  messages?: ChatMessage[];
}): Promise<ConversationDetail> {
  return fetchJson<ConversationDetail>('/api/ai/conversations', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateConversation(
  id: string,
  data: {
    title?: string;
    contextMode?: ChatContextMode;
    contextRef?: string | null;
    messages?: ChatMessage[];
  },
): Promise<ConversationDetail> {
  return fetchJson<ConversationDetail>(`/api/ai/conversations/${enc(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deleteConversation(id: string): Promise<{ ok: boolean }> {
  return fetchJson<{ ok: boolean }>(`/api/ai/conversations/${enc(id)}`, {
    method: 'DELETE',
  });
}

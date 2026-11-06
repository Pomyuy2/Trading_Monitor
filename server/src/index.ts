import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { isRange, isValidSymbol, LANGS, normalizeSymbol, type Lang, type MetaResponse } from '@tm/shared';
import Fastify, { type FastifyReply } from 'fastify';
import { AnthropicAi } from './ai/anthropic-ai.js';
import { KeywordAi } from './ai/keyword-ai.js';
import { MockAi } from './ai/mock-ai.js';
import { LruCache } from './cache/cache.js';
import { env } from './env.js';
import { ProviderRegistry } from './providers/registry.js';
import { NotFoundError, NotSupportedError, RateLimitError } from './providers/types.js';
import { RealtimeHub } from './realtime/hub.js';
import { MarketService } from './services/market-service.js';
import { MemoryWatchlistStore } from './store/watchlist-store.js';

// trustProxy 'loopback': the Next.js dev proxy forwards the real client IP (X-Forwarded-For)
// so the per-IP rate limit works; headers from non-local peers are ignored.
const app = Fastify({ logger: { level: 'info' }, trustProxy: 'loopback' });
const allowedOrigins = env.WEB_ORIGIN.split(',').map((s) => s.trim());

const providers = new ProviderRegistry({ info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) });
const cache = new LruCache(5000);
// AI: Claude when ANTHROPIC_API_KEY is set; otherwise keyword-rule sentiment and no summaries.
const ai = {
  claude: env.ANTHROPIC_API_KEY ? new AnthropicAi(env.ANTHROPIC_API_KEY, { warn: (m: string) => app.log.warn(m) }) : null,
  keyword: new KeywordAi(),
  mock: new MockAi(),
};
const market = new MarketService(providers, cache, ai);
const hub = new RealtimeHub(providers.for('realtime'));
const watchlist = new MemoryWatchlistStore(['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL']);

await app.register(cors, { origin: allowedOrigins });
await app.register(rateLimit, { max: env.RATE_LIMIT_PER_MIN, timeWindow: '1 minute' });
await app.register(websocket);

// ---------- helpers ----------
function parseSymbol(raw: string | undefined, reply: FastifyReply): string | null {
  const s = normalizeSymbol(raw ?? '');
  if (!isValidSymbol(s)) {
    reply.code(400).send({ error: 'Invalid symbol' });
    return null;
  }
  return s;
}

function parseLang(raw: unknown): Lang {
  return LANGS.includes(raw as Lang) ? (raw as Lang) : 'en';
}

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
  if (err instanceof NotSupportedError) return reply.code(501).send({ error: err.message });
  if (err instanceof RateLimitError) {
    app.log.warn(err.message);
    const secs = Math.ceil((err.retryAfterMs ?? 30_000) / 1000);
    return reply.code(503).header('retry-after', String(secs)).send({ error: 'Data provider rate limit reached; try again shortly', retryAfter: secs });
  }
  const status = (err as { statusCode?: number }).statusCode;
  if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
  app.log.error(err);
  return reply.code(502).send({ error: 'Upstream data provider error' });
});

// ---------- REST ----------
app.get('/api/health', async () => ({ ok: true, realtime: hub.stats }));

app.get('/api/meta', async (): Promise<MetaResponse> => ({
  providers: [...providers.activeNames(), ...(ai.claude ? [ai.claude.name] : [])],
  mock: providers.mockCapabilities().length > 0,
  mockCapabilities: providers.mockCapabilities(),
}));

app.get<{ Querystring: { q?: string } }>('/api/search', async (req) => {
  const q = (req.query.q ?? '').slice(0, 50);
  if (!q.trim()) return [];
  return market.search(q);
});

app.get<{ Params: { symbol: string }; Querystring: { detail?: string } }>('/api/quote/:symbol', async (req, reply) => {
  const s = parseSymbol(req.params.symbol, reply);
  if (!s) return;
  return market.quote(s, req.query.detail === '1');
});

app.get<{ Params: { symbol: string }; Querystring: { range?: string } }>('/api/candles/:symbol', async (req, reply) => {
  const s = parseSymbol(req.params.symbol, reply);
  if (!s) return;
  const range = req.query.range ?? '1D';
  if (!isRange(range)) return reply.code(400).send({ error: 'Invalid range' });
  return market.candles(s, range);
});

app.get<{ Params: { symbol: string }; Querystring: { lang?: string } }>('/api/news/:symbol', async (req, reply) => {
  const s = parseSymbol(req.params.symbol, reply);
  if (!s) return;
  return market.news(s, parseLang(req.query.lang));
});

app.get<{ Params: { symbol: string }; Querystring: { lang?: string } }>('/api/insight/:symbol', async (req, reply) => {
  const s = parseSymbol(req.params.symbol, reply);
  if (!s) return;
  return market.insight(s, parseLang(req.query.lang));
});

app.get('/api/watchlist', async () => watchlist.list());

app.post<{ Body: { symbol?: string } }>('/api/watchlist', async (req, reply) => {
  const s = parseSymbol(req.body?.symbol, reply);
  if (!s) return;
  await market.quote(s); // 404 if the symbol is unknown to the provider
  return watchlist.add(s);
});

app.delete<{ Params: { symbol: string } }>('/api/watchlist/:symbol', async (req, reply) => {
  const s = parseSymbol(req.params.symbol, reply);
  if (!s) return;
  return watchlist.remove(s);
});

// ---------- WebSocket ----------
app.get('/ws', { websocket: true }, (socket, req) => {
  // Browsers always send Origin on WebSocket upgrades; reject other sites embedding our feed.
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.includes(origin) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    socket.close(1008, 'Origin not allowed');
    return;
  }
  hub.addClient(socket);
});

// Graceful shutdown: free the port and close the upstream socket so `tsx watch` restarts don't collide.
let closing = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    if (closing) return;
    closing = true;
    console.error(`[server] received ${sig}, shutting down`);
    providers.for('realtime').unsubscribe(hub.stats.symbols);
    await app.close().catch(() => {});
    process.exit(0);
  });
}

process.on('exit', (code) => console.error(`[server] process exit, code ${code}`));
process.on('uncaughtException', (err) => {
  console.error('[server] uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => console.error('[server] unhandled rejection:', err));

await app.listen({ port: env.PORT, host: env.HOST });
app.log.info(`Provider routing: ${JSON.stringify(providers.routing())}`);
app.log.info(`AI: ${ai.claude ? ai.claude.name : 'off (no ANTHROPIC_API_KEY) - keyword sentiment, no summaries'}`);

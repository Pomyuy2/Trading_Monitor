import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { isRange, isValidSymbol, LANGS, normalizeSymbol, type Lang, type MetaResponse, decodePayload } from '@tm/shared';
import Fastify, { type FastifyReply } from 'fastify';
import { AnthropicAi } from './ai/anthropic-ai.js';
import { RouterAi } from './ai/router-ai.js';
import { KeywordAi } from './ai/keyword-ai.js';
import { MockAi } from './ai/mock-ai.js';
import { LruCache } from './cache/cache.js';
import { env } from './env.js';
import { ProviderRegistry } from './providers/registry.js';
import { NotFoundError, NotSupportedError, RateLimitError } from './providers/types.js';
import { RealtimeHub } from './realtime/hub.js';
import { MarketService } from './services/market-service.js';
import { z } from 'zod';
import { AlertService } from './alerts/alert-service.js';
import { SqliteCache } from './cache/sqlite-cache.js';
import { db } from './store/db.js';
import { PrismaWatchlistStore } from './store/watchlist-store.js';
import { PushService } from './push/push-service.js';
import { UserService } from './auth/user-service.js';
import { getAuthUserFromCookie } from './auth/session.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    userEmail?: string;
  }
}

// trustProxy 'loopback': the Next.js dev proxy forwards the real client IP (X-Forwarded-For)
// so the per-IP rate limit works; headers from non-local peers are ignored.
const app = Fastify({ logger: { level: 'info' }, trustProxy: 'loopback' });
const allowedOrigins = env.WEB_ORIGIN.split(',').map((s) => s.trim());

const providers = new ProviderRegistry({ info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) });
const cache = new LruCache(5000);
// AI: Claude when ANTHROPIC_API_KEY is set, else an OpenAI-compatible endpoint (AI_BASE_URL + AI_API_KEY +
// AI_MODEL, e.g. a model router); with neither, keyword-rule sentiment and no summaries.
const aiLog = { warn: (m: string) => app.log.warn(m) };
const ai = {
  llm: env.ANTHROPIC_API_KEY
    ? new AnthropicAi(env.ANTHROPIC_API_KEY, aiLog)
    : env.AI_BASE_URL && env.AI_API_KEY && env.AI_MODEL
      ? new RouterAi(env.AI_BASE_URL, env.AI_API_KEY, env.AI_MODEL, aiLog)
      : null,
  keyword: new KeywordAi(),
  mock: new MockAi(),
};
const aiCache = new SqliteCache(db); // AI outputs survive restarts
const market = new MarketService(providers, cache, ai, aiCache);
const hub = new RealtimeHub(providers.for('realtime'));
const watchlist = new PrismaWatchlistStore(db, ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL']);
const log = { info: (m: string) => app.log.info(m), warn: (m: string) => app.log.warn(m) };
const alerts = new AlertService(db, market, hub, log);
providers.for('realtime').onTick((t) => alerts.handleTick(t));
const push = new PushService(db, env.VAPID_SUBJECT, log);
await push.init();
const users = new UserService(db, process.env, log);
await users.init();
const defaultAdminId = await users.getDefaultUserId();
await watchlist.init(defaultAdminId);

alerts.onTriggered((alert) => {
  if (alert.userId) {
    hub.sendToUser(alert.userId, { type: 'alert', alert });
  } else {
    hub.broadcastAll({ type: 'alert', alert });
  }
  void push.sendAlert(alert);
});
await alerts.init();
void aiCache.purge().catch(() => {});

await app.register(cors, { origin: allowedOrigins });
await app.register(rateLimit, { max: env.RATE_LIMIT_PER_MIN, timeWindow: '1 minute' });
await app.register(websocket);

// Extract authenticated user from session cookie for all incoming requests
app.addHook('preHandler', async (req) => {
  const secret = process.env.AUTH_SECRET;
  const cookieHeader = req.headers.cookie;
  if (cookieHeader && secret) {
    const authUser = await getAuthUserFromCookie(cookieHeader, secret);
    if (authUser) {
      req.userId = authUser.id;
      req.userEmail = authUser.email;
    }
  }
});

async function resolveUserId(req: { userId?: string }): Promise<string> {
  return req.userId || (await users.getDefaultUserId());
}

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

const verifyBodySchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});

app.post('/api/internal/auth/verify', async (req, reply) => {
  const parsed = verifyBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ ok: false, error: 'Invalid input' });
  }
  const cleanEmail = decodePayload(parsed.data.email).trim().toLowerCase();
  const cleanPassword = decodePayload(parsed.data.password);
  const user = await users.verifyCredentials(cleanEmail, cleanPassword);
  if (!user) {
    return reply.code(401).send({ ok: false, error: 'Invalid email or password' });
  }
  return { ok: true, user };
});

const registerBodySchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
  inviteCode: z.string().min(1),
});

app.post('/api/register', async (req, reply) => {
  const parsed = registerBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ ok: false, error: 'invalid_input', message: 'Invalid registration input' });
  }

  const rawEmail = decodePayload(parsed.data.email).trim().toLowerCase();
  const rawPass = decodePayload(parsed.data.password);
  if (!rawEmail.includes('@') || rawPass.length < 6) {
    return reply.code(400).send({ ok: false, error: 'invalid_input', message: 'Invalid email or password' });
  }

  const cfIp = req.headers['cf-connecting-ip'];
  const realIp = req.headers['x-real-ip'];
  const forwarded = req.headers['x-forwarded-for'];
  const ip =
    (typeof cfIp === 'string' && cfIp.trim()) ||
    (typeof realIp === 'string' && realIp.trim()) ||
    (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null) ||
    req.ip ||
    '127.0.0.1';

  const result = await users.registerUser({
    email: rawEmail,
    password: rawPass,
    inviteCode: parsed.data.inviteCode,
    ip,
  });

  if (!result.ok) {
    if (result.error === 'rate_limited') {
      return reply.code(429).send({
        ok: false,
        error: 'rate_limited',
        message: 'Too many invalid invite code attempts. Locked for 5 hours.',
        remaining: 0,
      });
    }
    if (result.error === 'invalid_invite') {
      return reply.code(400).send({
        ok: false,
        error: 'invalid_invite',
        message: `Invalid invitation code. ${result.remaining ?? 0} attempt(s) remaining.`,
        remaining: result.remaining,
      });
    }
    if (result.error === 'email_exists') {
      return reply.code(409).send({
        ok: false,
        error: 'email_exists',
        message: 'Email address is already registered.',
      });
    }
    return reply.code(400).send({
      ok: false,
      error: 'invalid_input',
      message: 'Invalid registration input.',
    });
  }

  return reply.code(201).send({ ok: true, user: result.user });
});

app.get('/api/meta', async (): Promise<MetaResponse> => ({
  providers: [...providers.activeNames(), ...(ai.llm ? [ai.llm.name] : [])],
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

app.get<{ Params: { symbol: string }; Querystring: { range?: string } }>('/api/levels/:symbol', async (req, reply) => {
  const s = parseSymbol(req.params.symbol, reply);
  if (!s) return;
  const range = req.query.range ?? '1D';
  if (!isRange(range)) return reply.code(400).send({ error: 'Invalid range' });
  return market.levels(s, range);
});

app.get<{ Params: { symbol: string } }>('/api/events/:symbol', async (req, reply) => {
  const s = parseSymbol(req.params.symbol, reply);
  if (!s) return;
  return market.events(s);
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

const askBodySchema = z.object({
  symbol: z.string().min(1).max(15),
  question: z.string().min(1).max(1000),
  lang: z.enum(['en', 'th']).optional().default('en'),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(2000),
      }),
    )
    .optional(),
});

app.post('/api/ai/ask', async (req, reply) => {
  const parsed = askBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'Invalid request body' });
  }
  const s = parseSymbol(parsed.data.symbol, reply);
  if (!s) return;
  return market.askStock(s, parsed.data.question.trim(), parsed.data.lang, parsed.data.history);
});

app.get('/api/watchlist', async (req) => {
  const uid = await resolveUserId(req);
  return watchlist.list(uid);
});

app.post<{ Body: { symbol?: string } }>('/api/watchlist', async (req, reply) => {
  const s = parseSymbol(req.body?.symbol, reply);
  if (!s) return;
  await market.quote(s); // 404 if the symbol is unknown to the provider
  const uid = await resolveUserId(req);
  return watchlist.add(s, uid);
});

/** Comma-separated symbols for batch endpoints (max 40, invalid ones dropped). */
function parseSymbols(raw: string | undefined): string[] {
  return [...new Set((raw ?? '').split(',').map(normalizeSymbol).filter(isValidSymbol))].slice(0, 40);
}

app.get<{ Querystring: { symbols?: string } }>('/api/quotes', async (req) => market.quotes(parseSymbols(req.query.symbols)));

app.get<{ Querystring: { symbols?: string } }>('/api/sparklines', async (req) => market.sparklines(parseSymbols(req.query.symbols)));

app.put('/api/watchlist/order', async (req, reply) => {
  const parsed = z.object({ symbols: z.array(z.string()).max(200) }).safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid order' });
  const uid = await resolveUserId(req);
  return watchlist.reorder(parsed.data.symbols.map(normalizeSymbol).filter(isValidSymbol), uid);
});

app.patch<{ Params: { symbol: string } }>('/api/watchlist/:symbol', async (req, reply) => {
  const s = parseSymbol(req.params.symbol, reply);
  if (!s) return;
  const parsed = z.object({ group: z.string().max(100).nullable() }).safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid group' });
  const uid = await resolveUserId(req);
  return watchlist.setGroup(s, parsed.data.group, uid);
});

app.delete<{ Params: { symbol: string } }>('/api/watchlist/:symbol', async (req, reply) => {
  const s = parseSymbol(req.params.symbol, reply);
  if (!s) return;
  const uid = await resolveUserId(req);
  return watchlist.remove(s, uid);
});

// ---------- Alerts ----------
const levelSchema = z.object({
  kind: z.enum(['support', 'resistance']),
  price: z.number().positive(),
  zoneLow: z.number().positive(),
  zoneHigh: z.number().positive(),
  range: z.enum(['1H', '1D', '1W', '1M', '6M', '1Y', '5Y']),
});
const newAlertSchema = z.discriminatedUnion('kind', [
  z.object({ symbol: z.string(), kind: z.literal('price_above'), targetPrice: z.number().positive() }),
  z.object({ symbol: z.string(), kind: z.literal('price_below'), targetPrice: z.number().positive() }),
  z.object({ symbol: z.string(), kind: z.literal('near_level'), level: levelSchema }),
  z.object({ symbol: z.string(), kind: z.literal('breakout'), level: levelSchema }),
]);

app.get<{ Querystring: { symbol?: string } }>('/api/alerts', async (req, reply) => {
  const uid = await resolveUserId(req);
  if (req.query.symbol) {
    const s = parseSymbol(req.query.symbol, reply);
    if (!s) return;
    return alerts.list(uid, s);
  }
  return alerts.list(uid);
});

app.post('/api/alerts', async (req, reply) => {
  const parsed = newAlertSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid alert' });
  const symbol = normalizeSymbol(parsed.data.symbol);
  if (!isValidSymbol(symbol)) return reply.code(400).send({ error: 'Invalid symbol' });
  const uid = await resolveUserId(req);
  return reply.code(201).send(await alerts.create({ ...parsed.data, symbol }, uid));
});

app.delete<{ Params: { id: string } }>('/api/alerts/:id', async (req, reply) => {
  const uid = await resolveUserId(req);
  const ok = await alerts.remove(req.params.id, uid);
  return ok ? { ok: true } : reply.code(404).send({ error: 'Alert not found' });
});

app.post<{ Params: { id: string } }>('/api/alerts/:id/seen', async (req) => {
  const uid = await resolveUserId(req);
  await alerts.markSeen(req.params.id, uid);
  return { ok: true };
});

// ---------- Push (installed app) ----------
app.get('/api/push/key', async () => ({ publicKey: push.publicKey }));

const pushSubSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(500), auth: z.string().min(1).max(500) }),
  lang: z.enum(['en', 'th']).optional(),
});
app.post('/api/push/subscribe', async (req, reply) => {
  const parsed = pushSubSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid subscription' });
  const uid = await resolveUserId(req);
  await push.subscribe(parsed.data, uid);
  return { ok: true };
});
app.post('/api/push/unsubscribe', async (req, reply) => {
  const parsed = z.object({ endpoint: z.string().max(2000) }).safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
  await push.unsubscribe(parsed.data.endpoint);
  return { ok: true };
});

// ---------- WebSocket ----------
app.get('/ws', { websocket: true }, async (socket, req) => {
  // Browsers always send Origin on WebSocket upgrades; reject other sites embedding our feed.
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.includes(origin) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    socket.close(1008, 'Origin not allowed');
    return;
  }
  let wsUserId: string | undefined = undefined;
  if (req.headers.cookie && process.env.AUTH_SECRET) {
    const user = await getAuthUserFromCookie(req.headers.cookie, process.env.AUTH_SECRET);
    if (user) wsUserId = user.id;
  }
  hub.addClient(socket, wsUserId);
});

// Graceful shutdown: free the port and close the upstream socket so `tsx watch` restarts don't collide.
let closing = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    if (closing) return;
    closing = true;
    console.error(`[server] received ${sig}, shutting down`);
    alerts.stop();
    providers.for('realtime').unsubscribe(hub.stats.symbols);
    await app.close().catch(() => {});
    await db.$disconnect().catch(() => {});
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
app.log.info(`AI: ${ai.llm ? ai.llm.name : 'off (no ANTHROPIC_API_KEY or AI_BASE_URL + AI_API_KEY + AI_MODEL) - keyword sentiment, no summaries'}`);

/**
 * Pre-warm caches for watchlist stocks right after startup, so the first page you open is fast.
 * Uses only Finnhub (60 calls/min) and SEC (free); FMP's daily allowance and Twelve Data's
 * per-minute limit are left for what you actually open. Runs quietly in the background.
 */
async function prewarm() {
  const t0 = Date.now();
  const symbols = (await watchlist.list(defaultAdminId)).map((w) => w.symbol);
  const quoteProvider = providers.for('quote');
  const docsProvider = providers.for('transcripts');
  for (const s of symbols) {
    if (closing) return;
    await market.quote(s).catch(() => {}); // fills Finnhub fundamentals (cached 12 h) + market status
    if (docsProvider !== quoteProvider) await docsProvider.getGuidanceDocuments(s).catch(() => {}); // SEC filings (cached 12 h)
    await new Promise((r) => setTimeout(r, 300)); // gentle on the providers
  }
  app.log.info(`Pre-warmed ${symbols.length} watchlist symbols in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
void prewarm();

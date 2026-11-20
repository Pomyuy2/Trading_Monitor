import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { isRange, isValidSymbol, LANGS, normalizeSymbol, type Lang, type MetaResponse, decodePayload, type AgentStreamEvent, type InvestmentResearchReport } from '@tm/shared';
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
import { PortfolioService } from './portfolio/portfolio-service.js';
import { InvestmentResearchAgent } from './agent/research-agent.js';
import { ConversationService } from './agent/conversation-service.js';
import type { AgentContext } from './agent/types.js';
import type { ChatContextMode } from '@tm/shared';

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
import { quotaLedger } from './quota/ledger.js';
await quotaLedger.init();
const push = new PushService(db, env.VAPID_SUBJECT, log);
await push.init();
const users = new UserService(db, process.env, log);
await users.init();
const portfolio = new PortfolioService(db);
const conversationService = new ConversationService(db);
const researchAgent =
  env.AI_BASE_URL && env.AI_API_KEY && env.AI_MODEL
    ? new InvestmentResearchAgent(env.AI_BASE_URL, env.AI_API_KEY, env.AI_MODEL, log)
    : null;
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

app.get<{ Params: { symbol: string } }>('/api/market/facts/:symbol', async (req, reply) => {
  const s = parseSymbol(req.params.symbol, reply);
  if (!s) return;
  return market.companyFacts(s);
});

app.get('/api/diagnostics/providers', async () => {
  return {
    routing: providers.routing(),
    health: quotaLedger.getDiagnostics(),
  };
});

const askBodySchema = z.object({
  symbol: z.string().min(1).max(15).optional(),
  question: z.string().min(1).max(1000),
  lang: z.enum(['en', 'th']).optional().default('en'),
  contextMode: z.enum(['global', 'stock', 'portfolio']).optional(),
  contextRef: z.string().max(50).optional().nullable(),
  conversationId: z.string().optional(),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(2000),
      }),
    )
    .optional(),
});

function getDemoAnalysis(
  question: string,
  symbol: string | null,
  lang: 'en' | 'th',
  contextMode: 'global' | 'stock' | 'portfolio',
  contextRef?: string | null,
) {
  const isThai = lang === 'th';
  const sym = symbol || (contextMode === 'stock' && contextRef ? contextRef : null);

  if (sym) {
    return {
      answer: isThai
        ? `รายงานวิเคราะห์เชิงปริมาณสำหรับ ${sym}: มูลค่าทางบัญชีและผลตอบแทนอยู่ในเกณฑ์ดี แนวโน้มทางเทคนิคเป็นบวก`
        : `Quantitative research report for ${sym}: Valuation DCF scenarios indicate attractive upside under base assumptions with strong technical momentum.`,
      sources: [
        { id: `quote-${sym}`, label: `${sym} Quote · MockProvider`, type: 'price' as const },
        { id: `val-${sym}`, label: `${sym} Valuation (Base Fair Value: $195.00)`, type: 'general' as const },
        { id: `tech-${sym}`, label: `${sym} Technicals (RSI 58.2, Trend: bullish)`, type: 'levels' as const },
      ],
      toolSteps: [
        { tool: 'get_quote', args: { symbol: sym }, durationMs: 15, success: true, summary: `Loaded ${sym} quote` },
        { tool: 'calculate_indicators', args: { symbol: sym }, durationMs: 25, success: true, summary: 'Calculated technical indicators' },
        { tool: 'calculate_valuation', args: { symbol: sym }, durationMs: 30, success: true, summary: 'Calculated 3-scenario DCF' },
        { tool: 'analyze_stock_risk', args: { symbol: sym }, durationMs: 20, success: true, summary: 'Calculated VaR and Beta' },
      ],
      report: {
        symbol: sym,
        title: `${sym} Investment Research Report`,
        horizon: 'medium' as const,
        verdict: 'ATTRACTIVE_UNDER_ASSUMPTIONS' as const,
        summary: `Demonstrates resilient operating margins and solid free cash flow generation. Current price offers favorable risk/reward profile relative to intrinsic value.`,
        valuationScenarios: {
          currentPrice: 180.25,
          baseFairValue: 195.0,
          bull: { scenario: 'bull' as const, impliedFairValue: 245.0, upsideDownsidePercent: 36.1, keyAssumptions: '15% FCF growth, 8% WACC' },
          base: { scenario: 'base' as const, impliedFairValue: 195.0, upsideDownsidePercent: 18.2, keyAssumptions: '10% FCF growth, 9% WACC' },
          bear: { scenario: 'bear' as const, impliedFairValue: 140.0, upsideDownsidePercent: -15.5, keyAssumptions: '5% FCF growth, 10.5% WACC' },
          keyTakeaway: 'Current market price provides attractive margin of safety relative to base case intrinsic value.',
        },
        fundamentals: {
          revenueGrowthYoY: 0.145,
          netMargin: 0.238,
          fcfMargin: 0.215,
          roe: 0.485,
          roic: 0.321,
          debtToEquity: 1.15,
          keyTakeaway: 'High return on capital and expanding operating leverage.',
        },
        technicals: {
          currentPrice: 180.25,
          trend: 'bullish' as const,
          rsi14: 58.2,
          supportPrice: 165.0,
          resistancePrice: 195.0,
          keyTakeaway: 'Trading comfortably above 50-day and 200-day moving averages with healthy momentum.',
        },
        riskAssessment: {
          riskRating: 'moderate' as const,
          downsideRisks: ['Macro slowdown impacting enterprise spend', 'Regulatory scrutiny in core markets'],
          thesisInvalidation: [
            'Daily close below 200-day moving average ($160.00)',
            'Operating margin compression below 22% for two consecutive quarters',
          ],
        },
        portfolioConsiderations: {
          suitability: 'Suitable for moderate-to-aggressive growth portfolios seeking core exposure.',
        },
        dataQuality: {
          staleFeeds: [],
          sources: [
            { id: `quote-${sym}`, label: `${sym} Quote · MockProvider`, type: 'price' as const },
          ],
        },
      },
    };
  }

  // Symbol is null (global or portfolio mode)
  const words = question.split(/[^A-Za-z0-9]/).filter(Boolean);
  const possibleTickers = Array.from(new Set(
    words
      .filter((w) => /^[A-Z]{2,5}$/.test(w) && !['DCF', 'VAR', 'RSI', 'MACD', 'HHI', 'PE', 'USA', 'AI', 'USD', 'THE', 'AND', 'FOR', 'HOW', 'WHY', 'WHAT', 'STOCK', 'PRICE', 'TELL', 'ABOUT', 'ME', 'IS'].includes(w.toUpperCase()))
      .map((w) => w.toUpperCase()),
  ));

  if (possibleTickers.length >= 2) {
    const [t1, t2] = possibleTickers;
    return {
      answer: isThai
        ? `เปรียบเทียบเชิงวิเคราะห์ระหว่าง ${t1} และ ${t2}: ${t1} มีอัตรากำไรจากการดำเนินงานและการเติบโตของกระแสเงินสดอิสระสูงกว่า ขณะที่ ${t2} มีอัตราส่วนการประเมินมูลค่าต่อกำไรที่ยืดหยุ่นกว่าสำหรับการลงทุนระยะยาว`
        : `Comparative research analysis between ${t1} and ${t2}: ${t1} exhibits superior operating margins and free cash flow generation driven by enterprise demand, while ${t2} offers competitive multiple expansion opportunities under diversified workload assumptions.`,
      sources: [
        { id: `quote-${t1}`, label: `${t1} Quote · MockProvider`, type: 'price' as const },
        { id: `quote-${t2}`, label: `${t2} Quote · MockProvider`, type: 'price' as const },
        { id: `compare-${t1}-${t2}`, label: `${t1} vs ${t2} Relative Valuation Multiple Comparison`, type: 'general' as const },
      ],
      toolSteps: [
        { tool: 'get_quote', args: { symbol: t1 }, durationMs: 15, success: true, summary: `Loaded ${t1} quote` },
        { tool: 'get_quote', args: { symbol: t2 }, durationMs: 15, success: true, summary: `Loaded ${t2} quote` },
        { tool: 'compare_stocks', args: { symbols: [t1, t2] }, durationMs: 40, success: true, summary: `Compared ${t1} vs ${t2} metrics` },
      ],
      report: null,
    };
  }

  if (possibleTickers.length === 1) {
    const singleSym = possibleTickers[0];
    return getDemoAnalysis(question, singleSym, lang, 'stock', singleSym);
  }

  if (contextMode === 'portfolio' || /portfolio|holdings|rebalance/i.test(question)) {
    return {
      answer: isThai
        ? `การวิเคราะห์สถานะพอร์ตโฟลิโอ: ตรวจสอบการกระจายความเสี่ยง ดัชนี HHI อยู่ในระดับกระจายตัวเหมาะสม ต้นทุนเฉลี่ยและสัดส่วนสินทรัพย์สอดคล้องกับเป้าหมายความเสี่ยงปานกลาง`
        : `Portfolio health analysis: Assessed active holdings, unrealized P&L, and asset concentration. The Herfindahl-Hirschman Index (HHI) reflects healthy diversification across equity sectors with moderate risk exposure.`,
      sources: [
        { id: 'user-portfolios', label: 'User Portfolios · Portfolio Ledger (SQLite)', type: 'general' as const },
        { id: 'portfolio-primary', label: 'Primary Portfolio Asset Allocation & Concentration', type: 'general' as const },
      ],
      toolSteps: [
        { tool: 'get_user_portfolios', args: {}, durationMs: 10, success: true, summary: 'Loaded user portfolios' },
        { tool: 'get_portfolio_analysis', args: {}, durationMs: 25, success: true, summary: 'Calculated portfolio metrics & concentration' },
      ],
      report: null,
    };
  }

  // General investing concept question
  return {
    answer: isThai
      ? `การประเมินมูลค่ากระแสเงินสดคิดลด (DCF) เป็นวิธีการประเมินมูลค่าที่แท้จริงของกิจการ โดยคาดการณ์กระแสเงินสดอิสระในอนาคต (Free Cash Flow) แล้วคิดลดกลับมาเป็นมูลค่าปัจจุบันด้วยต้นทุนเงินทุนถัวเฉลี่ยถ่วงน้ำหนัก (WACC) ซึ่งช่วยให้ผู้ลงทุนสามารถจำลองสถานการณ์ทั้ง Bull, Base และ Bear ได้อย่างเป็นระบบ`
      : `Discounted Cash Flow (DCF) valuation calculates the intrinsic fair value of an asset by projecting future unlevered free cash flows and discounting them back to the present value using the Weighted Average Cost of Capital (WACC). It provides a structured margin of safety across Bull, Base, and Bear scenarios without relying solely on short-term market multiples.`,
    sources: [],
    toolSteps: [],
    report: null,
  };
}

app.post('/api/ai/ask', async (req, reply) => {
  const parsed = askBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'Invalid request body' });
  }

  let s: string | null = null;
  if (parsed.data.symbol) {
    s = parseSymbol(parsed.data.symbol, reply);
    if (!s) return;
  }

  const uid = await resolveUserId(req);
  const contextMode: ChatContextMode = parsed.data.contextMode || (s ? 'stock' : 'global');
  let contextRef = parsed.data.contextRef || (contextMode === 'stock' ? s ?? undefined : undefined);

  // Validate portfolio context ownership if requested
  if (contextMode === 'portfolio' && contextRef) {
    const list = await portfolio.listPortfolios(uid);
    if (!list.some((p) => p.id === contextRef)) {
      contextRef = undefined; // Strip unauthorized or missing portfolio ID
    }
  }

  const ctx: AgentContext = {
    userId: uid,
    lang: parsed.data.lang,
    market,
    portfolio,
  };

  if (process.env.DEMO_MODE === 'true') {
    const demo = getDemoAnalysis(parsed.data.question.trim(), s, parsed.data.lang, contextMode, contextRef);
    const resp: any = {
      answer: demo.answer,
      sources: demo.sources,
      toolSteps: demo.toolSteps,
      report: demo.report,
      model: 'demo-research-v1',
      executionTimeMs: 120,
    };

    if (parsed.data.conversationId) {
      await conversationService.appendMessages(uid, parsed.data.conversationId, [
        { id: `u-${Date.now()}`, role: 'user', content: parsed.data.question.trim(), ts: Date.now() },
        { id: `a-${Date.now()}`, role: 'assistant', content: resp.answer, sources: resp.sources, report: resp.report, toolSteps: resp.toolSteps, ts: Date.now() },
      ], contextMode, contextRef).catch(() => {});
      resp.conversationId = parsed.data.conversationId;
    }
    return resp;
  }

  if (researchAgent) {
    try {
      const result = await researchAgent.research(
        parsed.data.question.trim(),
        s ?? undefined,
        parsed.data.lang,
        ctx,
        parsed.data.history,
        contextMode,
        contextRef,
      );
      if (parsed.data.conversationId) {
        await conversationService.appendMessages(uid, parsed.data.conversationId, [
          { id: `u-${Date.now()}`, role: 'user', content: parsed.data.question.trim(), ts: Date.now() },
          { id: `a-${Date.now()}`, role: 'assistant', content: result.answer, sources: result.sources, report: result.report, toolSteps: result.toolSteps, ts: Date.now() },
        ], contextMode, contextRef).catch(() => {});
        (result as any).conversationId = parsed.data.conversationId;
      }
      return result;
    } catch (err) {
      app.log.warn(`Research agent failed, falling back to askStock: ${(err as Error).message}`);
    }
  }

  if (s) {
    const res = await market.askStock(s, parsed.data.question.trim(), parsed.data.lang, parsed.data.history);
    if (parsed.data.conversationId) {
      await conversationService.appendMessages(uid, parsed.data.conversationId, [
        { id: `u-${Date.now()}`, role: 'user', content: parsed.data.question.trim(), ts: Date.now() },
        { id: `a-${Date.now()}`, role: 'assistant', content: res.answer, sources: res.sources, ts: Date.now() },
      ], contextMode, contextRef).catch(() => {});
    }
    return res;
  }
  return reply.code(400).send({ error: 'AI Assistant requires symbol or active agent' });
});

app.post('/api/ai/ask/stream', async (req, reply) => {
  const parsed = askBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'Invalid request body' });
  }

  let s: string | null = null;
  if (parsed.data.symbol) {
    s = parseSymbol(parsed.data.symbol, reply);
    if (!s) return;
  }

  const uid = await resolveUserId(req);
  const contextMode: ChatContextMode = parsed.data.contextMode || (s ? 'stock' : 'global');
  let contextRef = parsed.data.contextRef || (contextMode === 'stock' ? s ?? undefined : undefined);

  // Validate portfolio context ownership if requested
  if (contextMode === 'portfolio' && contextRef) {
    const list = await portfolio.listPortfolios(uid);
    if (!list.some((p) => p.id === contextRef)) {
      contextRef = undefined; // Strip unauthorized or missing portfolio ID
    }
  }

  const ctx: AgentContext = {
    userId: uid,
    lang: parsed.data.lang,
    market,
    portfolio,
  };

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const sendEvent = (event: any) => {
    if (reply.raw.writableEnded || reply.raw.destroyed) return;
    reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  };

  const heartbeatTimer = setInterval(() => {
    if (reply.raw.writableEnded || reply.raw.destroyed) {
      clearInterval(heartbeatTimer);
      return;
    }
    reply.raw.write(': heartbeat\n\n');
  }, 5_000);

  const abortController = new AbortController();
  req.raw.on('close', () => {
    clearInterval(heartbeatTimer);
    abortController.abort();
  });

  if (process.env.DEMO_MODE === 'true') {
    try {
      const demo = getDemoAnalysis(parsed.data.question.trim(), s, parsed.data.lang, contextMode, contextRef);
      sendEvent({ type: 'agent_start', data: { query: parsed.data.question, symbol: s ?? undefined } });

      for (let i = 0; i < demo.toolSteps.length; i++) {
        if (abortController.signal.aborted) break;
        const st = demo.toolSteps[i];
        sendEvent({ type: 'tool_start', data: { tool: st.tool, args: st.args, step: i + 1 } });
        await new Promise((r) => setTimeout(r, 20));
        sendEvent({
          type: 'tool_result',
          data: { tool: st.tool, success: st.success, durationMs: st.durationMs, summary: st.summary },
        });
      }

      const words = demo.answer.split(' ');
      for (const word of words) {
        if (abortController.signal.aborted) break;
        sendEvent({ type: 'text_delta', data: { delta: word + ' ' } });
        await new Promise((r) => setTimeout(r, 15));
      }

      if (demo.report) {
        sendEvent({ type: 'report_ready', data: { report: demo.report } });
      }

      sendEvent({
        type: 'done',
        data: {
          executionTimeMs: 150,
          model: 'demo-research-v1',
          sources: demo.sources,
          toolSteps: demo.toolSteps,
          conversationId: parsed.data.conversationId,
        },
      });

      if (parsed.data.conversationId && !abortController.signal.aborted) {
        await conversationService.appendMessages(uid, parsed.data.conversationId, [
          { id: `u-${Date.now()}`, role: 'user', content: parsed.data.question.trim(), ts: Date.now() },
          { id: `a-${Date.now()}`, role: 'assistant', content: demo.answer, sources: demo.sources, report: demo.report, toolSteps: demo.toolSteps, ts: Date.now() },
        ], contextMode, contextRef).catch(() => {});
      }
    } catch (err) {
      sendEvent({ type: 'error', data: { message: (err as Error).message } });
    } finally {
      clearInterval(heartbeatTimer);
      if (!reply.raw.writableEnded) reply.raw.end();
    }
    return;
  }

  if (researchAgent) {
    try {
      const result = await researchAgent.researchStream(
        parsed.data.question.trim(),
        s ?? undefined,
        parsed.data.lang,
        ctx,
        parsed.data.history,
        sendEvent,
        abortController.signal,
        contextMode,
        contextRef,
      );
      if (parsed.data.conversationId && result && !abortController.signal.aborted) {
        await conversationService.appendMessages(uid, parsed.data.conversationId, [
          { id: `u-${Date.now()}`, role: 'user', content: parsed.data.question.trim(), ts: Date.now() },
          { id: `a-${Date.now()}`, role: 'assistant', content: result.answer, sources: result.sources, report: result.report, toolSteps: result.toolSteps, ts: Date.now() },
        ], contextMode, contextRef).catch(() => {});
      }
    } catch (err) {
      if (!abortController.signal.aborted) {
        sendEvent({ type: 'error', data: { message: (err as Error).message } });
      }
    } finally {
      clearInterval(heartbeatTimer);
      if (!reply.raw.writableEnded) reply.raw.end();
    }
    return;
  }

  try {
    sendEvent({ type: 'agent_start', data: { query: parsed.data.question, symbol: s ?? undefined } });
    const ans = s ? await market.askStock(s, parsed.data.question.trim(), parsed.data.lang, parsed.data.history) : null;
    if (ans) {
      sendEvent({ type: 'text_delta', data: { delta: ans.answer } });
      sendEvent({
        type: 'done',
        data: {
          executionTimeMs: 100,
          model: ans.model || 'fallback',
          sources: ans.sources || [],
          toolSteps: [],
          conversationId: parsed.data.conversationId,
        },
      });
      if (parsed.data.conversationId && !abortController.signal.aborted) {
        await conversationService.appendMessages(uid, parsed.data.conversationId, [
          { id: `u-${Date.now()}`, role: 'user', content: parsed.data.question.trim(), ts: Date.now() },
          { id: `a-${Date.now()}`, role: 'assistant', content: ans.answer, sources: ans.sources, ts: Date.now() },
        ], contextMode, contextRef).catch(() => {});
      }
    } else {
      sendEvent({ type: 'error', data: { message: 'AI Assistant requires symbol or active agent' } });
    }
  } catch (err) {
    sendEvent({ type: 'error', data: { message: (err as Error).message } });
  } finally {
    clearInterval(heartbeatTimer);
    if (!reply.raw.writableEnded) reply.raw.end();
  }
});

// ---- Conversation History REST Endpoints ----
app.get('/api/ai/conversations', async (req) => {
  const uid = await resolveUserId(req);
  return conversationService.listConversations(uid);
});

const createConversationSchema = z.object({
  title: z.string().max(100).optional(),
  contextMode: z.enum(['global', 'stock', 'portfolio']).optional(),
  contextRef: z.string().max(50).optional().nullable(),
  messages: z.array(z.any()).optional(),
});

app.post('/api/ai/conversations', async (req, reply) => {
  const parsed = createConversationSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid conversation payload' });
  const uid = await resolveUserId(req);
  const created = await conversationService.createConversation(uid, parsed.data);
  return reply.code(201).send(created);
});

app.get<{ Params: { id: string } }>('/api/ai/conversations/:id', async (req, reply) => {
  const uid = await resolveUserId(req);
  const c = await conversationService.getConversation(uid, req.params.id);
  if (!c) return reply.code(404).send({ error: 'Conversation not found' });
  return c;
});

const updateConversationSchema = z.object({
  title: z.string().max(100).optional(),
  contextMode: z.enum(['global', 'stock', 'portfolio']).optional(),
  contextRef: z.string().max(50).optional().nullable(),
  messages: z.array(z.any()).optional(),
});

app.patch<{ Params: { id: string } }>('/api/ai/conversations/:id', async (req, reply) => {
  const parsed = updateConversationSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid conversation update' });
  const uid = await resolveUserId(req);
  const updated = await conversationService.updateConversation(uid, req.params.id, parsed.data);
  if (!updated) return reply.code(404).send({ error: 'Conversation not found' });
  return updated;
});

app.delete<{ Params: { id: string } }>('/api/ai/conversations/:id', async (req, reply) => {
  const uid = await resolveUserId(req);
  const ok = await conversationService.deleteConversation(uid, req.params.id);
  if (!ok) return reply.code(404).send({ error: 'Conversation not found' });
  return { ok: true };
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

// ---------- Portfolio Ledger ----------
app.get('/api/portfolio', async (req) => {
  const uid = await resolveUserId(req);
  return portfolio.listPortfolios(uid);
});

app.post('/api/portfolio', async (req, reply) => {
  const parsed = z
    .object({
      name: z.string().min(1).max(100),
      currency: z.string().max(10).optional().default('USD'),
      description: z.string().max(500).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid portfolio input' });
  const uid = await resolveUserId(req);
  const created = await portfolio.createPortfolio(uid, parsed.data.name, parsed.data.currency, parsed.data.description);
  return reply.code(201).send(created);
});

app.delete<{ Params: { id: string } }>('/api/portfolio/:id', async (req, reply) => {
  const uid = await resolveUserId(req);
  const ok = await portfolio.deletePortfolio(uid, req.params.id);
  return ok ? { ok: true } : reply.code(404).send({ error: 'Portfolio not found' });
});

app.get<{ Params: { id: string } }>('/api/portfolio/:id', async (req, reply) => {
  const uid = await resolveUserId(req);
  try {
    const priceLookup = async (sym: string) => {
      const q = await market.quote(sym).catch(() => null);
      return q?.price ?? null;
    };
    return await portfolio.getPortfolioSummary(uid, req.params.id, priceLookup);
  } catch (err) {
    return reply.code(404).send({ error: (err as Error).message });
  }
});

app.get<{ Params: { id: string } }>('/api/portfolio/:id/transactions', async (req, reply) => {
  const uid = await resolveUserId(req);
  try {
    return await portfolio.getTransactions(uid, req.params.id);
  } catch (err) {
    return reply.code(404).send({ error: (err as Error).message });
  }
});

const txBodySchema = z.object({
  type: z.enum(['BUY', 'SELL', 'CASH_DEPOSIT', 'CASH_WITHDRAWAL', 'DIVIDEND', 'FEE']),
  symbol: z.string().max(15).optional().nullable(),
  quantity: z.number().nonnegative().optional(),
  price: z.number().nonnegative().optional(),
  fee: z.number().nonnegative().optional(),
  timestamp: z.string().optional(),
  notes: z.string().max(500).optional(),
});

app.post<{ Params: { id: string } }>('/api/portfolio/:id/transactions', async (req, reply) => {
  const parsed = txBodySchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid transaction input' });
  const uid = await resolveUserId(req);
  try {
    const tx = await portfolio.addTransaction(uid, {
      portfolioId: req.params.id,
      ...parsed.data,
      symbol: parsed.data.symbol ? normalizeSymbol(parsed.data.symbol) : null,
    });
    return reply.code(201).send(tx);
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

const rebalanceBodySchema = z.object({
  targets: z
    .array(
      z.object({
        symbol: z.string().min(1).max(15),
        targetWeight: z.number().min(0).max(1),
      }),
    )
    .min(1)
    .max(50),
});

app.post<{ Params: { id: string } }>('/api/portfolio/:id/rebalance', async (req, reply) => {
  const parsed = rebalanceBodySchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid rebalance targets' });
  const uid = await resolveUserId(req);
  try {
    const priceLookup = async (sym: string) => {
      const q = await market.quote(sym).catch(() => null);
      return q?.price ?? null;
    };
    return await portfolio.simulateRebalancing(
      uid,
      req.params.id,
      parsed.data.targets.map((t) => ({ ...t, symbol: normalizeSymbol(t.symbol) })),
      priceLookup,
    );
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

app.get('/api/portfolio/profile', async (req) => {
  const uid = await resolveUserId(req);
  return portfolio.getInvestmentProfile(uid);
});

app.put('/api/portfolio/profile', async (req, reply) => {
  const parsed = z
    .object({
      horizon: z.enum(['short', 'medium', 'long']).optional(),
      riskTolerance: z.enum(['conservative', 'moderate', 'aggressive']).optional(),
      liquidityNeeds: z.enum(['low', 'medium', 'high']).optional(),
      lossCapacity: z.enum(['low', 'moderate', 'high']).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid profile data' });
  const uid = await resolveUserId(req);
  return portfolio.updateInvestmentProfile(uid, parsed.data);
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

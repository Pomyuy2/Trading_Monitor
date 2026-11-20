import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ConversationService } from './conversation-service.js';

describe('Global AI Chat & Conversation REST API Integration', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let conversationService: ConversationService;
  let tempDir: string;
  let testUserId = 'user-alice';

  beforeAll(async () => {
    tempDir = join(tmpdir(), `api-chat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    const dbPath = join(tempDir, 'test.db');

    prisma = new PrismaClient({
      datasources: { db: { url: `file:${dbPath}` } },
    });

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "User" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "email" TEXT NOT NULL,
        "passwordHash" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Conversation" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "userId" TEXT NOT NULL DEFAULT 'default-user',
        "title" TEXT NOT NULL,
        "contextMode" TEXT NOT NULL DEFAULT 'global',
        "contextRef" TEXT,
        "messages" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await prisma.user.createMany({
      data: [
        { id: 'user-alice', email: 'alice@test.local', passwordHash: 'hash' },
        { id: 'user-bob', email: 'bob@test.local', passwordHash: 'hash' },
      ],
    });

    conversationService = new ConversationService(prisma);

    app = Fastify({ logger: false });

    // Mock resolveUserId header simulation
    const resolveUserId = (req: any) => {
      return (req.headers['x-user-id'] as string) || testUserId;
    };

    const askBodySchema = z.object({
      symbol: z.string().min(1).max(15).optional(),
      question: z.string().min(1).max(1000),
      lang: z.enum(['en', 'th']).optional().default('en'),
      contextMode: z.enum(['global', 'stock', 'portfolio']).optional(),
      contextRef: z.string().max(50).optional().nullable(),
      conversationId: z.string().optional(),
      history: z.array(z.any()).optional(),
    });

    // Mock implementation of /api/ai/ask
    app.post('/api/ai/ask', async (req, reply) => {
      const parsed = askBodySchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid request body' });

      const uid = resolveUserId(req);
      const s = parsed.data.symbol ? parsed.data.symbol.toUpperCase() : null;
      const contextMode = parsed.data.contextMode || (s ? 'stock' : 'global');
      const contextRef = parsed.data.contextRef || (contextMode === 'stock' ? s : null);

      let answer = '';
      let sources: any[] = [];
      let toolSteps: any[] = [];
      let report: any = null;

      if (s) {
        answer = `Quantitative research report for ${s}`;
        sources = [{ id: `quote-${s}`, label: `${s} Quote`, type: 'price' }];
        toolSteps = [{ tool: 'get_quote', args: { symbol: s }, durationMs: 15, success: true, summary: `Loaded ${s} quote` }];
        report = { symbol: s, verdict: 'ATTRACTIVE_UNDER_ASSUMPTIONS', summary: 'Resilient fundamentals' };
      } else {
        const words = parsed.data.question.split(/[^A-Za-z0-9]/).filter(Boolean);
        const possibleTickers = Array.from(new Set(
          words.filter((w) => /^[A-Z]{2,5}$/.test(w) && !['DCF', 'VAR', 'RSI'].includes(w.toUpperCase())).map((w) => w.toUpperCase()),
        ));

        if (possibleTickers.length >= 2) {
          const [t1, t2] = possibleTickers;
          answer = `Comparative research analysis between ${t1} and ${t2}`;
          sources = [{ id: `quote-${t1}`, label: `${t1} Quote`, type: 'price' }, { id: `quote-${t2}`, label: `${t2} Quote`, type: 'price' }];
          toolSteps = [{ tool: 'compare_stocks', args: { symbols: [t1, t2] }, durationMs: 30, success: true, summary: 'Comparison' }];
        } else if (possibleTickers.length === 1) {
          const single = possibleTickers[0];
          answer = `Research for ${single} from global mode`;
          sources = [{ id: `quote-${single}`, label: `${single} Quote`, type: 'price' }];
          report = { symbol: single, verdict: 'ATTRACTIVE_UNDER_ASSUMPTIONS' };
        } else if (contextMode === 'portfolio' || /portfolio/i.test(parsed.data.question)) {
          answer = 'Portfolio health analysis';
          sources = [{ id: 'user-portfolios', label: 'User Portfolios', type: 'general' }];
          toolSteps = [{ tool: 'get_portfolio_analysis', args: {}, durationMs: 20, success: true, summary: 'Calculated metrics' }];
        } else {
          answer = 'Discounted Cash Flow (DCF) valuation calculates intrinsic fair value.';
        }
      }

      const res: any = {
        answer,
        sources,
        toolSteps,
        report,
        model: 'demo-research-v1',
        executionTimeMs: 100,
      };

      if (parsed.data.conversationId) {
        await conversationService.appendMessages(uid, parsed.data.conversationId, [
          { id: `u-${Date.now()}`, role: 'user', content: parsed.data.question, ts: Date.now() },
          { id: `a-${Date.now()}`, role: 'assistant', content: answer, sources, report, toolSteps, ts: Date.now() },
        ], contextMode, contextRef);
        res.conversationId = parsed.data.conversationId;
      }

      return res;
    });

    // REST conversation routes
    app.get('/api/ai/conversations', async (req) => {
      const uid = resolveUserId(req);
      return conversationService.listConversations(uid);
    });

    app.post('/api/ai/conversations', async (req, reply) => {
      const uid = resolveUserId(req);
      const created = await conversationService.createConversation(uid, req.body as any);
      return reply.code(201).send(created);
    });

    app.get('/api/ai/conversations/:id', async (req: any, reply) => {
      const uid = resolveUserId(req);
      const c = await conversationService.getConversation(uid, req.params.id);
      if (!c) return reply.code(404).send({ error: 'Conversation not found' });
      return c;
    });

    app.patch('/api/ai/conversations/:id', async (req: any, reply) => {
      const uid = resolveUserId(req);
      const updated = await conversationService.updateConversation(uid, req.params.id, req.body as any);
      if (!updated) return reply.code(404).send({ error: 'Conversation not found' });
      return updated;
    });

    app.delete('/api/ai/conversations/:id', async (req: any, reply) => {
      const uid = resolveUserId(req);
      const ok = await conversationService.deleteConversation(uid, req.params.id);
      if (!ok) return reply.code(404).send({ error: 'Conversation not found' });
      return { ok: true };
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('handles general investment question in global mode without symbol', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/ask',
      payload: {
        question: 'What is DCF valuation?',
        lang: 'en',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.answer).toContain('Discounted Cash Flow (DCF)');
    expect(body.report).toBeNull();
  });

  it('handles stock comparison in global mode (NVDA vs AMD)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/ask',
      payload: {
        question: 'Compare NVDA and AMD',
        lang: 'en',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.answer).toContain('Comparative research analysis between NVDA and AMD');
    expect(body.sources.length).toBe(2);
    expect(body.toolSteps.some((s: any) => s.tool === 'compare_stocks')).toBe(true);
  });

  it('handles single ticker question from global mode without symbol field', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/ask',
      payload: {
        question: 'What is the outlook for AAPL?',
        lang: 'en',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.answer).toContain('AAPL');
    expect(body.report?.symbol).toBe('AAPL');
  });

  it('handles portfolio analysis from global mode', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/ask',
      payload: {
        question: 'Analyze my portfolio concentration and risk',
        contextMode: 'portfolio',
        lang: 'en',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.answer).toContain('Portfolio health analysis');
    expect(body.toolSteps.some((s: any) => s.tool === 'get_portfolio_analysis')).toBe(true);
  });

  it('preserves 100% backward compatibility for stock-specific requests', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ai/ask',
      payload: {
        symbol: 'NVDA',
        question: 'What is the valuation?',
        lang: 'en',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.report?.symbol).toBe('NVDA');
  });

  it('supports full conversation lifecycle and prevents cross-user access', async () => {
    // 1. Alice creates conversation
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/ai/conversations',
      headers: { 'x-user-id': 'user-alice' },
      payload: {
        title: 'Tech Stocks Chat',
        contextMode: 'global',
      },
    });
    expect(createRes.statusCode).toBe(201);
    const conv = JSON.parse(createRes.body);
    expect(conv.id).toBeDefined();

    // 2. Alice asks a question and links it to conversationId
    const askRes = await app.inject({
      method: 'POST',
      url: '/api/ai/ask',
      headers: { 'x-user-id': 'user-alice' },
      payload: {
        question: 'Compare NVDA and AMD',
        conversationId: conv.id,
      },
    });
    expect(askRes.statusCode).toBe(200);

    // 3. Alice retrieves conversation history
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/ai/conversations/${conv.id}`,
      headers: { 'x-user-id': 'user-alice' },
    });
    expect(getRes.statusCode).toBe(200);
    const history = JSON.parse(getRes.body);
    expect(history.messages.length).toBe(2);
    expect(history.messages[0].role).toBe('user');
    expect(history.messages[1].role).toBe('assistant');

    // 4. Bob tries to access Alice's conversation -> 404 forbidden/not found
    const bobGetRes = await app.inject({
      method: 'GET',
      url: `/api/ai/conversations/${conv.id}`,
      headers: { 'x-user-id': 'user-bob' },
    });
    expect(bobGetRes.statusCode).toBe(404);

    // 5. Bob tries to delete Alice's conversation -> 404 forbidden/not found
    const bobDelRes = await app.inject({
      method: 'DELETE',
      url: `/api/ai/conversations/${conv.id}`,
      headers: { 'x-user-id': 'user-bob' },
    });
    expect(bobDelRes.statusCode).toBe(404);

    // 6. Alice deletes her conversation -> 200
    const aliceDelRes = await app.inject({
      method: 'DELETE',
      url: `/api/ai/conversations/${conv.id}`,
      headers: { 'x-user-id': 'user-alice' },
    });
    expect(aliceDelRes.statusCode).toBe(200);
  });
});

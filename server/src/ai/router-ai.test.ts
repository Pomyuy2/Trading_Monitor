import type { NewsItem } from '@tm/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractJson, readCompletion, RouterAi } from './router-ai.js';

const KEY = 'sk-test-SECRET';
const sse = (...parts: string[]) =>
  parts.map((p) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: p }, finish_reason: null }] })}\n\n`).join('') + 'data: [DONE]\n\n';

const news = (n: number): NewsItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `n${i}`,
    headline: `Headline ${i}`,
    snippet: null,
    source: 'Wire',
    url: 'https://example.com',
    publishedAt: '2026-11-11T00:00:00Z',
    sentiment: null,
    sentimentMethod: null,
  }) as unknown as NewsItem);

/** Answers each request with the next body in the list; records request bodies. */
function serve(...bodies: string[]) {
  const sent: { url: string; body: { model: string; messages: { role: string; content: string }[] }; auth: string | null }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get('authorization') });
    const body = bodies.shift() ?? '';
    return new Response(body, { status: 200, headers: { 'content-type': body.startsWith('data:') ? 'text/event-stream' : 'application/json' } });
  });
  return sent;
}

afterEach(() => vi.unstubAllGlobals());

describe('reading a chat completion', () => {
  it('joins the text of a streamed answer and ignores keep-alives', () => {
    expect(readCompletion(': ping\n\n' + sse('{"a":', '1}'))).toBe('{"a":1}');
  });
  it('reads a plain (non-streamed) JSON answer', () => {
    expect(readCompletion(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }))).toBe('hi');
  });
  it('pulls the JSON object out of a code fence or surrounding text', () => {
    expect(extractJson('```json\n{"x": 2}\n```')).toEqual({ x: 2 });
    expect(extractJson('Here you go: {"x": 3} hope it helps')).toEqual({ x: 3 });
    expect(() => extractJson('no json here')).toThrow();
  });
});

describe('RouterAi (OpenAI-compatible endpoint)', () => {
  const ai = () => new RouterAi('https://router.example.com/v1/', KEY, 'combo1');

  it('names itself after the model and host, and sends model + key + JSON instructions', async () => {
    const sent = serve(sse('{"labels":[{"index":0,"sentiment":"positive"},{"index":1,"sentiment":"neutral"}]}'));
    const r = ai();
    expect(r.name).toBe('combo1 · router.example.com');
    expect(await r.tagSentiment('AAPL', news(2))).toEqual(['positive', 'neutral']);
    expect(sent[0].url).toBe('https://router.example.com/v1/chat/completions');
    expect(sent[0].body.model).toBe('combo1');
    expect(sent[0].auth).toBe(`Bearer ${KEY}`);
    expect(sent[0].body.messages[0].content).toContain('JSON Schema');
  });

  it('asks again once when the first answer is not valid JSON', async () => {
    const sent = serve(sse('Sure! The summary is…'), sse('{"summary":"Shares rose after results.","articlesUsed":9}'));
    const s = await ai().summarizeNews('AAPL', 'Apple', 'en', news(3), 1.2);
    expect(sent).toHaveLength(2);
    expect(s).toEqual({ text: 'Shares rose after results.', articleCount: 3, source: 'combo1 · router.example.com' }); // capped at 3 articles
  });

  it('fails (so the app falls back to keyword sentiment) if a headline is skipped', async () => {
    serve(sse('{"labels":[{"index":0,"sentiment":"positive"}]}'));
    await expect(ai().tagSentiment('AAPL', news(2))).rejects.toThrow('skipped');
  });

  it('keeps the translation count and empty strings', async () => {
    serve(sse('{"translations":["รายได้ 10 พันล้านดอลลาร์","x"]}'));
    expect(await ai().translate(['Revenue $10B', ''], 'th')).toEqual(['รายได้ 10 พันล้านดอลลาร์', '']);
  });

  it('never puts the key or URL in errors', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));
    const err = (await ai().tagSentiment('AAPL', news(1)).catch((e) => e)) as Error;
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain('router.example.com/v1');
  });
});

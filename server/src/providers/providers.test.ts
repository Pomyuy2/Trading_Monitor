/**
 * Provider adapter tests against RECORDED real responses (server/test/fixtures/, trimmed, no keys).
 * fetch() is stubbed: unknown URLs throw, so these tests never touch the network.
 */
import { RANGE_RESOLUTION } from '@tm/shared';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinnhubProvider } from './finnhub.js';
import { FmpProvider } from './fmp.js';
import { SecEdgarProvider } from './sec.js';
import { TwelveDataProvider } from './twelvedata.js';
import { NotFoundError, NotSupportedError, ProviderAuthError, RateLimitError, type Tick } from './types.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures');
const json = (p: string) => readFileSync(join(FIX, p), 'utf8');

type Route = { match: RegExp; status?: number; body: string; type?: string };
let routes: Route[] = [];
let calls: string[] = [];

function serve(match: RegExp, fixture: string, status = 200) {
  routes.push({ match, status, body: json(fixture), type: fixture.endsWith('.html') ? 'text/html' : 'application/json' });
}
function serveBody(match: RegExp, body: string, status = 200, type = 'text/html') {
  routes.push({ match, status, body, type });
}

beforeEach(() => {
  routes = [];
  calls = [];
  // Freeze "now" at the recording date (only Date — timers and promises stay real).
  vi.useFakeTimers({ now: new Date('2026-11-10T07:00:00Z'), toFake: ['Date'] });
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const r = routes.find((x) => x.match.test(url));
    if (!r) throw new Error(`Unexpected network call in test: ${url}`);
    return new Response(r.body, { status: r.status, headers: { 'content-type': r.type ?? 'application/json' } });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const quiet = { info() {}, warn() {} };

// ---------------------------------------------------------------- Finnhub
describe('FinnhubProvider (recorded)', () => {
  const fh = () => new FinnhubProvider('test-key', quiet);
  const finnhubQuoteRoutes = () => {
    serve(/finnhub\.io\/api\/v1\/quote\?symbol=AAPL/, 'finnhub/quote-AAPL.json');
    serve(/stock\/profile2\?symbol=AAPL/, 'finnhub/profile2-AAPL.json');
    serve(/stock\/metric\?symbol=AAPL/, 'finnhub/metric-AAPL.json');
    serve(/stock\/market-status/, 'finnhub/market-status.json');
  };

  it('maps a quote, converting market cap and average volume from millions', async () => {
    finnhubQuoteRoutes();
    const q = await fh().getQuote('AAPL');
    expect(q).toMatchObject({
      symbol: 'AAPL',
      name: 'Apple Inc.',
      exchange: 'NASDAQ',
      price: 350.69,
      change: 8.32,
      changePct: 2.4301,
      open: 344.995,
      high: 352.33,
      low: 344.78,
      prevClose: 342.37,
      volume: null, // Finnhub's quote has no volume (FMP fills it)
      avgVolume: 56_680_420,
      peTTM: 38.3713,
      week52High: 355.38,
      week52Low: 243.42,
      dividendYield: 0.31,
      marketState: 'closed',
      delayed: false,
    });
    expect(q.marketCap).toBe(Math.round(5096290.706868641 * 1_000_000));
    expect(q.ts).toBe(1794258000 * 1000);
    expect(q.meta.source).toBe('Finnhub');
  });

  it('treats an all-zero quote as an unknown symbol', async () => {
    serve(/quote\?symbol=ZZZZQ/, 'finnhub/quote-UNKNOWN.json');
    serveBody(/profile2|metric/, '{}', 200, 'application/json');
    serve(/market-status/, 'finnhub/market-status.json');
    await expect(fh().getQuote('ZZZZQ')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('sends the key as a header, never in the URL', async () => {
    finnhubQuoteRoutes();
    await fh().getQuote('AAPL');
    expect(calls.every((u) => !u.includes('test-key'))).toBe(true);
  });

  it('maps HTTP 429 to RateLimitError and 403 to ProviderAuthError', async () => {
    serveBody(/quote\?symbol=AAPL/, '{"error":"limit"}', 429, 'application/json');
    serveBody(/profile2|metric|market-status/, '{}', 200, 'application/json');
    await expect(fh().getQuote('AAPL')).rejects.toBeInstanceOf(RateLimitError);
    routes = [];
    serveBody(/quote\?symbol=AAPL/, '{"error":"You don\'t have access to this resource."}', 403, 'application/json');
    serveBody(/profile2|metric|market-status/, '{}', 200, 'application/json');
    await expect(fh().getQuote('AAPL')).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('searches US symbols (stocks / ETFs / ADRs only, max 10)', async () => {
    serve(/search\?q=apple/, 'finnhub/search-apple.json');
    const r = await fh().searchSymbols('apple');
    expect(r.length).toBeLessThanOrEqual(10);
    expect(r[0]).toEqual({ symbol: 'AAPL', name: expect.stringMatching(/apple/i), exchange: 'US', type: 'Common Stock' });
  });

  it('maps company news within the time window, newest first, de-duplicated', async () => {
    serve(/company-news\?symbol=AAPL/, 'finnhub/company-news-AAPL.json');
    const from = Date.parse('2026-11-09T00:00:00Z');
    const to = Date.parse('2026-11-10T07:00:00Z');
    const items = await fh().getNews('AAPL', from, to);
    expect(items.length).toBeGreaterThan(10);
    expect(items.every((n) => Date.parse(n.publishedAt) >= from && Date.parse(n.publishedAt) <= to)).toBe(true);
    for (let i = 1; i < items.length; i++) expect(Date.parse(items[i - 1].publishedAt)).toBeGreaterThanOrEqual(Date.parse(items[i].publishedAt));
    expect(new Set(items.map((n) => n.headline.toLowerCase())).size).toBe(items.length);
    expect(items[0]).toMatchObject({ id: expect.stringMatching(/^fh-/), sentiment: null, url: expect.stringMatching(/^https?:/) });
    expect(items.every((n) => n.snippet.length <= 400)).toBe(true);
  });

  it('turns one WebSocket message with many trades into one tick per symbol (latest price, summed volume)', () => {
    const p = fh();
    const ticks: Tick[] = [];
    p.onTick((t) => ticks.push(t));
    (p as unknown as { onMessage(raw: string): void }).onMessage(
      JSON.stringify({
        type: 'trade',
        data: [
          { s: 'AAPL', p: 350.1, t: 1000, v: 10 },
          { s: 'AAPL', p: 350.3, t: 3000, v: 5 },
          { s: 'AAPL', p: 350.2, t: 2000, v: 7 }, // out of order: older than the 3000 trade
          { s: 'NVDA', p: 180.5, t: 1500, v: 100 },
        ],
      }),
    );
    expect(ticks).toEqual([
      { symbol: 'AAPL', price: 350.3, ts: 3000, volume: 22 },
      { symbol: 'NVDA', price: 180.5, ts: 1500, volume: 100 },
    ]);
  });

  it('ignores pings and reports WebSocket errors without throwing', () => {
    const warn = vi.fn();
    const p = new FinnhubProvider('k', { info() {}, warn });
    const ticks: Tick[] = [];
    p.onTick((t) => ticks.push(t));
    const msg = (o: unknown) => (p as unknown as { onMessage(raw: string): void }).onMessage(JSON.stringify(o));
    msg({ type: 'ping' });
    msg({ type: 'error', msg: 'Subscribing to too many symbols' });
    (p as unknown as { onMessage(raw: string): void }).onMessage('not json');
    expect(ticks).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('too many symbols'));
  });
});

// ---------------------------------------------------------------- FMP
describe('FmpProvider (recorded)', () => {
  const fmp = () => new FmpProvider('test-key');

  it('serves 6M and 1Y daily candles from one 5-year download, and 5Y as Monday-aligned weeks', async () => {
    serve(/historical-price-eod\/full\?symbol=AAPL/, 'fmp/eod-AAPL.json');
    const p = fmp();
    const m6 = await p.getCandles('AAPL', '6M');
    const y1 = await p.getCandles('AAPL', '1Y');
    const y5 = await p.getCandles('AAPL', '5Y');
    expect(calls.filter((u) => u.includes('historical-price-eod'))).toHaveLength(1); // memoized
    expect(m6.resolution).toBe('1day');
    expect(y5.resolution).toBe('1week');
    expect(m6.candles.length).toBeGreaterThan(115);
    expect(m6.candles.length).toBeLessThan(135);
    expect(y1.candles.length).toBeGreaterThan(240);
    expect(y1.candles.length).toBeLessThan(260);
    // ascending, last bar = most recent session
    expect(y1.candles.at(-1)).toMatchObject({ time: Date.parse('2026-11-09T00:00:00Z') / 1000, close: 350.69 });
    for (let i = 1; i < y1.candles.length; i++) expect(y1.candles[i].time).toBeGreaterThan(y1.candles[i - 1].time);
    // weekly bars start on Monday 00:00 UTC
    expect(y5.candles.every((c) => new Date(c.time * 1000).getUTCDay() === 1)).toBe(true);
    expect(y5.candles.length).toBeGreaterThan(250);
    const lastWeek = y5.candles.at(-1)!;
    expect(lastWeek.close).toBe(350.69);
    expect(lastWeek.high).toBeGreaterThanOrEqual(lastWeek.close);
  });

  it('refuses intraday ranges (they are paid on FMP)', async () => {
    await expect(fmp().getCandles('AAPL', '1D')).rejects.toBeInstanceOf(NotSupportedError);
  });

  it('builds the profile: CEO from the profile, CFO from key executives, unknown founded year stays null', async () => {
    serve(/profile\?symbol=AAPL/, 'fmp/profile-AAPL.json');
    serve(/key-executives\?symbol=AAPL/, 'fmp/key-executives-AAPL.json');
    const p = await fmp().getProfile('AAPL');
    expect(p).toMatchObject({
      name: 'Apple Inc.',
      ceo: { name: 'John Ternus', since: null },
      cfo: { name: 'Kevan Parekh', since: null },
      hq: 'Cupertino, CA, US',
      founded: null,
      employees: 167000,
      website: expect.stringContaining('apple.com'),
    });
    // one line: first sentence only
    expect(p.description).toMatch(/^Apple Inc\. is a global technology corporation .*\.$/);
    expect(p.description!.length).toBeLessThanOrEqual(260);
  });

  it('picks estimates for the fiscal year in progress (first period ending after today)', async () => {
    serve(/analyst-estimates\?symbol=AAPL/, 'fmp/analyst-estimates-AAPL.json');
    const e = await fmp().getEstimates('AAPL');
    expect(e).toMatchObject({ fiscalYear: 2027, revenueAvg: 526232871628, epsAvg: 9.45682, analystCount: 27 });
  });

  it('maps price targets, ratings (strong buy + buy, sell + strong sell) and the next earnings date', async () => {
    serve(/price-target-consensus\?symbol=AAPL/, 'fmp/price-target-consensus-AAPL.json');
    serve(/grades-consensus\?symbol=AAPL/, 'fmp/grades-consensus-AAPL.json');
    serve(/\/earnings\?symbol=AAPL/, 'fmp/earnings-AAPL.json');
    const p = fmp();
    expect(await p.getPriceTargets('AAPL')).toMatchObject({ low: 245, avg: 341.94, high: 400 });
    expect(await p.getRatings('AAPL')).toMatchObject({ buy: 70, hold: 33, sell: 9 });
    expect((await p.getEarningsCalendar('AAPL')).date).toBe('2027-02-04');
  });

  it('asks for at most 5 earnings rows (more is a paid parameter → 402)', async () => {
    serve(/\/earnings\?symbol=AAPL/, 'fmp/earnings-AAPL.json');
    await fmp().getEarningsHistory('AAPL', Date.parse('2025-11-01'), Date.parse('2027-03-01'));
    expect(calls.some((u) => /limit=([6-9]|\d\d)/.test(u))).toBe(false);
    routes = [];
    serve(/\/earnings\?symbol=AAPL/, 'fmp/earnings-limit-error.txt', 402);
    await expect(fmp().getEarningsCalendar('AAPL')).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it('returns earnings history in the window, oldest first, with EPS actual vs estimate', async () => {
    serve(/\/earnings\?symbol=AAPL/, 'fmp/earnings-AAPL.json');
    const h = await fmp().getEarningsHistory('AAPL', Date.parse('2026-03-01'), Date.parse('2026-12-31'));
    expect(h.map((x) => x.date)).toEqual(['2026-04-30', '2026-07-30', '2026-11-02']);
    expect(h[2]).toMatchObject({ epsActual: 2.05, epsEstimate: 1.99 });
  });

  it('maps dividends oldest first and volume from the quote', async () => {
    serve(/dividends\?symbol=AAPL/, 'fmp/dividends-AAPL.json');
    serve(/stable\/quote\?symbol=AAPL/, 'fmp/quote-AAPL.json');
    const d = await fmp().getDividends('AAPL');
    expect(d.at(-1)).toMatchObject({ exDate: '2026-11-12', amount: 0.27 });
    for (let i = 1; i < d.length; i++) expect(d[i].exDate > d[i - 1].exDate).toBe(true);
    expect((await fmp().getKeyStats('AAPL')).volume).toBe(47499490);
  });
});

// ---------------------------------------------------------------- Twelve Data
describe('TwelveDataProvider (recorded)', () => {
  const td = () => new TwelveDataProvider('test-key');

  it('parses UTC bars and keeps only the latest session for 1D', async () => {
    serve(/time_series\?symbol=AAPL&interval=5min/, 'twelvedata/time_series-AAPL-5min.json');
    const s = await td().getCandles('AAPL', '1D');
    expect(s.resolution).toBe(RANGE_RESOLUTION['1D']);
    expect(s.candles).toHaveLength(78); // 09:30–16:00 New York in 5-minute bars
    expect(new Date(s.candles[0].time * 1000).toISOString()).toBe('2026-11-09T14:30:00.000Z');
    expect(new Date(s.candles.at(-1)!.time * 1000).toISOString()).toBe('2026-11-09T20:55:00.000Z');
    expect(s.candles.at(-1)!.close).toBeCloseTo(350.49, 2);
    expect(s.candles.every((c) => typeof c.open === 'number' && c.high >= c.low)).toBe(true);
  });

  it('sends the key as a header, never in the URL', async () => {
    serve(/time_series/, 'twelvedata/time_series-AAPL-5min.json');
    await td().getCandles('AAPL', '1D');
    expect(calls.every((u) => !u.includes('test-key'))).toBe(true);
  });

  it('returns no candles (with a note) for an unknown symbol', async () => {
    serve(/time_series\?symbol=ZZZZQ/, 'twelvedata/time_series-UNKNOWN.json');
    const s = await td().getCandles('ZZZZQ', '1D');
    expect(s.candles).toEqual([]);
    expect(s.meta.note).toBeTruthy();
  });

  it('maps a 429 reported in the body (HTTP 200) to RateLimitError', async () => {
    serveBody(/time_series/, JSON.stringify({ code: 429, message: 'You have run out of API credits for the current minute.', status: 'error' }), 200, 'application/json');
    await expect(td().getCandles('AAPL', '1D')).rejects.toBeInstanceOf(RateLimitError);
  });

  it('refuses a 9th request within a minute locally, without calling the API', async () => {
    serve(/time_series/, 'twelvedata/time_series-AAPL-5min.json');
    const p = td();
    for (let i = 0; i < 8; i++) await p.getCandles('AAPL', '1D');
    await expect(p.getCandles('AAPL', '1D')).rejects.toBeInstanceOf(RateLimitError);
    expect(calls).toHaveLength(8);
  });

  it('does not serve daily ranges', async () => {
    await expect(td().getCandles('AAPL', '1Y')).rejects.toBeInstanceOf(NotSupportedError);
  });
});

// ---------------------------------------------------------------- SEC EDGAR
describe('SecEdgarProvider (recorded)', () => {
  const pressRelease = `<html><body><p>Exhibit 99.1</p><p>Apple reports fourth quarter results.</p>${'<p>Revenue grew and services set a record. '.repeat(30)}</p></body></html>`;
  const tenK = [
    '<html><body><ix:header><p>hidden xbrl facts</p></ix:header>',
    '<p>Item 7.</p><p>Management’s Discussion and Analysis 20</p><p>Item 7A.</p><p>Quantitative 30</p><p>Item 8.</p><p>Financial Statements 31</p>',
    '<p>Item 7. Management’s Discussion and Analysis of Financial Condition and Results of Operations</p>',
    '<p>This should be read with Part II, Item 8 of this Form 10-K.</p>',
    `<p>${'We plan to invest in data centers and new products. '.repeat(30)}</p>`,
    '<p>Item 7A. Quantitative and Qualitative Disclosures About Market Risk</p><p>Market risk text.</p>',
    '</body></html>',
  ].join('\n');

  const secRoutes = () => {
    serve(/sec\.gov\/files\/company_tickers\.json/, 'sec/company_tickers.json');
    serve(/data\.sec\.gov\/submissions\/CIK0000320193\.json/, 'sec/submissions-AAPL.json');
    serve(/0000320193-26-000024-index\.html/, 'sec/index-8k-AAPL.html');
    serveBody(/a8-kex991q4202609262026\.htm/, pressRelease);
    serveBody(/aapl-20260926\.htm/, tenK);
  };

  it('finds the latest earnings release via the index page (EX-99.1) and the 10-K MD&A', async () => {
    secRoutes();
    const docs = await new SecEdgarProvider('TradingMonitor test').getGuidanceDocuments('AAPL');
    expect(docs.map((d) => [d.title, d.date])).toEqual([
      ['Earnings press release (Form 8-K, Exhibit 99.1)', '2026-11-02'],
      ['Annual report (Form 10-K), MD&A', '2026-11-03'],
    ]);
    expect(docs[0].url).toMatch(/a8-kex991q4202609262026\.htm$/);
    expect(docs[0].text).toContain('Apple reports fourth quarter results');
    expect(docs[1].text.startsWith('Item 7. Management’s Discussion')).toBe(true);
    expect(docs[1].text).toContain('invest in data centers');
    expect(docs[1].text).not.toContain('Market risk text');
    expect(docs[1].text).not.toContain('hidden xbrl facts');
  });

  it('sends a User-Agent (SEC requirement)', async () => {
    secRoutes();
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('User-Agent') ?? '');
      const r = routes.find((x) => x.match.test(String(input)))!;
      return new Response(r.body, { status: r.status });
    });
    await new SecEdgarProvider('TradingMonitor test').getGuidanceDocuments('AAPL');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((ua) => ua === 'TradingMonitor test')).toBe(true);
  });

  it('rejects a ticker that is not an SEC filer', async () => {
    serve(/company_tickers\.json/, 'sec/company_tickers.json');
    await expect(new SecEdgarProvider('ua').getGuidanceDocuments('ZZZZQ')).rejects.toBeInstanceOf(NotFoundError);
  });
});

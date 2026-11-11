import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { NotFoundError, NotSupportedError } from './types.js';
import { YahooCrumbManager, YahooProvider } from './yahoo.js';

describe('YahooProvider', () => {
  let routes: Array<{ match: RegExp; status?: number; body: string; headers?: Record<string, string> }> = [];

  beforeEach(() => {
    routes = [];
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const r = routes.find((x) => x.match.test(url));
      if (!r) throw new Error(`Unexpected network call: ${url}`);
      return new Response(r.body, {
        status: r.status ?? 200,
        headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
      });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is available without an API key and supports its capabilities', () => {
    const provider = new YahooProvider();
    expect(provider.isAvailable()).toBe(true);
    expect(provider.supports('intradayCandles')).toBe(true);
    expect(provider.supports('dailyCandles')).toBe(true);
    expect(provider.supports('quote')).toBe(true);
    expect(provider.supports('keyStats')).toBe(true);
    expect(provider.supports('search')).toBe(true);
    expect(provider.supports('profile')).toBe(true);
    expect(provider.supports('priceTargets')).toBe(true);
    expect(provider.supports('ratings')).toBe(true);
    expect(provider.supports('dividends')).toBe(true);
    expect(provider.supports('transcripts')).toBe(false);
  });

  it('maps candles correctly, filtering invalid bars and sorting chronologically', async () => {
    routes.push({
      match: /chart\/AAPL\?interval=5m&range=1d/,
      body: JSON.stringify({
        chart: {
          result: [
            {
              meta: { symbol: 'AAPL', currency: 'USD', regularMarketPrice: 220.5 },
              timestamp: [1700000300, 1700000000, 1700000600],
              indicators: {
                quote: [
                  {
                    open: [221, 220, null],
                    high: [222, 221, null],
                    low: [220, 219, null],
                    close: [221.5, 220.5, null],
                    volume: [1000, 2000, null],
                  },
                ],
              },
            },
          ],
        },
      }),
    });

    const provider = new YahooProvider();
    const series = await provider.getCandles('AAPL', '1D');
    expect(series.symbol).toBe('AAPL');
    expect(series.range).toBe('1D');
    expect(series.resolution).toBe('5min');
    expect(series.candles).toHaveLength(2); // null bar filtered
    expect(series.candles[0].time).toBe(1700000000); // sorted chronologically
    expect(series.candles[0].open).toBe(220);
    expect(series.candles[0].close).toBe(220.5);
    expect(series.candles[1].time).toBe(1700000300);
    expect(series.meta.source).toBe('Yahoo Finance');
  });

  it('throws NotFoundError when chart API reports symbol not found', async () => {
    routes.push({
      match: /chart\/NONEXISTENT/,
      body: JSON.stringify({
        chart: {
          result: null,
          error: { code: 'Not Found', description: 'No data found, symbol may be delisted' },
        },
      }),
    });

    const provider = new YahooProvider();
    await expect(provider.getCandles('NONEXISTENT', '1D')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('maps quote fields from chart metadata and candles', async () => {
    routes.push({
      match: /chart\/TSLA\?interval=5m&range=1d/,
      body: JSON.stringify({
        chart: {
          result: [
            {
              meta: {
                symbol: 'TSLA',
                longName: 'Tesla, Inc.',
                exchangeName: 'NMS',
                currency: 'USD',
                regularMarketPrice: 250.0,
                regularMarketChangePercent: 2.5,
                chartPreviousClose: 243.9,
                regularMarketDayHigh: 252.0,
                regularMarketDayLow: 242.0,
                regularMarketVolume: 50000000,
                fiftyTwoWeekHigh: 270.0,
                fiftyTwoWeekLow: 140.0,
                regularMarketTime: 1700000000,
                currentTradingPeriod: {
                  regular: { start: 1699990000, end: 1700020000 },
                },
              },
              timestamp: [1700000000],
              indicators: {
                quote: [{ open: [244.0], high: [252.0], low: [242.0], close: [250.0], volume: [50000000] }],
              },
            },
          ],
        },
      }),
    });

    const provider = new YahooProvider();
    const q = await provider.getQuote('TSLA');
    expect(q.symbol).toBe('TSLA');
    expect(q.name).toBe('Tesla, Inc.');
    expect(q.exchange).toBe('NASDAQ');
    expect(q.price).toBe(250.0);
    expect(q.change).toBe(6.1);
    expect(q.changePct).toBe(2.5);
    expect(q.open).toBe(244.0);
    expect(q.high).toBe(252.0);
    expect(q.low).toBe(242.0);
    expect(q.prevClose).toBe(243.9);
    expect(q.volume).toBe(50000000);
    expect(q.week52High).toBe(270.0);
    expect(q.week52Low).toBe(140.0);
    expect(q.meta.source).toBe('Yahoo Finance');
  });

  it('searches symbols and filters only equity/ETF results', async () => {
    routes.push({
      match: /v1\/finance\/search\?q=rocket/,
      body: JSON.stringify({
        quotes: [
          {
            symbol: 'RKLB',
            longname: 'Rocket Lab Corporation',
            exchDisp: 'NASDAQ',
            quoteType: 'EQUITY',
            typeDisp: 'Equity',
          },
          {
            symbol: 'ROKT',
            longname: 'SPDR S&P Kensho Final Frontiers ETF',
            exchDisp: 'NYSE Arca',
            quoteType: 'ETF',
            typeDisp: 'ETF',
          },
          {
            symbol: 'IGNORED_FUTURE',
            longname: 'Some Futures',
            quoteType: 'FUTURE',
            typeDisp: 'Futures',
          },
        ],
      }),
    });

    const provider = new YahooProvider();
    const matches = await provider.searchSymbols('rocket');
    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({
      symbol: 'RKLB',
      name: 'Rocket Lab Corporation',
      exchange: 'NASDAQ',
      type: 'Equity',
    });
    expect(matches[1]).toEqual({
      symbol: 'ROKT',
      name: 'SPDR S&P Kensho Final Frontiers ETF',
      exchange: 'NYSE Arca',
      type: 'ETF',
    });
  });

  it('fetches profile, price targets, and ratings using CrumbManager', async () => {
    // Crumb exchange
    routes.push({
      match: /fc\.yahoo\.com/,
      status: 404,
      body: '',
      headers: { 'set-cookie': 'A3=mock_cookie; Path=/' },
    });
    routes.push({
      match: /getcrumb/,
      body: 'mock_crumb_123',
    });

    // Profile & price targets & ratings mock responses
    routes.push({
      match: /quoteSummary\/RKLB\?modules=assetProfile,price/,
      body: JSON.stringify({
        quoteSummary: {
          result: [
            {
              price: { longName: 'Rocket Lab Corporation' },
              assetProfile: {
                city: 'Long Beach',
                state: 'CA',
                country: 'United States',
                website: 'https://rocketlabusa.com',
                fullTimeEmployees: 1800,
                longBusinessSummary: 'Rocket Lab is a space systems company.',
                companyOfficers: [
                  { name: 'Peter Beck', title: 'President, Chief Executive Officer' },
                  { name: 'Adam Spice', title: 'Chief Financial Officer' },
                ],
              },
            },
          ],
        },
      }),
    });

    routes.push({
      match: /quoteSummary\/RKLB\?modules=financialData/,
      body: JSON.stringify({
        quoteSummary: {
          result: [
            {
              financialData: {
                targetLowPrice: { raw: 15.0 },
                targetMeanPrice: { raw: 22.5 },
                targetHighPrice: { raw: 30.0 },
              },
            },
          ],
        },
      }),
    });

    routes.push({
      match: /quoteSummary\/RKLB\?modules=recommendationTrend/,
      body: JSON.stringify({
        quoteSummary: {
          result: [
            {
              recommendationTrend: {
                trend: [
                  {
                    strongBuy: 5,
                    buy: 10,
                    hold: 3,
                    sell: 1,
                    strongSell: 0,
                  },
                ],
              },
            },
          ],
        },
      }),
    });

    const provider = new YahooProvider();

    // 1. Profile
    const profile = await provider.getProfile('RKLB');
    expect(profile.symbol).toBe('RKLB');
    expect(profile.name).toBe('Rocket Lab Corporation');
    expect(profile.ceo?.name).toBe('Peter Beck');
    expect(profile.cfo?.name).toBe('Adam Spice');
    expect(profile.hq).toBe('Long Beach, CA, United States');
    expect(profile.employees).toBe(1800);
    expect(profile.website).toBe('https://rocketlabusa.com');

    // 2. Price Targets
    const targets = await provider.getPriceTargets('RKLB');
    expect(targets.low).toBe(15.0);
    expect(targets.avg).toBe(22.5);
    expect(targets.high).toBe(30.0);

    // 3. Ratings
    const ratings = await provider.getRatings('RKLB');
    expect(ratings.buy).toBe(15); // 5 + 10
    expect(ratings.hold).toBe(3);
    expect(ratings.sell).toBe(1); // 1 + 0
  });

  it('fetches dividends from chart events', async () => {
    routes.push({
      match: /chart\/AAPL\?interval=1d&range=5y&events=div/,
      body: JSON.stringify({
        chart: {
          result: [
            {
              events: {
                dividends: {
                  '1700000000': { amount: 0.25, date: 1700000000 },
                  '1690000000': { amount: 0.24, date: 1690000000 },
                },
              },
            },
          ],
        },
      }),
    });

    const provider = new YahooProvider();
    const dividends = await provider.getDividends('AAPL');
    expect(dividends).toHaveLength(2);
    expect(dividends[0].amount).toBe(0.24);
    expect(dividends[1].amount).toBe(0.25);
  });
});

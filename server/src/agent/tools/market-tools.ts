import { z } from 'zod/v4';
import type { ToolDefinition, ToolResult } from '../types.js';
import type { CandleSeries, InsightResponse, Profile, Quote } from '@tm/shared';

// Helper to normalize stock ticker symbols
function cleanSymbol(sym: string): string {
  return sym.trim().toUpperCase();
}

/** 1. get_quote */
export const getQuoteTool: ToolDefinition<{ symbol: string }> = {
  name: 'get_quote',
  description: 'Fetch the latest real-time or end-of-day market quote for a stock symbol, including price, change, day range, 52-week range, and market cap.',
  parameters: z.object({
    symbol: z.string().min(1).max(15).describe('Stock ticker symbol, e.g. AAPL, NVDA, RKLB'),
  }),
  async execute({ symbol }, ctx): Promise<ToolResult<Quote>> {
    const sym = cleanSymbol(symbol);
    try {
      const quote = await ctx.market.quote(sym, true);
      return {
        success: true,
        data: quote,
        provenance: {
          source: quote.meta.source,
          updatedAt: quote.meta.updatedAt,
          feed: quote.delayed ? 'delayed' : 'realtime',
        },
        evidenceSource: {
          id: `quote-${sym}`,
          label: `${sym} Quote · ${quote.meta.source}`,
          type: 'price',
        },
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        provenance: {
          source: 'MarketService',
          updatedAt: new Date().toISOString(),
          warnings: [`Failed to fetch quote for ${sym}: ${(err as Error).message}`],
        },
      };
    }
  },
};

/** 2. get_candles */
export const getCandlesTool: ToolDefinition<{ symbol: string; range?: string }> = {
  name: 'get_candles',
  description: 'Fetch historical OHLCV candle series for a stock across ranges like 1D, 1W, 1M, 6M, 1Y, 5Y.',
  parameters: z.object({
    symbol: z.string().min(1).max(15).describe('Stock ticker symbol, e.g. AAPL'),
    range: z.enum(['1D', '1W', '1M', '6M', '1Y', '5Y']).optional().default('1Y').describe('Historical chart time range'),
  }),
  async execute({ symbol, range }, ctx): Promise<ToolResult<CandleSeries>> {
    const sym = cleanSymbol(symbol);
    const r = (range as any) || '1Y';
    try {
      const series = await ctx.market.candles(sym, r);
      return {
        success: true,
        data: series,
        provenance: {
          source: series.meta.source,
          updatedAt: series.meta.updatedAt,
          feed: series.meta.feed,
          latency: series.meta.latency,
        },
        evidenceSource: {
          id: `candles-${sym}-${r}`,
          label: `${sym} Candles (${r}) · ${series.meta.source}`,
          type: 'levels',
        },
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        provenance: {
          source: 'MarketService',
          updatedAt: new Date().toISOString(),
          warnings: [`Failed to fetch candles for ${sym}: ${(err as Error).message}`],
        },
      };
    }
  },
};

/** 3. get_company_profile */
export const getCompanyProfileTool: ToolDefinition<{ symbol: string }> = {
  name: 'get_company_profile',
  description: 'Fetch company business overview, sector, industry, CEO, headquarters, and employee count.',
  parameters: z.object({
    symbol: z.string().min(1).max(15).describe('Stock ticker symbol'),
  }),
  async execute({ symbol }, ctx): Promise<ToolResult<Profile | null>> {
    const sym = cleanSymbol(symbol);
    try {
      const insight = await ctx.market.insight(sym, ctx.lang);
      const profile = insight.profile;
      return {
        success: true,
        data: profile,
        provenance: {
          source: profile?.meta?.source ?? 'FMP',
          updatedAt: profile?.meta?.updatedAt ?? new Date().toISOString(),
        },
        evidenceSource: {
          id: `profile-${sym}`,
          label: `${sym} Profile · ${profile?.meta?.source ?? 'FMP'}`,
          type: 'general',
        },
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        provenance: {
          source: 'MarketService',
          updatedAt: new Date().toISOString(),
        },
      };
    }
  },
};

/** 4. get_company_facts */
export const getCompanyFactsTool: ToolDefinition<{ symbol: string }> = {
  name: 'get_company_facts',
  description: 'Fetch official SEC EDGAR XBRL company financial facts including annual and quarterly balance sheets, revenues, net income, EPS, assets, and liabilities.',
  parameters: z.object({
    symbol: z.string().min(1).max(15).describe('US stock ticker symbol, e.g. AAPL, NVDA, RKLB'),
  }),
  async execute({ symbol }, ctx): Promise<ToolResult<unknown>> {
    const sym = cleanSymbol(symbol);
    try {
      const facts = await ctx.market.companyFacts(sym);
      return {
        success: true,
        data: facts,
        provenance: {
          source: 'SEC EDGAR',
          updatedAt: new Date().toISOString(),
        },
        evidenceSource: {
          id: `sec-facts-${sym}`,
          label: `${sym} XBRL Financials · SEC EDGAR`,
          type: 'guidance',
        },
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        provenance: {
          source: 'SEC EDGAR',
          updatedAt: new Date().toISOString(),
          warnings: [`SEC Company Facts unavailable for ${sym}: ${(err as Error).message}`],
        },
      };
    }
  },
};

/** 5. get_company_insight */
export const getCompanyInsightTool: ToolDefinition<{ symbol: string }> = {
  name: 'get_company_insight',
  description: 'Fetch Wall Street analyst consensus price targets, buy/hold/sell ratings, upcoming earnings dates, and management guidance.',
  parameters: z.object({
    symbol: z.string().min(1).max(15).describe('Stock ticker symbol'),
  }),
  async execute({ symbol }, ctx): Promise<ToolResult<InsightResponse>> {
    const sym = cleanSymbol(symbol);
    try {
      const insight = await ctx.market.insight(sym, ctx.lang);
      return {
        success: true,
        data: insight,
        provenance: {
          source: insight.priceTargets?.meta?.source ?? 'FMP',
          updatedAt: new Date().toISOString(),
        },
        evidenceSource: {
          id: `insight-${sym}`,
          label: `${sym} Analyst Targets & Ratings · ${insight.priceTargets?.meta?.source ?? 'FMP'}`,
          type: 'analyst',
        },
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        provenance: {
          source: 'MarketService',
          updatedAt: new Date().toISOString(),
        },
      };
    }
  },
};

/** 6. get_news */
export const getNewsTool: ToolDefinition<{ symbol: string }> = {
  name: 'get_news',
  description: 'Fetch recent market news articles, AI sentiment tags, and news summary for a stock symbol.',
  parameters: z.object({
    symbol: z.string().min(1).max(15).describe('Stock ticker symbol'),
  }),
  async execute({ symbol }, ctx): Promise<ToolResult<unknown>> {
    const sym = cleanSymbol(symbol);
    try {
      const news = await ctx.market.news(sym, ctx.lang);
      return {
        success: true,
        data: {
          summary: news.summary?.text,
          articles: news.items.slice(0, 10).map((n) => ({
            id: n.id,
            headline: n.headline,
            source: n.source,
            publishedAt: n.publishedAt,
            sentiment: n.sentiment,
            url: n.url,
          })),
        },
        provenance: {
          source: news.items[0]?.source ?? 'Finnhub',
          updatedAt: new Date().toISOString(),
        },
        evidenceSource: {
          id: `news-${sym}`,
          label: `${sym} News (${news.items.length} articles) · Finnhub`,
          type: 'news',
        },
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        provenance: {
          source: 'MarketService',
          updatedAt: new Date().toISOString(),
        },
      };
    }
  },
};

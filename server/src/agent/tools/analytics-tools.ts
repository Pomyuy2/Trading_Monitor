import { z } from 'zod/v4';
import type { PeriodFacts } from '@tm/shared';
import type { ToolDefinition, ToolResult } from '../types.js';
import {
  calculateFundamentalMetrics,
  type FundamentalMetrics,
  type PeriodFinancials,
} from '../../analytics/fundamentals.js';
import {
  calculateTechnicalSummary,
  type TechnicalSummary,
} from '../../analytics/technicals.js';
import {
  calculateDCF,
  calculateRelativeValuation,
  type DcfValuationSummary,
} from '../../analytics/valuation.js';
import {
  calculateStockRiskSummary,
  type StockRiskSummary,
} from '../../analytics/risk.js';

function cleanSymbol(sym: string): string {
  return sym.trim().toUpperCase();
}

function mapPeriodFactsToFinancials(facts?: PeriodFacts[]): PeriodFinancials[] {
  if (!facts) return [];
  return facts.map((a) => ({
    fiscalYear: a.fiscalYear,
    fiscalPeriod: a.fiscalPeriod,
    endDate: a.endDate,
    revenue: a.revenue,
    netIncome: a.netIncome,
    operatingIncome: a.operatingIncome,
    grossProfit: a.grossProfit,
    operatingCashFlow: a.operatingCashFlow,
    capitalExpenditures: a.capitalExpenditures,
    freeCashFlow: a.freeCashFlow ?? (a.operatingCashFlow != null ? a.operatingCashFlow - Math.abs(a.capitalExpenditures ?? 0) : null),
    totalAssets: a.assets,
    stockholdersEquity: a.equity,
    totalLiabilities: a.liabilities,
    sharesDiluted: a.sharesOutstanding,
    epsDiluted: a.epsDiluted,
    cashAndEquivalents: a.cashAndEquivalents,
    totalDebt: a.totalDebt,
  }));
}

/** 7. calculate_indicators */
export const calculateIndicatorsTool: ToolDefinition<{ symbol: string; range?: string }> = {
  name: 'calculate_indicators',
  description: 'Compute deterministic technical indicators from historical candles: SMA(20,50,200), EMA(12,26), RSI(14), MACD(12,26,9), Bollinger Bands, ATR(14), ADX(14), and Historical Volatility.',
  parameters: z.object({
    symbol: z.string().min(1).max(15).describe('Stock ticker symbol'),
    range: z.enum(['1M', '6M', '1Y', '5Y']).optional().default('1Y').describe('Chart range for calculations'),
  }),
  async execute({ symbol, range }, ctx): Promise<ToolResult<TechnicalSummary>> {
    const sym = cleanSymbol(symbol);
    const r = (range as any) || '1Y';
    try {
      const candlesResult = await ctx.market.candles(sym, r);
      const summary = calculateTechnicalSummary(candlesResult.candles);
      return {
        success: true,
        data: summary,
        provenance: {
          source: `Deterministic Analytics (${candlesResult.meta.source} data)`,
          updatedAt: new Date().toISOString(),
          warnings: summary.warnings,
        },
        evidenceSource: {
          id: `tech-${sym}`,
          label: `${sym} Technical Indicators (RSI ${summary.rsi14 ?? 'N/A'}, Trend: ${summary.trend})`,
          type: 'levels',
        },
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        provenance: {
          source: 'Deterministic Analytics',
          updatedAt: new Date().toISOString(),
        },
      };
    }
  },
};

/** 8. calculate_financial_ratios */
export const calculateFinancialRatiosTool: ToolDefinition<{ symbol: string }> = {
  name: 'calculate_financial_ratios',
  description: 'Compute fundamental ratios from SEC XBRL financial facts: YoY revenue/EPS growth, 3Y CAGR, Gross/Operating/Net margins, FCF, ROE, ROIC, Current Ratio, Quick Ratio, D/E, and Multiples.',
  parameters: z.object({
    symbol: z.string().min(1).max(15).describe('Stock ticker symbol'),
  }),
  async execute({ symbol }, ctx): Promise<ToolResult<FundamentalMetrics>> {
    const sym = cleanSymbol(symbol);
    try {
      const [facts, quote] = await Promise.all([
        ctx.market.companyFacts(sym),
        ctx.market.quote(sym).catch(() => null),
      ]);

      const annuals = mapPeriodFactsToFinancials(facts?.annual);
      const metrics = calculateFundamentalMetrics(annuals, quote?.marketCap, quote?.price);
      const latest = annuals[0];
      const periodLabel = latest?.fiscalYear ? `FY${latest.fiscalYear}` : 'Latest';

      return {
        success: true,
        data: metrics,
        provenance: {
          source: 'Deterministic Analytics (SEC EDGAR XBRL)',
          updatedAt: new Date().toISOString(),
          warnings: metrics.warnings,
        },
        evidenceSource: {
          id: `ratios-${sym}`,
          label: `${sym} ${periodLabel} Financial Ratios (Rev: $${latest?.revenue ? (latest.revenue / 1e9).toFixed(2) + 'B' : 'N/A'}, Rev Growth: ${metrics.revenueGrowthYoY != null ? +(metrics.revenueGrowthYoY * 100).toFixed(1) + '%' : 'N/A'}, Net Margin: ${metrics.netMargin != null ? +(metrics.netMargin * 100).toFixed(1) + '%' : 'N/A'}, P/S: ${metrics.psRatio != null ? metrics.psRatio.toFixed(1) + 'x' : 'N/A'})`,
          type: 'guidance',
        },
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        provenance: {
          source: 'Deterministic Analytics',
          updatedAt: new Date().toISOString(),
        },
      };
    }
  },
};

/** 9. calculate_valuation */
export const calculateValuationTool: ToolDefinition<{
  symbol: string;
  wacc?: number;
  growthRate5Y?: number;
  terminalGrowthRate?: number;
}> = {
  name: 'calculate_valuation',
  description: 'Perform deterministic Discounted Cash Flow (DCF) valuation with Bull/Base/Bear scenarios and WACC sensitivity table, plus relative valuation multiples comparison.',
  parameters: z.object({
    symbol: z.string().min(1).max(15).describe('Stock ticker symbol'),
    wacc: z.number().min(0.04).max(0.25).optional().describe('Discount rate (WACC), e.g. 0.09 for 9.0%'),
    growthRate5Y: z.number().min(-0.2).max(1.0).optional().describe('Projected 5-year FCF annual growth rate, e.g. 0.12 for 12%'),
    terminalGrowthRate: z.number().min(0.01).max(0.05).optional().describe('Terminal perpetual growth rate, e.g. 0.025 for 2.5%'),
  }),
  async execute({ symbol, wacc, growthRate5Y, terminalGrowthRate }, ctx): Promise<ToolResult<DcfValuationSummary>> {
    const sym = cleanSymbol(symbol);
    try {
      const [facts, quote] = await Promise.all([
        ctx.market.companyFacts(sym),
        ctx.market.quote(sym),
      ]);

      const currentPrice = quote.price ?? 100;
      const annuals = mapPeriodFactsToFinancials(facts?.annual);
      const latest = annuals[0] ?? {};

      // Estimate shares outstanding from marketCap / price or latest annuals
      const sharesOutstanding =
        (quote.marketCap && currentPrice > 0 ? quote.marketCap / currentPrice : undefined) ??
        latest.sharesDiluted ??
        1_000_000;

      // Base Free Cash Flow
      let baseFCF = 0;
      if (latest.freeCashFlow != null && Number.isFinite(latest.freeCashFlow)) {
        baseFCF = latest.freeCashFlow;
      } else if (latest.operatingCashFlow != null) {
        baseFCF = latest.operatingCashFlow - Math.abs(latest.capitalExpenditures ?? 0);
      } else if (latest.netIncome != null) {
        baseFCF = latest.netIncome * 0.9; // Approximate FCF
      }

      // Net Debt = Total Debt - Cash
      const netDebt = (latest.totalDebt ?? 0) - (latest.cashAndEquivalents ?? 0);

      const dcf = calculateDCF(currentPrice, baseFCF, sharesOutstanding, netDebt, {
        wacc,
        growthRate5Y,
        terminalGrowthRate,
      });

      const periodLabel = latest?.fiscalYear ? `FY${latest.fiscalYear}` : 'Latest';

      return {
        success: true,
        data: dcf,
        provenance: {
          source: 'Deterministic DCF Model (SEC EDGAR & Market Data)',
          updatedAt: new Date().toISOString(),
          warnings: dcf.warnings,
        },
        evidenceSource: {
          id: `val-${sym}`,
          label: `${sym} Valuation (${periodLabel} Base FCF: $${(baseFCF / 1e9).toFixed(2)}B, Base Fair Value: $${dcf.scenarios.base.fairValuePerShare ?? 'N/A'}, Current: $${currentPrice})`,
          type: 'general',
        },
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        provenance: {
          source: 'Deterministic Valuation',
          updatedAt: new Date().toISOString(),
        },
      };
    }
  },
};

/** 10. analyze_stock_risk */
export const analyzeStockRiskTool: ToolDefinition<{ symbol: string; benchmarkSymbol?: string }> = {
  name: 'analyze_stock_risk',
  description: 'Compute historical risk metrics: Beta against SPY, Annualized Volatility, Downside Volatility, Maximum Drawdown (peak/trough), and 1-day 95%/99% Historical VaR and Expected Shortfall.',
  parameters: z.object({
    symbol: z.string().min(1).max(15).describe('Stock ticker symbol'),
    benchmarkSymbol: z.string().min(1).max(15).optional().default('SPY').describe('Benchmark ticker symbol (default SPY)'),
  }),
  async execute({ symbol, benchmarkSymbol }, ctx): Promise<ToolResult<StockRiskSummary>> {
    const sym = cleanSymbol(symbol);
    const benchSym = cleanSymbol(benchmarkSymbol || 'SPY');
    try {
      const [assetCandles, benchCandles] = await Promise.all([
        ctx.market.candles(sym, '1Y'),
        ctx.market.candles(benchSym, '1Y').catch(() => null),
      ]);

      const assetCloses = assetCandles.candles.map((c) => c.close);
      const benchCloses = benchCandles?.candles?.map((c) => c.close) ?? [];

      const risk = calculateStockRiskSummary(assetCloses, benchCloses);

      return {
        success: true,
        data: risk,
        provenance: {
          source: `Deterministic Risk Engine (${assetCandles.meta.source} 1Y data)`,
          updatedAt: new Date().toISOString(),
          warnings: risk.warnings,
        },
        evidenceSource: {
          id: `risk-${sym}`,
          label: `${sym} Risk Metrics (Beta: ${risk.beta ?? 'N/A'}, Max DD: ${risk.maxDrawdown ? (risk.maxDrawdown.maxDrawdown * 100).toFixed(1) + '%' : 'N/A'}, Rating: ${risk.riskRating})`,
          type: 'levels',
        },
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        provenance: {
          source: 'Deterministic Risk Engine',
          updatedAt: new Date().toISOString(),
        },
      };
    }
  },
};

/** 11. compare_stocks */
export const compareStocksTool: ToolDefinition<{ symbols: string[] }> = {
  name: 'compare_stocks',
  description: 'Perform a comprehensive side-by-side comparison of 2 to 5 stocks across prices, valuation multiples, revenue/EPS growth, margins, technical trends, and risk ratings.',
  parameters: z.object({
    symbols: z.array(z.string().min(1).max(15)).min(2).max(5).describe('List of 2 to 5 stock ticker symbols to compare'),
  }),
  async execute({ symbols }, ctx): Promise<ToolResult<unknown>> {
    const syms = Array.from(new Set(symbols.map(cleanSymbol)));
    try {
      const comparisons = await Promise.all(
        syms.map(async (sym) => {
          const [quote, facts, candles] = await Promise.all([
            ctx.market.quote(sym, true).catch(() => null),
            ctx.market.companyFacts(sym).catch(() => null),
            ctx.market.candles(sym, '1Y').catch(() => null),
          ]);

          const annuals = mapPeriodFactsToFinancials(facts?.annual);
          const fundamentalMetrics = calculateFundamentalMetrics(annuals, quote?.marketCap, quote?.price);
          const technicalSummary = candles ? calculateTechnicalSummary(candles.candles) : null;
          const riskSummary = candles ? calculateStockRiskSummary(candles.candles.map((c) => c.close)) : null;

          return {
            symbol: sym,
            name: quote?.name ?? sym,
            price: quote?.price ?? null,
            marketCap: quote?.marketCap ?? null,
            changePct: quote?.changePct ?? null,
            peRatio: quote?.peTTM ?? fundamentalMetrics.peRatio,
            psRatio: fundamentalMetrics.psRatio,
            revenueGrowthYoY: fundamentalMetrics.revenueGrowthYoY,
            netMargin: fundamentalMetrics.netMargin,
            roe: fundamentalMetrics.roe,
            technicalTrend: technicalSummary?.trend ?? 'neutral',
            rsi14: technicalSummary?.rsi14 ?? null,
            beta: riskSummary?.beta ?? null,
            maxDrawdown: riskSummary?.maxDrawdown?.maxDrawdown ?? null,
            riskRating: riskSummary?.riskRating ?? 'moderate',
          };
        }),
      );

      return {
        success: true,
        data: comparisons,
        provenance: {
          source: 'Deterministic Multi-Stock Comparison Engine',
          updatedAt: new Date().toISOString(),
        },
        evidenceSource: {
          id: `compare-${syms.join('-')}`,
          label: `Comparison: ${syms.join(', ')}`,
          type: 'general',
        },
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        provenance: {
          source: 'Deterministic Multi-Stock Comparison Engine',
          updatedAt: new Date().toISOString(),
        },
      };
    }
  },
};

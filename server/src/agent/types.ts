import type { AskSource, Lang } from '@tm/shared';
import { z } from 'zod/v4';
import type { MarketService } from '../services/market-service.js';
import type { PortfolioService } from '../portfolio/portfolio-service.js';

export interface ToolProvenance {
  source: string; // e.g. 'Finnhub', 'Yahoo Finance', 'SEC EDGAR', 'Deterministic Analytics'
  updatedAt: string;
  latency?: string;
  feed?: string;
  warnings?: string[];
}

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  provenance: ToolProvenance;
  evidenceSource?: AskSource;
}

export interface AgentContext {
  userId: string;
  lang: Lang;
  market: MarketService;
  portfolio: PortfolioService;
  abortSignal?: AbortSignal;
}

export interface ToolDefinition<TArgs = any, TResult = any> {
  name: string;
  description: string;
  parameters: z.ZodType<TArgs>;
  execute(args: TArgs, ctx: AgentContext): Promise<ToolResult<TResult>>;
}

export interface ToolExecutionStep {
  tool: string;
  args: Record<string, unknown>;
  durationMs: number;
  success: boolean;
  summary: string;
  error?: string;
  evidenceSource?: AskSource;
  data?: any;
}

export type InvestmentVerdictCategory =
  | 'ATTRACTIVE_UNDER_ASSUMPTIONS'
  | 'NEUTRAL'
  | 'UNATTRACTIVE_UNDER_ASSUMPTIONS'
  | 'INSUFFICIENT_DATA';

export interface ValuationScenarioSummary {
  scenario: 'bull' | 'base' | 'bear';
  impliedFairValue: number | null;
  upsideDownsidePercent: number | null;
  keyAssumptions: string;
}

export interface InvestmentResearchReport {
  symbol?: string;
  title: string;
  horizon: 'short' | 'medium' | 'long';
  verdict: InvestmentVerdictCategory;
  summary: string;

  // Analysis Dimensions
  fundamentals?: {
    revenueGrowthYoY?: number | null;
    netMargin?: number | null;
    fcfMargin?: number | null;
    roe?: number | null;
    roic?: number | null;
    debtToEquity?: number | null;
    keyTakeaway: string;
  };

  technicals?: {
    currentPrice: number;
    trend: 'bullish' | 'bearish' | 'neutral';
    rsi14?: number | null;
    rsiCondition?: 'overbought' | 'oversold' | 'neutral';
    macdCondition?: string;
    supportPrice?: number | null;
    resistancePrice?: number | null;
    keyTakeaway: string;
  };

  valuationScenarios?: {
    currentPrice: number;
    baseFairValue: number | null;
    bull: ValuationScenarioSummary;
    base: ValuationScenarioSummary;
    bear: ValuationScenarioSummary;
    keyTakeaway: string;
  };

  riskAssessment?: {
    riskRating: 'low' | 'moderate' | 'high' | 'very_high';
    beta?: number | null;
    maxDrawdownPercent?: number | null;
    historicalVaR95?: number | null;
    downsideRisks: string[];
    thesisInvalidation: string[]; // Specific conditions that break the investment case
  };

  comparisons?: {
    peers: string[];
    comparisonSummary: string;
  };

  portfolioConsiderations?: {
    suitability: string;
    suggestedAllocationWeight?: string;
    rebalancingNotes?: string;
  };

  dataQuality: {
    freshnessWarning?: string;
    staleFeeds: string[];
    sources: AskSource[];
  };
}

export interface ResearchAgentResponse {
  answer: string;
  report?: InvestmentResearchReport | null;
  sources: AskSource[];
  toolSteps: ToolExecutionStep[];
  model: string;
  executionTimeMs: number;
  plan?: any;
  verification?: any;
  agentVersion?: 'v1' | 'v2' | 'v2.1' | 'v2.2';
}

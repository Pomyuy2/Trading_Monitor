import { z } from 'zod/v4';
import type { ToolDefinition, ToolResult } from '../types.js';

/** 12. get_user_portfolios */
export const getUserPortfoliosTool: ToolDefinition<Record<string, never>> = {
  name: 'get_user_portfolios',
  description: "Retrieve a list of the authenticated user's investment portfolios, including name, currency, and transaction counts.",
  parameters: z.object({}),
  async execute(_args, ctx): Promise<ToolResult<unknown>> {
    try {
      const portfolios = await ctx.portfolio.listPortfolios(ctx.userId);
      return {
        success: true,
        data: portfolios,
        provenance: {
          source: 'User Portfolio Ledger (SQLite)',
          updatedAt: new Date().toISOString(),
        },
        evidenceSource: {
          id: 'user-portfolios',
          label: `User Portfolios (${portfolios.length})`,
          type: 'general',
        },
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        provenance: {
          source: 'User Portfolio Ledger',
          updatedAt: new Date().toISOString(),
        },
      };
    }
  },
};

/** 13. get_portfolio_analysis */
export const getPortfolioAnalysisTool: ToolDefinition<{ portfolioId?: string }> = {
  name: 'get_portfolio_analysis',
  description: 'Analyze an authenticated user portfolio: total value, cash balance, active holdings with average cost basis, realized & unrealized P&L, allocation weights, and HHI concentration risk.',
  parameters: z.object({
    portfolioId: z.string().optional().describe('Specific portfolio ID. If omitted, analyzes the user’s primary/first portfolio.'),
  }),
  async execute({ portfolioId }, ctx): Promise<ToolResult<unknown>> {
    try {
      let targetId = portfolioId;
      if (!targetId) {
        const list = await ctx.portfolio.listPortfolios(ctx.userId);
        if (list.length === 0) {
          return {
            success: true,
            data: { message: 'User has no created portfolios yet.', holdings: [] },
            provenance: { source: 'Portfolio Ledger', updatedAt: new Date().toISOString() },
          };
        }
        targetId = list[0].id;
      }

      const priceLookup = async (symbol: string) => {
        const q = await ctx.market.quote(symbol).catch(() => null);
        return q?.price ?? null;
      };

      const summary = await ctx.portfolio.getPortfolioSummary(ctx.userId, targetId, priceLookup);
      return {
        success: true,
        data: summary,
        provenance: {
          source: 'Portfolio Ledger & Live Market Valuation',
          updatedAt: new Date().toISOString(),
          warnings: summary.warnings,
        },
        evidenceSource: {
          id: `portfolio-${targetId}`,
          label: `Portfolio: ${summary.name} (Value: $${summary.totalValue.toLocaleString()}, P&L: ${summary.totalUnrealizedPnLPercent}%)`,
          type: 'general',
        },
      };
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message,
        provenance: {
          source: 'Portfolio Ledger',
          updatedAt: new Date().toISOString(),
        },
      };
    }
  },
};

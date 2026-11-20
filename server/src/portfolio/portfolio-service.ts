import type { PrismaClient } from '@prisma/client';
import { calculateConcentrationRisk, calculateMaxDrawdown } from '../analytics/risk.js';

export type TransactionType = 'BUY' | 'SELL' | 'CASH_DEPOSIT' | 'CASH_WITHDRAWAL' | 'DIVIDEND' | 'FEE';

export interface NewTransactionInput {
  portfolioId: string;
  type: TransactionType;
  symbol?: string | null;
  quantity?: number;
  price?: number;
  fee?: number;
  timestamp?: Date | string;
  notes?: string;
}

export interface PositionHolding {
  symbol: string;
  quantity: number;
  averageCostBasis: number;
  totalCost: number;
  currentPrice: number | null;
  currentValue: number | null;
  unrealizedPnL: number | null;
  unrealizedPnLPercent: number | null;
  weight: number; // Decimal weight of total portfolio value
}

export interface PortfolioSummary {
  id: string;
  userId: string;
  name: string;
  currency: string;
  description?: string | null;
  cashBalance: number;
  investedValue: number;
  totalValue: number;
  totalCostBasis: number;
  totalUnrealizedPnL: number;
  totalUnrealizedPnLPercent: number;
  totalRealizedPnL: number;
  netDepositedCash: number;
  totalReturnPercent: number | null;
  holdings: PositionHolding[];
  concentration: {
    hhi: number;
    maxPositionWeight: number;
    top3Concentration: number;
    level: 'low' | 'moderate' | 'high';
  };
  warnings: string[];
}

export interface RebalanceTarget {
  symbol: string;
  targetWeight: number; // e.g. 0.25 for 25%
}

export interface RebalanceAction {
  symbol: string;
  currentWeight: number;
  targetWeight: number;
  action: 'BUY' | 'SELL' | 'HOLD';
  targetValue: number;
  diffValue: number;
  estimatedQuantityChange: number | null;
}

export interface UserProfileData {
  horizon: 'short' | 'medium' | 'long';
  riskTolerance: 'conservative' | 'moderate' | 'aggressive';
  liquidityNeeds: 'low' | 'medium' | 'high';
  lossCapacity: 'low' | 'moderate' | 'high';
}

export class PortfolioService {
  constructor(private readonly prisma: PrismaClient) {}

  /** List all portfolios owned by the specified user. */
  async listPortfolios(userId: string) {
    return this.prisma.portfolio.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: { transactions: true },
        },
      },
    });
  }

  /** Create a new portfolio for the user. */
  async createPortfolio(userId: string, name: string, currency = 'USD', description?: string) {
    return this.prisma.portfolio.create({
      data: {
        userId,
        name: name.trim(),
        currency: currency.toUpperCase(),
        description: description?.trim(),
      },
    });
  }

  /** Delete a portfolio owned by the user. */
  async deletePortfolio(userId: string, portfolioId: string): Promise<boolean> {
    const portfolio = await this.prisma.portfolio.findFirst({
      where: { id: portfolioId, userId },
    });
    if (!portfolio) return false;

    await this.prisma.portfolio.delete({ where: { id: portfolioId } });
    return true;
  }

  /** Record a transaction in a user's portfolio. */
  async addTransaction(userId: string, input: NewTransactionInput) {
    const portfolio = await this.prisma.portfolio.findFirst({
      where: { id: input.portfolioId, userId },
    });
    if (!portfolio) {
      throw new Error('Portfolio not found or access denied');
    }

    const qty = Math.max(0, input.quantity ?? 0);
    const price = Math.max(0, input.price ?? 0);
    const fee = Math.max(0, input.fee ?? 0);
    const sym = input.symbol ? input.symbol.trim().toUpperCase() : null;

    if ((input.type === 'BUY' || input.type === 'SELL') && (!sym || qty <= 0 || price <= 0)) {
      throw new Error('Buy/Sell transactions require valid symbol, quantity > 0, and price > 0');
    }

    return this.prisma.portfolioTransaction.create({
      data: {
        portfolioId: input.portfolioId,
        type: input.type,
        symbol: sym,
        quantity: qty,
        price,
        fee,
        timestamp: input.timestamp ? new Date(input.timestamp) : new Date(),
        notes: input.notes?.trim(),
      },
    });
  }

  /** List transactions for a user's portfolio. */
  async getTransactions(userId: string, portfolioId: string) {
    const portfolio = await this.prisma.portfolio.findFirst({
      where: { id: portfolioId, userId },
    });
    if (!portfolio) {
      throw new Error('Portfolio not found or access denied');
    }

    return this.prisma.portfolioTransaction.findMany({
      where: { portfolioId },
      orderBy: { timestamp: 'desc' },
    });
  }

  /**
   * Evaluates positions, cash balance, and P&L from transaction ledger using Average Cost Basis.
   * Resolves current market prices via optional price lookup callback.
   */
  async getPortfolioSummary(
    userId: string,
    portfolioId: string,
    priceLookup?: (symbol: string) => Promise<number | null>,
  ): Promise<PortfolioSummary> {
    const portfolio = await this.prisma.portfolio.findFirst({
      where: { id: portfolioId, userId },
    });
    if (!portfolio) {
      throw new Error('Portfolio not found or access denied');
    }

    const txs = await this.prisma.portfolioTransaction.findMany({
      where: { portfolioId },
      orderBy: { timestamp: 'asc' },
    });

    const warnings: string[] = [];
    let cashBalance = 0;
    let netDepositedCash = 0;
    let totalRealizedPnL = 0;

    // Track holdings by symbol
    interface InternalHolding {
      shares: number;
      totalCost: number; // shares * avgCostBasis
    }
    const holdingsMap = new Map<string, InternalHolding>();

    for (const tx of txs) {
      const sym = tx.symbol ?? '';
      switch (tx.type) {
        case 'CASH_DEPOSIT':
          cashBalance += tx.price;
          netDepositedCash += tx.price;
          break;

        case 'CASH_WITHDRAWAL':
          cashBalance -= tx.price;
          netDepositedCash -= tx.price;
          break;

        case 'DIVIDEND':
          cashBalance += tx.price;
          break;

        case 'FEE':
          cashBalance -= tx.fee || tx.price;
          break;

        case 'BUY': {
          const totalPaid = tx.quantity * tx.price + tx.fee;
          cashBalance -= totalPaid;
          const current = holdingsMap.get(sym) ?? { shares: 0, totalCost: 0 };
          const newShares = current.shares + tx.quantity;
          const newCost = current.totalCost + totalPaid;
          holdingsMap.set(sym, { shares: newShares, totalCost: newCost });
          break;
        }

        case 'SELL': {
          const totalProceeds = tx.quantity * tx.price - tx.fee;
          cashBalance += totalProceeds;
          const current = holdingsMap.get(sym) ?? { shares: 0, totalCost: 0 };

          if (current.shares < tx.quantity) {
            warnings.push(`Oversold ${sym}: sold ${tx.quantity} but held only ${current.shares}`);
          }

          const avgCost = current.shares > 0 ? current.totalCost / current.shares : 0;
          const costOfSharesSold = tx.quantity * avgCost;
          const realizedGain = totalProceeds - costOfSharesSold;
          totalRealizedPnL += realizedGain;

          const remainingShares = Math.max(0, current.shares - tx.quantity);
          const remainingCost = remainingShares > 0 ? remainingShares * avgCost : 0;
          holdingsMap.set(sym, { shares: remainingShares, totalCost: remainingCost });
          break;
        }
      }
    }

    // Filter to active positions (shares > 0)
    const activeSymbols = Array.from(holdingsMap.entries())
      .filter(([, h]) => h.shares > 0.0001)
      .map(([s]) => s);

    // Fetch market prices
    const prices = new Map<string, number | null>();
    if (priceLookup && activeSymbols.length > 0) {
      await Promise.all(
        activeSymbols.map(async (s) => {
          try {
            const p = await priceLookup(s);
            prices.set(s, p);
          } catch {
            prices.set(s, null);
          }
        }),
      );
    }

    let investedValue = 0;
    let totalCostBasis = 0;
    const positionList: PositionHolding[] = [];

    for (const sym of activeSymbols) {
      const h = holdingsMap.get(sym)!;
      const avgCostBasis = h.shares > 0 ? +(h.totalCost / h.shares).toFixed(4) : 0;
      const currentPrice = prices.get(sym) ?? null;

      let currentValue: number | null = null;
      let unrealizedPnL: number | null = null;
      let unrealizedPnLPercent: number | null = null;

      if (currentPrice != null) {
        currentValue = +(h.shares * currentPrice).toFixed(2);
        unrealizedPnL = +(currentValue - h.totalCost).toFixed(2);
        unrealizedPnLPercent = h.totalCost > 0 ? +((unrealizedPnL / h.totalCost) * 100).toFixed(2) : 0;
        investedValue += currentValue;
      } else {
        investedValue += h.totalCost; // Fallback to cost basis if price unavailable
        warnings.push(`Live price unavailable for ${sym}; using cost basis for valuation`);
      }

      totalCostBasis += h.totalCost;
      positionList.push({
        symbol: sym,
        quantity: +h.shares.toFixed(4),
        averageCostBasis: avgCostBasis,
        totalCost: +h.totalCost.toFixed(2),
        currentPrice,
        currentValue,
        unrealizedPnL,
        unrealizedPnLPercent,
        weight: 0, // Calculated below
      });
    }

    const totalValue = +(investedValue + cashBalance).toFixed(2);
    const totalUnrealizedPnL = +(investedValue - totalCostBasis).toFixed(2);
    const totalUnrealizedPnLPercent = totalCostBasis > 0 ? +((totalUnrealizedPnL / totalCostBasis) * 100).toFixed(2) : 0;
    const totalReturnPercent = netDepositedCash > 0 ? +(((totalValue - netDepositedCash) / netDepositedCash) * 100).toFixed(2) : null;

    // Calculate weights
    for (const pos of positionList) {
      const val = pos.currentValue ?? pos.totalCost;
      pos.weight = totalValue > 0 ? +(val / totalValue).toFixed(4) : 0;
    }

    // Concentration Risk
    const positionWeights = positionList.map((p) => p.weight);
    if (cashBalance > 0 && totalValue > 0) {
      positionWeights.push(+(cashBalance / totalValue).toFixed(4));
    }
    const concentration = calculateConcentrationRisk(positionWeights);

    return {
      id: portfolio.id,
      userId: portfolio.userId,
      name: portfolio.name,
      currency: portfolio.currency,
      description: portfolio.description,
      cashBalance: +cashBalance.toFixed(2),
      investedValue: +investedValue.toFixed(2),
      totalValue,
      totalCostBasis: +totalCostBasis.toFixed(2),
      totalUnrealizedPnL,
      totalUnrealizedPnLPercent,
      totalRealizedPnL: +totalRealizedPnL.toFixed(2),
      netDepositedCash: +netDepositedCash.toFixed(2),
      totalReturnPercent,
      holdings: positionList.sort((a, b) => (b.currentValue ?? 0) - (a.currentValue ?? 0)),
      concentration,
      warnings,
    };
  }

  /**
   * Rebalancing simulation: calculates the exact trades required to align portfolio to target weights.
   */
  async simulateRebalancing(
    userId: string,
    portfolioId: string,
    targets: RebalanceTarget[],
    priceLookup?: (symbol: string) => Promise<number | null>,
  ): Promise<{ totalValue: number; actions: RebalanceAction[]; warnings: string[] }> {
    const summary = await this.getPortfolioSummary(userId, portfolioId, priceLookup);
    const warnings = [...summary.warnings];

    const targetSum = targets.reduce((sum, t) => sum + t.targetWeight, 0);
    if (Math.abs(targetSum - 1.0) > 0.05) {
      warnings.push(`Target weights sum to ${(targetSum * 100).toFixed(1)}% instead of 100%`);
    }

    const currentHoldings = new Map(summary.holdings.map((h) => [h.symbol, h]));
    const allSymbols = Array.from(new Set([...targets.map((t) => t.symbol), ...summary.holdings.map((h) => h.symbol)]));

    const actions: RebalanceAction[] = [];

    for (const sym of allSymbols) {
      const holding = currentHoldings.get(sym);
      const target = targets.find((t) => t.symbol === sym);
      const currentWeight = holding?.weight ?? 0;
      const targetWeight = target?.targetWeight ?? 0;
      const currentVal = holding?.currentValue ?? (holding ? holding.totalCost : 0);
      const targetVal = +(summary.totalValue * targetWeight).toFixed(2);
      const diffVal = +(targetVal - currentVal).toFixed(2);

      let action: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
      if (diffVal > 25) action = 'BUY';
      else if (diffVal < -25) action = 'SELL';

      let estimatedQty: number | null = null;
      const price = holding?.currentPrice;
      if (price && price > 0) {
        estimatedQty = +(Math.abs(diffVal) / price).toFixed(4);
      }

      actions.push({
        symbol: sym,
        currentWeight,
        targetWeight,
        action,
        targetValue: targetVal,
        diffValue: diffVal,
        estimatedQuantityChange: estimatedQty,
      });
    }

    return {
      totalValue: summary.totalValue,
      actions: actions.sort((a, b) => Math.abs(b.diffValue) - Math.abs(a.diffValue)),
      warnings,
    };
  }

  /** Retrieve or create default user investment profile. */
  async getInvestmentProfile(userId: string): Promise<UserProfileData> {
    const p = await this.prisma.userInvestmentProfile.findUnique({
      where: { userId },
    });
    if (!p) {
      return {
        horizon: 'medium',
        riskTolerance: 'moderate',
        liquidityNeeds: 'medium',
        lossCapacity: 'moderate',
      };
    }
    return {
      horizon: p.horizon as any,
      riskTolerance: p.riskTolerance as any,
      liquidityNeeds: p.liquidityNeeds as any,
      lossCapacity: p.lossCapacity as any,
    };
  }

  /** Update user investment profile. */
  async updateInvestmentProfile(userId: string, data: Partial<UserProfileData>) {
    return this.prisma.userInvestmentProfile.upsert({
      where: { userId },
      create: {
        userId,
        horizon: data.horizon ?? 'medium',
        riskTolerance: data.riskTolerance ?? 'moderate',
        liquidityNeeds: data.liquidityNeeds ?? 'medium',
        lossCapacity: data.lossCapacity ?? 'moderate',
      },
      update: {
        ...(data.horizon ? { horizon: data.horizon } : {}),
        ...(data.riskTolerance ? { riskTolerance: data.riskTolerance } : {}),
        ...(data.liquidityNeeds ? { liquidityNeeds: data.liquidityNeeds } : {}),
        ...(data.lossCapacity ? { lossCapacity: data.lossCapacity } : {}),
      },
    });
  }
}

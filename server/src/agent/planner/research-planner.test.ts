import { describe, expect, it } from 'vitest';
import { ResearchPlanner } from './research-planner.js';

describe('ResearchPlanner', () => {
  const planner = new ResearchPlanner();

  describe('shouldPlan (Fast-Path Heuristics)', () => {
    it('returns false for simple price/quote lookups', () => {
      expect(planner.shouldPlan('what is the price of AAPL?')).toBe(false);
      expect(planner.shouldPlan('quote TSLA')).toBe(false);
      expect(planner.shouldPlan('how much is NVDA trading at?')).toBe(false);
      expect(planner.shouldPlan('price MSFT')).toBe(false);
    });

    it('returns false for simple concept definitions without a specific stock', () => {
      expect(planner.shouldPlan('what is DCF?')).toBe(false);
      expect(planner.shouldPlan('explain RSI')).toBe(false);
      expect(planner.shouldPlan('what does P/E ratio mean?')).toBe(false);
    });

    it('returns false for conversational greetings', () => {
      expect(planner.shouldPlan('hello')).toBe(false);
      expect(planner.shouldPlan('who are you')).toBe(false);
      expect(planner.shouldPlan('thanks!')).toBe(false);
    });

    it('returns true for deep equity research queries', () => {
      expect(planner.shouldPlan('analyze NVDA financial performance and valuation')).toBe(true);
      expect(planner.shouldPlan('is TSLA attractive under DCF assumptions?')).toBe(true);
      expect(planner.shouldPlan('what are the main risk factors disclosed in Apple 10-K?')).toBe(true);
    });

    it('returns true for multi-stock comparisons', () => {
      expect(planner.shouldPlan('compare AAPL and MSFT')).toBe(true);
      expect(planner.shouldPlan('NVDA vs AMD Data Center growth')).toBe(true);
    });

    it('returns true for historical cutoff queries', () => {
      expect(planner.shouldPlan('What was NVDA revenue in fiscal 2024?')).toBe(true);
      expect(planner.shouldPlan('disclosed risks as of 2024-03-01 for TSLA')).toBe(true);
    });
  });

  describe('extractSymbols & Cutoff', () => {
    it('extracts multiple uppercase symbols and well-known company names', () => {
      expect(planner.extractSymbols('compare Apple and Microsoft')).toEqual(['AAPL', 'MSFT']);
      expect(planner.extractSymbols('NVDA vs AMD')).toEqual(['NVDA', 'AMD']);
      expect(planner.extractSymbols('What is Tesla guidance?')).toEqual(['TSLA']);
    });

    it('extracts historical cutoff dates', () => {
      expect(planner.extractHistoricalCutoff('Disclosed risks as of 2024-03-01 for TSLA')).toBe('2024-03-01');
      expect(planner.extractHistoricalCutoff('What was revenue before 2024-01-01?')).toBe('2024-01-01');
      expect(planner.extractHistoricalCutoff('In fiscal 2023 what was net income?')).toBe('2023-12-31');
    });
  });

  describe('plan generation', () => {
    it('creates a bounded typed ResearchPlan for single stock', async () => {
      const plan = await planner.plan('Analyze NVDA revenue drivers, DCF valuation and Item 1A risks');
      expect(plan.complexity).toBe('deep');
      expect(plan.targetCompanies).toContain('NVDA');
      expect(plan.tasks.length).toBeGreaterThanOrEqual(3);
      expect(plan.tasks.length).toBeLessThanOrEqual(6);
      expect(plan.tasks.some((t) => t.category === 'sec_filings')).toBe(true);
      expect(plan.tasks.some((t) => t.category === 'fundamentals')).toBe(true);
      expect(plan.tasks.some((t) => t.category === 'valuation')).toBe(true);
    });

    it('creates balanced tasks for multi-stock comparisons', async () => {
      const plan = await planner.plan('Compare AAPL and MSFT profitability and cloud growth');
      expect(plan.complexity).toBe('deep');
      expect(plan.targetCompanies).toContain('AAPL');
      expect(plan.targetCompanies).toContain('MSFT');
      expect(plan.tasks.some((t) => t.targetSymbol === 'AAPL')).toBe(true);
      expect(plan.tasks.some((t) => t.targetSymbol === 'MSFT')).toBe(true);
      expect(plan.tasks.some((t) => t.category === 'comparison')).toBe(true);
    });
  });
});

import { z } from 'zod/v4';

export type ResearchComplexity = 'simple' | 'moderate' | 'deep';

export interface ValuationAssumptions {
  wacc?: number;
  growthRate5Y?: number;
  terminalGrowthRate?: number;
  discountRate?: number;
  notes?: string;
}

export type ResearchTaskCategory =
  | 'sec_filings'
  | 'fundamentals'
  | 'valuation'
  | 'technicals'
  | 'risks'
  | 'comparison'
  | 'macro_general';

export type ResearchTaskPriority = 'high' | 'medium' | 'low';
export type ResearchTaskStatus = 'pending' | 'in_progress' | 'completed' | 'skipped' | 'failed';

export interface ResearchTask {
  id: string;
  description: string;
  priority: ResearchTaskPriority;
  category: ResearchTaskCategory;
  targetSymbol?: string;
  toolHint?: string;
  status: ResearchTaskStatus;
  resultSummary?: string;
}

export interface ResearchPlan {
  planId: string;
  query: string;
  complexity: ResearchComplexity;
  targetCompanies: string[];
  researchObjectives: string[];
  requiredFinancialMetrics: string[];
  requiredSecEvidence: string[];
  riskFactorsToInvestigate: string[];
  valuationAssumptions?: ValuationAssumptions;
  historicalTimeCutoff?: string; // YYYY-MM-DD
  missingOrUncertainInputs: string[];
  tasks: ResearchTask[];
  createdAt: string;
}

export const ValuationAssumptionsSchema = z.object({
  wacc: z.number().min(0.01).max(0.3).optional(),
  growthRate5Y: z.number().min(-0.5).max(1.5).optional(),
  terminalGrowthRate: z.number().min(0.005).max(0.08).optional(),
  discountRate: z.number().min(0.01).max(0.3).optional(),
  notes: z.string().max(500).optional(),
});

export const ResearchTaskSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(3).max(300),
  priority: z.enum(['high', 'medium', 'low']),
  category: z.enum([
    'sec_filings',
    'fundamentals',
    'valuation',
    'technicals',
    'risks',
    'comparison',
    'macro_general',
  ]),
  targetSymbol: z.string().max(15).optional(),
  toolHint: z.string().max(60).optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'skipped', 'failed']).default('pending'),
  resultSummary: z.string().max(1000).optional(),
});

export const ResearchPlanSchema = z.object({
  planId: z.string().min(1),
  query: z.string().min(1),
  complexity: z.enum(['simple', 'moderate', 'deep']),
  targetCompanies: z.array(z.string().min(1).max(15)).max(10),
  researchObjectives: z.array(z.string().min(2).max(300)).max(10),
  requiredFinancialMetrics: z.array(z.string().min(1).max(100)).max(20),
  requiredSecEvidence: z.array(z.string().min(1).max(100)).max(20),
  riskFactorsToInvestigate: z.array(z.string().min(1).max(300)).max(10),
  valuationAssumptions: ValuationAssumptionsSchema.optional(),
  historicalTimeCutoff: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  missingOrUncertainInputs: z.array(z.string().max(300)).max(10),
  tasks: z.array(ResearchTaskSchema).max(10),
  createdAt: z.string(),
});

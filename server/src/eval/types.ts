export type BenchmarkCategory =
  | 'financial_statement_interpretation'
  | 'mda_analysis'
  | 'business_strategy'
  | 'risk_factor_identification'
  | 'historical_filing_comparison'
  | 'revenue_profitability_drivers'
  | 'guidance_consistency'
  | 'valuation_assumption_support'
  | 'cross_company_comparison'
  | 'unsupported_abstention'
  | 'deep_research_planning'
  | 'contradiction_detection'
  | 'evidence_support_verification';

export interface ExpectedDocument {
  symbol: string;
  form: '10-K' | '10-Q';
  reportPeriod?: string;
  filingDate?: string;
  accessionNumber?: string;
}

export interface ExpectedNumericalFact {
  metric: string;
  value: number | string;
  unit?: string;
  tolerancePercent?: number;
}

export interface BenchmarkQuestion {
  id: string; // e.g. "Q01", "Q02"
  category: BenchmarkCategory;
  question: string;
  symbols: string[];
  expectedDocuments: ExpectedDocument[];
  expectedSections: string[];
  expectedPassageKeywords: string[];
  requiredFactualClaims: string[];
  requiredNumericalValues?: ExpectedNumericalFact[];
  expectAbstention: boolean;
  historicalCutoff?: string; // If set, any filing after this date must NOT be used
  split: 'eval_frozen' | 'dev_tuning';
}

export interface RetrievalMetrics {
  recallAt3: number;
  recallAt5: number;
  mrr: number; // Mean Reciprocal Rank
  avgPrecision: number;
}

export interface QuestionEvaluationResult {
  questionId: string;
  category: BenchmarkCategory;
  agentVersion: 'v1' | 'v2' | 'v2.1' | 'v2.2';
  success: boolean;
  answer: string;
  executionTimeMs: number;
  toolCallCount: number;
  toolsUsed: string[];
  tokenEstimate: number;
  retrieval?: {
    chunksRetrieved: number;
    topChunkCitationId?: string;
    recallAt3: boolean;
    recallAt5: boolean;
    reciprocalRank: number;
  };
  plan?: any;
  verification?: any;
  evaluation: {
    factualCorrectnessScore: number; // 0.0 - 1.0
    numericalCorrectnessScore?: number; // 0.0 - 1.0
    citationFaithfulnessScore: number; // 0.0 - 1.0
    unsupportedClaimRate: number; // 0.0 - 1.0 (lower is better)
    historicalCutoffCompliant: boolean;
    abstentionCorrect: boolean;
    contradictionDetected?: boolean;
    reasoningNotes: string;
  };
}

export interface BenchmarkAggregateResults {
  agentVersion: 'v1' | 'v2' | 'v2.1' | 'v2.2';
  totalQuestions: number;
  byCategory: Record<
    BenchmarkCategory,
    {
      count: number;
      avgFactualScore: number;
      avgCitationFaithfulness: number;
      avgLatencyMs: number;
      avgToolCalls: number;
      abstentionAccuracy: number;
      cutoffCompliance: number;
    }
  >;
  overall: {
    retrievalRecallAt1?: number;
    retrievalRecallAt3?: number;
    retrievalRecallAt5?: number;
    mrr?: number;
    avgFactualCorrectness: number;
    avgCitationFaithfulness: number;
    avgUnsupportedClaimRate: number;
    historicalCutoffComplianceRate: number;
    appropriateAbstentionRate: number;
    abstentionAccuracyRate?: number;
    avgLatencyMs: number;
    p50LatencyMs?: number;
    p90LatencyMs?: number;
    avgTokens?: number;
    avgToolCalls: number;
    avgToolCallsPerQuery?: number;
    totalTokensConsumed?: number;
  };
}

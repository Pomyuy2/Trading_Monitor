import {
  type ResearchComplexity,
  type ResearchPlan,
  type ResearchTask,
  type ValuationAssumptions,
  ResearchPlanSchema,
} from './plan-types.js';

const COMMON_NON_TICKER_WORDS = new Set([
  'A', 'AN', 'THE', 'AND', 'OR', 'BUT', 'IF', 'FOR', 'NOR', 'ON', 'AT', 'TO', 'BY', 'OF',
  'IN', 'IS', 'AM', 'ARE', 'WAS', 'WERE', 'BE', 'BEEN', 'BEING', 'HAVE', 'HAS', 'HAD',
  'DO', 'DOES', 'DID', 'WILL', 'WOULD', 'SHALL', 'SHOULD', 'MAY', 'MIGHT', 'MUST', 'CAN',
  'COULD', 'NOT', 'NO', 'SO', 'UP', 'OUT', 'ALL', 'ANY', 'EACH', 'FEW', 'MORE', 'MOST',
  'OTHER', 'SOME', 'SUCH', 'THAT', 'THIS', 'THESE', 'THOSE', 'WHAT', 'WHICH', 'WHO',
  'WHOM', 'HOW', 'WHY', 'WHEN', 'WHERE', 'RSI', 'MACD', 'DCF', 'PE', 'EPS', 'SEC', 'CAGR',
  'ROE', 'ROIC', 'WACC', 'USD', 'EBITDA', 'FCF', 'FY', 'Q1', 'Q2', 'Q3', 'Q4', 'ITEM',
  'VS', 'AI', 'CEO', 'CFO', 'CTO', 'USA', 'US', 'UK', 'EU', 'IPO',
]);

const SIMPLE_PATTERNS = [
  /^(?:what is|what's|how much is|get|check|show)\s+(?:the\s+)?(?:current\s+)?(?:price|quote|stock price)\s+(?:for|of)?\s*([a-zA-Z]{1,5})\??$/i,
  /^(?:how much is|what is)\s+([a-zA-Z]{1,5})\s+trading at\??$/i,
  /^(?:quote|price)\s+([a-zA-Z]{1,5})\??$/i,
  /^(?:what is|what's|explain|define|tell me about)\s+(?:a\s+|an\s+|the\s+)?(dcf|pe ratio|p\/e|rsi|macd|wacc|beta|ebitda|fcf|market cap|var)\??$/i,
  /^(?:what does|what do)\s+(?:a\s+|an\s+|the\s+)?([a-zA-Z0-9\/\s\-]+?)\s+mean\??$/i,
  /^(?:hello|hi|hey|thanks|thank you|good morning|who are you)\b/i,
  /^(?:show|view|check|what is in)\s+my\s+portfolio\??$/i,
];

export class ResearchPlanner {
  constructor(
    private readonly baseUrl?: string,
    private readonly apiKey?: string,
    private readonly model?: string,
  ) {}

  /**
   * Fast-path check: returns false if the query is a simple factual/quote request
   * that does not require multi-step bounded research planning.
   */
  shouldPlan(question: string, targetSymbol?: string, contextMode: string = 'global'): boolean {
    const trimmed = question.trim();
    if (!trimmed) return false;

    // Check against simple regex patterns
    for (const pattern of SIMPLE_PATTERNS) {
      if (pattern.test(trimmed)) {
        return false;
      }
    }

    // Short definitions without symbols
    const lower = trimmed.toLowerCase();
    if (
      (lower.startsWith('what is ') || lower.startsWith("what's ") || lower.startsWith('explain ')) &&
      (lower.includes('formula') || lower.includes('definition') || lower.includes('concept') || lower.includes('how to calculate')) &&
      !this.extractSymbols(trimmed, targetSymbol).length
    ) {
      return false;
    }

    // Global queries without symbols and asking generic questions
    if (contextMode === 'global' && !targetSymbol && !this.extractSymbols(trimmed).length) {
      const isMacroOrEducational =
        lower.includes('how does ') ||
        lower.includes('what is the difference between ') ||
        lower.includes('explain ');
      if (isMacroOrEducational && !lower.includes('10-k') && !lower.includes('sec')) {
        return false;
      }
    }

    // Default: complex analytical questions require planning
    return true;
  }

  /**
   * Generates a typed, bounded ResearchPlan for a complex investment research question.
   */
  async plan(
    question: string,
    targetSymbol?: string,
    contextMode: string = 'global',
    userProfile?: any,
  ): Promise<ResearchPlan> {
    const symbols = this.extractSymbols(question, targetSymbol);
    const cutoff = this.extractHistoricalCutoff(question);
    const complexity = this.determineComplexity(question, symbols);
    const planId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const objectives = this.extractObjectives(question, symbols);
    const requiredMetrics = this.determineRequiredMetrics(question, complexity);
    const requiredSecEvidence = this.determineRequiredSecEvidence(question, cutoff);
    const riskFactors = this.determineRiskFactors(question, symbols);
    const valuationAssumptions = this.determineValuationAssumptions(question, userProfile);
    const missingInputs = this.determineMissingInputs(symbols, question);

    const tasks = this.buildTasks(
      question,
      symbols,
      complexity,
      cutoff,
      objectives,
      valuationAssumptions,
    );

    const plan: ResearchPlan = {
      planId,
      query: question,
      complexity,
      targetCompanies: symbols,
      researchObjectives: objectives,
      requiredFinancialMetrics: requiredMetrics,
      requiredSecEvidence,
      riskFactorsToInvestigate: riskFactors,
      valuationAssumptions,
      historicalTimeCutoff: cutoff,
      missingOrUncertainInputs: missingInputs,
      tasks,
      createdAt: new Date().toISOString(),
    };

    return ResearchPlanSchema.parse(plan);
  }

  /**
   * Extracts uppercase stock symbols from question, filtered by exclusions.
   */
  extractSymbols(question: string, targetSymbol?: string): string[] {
    const symbols = new Set<string>();
    if (targetSymbol && /^[A-Z0-9.\-]{1,10}$/i.test(targetSymbol)) {
      symbols.add(targetSymbol.toUpperCase());
    }

    // Look for explicit ticker symbols in text
    const matches = question.match(/\b[A-Za-z]{1,5}\b/g) || [];
    for (const match of matches) {
      const upper = match.toUpperCase();
      if (!COMMON_NON_TICKER_WORDS.has(upper) && upper.length >= 2 && upper === match) {
        // Upper case word matching a known or plausible ticker
        symbols.add(upper);
      }
    }

    // Well-known company names mapping to tickers
    const nameMap: Record<string, string> = {
      nvidia: 'NVDA',
      apple: 'AAPL',
      microsoft: 'MSFT',
      amazon: 'AMZN',
      tesla: 'TSLA',
      alphabet: 'GOOGL',
      google: 'GOOGL',
      meta: 'META',
      amd: 'AMD',
      intel: 'INTC',
      broadcom: 'AVGO',
      qualcomm: 'QCOM',
      micron: 'MU',
      taiwan: 'TSM',
      tsmc: 'TSM',
    };

    const lowerQ = question.toLowerCase();
    for (const [name, sym] of Object.entries(nameMap)) {
      const regex = new RegExp(`\\b${name}\\b`, 'i');
      if (regex.test(lowerQ)) {
        symbols.add(sym);
      }
    }

    return Array.from(symbols);
  }

  /**
   * Extracts historical cutoff date (YYYY-MM-DD) if user asked about a past period.
   */
  extractHistoricalCutoff(question: string): string | undefined {
    // 1. Direct YYYY-MM-DD with cutoff keywords
    const directDateMatch = question.match(
      /(?:as of|before|prior to|up to|through|until|ended|ending)\s+(\d{4}-\d{2}-\d{2})/i,
    );
    if (directDateMatch) {
      return directDateMatch[1];
    }

    // 2. Fiscal year mentions (e.g. "as of FY2024", "in fiscal 2023", "before 2025")
    const fyMatch = question.match(/(?:as of|in|for)?\s*(?:FY|fiscal\s*)(\d{4})/i);
    if (fyMatch) {
      const year = parseInt(fyMatch[1], 10);
      return `${year}-12-31`;
    }

    // 3. Before YYYY
    const beforeYearMatch = question.match(/(?:before|prior to)\s+(\d{4})/i);
    if (beforeYearMatch) {
      const year = parseInt(beforeYearMatch[1], 10);
      return `${year}-01-01`;
    }

    return undefined;
  }

  private determineComplexity(question: string, symbols: string[]): ResearchComplexity {
    const lower = question.toLowerCase();
    if (symbols.length > 1 || lower.includes('compare') || lower.includes('versus') || lower.includes(' vs ')) {
      return 'deep';
    }

    if (
      lower.includes('comprehensive') ||
      lower.includes('deep research') ||
      lower.includes('investment thesis') ||
      lower.includes('full analysis') ||
      lower.includes('valuation and risk') ||
      (lower.includes('valuation') && (lower.includes('10-k') || lower.includes('sec') || lower.includes('revenue') || lower.includes('risk') || lower.includes('item'))) ||
      (lower.includes('revenue') && (lower.includes('risk') || lower.includes('driver')))
    ) {
      return 'deep';
    }

    return 'moderate';
  }

  private extractObjectives(question: string, symbols: string[]): string[] {
    const objectives: string[] = [];
    const lower = question.toLowerCase();

    if (symbols.length > 1) {
      objectives.push(`Compare financial performance, valuation, and competitive advantage across ${symbols.join(', ')}`);
    } else if (symbols.length === 1) {
      objectives.push(`Analyze fundamental health, growth catalysts, and valuation for ${symbols[0]}`);
    } else {
      objectives.push('Investigate financial concepts and provide evidence-grounded research');
    }

    if (lower.includes('valuation') || lower.includes('fair value') || lower.includes('dcf') || lower.includes('target price')) {
      objectives.push('Model intrinsic fair value using Discounted Cash Flow and valuation multiples');
    }

    if (lower.includes('sec') || lower.includes('10-k') || lower.includes('10-q') || lower.includes('filing') || lower.includes('segment')) {
      objectives.push('Retrieve and ground findings in official SEC periodic report disclosures (Business, MD&A, Financial Notes)');
    }

    if (lower.includes('risk') || lower.includes('downside') || lower.includes('threat') || lower.includes('invalidation')) {
      objectives.push('Identify material business and financial risks and define explicit thesis invalidation conditions');
    }

    return objectives;
  }

  private determineRequiredMetrics(question: string, complexity: ResearchComplexity): string[] {
    const metrics = ['revenueGrowthYoY', 'netMargin', 'peRatio'];
    const lower = question.toLowerCase();

    if (complexity === 'deep' || lower.includes('cash flow') || lower.includes('fcf') || lower.includes('valuation')) {
      metrics.push('freeCashFlow', 'operatingCashFlow', 'dcfFairValue');
    }

    if (complexity === 'deep' || lower.includes('debt') || lower.includes('balance sheet') || lower.includes('solvency')) {
      metrics.push('debtToEquity', 'currentRatio', 'roe', 'roic');
    }

    if (lower.includes('technical') || lower.includes('chart') || lower.includes('momentum') || lower.includes('rsi')) {
      metrics.push('rsi14', 'sma200', 'macdCondition');
    }

    return metrics;
  }

  private determineRequiredSecEvidence(question: string, cutoff?: string): string[] {
    const sec: string[] = [];
    const lower = question.toLowerCase();

    if (lower.includes('risk') || lower.includes('threat')) {
      sec.push('10-K ITEM_1A (Risk Factors)');
    }
    if (lower.includes('segment') || lower.includes('revenue') || lower.includes('growth') || lower.includes('mda') || lower.includes('md&a')) {
      sec.push('10-K ITEM_7 (MD&A)');
    }
    if (lower.includes('balance sheet') || lower.includes('debt') || lower.includes('accounting') || lower.includes('financial')) {
      sec.push('10-K ITEM_8 (Financial Statements & Notes)');
    }
    if (lower.includes('business') || lower.includes('product') || lower.includes('competition') || lower.includes('strategy')) {
      sec.push('10-K ITEM_1 (Business Overview)');
    }

    if (sec.length === 0) {
      sec.push('10-K ITEM_7 (MD&A)', '10-K ITEM_1 (Business)');
    }

    if (cutoff) {
      sec.push(`Filings accepted on or before ${cutoff}`);
    }

    return sec;
  }

  private determineRiskFactors(question: string, symbols: string[]): string[] {
    return [
      'Customer and supplier concentration risk',
      'Macroeconomic and interest rate sensitivity',
      'Competitive threats and technological displacement',
      'Regulatory scrutiny and export control restrictions',
    ];
  }

  private determineValuationAssumptions(question: string, userProfile?: any): ValuationAssumptions {
    const riskTolerance = userProfile?.riskTolerance ?? 'moderate';
    let baseWacc = 0.09; // 9.0% default
    if (riskTolerance === 'conservative') baseWacc = 0.105;
    if (riskTolerance === 'aggressive') baseWacc = 0.085;

    return {
      wacc: baseWacc,
      growthRate5Y: 0.12, // 12% 5Y base
      terminalGrowthRate: 0.025, // 2.5% perpetual
      notes: 'Standard institutional DCF base assumptions calibrated by risk tolerance',
    };
  }

  private determineMissingInputs(symbols: string[], question: string): string[] {
    const missing: string[] = [];
    if (symbols.length === 0) {
      missing.push('Target ticker symbol not explicitly specified in prompt');
    }
    const lower = question.toLowerCase();
    if (lower.includes('guidance') && !lower.includes('8-k')) {
      missing.push('Intra-quarter forward guidance may require recent 8-K disclosures beyond 10-K/10-Q');
    }
    return missing;
  }

  private buildTasks(
    question: string,
    symbols: string[],
    complexity: ResearchComplexity,
    cutoff: string | undefined,
    objectives: string[],
    assumptions: ValuationAssumptions,
  ): ResearchTask[] {
    const tasks: ResearchTask[] = [];
    let taskId = 1;

    // Multi-stock scenario
    if (symbols.length > 1) {
      for (const sym of symbols) {
        tasks.push({
          id: `task-${taskId++}`,
          description: `Verify SEC document coverage and retrieve business & financial drivers for ${sym}${cutoff ? ` as of ${cutoff}` : ''}`,
          priority: 'high',
          category: 'sec_filings',
          targetSymbol: sym,
          toolHint: 'search_financial_documents',
          status: 'pending',
        });
        tasks.push({
          id: `task-${taskId++}`,
          description: `Fetch fundamental metrics, growth rates, and financial ratios for ${sym}`,
          priority: 'high',
          category: 'fundamentals',
          targetSymbol: sym,
          toolHint: 'calculate_financial_ratios',
          status: 'pending',
        });
      }
      tasks.push({
        id: `task-${taskId++}`,
        description: `Perform comparative valuation and peer benchmarking across ${symbols.join(', ')}`,
        priority: 'medium',
        category: 'comparison',
        toolHint: 'compare_stocks',
        status: 'pending',
      });
      return tasks.slice(0, 7); // Bound to max 7 tasks
    }

    // Single-stock or global scenario
    const primarySymbol = symbols[0];

    // Task 1: SEC Evidence
    tasks.push({
      id: `task-${taskId++}`,
      description: primarySymbol
        ? `Retrieve official SEC 10-K/10-Q disclosures for ${primarySymbol}${cutoff ? ` before ${cutoff}` : ''}`
        : 'Search official SEC financial documents for query topic',
      priority: 'high',
      category: 'sec_filings',
      targetSymbol: primarySymbol,
      toolHint: 'search_financial_documents',
      status: 'pending',
    });

    // Task 2: Fundamentals & Financial Ratios
    if (primarySymbol) {
      tasks.push({
        id: `task-${taskId++}`,
        description: `Compute audited fundamental ratios, margins, and cash flow for ${primarySymbol}`,
        priority: 'high',
        category: 'fundamentals',
        targetSymbol: primarySymbol,
        toolHint: 'calculate_financial_ratios',
        status: 'pending',
      });
    }

    // Task 3: Valuation Modeling
    if (primarySymbol && (complexity === 'deep' || question.toLowerCase().includes('valuation') || question.toLowerCase().includes('fair value') || question.toLowerCase().includes('dcf'))) {
      tasks.push({
        id: `task-${taskId++}`,
        description: `Execute DCF valuation model with Bull/Base/Bear scenarios (WACC: ${((assumptions.wacc ?? 0.09) * 100).toFixed(1)}%) for ${primarySymbol}`,
        priority: 'medium',
        category: 'valuation',
        targetSymbol: primarySymbol,
        toolHint: 'calculate_valuation',
        status: 'pending',
      });
    }

    // Task 4: Risk Factors & Thesis Invalidation
    if (primarySymbol) {
      tasks.push({
        id: `task-${taskId++}`,
        description: `Investigate SEC Item 1A Risk Factors and analyze statistical volatility & drawdown for ${primarySymbol}`,
        priority: 'medium',
        category: 'risks',
        targetSymbol: primarySymbol,
        toolHint: 'analyze_stock_risk',
        status: 'pending',
      });
    }

    // Task 5: Technical Context (if deep or explicitly asked)
    if (primarySymbol && (complexity === 'deep' || question.toLowerCase().includes('technical') || question.toLowerCase().includes('trend') || question.toLowerCase().includes('rsi'))) {
      tasks.push({
        id: `task-${taskId++}`,
        description: `Analyze technical indicator regime (SMA 20/50/200, RSI, MACD) for ${primarySymbol}`,
        priority: 'low',
        category: 'technicals',
        targetSymbol: primarySymbol,
        toolHint: 'calculate_indicators',
        status: 'pending',
      });
    }

    return tasks.slice(0, 6); // Bounded to max 6 tasks
  }
}

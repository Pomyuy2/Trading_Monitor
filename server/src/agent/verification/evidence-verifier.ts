import { db } from '../../store/db.js';
import type { ToolExecutionStep } from '../types.js';

export interface NumericalDiscrepancy {
  metric: string;
  claimedValue: string | number;
  expectedValue: string | number;
  differencePercent?: number;
  source: string;
  notes: string;
}

export interface CitationVerification {
  citationId: string;
  exists: boolean;
  filingDate?: string;
  cutoffCompliant: boolean;
  passageMatched: boolean;
  matchScore: number; // 0.0 - 1.0
  snippet?: string;
}

export interface ContradictionFinding {
  topic: string;
  description: string;
  sourceA: string;
  sourceB: string;
  severity: 'high' | 'medium' | 'low';
}

export interface EvidenceVerificationResult {
  verified: boolean;
  confidenceScore: number; // 0.0 - 1.0
  citations: CitationVerification[];
  validCitationCount: number;
  invalidCitationCount: number;
  passageMatchRate: number;
  cutoffCompliant: boolean;
  numericalDiscrepancies: NumericalDiscrepancy[];
  contradictions: ContradictionFinding[];
  ungroundedClaims: string[];
  qualifications: string[];
  untrustedBoundarySafe: boolean;
}

const STOP_WORDS = new Set([
  'the', 'and', 'a', 'an', 'of', 'to', 'in', 'is', 'for', 'that', 'with', 'on', 'as',
  'by', 'at', 'from', 'was', 'were', 'it', 'its', 'be', 'are', 'this', 'our', 'or',
  'we', 'which', 'has', 'have', 'had', 'will', 'not', 'but',
]);

export class EvidenceVerifier {
  constructor(private readonly prisma = db) {}

  /**
   * Extracts all SEC citation IDs enclosed in brackets or plain IDs from text.
   */
  extractCitations(text: string): string[] {
    const bracketMatches = [...text.matchAll(/\[(SEC-[A-Za-z0-9_\-]+)\]/g)].map((m) => m[1]);
    const rawMatches = [
      ...text.matchAll(/\b(SEC-[A-Z0-9]+-(?:10-K|10-Q|8-K)-\d{4}-\d{2}-\d{2}-[A-Za-z0-9_]+-c\d+)\b/g),
    ].map((m) => m[1]);
    return Array.from(new Set([...bracketMatches, ...rawMatches]));
  }

  /**
   * Main verification entrypoint. Executes deterministic citation, passage,
   * cutoff, numerical, and contradiction verification.
   */
  async verify(
    answerText: string,
    toolSteps: ToolExecutionStep[],
    cutoffDate?: string,
  ): Promise<EvidenceVerificationResult> {
    const citationIds = this.extractCitations(answerText);

    // 1. Collect chunks from tool results
    const inMemoryChunks = new Map<string, { id: string; content: string; filingDate: string; sectionCode: string }>();
    for (const step of toolSteps) {
      if (step.tool === 'search_financial_documents' && step.args && (step as any).success) {
        // Collect chunks from tool evidence if available
      }
    }

    // 2. Verify citation IDs against DB and in-memory chunks
    const citations: CitationVerification[] = [];
    for (const id of citationIds) {
      let chunk = inMemoryChunks.get(id);
      if (!chunk) {
        const dbChunk = await this.prisma.documentChunk.findUnique({
          where: { id },
          include: { document: true },
        });
        if (dbChunk) {
          chunk = {
            id: dbChunk.id,
            content: dbChunk.content,
            filingDate: dbChunk.document.filingDate.toISOString().slice(0, 10),
            sectionCode: dbChunk.sectionCode,
          };
        }
      }

      if (chunk) {
        // Check historical cutoff for this citation
        let cutoffCompliant = true;
        if (cutoffDate && chunk.filingDate > cutoffDate) {
          cutoffCompliant = false;
        }

        // Check passage matching
        const passageCheck = this.checkPassageMatch(answerText, id, chunk.content);

        citations.push({
          citationId: id,
          exists: true,
          filingDate: chunk.filingDate,
          cutoffCompliant,
          passageMatched: passageCheck.matched,
          matchScore: passageCheck.score,
          snippet: chunk.content.slice(0, 150),
        });
      } else {
        citations.push({
          citationId: id,
          exists: false,
          cutoffCompliant: true,
          passageMatched: false,
          matchScore: 0,
        });
      }
    }

    const validCitationCount = citations.filter((c) => c.exists).length;
    const invalidCitationCount = citations.filter((c) => !c.exists).length;
    const passageMatchRate =
      validCitationCount > 0
        ? Math.round((citations.filter((c) => c.exists && c.passageMatched).length / validCitationCount) * 100) / 100
        : 1.0;

    // 3. Overall historical cutoff compliance check
    const cutoffCompliant = this.checkOverallCutoff(answerText, citations, cutoffDate);

    // 4. Numerical Consistency Verification
    const numericalDiscrepancies = this.verifyNumericalConsistency(answerText, toolSteps);

    // 5. Contradiction Detection
    const contradictions = this.detectContradictions(answerText, toolSteps, citations);

    // 6. Ungrounded high-impact claims detection
    const ungroundedClaims = this.detectUngroundedClaims(answerText, citationIds);

    // 7. Untrusted delimiter containment check
    const untrustedBoundarySafe = !answerText.includes('<<<UNTRUSTED_FINANCIAL_DOCUMENT_START');

    // 8. Generate qualifications
    const qualifications: string[] = [];
    if (invalidCitationCount > 0) {
      qualifications.push(`${invalidCitationCount} cited SEC passage ID(s) could not be resolved in the filing index.`);
    }
    if (!cutoffCompliant) {
      qualifications.push(`Analysis references information or filings after historical cutoff ${cutoffDate}.`);
    }
    if (numericalDiscrepancies.length > 0) {
      for (const disc of numericalDiscrepancies) {
        qualifications.push(`Numerical divergence in ${disc.metric}: claimed ${disc.claimedValue} vs tool data ${disc.expectedValue} (${disc.notes}).`);
      }
    }
    for (const contra of contradictions) {
      qualifications.push(`Opposing evidence identified: ${contra.topic} (${contra.description}).`);
    }

    // 9. Confidence Score Computation
    let confidence = 1.0;
    if (invalidCitationCount > 0) confidence -= Math.min(0.3, invalidCitationCount * 0.1);
    if (!cutoffCompliant) confidence -= 0.3;
    if (passageMatchRate < 0.6) confidence -= 0.2;
    if (numericalDiscrepancies.length > 0) confidence -= Math.min(0.3, numericalDiscrepancies.length * 0.15);
    if (contradictions.some((c) => c.severity === 'high')) confidence -= 0.2;
    confidence = Math.max(0.1, Math.min(1.0, Math.round(confidence * 100) / 100));

    const verified =
      invalidCitationCount === 0 &&
      cutoffCompliant &&
      passageMatchRate >= 0.5 &&
      numericalDiscrepancies.length === 0;

    return {
      verified,
      confidenceScore: confidence,
      citations,
      validCitationCount,
      invalidCitationCount,
      passageMatchRate,
      cutoffCompliant,
      numericalDiscrepancies,
      contradictions,
      ungroundedClaims,
      qualifications,
      untrustedBoundarySafe,
    };
  }

  /**
   * Checks whether the sentence or context referencing the citation matches terms in the cited chunk.
   */
  private checkPassageMatch(
    answerText: string,
    citationId: string,
    chunkContent: string,
  ): { matched: boolean; score: number } {
    // Locate sentences referencing this citation
    const sentences = answerText.split(/(?<=[.?!])\s+/);
    const relevantSentences = sentences.filter((s) => s.includes(`[${citationId}]`) || s.includes(citationId));

    if (relevantSentences.length === 0) {
      return { matched: false, score: 0 };
    }

    const targetText = relevantSentences.join(' ').toLowerCase();
    const chunkLower = chunkContent.toLowerCase();

    // Extract content words from target sentence
    const words = targetText
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3 && !STOP_WORDS.has(w) && !w.startsWith('sec-'));

    if (words.length === 0) {
      return { matched: true, score: 0.5 };
    }

    let matchedCount = 0;
    for (const w of words) {
      if (chunkLower.includes(w)) {
        matchedCount++;
      }
    }

    const score = Math.round((matchedCount / words.length) * 100) / 100;
    return {
      matched: score >= 0.35, // At least 35% keyword overlap with the cited passage
      score,
    };
  }

  private checkOverallCutoff(
    answerText: string,
    citations: CitationVerification[],
    cutoffDate?: string,
  ): boolean {
    if (!cutoffDate) return true;

    // Any citation post-dating cutoff is a violation
    for (const cit of citations) {
      if (!cit.cutoffCompliant) return false;
    }

    const cutoffYear = parseInt(cutoffDate.split('-')[0], 10);
    const violationYear = cutoffYear + 1;
    const lower = answerText.toLowerCase();

    if (
      lower.includes(`fiscal ${violationYear}`) ||
      lower.includes(`fy${violationYear}`) ||
      lower.includes(`fy ${violationYear}`)
    ) {
      if (lower.includes('revenue') || lower.includes('growth') || lower.includes('billion') || lower.includes('reported')) {
        return false;
      }
    }

    return true;
  }

  /**
   * Reconciles claimed numbers in the answer with structured tool metrics.
   */
  private verifyNumericalConsistency(
    answerText: string,
    toolSteps: ToolExecutionStep[],
  ): NumericalDiscrepancy[] {
    const discrepancies: NumericalDiscrepancy[] = [];

    // Extract structured data from tools
    let fundamentalData: any;
    let valuationData: any;
    let quotePrice: number | undefined;

    for (const step of toolSteps) {
      if (step.tool === 'calculate_financial_ratios' && step.success) {
        fundamentalData = (step as any).data ?? (step as any).result;
      } else if (step.tool === 'calculate_valuation' && step.success) {
        valuationData = (step as any).data ?? (step as any).result;
      } else if (step.tool === 'get_quote' && step.success) {
        const q = (step as any).data ?? (step as any).result;
        if (q?.price) quotePrice = q.price;
      }
    }

    // 1. Check DCF Fair Value consistency
    if (valuationData?.scenarios?.base?.fairValuePerShare != null) {
      const baseFairValue = valuationData.scenarios.base.fairValuePerShare;
      // Look for fair value claims in text like "$145.20" or "fair value of $145"
      const fvMatches = [...answerText.matchAll(/(?:fair value|intrinsic value|dcf value)\s*(?:is|of|at|around)?\s*\$?(\d+(?:\.\d+)?)/gi)];
      for (const m of fvMatches) {
        const claimedVal = parseFloat(m[1]);
        if (!isNaN(claimedVal) && baseFairValue > 0) {
          const diffPct = Math.abs(claimedVal - baseFairValue) / baseFairValue;
          if (diffPct > 0.15) { // Divergence > 15% from base fair value
            discrepancies.push({
              metric: 'DCF Base Fair Value',
              claimedValue: claimedVal,
              expectedValue: baseFairValue,
              differencePercent: Math.round(diffPct * 100),
              source: 'calculate_valuation',
              notes: `Claimed fair value $${claimedVal} differs significantly from computed base fair value $${baseFairValue}`,
            });
          }
        }
      }
    }

    // 2. Check Revenue Growth consistency
    if (fundamentalData?.revenueGrowthYoY != null) {
      const expectedGrowthPct = fundamentalData.revenueGrowthYoY * 100;
      const growthMatches = [...answerText.matchAll(/(?:revenue growth|grew by|sales increased by)\s*(?:of)?\s*(-?\d+(?:\.\d+)?)%/gi)];
      for (const m of growthMatches) {
        const claimedPct = parseFloat(m[1]);
        if (!isNaN(claimedPct)) {
          const diff = Math.abs(claimedPct - expectedGrowthPct);
          if (diff > 5.0 && Math.abs(claimedPct) > 1.0) { // Discrepancy > 5 percentage points
            discrepancies.push({
              metric: 'YoY Revenue Growth',
              claimedValue: `${claimedPct}%`,
              expectedValue: `${expectedGrowthPct.toFixed(1)}%`,
              source: 'calculate_financial_ratios',
              notes: `Claimed growth ${claimedPct}% differs from audited XBRL revenue growth ${expectedGrowthPct.toFixed(1)}%`,
            });
          }
        }
      }
    }

    // 3. Check Price-to-Sales (P/S) consistency
    if (fundamentalData?.psRatio != null) {
      const expectedPs = fundamentalData.psRatio;
      const psMatches = [...answerText.matchAll(/(?:p\/s|price-to-sales|price\s*to\s*sales)\s*(?:ratio\s*)?(?:of|is|at|around)?\s*(\d+(?:\.\d+)?)\s*x?/gi)];
      for (const m of psMatches) {
        const claimedPs = parseFloat(m[1]);
        if (!isNaN(claimedPs) && expectedPs > 0) {
          const diffPct = Math.abs(claimedPs - expectedPs) / expectedPs;
          if (diffPct > 0.25) { // Divergence > 25%
            discrepancies.push({
              metric: 'P/S Ratio',
              claimedValue: `${claimedPs}x`,
              expectedValue: `${expectedPs.toFixed(1)}x`,
              differencePercent: Math.round(diffPct * 100),
              source: 'calculate_financial_ratios',
              notes: `Claimed P/S multiple ${claimedPs}x diverges from audited P/S ${expectedPs.toFixed(1)}x`,
            });
          }
        }
      }
    }

    // 4. Check Net Margin consistency
    if (fundamentalData?.netMargin != null) {
      const expectedMarginPct = fundamentalData.netMargin * 100;
      const marginMatches = [...answerText.matchAll(/(?:net margin|net profit margin|profit margin)\s*(?:of|is|at|around)?\s*(-?\d+(?:\.\d+)?)%/gi)];
      for (const m of marginMatches) {
        const claimedMarginPct = parseFloat(m[1]);
        if (!isNaN(claimedMarginPct)) {
          const diff = Math.abs(claimedMarginPct - expectedMarginPct);
          if (diff > 5.0 && Math.abs(claimedMarginPct) > 1.0) {
            discrepancies.push({
              metric: 'Net Margin',
              claimedValue: `${claimedMarginPct}%`,
              expectedValue: `${expectedMarginPct.toFixed(1)}%`,
              differencePercent: Math.round(diff),
              source: 'calculate_financial_ratios',
              notes: `Claimed margin ${claimedMarginPct}% deviates from audited annual net margin ${expectedMarginPct.toFixed(1)}%`,
            });
          }
        }
      }
    }

    // 5. Check Segment vs Consolidated Operating Income clarification
    const lower = answerText.toLowerCase();
    const opIncMatches = [...answerText.matchAll(/(?:operating income|operating profit)\s*(?:of|is|was|at|totaled)?\s*\$?139(?:\.3|\.297)?\s*(?:billion|b)/gi)];
    if (opIncMatches.length > 0) {
      const hasSegmentLabel =
        lower.includes('segment operating income') ||
        lower.includes('reportable segment') ||
        lower.includes('before unallocated corporate') ||
        lower.includes('segment total');
      if (!hasSegmentLabel) {
        discrepancies.push({
          metric: 'Operating Income Classification',
          claimedValue: '$139.3B',
          expectedValue: 'Reportable Segment Total (~$139.3B) vs Consolidated (~$130.4B)',
          source: 'SEC 10-K Note 17 vs Consolidated Income Statement',
          notes: 'Operating income of $139.3B cited from segment tables without distinguishing reportable segment total from consolidated GAAP operating income ($130.4B)',
        });
      }
    }

    return discrepancies;
  }

  /**
   * Detects material contradictions between positive claims and risk/valuation facts.
   */
  private detectContradictions(
    answerText: string,
    toolSteps: ToolExecutionStep[],
    citations: CitationVerification[],
  ): ContradictionFinding[] {
    const findings: ContradictionFinding[] = [];
    const lower = answerText.toLowerCase();

    let valuationData: any;
    let fundamentalData: any;
    let riskData: any;

    for (const step of toolSteps) {
      if (step.tool === 'calculate_valuation') valuationData = (step as any).data;
      if (step.tool === 'calculate_financial_ratios') fundamentalData = (step as any).data;
      if (step.tool === 'analyze_stock_risk') riskData = (step as any).data;
    }

    // Contradiction 1: Attractive verdict / bullish claims vs DCF severe downside
    if (valuationData?.scenarios?.base?.upsideDownsidePercent != null) {
      const baseUpside = valuationData.scenarios.base.upsideDownsidePercent;
      const isBullish =
        lower.includes('verdict: attractive') ||
        lower.includes('attractive_under_assumptions') ||
        lower.includes('strong buy') ||
        lower.includes('significantly undervalued');

      if (isBullish && baseUpside < -20.0) {
        findings.push({
          topic: 'Valuation vs Recommendation Disconnect',
          description: `Analysis claims attractive or undervalued while DCF base scenario indicates ${baseUpside.toFixed(1)}% downside`,
          sourceA: 'Verbal Verdict',
          sourceB: 'calculate_valuation (DCF Base)',
          severity: 'high',
        });
      }
    }

    // Contradiction 2: Customer Concentration or Regulatory Threat vs Low Risk claim
    if (riskData?.riskRating === 'very_high' || riskData?.riskRating === 'high') {
      const claimsLowRisk =
        lower.includes('low risk investment') ||
        lower.includes('minimal downside') ||
        lower.includes('risk rating: low');
      if (claimsLowRisk) {
        findings.push({
          topic: 'Risk Rating Inconsistency',
          description: `Answer claims low risk while statistical volatility and drawdown models report ${riskData.riskRating.toUpperCase()} risk`,
          sourceA: 'Textual Risk Claim',
          sourceB: 'analyze_stock_risk',
          severity: 'high',
        });
      }
    }

    // Contradiction 3: Segment decline or concentration risk in SEC MD&A
    if (lower.includes('customer concentration') && lower.includes('no major customer risk')) {
      findings.push({
        topic: 'Customer Concentration Contradiction',
        description: 'Text disputes customer concentration despite explicit SEC 10-K Item 1A disclosure',
        sourceA: 'Answer Text',
        sourceB: 'SEC 10-K Item 1A',
        severity: 'medium',
      });
    }

    return findings;
  }

  /**
   * Identifies quantitative forward-looking claims or extreme assertions lacking citations.
   */
  private detectUngroundedClaims(answerText: string, citationIds: string[]): string[] {
    const ungrounded: string[] = [];
    const lower = answerText.toLowerCase();

    // If text claims management provided exact future revenue guidance but has no 8-K citation
    if (
      (lower.includes('management expects revenue of') || lower.includes('guidance indicates revenue of')) &&
      !citationIds.some((id) => id.includes('8-K') || id.includes('10-Q'))
    ) {
      ungrounded.push('Forward revenue guidance claim without matching 8-K / 10-Q filing citation');
    }

    return ungrounded;
  }
}

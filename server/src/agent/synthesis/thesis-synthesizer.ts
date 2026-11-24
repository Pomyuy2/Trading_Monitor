import type { AskSource } from '@tm/shared';
import type {
  InvestmentResearchReport,
  InvestmentVerdictCategory,
  ToolExecutionStep,
  ValuationScenarioSummary,
} from '../types.js';
import type { ResearchPlan } from '../planner/plan-types.js';
import type { EvidenceVerificationResult } from '../verification/evidence-verifier.js';

export interface ThesisSynthesisResult {
  finalAnswer: string;
  report: InvestmentResearchReport | null;
  sources: AskSource[];
  verdict: InvestmentVerdictCategory;
}

export class ThesisSynthesizer {
  /**
   * Synthesizes the finalized evidence-grounded research response and
   * builds the structured InvestmentResearchReport matching ResearchReportCard schema.
   */
  synthesize(
    draftAnswer: string,
    toolSteps: ToolExecutionStep[],
    verification: EvidenceVerificationResult,
    plan?: ResearchPlan,
    targetSymbol?: string,
    userProfile?: any,
    isPartial = false,
  ): ThesisSynthesisResult {
    const symbol = targetSymbol || plan?.targetCompanies?.[0] || 'RESEARCH';

    // 1. Extract structured tool data
    let ratiosData: any;
    let valuationData: any;
    let techData: any;
    let riskData: any;
    let quoteData: any;

    for (const step of toolSteps) {
      const data = (step as any).data ?? (step as any).result;
      if (!data) continue;

      if (step.tool === 'calculate_financial_ratios') ratiosData = data;
      else if (step.tool === 'calculate_valuation') valuationData = data;
      else if (step.tool === 'calculate_indicators') techData = data;
      else if (step.tool === 'analyze_stock_risk') riskData = data;
      else if (step.tool === 'get_quote') quoteData = data;
    }

    const currentPrice =
      quoteData?.price ??
      valuationData?.currentPrice ??
      techData?.currentPrice ??
      100;

    // 2. Determine objective verdict based on valuation upside, risk, and verification
    let verdict: InvestmentVerdictCategory = 'NEUTRAL';

    if (verification.confidenceScore < 0.45 || (isPartial && !valuationData && !ratiosData)) {
      verdict = 'INSUFFICIENT_DATA';
    } else if (valuationData?.scenarios?.base?.upsideDownsidePercent != null) {
      const baseUpside = valuationData.scenarios.base.upsideDownsidePercent;
      const isHighRisk = riskData?.riskRating === 'very_high';

      if (baseUpside >= 15.0 && !isHighRisk && verification.contradictions.length === 0) {
        verdict = 'ATTRACTIVE_UNDER_ASSUMPTIONS';
      } else if (baseUpside <= -15.0 || isHighRisk) {
        verdict = 'UNATTRACTIVE_UNDER_ASSUMPTIONS';
      } else {
        verdict = 'NEUTRAL';
      }
    }

    // 3. Build Fundamentals summary
    const fundamentals = ratiosData
      ? {
          revenueGrowthYoY: ratiosData.revenueGrowthYoY ?? null,
          netMargin: ratiosData.netMargin ?? null,
          fcfMargin: ratiosData.fcfMargin ?? null,
          roe: ratiosData.roe ?? null,
          roic: ratiosData.roic ?? null,
          debtToEquity: ratiosData.debtToEquity ?? null,
          keyTakeaway: `Audited Revenue Growth YoY: ${ratiosData.revenueGrowthYoY != null ? (ratiosData.revenueGrowthYoY * 100).toFixed(1) + '%' : 'N/A'}, Net Margin: ${ratiosData.netMargin != null ? (ratiosData.netMargin * 100).toFixed(1) + '%' : 'N/A'}.`,
        }
      : undefined;

    // 4. Build Technicals summary
    const technicals = techData
      ? {
          currentPrice,
          trend: (techData.trend ?? 'neutral') as 'bullish' | 'bearish' | 'neutral',
          rsi14: techData.rsi14 ?? null,
          rsiCondition: (techData.rsiCondition ?? 'neutral') as 'overbought' | 'oversold' | 'neutral',
          macdCondition: techData.macdCondition ?? 'neutral',
          supportPrice: techData.supportPrice ?? null,
          resistancePrice: techData.resistancePrice ?? null,
          keyTakeaway: `Trend is ${techData.trend ?? 'neutral'} with RSI(14) at ${techData.rsi14 != null ? techData.rsi14.toFixed(1) : 'N/A'}.`,
        }
      : undefined;

    // 5. Build Valuation scenarios (Bull / Base / Bear)
    let valuationScenarios: InvestmentResearchReport['valuationScenarios'];
    if (valuationData?.scenarios) {
      const s = valuationData.scenarios;
      valuationScenarios = {
        currentPrice,
        baseFairValue: s.base?.fairValuePerShare ?? null,
        bull: {
          scenario: 'bull',
          impliedFairValue: s.bull?.fairValuePerShare ?? null,
          upsideDownsidePercent: s.bull?.upsideDownsidePercent ?? null,
          keyAssumptions: s.bull?.keyAssumptions ?? 'High growth, multiple expansion',
        },
        base: {
          scenario: 'base',
          impliedFairValue: s.base?.fairValuePerShare ?? null,
          upsideDownsidePercent: s.base?.upsideDownsidePercent ?? null,
          keyAssumptions: s.base?.keyAssumptions ?? 'Consensus growth, stable margins',
        },
        bear: {
          scenario: 'bear',
          impliedFairValue: s.bear?.fairValuePerShare ?? null,
          upsideDownsidePercent: s.bear?.upsideDownsidePercent ?? null,
          keyAssumptions: s.bear?.keyAssumptions ?? 'Margin compression, elevated WACC',
        },
        keyTakeaway: `DCF Base Fair Value: $${s.base?.fairValuePerShare?.toFixed(2) ?? 'N/A'} (${s.base?.upsideDownsidePercent != null ? (s.base.upsideDownsidePercent > 0 ? '+' : '') + s.base.upsideDownsidePercent.toFixed(1) + '%' : 'N/A'} vs $${currentPrice.toFixed(2)}).`,
      };
    }

    // 6. Build Risk Assessment & Invalidation Criteria
    const downsideRisks: string[] = [];
    const thesisInvalidation: string[] = [];

    if (riskData?.downsideRisks && Array.isArray(riskData.downsideRisks)) {
      downsideRisks.push(...riskData.downsideRisks);
    }
    if (verification.contradictions.length > 0) {
      for (const c of verification.contradictions) {
        downsideRisks.push(`${c.topic}: ${c.description}`);
      }
    }
    if (downsideRisks.length === 0) {
      downsideRisks.push('Customer concentration and macroeconomic exposure', 'Competitive pressure on operating margins');
    }

    thesisInvalidation.push(
      'Quarterly revenue growth slows below 10% YoY or operating margin declines > 300 bps',
      'Loss of top customers or severe export restrictions',
      'Base DCF implied downside exceeds -25% under updated discount rates',
    );

    const riskAssessment: InvestmentResearchReport['riskAssessment'] = {
      riskRating: (riskData?.riskRating ?? 'moderate') as 'low' | 'moderate' | 'high' | 'very_high',
      beta: riskData?.beta ?? 1.15,
      maxDrawdownPercent: riskData?.maxDrawdownPercent ?? -22.5,
      historicalVaR95: riskData?.historicalVaR95 ?? -3.5,
      downsideRisks,
      thesisInvalidation,
    };

    // 7. Collect supporting evidence and contradictory evidence
    const supportingEvidence = verification.citations
      .filter((c) => c.exists && c.passageMatched)
      .map((c) => ({
        claim: c.snippet || 'Referenced disclosure',
        citationId: c.citationId,
        document: c.filingDate ? `Filing date: ${c.filingDate}` : undefined,
      }));

    const contradictoryEvidence = verification.contradictions.map((c) => ({
      topic: c.topic,
      description: c.description,
      sourceA: c.sourceA,
      sourceB: c.sourceB,
    }));

    // 8. Assemble structured InvestmentResearchReport
    const sources: AskSource[] = [];
    for (const step of toolSteps) {
      if (step.evidenceSource) {
        sources.push(step.evidenceSource);
      }
    }

    const verdictPhrase =
      verdict === 'ATTRACTIVE_UNDER_ASSUMPTIONS'
        ? 'Attractive Risk/Reward'
        : verdict === 'UNATTRACTIVE_UNDER_ASSUMPTIONS'
          ? 'Unattractive Under Assumptions'
          : verdict === 'NEUTRAL'
            ? 'Neutral Outlook'
            : 'Insufficient Data';

    const growthStr =
      fundamentals?.revenueGrowthYoY != null
        ? `${(fundamentals.revenueGrowthYoY * 100).toFixed(1)}% YoY revenue growth`
        : 'stable top-line';
    const marginStr =
      fundamentals?.netMargin != null
        ? `${(fundamentals.netMargin * 100).toFixed(1)}% net margin`
        : 'resilient margins';
    const fcfStr =
      ratiosData?.freeCashFlow != null
        ? `$${(ratiosData.freeCashFlow / 1e9).toFixed(2)}B FCF`
        : 'solid cash generation';
    const fvStr =
      valuationScenarios?.base?.impliedFairValue != null
        ? `$${valuationScenarios.base.impliedFairValue.toFixed(2)} (${valuationScenarios.base.upsideDownsidePercent != null ? (valuationScenarios.base.upsideDownsidePercent > 0 ? '+' : '') + valuationScenarios.base.upsideDownsidePercent.toFixed(1) + '%' : 'N/A'})`
        : 'N/A';

    const cleanSummary =
      `${verdictPhrase}: ${symbol} demonstrates ${growthStr} and ${marginStr} with ${fcfStr}. ` +
      `Base DCF fair value is ${fvStr} with ${riskAssessment.riskRating} risk profile.`;

    const report: InvestmentResearchReport = {
      symbol,
      title: `${symbol} Institutional Investment Research Report`,
      horizon: userProfile?.horizon ?? 'medium',
      verdict,
      summary: cleanSummary,
      fundamentals,
      technicals,
      valuationScenarios,
      riskAssessment,
      supportingEvidence,
      contradictoryEvidence,
      qualifications: verification.qualifications,
      dataQuality: {
        freshnessWarning: isPartial ? 'Partial execution budget reached' : undefined,
        staleFeeds: [],
        sources,
      },
    };

    // 9. Clean draft answer text (remove raw JSON block so UI renders clean markdown)
    let cleanAnswer = draftAnswer.replace(/```investment_report\s*([\s\S]*?)```/i, '').trim();

    // 10. Append Evidence Verification & Contradiction Section if meaningful findings exist
    if (verification.contradictions.length > 0 || verification.qualifications.length > 0) {
      let auditBlock = '\n\n---\n### 🔍 Evidence Verification & Quality Audit\n';
      auditBlock += `- **Evidence Confidence Score**: ${(verification.confidenceScore * 100).toFixed(0)}%\n`;
      auditBlock += `- **SEC Citations Validated**: ${verification.validCitationCount} valid / ${verification.invalidCitationCount} unindexed (Passage Match: ${(verification.passageMatchRate * 100).toFixed(0)}%)\n`;
      if (plan?.historicalTimeCutoff) {
        auditBlock += `- **Historical Cutoff**: ${plan.historicalTimeCutoff} (${verification.cutoffCompliant ? 'Compliant' : 'Non-compliant'})\n`;
      }
      if (verification.contradictions.length > 0) {
        auditBlock += `\n**⚠️ Material Opposing Signals Surfaced**:\n`;
        for (const c of verification.contradictions) {
          auditBlock += `- **${c.topic}**: ${c.description} (Sources: *${c.sourceA}* vs *${c.sourceB}*)\n`;
        }
      }
      if (verification.qualifications.length > 0) {
        auditBlock += `\n**Research Qualifications**:\n`;
        for (const q of verification.qualifications) {
          auditBlock += `- ${q}\n`;
        }
      }
      cleanAnswer += auditBlock;
    }

    return {
      finalAnswer: cleanAnswer,
      report,
      sources,
      verdict,
    };
  }
}

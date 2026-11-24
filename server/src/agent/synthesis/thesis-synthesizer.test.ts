import { describe, expect, it } from 'vitest';
import { ThesisSynthesizer } from './thesis-synthesizer.js';
import type { EvidenceVerificationResult } from '../verification/evidence-verifier.js';

describe('ThesisSynthesizer', () => {
  const synthesizer = new ThesisSynthesizer();

  const emptyVerification: EvidenceVerificationResult = {
    verified: true,
    confidenceScore: 0.95,
    citations: [
      {
        citationId: 'SEC-NVDA-10-K-2024-02-21-ITEM_7-c1',
        exists: true,
        filingDate: '2024-02-21',
        cutoffCompliant: true,
        passageMatched: true,
        matchScore: 0.8,
        snippet: 'Data center revenue grew to $47.4B',
      },
    ],
    validCitationCount: 1,
    invalidCitationCount: 0,
    passageMatchRate: 1.0,
    cutoffCompliant: true,
    numericalDiscrepancies: [],
    contradictions: [],
    ungroundedClaims: [],
    qualifications: [],
    untrustedBoundarySafe: true,
  };

  it('builds a structured InvestmentResearchReport from tool steps', () => {
    const draft = 'Nvidia demonstrated exceptional growth in Compute & Networking.';
    const toolSteps: any[] = [
      {
        tool: 'calculate_financial_ratios',
        success: true,
        data: {
          revenueGrowthYoY: 1.25,
          netMargin: 0.48,
          roe: 0.65,
        },
      },
      {
        tool: 'calculate_valuation',
        success: true,
        data: {
          currentPrice: 130.0,
          scenarios: {
            bull: { fairValuePerShare: 180.0, upsideDownsidePercent: 38.5 },
            base: { fairValuePerShare: 155.0, upsideDownsidePercent: 19.2 },
            bear: { fairValuePerShare: 105.0, upsideDownsidePercent: -19.2 },
          },
        },
      },
    ];

    const result = synthesizer.synthesize(draft, toolSteps, emptyVerification, undefined, 'NVDA');

    expect(result.report).not.toBeNull();
    expect(result.report?.symbol).toBe('NVDA');
    expect(result.verdict).toBe('ATTRACTIVE_UNDER_ASSUMPTIONS');
    expect(result.report?.fundamentals?.revenueGrowthYoY).toBe(1.25);
    expect(result.report?.valuationScenarios?.base.impliedFairValue).toBe(155.0);
    expect(result.report?.riskAssessment?.thesisInvalidation.length).toBeGreaterThan(0);
  });

  it('sets verdict to INSUFFICIENT_DATA when confidence is low or partial data lacks valuation', () => {
    const draft = 'Data is incomplete.';
    const lowConfidenceVerification = {
      ...emptyVerification,
      confidenceScore: 0.3,
      verified: false,
    };

    const result = synthesizer.synthesize(draft, [], lowConfidenceVerification, undefined, 'XYZ', undefined, true);
    expect(result.verdict).toBe('INSUFFICIENT_DATA');
  });

  it('surfaces contradictions in both markdown and structured report', () => {
    const draft = 'Strong performance.';
    const verificationWithContradiction: EvidenceVerificationResult = {
      ...emptyVerification,
      contradictions: [
        {
          topic: 'Valuation vs Recommendation Disconnect',
          description: 'Bullish recommendation despite -30% DCF base downside',
          sourceA: 'Text',
          sourceB: 'calculate_valuation',
          severity: 'high',
        },
      ],
      qualifications: ['Opposing evidence: Valuation vs Recommendation Disconnect'],
    };

    const result = synthesizer.synthesize(draft, [], verificationWithContradiction, undefined, 'TEST');
    expect(result.report?.contradictoryEvidence?.length).toBe(1);
    expect(result.finalAnswer).toContain('Material Opposing Signals Surfaced');
    expect(result.finalAnswer).toContain('Valuation vs Recommendation Disconnect');
  });
});

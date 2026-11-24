import { describe, expect, it, vi } from 'vitest';
import { EvidenceVerifier } from './evidence-verifier.js';

describe('EvidenceVerifier', () => {
  const mockPrisma: any = {
    documentChunk: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id === 'SEC-NVDA-10-K-2024-02-21-ITEM_7-c1') {
          return {
            id: 'SEC-NVDA-10-K-2024-02-21-ITEM_7-c1',
            content: 'Compute & Networking revenue increased to $47.4 billion in fiscal 2024 driven by Data Center demand.',
            sectionCode: 'ITEM_7',
            document: {
              filingDate: new Date('2024-02-21'),
            },
          };
        }
        if (where.id === 'SEC-NVDA-10-K-2025-02-26-ITEM_7-c5') {
          return {
            id: 'SEC-NVDA-10-K-2025-02-26-ITEM_7-c5',
            content: 'In fiscal 2025, Data Center revenue reached $116.4 billion.',
            sectionCode: 'ITEM_7',
            document: {
              filingDate: new Date('2025-02-26'),
            },
          };
        }
        return null;
      }),
    },
  };

  const verifier = new EvidenceVerifier(mockPrisma);

  it('extracts citation IDs in brackets and plain formats', () => {
    const text = 'Nvidia grew [SEC-NVDA-10-K-2024-02-21-ITEM_7-c1] and also SEC-NVDA-10-K-2025-02-26-ITEM_7-c5.';
    const citations = verifier.extractCitations(text);
    expect(citations).toContain('SEC-NVDA-10-K-2024-02-21-ITEM_7-c1');
    expect(citations).toContain('SEC-NVDA-10-K-2025-02-26-ITEM_7-c5');
  });

  it('verifies passage matching and flags nonexistent citations', async () => {
    const text = 'Compute and networking revenue grew to $47.4 billion [SEC-NVDA-10-K-2024-02-21-ITEM_7-c1]. Hallucinated citation [SEC-FAKE-10-K-2024-01-01-ITEM_1-c99].';
    const res = await verifier.verify(text, []);

    expect(res.validCitationCount).toBe(1);
    expect(res.invalidCitationCount).toBe(1);
    expect(res.citations.find((c) => c.citationId === 'SEC-NVDA-10-K-2024-02-21-ITEM_7-c1')?.passageMatched).toBe(true);
    expect(res.verified).toBe(false); // Because 1 invalid citation exists
    expect(res.qualifications.length).toBeGreaterThan(0);
  });

  it('enforces historical cutoff dates strictly', async () => {
    const text = 'Data Center revenue surged [SEC-NVDA-10-K-2025-02-26-ITEM_7-c5].';
    // Cutoff set to 2024-12-31
    const res = await verifier.verify(text, [], '2024-12-31');

    expect(res.cutoffCompliant).toBe(false);
    expect(res.confidenceScore).toBeLessThan(0.8);
    expect(res.qualifications.some((q) => q.includes('historical cutoff'))).toBe(true);
  });

  it('detects numerical discrepancies between claimed values and tool facts', async () => {
    const text = 'The DCF intrinsic fair value is $250.00 per share.';
    const toolSteps: any[] = [
      {
        tool: 'calculate_valuation',
        success: true,
        data: {
          scenarios: {
            base: {
              fairValuePerShare: 140.0,
            },
          },
        },
      },
    ];

    const res = await verifier.verify(text, toolSteps);
    expect(res.numericalDiscrepancies.length).toBe(1);
    expect(res.numericalDiscrepancies[0].metric).toBe('DCF Base Fair Value');
    expect(res.numericalDiscrepancies[0].claimedValue).toBe(250.0);
    expect(res.numericalDiscrepancies[0].expectedValue).toBe(140.0);
  });

  it('detects contradiction between attractive verdict and severe DCF downside', async () => {
    const text = 'Overall Verdict: ATTRACTIVE_UNDER_ASSUMPTIONS with high growth.';
    const toolSteps: any[] = [
      {
        tool: 'calculate_valuation',
        success: true,
        data: {
          scenarios: {
            base: {
              upsideDownsidePercent: -35.0, // -35% downside!
            },
          },
        },
      },
    ];

    const res = await verifier.verify(text, toolSteps);
    expect(res.contradictions.length).toBeGreaterThan(0);
    expect(res.contradictions[0].topic).toBe('Valuation vs Recommendation Disconnect');
    expect(res.qualifications.some((q) => q.includes('Opposing evidence'))).toBe(true);
  });
});

import type { Guidance, GuidanceField, SourceDocument, SourceMeta } from '@tm/shared';
import { z } from 'zod/v4';

/**
 * Strict JSON the model must return for guidance extraction. Every field carries
 * a short supporting quote; anything not stated in the source is null.
 */
export const GuidanceFieldSchema = z.object({ value: z.string(), quote: z.string() }).nullable();

export const GuidanceDraftSchema = z.object({
  revenueGuidance: GuidanceFieldSchema,
  epsGuidance: GuidanceFieldSchema,
  capexBudget: GuidanceFieldSchema,
  rndBudget: GuidanceFieldSchema,
  priorities: z.array(GuidanceFieldSchema).max(3),
  fiscalYear: z.number().int().nullable(),
  sourceTitle: z.string().nullable(),
  sourceDate: z.string().nullable(),
});

export type GuidanceDraft = z.infer<typeof GuidanceDraftSchema>;

/** Normalize for quote matching: case, whitespace, curly quotes, dashes. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[“”"]/g, '"')
    .replace(/[‘’`]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/^["'\s]+|["'\s.]+$/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Turn a model draft into display guidance:
 * - validates the shape with zod (throws on mismatch);
 * - drops any field whose supporting quote does not appear in the source documents,
 *   so a value can never be shown without real backing text;
 * - pads priorities to exactly 3 (null = not stated);
 * - pins sourceTitle/sourceDate to one of the provided documents.
 */
export function finalizeGuidance(raw: unknown, docs: SourceDocument[], meta: SourceMeta): Guidance {
  const d = GuidanceDraftSchema.parse(raw);
  const haystack = norm(docs.map((x) => x.text).join('\n'));
  const keep = (f: GuidanceField | null): GuidanceField | null => {
    if (!f || !f.value.trim() || !f.quote.trim()) return null;
    return haystack.includes(norm(f.quote)) ? { value: f.value.trim(), quote: f.quote.trim() } : null;
  };
  const priorities = [0, 1, 2].map((i) => keep(d.priorities[i] ?? null));
  const doc = docs.find((x) => d.sourceTitle && norm(x.title) === norm(d.sourceTitle)) ?? docs[0];
  return {
    fiscalYear: d.fiscalYear,
    revenueGuidance: keep(d.revenueGuidance),
    epsGuidance: keep(d.epsGuidance),
    capexBudget: keep(d.capexBudget),
    rndBudget: keep(d.rndBudget),
    priorities,
    sourceTitle: doc?.title ?? null,
    sourceDate: doc?.date ?? null,
    meta,
  };
}

/** Display strings (values only — quotes stay in the source language) in a fixed order. */
export function guidanceTexts(g: Guidance): string[] {
  return [g.revenueGuidance, g.epsGuidance, g.capexBudget, g.rndBudget, ...g.priorities].map((f) => f?.value ?? '');
}

/** Put translated strings back in the same order as `guidanceTexts`. */
export function withTexts(g: Guidance, texts: string[]): Guidance {
  const f = (x: GuidanceField | null, i: number) => (x && texts[i]?.trim() ? { ...x, value: texts[i].trim() } : x);
  return {
    ...g,
    revenueGuidance: f(g.revenueGuidance, 0),
    epsGuidance: f(g.epsGuidance, 1),
    capexBudget: f(g.capexBudget, 2),
    rndBudget: f(g.rndBudget, 3),
    priorities: g.priorities.map((p, i) => f(p, 4 + i)),
  };
}

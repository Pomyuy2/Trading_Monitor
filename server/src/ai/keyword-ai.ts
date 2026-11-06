import type { NewsItem, Sentiment } from '@tm/shared';
import type { AiService } from './ai-service.js';

/**
 * No-AI fallback: tags headlines with simple finance keyword rules and writes
 * no summaries. Used when ANTHROPIC_API_KEY is not set. Clearly labelled in the UI.
 */
const POSITIVE = [
  'beat', 'beats', 'tops', 'record', 'surge', 'surges', 'soar', 'soars', 'jump', 'jumps', 'rally', 'rallies', 'gain', 'gains',
  'rise', 'rises', 'climb', 'climbs', 'upgrade', 'upgrades', 'upgraded', 'raises', 'raised', 'lifts', 'boost', 'boosts',
  'strong', 'growth', 'outperform', 'buy rating', 'bullish', 'expands', 'wins', 'approval', 'approved', 'partnership',
  'profit', 'dividend increase', 'buyback', 'all-time high', 'breakthrough',
];
const NEGATIVE = [
  'miss', 'misses', 'missed', 'plunge', 'plunges', 'tumble', 'tumbles', 'sink', 'sinks', 'slump', 'slumps', 'drop', 'drops',
  'fall', 'falls', 'slide', 'slides', 'decline', 'declines', 'downgrade', 'downgrades', 'downgraded', 'cuts', 'cut', 'lowers',
  'weak', 'warning', 'warns', 'lawsuit', 'sued', 'probe', 'investigation', 'recall', 'layoffs', 'layoff', 'bearish',
  'underperform', 'sell rating', 'fine', 'fined', 'antitrust', 'delay', 'delays', 'loss', 'losses', 'halt', 'ban', 'tariff', 'tariffs',
];

const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const posRe = new RegExp(`\\b(${POSITIVE.map(escape).join('|')})\\b`, 'gi');
const negRe = new RegExp(`\\b(${NEGATIVE.map(escape).join('|')})\\b`, 'gi');

export function keywordSentiment(text: string): Sentiment {
  const pos = text.match(posRe)?.length ?? 0;
  const neg = text.match(negRe)?.length ?? 0;
  if (pos > neg) return 'positive';
  if (neg > pos) return 'negative';
  return 'neutral';
}

export class KeywordAi implements AiService {
  readonly name = 'Keyword rules';
  readonly sentimentMethod = 'keywords' as const;
  readonly canSummarize = false;
  readonly canExtract = false;

  async summarizeNews() {
    return null;
  }

  async tagSentiment(_symbol: string, items: NewsItem[]): Promise<Sentiment[]> {
    // Headline only: snippets often mention unrelated companies and market moves.
    return items.map((i) => keywordSentiment(i.headline));
  }
}

import { describe, expect, it } from 'vitest';
import { findMentions, mentionsWatchlist, nameKeys } from './ask-resolver.js';

const syms = (q: string, known: { symbol: string; name: string | null }[] = []) => findMentions(q, known).map((m) => m.symbol);

describe('finding the stocks a question names', () => {
  it('reads tickers with or without $, in the order written', () => {
    expect(syms('Compare $tsla and NVDA')).toEqual(['TSLA', 'NVDA']);
  });

  it('skips common all-caps words', () => {
    expect(syms('What did the CEO say about EPS and AI in the US?')).toEqual([]);
  });

  it('marks unknown all-caps words for a provider check, known ones not', () => {
    const m = findMentions('ZZZQ and AAPL', [{ symbol: 'AAPL', name: 'Apple Inc.' }]);
    expect(m).toEqual([
      { symbol: 'ZZZQ', index: 0, needsCheck: true },
      { symbol: 'AAPL', index: 9, needsCheck: false },
    ]);
  });

  it('reads lower-case tickers only for stocks the user follows, never common words', () => {
    const known = [{ symbol: 'NVDA', name: null }, { symbol: 'NOW', name: null }];
    expect(syms('is nvda up now?', known)).toEqual(['NVDA']);
    expect(syms('is tsla up?', known)).toEqual([]);
  });

  it('matches company names: popular ones, Thai spellings and the user\'s own stocks', () => {
    expect(syms('Tesla vs Nvidia')).toEqual(['TSLA', 'NVDA']);
    expect(syms('ข่าวล่าสุดของเทสลา')).toEqual(['TSLA']);
    expect(syms('how is fluence doing?', [{ symbol: 'FLNC', name: 'Fluence Energy, Inc.' }])).toEqual(['FLNC']);
  });

  it('does not double count a stock named twice', () => {
    expect(syms('Rocket Lab (RKLB) news', [{ symbol: 'RKLB', name: 'Rocket Lab USA, Inc.' }])).toEqual(['RKLB']);
  });

  it('turns legal names into short keys', () => {
    expect(nameKeys('Rocket Lab USA, Inc.')).toEqual(['rocket lab', 'rocket']);
    expect(nameKeys('Amazon.com, Inc.')).toEqual(['amazon']);
    expect(nameKeys('Advanced Micro Devices, Inc.')).toEqual(['advanced micro devices']);
  });

  it('spots watchlist questions in English and Thai', () => {
    expect(mentionsWatchlist('Which watchlist stock fell most?')).toBe(true);
    expect(mentionsWatchlist('how are my stocks doing')).toBe(true);
    expect(mentionsWatchlist('หุ้นในรายการเฝ้าดูตัวไหนลงมากสุด')).toBe(true);
    expect(mentionsWatchlist('What is the stock price?')).toBe(false);
  });
});

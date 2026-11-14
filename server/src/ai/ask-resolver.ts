/**
 * Finds which stocks an "Ask AI" question is about: tickers ($NVDA, NVDA, or nvda for a stock the user
 * already follows), company names (Tesla, Rocket Lab, เทสลา) and "my watchlist". Pure functions — the
 * service validates unknown tickers against the quote provider.
 */

export interface KnownStock {
  symbol: string;
  name: string | null;
}

export interface Mention {
  symbol: string;
  /** Position in the question; answers list stocks in the order the user named them. */
  index: number;
  /** true → must be checked with the quote provider before use (an all-caps word that may not be a ticker). */
  needsCheck: boolean;
}

/** Most stocks a single question looks up in full detail (each costs several provider calls). */
export const MAX_ASK_STOCKS = 3;

/** All-caps words that are common in finance questions but are not the ticker the user means. */
const NOT_TICKERS = new Set(
  (
    'A I AI AM AN AND ARE AS AT ATH BE BUY BY CAGR CEO CFO CPI CTO DO DOW EBIT EBITDA EMA EOD EPS ET ETF EU EV EVS FAQ FED ' +
    'FOMC FY GDP GMT H1 H2 HOLD HOW IF IN IPO IRS IS IT ME MTD MY NASDAQ NEWS NO NYSE OF OK ON OR PE PM PST Q1 Q2 Q3 Q4 ' +
    'QOQ ROE ROI RSI SEC SELL SMA SO SP SPX THB THE TO TTM UK UP US USA USD VS VWAP WE WHAT WHEN WHO WHY YOY YTD MACD EUR ' +
    'JPY CNY GBP OTC IMO TLDR FYI ASAP PDF URL API CEOS'
  ).split(' '),
);

/** Lower-case words that are also tickers — never read them as a stock in normal writing. */
const COMMON_WORDS = new Set('all are big can car cost edit for fun has key low now one out play real see sell two way well win'.split(' '));

/** Well-known names (incl. Thai spellings) so a question works even for stocks not on the watchlist. */
const POPULAR: [string, string][] = [
  ['apple', 'AAPL'], ['แอปเปิล', 'AAPL'], ['แอปเปิ้ล', 'AAPL'],
  ['microsoft', 'MSFT'], ['ไมโครซอฟท์', 'MSFT'],
  ['nvidia', 'NVDA'], ['เอ็นวิเดีย', 'NVDA'], ['เอนวิเดีย', 'NVDA'],
  ['tesla', 'TSLA'], ['เทสลา', 'TSLA'],
  ['amazon', 'AMZN'], ['อเมซอน', 'AMZN'], ['แอมะซอน', 'AMZN'],
  ['alphabet', 'GOOGL'], ['google', 'GOOGL'], ['กูเกิล', 'GOOGL'], ['กูเกิ้ล', 'GOOGL'],
  ['meta platforms', 'META'], ['facebook', 'META'], ['เฟซบุ๊ก', 'META'],
  ['netflix', 'NFLX'], ['เน็ตฟลิกซ์', 'NFLX'],
  ['broadcom', 'AVGO'], ['intel', 'INTC'], ['อินเทล', 'INTC'],
  ['advanced micro devices', 'AMD'], ['palantir', 'PLTR'], ['oracle', 'ORCL'], ['salesforce', 'CRM'],
  ['berkshire', 'BRK.B'], ['jpmorgan', 'JPM'], ['visa', 'V'], ['mastercard', 'MA'], ['walmart', 'WMT'],
  ['coca-cola', 'KO'], ['coca cola', 'KO'], ['pepsico', 'PEP'], ['disney', 'DIS'], ['nike', 'NKE'],
  ['boeing', 'BA'], ['qualcomm', 'QCOM'], ['taiwan semiconductor', 'TSM'], ['tsmc', 'TSM'],
  ['rocket lab', 'RKLB'], ['coinbase', 'COIN'], ['uber', 'UBER'], ['airbnb', 'ABNB'], ['shopify', 'SHOP'],
];

/** Generic first words of company names that would match too much on their own. */
const GENERIC_FIRST = new Set(
  'advanced american applied first general global international national united new energy digital the bank data micro'.split(' '),
);
const LEGAL_SUFFIX = /\b(inc|incorporated|corp|corporation|company|co|ltd|limited|plc|holdings?|group|sa|nv|ag|se|class [abc]|usa)\b\.?/gi;

/** "Rocket Lab USA, Inc." → ["rocket lab", "rocket"]; "Amazon.com, Inc." → ["amazon"]. */
export function nameKeys(name: string): string[] {
  const clean = name
    .toLowerCase()
    .replace(/\.com\b/g, '')
    .replace(LEGAL_SUFFIX, ' ')
    .replace(/[,.()&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return [];
  const keys = [clean];
  const first = clean.split(' ')[0];
  if (first !== clean && first.length >= 5 && !GENERIC_FIRST.has(first)) keys.push(first);
  return keys;
}

const WATCHLIST_RE = /\b(watch ?list|my (stocks|portfolio|list))\b|รายการเฝ้าดู|หุ้นของ(ฉัน|ผม|เรา)|หุ้นที่(ฉัน|ผม)?ติดตาม/i;

export function mentionsWatchlist(question: string): boolean {
  return WATCHLIST_RE.test(question);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isThai = (s: string) => /[฀-๿]/.test(s);

/** Every stock the question names, in order of appearance, without duplicates. */
export function findMentions(question: string, known: KnownStock[]): Mention[] {
  const knownSymbols = new Set(known.map((k) => k.symbol));
  const out: Mention[] = [];
  const add = (symbol: string, index: number, needsCheck: boolean) => {
    const prev = out.find((m) => m.symbol === symbol);
    if (!prev) out.push({ symbol, index, needsCheck });
    else {
      prev.index = Math.min(prev.index, index);
      prev.needsCheck &&= needsCheck;
    }
  };

  // Tickers: "$tsla" always counts; "TSLA" if it isn't a common all-caps word; "tsla" only for a stock the user follows.
  for (const m of question.matchAll(/(^|[^A-Za-z0-9$])(\$?)([A-Za-z]{1,5}(?:\.[A-Za-z]{1,2})?)(?![A-Za-z0-9])/g)) {
    const dollar = m[2] === '$';
    const raw = m[3];
    const sym = raw.toUpperCase();
    const index = (m.index ?? 0) + m[1].length;
    if (dollar) add(sym, index, !knownSymbols.has(sym));
    else if (raw === sym && raw.length >= 2 && !NOT_TICKERS.has(sym)) add(sym, index, !knownSymbols.has(sym));
    else if (raw !== sym && raw.length >= 3 && knownSymbols.has(sym) && !COMMON_WORDS.has(raw.toLowerCase())) add(sym, index, false);
  }

  // Company names: the user's own stocks first, then the built-in popular list.
  const names: [string, string][] = [];
  for (const k of known) if (k.name) for (const key of nameKeys(k.name)) names.push([key, k.symbol]);
  names.push(...POPULAR);
  const lower = question.toLowerCase();
  for (const [key, symbol] of names) {
    let index: number;
    if (isThai(key)) index = lower.indexOf(key);
    else {
      const hit = new RegExp(`(^|[^a-z0-9])${esc(key)}(?![a-z0-9])`, 'i').exec(lower);
      index = hit ? hit.index + hit[1].length : -1;
    }
    if (index >= 0) add(symbol, index, false);
  }

  return out.sort((a, b) => a.index - b.index);
}

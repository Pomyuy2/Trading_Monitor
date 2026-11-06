import type { SourceDocument } from '@tm/shared';
import { Memo } from '../lib/memo.js';
import { htmlToText, mdaSection } from '../lib/html-text.js';
import { BaseProvider, NotFoundError, RateLimitError, type Capability } from './types.js';

/**
 * SEC EDGAR (https://www.sec.gov/edgar) — free, official US filings. Used as the
 * free source for guidance extraction instead of paid earnings-call transcripts:
 *   - latest 8-K with Item 2.02 (results of operations): the earnings press release (Exhibit 99.1)
 *   - latest 10-K: the Management's Discussion & Analysis section
 * SEC asks automated clients to send a descriptive User-Agent and stay under 10 requests/second.
 * US-listed companies only (no ETFs; foreign issuers file 20-F / 6-K instead).
 */
const MAX_RELEASE_CHARS = 60_000;
const MAX_MDA_CHARS = 120_000;

interface Submissions {
  filings: { recent: { form: string[]; filingDate: string[]; accessionNumber: string[]; primaryDocument: string[]; items?: string[] } };
}

export class SecEdgarProvider extends BaseProvider {
  readonly name = 'SEC EDGAR';
  protected readonly capabilities = new Set<Capability>(['transcripts']);
  private tickers = new Memo<Map<string, number>>(24 * 3600_000);
  private docs = new Memo<SourceDocument[]>(12 * 3600_000);

  constructor(private readonly userAgent: string) {
    super();
  }

  isAvailable(): boolean {
    return true; // no key needed
  }

  private async fetchText(url: string, accept = 'application/json'): Promise<string> {
    const res = await fetch(url, { headers: { 'User-Agent': this.userAgent, Accept: accept }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 429) throw new RateLimitError(this.name, 10_000);
    if (!res.ok) throw new Error(`${this.name} HTTP ${res.status}`);
    return res.text();
  }

  private cik(symbol: string): Promise<number | undefined> {
    return this.tickers
      .get('all', async () => {
        const j = JSON.parse(await this.fetchText('https://www.sec.gov/files/company_tickers.json')) as Record<string, { cik_str: number; ticker: string }>;
        return new Map(Object.values(j).map((r) => [r.ticker.toUpperCase(), r.cik_str]));
      })
      .then((m) => m.get(symbol.toUpperCase()) ?? m.get(symbol.toUpperCase().replace('.', '-')));
  }

  async getGuidanceDocuments(symbol: string): Promise<SourceDocument[]> {
    return this.docs.get(symbol, async () => {
      const cik = await this.cik(symbol);
      if (!cik) throw new NotFoundError(`SEC filer for ${symbol}`);
      const sub = JSON.parse(await this.fetchText(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`)) as Submissions;
      const r = sub.filings.recent;
      const out: SourceDocument[] = [];

      // Latest earnings release: 8-K with Item 2.02, exhibit 99.1.
      const i8k = r.form.findIndex((f, i) => f === '8-K' && (r.items?.[i] ?? '').split(',').includes('2.02'));
      if (i8k >= 0) {
        const acc = r.accessionNumber[i8k].replace(/-/g, '');
        const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${acc}`;
        let docName = r.primaryDocument[i8k];
        try {
          // File names vary (ex99-1.htm, a8-kex991q4….htm, q2fy27pr.htm …), so read each document's
          // official type from the filing index page and take EX-99.1 (else the first EX-99.x).
          const page = await this.fetchText(`${base}/${r.accessionNumber[i8k]}-index.html`, 'text/html');
          const rows = [...page.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
          const docOf = (re: RegExp) => {
            const row = rows.find((x) => re.test(x));
            return row?.match(/href="[^"]*\/([^"/]+\.html?)"/i)?.[1];
          };
          docName = docOf(/>\s*EX-99\.1\s*</i) ?? docOf(/>\s*EX-99(\.\d+)?\s*</i) ?? docName;
        } catch {
          // fall back to the primary document
        }
        const url = `${base}/${docName}`;
        const text = htmlToText(await this.fetchText(url, 'text/html')).slice(0, MAX_RELEASE_CHARS);
        if (text.length > 500) out.push({ title: `Earnings press release (Form 8-K, Exhibit 99.1)`, date: r.filingDate[i8k], url, text });
      }

      // Latest annual report: 10-K, MD&A section only.
      const i10k = r.form.findIndex((f) => f === '10-K');
      if (i10k >= 0) {
        const acc = r.accessionNumber[i10k].replace(/-/g, '');
        const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/${r.primaryDocument[i10k]}`;
        const full = htmlToText(await this.fetchText(url, 'text/html'));
        const mda = mdaSection(full).slice(0, MAX_MDA_CHARS);
        if (mda.length > 500) out.push({ title: `Annual report (Form 10-K), MD&A`, date: r.filingDate[i10k], url, text: mda });
      }
      return out;
    });
  }
}

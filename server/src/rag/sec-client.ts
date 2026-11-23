import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SecFilingMeta {
  symbol: string;
  cik: string;
  companyName: string;
  form: string;
  filingDate: string; // YYYY-MM-DD
  reportDate?: string; // YYYY-MM-DD
  accessionNumber: string; // with hyphens
  primaryDoc: string;
  sourceUrl: string;
}

export interface SecClientOptions {
  userAgent?: string;
  cacheDir?: string;
  minIntervalMs?: number;
}

export class SecClient {
  readonly userAgent: string;
  readonly cacheDir: string;
  private minIntervalMs: number;
  private static globalLastRequestTime = 0;

  constructor(options: SecClientOptions = {}) {
    this.userAgent = options.userAgent ?? 'TradingMonitor Research/2.0 (contact: admin@jarengjar.com)';
    const baseDir = process.cwd().endsWith('server') ? process.cwd() : path.resolve(process.cwd(), 'server');
    this.cacheDir = options.cacheDir ?? path.resolve(baseDir, 'data', 'sec_filings_cache');
    this.minIntervalMs = options.minIntervalMs ?? 200; // max 5 req/sec (well within SEC 10 req/s limit)
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - SecClient.globalLastRequestTime;
    if (elapsed < this.minIntervalMs) {
      await new Promise((resolve) => setTimeout(resolve, this.minIntervalMs - elapsed));
    }
    SecClient.globalLastRequestTime = Date.now();
  }

  async fetchWithCache(
    url: string,
    cachePath: string,
    accept = 'text/html,application/xhtml+xml,application/json',
    maxAgeMs?: number,
  ): Promise<string> {
    if (fs.existsSync(cachePath)) {
      if (maxAgeMs !== undefined) {
        try {
          const stats = fs.statSync(cachePath);
          if (Date.now() - stats.mtimeMs < maxAgeMs) {
            return fs.readFileSync(cachePath, 'utf8');
          }
        } catch {
          // Fall through to network fetch if stat fails
        }
      } else {
        return fs.readFileSync(cachePath, 'utf8');
      }
    }

    await this.throttle();
    let retries = 3;
    let delay = 1000;

    while (retries > 0) {
      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': this.userAgent,
            Accept: accept,
            'Accept-Encoding': 'gzip, deflate',
          },
          signal: AbortSignal.timeout(30_000),
        });

        if (res.status === 429) {
          retries--;
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay *= 2;
          continue;
        }

        if (!res.ok) {
          throw new Error(`SEC HTTP ${res.status} for ${url}`);
        }

        const text = await res.text();
        const dir = path.dirname(cachePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(cachePath, text, 'utf8');
        return text;
      } catch (err) {
        retries--;
        if (retries === 0) throw err;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      }
    }

    throw new Error(`Failed to fetch ${url} after retries`);
  }

  async getCompanySubmissions(cik: string, maxAgeMs = 24 * 60 * 60 * 1000): Promise<any> {
    const paddedCik = cik.replace(/^0+/, '').padStart(10, '0');
    const url = `https://data.sec.gov/submissions/CIK${paddedCik}.json`;
    const cachePath = path.join(this.cacheDir, 'submissions', `CIK${paddedCik}.json`);
    const jsonStr = await this.fetchWithCache(url, cachePath, 'application/json', maxAgeMs);
    return JSON.parse(jsonStr);
  }

  async getFilingDocument(cik: string, accessionNumber: string, primaryDoc: string): Promise<{ text: string; cachePath: string; url: string }> {
    const numericCik = cik.replace(/^0+/, '');
    const accNoHyphen = accessionNumber.replace(/-/g, '');
    const url = `https://www.sec.gov/Archives/edgar/data/${numericCik}/${accNoHyphen}/${primaryDoc}`;
    const cachePath = path.join(this.cacheDir, numericCik, accessionNumber, primaryDoc);
    const text = await this.fetchWithCache(url, cachePath);
    return { text, cachePath, url };
  }
}

export const secClient = new SecClient();


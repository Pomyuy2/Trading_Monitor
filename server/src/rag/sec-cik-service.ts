import * as fs from 'node:fs';
import * as path from 'node:path';
import { SecClient } from './sec-client.js';

export interface SecCompanyInfo {
  ticker: string;
  cik: string; // 10-digit zero-padded string
  cikNumeric: number;
  companyName: string;
}

/**
 * Built-in frozen fallback mappings for core reference universe and high-volume public tickers.
 * Used for offline execution, unit tests, and instant cache-warm lookups.
 */
export const FROZEN_CIK_FIXTURES: Record<string, { cik: number; name: string }> = {
  NVDA: { cik: 1045810, name: 'NVIDIA CORP' },
  AAPL: { cik: 320193, name: 'Apple Inc.' },
  MSFT: { cik: 789019, name: 'MICROSOFT CORP' },
  TSLA: { cik: 1318605, name: 'TESLA, INC.' },
  AMZN: { cik: 1018724, name: 'AMAZON COM INC' },
  GOOGL: { cik: 1652044, name: 'Alphabet Inc.' },
  GOOG: { cik: 1652044, name: 'Alphabet Inc.' },
  META: { cik: 1326801, name: 'Meta Platforms, Inc.' },
  NFLX: { cik: 1065280, name: 'NETFLIX INC' },
  AMD: { cik: 2488, name: 'ADVANCED MICRO DEVICES INC' },
  INTC: { cik: 50863, name: 'INTEL CORP' },
  PLTR: { cik: 1321655, name: 'Palantir Technologies Inc.' },
  COIN: { cik: 1679788, name: 'Coinbase Global, Inc.' },
  DIS: { cik: 1744489, name: 'Walt Disney Co' },
  JPM: { cik: 19617, name: 'JPMORGAN CHASE & CO' },
  V: { cik: 1403161, name: 'VISA INC.' },
  WMT: { cik: 104169, name: 'Walmart Inc.' },
  FLNC: { cik: 1868944, name: 'Fluence Energy, Inc.' },
};

export class SecCikService {
  private client: SecClient;
  private cachePath: string;
  private tickerMap: Map<string, SecCompanyInfo> = new Map();
  private isLoaded = false;
  private loadPromise: Promise<void> | null = null;

  constructor(client?: SecClient, cacheDir?: string) {
    this.client = client ?? new SecClient();
    const baseDir = cacheDir ?? this.client.cacheDir;
    this.cachePath = path.join(baseDir, 'company_tickers.json');
    this.loadFrozenFixtures();
  }

  private loadFrozenFixtures(): void {
    for (const [sym, info] of Object.entries(FROZEN_CIK_FIXTURES)) {
      const padded = String(info.cik).padStart(10, '0');
      this.tickerMap.set(sym.toUpperCase(), {
        ticker: sym.toUpperCase(),
        cik: padded,
        cikNumeric: info.cik,
        companyName: info.name,
      });
    }
  }

  /**
   * Initializes ticker-to-CIK mapping from local cache or SEC official endpoint.
   */
  async init(): Promise<void> {
    if (this.isLoaded) return;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      try {
        // 1. Check local file cache
        if (fs.existsSync(this.cachePath)) {
          const content = fs.readFileSync(this.cachePath, 'utf8');
          this.parseAndIndex(content);
          this.isLoaded = true;
          return;
        }

        // 2. Fetch from SEC EDGAR official mapping
        const url = 'https://www.sec.gov/files/company_tickers.json';
        const jsonStr = await this.client.fetchWithCache(url, this.cachePath, 'application/json');
        this.parseAndIndex(jsonStr);
        this.isLoaded = true;
      } catch (err: any) {
        // Fallback safely to frozen fixtures if SEC fetch fails
        this.loadFrozenFixtures();
        this.isLoaded = true;
      } finally {
        this.loadPromise = null;
      }
    })();

    return this.loadPromise;
  }

  private parseAndIndex(rawJson: string): void {
    try {
      const parsed = JSON.parse(rawJson);
      for (const key of Object.keys(parsed)) {
        const item = parsed[key];
        if (item && item.ticker && item.cik_str != null) {
          const sym = String(item.ticker).trim().toUpperCase();
          const num = Number(item.cik_str);
          const padded = String(num).padStart(10, '0');
          this.tickerMap.set(sym, {
            ticker: sym,
            cik: padded,
            cikNumeric: num,
            companyName: item.title ? String(item.title).trim() : sym,
          });
        }
      }
    } catch {
      this.loadFrozenFixtures();
    }
  }

  /**
   * Resolves a stock ticker symbol to official SEC CIK metadata.
   * Returns null if the company is not registered with the SEC (e.g. crypto, private, or invalid).
   */
  async resolveTicker(symbol: string): Promise<SecCompanyInfo | null> {
    const clean = symbol.replace(/^\$/, '').trim().toUpperCase();
    if (!clean) return null;

    if (!this.isLoaded) {
      await this.init();
    }

    return this.tickerMap.get(clean) ?? null;
  }

  /**
   * Synchronous lookup if already loaded or in frozen fixtures.
   */
  resolveTickerSync(symbol: string): SecCompanyInfo | null {
    const clean = symbol.replace(/^\$/, '').trim().toUpperCase();
    return this.tickerMap.get(clean) ?? null;
  }

  /**
   * Returns whether a ticker symbol is a supported SEC-registered company.
   */
  async isSupported(symbol: string): Promise<boolean> {
    const info = await this.resolveTicker(symbol);
    return info !== null;
  }

  /**
   * Injects or overrides a mapping (useful for testing).
   */
  setMapping(symbol: string, cik: number, companyName: string): void {
    const sym = symbol.toUpperCase();
    this.tickerMap.set(sym, {
      ticker: sym,
      cik: String(cik).padStart(10, '0'),
      cikNumeric: cik,
      companyName,
    });
  }
}

export const secCikService = new SecCikService();

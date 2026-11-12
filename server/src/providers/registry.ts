import { CAPABILITY_CHAINS, CAPABILITY_FALLBACKS, CAPABILITY_PROVIDERS, type ProviderName } from '../config/providers.js';
import { env } from '../env.js';
import { FinnhubProvider } from './finnhub.js';
import { FmpProvider } from './fmp.js';
import { MockProvider } from './mock/mock-provider.js';
import { SecEdgarProvider } from './sec.js';
import { SetProvider } from './set.js';
import { TwelveDataProvider } from './twelvedata.js';
import { YahooProvider } from './yahoo.js';
import { AlpacaProvider } from './alpaca.js';
import { TiingoProvider } from './tiingo.js';
import type { Capability, MarketDataProvider } from './types.js';

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

export class ProviderRegistry {
  readonly mock: MockProvider;
  private readonly all: Record<ProviderName, MarketDataProvider>;

  constructor(log: Logger = console) {
    this.mock = new MockProvider(env.MOCK_MARKET_STATE);
    this.all = {
      finnhub: new FinnhubProvider(env.FINNHUB_API_KEY, log),
      fmp: new FmpProvider(env.FMP_API_KEY),
      twelvedata: new TwelveDataProvider(env.TWELVEDATA_API_KEY),
      sec: new SecEdgarProvider(env.SEC_USER_AGENT),
      set: new SetProvider(),
      yahoo: new YahooProvider(),
      alpaca: new AlpacaProvider(env.ALPACA_API_KEY_ID, env.ALPACA_API_SECRET_KEY, log),
      tiingo: new TiingoProvider(env.TIINGO_API_KEY, log),
      mock: this.mock,
    };
  }

  private isDemo(): boolean {
    return process.env.DEMO_MODE === 'true';
  }

  /**
   * Ordered fallback chain for a capability.
   * Returns only available, capable providers in priority order.
   * Never injects MockProvider in real-data mode.
   */
  chainFor(cap: Capability): MarketDataProvider[] {
    if (this.isDemo()) {
      return this.mock.supports(cap) ? [this.mock] : [];
    }
    const chainNames = CAPABILITY_CHAINS[cap] ?? [CAPABILITY_PROVIDERS[cap]];
    const realProviders = chainNames
      .map((name) => this.all[name])
      .filter((p): p is MarketDataProvider => !!p && p.supports(cap) && p !== this.mock);

    return realProviders;
  }

  /** Primary provider for a capability, falling back to configured primary or MockProvider in demo mode. */
  for(cap: Capability): MarketDataProvider {
    const chain = this.chainFor(cap);
    if (chain.length > 0) return chain[0];
    if (this.isDemo()) return this.mock;
    const primaryName = CAPABILITY_PROVIDERS[cap];
    const primary = this.all[primaryName];
    if (primary && primary !== this.mock) return primary;
    return this.mock;
  }

  /** Second-choice provider for a capability, if one exists and is usable. */
  fallbackFor(cap: Capability): MarketDataProvider | null {
    const chain = this.chainFor(cap);
    return chain[1] ?? null;
  }

  /** capability → provider name actually in use. */
  routing(): Record<Capability, string> {
    const caps = Object.keys(CAPABILITY_PROVIDERS) as Capability[];
    return Object.fromEntries(caps.map((c) => [c, this.for(c).name])) as Record<Capability, string>;
  }

  /** Names of providers actually in use (for the footer). */
  activeNames(): string[] {
    return [...new Set(Object.values(this.routing()))];
  }

  providerNamed(name: string): MarketDataProvider | undefined {
    return this.all[name.toLowerCase() as ProviderName];
  }

  mockCapabilities(): Capability[] {
    if (!this.isDemo()) return [];
    return (Object.entries(this.routing()) as [Capability, string][]).filter(([, n]) => n === this.mock.name).map(([c]) => c);
  }
}

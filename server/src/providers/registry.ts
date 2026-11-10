import { CAPABILITY_FALLBACKS, CAPABILITY_PROVIDERS, type ProviderName } from '../config/providers.js';
import { env } from '../env.js';
import { FinnhubProvider } from './finnhub.js';
import { FmpProvider } from './fmp.js';
import { MockProvider } from './mock/mock-provider.js';
import { SecEdgarProvider } from './sec.js';
import { SetProvider } from './set.js';
import { TwelveDataProvider } from './twelvedata.js';
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
      mock: this.mock,
    };
  }

  /** Provider for a capability, falling back to MockProvider. */
  for(cap: Capability): MarketDataProvider {
    const p = this.all[CAPABILITY_PROVIDERS[cap]];
    return p.supports(cap) ? p : this.mock;
  }

  /** Fallback provider for a capability, if one is configured and usable (else null). */
  fallbackFor(cap: Capability): MarketDataProvider | null {
    const name = CAPABILITY_FALLBACKS[cap];
    const p = name ? this.all[name] : null;
    return p && p.supports(cap) && p !== this.for(cap) ? p : null;
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

  mockCapabilities(): Capability[] {
    return (Object.entries(this.routing()) as [Capability, string][]).filter(([, n]) => n === this.mock.name).map(([c]) => c);
  }
}

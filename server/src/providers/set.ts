import { BaseProvider, type Capability } from './types.js';

/**
 * Thai SET market data — STUB ONLY.
 *
 * TODO(SET): choose a data source:
 *   - SET SMART Marketplace API (https://www.setsmart.com) — EOD prices, company
 *     profiles, financials. Requires a paid subscription; ask before enabling.
 *   - Settrade Open API (https://developer.settrade.com) — realtime quotes via a
 *     broker account (app ID / app secret / broker ID).
 * TODO(SET): symbols use the ".BK" suffix convention in the UI (e.g. "PTT.BK");
 *   strip it before calling SET APIs.
 * TODO(SET): prices are in THB; set Quote.currency = 'THB'.
 * TODO(SET): market hours are Asia/Bangkok (10:00–12:30, 14:30–16:30) — the
 *   live/closed logic must use these, not US hours.
 * TODO(SET): implement searchSymbols, getQuote, getCandles, subscribe/unsubscribe,
 *   getProfile, getNews (SET news feed), getEarningsCalendar.
 * TODO(SET): add 'set' to the capability map in config/providers.ts, routed by
 *   symbol suffix.
 */
export class SetProvider extends BaseProvider {
  readonly name = 'SET';
  protected readonly capabilities = new Set<Capability>(); // TODO(SET): fill in as methods are implemented

  isAvailable(): boolean {
    return false;
  }
}

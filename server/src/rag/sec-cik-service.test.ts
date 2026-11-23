import { describe, expect, it } from 'vitest';
import { SecCikService, FROZEN_CIK_FIXTURES } from './sec-cik-service.js';

describe('SecCikService — Dynamic Ticker-to-CIK Resolution', () => {
  const service = new SecCikService();

  it('resolves core reference universe tickers immediately via frozen fixtures', async () => {
    const nvda = await service.resolveTicker('NVDA');
    expect(nvda).toBeDefined();
    expect(nvda?.cik).toBe('0001045810');
    expect(nvda?.companyName).toContain('NVIDIA');

    const tsla = await service.resolveTicker('TSLA');
    expect(tsla).toBeDefined();
    expect(tsla?.cik).toBe('0001318605');
    expect(tsla?.companyName?.toUpperCase()).toContain('TESLA');

    const amzn = await service.resolveTicker('AMZN');
    expect(amzn).toBeDefined();
    expect(amzn?.cik).toBe('0001018724');

    const googl = await service.resolveTicker('GOOGL');
    expect(googl).toBeDefined();
    expect(googl?.cik).toBe('0001652044');
  });

  it('handles ticker sanitization (dollar signs, lowercase, whitespace)', async () => {
    const res1 = await service.resolveTicker('$tsla');
    expect(res1?.ticker).toBe('TSLA');
    expect(res1?.cik).toBe('0001318605');

    const res2 = await service.resolveTicker('  aapl  ');
    expect(res2?.ticker).toBe('AAPL');
    expect(res2?.cik).toBe('0000320193');
  });

  it('returns null and false for unsupported tickers (crypto, private, invalid)', async () => {
    const doge = await service.resolveTicker('DOGE-USD');
    expect(doge).toBeNull();
    expect(await service.isSupported('DOGE-USD')).toBe(false);

    const eth = await service.resolveTicker('ETH-USD');
    expect(eth).toBeNull();

    const invalid = await service.resolveTicker('NONEXISTENT_XYZ_123');
    expect(invalid).toBeNull();
    expect(await service.isSupported('NONEXISTENT_XYZ_123')).toBe(false);
  });

  it('supports custom mapping overrides for testing', () => {
    service.setMapping('CUSTOM_CORP', 9999999, 'Custom Corporation');
    const res = service.resolveTickerSync('CUSTOM_CORP');
    expect(res?.cik).toBe('0009999999');
    expect(res?.companyName).toBe('Custom Corporation');
  });
});

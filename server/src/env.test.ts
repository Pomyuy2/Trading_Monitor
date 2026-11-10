import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { envSchema } from './env.js';

/** Parse a .env-style file into an object (no dotenv side effects). */
function parseEnvFile(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((l) => l.match(/^\s*([A-Za-z_]\w*)\s*=\s*(.*)$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => [m[1], m[2]]),
  );
}

describe('server environment', () => {
  it('starts with .env.example copied as-is (empty values fall back to defaults)', () => {
    const example = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.env.example'), 'utf8');
    const env = envSchema.parse(parseEnvFile(example));
    expect(env).toMatchObject({
      PORT: 4000,
      WEB_ORIGIN: 'http://localhost:3000',
      FINNHUB_API_KEY: undefined,
      FMP_API_KEY: undefined,
      TWELVEDATA_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
      SEC_USER_AGENT: 'TradingMonitor personal research app',
      VAPID_SUBJECT: 'mailto:trading-monitor@example.com',
      MOCK_MARKET_STATE: 'open',
    });
  });

  it('trims values and keeps real keys', () => {
    const env = envSchema.parse({ FINNHUB_API_KEY: '  abc123  ', PORT: '4100' });
    expect(env.FINNHUB_API_KEY).toBe('abc123');
    expect(env.PORT).toBe(4100);
  });

  it('rejects an invalid push contact or market state with a clear error', () => {
    expect(() => envSchema.parse({ VAPID_SUBJECT: 'me@example.com' })).toThrow(/mailto/);
    expect(() => envSchema.parse({ MOCK_MARKET_STATE: 'sideways' })).toThrow();
  });
});

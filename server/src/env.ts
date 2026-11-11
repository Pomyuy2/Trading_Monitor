import 'dotenv/config';
import { z } from 'zod';

/** Treat empty / whitespace-only values (e.g. `KEY=` copied from .env.example) as "not set". */
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : typeof v === 'string' ? v.trim() : v);
const opt = <T extends z.ZodTypeAny>(t: T) => z.preprocess(blankToUndefined, t);

export const envSchema = z.object({
  PORT: opt(z.coerce.number().int().positive().default(4000)),
  HOST: opt(z.string().default('0.0.0.0')),
  WEB_ORIGIN: opt(z.string().default('http://localhost:3000')),
  RATE_LIMIT_PER_MIN: opt(z.coerce.number().int().positive().default(300)),
  FINNHUB_API_KEY: opt(z.string().optional()),
  FMP_API_KEY: opt(z.string().optional()),
  TWELVEDATA_API_KEY: opt(z.string().optional()),
  ANTHROPIC_API_KEY: opt(z.string().optional()),
  // Alternative to Claude: any OpenAI-compatible chat endpoint (e.g. a model router). All three are needed.
  AI_BASE_URL: opt(z.string().url().optional()),
  AI_API_KEY: opt(z.string().optional()),
  AI_MODEL: opt(z.string().optional()),
  // SEC asks automated clients to identify themselves (e.g. "Your Name your@email.com").
  SEC_USER_AGENT: opt(z.string().default('TradingMonitor personal research app')),
  // Contact for Web Push (VAPID): a mailto: or https: URL. Push services may reject a placeholder.
  VAPID_SUBJECT: opt(z.string().regex(/^(mailto:|https:)/, 'VAPID_SUBJECT must start with mailto: or https:').default('mailto:trading-monitor@example.com')),
  MOCK_MARKET_STATE: opt(z.enum(['open', 'closed', 'delayed']).default('open')),
});

export const env = envSchema.parse(process.env);

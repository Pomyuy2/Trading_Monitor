import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default('0.0.0.0'),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  RATE_LIMIT_PER_MIN: z.coerce.number().default(300),
  FINNHUB_API_KEY: z.string().optional().transform((v) => v || undefined),
  FMP_API_KEY: z.string().optional().transform((v) => v || undefined),
  TWELVEDATA_API_KEY: z.string().optional().transform((v) => v || undefined),
  ANTHROPIC_API_KEY: z.string().optional().transform((v) => v || undefined),
  // SEC asks automated clients to identify themselves (e.g. "Your Name your@email.com").
  SEC_USER_AGENT: z.string().default('TradingMonitor personal research app'),
  // Contact for Web Push (VAPID). Push services may reject a placeholder; use your own mailto: or https: URL.
  VAPID_SUBJECT: z.string().default('mailto:trading-monitor@example.com'),
  MOCK_MARKET_STATE: z.enum(['open', 'closed', 'delayed']).default('open'),
});

export const env = schema.parse(process.env);

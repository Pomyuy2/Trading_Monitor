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
  MOCK_MARKET_STATE: z.enum(['open', 'closed', 'delayed']).default('open'),
});

export const env = schema.parse(process.env);

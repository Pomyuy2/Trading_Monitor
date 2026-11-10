/**
 * Server for the Playwright smoke test (started by playwright.config.ts):
 * - demo data only: provider keys are blanked, so MockProvider serves everything (no API calls)
 * - its own port (4100) and a fresh database (server/data/e2e.db), so it never touches your real app
 */
import { PrismaClient } from '@prisma/client';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbFile = join(root, 'data', 'e2e.db');

// Blank keys BEFORE the app loads .env (dotenv never overrides variables that already exist).
Object.assign(process.env, {
  FINNHUB_API_KEY: '',
  FMP_API_KEY: '',
  TWELVEDATA_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  PORT: process.env.E2E_SERVER_PORT ?? '4100',
  WEB_ORIGIN: process.env.E2E_WEB_ORIGIN ?? 'http://localhost:3100',
  RATE_LIMIT_PER_MIN: '5000',
  MOCK_MARKET_STATE: 'open',
  TM_DATABASE_URL: `file:${dbFile.replace(/\\/g, '/')}`,
});

// Fresh database from the committed migrations.
mkdirSync(dirname(dbFile), { recursive: true });
for (const f of [dbFile, `${dbFile}-journal`]) if (existsSync(f)) rmSync(f);
const setup = new PrismaClient({ datasourceUrl: process.env.TM_DATABASE_URL });
const migrations = join(root, 'prisma', 'migrations');
for (const m of readdirSync(migrations).filter((d) => !d.endsWith('.toml')).sort()) {
  const sql = readFileSync(join(migrations, m, 'migration.sql'), 'utf8');
  for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) await setup.$executeRawUnsafe(stmt);
}
await setup.$disconnect();

await import('../src/index.js');

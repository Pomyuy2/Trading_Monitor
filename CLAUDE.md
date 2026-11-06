# Trading Monitor — project notes for Claude Code

Personal stock-monitoring web app (EN / TH). The spec and phase plan live in
`trading-monitor-prompt.md` — treat it as the source of truth and update it when the user adds
phases or features. This file records what has been built, the decisions behind it, and how to work here.

## Working agreements (from the user)

- Work **phase by phase**. After each phase: run it, verify it (screenshots of the real app), then
  stop and show the user before starting the next phase.
- **Always commit and push** to `origin/main` after finished work, and **never** add a
  "Co-Authored-By: Claude" (or any Claude attribution) line to commits or PRs.
- Before committing: make sure `server/.env` and `*.db` are not staged, and grep the staged files for
  the API key values.
- **Ask before adding any paid service** or changing the stack.
- Never invent data: missing values show "—" plus a short note. Support/resistance and alert wording
  stays neutral — never "buy" / "sell".
- All UI text in English and Thai (`web/messages/en.json`, `th.json`); Thai dates use
  `th-TH-u-ca-gregory` (Western years).
- The user works on two PCs and syncs through GitHub. The SQLite database is per-PC (not in git).

## Status (as of 2026-11-06)

| Phase | State |
|---|---|
| 1 Scaffold + mock data | done |
| 2 Live prices + chart history | done — live ticks verified in pre-market (NVDA); regular-session check not yet confirmed |
| 3 News + AI summary + sentiment | done — AI is **off** (no `ANTHROPIC_API_KEY`); keyword-rule sentiment, summary box says AI is off |
| 3.5 Support & resistance + pivots | done |
| 4 Company insight | done — guidance extraction needs the Anthropic key; without it the card links the SEC filings |
| 5 Watchlist, search, alerts (+ level alerts) | done |
| 5.5 Comfort features | done (prefs, crosshair tooltip, market status bar, E/D markers, compare ×2 + SPY, light theme, shortcuts, PWA + push) |
| **6 Polish** | **next**: loading/error-state pass, unit tests for provider adapters (recorded responses) + range mapping, Playwright smoke test (mock data), full README (setup, API keys, free-plan limits) |

Open items / not yet verified:
- Claude features (news summary, AI sentiment, guidance extraction + Thai translation) are built and
  type-checked against the SDK but have **never run**: the user has a Claude subscription, not an API
  key, and chose to run without AI for now. When a key is added, test them first.
- Web Push: service worker + server sending are built; Chrome reports the app installable, but push
  hasn't been verified end to end with an installed app. Phone install needs HTTPS.
- `SetProvider` (Thai SET stocks) is a stub with TODOs.
- Decisions taken by default (user didn't pick): analyst "next-year" estimates = the fiscal year in
  progress; news card height on desktop (it scrolls inside, under the Key levels card).

## Run, test, check

```bash
npm i -g pnpm@10          # corepack enable fails on Windows (Program Files is read-only)
pnpm install              # Node >= 20 (developed on Node 24)
cp server/.env.example server/.env   # then add keys
pnpm dev                  # web http://localhost:3000, server http://localhost:4000
pnpm --filter server test # vitest, 58 tests
cd server && npx tsc --noEmit ; cd ../web && npx tsc --noEmit
```

`server/.env`: `FINNHUB_API_KEY`, `FMP_API_KEY`, `TWELVEDATA_API_KEY`, `ANTHROPIC_API_KEY` (optional),
`SEC_USER_AGENT`, `VAPID_SUBJECT`, `MOCK_MARKET_STATE` (mock only). Each missing key falls back to
`MockProvider` (or turns its AI feature off). Tip for testing alerts any time: comment out
`FINNHUB_API_KEY` → mock prices tick 24/7.

## Architecture

pnpm monorepo:
- `shared/` — types, range → candle size, `bucketStart`, `market-hours.ts` (NYSE holidays, half days,
  DST by rule).
- `server/` — Fastify 5 + tsx. `src/index.ts` (routes, WS, wiring), `providers/` (adapter per vendor,
  `types.ts` interface, `registry.ts`), `config/providers.ts` (capability → provider map),
  `config/cache-ttl.ts`, `services/market-service.ts` (caching, stale fallback, AI routing, levels,
  insight, events), `realtime/hub.ts` (one upstream WS, fan-out, 1 msg/s/symbol throttle),
  `analysis/levels.ts` (support/resistance), `alerts/alert-service.ts`, `push/push-service.ts`,
  `ai/` (Claude, keyword fallback, mock, guidance schema + quote check), `cache/` (LRU + SQLite cache
  for AI outputs), `store/` (Prisma).
- `web/` — Next.js 15 App Router, Tailwind 4 (theme tokens are CSS variables in `globals.css`, light
  theme overrides under `[data-theme=light]`), next-intl 4 (cookie `NEXT_LOCALE`, no i18n routing),
  lightweight-charts 5 (`PriceChart.tsx`, zones primitive in `level-zones.ts`), SWR (`lib/api.ts`),
  live WebSocket client (`lib/live.ts`), prefs in localStorage + cookie (`lib/prefs.ts`), PWA
  (`app/manifest.ts`, `app/icons/[size]/route.tsx`, `public/sw.js`, `lib/pwa.ts`).
- The browser calls only our server: Next rewrites `/api/*` → `:4000`; the WebSocket connects to
  `ws://<host>:4000/ws` (origin-checked). Fastify `trustProxy: 'loopback'` so per-IP rate limits work.

API: `/api/search`, `quote/:s` (`?detail=1` adds volume), `candles/:s?range=`, `levels/:s?range=`,
`events/:s`, `news/:s?lang=`, `insight/:s?lang=`, `watchlist` (GET/POST/DELETE `/:s`), `alerts`
(GET/POST, DELETE `/:id`, POST `/:id/seen`), `push/key|subscribe|unsubscribe`, `meta`, `health`, `WS /ws`.

## Data providers (all free plans) — routing in `server/src/config/providers.ts`

| Provider | Used for | Limits / notes |
|---|---|---|
| Finnhub | quotes, live trades WS, search, company news, market status | 60 calls/min, 1 WS per key. Executives and candles are paid (403). Quote shows the previous close before the open. |
| Twelve Data | intraday candles 1H/1D/1W/1M | 8 calls/min, 800/day. Local limiter refuses a 9th call/min; 429s are not retried. Cache 1 min while trading, 30 min when idle. Hourly bars start at :30. |
| FMP (`/stable` API) | daily candles (one 5-year call/hour serves 6M/1Y/5Y), today's volume, profile + key executives, estimates, price-target consensus, grades consensus, earnings (`limit` ≤ 5, else 402), dividends | 250 calls/day. Intraday charts and transcripts are paid (402). No "founded" year and no exec start years → shown as "—". |
| SEC EDGAR | guidance source documents: latest 8-K Item 2.02 Exhibit 99.1 (found via the filing index page's document types) + 10-K MD&A | No key; send `SEC_USER_AGENT`. |
| Anthropic | `claude-sonnet-5-5` via `@anthropic-ai/sdk` `messages.parse` + `zodOutputFormat` (`zod/v4`); effort low (summary/sentiment/translate), medium (guidance) | Optional. Guidance fields are dropped unless their quote appears verbatim in the filing. |
| Mock | fixtures for 10 US symbols, ticks 24/7 | Fallback whenever a key is missing. |

## Storage

SQLite via Prisma 6 at `server/data/trading.db` (git-ignored, per PC). Models: `WatchlistItem`,
`Alert`, `AiCache` (AI outputs survive restarts), `Setting` (watchlist seeded flag, VAPID keys),
`PushSubscription`. Migrations are committed; `pnpm dev` runs `prisma migrate deploy` + `prisma generate`.
New migration: `cd server && npx prisma migrate dev --name <name>` (stop the dev server first).

## Gotchas learned the hard way

- **Windows + Prisma:** a running server locks the Prisma engine DLL, so `prisma generate` / installs
  fail (EPERM). Stop the dev server first. Killing only the process on port 4000 is not enough — the
  `tsx watch` / `pnpm dev` parents restart it; kill the whole tree (match command lines containing
  `Trading_Monitor`). Don't touch the user's other projects (e.g. `D:\DataPipeline`).
- `tsx watch` can start the server twice on rapid saves → `EADDRINUSE` on the second copy (harmless;
  graceful shutdown is in place).
- Writing source through bash heredocs / `node -e` mangled regex escapes (`\s`, `\b` became `s` and a
  backspace character) and sometimes failed to parse. Use the editor tools or a script file, then grep
  for control characters.
- Alerts validate against the latest live trade, not the REST quote (the quote lags before the open).
- Live candle updates step from the last bar's own start time (provider bar alignment varies).
- 1D "change" is measured from the previous close; compare mode uses the first candle's close for all
  lines (same as the % axis).
- News from Finnhub includes market-wide stories; the service keeps articles that mention the ticker
  or company name (falls back to all if fewer than 5).

## Verifying UI changes

Previous sessions drove headless Chrome over the DevTools protocol to screenshot desktop (1440 px) and
phone (390 px) layouts in EN and TH, check for console errors and horizontal overflow, simulate hovers,
and run Chrome's installability check. Phase 6 should turn this into a committed Playwright smoke test.

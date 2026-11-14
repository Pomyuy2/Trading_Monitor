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

## Status (as of 2026-11-10)

| Phase | State |
|---|---|
| 1 Scaffold + mock data | done |
| 2 Live prices + chart history | done — live ticks verified in pre-market (NVDA); regular-session check not yet confirmed |
| 3 News + AI summary + sentiment | done — AI **on via a model router** since 2026-11-11 (`AI_*` in `server/.env`, model `combo1`); keyword rules while the AI works / if it fails |
| 3.5 Support & resistance + pivots | done |
| 4 Company insight | done — guidance extraction runs through the router (verified: NVDA revenue outlook, quote-checked); without AI the card links the SEC filings |
| 5 Watchlist, search, alerts (+ level alerts) | done |
| 5.5 Comfort features | done (prefs, crosshair tooltip, market status bar, E/D markers, compare ×2 + SPY, light theme, shortcuts, PWA + push) |
| 6 Polish | done: error states by cause + connection/offline banner, provider adapter tests on recorded responses, Playwright smoke test (desktop + phone, demo data), full README |

| 7 Fast, always-ready app | done: `scripts/run.mjs` (`pnpm app:*`) — production build in `web/.next-prod`, background supervisor with crash restart + logs in `logs/`, startup pre-warm of watchlist caches, optional Windows autostart (Startup-folder .vbs) |
| 8 Watchlist upgrades | done: 1-month sparklines (`/api/sparklines`, batch `/api/quotes`), up/down summary, sort (saved pref `tm_wlsort`), edit-order mode with pointer drag + arrow keys (`PUT /api/watchlist/order`), groups via the row ⋯ menu (`PATCH /api/watchlist/:s`, collapse state in localStorage). Also: Twelve Data fallback for daily candles, `notInPlan` caching, per-provider 429 back-off |
| 8.5 AI via router + summary panel | done (2026-11-11): `RouterAi`, AI work in the background (`aiJob`), `AiSummaryPanel` under the price header (grid area `summary`), summary keyed by the set of last-24 h article ids (new article → new summary; unchanged → none; hourly refresh for the price-move wording), previous summary shown with `summaryUpdating`, news list re-checked every 2 min |
| 8.6 Auth, sign-up, Docker, Yahoo | done on the other PC (see git log): Auth.js login + invite-code sign-up, per-user data, encrypted emails, Docker Compose, Yahoo Finance for candles |
| 9 Ask AI about any stock + layout | done (2026-11-14): `ai/ask-resolver.ts` finds tickers / company names / "watchlist" in the question (all-caps words checked with the quote provider, "not found" remembered 6 h); `MarketService.ask` looks up ≤3 stocks; `POST /api/ai/resolve` feeds the preview line; chat kept in `lib/ask-ai-store.ts` across stock pages. News card full width in two columns + "Show more"; Key stats full-width row |
| **Next** | ask the user (ideas in the prompt's "Later ideas": phone alerts via LINE/email/ntfy, portfolio, HTTPS, SET). The Playwright suite predates the login wall and fails at sign-in — needs a test account step |

Phone alerts: the user does **not** use Telegram; candidates are LINE Official Account, email or the ntfy app (deferred).

Open items / not yet verified:
- AI: the user has no Anthropic API key; AI runs through an OpenAI-compatible router the user provided
  (`AI_BASE_URL`/`AI_API_KEY`/`AI_MODEL` → `server/src/ai/router-ai.ts`). Summary, sentiment, guidance and Thai
  translation are verified through it. The direct Claude path (`anthropic-ai.ts`, used when `ANTHROPIC_API_KEY`
  is set, takes precedence) is type-checked but has never run.
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
pnpm dev                  # development: web http://localhost:3000, server http://localhost:4000
pnpm app:start            # everyday: production build in the background (see README); app:stop/status/logs/update
pnpm test                 # vitest: 131 unit/integration tests, no network
pnpm test:e2e             # Playwright smoke test (32 run + 8 phone-skipped), own ports 3100/4100 + own DB
cd server && npx tsc --noEmit ; cd ../web && npx tsc --noEmit
```

`server/.env`: `FINNHUB_API_KEY`, `FMP_API_KEY`, `TWELVEDATA_API_KEY`, `ANTHROPIC_API_KEY` (optional) or
`AI_BASE_URL` + `AI_API_KEY` + `AI_MODEL` (optional OpenAI-compatible router),
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
`events/:s`, `news/:s?lang=`, `insight/:s?lang=`, `ai/ask` (POST: question, context chips, pageSymbol, history),
`ai/resolve` (POST: which stocks a question would look up), `watchlist` (GET/POST/DELETE `/:s`), `alerts`
(GET/POST, DELETE `/:id`, POST `/:id/seen`), `push/key|subscribe|unsubscribe`, `meta`, `health`, `WS /ws`.

## Data providers (all free plans) — routing in `server/src/config/providers.ts`

| Provider | Used for | Limits / notes |
|---|---|---|
| Finnhub | quotes, live trades WS, search, company news, market status | 60 calls/min, 1 WS per key. Executives and candles are paid (403). Quote shows the previous close before the open. |
| Twelve Data | intraday candles 1H/1D/1W/1M | 8 calls/min, 800/day. Local limiter refuses a 9th call/min; 429s are not retried. Cache 1 min while trading, 30 min when idle. Hourly bars start at :30. |
| FMP (`/stable` API) | daily candles (one 5-year call/hour serves 6M/1Y/5Y), today's volume, profile + key executives, estimates, price-target consensus, grades consensus, earnings (`limit` ≤ 5, else 402), dividends | 250 calls/day. Intraday charts and transcripts are paid (402). No "founded" year and no exec start years → shown as "—". |
| SEC EDGAR | guidance source documents: latest 8-K Item 2.02 Exhibit 99.1 (found via the filing index page's document types) + 10-K MD&A | No key; send `SEC_USER_AGENT`. |
| Anthropic | `claude-sonnet-5-5` via `@anthropic-ai/sdk` `messages.parse` + `zodOutputFormat` (`zod/v4`); effort low (summary/sentiment/translate), medium (guidance) | Optional. Guidance fields are dropped unless their quote appears verbatim in the filing. |
| Model router (OpenAI-compatible) | `RouterAi`: `/chat/completions` via fetch; same prompts (`ai/prompts.ts`); JSON Schema put in the system prompt, answer parsed + zod-validated, one retry | Optional, used when no Anthropic key. The user's router (`combo1`) currently maps to a Gemini Flash model. |
| Mock | fixtures for 10 US symbols, ticks 24/7 | Fallback whenever a key is missing. |

## Storage

SQLite via Prisma 6 at `server/data/trading.db` (git-ignored, per PC). Models: `WatchlistItem`,
`Alert`, `AiCache` (AI outputs survive restarts), `Setting` (watchlist seeded flag, VAPID keys),
`PushSubscription`. Migrations are committed; `pnpm dev` runs `prisma migrate deploy` + `prisma generate`.
New migration: `cd server && npx prisma migrate dev --name <name>` (stop the dev server first).

## Gotchas learned the hard way

- **Windows drive-letter case:** building from a shell whose path is `d:Trading_Monitor` (lower case) made webpack bundle
  Next twice (`d:…` and `D:…`) → every page crashed with "invariant expected layout router to be mounted" (build log:
  "Compiled with warnings" listing both paths). `scripts/run.mjs` now upper-cases the drive letter and `chdir`s. If it ever
  happens with `pnpm dev`, open the terminal at `D:Trading_Monitor`.
- `pnpm dev` and the background app (`pnpm app:start`) both use ports 3000/4000 — only one at a time.
  `app:start` refuses if the ports are busy; `app:status` tells which is running. When the user runs the
  background app, restart it after code changes with `pnpm app:update` (rebuild) — it does not hot-reload.

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
- `.env` values copied empty from `.env.example` must fall back to defaults (`server/src/env.ts` treats blank as
  unset; `env.test.ts` guards this) — an empty `VAPID_SUBJECT` used to crash startup.
- `ConnectionBanner`: SWR keeps the last good `data` after a failed check, so use `error` alone to decide
  "server down". Every server capability needs an `app.mockSections.<capability>` label in en/th.
- **FMP free plan doesn't cover every symbol** (RKLB, FLNC → 402 on everything but the profile). `withFallback`
  routes `dailyCandles` to Twelve Data (`CAPABILITY_FALLBACKS`) on 402 *or* 429; analyst/stats/events answer
  `meta.note = 'notInPlan'` (cached 12 h, UI says "not included in the free plan").
- **FMP's 250 calls/day run out** on heavy test days (429 "Limit Reach", no Retry-After). `getJson` keeps a
  per-provider back-off (1 min doubling to 30 min) and fails fast while blocked — before that, every request
  waited ~2.5 s in inline retries. Tests call `resetRateLimits()`.
- Never pipe Playwright output through `head` (it kills the run before teardown and leaves servers on
  3100/4100); write to a log file in the scratchpad. The background app does not see code changes until
  `pnpm app:update`; stop it before Prisma migrations (DLL lock).
- WatchlistItem has `position` + `group`; the order migration back-fills positions from `addedAt`.
- **AI is slow on first use** (router: 15–45 s for a stock's sentiment + summary). `MarketService.aiJob` runs AI work in the
  background and waits only 6 s (news) / 15 s (guidance); responses then carry `aiPending` / status `'pending'` and SWR polls
  every 5 s. Failed jobs cool down 5 min. Next's rewrite proxy times out at 30 s by default → `experimental.proxyTimeout`.
- The router **always streams** (SSE), even without `stream: true`, injects ~2.8k tokens of its own prompt, and doesn't
  enforce JSON schemas — `readCompletion` / `extractJson` handle all three.
- News from Finnhub includes market-wide stories; the service keeps articles that mention the ticker
  or company name (falls back to all if fewer than 5).

## Verifying changes

- `pnpm test` — unit/integration tests. Provider adapters are tested against recorded real responses in
  `server/test/fixtures/` (fetch is stubbed; unknown URLs throw). Re-record only if a provider changes its
  format (keep fixtures trimmed and key-free).
- `pnpm test:e2e` — `e2e/smoke.spec.ts`, desktop (1440 px) + phone (390 px). `playwright.config.ts` starts
  its own server (`server/scripts/e2e-server.ts`: blank keys → demo data, port 4100, fresh `server/data/e2e.db`
  via `TM_DATABASE_URL`) and `next dev -p 3100` with `NEXT_DIST_DIR=.next-e2e`, so it runs alongside the
  user's `pnpm dev` without touching their data. Uses installed Google Chrome (`PW_CHANNEL` to change).
  It already caught real bugs (missing i18n keys, banner logic) — run it after UI changes.
- For visual checks, screenshots of desktop and phone in EN and TH are still worth taking and showing.

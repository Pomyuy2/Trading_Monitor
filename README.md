# Trading Monitor

Personal stock-monitoring web app (EN / TH). Monorepo:

| Folder | What |
|---|---|
| `web/` | Next.js 15 (App Router, TypeScript, Tailwind 4, next-intl, lightweight-charts) |
| `server/` | Fastify 5 (TypeScript): REST API, WebSocket price relay, provider adapters, cache |
| `shared/` | Types and range → candle-size mapping used by both |

## Run

```bash
pnpm install
pnpm dev        # web on http://localhost:3000, server on http://localhost:4000
```

No API keys are needed: every capability falls back to `MockProvider` (fake data, labelled "Mock" in the UI).
Optional: copy `server/.env.example` to `server/.env` and add keys (`FINNHUB_API_KEY`, `FMP_API_KEY`, `TWELVEDATA_API_KEY`, `ANTHROPIC_API_KEY`); each missing key falls back to mock data or turns its AI feature off.

Mock-only switch to preview market states: `MOCK_MARKET_STATE=open | closed | delayed` in `server/.env`.

Storage: SQLite at `server/data/trading.db` (git-ignored), created and migrated automatically by `pnpm dev`.
Holds the watchlist, alerts and cached AI outputs.

## Where things live

- Provider interface: `server/src/providers/types.ts`
- Which provider serves which capability: `server/src/config/providers.ts`
- Cache interface + in-memory LRU (swap for Redis later): `server/src/cache/cache.ts`
- Cache lifetimes: `server/src/config/cache-ttl.ts`
- WebSocket fan-out + 1 update/s/symbol throttle: `server/src/realtime/hub.ts`
- Alert engine: `server/src/alerts/alert-service.ts`
- Database schema: `server/prisma/schema.prisma`
- UI strings: `web/messages/en.json`, `web/messages/th.json`

## Status

- [x] Phase 1: scaffold + mock data
- [x] Phase 2: live prices (Finnhub) + chart history (Twelve Data intraday, FMP daily) — live ticks verified in pre-market
- [x] Phase 3: news + sentiment (AI summary/sentiment need `ANTHROPIC_API_KEY`; without it, keyword-rule sentiment)
- [x] Phase 3.5: support & resistance levels + pivot points
- [x] Phase 4: company insight (FMP profile/estimates/targets/ratings/earnings; guidance from SEC filings, extracted by Claude when `ANTHROPIC_API_KEY` is set)
- [x] Phase 5: watchlist (SQLite/Prisma), search, price + level alerts with browser notifications
- [x] Phase 5.5: comfort features (saved preferences, crosshair tooltip, market status bar, earnings/dividend markers, compare up to 2 + SPY, light theme, keyboard shortcuts, installable PWA with push alerts)
- [ ] Phase 6: polish, tests, full README

## Keyboard shortcuts

`/` search · `1`–`7` chart range · `L` levels · `P` pivots · `C` compare · `?` help (ignored while typing).

## Install as an app (PWA)

- Desktop (Chrome / Edge): open http://localhost:3000 and click the install icon in the address bar.
- Phone: installing and push notifications require **HTTPS** (browsers only allow them on secure origins or localhost).
  Opening the app over your LAN IP (http://192.168.x.x:3000) works as a website, but cannot be installed.
- In the installed app, price alerts also arrive as push notifications while the app is closed (the server must be running).
  Push keys are generated automatically; set `VAPID_SUBJECT=mailto:you@example.com` in `server/.env`.

## Tests

```bash
pnpm --filter server test
```

Data may be delayed. Not investment advice.

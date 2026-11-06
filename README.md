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
Optional: copy `server/.env.example` to `server/.env`.

Mock-only switch to preview market states: `MOCK_MARKET_STATE=open | closed | delayed` in `server/.env`.

## Where things live

- Provider interface: `server/src/providers/types.ts`
- Which provider serves which capability: `server/src/config/providers.ts`
- Cache interface + in-memory LRU (swap for Redis later): `server/src/cache/cache.ts`
- Cache lifetimes: `server/src/config/cache-ttl.ts`
- WebSocket fan-out + 1 update/s/symbol throttle: `server/src/realtime/hub.ts`
- UI strings: `web/messages/en.json`, `web/messages/th.json`

## Status

- [x] Phase 1: scaffold + mock data
- [ ] Phase 2: live prices (Finnhub) + chart history (FMP)
- [ ] Phase 3: news + AI summary + sentiment
- [ ] Phase 4: company insight + guidance extraction
- [ ] Phase 5: watchlist (SQLite/Prisma), search, price alerts
- [ ] Phase 6: polish, tests, full README

Data may be delayed. Not investment advice.

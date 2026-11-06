# Build: Trading Monitor web app (EN / TH)

You are building a personal stock-monitoring web app. Work in phases (bottom of this file). After each phase, run it, check it works, and stop to show me before starting the next one.

## What the app does

For any stock I pick, one screen shows:

1. **Price header**: live price, change today ($ and %), "Live · updated HH:MM:SS" clock, buttons for "Set price alert" and "Compare".
2. **Chart** with range buttons 1H, 1D, 1W, 1M, 6M, 1Y, 5Y. It updates in real time while the market is open. It also shows the price change over the selected range.
3. **Key stats** under the chart: open, day high/low, previous close, volume, average volume, market cap, P/E (TTM), 52-week range, dividend yield.
4. **News panel**: a short AI-written summary of what's moving the stock (in the current language), then the latest headlines with source, time ago, and a Positive / Negative / Neutral tag.
5. **Company insight**, three cards:
   - Leadership & profile: CEO (with start year), CFO, HQ, founded, employees, one-line business description.
   - Next-year plan & guidance: revenue guidance, EPS guidance, capex budget, R&D budget, top 3 strategic priorities. These come from the latest earnings-call transcript or annual report.
   - Analyst expectations: next-year revenue and EPS estimates, 12-month price target (low / average / high), Buy / Hold / Sell counts, next earnings date.
6. **Watchlist** sidebar (add/remove symbols, each with price and % change) and a **search box** for ticker or company name.
7. **Language switch EN / TH** in the header. It translates all UI text, and the AI summaries are generated in the selected language.

Every number or card shows its **source and last-updated time**. If data is missing, show "—" and a short note. Never invent values.

## Look and feel

Dark trading-terminal style:
- Background `#0B0E13`, panels `#151A21`, borders `#222935`, text `#E6EAF0`, muted text `#9AA4B2`.
- Accent blue `#4C8DFF` / button `#2B5BC4`, up `#3DDC97`, down `#FF7B7B`.
- Always show a +/− sign and an up/down arrow, so direction isn't shown by color alone.
- Fonts: Inter for text, IBM Plex Sans Thai as fallback for Thai, JetBrains Mono for all numbers.
- Layout on desktop: watchlist on the left; chart card (wide) and news card side by side; the three insight cards in a row below.
- On a phone: single column. The chart is on top, then the range buttons, then tabs for News / Insight / Stats.
- Minimum touch target 44 px. Text contrast at least 4.5:1. Real `<button>`s with labels.

## Tech stack

- **Monorepo** with two apps:
  - `web/`: Next.js (App Router, TypeScript, Tailwind).
  - `server/`: Node + Fastify (TypeScript). The browser never talks to data providers directly.
- **Chart**: TradingView `lightweight-charts`.
- **Realtime**: the server keeps ONE upstream WebSocket to the price provider and fans updates out to browsers over its own WebSocket. Throttle to at most 1 update per second per symbol, and update the last candle in place.
- **Cache**: in-memory LRU for now, behind an interface so Redis can be swapped in later. Suggested cache times:
  - quotes: 5 s
  - intraday candles: 1 min
  - daily candles: 1 h
  - news: 5 min
  - profile: 1 day
  - estimates: 12 h
  - guidance: until the next earnings date
- **Storage**: SQLite (Prisma) for watchlist, alerts, and cached AI outputs.
- **i18n**: `next-intl` with `en.json` / `th.json`. Save the chosen language in a cookie.
  - Format numbers and dates with `Intl`.
  - For Thai use `th-TH-u-ca-gregory`, so years stay Western (2027, not 2570).
  - Short Thai range labels: 1 ชม., 1 วัน, 1 สป., 1 ด., 6 ด., 1 ปี, 5 ปี.
- **AI**: Anthropic API, model `claude-sonnet-5-5`, called only from the server.

## Data providers (behind an adapter interface)

Create a `MarketDataProvider` interface with methods:

- `searchSymbols`
- `getQuote`
- `getCandles(symbol, range)`
- `subscribe(symbols)` / `unsubscribe(symbols)`
- `getProfile`
- `getNews`
- `getEstimates`
- `getPriceTargets`
- `getRatings`
- `getEarningsCalendar`
- `getLatestTranscript`

Implement these providers:

- `FinnhubProvider`: live trades over WebSocket, quotes, company profile and executives, company news, symbol search.
- `FmpProvider` (Financial Modeling Prep): historical and intraday candles, key stats, analyst estimates, price targets, ratings, earnings calendar, earnings-call transcripts.
- `MockProvider`: realistic fixture data so the whole UI works with no API keys. Use it in tests and as the fallback.
- `SetProvider` (stub only for now): for Thai SET stocks later, via the SET SMART Marketplace API or Settrade Open API. Leave clear TODOs.

A config file maps each capability to a provider, so I can change providers without touching UI code.

Range → candle size:

| Range | Candle size |
|---|---|
| 1H | 1-min |
| 1D | 5-min |
| 1W | 30-min |
| 1M | 1-hour |
| 6M | daily |
| 1Y | daily |
| 5Y | weekly |

Handle these states:

- If the provider only gives delayed data on my plan, show a "Delayed 15 min" badge instead of "Live".
- When the market is closed, show "Market closed · last close" and stop the live dot.
- On a provider rate-limit (HTTP 429), back off and retry. Serve cached data with a "stale" note rather than an error.
- Reconnect the upstream WebSocket with exponential backoff (1 s → 30 s max).

## AI features (server-side, cached)

1. **News summary**: input is the last 24 h of headlines and snippets for a symbol. Output is 2–3 sentences on what's moving the stock and the main risk, in EN or TH. Also return the number of articles used. Cache per symbol + language for 15 min.
2. **Sentiment tags**: classify each headline as positive / negative / neutral. Batch the headlines in one call.
3. **Guidance extraction**: input is the latest earnings-call transcript (and 10-K text if available).
   - Output strict JSON: `{ revenueGuidance, epsGuidance, capexBudget, rndBudget, priorities[3], fiscalYear, sourceTitle, sourceDate }`.
   - Each field also carries a short supporting quote.
   - Fields not stated in the source are `null`, never guessed.
   - Validate with zod. Cache until the next earnings date.
   - Translate the display text to Thai on request and cache the translation separately.

## Security and config

- All keys in `server/.env`: `FINNHUB_API_KEY`, `FMP_API_KEY`, `ANTHROPIC_API_KEY`. Commit a `.env.example`. Never expose keys to the browser.
- Add a basic per-IP rate limit on the server API.
- Add a footer: "Data from [providers]. May be delayed. Not investment advice." (translated).

## Server API (for the web app)

- `GET /api/search?q=`
- `GET /api/quote/:symbol`
- `GET /api/candles/:symbol?range=1D`
- `GET /api/news/:symbol?lang=en`
- `GET /api/insight/:symbol?lang=en` (profile + guidance + estimates)
- `GET/POST/DELETE /api/watchlist`
- `WS /ws` with messages `{type:"subscribe", symbols:[...]}` and `{type:"tick", symbol, price, ts}`

## Phases

1. **Scaffold + mock data.**
   - Monorepo, both apps run with one command (`pnpm dev`).
   - Full UI built to the design above using `MockProvider`, including the EN/TH switch and mobile layout.
   - Done when every section renders with fake data and the range buttons change the chart.
2. **Live prices + chart history.** Finnhub WebSocket relay, FMP candles for all 7 ranges, live/delayed/closed states. Done when a real US ticker (e.g. AAPL) ticks live during market hours and all ranges load.
3. **News + AI summary + sentiment**, in both languages.
4. **Company insight**: profile, estimates, price targets, ratings, guidance extraction with sources.
5. **Watchlist, search, price alerts.** Alerts are checked on the server; a browser notification fires when one triggers.
6. **Polish:**
   - Loading skeletons and error states.
   - Unit tests for the provider adapters, range mapping and the guidance JSON schema.
   - Playwright smoke test.
   - A README covering setup, getting API keys, and the free-plan limits of each provider.

Start with Phase 1. Ask me before adding any paid service or changing the stack.

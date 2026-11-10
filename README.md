# Trading Monitor

A personal stock-monitoring web app in **English and Thai**. For any US stock, one screen shows the
live price, an interactive chart, support & resistance levels, key stats, news with sentiment, company
insight (leadership, guidance, analyst expectations), a watchlist and server-side price alerts.
It runs on your own PC with free data plans, and works without any API keys in demo mode.

> Data may be delayed. Not investment advice.

## Features

- **Live price** with "Live · updated HH:MM:SS", or "Delayed 15 min" / "Market closed · last close"; a
  **market status bar** ("Open · closes in 2h 15m") that knows US holidays, half days and daylight saving.
- **Chart** (1H, 1D, 1W, 1M, 6M, 1Y, 5Y) that updates in real time; line or candles; crosshair tooltip
  with OHLC, volume and % change; **E** (earnings) and **D** (dividend) markers; **Compare** with up to
  2 symbols or SPY as % lines.
- **Support & resistance** zones and pivot points, with a Key levels card (neutral wording only).
- **Key stats**: open, day range, previous close, volume, average volume, market cap, P/E, 52-week range,
  dividend yield.
- **News** with Positive / Negative / Neutral tags, and an AI summary when an Anthropic key is set.
- **Company insight**: CEO, CFO, HQ, employees; next-year guidance from the latest SEC filings
  (extracted by AI, every value backed by a quote from the filing); analyst estimates, price targets,
  ratings and the next earnings date.
- **Watchlist**, **search** by ticker or company name, and **alerts** checked on the server
  (price above/below, near a key level, level breakout) with browser and push notifications.
- **EN / TH** switch, **dark / light** theme, keyboard shortcuts, phone layout, installable app (PWA).
- Every number shows its **source and last-updated time**; missing data shows "—" with a note.

## Quick start (new PC)

1. Install **Node.js 20 or newer** (LTS) from <https://nodejs.org>.
2. Install pnpm:
   ```bash
   npm i -g pnpm@10
   ```
   (`corepack enable` fails on Windows because Program Files is read-only — use the line above.)
3. Get the code and install:
   ```bash
   git clone https://github.com/Pomyuy2/Trading_Monitor.git
   cd Trading_Monitor
   pnpm install
   ```
4. Copy `server/.env.example` to `server/.env` and add your API keys (see below). You can skip this
   step: without keys the app runs on demo data, clearly labelled "Mock".
5. Run it:
   ```bash
   pnpm dev
   ```
   Open **<http://localhost:3000>**. The first run creates the local database with a starter watchlist.

Stop with **Ctrl + C**. After `git pull`, stop the app, run `pnpm install`, then `pnpm dev` again.

## API keys (all free plans)

| Key in `server/.env` | Where to get it | Used for |
|---|---|---|
| `FINNHUB_API_KEY` | Sign up at <https://finnhub.io> → Dashboard → API key | Live prices (WebSocket), quotes, search, news, market status |
| `FMP_API_KEY` | Sign up at <https://financialmodelingprep.com> → Dashboard → API key | Daily chart history, volume, company profile, analyst data, earnings, dividends |
| `TWELVEDATA_API_KEY` | Sign up at <https://twelvedata.com> → Dashboard → API Keys | Intraday charts (1H, 1D, 1W, 1M) |
| `ANTHROPIC_API_KEY` *(optional)* | <https://console.anthropic.com> → API Keys. **Separate from a Claude.ai subscription** (pay-as-you-go; set a monthly limit there) | News summaries, AI sentiment, guidance extraction + Thai translation |

Any missing key falls back to demo data for that part (or turns that AI feature off), so the app always runs.
Never commit `server/.env` — it is git-ignored.

Other settings in `server/.env` (all optional, empty = default):

| Setting | Default | What it does |
|---|---|---|
| `SEC_USER_AGENT` | `TradingMonitor personal research app` | SEC asks automated clients to identify themselves, e.g. `Your Name you@example.com` |
| `VAPID_SUBJECT` | `mailto:trading-monitor@example.com` | Contact for push notifications; use your own `mailto:` |
| `PORT` / `WEB_ORIGIN` | `4000` / `http://localhost:3000` | Server port and the web app's address |
| `RATE_LIMIT_PER_MIN` | `300` | Requests per minute per IP to the server API |
| `MOCK_MARKET_STATE` | `open` | Demo data only: `open`, `closed` or `delayed`, to preview those states |

## Free-plan limits, and how the app stays within them

| Provider | Free-plan limits | What the app does |
|---|---|---|
| **Finnhub** | 60 calls/min; 1 live WebSocket per key (up to 50 symbols). Executives and candles are paid. | One shared upstream WebSocket for all browser tabs; quotes cached 5 s; company metrics cached 12 h. Before the open, its quote still shows yesterday's close — the app uses live trades instead. |
| **Twelve Data** | 8 calls/min, 800 calls/day | The server refuses a 9th call within a minute (charts show "rate limit — retrying automatically"); intraday charts cached 1 min while trading, 30 min when idle. Flipping quickly through ranges and Compare symbols can hit the limit; it clears within a minute. |
| **FMP** | 250 calls/day; earnings history limited to 5 rows; intraday charts and earnings-call transcripts are paid | One 5-year daily download per stock per hour serves 6M, 1Y and 5Y; profile cached 1 day, analyst data 12 h. Earnings markers therefore cover about the last year; dividends cover 5 years. |
| **SEC EDGAR** | Free, no key; fair use ≤ 10 requests/s | Filings list and text cached 12 h; used instead of paid earnings-call transcripts. |
| **Anthropic** *(optional)* | Pay per use (≈ $2 / $10 per million input / output tokens for Claude Sonnet 5.5) | Summaries cached 15 min per stock and language; each headline tagged once (7 days); guidance cached until the next earnings date. AI results are stored in the database so restarts don't repeat them. |

When a provider rate-limits or fails, the app shows the last cached data marked **Stale** rather than an error.

## Using the app

- **Install as an app** (Chrome / Edge on your PC): click the install icon at the right of the address
  bar. On a phone, installing and push notifications need **HTTPS**; over your Wi-Fi address
  (`http://192.168.x.x:3000`) it works as a normal website only.
- **Alerts** are checked by the server, so `pnpm dev` must be running (the browser can be closed). They
  show as an in-app pop-up, a system notification (allow notifications when asked), and — in the
  installed app — a push notification. Alerts that fire while the page is closed appear on your next visit.
- **Keyboard shortcuts**: `/` search · `1`–`7` chart range · `L` levels · `P` pivots · `C` compare ·
  `?` help. They're ignored while you type in a text field.
- **Your data** (watchlist, alerts, cached AI results) lives in `server/data/trading.db` on each PC; it
  is not synced through GitHub.

## Tests

```bash
pnpm test          # 106 unit + integration tests (server, shared), no network
pnpm test:e2e      # Playwright smoke test on demo data, desktop + phone
pnpm test:all      # both
```

- Unit tests use **recorded real responses** from each provider (`server/test/fixtures/`, trimmed, no
  keys); `fetch` is stubbed so tests never call the APIs.
- The smoke test starts its **own** server (port 4100, fresh database `server/data/e2e.db`) and web app
  (port 3100), so it can run while your normal `pnpm dev` is running and never touches your data. It
  uses your installed Google Chrome; to use Playwright's own browser instead run
  `npx playwright install chromium` and `PW_CHANNEL= pnpm test:e2e`.
- Type checks: `cd server && npx tsc --noEmit` and `cd web && npx tsc --noEmit`.

## Project structure

| Folder | What |
|---|---|
| `web/` | Next.js 15 (App Router), Tailwind 4, next-intl (EN/TH), lightweight-charts, SWR |
| `server/` | Fastify 5: REST API, WebSocket price relay, provider adapters, cache, alerts, push, SQLite (Prisma) |
| `shared/` | Types, range → candle size, US market hours |
| `e2e/` | Playwright smoke test |

Where things live:
- Provider interface `server/src/providers/types.ts`; which provider serves what: `server/src/config/providers.ts`
  (change providers there without touching the UI).
- Cache lifetimes `server/src/config/cache-ttl.ts`; cache interface (swap in Redis later) `server/src/cache/cache.ts`.
- Live price fan-out (1 update/s per symbol) `server/src/realtime/hub.ts`; alerts `server/src/alerts/alert-service.ts`.
- Support & resistance `server/src/analysis/levels.ts`; market hours `shared/src/market-hours.ts`.
- Database schema `server/prisma/schema.prisma`; UI text `web/messages/en.json`, `web/messages/th.json`.
- Thai SET stocks: `server/src/providers/set.ts` is a stub with TODOs (needs a SET SMART or Settrade account).

## Troubleshooting

**Every section says "Couldn't load" / a red "Data server not reachable" banner**
The web app (port 3000) is up but the server (port 4000) isn't. Look in the terminal for `server dev`
errors such as `EADDRINUSE: address already in use` — usually a second copy of `pnpm dev` (another
terminal tab) is holding the port. Close every terminal running `pnpm dev`, run it once, and the page
reloads its data by itself.

**`EPERM: operation not permitted … query_engine-windows.dll.node`** (Windows)
A running server locks Prisma's engine file. Stop `pnpm dev` before `pnpm install`; `pnpm dev`
regenerates it on start.

**Charts say "rate limit — retrying automatically"**
Twelve Data allows 8 chart requests per minute. Wait a moment; it recovers by itself.

**No system notifications**
Allow notifications for `localhost` (lock icon in the address bar) and check Windows Focus Assist / Do
Not Disturb. The in-app pop-up shows either way.

**"AI summary is off" / "Guidance extraction is off"**
Expected without `ANTHROPIC_API_KEY`. Add the key to `server/.env` and restart.

**Can't install on a phone**
Phones require HTTPS for installing and push. Use it as a website over Wi-Fi, or put it behind an
HTTPS address (a tunnel or hosting service — not set up here).

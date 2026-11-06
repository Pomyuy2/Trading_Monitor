import { isValidSymbol, normalizeSymbol, type ServerMessage } from '@tm/shared';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { MarketDataProvider, Tick } from '../providers/types.js';

const MAX_SYMBOLS_PER_CLIENT = 50;

const clientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), symbols: z.array(z.string()).max(MAX_SYMBOLS_PER_CLIENT) }),
  z.object({ type: z.literal('unsubscribe'), symbols: z.array(z.string()).max(MAX_SYMBOLS_PER_CLIENT) }),
]);

/**
 * Fans ONE upstream provider stream out to many browser sockets.
 * - Reference-counts symbols so the upstream only streams what someone watches.
 * - Throttles to at most one message per symbol per `minIntervalMs`; the most
 *   recent tick inside a window wins (trailing send), so the last price is never lost.
 */
export class RealtimeHub {
  private clients = new Map<WebSocket, Set<string>>();
  private refCount = new Map<string, number>();
  private lastSent = new Map<string, number>();
  private pending = new Map<string, Tick>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly upstream: MarketDataProvider,
    private readonly minIntervalMs = 1000,
  ) {
    upstream.onTick((t) => this.onTick(t));
  }

  get stats() {
    return { clients: this.clients.size, symbols: [...this.refCount.keys()] };
  }

  addClient(ws: WebSocket) {
    this.clients.set(ws, new Set());
    ws.on('message', (raw) => this.onMessage(ws, raw.toString()));
    ws.on('close', () => this.removeClient(ws));
    ws.on('error', () => this.removeClient(ws));
  }

  private onMessage(ws: WebSocket, raw: string) {
    let parsed: z.infer<typeof clientMessage>;
    try {
      parsed = clientMessage.parse(JSON.parse(raw));
    } catch {
      this.send(ws, { type: 'error', message: 'Invalid message' });
      return;
    }
    const subs = this.clients.get(ws);
    if (!subs) return;
    const symbols = parsed.symbols.map(normalizeSymbol).filter(isValidSymbol);
    if (parsed.type === 'subscribe') {
      const fresh = symbols.filter((s) => !subs.has(s)).slice(0, MAX_SYMBOLS_PER_CLIENT - subs.size);
      fresh.forEach((s) => subs.add(s));
      this.retain(fresh);
    } else {
      const gone = symbols.filter((s) => subs.delete(s));
      this.release(gone);
    }
  }

  private removeClient(ws: WebSocket) {
    const subs = this.clients.get(ws);
    if (!subs) return;
    this.clients.delete(ws);
    this.release([...subs]);
  }

  /** Server-side subscribers (e.g. alerts) keep a symbol streaming with no browser connected. */
  retainInternal(symbols: string[]) {
    this.retain(symbols);
  }

  releaseInternal(symbols: string[]) {
    this.release(symbols);
  }

  /** Push a message to every connected browser (single-user app). */
  broadcastAll(msg: ServerMessage) {
    const data = JSON.stringify(msg);
    for (const ws of this.clients.keys()) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  private retain(symbols: string[]) {
    const started: string[] = [];
    for (const s of symbols) {
      const n = (this.refCount.get(s) ?? 0) + 1;
      this.refCount.set(s, n);
      if (n === 1) started.push(s);
    }
    if (started.length) this.upstream.subscribe(started);
  }

  private release(symbols: string[]) {
    const stopped: string[] = [];
    for (const s of symbols) {
      const n = (this.refCount.get(s) ?? 0) - 1;
      if (n <= 0) {
        this.refCount.delete(s);
        this.lastSent.delete(s);
        this.pending.delete(s);
        const t = this.timers.get(s);
        if (t) clearTimeout(t);
        this.timers.delete(s);
        stopped.push(s);
      } else {
        this.refCount.set(s, n);
      }
    }
    if (stopped.length) this.upstream.unsubscribe(stopped);
  }

  private onTick(tick: Tick) {
    if (!this.refCount.has(tick.symbol)) return;
    const now = Date.now();
    const elapsed = now - (this.lastSent.get(tick.symbol) ?? 0);
    if (elapsed >= this.minIntervalMs && !this.timers.has(tick.symbol)) {
      this.broadcast(tick);
      return;
    }
    // Inside the throttle window: keep the latest price (summing volume) and flush at window end.
    const prev = this.pending.get(tick.symbol);
    const volume = prev?.volume != null || tick.volume != null ? (prev?.volume ?? 0) + (tick.volume ?? 0) : undefined;
    this.pending.set(tick.symbol, { ...tick, volume });
    if (!this.timers.has(tick.symbol)) {
      const wait = Math.max(0, this.minIntervalMs - elapsed);
      this.timers.set(
        tick.symbol,
        setTimeout(() => {
          this.timers.delete(tick.symbol);
          const latest = this.pending.get(tick.symbol);
          this.pending.delete(tick.symbol);
          if (latest) this.broadcast(latest);
        }, wait),
      );
    }
  }

  private broadcast(tick: Tick) {
    this.lastSent.set(tick.symbol, Date.now());
    const msg: ServerMessage = { type: 'tick', symbol: tick.symbol, price: tick.price, ts: tick.ts, ...(tick.volume != null ? { volume: tick.volume } : {}) };
    const data = JSON.stringify(msg);
    for (const [ws, subs] of this.clients) {
      if (subs.has(tick.symbol) && ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
}

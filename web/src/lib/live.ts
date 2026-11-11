'use client';

import type { Alert, ClientMessage, ServerMessage } from '@tm/shared';
import { useEffect, useState, useSyncExternalStore } from 'react';

export interface LiveTick {
  symbol: string;
  price: number;
  ts: number;
  volume?: number;
}

type TickListener = (t: LiveTick) => void;
export type ConnState = 'connecting' | 'open' | 'closed';

/**
 * One browser WebSocket to our server, shared by every component.
 * Ref-counts symbols, resubscribes after reconnect, and reconnects with
 * exponential backoff (1 s → 30 s).
 */
class LiveFeed {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<TickListener>>();
  private alertListeners = new Set<(a: Alert) => void>();
  private latest = new Map<string, LiveTick>();
  private stateListeners = new Set<() => void>();
  private backoff = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  state: ConnState = 'closed';

  private url() {
    const env = process.env.NEXT_PUBLIC_WS_URL;
    if (env) return env;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    if (location.port === '3000') {
      return `${proto}://${location.hostname}:4000/ws`;
    }
    return `${proto}://${location.host}/ws`;
  }

  private setState(s: ConnState) {
    this.state = s;
    this.stateListeners.forEach((l) => l());
  }

  onState(l: () => void) {
    this.stateListeners.add(l);
    return () => {
      this.stateListeners.delete(l);
    };
  }

  private connect() {
    if (this.ws || typeof window === 'undefined') return;
    this.setState('connecting');
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      this.setState('open');
      const symbols = [...this.listeners.keys()];
      if (symbols.length) this.send({ type: 'subscribe', symbols });
    };
    ws.onmessage = (e) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'alert') {
        this.alertListeners.forEach((cb) => cb(msg.alert));
        return;
      }
      if (msg.type !== 'tick') return;
      const tick: LiveTick = { symbol: msg.symbol, price: msg.price, ts: msg.ts, volume: msg.volume };
      this.latest.set(msg.symbol, tick);
      this.listeners.get(msg.symbol)?.forEach((l) => l(tick));
    };
    ws.onclose = () => {
      this.ws = null;
      this.setState('closed');
      if (this.listeners.size === 0 && this.alertListeners.size === 0) return;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    };
    ws.onerror = () => ws.close();
  }

  private send(m: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  subscribe(symbol: string, l: TickListener): () => void {
    let set = this.listeners.get(symbol);
    if (!set) {
      set = new Set();
      this.listeners.set(symbol, set);
      this.send({ type: 'subscribe', symbols: [symbol] });
    }
    set.add(l);
    this.connect();
    return () => {
      const s = this.listeners.get(symbol);
      if (!s) return;
      s.delete(l);
      if (s.size === 0) {
        this.listeners.delete(symbol);
        this.latest.delete(symbol);
        this.send({ type: 'unsubscribe', symbols: [symbol] });
      }
      if (this.listeners.size === 0 && this.alertListeners.size === 0 && this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    };
  }

  /** Triggered alerts pushed by the server. Keeps the socket open. */
  onAlert(cb: (a: Alert) => void): () => void {
    this.alertListeners.add(cb);
    this.connect();
    return () => {
      this.alertListeners.delete(cb);
    };
  }

  last(symbol: string) {
    return this.latest.get(symbol);
  }
}

let feed: LiveFeed | null = null;
export function liveFeed(): LiveFeed {
  if (!feed) feed = new LiveFeed();
  return feed;
}

/** Latest tick for a symbol (re-renders at most once per server throttle window). */
export function useLiveTick(symbol: string | null, enabled = true): LiveTick | null {
  const [tick, setTick] = useState<LiveTick | null>(null);
  useEffect(() => {
    setTick(null);
    if (!symbol || !enabled) return;
    const f = liveFeed();
    setTick(f.last(symbol) ?? null);
    return f.subscribe(symbol, setTick);
  }, [symbol, enabled]);
  return tick;
}

/** Subscribe with a callback instead of state (used by the chart to update in place). */
export function useTickListener(symbol: string | null, enabled: boolean, cb: TickListener) {
  useEffect(() => {
    if (!symbol || !enabled) return;
    return liveFeed().subscribe(symbol, cb);
  }, [symbol, enabled, cb]);
}

export function useConnState(): ConnState {
  return useSyncExternalStore(
    (l) => liveFeed().onState(l),
    () => liveFeed().state,
    () => 'closed',
  );
}

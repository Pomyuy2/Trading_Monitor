/** Tiny TTL memo for provider-internal data (shares one in-flight promise per key). */
export class Memo<V> {
  private map = new Map<string, { p: Promise<V>; exp: number }>();

  constructor(private readonly ttlMs: number, private readonly max = 500) {}

  get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.map.get(key);
    if (hit && hit.exp > Date.now()) return hit.p;
    const p = load();
    this.map.set(key, { p, exp: Date.now() + this.ttlMs });
    p.catch(() => this.map.delete(key));
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
    return p;
  }
}

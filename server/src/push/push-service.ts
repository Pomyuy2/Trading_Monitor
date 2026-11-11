import type { PrismaClient } from '@prisma/client';
import { NEAR_LEVEL_PCT, type Alert, type Lang } from '@tm/shared';
import webpush from 'web-push';

interface Logger { info(msg: string): void; warn(msg: string): void }

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  lang?: Lang;
}

/**
 * Web Push (standard VAPID; the browsers' push services are free). VAPID keys are
 * generated on first run and stored in the database, so there is nothing to configure.
 * Used for alerts when the app is installed and possibly closed.
 */
export class PushService {
  private ready = false;
  publicKey = '';

  constructor(private readonly db: PrismaClient, private readonly subject: string, private readonly log: Logger) {}

  async init() {
    const get = (key: string) => this.db.setting.findUnique({ where: { key } });
    let pub = (await get('vapidPublicKey'))?.value;
    let priv = (await get('vapidPrivateKey'))?.value;
    if (!pub || !priv) {
      const keys = webpush.generateVAPIDKeys();
      pub = keys.publicKey;
      priv = keys.privateKey;
      await this.db.$transaction([
        this.db.setting.upsert({ where: { key: 'vapidPublicKey' }, create: { key: 'vapidPublicKey', value: pub }, update: { value: pub } }),
        this.db.setting.upsert({ where: { key: 'vapidPrivateKey' }, create: { key: 'vapidPrivateKey', value: priv }, update: { value: priv } }),
      ]);
      this.log.info('Push: generated VAPID keys');
    }
    webpush.setVapidDetails(this.subject, pub, priv);
    this.publicKey = pub;
    this.ready = true;
  }

  async subscribe(s: PushSubscriptionInput, userId?: string) {
    const data = { p256dh: s.keys.p256dh, auth: s.keys.auth, lang: s.lang === 'th' ? 'th' : 'en', userId };
    await this.db.pushSubscription.upsert({ where: { endpoint: s.endpoint }, create: { endpoint: s.endpoint, ...data }, update: data });
  }

  async unsubscribe(endpoint: string) {
    await this.db.pushSubscription.deleteMany({ where: { endpoint } });
  }

  async count() {
    return this.db.pushSubscription.count();
  }

  /** Send a triggered alert to every subscription belonging to the alert owner. */
  async sendAlert(alert: Alert) {
    if (!this.ready) return;
    const subs = await this.db.pushSubscription.findMany({
      where: alert.userId ? { OR: [{ userId: alert.userId }, { userId: null }] } : {},
    });
    await Promise.all(
      subs.map(async (s) => {
        const lang = (s.lang === 'th' ? 'th' : 'en') as Lang;
        const payload = JSON.stringify({
          title: `${alert.symbol} · Trading Monitor`,
          body: alertText(alert, lang),
          url: `/stock/${encodeURIComponent(alert.symbol)}`,
          tag: alert.id, // same tag as the in-page notification, so the browser shows it once
        });
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600 });
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) await this.unsubscribe(s.endpoint);
          else this.log.warn(`Push failed (${code ?? 'network'})`);
        }
      }),
    );
  }
}

/** Short, neutral notification text (the push arrives without the web app's translations). */
export function alertText(a: Alert, lang: Lang): string {
  const money = (n: number | null | undefined) =>
    n == null ? '—' : new Intl.NumberFormat(lang === 'th' ? 'th-TH-u-ca-gregory' : 'en-US', { style: 'currency', currency: 'USD' }).format(n);
  const at = money(a.triggerPrice);
  const kindTh = a.level?.kind === 'support' ? 'แนวรับ' : 'แนวต้าน';
  const kindEn = a.level?.kind ?? '';
  switch (a.kind) {
    case 'price_above':
      return lang === 'th' ? `ราคา ${at} สูงกว่าหรือเท่ากับ ${money(a.targetPrice)}` : `Price ${at} is at or above ${money(a.targetPrice)}`;
    case 'price_below':
      return lang === 'th' ? `ราคา ${at} ต่ำกว่าหรือเท่ากับ ${money(a.targetPrice)}` : `Price ${at} is at or below ${money(a.targetPrice)}`;
    case 'near_level':
      return lang === 'th'
        ? `ราคา ${at} อยู่ห่างจาก${kindTh} ${money(a.level?.price)} ไม่เกิน ${NEAR_LEVEL_PCT}%`
        : `Price ${at} is within ${NEAR_LEVEL_PCT}% of ${kindEn} ${money(a.level?.price)}`;
    case 'breakout':
      return lang === 'th'
        ? `แท่งเทียนปิดที่ ${at} ${a.level?.kind === 'resistance' ? 'เหนือ' : 'ต่ำกว่า'}โซน${kindTh} ${money(a.level?.zoneLow)}–${money(a.level?.zoneHigh)}`
        : `A candle closed at ${at}, ${a.level?.kind === 'resistance' ? 'above' : 'below'} the ${kindEn} zone ${money(a.level?.zoneLow)}–${money(a.level?.zoneHigh)}`;
  }
}

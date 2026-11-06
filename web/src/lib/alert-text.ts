'use client';

import { NEAR_LEVEL_PCT, RANGE_RESOLUTION, type Alert, type Lang } from '@tm/shared';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { fmtNumber, fmtPrice } from './format';

/** Neutral, descriptive text for an alert's condition and its trigger. Never "buy"/"sell". */
export function useAlertText(lang: Lang) {
  const t = useTranslations('alerts');
  const tc = useTranslations('chart');
  const tl = useTranslations('levels');

  const condition = useCallback(
    (a: Pick<Alert, 'kind' | 'targetPrice' | 'level'>) => {
      const p = (n: number | null | undefined) => fmtPrice(n, lang);
      switch (a.kind) {
        case 'price_above':
          return t('cond.price_above', { price: p(a.targetPrice) });
        case 'price_below':
          return t('cond.price_below', { price: p(a.targetPrice) });
        case 'near_level':
          return t('cond.near_level', { pct: NEAR_LEVEL_PCT, kind: tl(a.level!.kind), price: p(a.level!.price), range: tc(`ranges.${a.level!.range}`) });
        case 'breakout':
          return t(a.level!.kind === 'resistance' ? 'cond.breakout_up' : 'cond.breakout_down', {
            kind: tl(a.level!.kind),
            zone: `${fmtNumber(a.level!.zoneLow, lang)}–${fmtNumber(a.level!.zoneHigh, lang)}`,
            size: tc(`sizes.${RANGE_RESOLUTION[a.level!.range]}`),
          });
      }
    },
    [t, tc, tl, lang],
  );

  const triggered = useCallback(
    (a: Alert) => t('triggeredAt', { symbol: a.symbol, price: fmtPrice(a.triggerPrice, lang), condition: condition(a) }),
    [t, condition, lang],
  );

  return { condition, triggered };
}

'use client';

import type { Sentiment } from '@tm/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { useNews } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { Card, cx, ErrorState, Skeleton, SourceLine, useLang } from './ui';

export function NewsCard({ symbol }: { symbol: string }) {
  const t = useTranslations('news');
  const lang = useLang();
  const { data, error, isLoading, mutate } = useNews(symbol, lang);
  const now = useNow(60_000);

  return (
    <Card
      id="news"
      title={t('title')}
      className="h-full"
      bodyClassName="min-h-0 xl:overflow-y-auto"
      footer={
        <div className="space-y-1">
          <SourceLine meta={data?.meta} />
          {data?.sentimentMethod && (
            <p className="text-xs text-muted">
              {data.sentimentMethod === 'keywords'
                ? t(data.aiPending ? 'sentimentPending' : 'sentimentKeywords')
                : t('sentimentBy', { source: data.sentimentSource ?? '' })}
            </p>
          )}
        </div>
      }
    >
      {error && !data ? (
        <ErrorState error={error} onRetry={() => mutate()} />
      ) : isLoading || !data ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-12" />)}
        </div>
      ) : (
        <>
          {data.items.length === 0 ? (
            <p className="text-sm text-muted">{t('noNews')}</p>
          ) : (
            <ul className="-mt-3 divide-y divide-border">
              {data.items.map((n) => (
                <li key={n.id} className="py-3">
                  <a href={n.url} target="_blank" rel="noopener noreferrer" className="block min-h-11 rounded text-sm font-medium leading-snug text-text hover:text-accent" lang="en">
                    {n.headline}
                  </a>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                    <span>{n.source}</span>
                    <span aria-hidden>·</span>
                    <time dateTime={n.publishedAt} title={new Date(n.publishedAt).toLocaleString()}>{timeAgo(n.publishedAt, lang, now)}</time>
                    {n.sentiment && <SentimentTag s={n.sentiment} />}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

const TAG: Record<Sentiment, { cls: string; icon: string }> = {
  positive: { cls: 'border-up/50 text-up', icon: '▲' },
  negative: { cls: 'border-down/50 text-down', icon: '▼' },
  neutral: { cls: 'border-border text-muted', icon: '●' },
};

function SentimentTag({ s }: { s: Sentiment }) {
  const t = useTranslations('news');
  return (
    <span className={cx('ml-auto inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium', TAG[s].cls)}>
      <span aria-hidden className="text-[9px]">{TAG[s].icon}</span>
      {t(s)}
    </span>
  );
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(h);
  }, [intervalMs]);
  return now;
}

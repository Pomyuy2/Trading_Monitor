'use client';

import type { Sentiment } from '@tm/shared';
import { useTranslations } from 'next-intl';
import { useNews } from '@/lib/api';
import { fmtStamp } from '@/lib/format';
import { SparkIcon } from './icons';
import { cx, Skeleton, useLang } from './ui';

/**
 * The AI news summary, shown right under the price so it's the first thing you read.
 * Shares the news request with NewsCard (SWR de-duplicates it).
 */
export function AiSummaryPanel({ symbol, onShowNews, onAskAi }: { symbol: string; onShowNews: () => void; onAskAi?: () => void }) {
  const t = useTranslations('news');
  const tc = useTranslations('common');
  const ta = useTranslations('askAi');
  const lang = useLang();
  const { data, error } = useNews(symbol, lang);

  const dayAgo = Date.now() - 24 * 3600_000;
  const today = (data?.items ?? []).filter((n) => Date.parse(n.publishedAt) >= dayAgo);
  const count = (s: Sentiment) => today.filter((n) => n.sentiment === s).length;

  return (
    <section
      aria-labelledby="ai-summary-title"
      className="relative overflow-hidden rounded-xl border border-accent/40 bg-gradient-to-br from-accent/15 via-accent/5 to-panel p-4 sm:p-5"
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-accent" />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 id="ai-summary-title" className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-accent">
          <SparkIcon width={16} height={16} /> {t('aiSummary')}
        </h2>
        {data?.summary && (
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
            {data.summaryUpdating ? (
              <span className="inline-flex items-center gap-1.5 text-accent" role="status">
                <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                {t('summaryUpdating')}
              </span>
            ) : (
              <span>{tc('updated', { time: fmtStamp(data.summary.meta.updatedAt, lang) })}</span>
            )}
            <span aria-hidden>·</span>
            <span>{t('articles', { count: data.summary.articleCount })}</span>
          </p>
        )}
      </div>

      {!data ? (
        error ? (
          <p className="mt-3 text-sm text-muted">— {t('noSummary')}</p>
        ) : (
          <div className="mt-3 space-y-2" aria-busy="true">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        )
      ) : data.summary ? (
        <p className="mt-3 text-[15px] leading-relaxed text-text sm:text-base" lang={data.summary.lang}>
          {data.summary.text}
        </p>
      ) : data.summaryStatus === 'pending' ? (
        <p className="mt-3 animate-pulse text-[15px] text-muted" role="status">
          {t('summaryPending')}
        </p>
      ) : (
        <p className="mt-3 text-sm text-muted">
          — {t(data.summaryStatus === 'disabled' ? 'summaryOff' : data.summaryStatus === 'no-recent' ? 'summaryNoRecent' : 'noSummary')}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {today.length > 0 ? (
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted" aria-label={t('moodLabel', { up: count('positive'), down: count('negative'), flat: count('neutral') })}>
            <span>{t('mood24h')}</span>
            <Mood cls="border-up/50 text-up" icon="▲" n={count('positive')} label={t('positive')} />
            <Mood cls="border-down/50 text-down" icon="▼" n={count('negative')} label={t('negative')} />
            <Mood cls="border-border text-muted" icon="●" n={count('neutral')} label={t('neutral')} />
          </p>
        ) : (
          <span />
        )}
        <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted">
          {data?.summary && <span>{tc('source', { source: data.summary.meta.source })}</span>}
          {onAskAi && (
            <button type="button" onClick={onAskAi} className="inline-flex min-h-11 items-center gap-1 font-medium text-accent hover:underline sm:min-h-0">
              <SparkIcon width={13} height={13} /> {ta('title')} →
            </button>
          )}
          <button type="button" onClick={onShowNews} className="inline-flex min-h-11 items-center font-medium text-accent hover:underline sm:min-h-0">
            {t('seeAllNews')} ↓
          </button>
        </div>
      </div>
      {data?.summary && <p className="mt-1 text-[11px] text-muted">{t('aiDisclaimer')}</p>}
    </section>
  );
}

function Mood({ cls, icon, n, label }: { cls: string; icon: string; n: number; label: string }) {
  return (
    <span aria-hidden className={cx('inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-medium', cls)}>
      <span className="text-[9px]">{icon}</span>
      {n} {label}
    </span>
  );
}

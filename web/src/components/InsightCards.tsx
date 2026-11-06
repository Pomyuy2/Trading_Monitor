'use client';

import type { GuidanceField, InsightResponse, Quote, SourceMeta } from '@tm/shared';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { useInsight } from '@/lib/api';
import { fmtCompact, fmtInt, fmtIsoDate, fmtPrice } from '@/lib/format';
import { Card, ErrorState, Missing, Skeleton, SourceLine, useLang } from './ui';

export function InsightCards({ symbol, quote }: { symbol: string; quote: Quote | undefined }) {
  const lang = useLang();
  const { data, error, isLoading, mutate } = useInsight(symbol, lang);
  const t = useTranslations('insight');

  if (error && !data) {
    return (
      <Card title={t('profileTitle')}>
        <ErrorState onRetry={() => mutate()} />
      </Card>
    );
  }
  const loading = isLoading || !data;
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <ProfileCard data={loading ? null : data} />
      <GuidanceCard data={loading ? null : data} />
      <AnalystCard data={loading ? null : data} quote={quote} />
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,40%)_minmax(0,1fr)] gap-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function LoadingRows({ n = 5 }: { n?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: n }, (_, i) => <Skeleton key={i} className="h-8" />)}
    </div>
  );
}

// ---------- Leadership & profile ----------
function ProfileCard({ data }: { data: InsightResponse | null }) {
  const t = useTranslations('insight');
  const lang = useLang();
  const p = data?.profile;
  return (
    <Card id="profile" title={t('profileTitle')} footer={<SourceLine meta={p?.meta} />}>
      {!data ? (
        <LoadingRows />
      ) : !p ? (
        <Missing />
      ) : (
        <dl className="divide-y divide-border">
          <Row label={t('ceo')}>
            {p.ceo ? (
              <>
                {p.ceo.name}
                {p.ceo.since && <span className="block text-xs text-muted">{t('since', { year: String(p.ceo.since) })}</span>}
              </>
            ) : <Missing />}
          </Row>
          <Row label={t('cfo')}>
            {p.cfo ? (
              <>
                {p.cfo.name}
                {p.cfo.since && <span className="block text-xs text-muted">{t('since', { year: String(p.cfo.since) })}</span>}
              </>
            ) : <Missing />}
          </Row>
          <Row label={t('hq')}>{p.hq ?? <Missing />}</Row>
          <Row label={t('founded')}>{p.founded ? <span className="font-mono">{p.founded}</span> : <Missing />}</Row>
          <Row label={t('employees')}>{p.employees != null ? <span className="font-mono">{fmtInt(p.employees, lang)}</span> : <Missing />}</Row>
          <div className="py-2">
            <dt className="text-xs text-muted">{t('business')}</dt>
            <dd className="mt-1 text-sm leading-relaxed text-text" lang="en">{p.description ?? <Missing />}</dd>
          </div>
        </dl>
      )}
    </Card>
  );
}

// ---------- Next-year plan & guidance ----------
function GField({ label, f }: { label: string; f: GuidanceField | null }) {
  const t = useTranslations('insight');
  return (
    <div className="py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 text-sm">{f ? <QuotedValue f={f} /> : <Missing note={t('notStated')} />}</dd>
    </div>
  );
}

function QuotedValue({ f }: { f: GuidanceField }) {
  const t = useTranslations('insight');
  return (
    <>
      <span>{f.value}</span>
      <details className="group mt-1">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 text-xs text-accent [&::-webkit-details-marker]:hidden">
          <span aria-hidden className="transition-transform group-open:rotate-90">›</span> {t('showQuote')}
        </summary>
        <blockquote className="border-l-2 border-accent/50 pl-3 text-xs italic leading-relaxed text-muted" lang="en">
          {f.quote}
        </blockquote>
      </details>
    </>
  );
}

function GuidanceCard({ data }: { data: InsightResponse | null }) {
  const t = useTranslations('insight');
  const lang = useLang();
  const g = data?.guidance;
  return (
    <Card
      id="guidance"
      title={t('guidanceTitle')}
      actions={g?.fiscalYear ? <span className="rounded border border-border px-2 py-0.5 font-mono text-xs text-muted">{t('fiscalYear', { year: String(g.fiscalYear) })}</span> : null}
      footer={
        g ? (
          <div className="space-y-1">
            {g.sourceTitle && (
              <p className="text-xs text-muted">{t('fromSource', { title: g.sourceTitle, date: fmtIsoDate(g.sourceDate, lang) })}</p>
            )}
            <SourceLine meta={g.meta} />
          </div>
        ) : null
      }
    >
      {!data ? (
        <LoadingRows n={6} />
      ) : !g ? (
        <Missing note={t('noGuidance')} />
      ) : (
        <dl className="divide-y divide-border">
          <GField label={t('revenueGuidance')} f={g.revenueGuidance} />
          <GField label={t('epsGuidance')} f={g.epsGuidance} />
          <GField label={t('capex')} f={g.capexBudget} />
          <GField label={t('rnd')} f={g.rndBudget} />
          <div className="py-2">
            <dt className="text-xs text-muted">{t('priorities')}</dt>
            <dd>
              <ol className="mt-1 space-y-2">
                {g.priorities.map((p, i) => (
                  <li key={i} className="flex gap-2 text-sm">
                    <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded bg-panel-2 font-mono text-[11px] text-muted">{i + 1}</span>
                    <span className="min-w-0 flex-1">{p ? <QuotedValue f={p} /> : <Missing note={t('notStated')} />}</span>
                  </li>
                ))}
              </ol>
            </dd>
          </div>
        </dl>
      )}
    </Card>
  );
}

// ---------- Analyst expectations ----------
function AnalystCard({ data, quote }: { data: InsightResponse | null; quote: Quote | undefined }) {
  const t = useTranslations('insight');
  const lang = useLang();
  const cur = quote?.currency ?? 'USD';
  const e = data?.estimates;
  const pt = data?.priceTargets;
  const r = data?.ratings;
  const metas = [e?.meta, pt?.meta, r?.meta, data?.earnings?.meta].filter(Boolean) as SourceMeta[];
  // One line per distinct source; use the oldest update time for that source.
  const bySource = new Map<string, SourceMeta>();
  for (const m of metas) {
    const prev = bySource.get(m.source);
    if (!prev || Date.parse(m.updatedAt) < Date.parse(prev.updatedAt) || m.stale) bySource.set(m.source, { ...m, note: undefined });
  }

  return (
    <Card id="analyst" title={t('analystTitle')} footer={<div className="space-y-1">{[...bySource.values()].map((m) => <SourceLine key={m.source} meta={m} />)}</div>}>
      {!data ? (
        <LoadingRows n={6} />
      ) : (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-3">
            <div>
              <dt className="text-xs text-muted">
                {t('revenueEst')}
                {e?.fiscalYear ? ` · ${t('fiscalYear', { year: String(e.fiscalYear) })}` : ''}
              </dt>
              <dd className="mt-1 font-mono text-lg">{e?.revenueAvg != null ? fmtCompact(e.revenueAvg, lang, cur) : <Missing />}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">
                {t('epsEst')}
                {e?.fiscalYear ? ` · ${t('fiscalYear', { year: String(e.fiscalYear) })}` : ''}
              </dt>
              <dd className="mt-1 font-mono text-lg">{e?.epsAvg != null ? fmtPrice(e.epsAvg, lang, cur) : <Missing />}</dd>
            </div>
            {e?.analystCount != null && <p className="col-span-2 -mt-1 text-xs text-muted">{t('analysts', { count: String(e.analystCount) })}</p>}
          </dl>

          <div>
            <h3 className="text-xs text-muted">{t('priceTarget')}</h3>
            {pt && pt.low != null && pt.avg != null && pt.high != null ? (
              <TargetBar low={pt.low} avg={pt.avg} high={pt.high} current={quote?.price ?? null} fmt={(n) => fmtPrice(n, lang, cur)} />
            ) : (
              <div className="mt-1"><Missing /></div>
            )}
          </div>

          <div>
            <h3 className="text-xs text-muted">{t('ratings')}</h3>
            {r && r.buy != null && r.hold != null && r.sell != null ? <RatingsBar buy={r.buy} hold={r.hold} sell={r.sell} /> : <div className="mt-1"><Missing /></div>}
          </div>

          <div className="flex items-baseline justify-between gap-2 border-t border-border pt-3">
            <span className="text-xs text-muted">{t('nextEarnings')}</span>
            <span className="font-mono text-sm">{data.earnings?.date ? fmtIsoDate(data.earnings.date, lang) : <Missing inline />}</span>
          </div>
        </div>
      )}
    </Card>
  );
}

function TargetBar({ low, avg, high, current, fmt }: { low: number; avg: number; high: number; current: number | null; fmt: (n: number) => string }) {
  const t = useTranslations('insight');
  const min = Math.min(low, current ?? low);
  const max = Math.max(high, current ?? high);
  const pos = (v: number) => (max > min ? ((v - min) / (max - min)) * 100 : 50);
  return (
    <div className="mt-2">
      <div aria-hidden className="relative h-6">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded bg-border" />
        <div className="absolute top-1/2 h-1 -translate-y-1/2 rounded bg-accent/50" style={{ left: `${pos(low)}%`, width: `${pos(high) - pos(low)}%` }} />
        <div className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent" style={{ left: `${pos(avg)}%` }} />
        {current != null && <div className="absolute top-0 h-6 w-0.5 -translate-x-1/2 bg-text" style={{ left: `${pos(current)}%` }} />}
      </div>
      <dl className="mt-1 grid grid-cols-3 gap-2 text-center">
        <div><dt className="text-[11px] text-muted">{t('low')}</dt><dd className="font-mono text-sm">{fmt(low)}</dd></div>
        <div><dt className="text-[11px] text-muted">{t('avg')}</dt><dd className="font-mono text-sm text-accent">{fmt(avg)}</dd></div>
        <div><dt className="text-[11px] text-muted">{t('high')}</dt><dd className="font-mono text-sm">{fmt(high)}</dd></div>
      </dl>
      {current != null && <p className="mt-1 text-center text-[11px] text-muted">▏{t('current')}: <span className="font-mono">{fmt(current)}</span></p>}
    </div>
  );
}

function RatingsBar({ buy, hold, sell }: { buy: number; hold: number; sell: number }) {
  const t = useTranslations('insight');
  const total = buy + hold + sell || 1;
  const parts = [
    { k: 'buy', n: buy, cls: 'bg-up' },
    { k: 'hold', n: hold, cls: 'bg-muted' },
    { k: 'sell', n: sell, cls: 'bg-down' },
  ] as const;
  return (
    <div className="mt-2">
      <div aria-hidden className="flex h-2 overflow-hidden rounded">
        {parts.map((p) => p.n > 0 && <div key={p.k} className={p.cls} style={{ width: `${(p.n / total) * 100}%` }} />)}
      </div>
      <dl className="mt-2 grid grid-cols-3 gap-2">
        {parts.map((p) => (
          <div key={p.k} className="flex items-center gap-1.5">
            <span aria-hidden className={`size-2 rounded-sm ${p.cls}`} />
            <dt className="text-xs text-muted">{t(p.k)}</dt>
            <dd className="font-mono text-sm">{p.n}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

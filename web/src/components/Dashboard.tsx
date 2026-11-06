'use client';

import type { PriceLevel, Range } from '@tm/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { useMeta } from '@/lib/api';
import { useLiveQuote } from '@/lib/use-live-quote';
import { ChartCard } from './ChartCard';
import { AlertCenter } from './AlertCenter';
import { AlertsPanel } from './AlertsPanel';
import { AlertDialog, CompareDialog, Modal, type AlertPreset } from './Dialogs';
import { Header } from './Header';
import { InsightCards } from './InsightCards';
import { KeyLevelsCard } from './KeyLevelsCard';
import { NewsCard } from './NewsCard';
import { PriceHeader } from './PriceHeader';
import { StatsCard } from './StatsCard';
import { cx } from './ui';
import { Watchlist } from './Watchlist';

type Tab = 'news' | 'insight' | 'stats';
const TABS: Tab[] = ['news', 'insight', 'stats'];
const RANGE_KEY = 'tm.range';

export function Dashboard({ symbol }: { symbol: string }) {
  const t = useTranslations();
  const [range, setRange] = useState<Range>('1D');
  const [tab, setTab] = useState<Tab>('news');
  const [compare, setCompare] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'alert' | 'compare' | 'watchlist' | null>(null);
  const [alertPreset, setAlertPreset] = useState<AlertPreset>(null);
  const openAlert = (level?: PriceLevel) => {
    setAlertPreset(level ? { kind: 'near_level', level } : null);
    setDialog('alert');
  };
  const live = useLiveQuote(symbol, true);

  // Remember the chosen range per browser (convenience only).
  useEffect(() => {
    try {
      const r = localStorage.getItem(RANGE_KEY) as Range | null;
      if (r) setRange(r);
    } catch {}
  }, []);
  const changeRange = (r: Range) => {
    setRange(r);
    try {
      localStorage.setItem(RANGE_KEY, r);
    } catch {}
  };

  useEffect(() => setCompare(null), [symbol]);

  const onTabKey = (e: React.KeyboardEvent, i: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    setTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-button focus:px-3 focus:py-2 focus:text-white">
        {t('app.skipToContent')}
      </a>
      <MockBanner />
      <Header onOpenWatchlist={() => setDialog('watchlist')} />

      <div className="mx-auto w-full max-w-[1600px] flex-1 gap-4 px-4 py-4 lg:grid lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="hidden lg:block">
          <div className="sticky top-20 space-y-4">
            <Watchlist current={symbol} />
            <AlertsPanel />
          </div>
        </aside>

        <main id="main" className="dash-grid min-w-0">
          <div className="area-price">
            <PriceHeader
              symbol={symbol}
              quote={live.data}
              error={live.error}
              streaming={live.streaming}
              onRetry={() => live.mutate()}
              compare={compare}
              onAlert={() => openAlert()}
              onCompare={() => setDialog('compare')}
              onStopCompare={() => setCompare(null)}
            />
          </div>
          <div className="area-chart min-w-0">
            <ChartCard symbol={symbol} range={range} onRange={changeRange} quote={live.data} streaming={live.streaming} compare={compare} />
          </div>
          <div className="area-levels min-w-0">
            <KeyLevelsCard symbol={symbol} range={range} quote={live.data} onAlert={(l) => openAlert(l)} />
          </div>

          {/* Phone only: tabs for the panels below the chart */}
          <div className="area-tabs lg:hidden">
            <div role="tablist" aria-label={t('tabs.label')} className="grid grid-cols-3 gap-1 rounded-xl border border-border bg-panel p-1">
              {TABS.map((k, i) => (
                <button
                  key={k}
                  id={`tab-${k}`}
                  type="button"
                  role="tab"
                  aria-selected={tab === k}
                  aria-controls={`panel-${k}`}
                  tabIndex={tab === k ? 0 : -1}
                  onClick={() => setTab(k)}
                  onKeyDown={(e) => onTabKey(e, i)}
                  className={cx('min-h-11 rounded-lg text-sm font-medium', tab === k ? 'bg-button text-white' : 'text-muted hover:text-text')}
                >
                  {t(`tabs.${k}`)}
                </button>
              ))}
            </div>
          </div>

          <div id="panel-news" className={cx('area-news min-w-0', tab !== 'news' && 'max-lg:hidden')}>
            <NewsCard symbol={symbol} />
          </div>
          <div id="panel-insight" className={cx('area-insight min-w-0', tab !== 'insight' && 'max-lg:hidden')}>
            <InsightCards symbol={symbol} quote={live.data} />
          </div>
          <div id="panel-stats" className={cx('area-stats min-w-0', tab !== 'stats' && 'max-lg:hidden')}>
            <StatsCard quote={live.data} />
          </div>
        </main>
      </div>

      <Footer />

      <Modal side open={dialog === 'watchlist'} onClose={() => setDialog(null)} title={t('watchlist.title')}>
        <div className="space-y-3 p-3">
          <Watchlist current={symbol} onNavigate={() => setDialog(null)} />
          <AlertsPanel onNavigate={() => setDialog(null)} />
        </div>
      </Modal>
      <AlertDialog open={dialog === 'alert'} onClose={() => setDialog(null)} symbol={symbol} quote={live.data} range={range} preset={alertPreset} />
      <AlertCenter />
      <CompareDialog open={dialog === 'compare'} onClose={() => setDialog(null)} symbol={symbol} onPick={setCompare} />
    </div>
  );
}

function MockBanner() {
  const t = useTranslations('app');
  const { data } = useMeta();
  if (!data?.mock) return null;
  const all = data.providers.every((p) => p.startsWith('Mock'));
  const sections = [...new Set(data.mockCapabilities.map((c) => t(`mockSections.${c}` as Parameters<typeof t>[0])))].join(', ');
  return (
    <div role="note" className="border-b border-warn/30 bg-warn/10 px-4 py-2 text-center text-xs text-warn">
      {all ? t('mockBanner') : t('mockPartial', { sections })}
    </div>
  );
}

function Footer() {
  const t = useTranslations('footer');
  const { data } = useMeta();
  const providers = data?.providers.join(', ') ?? '—';
  return (
    <footer className="border-t border-border px-4 py-4 text-center text-xs text-muted">
      <p>{t('disclaimer', { providers })}</p>
      <p className="mt-1">
        Charts by{' '}
        <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center underline hover:text-text">
          TradingView
        </a>
      </p>
    </footer>
  );
}

'use client';

import { isRange, RANGES, type PriceLevel, type Range } from '@tm/shared';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMeta } from '@/lib/api';
import { loadPref, savePref } from '@/lib/prefs';
import { useLiveQuote } from '@/lib/use-live-quote';
import { AskAiPanel } from './AskAiPanel';
import { AiSummaryPanel } from './AiSummaryPanel';
import { AlertCenter } from './AlertCenter';
import { AlertsPanel } from './AlertsPanel';
import { ChartCard } from './ChartCard';
import { ConnectionBanner } from './ConnectionBanner';
import { AlertDialog, CompareDialog, Modal, ShortcutsDialog, type AlertPreset } from './Dialogs';
import { Header } from './Header';
import { InsightCards } from './InsightCards';
import { KeyLevelsCard } from './KeyLevelsCard';
import { MarketStatusBar } from './MarketStatusBar';
import { NewsCard } from './NewsCard';
import { PriceHeader } from './PriceHeader';
import { StatsCard } from './StatsCard';
import { cx } from './ui';
import { Watchlist } from './Watchlist';

type Tab = 'news' | 'insight' | 'stats';
const TABS: Tab[] = ['news', 'insight', 'stats'];
export const MAX_COMPARES = 2;

export interface InitialPrefs {
  range: Range;
  levels: boolean;
  pivots: boolean;
}

export function Dashboard({ symbol, initial }: { symbol: string; initial: InitialPrefs }) {
  const t = useTranslations();
  const [range, setRange] = useState<Range>(initial.range);
  const [showLevels, setShowLevels] = useState(initial.levels);
  const [showPivots, setShowPivots] = useState(initial.pivots);
  const [tab, setTab] = useState<Tab>('news');
  const [compares, setCompares] = useState<string[]>([]);
  const [showAskAi, setShowAskAi] = useState(false);
  const [dialog, setDialog] = useState<'alert' | 'compare' | 'watchlist' | 'shortcuts' | null>(null);
  const [alertPreset, setAlertPreset] = useState<AlertPreset>(null);
  const live = useLiveQuote(symbol, true);

  // Remember the symbol; restore prefs from localStorage if the cookies were cleared.
  useEffect(() => savePref('symbol', symbol), [symbol]);
  useEffect(() => {
    const r = loadPref('range');
    if (r && isRange(r) && r !== initial.range) setRange(r);
    const l = loadPref('levels');
    if (l != null) setShowLevels(l === '1');
    const p = loadPref('pivots');
    if (p != null) setShowPivots(p === '1');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const changeRange = useCallback((r: Range) => {
    setRange(r);
    savePref('range', r);
  }, []);
  const toggleLevels = useCallback(() => setShowLevels((v) => (savePref('levels', v ? '0' : '1'), !v)), []);
  const togglePivots = useCallback(() => setShowPivots((v) => (savePref('pivots', v ? '0' : '1'), !v)), []);

  const openAlert = (level?: PriceLevel) => {
    setAlertPreset(level ? { kind: 'near_level', level } : null);
    setDialog('alert');
  };
  const addCompare = (s: string) => setCompares((cur) => (cur.includes(s) || s === symbol || cur.length >= MAX_COMPARES ? cur : [...cur, s]));
  const removeCompare = (s: string) => setCompares((cur) => cur.filter((x) => x !== s));
  useEffect(() => setCompares([]), [symbol]);

  // Keyboard shortcuts — ignored while typing or when a dialog is open.
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (dialogRef.current || document.querySelector('dialog[open]')) return;
      const k = e.key;
      if (k === '/') {
        e.preventDefault();
        document.getElementById('global-search')?.focus();
      } else if (k >= '1' && k <= '7') {
        changeRange(RANGES[Number(k) - 1]);
      } else if (k === 'l' || k === 'L') {
        toggleLevels();
      } else if (k === 'p' || k === 'P') {
        togglePivots();
      } else if (k === 'c' || k === 'C') {
        setDialog('compare');
      } else if (k === 'a' || k === 'A') {
        setShowAskAi((v) => !v);
      } else if (k === '?') {
        setDialog('shortcuts');
      } else {
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [changeRange, toggleLevels, togglePivots]);

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
      <ConnectionBanner />
      <MockBanner />
      <Header onOpenWatchlist={() => setDialog('watchlist')} />
      <MarketStatusBar />

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
              compareCount={compares.length}
              maxCompares={MAX_COMPARES}
              onAlert={() => openAlert()}
              onCompare={() => setDialog('compare')}
              onAskAi={() => setShowAskAi(true)}
            />
          </div>
          <div className="area-summary min-w-0">
            <AiSummaryPanel
              symbol={symbol}
              onShowNews={() => {
                setTab('news');
                requestAnimationFrame(() => document.getElementById('news-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
              }}
              onAskAi={() => setShowAskAi(true)}
            />
          </div>
          <div className="area-chart min-w-0">
            <ChartCard
              symbol={symbol}
              range={range}
              onRange={changeRange}
              quote={live.data}
              streaming={live.streaming}
              compares={compares}
              onRemoveCompare={removeCompare}
              showLevels={showLevels}
              showPivots={showPivots}
              onToggleLevels={toggleLevels}
              onTogglePivots={togglePivots}
            />
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

      <Footer onShortcuts={() => setDialog('shortcuts')} />

      <Modal side open={dialog === 'watchlist'} onClose={() => setDialog(null)} title={t('watchlist.title')}>
        <div className="space-y-3 p-3">
          <Watchlist current={symbol} onNavigate={() => setDialog(null)} />
          <AlertsPanel onNavigate={() => setDialog(null)} />
        </div>
      </Modal>
      <AlertDialog open={dialog === 'alert'} onClose={() => setDialog(null)} symbol={symbol} quote={live.data} range={range} preset={alertPreset} />
      <CompareDialog open={dialog === 'compare'} onClose={() => setDialog(null)} symbol={symbol} current={compares} max={MAX_COMPARES} onPick={addCompare} />
      <ShortcutsDialog open={dialog === 'shortcuts'} onClose={() => setDialog(null)} />
      <AskAiPanel open={showAskAi} onClose={() => setShowAskAi(false)} symbol={symbol} quote={live.data} />
      <AlertCenter />
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

function Footer({ onShortcuts }: { onShortcuts: () => void }) {
  const t = useTranslations('footer');
  const { data } = useMeta();
  const providers = data?.providers.join(', ') ?? '—';
  return (
    <footer className="border-t border-border px-4 py-4 text-center text-xs text-muted">
      <p>{t('disclaimer', { providers })}</p>
      <p className="mt-1 flex flex-wrap items-center justify-center gap-x-4">
        <span>
          Charts by{' '}
          <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center underline hover:text-text">
            TradingView
          </a>
        </span>
        <button type="button" onClick={onShortcuts} className="inline-flex min-h-11 items-center gap-1 underline hover:text-text">
          {t('shortcuts')} <kbd className="rounded border border-border px-1 font-mono">?</kbd>
        </button>
      </p>
    </footer>
  );
}

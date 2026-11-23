'use client';

import { useState, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { cx } from '../ui';
import {
  OVERLAY_CONFIGS,
  PANEL_CONFIGS,
  type OverlayIndicatorKey,
  type PanelIndicatorKey,
} from './ChartIndicatorEngine';
import type { DrawingType } from './ChartDrawingManager';

export type ExtendedChartType = 'candles' | 'line' | 'area';

interface Props {
  chartType: ExtendedChartType;
  onChangeChartType: (t: ExtendedChartType) => void;
  activeOverlays: OverlayIndicatorKey[];
  onToggleOverlay: (k: OverlayIndicatorKey) => void;
  activePanel: PanelIndicatorKey | null;
  onSelectPanel: (p: PanelIndicatorKey | null) => void;
  comparing: boolean;
  onResetZoom: () => void;
  onToggleFullscreen: () => void;
  isFullscreen: boolean;
  onExportPng: () => void;
  onAddDrawing?: (type: DrawingType) => void;
  onClearDrawings?: () => void;
  hasDrawings?: boolean;
}

export function ChartToolbar({
  chartType,
  onChangeChartType,
  activeOverlays,
  onToggleOverlay,
  activePanel,
  onSelectPanel,
  comparing,
  onResetZoom,
  onToggleFullscreen,
  isFullscreen,
  onExportPng,
  onAddDrawing,
  onClearDrawings,
  hasDrawings,
}: Props) {
  const t = useTranslations('chart.terminal');
  const [indicatorsOpen, setIndicatorsOpen] = useState(false);
  const [drawOpen, setDrawOpen] = useState(false);
  const indMenuRef = useRef<HTMLDivElement>(null);
  const drawMenuRef = useRef<HTMLDivElement>(null);

  // Close menus on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (indMenuRef.current && !indMenuRef.current.contains(e.target as Node)) {
        setIndicatorsOpen(false);
      }
      if (drawMenuRef.current && !drawMenuRef.current.contains(e.target as Node)) {
        setDrawOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div
      role="toolbar"
      aria-label={t('toolbarLabel')}
      className="flex flex-wrap items-center gap-1.5 px-3 py-1.5 border-b border-border bg-panel-2/60 text-xs"
    >
      {/* Chart Type Selector */}
      <div role="group" aria-label={t('styleLabel')} className="flex rounded-md border border-border bg-panel p-0.5">
        {(['candles', 'line', 'area'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={chartType === mode}
            onClick={() => onChangeChartType(mode)}
            disabled={comparing && mode === 'candles'}
            className={cx(
              'min-h-8 rounded px-2.5 font-medium transition-colors disabled:opacity-40',
              chartType === mode
                ? 'bg-panel-2 text-text shadow-sm'
                : 'text-muted hover:text-text',
            )}
            title={t(mode)}
          >
            {t(mode)}
          </button>
        ))}
      </div>

      <div className="h-4 w-px bg-border mx-1" aria-hidden />

      {/* Indicators Dropdown */}
      <div className="relative" ref={indMenuRef}>
        <button
          type="button"
          aria-expanded={indicatorsOpen}
          aria-label={t('indicatorsLabel')}
          onClick={() => setIndicatorsOpen((prev) => !prev)}
          className={cx(
            'min-h-8 inline-flex items-center gap-1.5 rounded-md border px-2.5 font-medium transition-colors',
            activeOverlays.length > 0 || activePanel != null
              ? 'border-accent/60 bg-accent/10 text-accent font-semibold'
              : 'border-border bg-panel text-muted hover:text-text',
          )}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
          <span>{t('indicators')}</span>
          {(activeOverlays.length > 0 || activePanel != null) && (
            <span className="flex size-4 items-center justify-center rounded-full bg-accent text-[10px] font-bold text-panel">
              {activeOverlays.length + (activePanel ? 1 : 0)}
            </span>
          )}
        </button>

        {indicatorsOpen && (
          <div
            role="dialog"
            aria-label={t('indicatorsMenu')}
            className="absolute left-0 top-full z-30 mt-1 w-64 rounded-lg border border-border bg-panel p-2 shadow-xl backdrop-blur-md"
          >
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted px-1">
              {t('overlaysTitle')}
            </div>
            <div className="space-y-0.5">
              {(Object.keys(OVERLAY_CONFIGS) as OverlayIndicatorKey[]).map((k) => {
                const conf = OVERLAY_CONFIGS[k];
                const active = activeOverlays.includes(k);
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => onToggleOverlay(k)}
                    className={cx(
                      'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs transition-colors',
                      active ? 'bg-panel-2 text-text font-medium' : 'text-muted hover:bg-panel-2/50 hover:text-text',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className="size-2 rounded-full" style={{ backgroundColor: conf.color }} />
                      {conf.label}
                    </span>
                    {active && <span className="text-accent text-[11px]">✓</span>}
                  </button>
                );
              })}
            </div>

            <div className="my-2 border-t border-border" />

            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted px-1">
              {t('subPanelsTitle')}
            </div>
            <div className="space-y-0.5">
              <button
                type="button"
                onClick={() => onSelectPanel(null)}
                className={cx(
                  'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs transition-colors',
                  activePanel === null ? 'bg-panel-2 text-text font-medium' : 'text-muted hover:bg-panel-2/50 hover:text-text',
                )}
              >
                <span>{t('none')}</span>
                {activePanel === null && <span className="text-accent text-[11px]">✓</span>}
              </button>
              {(Object.keys(PANEL_CONFIGS) as PanelIndicatorKey[]).map((k) => {
                const conf = PANEL_CONFIGS[k];
                const active = activePanel === k;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => onSelectPanel(active ? null : k)}
                    className={cx(
                      'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs transition-colors',
                      active ? 'bg-panel-2 text-text font-medium' : 'text-muted hover:bg-panel-2/50 hover:text-text',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className="size-2 rounded-full" style={{ backgroundColor: conf.color }} />
                      {conf.label}
                    </span>
                    {active && <span className="text-accent text-[11px]">✓</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Drawings Menu */}
      {onAddDrawing && (
        <div className="relative" ref={drawMenuRef}>
          <button
            type="button"
            aria-expanded={drawOpen}
            aria-label={t('drawingsLabel')}
            onClick={() => setDrawOpen((prev) => !prev)}
            className="min-h-8 inline-flex items-center gap-1.5 rounded-md border border-border bg-panel px-2.5 font-medium text-muted hover:text-text transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
            <span>{t('draw')}</span>
          </button>

          {drawOpen && (
            <div
              role="dialog"
              aria-label={t('drawingsMenu')}
              className="absolute left-0 top-full z-30 mt-1 w-48 rounded-lg border border-border bg-panel p-1.5 shadow-xl backdrop-blur-md"
            >
              <button
                type="button"
                onClick={() => {
                  onAddDrawing('horizontal');
                  setDrawOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-muted hover:bg-panel-2 hover:text-text"
              >
                <span className="w-3 border-t-2 border-dashed border-accent" />
                {t('horizontalLine')}
              </button>
              <button
                type="button"
                onClick={() => {
                  onAddDrawing('trendline');
                  setDrawOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-muted hover:bg-panel-2 hover:text-text"
              >
                <span className="w-3 -rotate-45 border-t-2 border-accent" />
                {t('trendline')}
              </button>
              <button
                type="button"
                onClick={() => {
                  onAddDrawing('measure');
                  setDrawOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-muted hover:bg-panel-2 hover:text-text"
              >
                <span className="size-3 border border-dashed border-accent" />
                {t('priceRange')}
              </button>
              {hasDrawings && onClearDrawings && (
                <>
                  <div className="my-1 border-t border-border" />
                  <button
                    type="button"
                    onClick={() => {
                      onClearDrawings();
                      setDrawOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-down hover:bg-down/10"
                  >
                    {t('clearAll')}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Utility buttons pushed to the right */}
      <div className="ml-auto flex items-center gap-1">
        {/* Reset Zoom / Fit content */}
        <button
          type="button"
          onClick={onResetZoom}
          aria-label={t('resetZoom')}
          title={t('resetZoomTitle')}
          className="inline-flex size-8 items-center justify-center rounded-md border border-border bg-panel text-muted hover:text-text transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        </button>

        {/* Export PNG */}
        <button
          type="button"
          onClick={onExportPng}
          aria-label={t('exportPng')}
          title={t('exportPngTitle')}
          className="inline-flex size-8 items-center justify-center rounded-md border border-border bg-panel text-muted hover:text-text transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>

        {/* Fullscreen Toggle */}
        <button
          type="button"
          onClick={onToggleFullscreen}
          aria-label={isFullscreen ? t('exitFullscreen') : t('enterFullscreen')}
          title={isFullscreen ? t('exitFullscreenTitle') : t('fullscreen')}
          className="inline-flex size-8 items-center justify-center rounded-md border border-border bg-panel text-muted hover:text-text transition-colors"
        >
          {isFullscreen ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

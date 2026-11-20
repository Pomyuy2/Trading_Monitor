'use client';

import type { InvestmentResearchReport, InvestmentVerdictCategory, ToolExecutionStep } from '@tm/shared';
import { useState } from 'react';
import { cx } from './ui';

interface Props {
  report: InvestmentResearchReport;
  toolSteps?: ToolExecutionStep[];
}

export function ResearchReportCard({ report, toolSteps }: Props) {
  const [activeTab, setActiveTab] = useState<'valuation' | 'fundamentals' | 'technicals' | 'risk'>('valuation');
  const [showTools, setShowTools] = useState(false);

  const getVerdictStyle = (v: InvestmentVerdictCategory) => {
    switch (v) {
      case 'ATTRACTIVE_UNDER_ASSUMPTIONS':
        return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30';
      case 'UNATTRACTIVE_UNDER_ASSUMPTIONS':
        return 'bg-rose-500/10 text-rose-400 border-rose-500/30';
      case 'NEUTRAL':
        return 'bg-amber-500/10 text-amber-400 border-amber-500/30';
      case 'INSUFFICIENT_DATA':
      default:
        return 'bg-slate-500/10 text-slate-400 border-slate-500/30';
    }
  };

  const getVerdictLabel = (v: InvestmentVerdictCategory) => {
    switch (v) {
      case 'ATTRACTIVE_UNDER_ASSUMPTIONS':
        return '✦ Attractive Under Assumptions';
      case 'UNATTRACTIVE_UNDER_ASSUMPTIONS':
        return '▼ Unattractive Under Assumptions';
      case 'NEUTRAL':
        return '● Neutral';
      case 'INSUFFICIENT_DATA':
        return '? Insufficient Data';
    }
  };

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-border bg-panel text-text shadow-md">
      {/* Header Banner */}
      <div className="border-b border-border bg-panel-2/60 p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="font-mono font-bold text-sm text-text sm:text-base">
              {report.symbol}
            </span>
            <span className="text-muted text-xs">·</span>
            <span className="text-xs font-medium text-muted capitalize">
              {report.horizon} Horizon
            </span>
          </div>
          <span
            className={cx(
              'rounded-full border px-2.5 py-0.5 text-xs font-semibold tracking-wide',
              getVerdictStyle(report.verdict),
            )}
          >
            {getVerdictLabel(report.verdict)}
          </span>
        </div>

        {report.summary && (
          <p className="mt-2 text-xs leading-relaxed text-text/90">
            {report.summary}
          </p>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border bg-panel text-xs font-medium">
        <button
          type="button"
          onClick={() => setActiveTab('valuation')}
          className={cx(
            'flex-1 py-2 text-center transition-colors border-b-2',
            activeTab === 'valuation'
              ? 'border-accent text-accent font-semibold'
              : 'border-transparent text-muted hover:text-text',
          )}
        >
          Valuation
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('fundamentals')}
          className={cx(
            'flex-1 py-2 text-center transition-colors border-b-2',
            activeTab === 'fundamentals'
              ? 'border-accent text-accent font-semibold'
              : 'border-transparent text-muted hover:text-text',
          )}
        >
          Fundamentals
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('technicals')}
          className={cx(
            'flex-1 py-2 text-center transition-colors border-b-2',
            activeTab === 'technicals'
              ? 'border-accent text-accent font-semibold'
              : 'border-transparent text-muted hover:text-text',
          )}
        >
          Technicals
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('risk')}
          className={cx(
            'flex-1 py-2 text-center transition-colors border-b-2',
            activeTab === 'risk'
              ? 'border-accent text-accent font-semibold'
              : 'border-transparent text-muted hover:text-text',
          )}
        >
          Risk & Thesis
        </button>
      </div>

      {/* Tab Contents */}
      <div className="p-3.5 text-xs">
        {/* Valuation Tab */}
        {activeTab === 'valuation' && (
          <div className="space-y-3">
            {report.valuationScenarios ? (
              <>
                <div className="grid grid-cols-3 gap-2">
                  {/* Bull Case */}
                  <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-2 text-center">
                    <span className="block text-[10px] font-semibold uppercase text-emerald-400">Bull Case</span>
                    <span className="font-mono font-bold text-sm text-text">
                      ${report.valuationScenarios.bull?.impliedFairValue ?? 'N/A'}
                    </span>
                    {report.valuationScenarios.bull?.upsideDownsidePercent != null && (
                      <span className="block text-[10px] text-emerald-400">
                        +{report.valuationScenarios.bull.upsideDownsidePercent}%
                      </span>
                    )}
                  </div>

                  {/* Base Case */}
                  <div className="rounded-lg border border-accent/20 bg-accent/5 p-2 text-center">
                    <span className="block text-[10px] font-semibold uppercase text-accent">Base Case</span>
                    <span className="font-mono font-bold text-sm text-text">
                      ${report.valuationScenarios.base?.impliedFairValue ?? 'N/A'}
                    </span>
                    {report.valuationScenarios.base?.upsideDownsidePercent != null && (
                      <span className="block text-[10px] text-muted">
                        {report.valuationScenarios.base.upsideDownsidePercent > 0 ? '+' : ''}
                        {report.valuationScenarios.base.upsideDownsidePercent}%
                      </span>
                    )}
                  </div>

                  {/* Bear Case */}
                  <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-2 text-center">
                    <span className="block text-[10px] font-semibold uppercase text-rose-400">Bear Case</span>
                    <span className="font-mono font-bold text-sm text-text">
                      ${report.valuationScenarios.bear?.impliedFairValue ?? 'N/A'}
                    </span>
                    {report.valuationScenarios.bear?.upsideDownsidePercent != null && (
                      <span className="block text-[10px] text-rose-400">
                        {report.valuationScenarios.bear.upsideDownsidePercent}%
                      </span>
                    )}
                  </div>
                </div>

                <div className="rounded-md bg-panel-2 p-2 text-[11px] text-muted">
                  <p><strong>Base Assumptions:</strong> {report.valuationScenarios.base?.keyAssumptions}</p>
                  {report.valuationScenarios.keyTakeaway && (
                    <p className="mt-1 text-text/80">{report.valuationScenarios.keyTakeaway}</p>
                  )}
                </div>
              </>
            ) : (
              <p className="text-muted">No DCF valuation scenarios available for this security.</p>
            )}
          </div>
        )}

        {/* Fundamentals Tab */}
        {activeTab === 'fundamentals' && (
          <div className="space-y-3">
            {report.fundamentals ? (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-md border border-border bg-panel-2/50 p-2 text-center">
                    <span className="block text-[10px] text-muted">Rev YoY Growth</span>
                    <span className="font-mono font-semibold text-text">
                      {report.fundamentals.revenueGrowthYoY != null
                        ? `${(report.fundamentals.revenueGrowthYoY * 100).toFixed(1)}%`
                        : 'N/A'}
                    </span>
                  </div>
                  <div className="rounded-md border border-border bg-panel-2/50 p-2 text-center">
                    <span className="block text-[10px] text-muted">Net Margin</span>
                    <span className="font-mono font-semibold text-text">
                      {report.fundamentals.netMargin != null
                        ? `${(report.fundamentals.netMargin * 100).toFixed(1)}%`
                        : 'N/A'}
                    </span>
                  </div>
                  <div className="rounded-md border border-border bg-panel-2/50 p-2 text-center">
                    <span className="block text-[10px] text-muted">FCF Margin</span>
                    <span className="font-mono font-semibold text-text">
                      {report.fundamentals.fcfMargin != null
                        ? `${(report.fundamentals.fcfMargin * 100).toFixed(1)}%`
                        : 'N/A'}
                    </span>
                  </div>
                  <div className="rounded-md border border-border bg-panel-2/50 p-2 text-center">
                    <span className="block text-[10px] text-muted">ROE</span>
                    <span className="font-mono font-semibold text-text">
                      {report.fundamentals.roe != null
                        ? `${(report.fundamentals.roe * 100).toFixed(1)}%`
                        : 'N/A'}
                    </span>
                  </div>
                  <div className="rounded-md border border-border bg-panel-2/50 p-2 text-center">
                    <span className="block text-[10px] text-muted">ROIC</span>
                    <span className="font-mono font-semibold text-text">
                      {report.fundamentals.roic != null
                        ? `${(report.fundamentals.roic * 100).toFixed(1)}%`
                        : 'N/A'}
                    </span>
                  </div>
                  <div className="rounded-md border border-border bg-panel-2/50 p-2 text-center">
                    <span className="block text-[10px] text-muted">Debt / Equity</span>
                    <span className="font-mono font-semibold text-text">
                      {report.fundamentals.debtToEquity != null
                        ? report.fundamentals.debtToEquity.toFixed(2)
                        : 'N/A'}
                    </span>
                  </div>
                </div>
                {report.fundamentals.keyTakeaway && (
                  <p className="rounded-md bg-panel-2 p-2 text-[11px] text-text/80">
                    {report.fundamentals.keyTakeaway}
                  </p>
                )}
              </>
            ) : (
              <p className="text-muted">No fundamental ratios available.</p>
            )}
          </div>
        )}

        {/* Technicals Tab */}
        {activeTab === 'technicals' && (
          <div className="space-y-3">
            {report.technicals ? (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-md border border-border bg-panel-2/50 p-2 text-center">
                    <span className="block text-[10px] text-muted">Price</span>
                    <span className="font-mono font-semibold text-text">${report.technicals.currentPrice}</span>
                  </div>
                  <div className="rounded-md border border-border bg-panel-2/50 p-2 text-center">
                    <span className="block text-[10px] text-muted">Trend</span>
                    <span
                      className={cx(
                        'font-semibold uppercase text-xs',
                        report.technicals.trend === 'bullish'
                          ? 'text-emerald-400'
                          : report.technicals.trend === 'bearish'
                          ? 'text-rose-400'
                          : 'text-amber-400',
                      )}
                    >
                      {report.technicals.trend}
                    </span>
                  </div>
                  <div className="rounded-md border border-border bg-panel-2/50 p-2 text-center">
                    <span className="block text-[10px] text-muted">RSI (14)</span>
                    <span className="font-mono font-semibold text-text">
                      {report.technicals.rsi14 ?? 'N/A'}
                    </span>
                  </div>
                </div>

                <div className="flex gap-2">
                  {report.technicals.supportPrice != null && (
                    <div className="flex-1 rounded-md bg-panel-2 p-2 text-center">
                      <span className="block text-[10px] text-emerald-400 font-medium">Key Support</span>
                      <span className="font-mono font-semibold text-text">${report.technicals.supportPrice}</span>
                    </div>
                  )}
                  {report.technicals.resistancePrice != null && (
                    <div className="flex-1 rounded-md bg-panel-2 p-2 text-center">
                      <span className="block text-[10px] text-rose-400 font-medium">Key Resistance</span>
                      <span className="font-mono font-semibold text-text">${report.technicals.resistancePrice}</span>
                    </div>
                  )}
                </div>

                {report.technicals.keyTakeaway && (
                  <p className="rounded-md bg-panel-2 p-2 text-[11px] text-text/80">
                    {report.technicals.keyTakeaway}
                  </p>
                )}
              </>
            ) : (
              <p className="text-muted">No technical indicators available.</p>
            )}
          </div>
        )}

        {/* Risk & Thesis Tab */}
        {activeTab === 'risk' && (
          <div className="space-y-3">
            {report.riskAssessment ? (
              <>
                <div className="flex items-center justify-between rounded-md border border-border bg-panel-2/50 p-2.5">
                  <span className="text-xs text-muted font-medium">Risk Rating</span>
                  <span
                    className={cx(
                      'rounded px-2 py-0.5 text-xs font-semibold uppercase',
                      report.riskAssessment.riskRating === 'low'
                        ? 'bg-emerald-500/10 text-emerald-400'
                        : report.riskAssessment.riskRating === 'moderate'
                        ? 'bg-amber-500/10 text-amber-400'
                        : 'bg-rose-500/10 text-rose-400',
                    )}
                  >
                    {report.riskAssessment.riskRating}
                  </span>
                </div>

                {report.riskAssessment.downsideRisks && report.riskAssessment.downsideRisks.length > 0 && (
                  <div>
                    <span className="block text-[11px] font-semibold text-rose-400 uppercase tracking-wide">
                      Key Downside Risks
                    </span>
                    <ul className="mt-1 list-disc space-y-1 pl-4 text-[11px] text-muted">
                      {report.riskAssessment.downsideRisks.map((risk, idx) => (
                        <li key={idx}>{risk}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {report.riskAssessment.thesisInvalidation && report.riskAssessment.thesisInvalidation.length > 0 && (
                  <div className="rounded-md border border-rose-500/20 bg-rose-500/5 p-2.5">
                    <span className="block text-[11px] font-semibold text-rose-300 uppercase tracking-wide">
                      Thesis Invalidation Criteria
                    </span>
                    <ul className="mt-1 list-disc space-y-1 pl-4 text-[11px] text-rose-200/90">
                      {report.riskAssessment.thesisInvalidation.map((crit, idx) => (
                        <li key={idx}>{crit}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <p className="text-muted">No risk assessment available.</p>
            )}

            {report.portfolioConsiderations && (
              <div className="rounded-md bg-panel-2 p-2.5 text-[11px] text-muted">
                <span className="block font-semibold text-accent uppercase tracking-wide">
                  Suitability & Portfolio Context
                </span>
                <p className="mt-1 text-text/80">{report.portfolioConsiderations.suitability}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Tool Execution Steps Collapsible */}
      {toolSteps && toolSteps.length > 0 && (
        <div className="border-t border-border bg-panel-2/30 p-2.5 text-[11px]">
          <button
            type="button"
            onClick={() => setShowTools(!showTools)}
            className="flex w-full items-center justify-between text-muted hover:text-text transition-colors"
          >
            <span className="flex items-center gap-1.5 font-medium">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              <span>{toolSteps.length} tools executed during analysis</span>
            </span>
            <span>{showTools ? '▲ Hide' : '▼ View Tools'}</span>
          </button>

          {showTools && (
            <div className="mt-2 space-y-1.5 pt-2 border-t border-border/50">
              {toolSteps.map((s, idx) => (
                <div key={idx} className="flex items-center justify-between rounded bg-panel p-1.5 text-[10px] text-muted font-mono">
                  <span className="text-text font-medium">{s.tool}</span>
                  <span>{s.durationMs}ms</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

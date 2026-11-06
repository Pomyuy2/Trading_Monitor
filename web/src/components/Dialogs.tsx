'use client';

import { isValidSymbol, NEAR_LEVEL_PCT, normalizeSymbol, type PriceLevel, type Quote, type Range } from '@tm/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAlertText } from '@/lib/alert-text';
import { createAlert, deleteAlert, useAlerts, useLevels, useWatchlist } from '@/lib/api';
import { fmtNumber, fmtPrice } from '@/lib/format';
import { ensureNotificationPermission } from './AlertCenter';
import { ensurePushSubscription } from '@/lib/pwa';
import { XIcon } from './icons';
import { btn, cx, Skeleton, useLang } from './ui';

/** Native <dialog>: focus trap, Esc to close, backdrop. */
export function Modal({ open, onClose, title, children, side }: { open: boolean; onClose: () => void; title: string; children: ReactNode; side?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const tc = useTranslations('common');
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-label={title}
      className={cx(
        'border border-border bg-panel p-0 text-text shadow-2xl',
        side ? 'm-0 h-dvh max-h-dvh w-[88vw] max-w-sm' : 'm-auto w-[min(92vw,28rem)] rounded-xl',
      )}
    >
      <div className="flex min-h-14 items-center justify-between border-b border-border pl-4 pr-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        <button type="button" className={btn.icon} onClick={onClose} aria-label={tc('close')}>
          <XIcon />
        </button>
      </div>
      <div className={side ? 'overflow-y-auto' : 'p-4'}>{children}</div>
    </dialog>
  );
}

export type AlertPreset = { kind: 'near_level' | 'breakout'; level: PriceLevel } | null;
type AlertType = 'price_above' | 'price_below' | 'near_level' | 'breakout';

export function AlertDialog({
  open,
  onClose,
  symbol,
  quote,
  range,
  preset,
}: {
  open: boolean;
  onClose: () => void;
  symbol: string;
  quote: Quote | undefined;
  range: Range;
  preset?: AlertPreset;
}) {
  const t = useTranslations('alert');
  const ta = useTranslations('alerts');
  const tl = useTranslations('levels');
  const tc = useTranslations('common');
  const tch = useTranslations('chart');
  const lang = useLang();
  const text = useAlertText(lang);
  const { data: alerts } = useAlerts();
  const lv = useLevels(open ? symbol : null, range);
  const levels = lv.data && lv.data.symbol === symbol && lv.data.range === range ? [...lv.data.resistances].reverse().concat(lv.data.supports) : [];

  const [type, setType] = useState<AlertType>('price_above');
  const [price, setPrice] = useState('');
  const [levelKey, setLevelKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Reset each time the dialog opens (optionally preset from a Key levels row).
  useEffect(() => {
    if (!open) return;
    setError(null);
    setNotice(null);
    if (preset) {
      setType(preset.kind);
      setLevelKey(keyOf(preset.level));
    } else {
      setType('price_above');
      setLevelKey(null);
      if (quote?.price != null) setPrice((quote.price * 1.02).toFixed(2));
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Suggest a target on the right side of the price when switching above/below.
  const pickType = (k: AlertType) => {
    setType(k);
    setError(null);
    if ((k === 'price_above' || k === 'price_below') && quote?.price != null) {
      setPrice((quote.price * (k === 'price_above' ? 1.02 : 0.98)).toFixed(2));
    }
  };

  const level = levels.find((l) => keyOf(l) === levelKey) ?? (preset && keyOf(preset.level) === levelKey ? preset.level : undefined);
  const isLevel = type === 'near_level' || type === 'breakout';
  const target = Number(price);
  const canSave = isLevel ? !!level : Number.isFinite(target) && target > 0;
  const mine = (alerts ?? []).filter((a) => a.symbol === symbol && a.status === 'active');

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (isLevel && level) {
        await createAlert({ symbol, kind: type as 'near_level' | 'breakout', level: { kind: level.kind, price: level.price, zoneLow: level.zoneLow, zoneHigh: level.zoneHigh, range } });
      } else {
        await createAlert({ symbol, kind: type as 'price_above' | 'price_below', targetPrice: target });
      }
      const perm = await ensureNotificationPermission();
      if (perm === 'granted') void ensurePushSubscription(lang); // installed app: alerts also arrive via push
      if (perm === 'granted') onClose();
      else setNotice(t('savedNoNotifications'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const TYPES: AlertType[] = ['price_above', 'price_below', 'near_level', 'breakout'];
  return (
    <Modal open={open} onClose={onClose} title={t('title', { symbol })}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave && !saving) void save();
        }}
        className="space-y-4"
      >
        <fieldset>
          <legend className="text-sm text-muted">{t('type')}</legend>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {TYPES.map((k) => (
              <button key={k} type="button" aria-pressed={type === k} onClick={() => pickType(k)} className={cx(btn.ghost, 'px-2 text-xs', type === k && 'border-accent bg-accent/10')}>
                <span aria-hidden>{k === 'price_above' ? '▲' : k === 'price_below' ? '▼' : k === 'near_level' ? '≈' : '⇥'}</span> {t(`types.${k}`)}
              </button>
            ))}
          </div>
        </fieldset>

        {!isLevel ? (
          <div>
            <label htmlFor="alert-price" className="text-sm text-muted">{t('price')}</label>
            <input
              id="alert-price"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ''))}
              className="mt-1 h-11 w-full rounded-md border border-border bg-bg px-3 font-mono text-text focus:border-accent focus:outline-none"
            />
            {quote?.price != null && <p className="mt-1 text-xs text-muted">{t('currentPrice', { price: fmtPrice(quote.price, lang, quote.currency) })}</p>}
          </div>
        ) : (
          <fieldset>
            <legend className="text-sm text-muted">{t('pickLevel', { range: tch(`rangeNames.${range}`) })}</legend>
            {lv.isLoading ? (
              <Skeleton className="mt-2 h-24" />
            ) : levels.length === 0 ? (
              <p className="mt-2 text-sm text-muted">— {t('noLevels')}</p>
            ) : (
              <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
                {levels.map((l) => (
                  <label key={keyOf(l)} className={cx('flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-3 py-1.5 text-sm', levelKey === keyOf(l) ? 'border-accent bg-accent/10' : 'border-border')}>
                    <input type="radio" name="alert-level" checked={levelKey === keyOf(l)} onChange={() => setLevelKey(keyOf(l))} className="accent-[#4C8DFF]" />
                    <span className={l.kind === 'support' ? 'text-accent' : 'text-resist'}>{tl(l.kind)}</span>
                    <span className="ml-auto font-mono">{fmtPrice(l.price, lang)}</span>
                    <span className="font-mono text-xs text-muted">{fmtNumber(l.zoneLow, lang)}–{fmtNumber(l.zoneHigh, lang)}</span>
                  </label>
                ))}
              </div>
            )}
            <p className="mt-2 text-xs text-muted">{type === 'near_level' ? t('nearHelp', { pct: NEAR_LEVEL_PCT }) : t('breakoutHelp')}</p>
            <p className="mt-1 text-[11px] text-muted">{tl('disclaimer')}</p>
          </fieldset>
        )}

        {canSave && (
          <p className="rounded-md bg-panel-2 p-2 text-xs text-text">
            {t('willNotify')}{' '}
            {text.condition({
              kind: type,
              targetPrice: isLevel ? null : target,
              level: isLevel && level ? { kind: level.kind, price: level.price, zoneLow: level.zoneLow, zoneHigh: level.zoneHigh, range } : null,
            })}
          </p>
        )}
        {error && <p role="alert" className="text-sm text-down">{error}</p>}
        {notice && <p role="status" className="rounded-md border border-warn/40 bg-warn/5 p-2 text-xs text-warn">{notice}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" className={btn.ghost} onClick={onClose}>{notice ? tc('close') : tc('cancel')}</button>
          {!notice && (
            <button type="submit" className={btn.primary} disabled={!canSave || saving}>
              {saving ? tc('loading') : t('save')}
            </button>
          )}
        </div>

        {mine.length > 0 && (
          <div className="border-t border-border pt-3">
            <h3 className="text-xs text-muted">{t('existing', { count: mine.length })}</h3>
            <ul className="mt-1 space-y-1">
              {mine.map((a) => (
                <li key={a.id} className="flex items-center gap-2 text-xs">
                  <span className="flex-1">{text.condition(a)}</span>
                  <button type="button" onClick={() => deleteAlert(a.id)} aria-label={ta('delete', { condition: text.condition(a) })} className="inline-flex size-11 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-down">
                    <XIcon width={14} height={14} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </form>
    </Modal>
  );
}

const keyOf = (l: PriceLevel) => `${l.kind}:${l.price}`;

export function CompareDialog({
  open,
  onClose,
  symbol,
  current,
  max,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  symbol: string;
  current: string[];
  max: number;
  onPick: (s: string) => void;
}) {
  const t = useTranslations('compare');
  const { data } = useWatchlist();
  const [custom, setCustom] = useState('');
  const taken = new Set([symbol, ...current]);
  const full = current.length >= max;
  const options = (data ?? []).map((i) => i.symbol).filter((s) => !taken.has(s) && s !== 'SPY');
  const pick = (s: string) => {
    onPick(s);
    setCustom('');
    if (current.length + 1 >= max) onClose();
  };
  const customSym = normalizeSymbol(custom);
  const customOk = isValidSymbol(customSym) && !taken.has(customSym);
  return (
    <Modal open={open} onClose={onClose} title={t('title', { symbol })}>
      <p className="text-xs text-muted">{t('hint', { max })}</p>
      <p className="mt-1 text-xs text-muted" role="status">{t('slots', { used: current.length, max })}</p>
      {full ? (
        <p className="mt-3 text-sm text-text">{t('full', { max })}</p>
      ) : (
        <>
          <button
            type="button"
            className={cx(btn.ghost, 'mt-3 w-full justify-start')}
            onClick={() => pick('SPY')}
            disabled={taken.has('SPY')}
            aria-label={t('pick', { symbol: 'SPY' })}
          >
            <span className="font-mono font-semibold">SPY</span>
            <span className="text-xs text-muted">{t('spy')}</span>
          </button>
          {options.length > 0 && (
            <>
              <h3 className="mt-3 text-xs text-muted">{t('fromWatchlist')}</h3>
              <div className="mt-1 grid grid-cols-3 gap-2">
                {options.map((s) => (
                  <button key={s} type="button" className={cx(btn.ghost, 'px-2 font-mono')} onClick={() => pick(s)} aria-label={t('pick', { symbol: s })}>
                    {s}
                  </button>
                ))}
              </div>
            </>
          )}
          <form
            className="mt-4 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (customOk) pick(customSym);
            }}
          >
            <label htmlFor="compare-sym" className="sr-only">{t('otherSymbol')}</label>
            <input
              id="compare-sym"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder={t('otherPlaceholder')}
              autoComplete="off"
              className="h-11 min-w-0 flex-1 rounded-md border border-border bg-bg px-3 font-mono uppercase text-text placeholder:normal-case placeholder:text-muted focus:border-accent focus:outline-none"
            />
            <button type="submit" className={btn.primary} disabled={!customOk}>
              {t('add')}
            </button>
          </form>
        </>
      )}
    </Modal>
  );
}

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ['/'], label: 'search' },
  { keys: ['1', '…', '7'], label: 'ranges' },
  { keys: ['L'], label: 'levels' },
  { keys: ['P'], label: 'pivots' },
  { keys: ['C'], label: 'compare' },
  { keys: ['?'], label: 'help' },
  { keys: ['Esc'], label: 'close' },
];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations('shortcuts');
  return (
    <Modal open={open} onClose={onClose} title={t('title')}>
      <dl className="divide-y divide-border">
        {SHORTCUTS.map((s) => (
          <div key={s.label} className="flex items-center justify-between gap-4 py-2">
            <dt className="text-sm">{t(`items.${s.label}` as Parameters<typeof t>[0])}</dt>
            <dd className="flex gap-1">
              {s.keys.map((k, i) =>
                k === '…' ? (
                  <span key={i} className="text-muted">–</span>
                ) : (
                  <kbd key={i} className="min-w-7 rounded border border-border bg-panel-2 px-1.5 py-0.5 text-center font-mono text-xs">{k}</kbd>
                ),
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-muted">{t('note')}</p>
    </Modal>
  );
}

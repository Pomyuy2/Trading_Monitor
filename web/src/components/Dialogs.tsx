'use client';

import { isValidSymbol, normalizeSymbol, type Quote } from '@tm/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useWatchlist } from '@/lib/api';
import { XIcon } from './icons';
import { btn, cx } from './ui';

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

export function AlertDialog({ open, onClose, symbol, quote }: { open: boolean; onClose: () => void; symbol: string; quote: Quote | undefined }) {
  const t = useTranslations('alert');
  const tc = useTranslations('common');
  const [dir, setDir] = useState<'above' | 'below'>('above');
  const [price, setPrice] = useState('');
  useEffect(() => {
    if (open && quote?.price != null) setPrice(quote.price.toFixed(2));
  }, [open, quote?.price == null]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Modal open={open} onClose={onClose} title={t('title', { symbol })}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
        }}
        className="space-y-4"
      >
        <fieldset>
          <legend className="text-sm text-muted">{t('condition')}</legend>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {(['above', 'below'] as const).map((d) => (
              <button key={d} type="button" aria-pressed={dir === d} onClick={() => setDir(d)} className={cx(btn.ghost, dir === d && 'border-accent bg-accent/10')}>
                <span aria-hidden>{d === 'above' ? '▲' : '▼'}</span> {t(d)}
              </button>
            ))}
          </div>
        </fieldset>
        <div>
          <label htmlFor="alert-price" className="text-sm text-muted">
            {t('price')}
          </label>
          <input
            id="alert-price"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ''))}
            className="mt-1 h-11 w-full rounded-md border border-border bg-bg px-3 font-mono text-text focus:border-accent focus:outline-none"
          />
        </div>
        <p className="rounded-md border border-warn/40 bg-warn/5 p-3 text-xs text-warn" role="note">
          {t('phaseNote')}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className={btn.ghost} onClick={onClose}>
            {tc('cancel')}
          </button>
          <button type="submit" className={btn.primary} disabled>
            {t('save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function CompareDialog({ open, onClose, symbol, onPick }: { open: boolean; onClose: () => void; symbol: string; onPick: (s: string) => void }) {
  const t = useTranslations('compare');
  const { data } = useWatchlist();
  const [custom, setCustom] = useState('');
  const options = (data ?? []).map((i) => i.symbol).filter((s) => s !== symbol);
  const pick = (s: string) => {
    onPick(s);
    onClose();
    setCustom('');
  };
  const customSym = normalizeSymbol(custom);
  return (
    <Modal open={open} onClose={onClose} title={t('title', { symbol })}>
      <p className="text-xs text-muted">{t('hint')}</p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {options.map((s) => (
          <button key={s} type="button" className={cx(btn.ghost, 'px-2 font-mono')} onClick={() => pick(s)} aria-label={t('pick', { symbol: s })}>
            {s}
          </button>
        ))}
      </div>
      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (isValidSymbol(customSym) && customSym !== symbol) pick(customSym);
        }}
      >
        <label htmlFor="compare-sym" className="sr-only">Symbol</label>
        <input
          id="compare-sym"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="e.g. AMD"
          autoComplete="off"
          className="h-11 min-w-0 flex-1 rounded-md border border-border bg-bg px-3 font-mono uppercase text-text placeholder:normal-case placeholder:text-muted focus:border-accent focus:outline-none"
        />
        <button type="submit" className={btn.primary} disabled={!isValidSymbol(customSym) || customSym === symbol}>
          OK
        </button>
      </form>
    </Modal>
  );
}

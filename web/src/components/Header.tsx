'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { useSearch } from '@/lib/api';
import { loadPref, restoreCookie, savePref, setTheme, useTheme, type Theme } from '@/lib/prefs';
import { ListIcon, LogoIcon, MoonIcon, SearchIcon, SunIcon } from './icons';
import { btn, cx, useLang } from './ui';

export function Header({ onOpenWatchlist }: { onOpenWatchlist: () => void }) {
  const t = useTranslations();
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-bg/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-2 px-4 sm:gap-4">
        <button type="button" className={cx(btn.icon, 'lg:hidden')} onClick={onOpenWatchlist} aria-label={t('header.openWatchlist')}>
          <ListIcon />
        </button>
        <Link href="/" className="hidden min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-md font-semibold text-text min-[420px]:flex">
          <span className="grid size-8 place-items-center rounded-md bg-button text-white">
            <LogoIcon width={18} height={18} />
          </span>
          <span className="hidden sm:inline">{t('app.title')}</span>
        </Link>
        <div className="min-w-0 flex-1">
          <SearchBox />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ThemeToggle />
          <LanguageSwitch />
        </div>
      </div>
    </header>
  );
}

function ThemeToggle() {
  const t = useTranslations('header');
  const theme = useTheme();
  // If the theme cookie was cleared, restore it from localStorage.
  useEffect(() => {
    const saved = loadPref('theme') as Theme | null;
    if (saved && saved !== document.documentElement.dataset.theme) setTheme(saved);
  }, []);
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={t(next === 'light' ? 'lightTheme' : 'darkTheme')}
      title={t(next === 'light' ? 'lightTheme' : 'darkTheme')}
      className={btn.icon}
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function LanguageSwitch() {
  const t = useTranslations('header');
  const lang = useLang();
  const router = useRouter();
  const [pending, start] = useTransition();
  useEffect(() => {
    if (restoreCookie('lang')) start(() => router.refresh());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (l: 'en' | 'th') => {
    if (l === lang) return;
    savePref('lang', l); // NEXT_LOCALE cookie + localStorage
    start(() => router.refresh());
  };

  return (
    <div role="group" aria-label={t('language')} className={cx('flex shrink-0 rounded-md border border-border p-0.5', pending && 'opacity-60')}>
      {(['en', 'th'] as const).map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={lang === l}
          onClick={() => set(l)}
          className={cx(
            'min-h-11 min-w-11 rounded px-2 text-sm font-medium',
            lang === l ? 'bg-button text-white' : 'text-muted hover:text-text',
          )}
        >
          {l === 'en' ? 'EN' : 'TH'}
        </button>
      ))}
    </div>
  );
}

function SearchBox() {
  const t = useTranslations('header');
  const router = useRouter();
  const id = 'global-search'; // "/" shortcut focuses it
  const uid = useId();
  const listId = `${uid}-list`;
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = setTimeout(() => setDebounced(q), 200);
    return () => clearTimeout(h);
  }, [q]);

  const { data, isLoading } = useSearch(debounced);
  const results = debounced.trim() ? (data ?? []) : [];

  useEffect(() => setActive(0), [debounced]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const go = (symbol: string) => {
    setOpen(false);
    setQ('');
    router.push(`/stock/${encodeURIComponent(symbol)}`);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = results[active];
      if (pick) go(pick.symbol);
      else if (/^[A-Za-z0-9.\-]{1,15}$/.test(q.trim())) go(q.trim().toUpperCase());
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const showList = open && q.trim().length > 0;

  return (
    <div ref={wrap} className="relative mx-auto max-w-xl">
      <label htmlFor={id} className="sr-only">
        {t('searchLabel')}
      </label>
      <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
      <input
        id={id}
        type="search"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && results[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={t('searchPlaceholder')}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        aria-keyshortcuts="/"
        className="h-11 w-full rounded-md border border-border bg-panel pl-10 pr-10 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
      />
      <kbd aria-hidden className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border border-border px-1.5 font-mono text-xs text-muted sm:block">/</kbd>
      {showList && (
        <ul id={listId} role="listbox" aria-label={t('searchLabel')} className="absolute inset-x-0 top-12 z-40 max-h-80 overflow-auto rounded-md border border-border bg-panel py-1 shadow-2xl">
          {results.length === 0 && (
            <li className="px-3 py-3 text-sm text-muted" role="presentation">
              {isLoading || q !== debounced ? t('searching') : t('noResults')}
            </li>
          )}
          {results.map((r, i) => (
            <li
              key={r.symbol}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                go(r.symbol);
              }}
              className={cx('flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-sm', i === active && 'bg-panel-2')}
            >
              <span className="w-16 shrink-0 font-mono font-semibold text-text">{r.symbol}</span>
              <span className="min-w-0 flex-1 truncate text-muted">{r.name}</span>
              <span className="shrink-0 text-xs text-muted">{r.exchange}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

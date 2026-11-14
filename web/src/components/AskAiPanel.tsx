'use client';

import type { AskSource, ChatMessage } from '@tm/shared';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { askAi, useAskResolve, useQuotes, useSearch, useWatchlist } from '@/lib/api';
import { loadAskChat, requestAskReopen, saveAskChat } from '@/lib/ask-ai-store';
import { fmtSignedPct } from '@/lib/format';
import { ArrowRightIcon, ChevronLeftIcon, PlusIcon, SparkIcon, XIcon } from './icons';
import { btn, cx, useLang } from './ui';

/** Most stocks one question looks up in full detail (same limit as the server). */
const MAX_CHIPS = 3;

interface Props {
  open: boolean;
  onClose: () => void;
  /** The stock open on the page: a new chat starts with it. */
  pageSymbol: string;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const h = setTimeout(() => setV(value), ms);
    return () => clearTimeout(h);
  }, [value, ms]);
  return v;
}

const uniq = (xs: string[]) => [...new Set(xs)];

export function AskAiPanel({ open, onClose, pageSymbol }: Props) {
  const t = useTranslations('askAi');
  const lang = useLang();
  const router = useRouter();

  const saved = loadAskChat();
  const [messages, setMessages] = useState<ChatMessage[]>(saved.messages);
  const [chips, setChips] = useState<string[]>(saved.messages.length ? saved.chips : [pageSymbol]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeModel, setActiveModel] = useState<string>('combo1');
  const [adding, setAdding] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The chat outlives this page (moving to another stock keeps it).
  useEffect(() => saveAskChat(messages, chips), [messages, chips]);

  // Before the first question the chat simply follows the page's stock.
  useEffect(() => {
    if (messages.length === 0) setChips([pageSymbol]);
  }, [pageSymbol]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: chipQuotes } = useQuotes(open ? chips : []);
  const { data: watchlist } = useWatchlist();

  const debouncedInput = useDebounced(input, 450);
  const { data: preview } = useAskResolve(open ? debouncedInput : '', chips, pageSymbol);
  const previewFresh = !!preview && debouncedInput.trim() === input.trim() && input.trim() !== '';
  const [lookingUp, setLookingUp] = useState<string | null>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 150);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (adding) setAdding(false);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose, adding]);

  const handleSend = async (questionText: string) => {
    const q = questionText.trim();
    if (!q || loading) return;

    setError(null);
    setInput('');
    setAdding(false);
    const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: 'user', content: q, ts: Date.now() };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setLoading(true);
    const p = previewFresh && input.trim() === q ? preview : null;
    setLookingUp(p ? [...(p.watchlist ? [t('watchlistChip')] : []), ...p.symbols].join(', ') : null);

    try {
      const history = messages.map((m) => ({ role: m.role, content: m.content }));
      const res = await askAi({ question: q, lang, context: chips, pageSymbol, history });
      if (res.model) setActiveModel(res.model);
      const aiMsg: ChatMessage = {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: res.answer,
        sources: res.sources,
        symbols: res.symbols,
        watchlist: res.watchlist,
        truncated: res.truncated,
        ts: Date.now(),
      };
      setMessages([...nextMessages, aiMsg]);
      // Stocks the question named join the chat (newest first), so follow-ups can say "which one…".
      if (res.symbols.length) setChips((cur) => uniq([...res.symbols, ...cur]).slice(0, MAX_CHIPS));
    } catch {
      setError(t('error'));
    } finally {
      setLoading(false);
      setLookingUp(null);
    }
  };

  const handleReset = () => {
    setMessages([]);
    setChips([pageSymbol]);
    setError(null);
    setInput('');
    setAdding(false);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const addChip = (s: string) => {
    setChips((cur) => uniq([...cur, s]).slice(0, MAX_CHIPS));
    setAdding(false);
    setTimeout(() => inputRef.current?.focus(), 50);
  };
  const removeChip = (s: string) => setChips((cur) => cur.filter((x) => x !== s));

  const openChart = (s: string) => {
    // Wide screens keep the panel open on the next stock's page; phones show the chart.
    if (window.matchMedia('(min-width: 1024px)').matches) requestAskReopen();
    else onClose();
    router.push(`/stock/${encodeURIComponent(s)}`);
  };

  const other = watchlist?.map((w) => w.symbol).find((s) => s !== pageSymbol);
  const suggestions: string[] = [
    t('suggestions.levels', { symbol: pageSymbol }),
    ...(other ? [t('suggestions.compare', { a: pageSymbol, b: other })] : []),
    t('suggestions.watchlist'),
    t('suggestions.news', { symbol: pageSymbol }),
  ];

  if (!open) return null;

  const quoteOf = (s: string) => chipQuotes?.find((q) => q.symbol === s);
  const full = chips.length >= MAX_CHIPS;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('title')}
      className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-xs transition-opacity lg:bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="flex h-full w-full flex-col border-border bg-panel shadow-2xl animate-in slide-in-from-right duration-200 lg:max-w-[480px] lg:border-l">
        <header className="border-b border-border px-4 py-3 sm:px-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted hover:bg-panel-2 hover:text-text lg:hidden"
                onClick={onClose}
                aria-label={t('back')}
              >
                <ChevronLeftIcon width={22} height={22} />
              </button>
              <h2 className="flex items-center gap-2 text-base font-semibold text-text sm:text-lg">
                <SparkIcon className="text-accent" width={18} height={18} />
                {t('title')}
              </h2>
            </div>
            <div className="flex items-center gap-1">
              <button type="button" className={btn.icon} onClick={handleReset} title={t('newChat')} aria-label={t('newChat')}>
                <PlusIcon width={18} height={18} />
              </button>
              {/* Desktop only (phones have the back arrow); a wrapper, because btn.icon's display would win over `hidden`. */}
              <span className="hidden lg:contents">
                <button type="button" className={btn.icon} onClick={onClose} title={t('close')} aria-label={t('close')}>
                  <XIcon width={18} height={18} />
                </button>
              </span>
            </div>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted">{t('subtitle')}</p>
        </header>

        {/* Stocks in this chat */}
        <section aria-labelledby="ask-chips-label" className="space-y-2 border-b border-border px-4 py-2.5 sm:px-5">
          <div className="flex items-center justify-between">
            <h3 id="ask-chips-label" className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              {t('chipsLabel')}
            </h3>
            <span className="text-[11px] text-muted">{t('chipsCount', { count: chips.length, max: MAX_CHIPS })}</span>
          </div>
          <ul className="flex flex-wrap items-center gap-1.5">
            {chips.map((s) => {
              const q = quoteOf(s);
              const pct = q?.changePct;
              return (
                <li key={s} className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-panel-2 pl-2.5 text-xs">
                  <span className="font-mono font-semibold">{s}</span>
                  {pct != null && (
                    <span className={cx('font-mono', pct >= 0 ? 'text-up' : 'text-down')}>
                      {pct >= 0 ? '▲' : '▼'} {fmtSignedPct(pct, lang)}
                    </span>
                  )}
                  {s === pageSymbol && <span className="border-l border-border pl-1.5 text-[10px] text-muted">{t('thisPage')}</span>}
                  <button
                    type="button"
                    onClick={() => removeChip(s)}
                    aria-label={t('removeStock', { symbol: s })}
                    className="inline-flex size-8 items-center justify-center rounded-full text-muted hover:bg-panel hover:text-text"
                  >
                    <XIcon width={12} height={12} />
                  </button>
                </li>
              );
            })}
            {!full && (
              <li>
                <button
                  type="button"
                  onClick={() => setAdding((v) => !v)}
                  aria-expanded={adding}
                  className="inline-flex h-8 items-center gap-1 rounded-full border border-dashed border-border px-3 text-xs font-medium text-accent hover:border-accent"
                >
                  <PlusIcon width={12} height={12} />
                  {t('addStock')}
                </button>
              </li>
            )}
            {full && <li className="text-[11px] text-muted">{t('chipsFull', { max: MAX_CHIPS })}</li>}
          </ul>
          {adding && !full && <AddStock exclude={chips} onPick={addChip} />}
        </section>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <div className="rounded-full bg-accent/10 p-3 text-accent">
                <SparkIcon width={28} height={28} />
              </div>
              <p className="mt-3 text-sm font-medium text-text">{t('emptyTitle')}</p>
              <p className="mt-1 max-w-xs text-xs leading-relaxed text-muted">{t('emptyState')}</p>
            </div>
          ) : (
            messages.map((m) => (
              <div key={m.id} className={cx('flex flex-col', m.role === 'user' ? 'items-end' : 'items-start')}>
                {m.role === 'user' ? (
                  <div className="max-w-[85%] rounded-2xl rounded-tr-xs bg-button px-4 py-2.5 text-[14px] leading-relaxed text-white shadow-sm sm:text-[15px]">{m.content}</div>
                ) : (
                  <AnswerBlock m={m} pageSymbol={pageSymbol} onOpen={openChart} />
                )}
              </div>
            ))
          )}

          {loading && (
            <div className="flex items-center gap-2.5 rounded-xl border border-accent/20 bg-accent/5 p-4 text-sm text-accent" role="status">
              <SparkIcon className="animate-pulse" width={16} height={16} />
              <span>{lookingUp ? t('lookingUp', { symbols: lookingUp }) : t('thinking')}</span>
            </div>
          )}

          {error && <div className="rounded-xl border border-down/30 bg-down/10 p-3 text-xs text-down">{error}</div>}
        </div>

        {/* Suggestions */}
        <div className="border-t border-border/60 px-4 py-2.5 sm:px-5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">{t('tryAsking')}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                disabled={loading}
                onClick={() => handleSend(s)}
                className="inline-flex min-h-8 items-center rounded-full border border-border bg-panel-2/60 px-3 py-1 text-xs text-text transition-colors hover:border-accent/40 hover:bg-panel-2 hover:text-accent disabled:opacity-50"
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Input */}
        <footer className="border-t border-border bg-panel p-4 sm:p-5">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSend(input);
            }}
            className="space-y-2"
          >
            <label htmlFor="ask-ai-input" className="block text-xs font-medium text-muted">
              {t('inputLabel')}
            </label>
            <div className="flex items-center gap-2">
              <input
                id="ask-ai-input"
                ref={inputRef}
                type="text"
                autoComplete="off"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={t('placeholder')}
                disabled={loading}
                className="h-11 min-w-0 flex-1 rounded-lg border border-border bg-panel-2 px-3.5 text-sm text-text placeholder:text-muted/60 focus:border-accent focus:outline-none disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={!input.trim() || loading}
                aria-label={t('send')}
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg bg-button text-white transition-colors hover:bg-button-hover disabled:opacity-40 disabled:hover:bg-button"
              >
                <ArrowRightIcon width={18} height={18} />
              </button>
            </div>
            <div aria-live="polite" className="flex min-h-6 flex-wrap items-center gap-1.5 text-[11px] text-muted">
              {previewFresh && preview && (preview.symbols.length > 0 || preview.watchlist) ? (
                <>
                  <span>{preview.fromContext ? t('previewContext') : t('previewWill')}</span>
                  {preview.watchlist && <Tag>{t('watchlistChip')}</Tag>}
                  {preview.symbols.map((s) => (
                    <Tag key={s}>{s}</Tag>
                  ))}
                  {preview.truncated && <span>{t('previewTruncated', { max: MAX_CHIPS })}</span>}
                </>
              ) : previewFresh && preview ? (
                <span>{t('previewNone')}</span>
              ) : (
                <span>{t('modelNote', { model: activeModel })}</span>
              )}
            </div>
          </form>
        </footer>
      </aside>
    </div>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return <span className="rounded border border-border px-1.5 py-px font-mono text-[11px] text-text">{children}</span>;
}

function AnswerBlock({ m, pageSymbol, onOpen }: { m: ChatMessage; pageSymbol: string; onOpen: (s: string) => void }) {
  const t = useTranslations('askAi');
  const looked = [...(m.watchlist ? [t('watchlistChip')] : []), ...(m.symbols ?? [])];
  const opens = (m.symbols ?? []).filter((s) => s !== pageSymbol);
  return (
    <div className="w-full space-y-2">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
        <span className="flex items-center gap-1.5 font-semibold uppercase tracking-wider text-accent">
          <SparkIcon width={14} height={14} />
          {t('title')}
        </span>
        {looked.length > 0 && (
          <>
            <span>· {t('lookedUp')}</span>
            {looked.map((s) => (
              <Tag key={s}>{s}</Tag>
            ))}
          </>
        )}
      </div>

      <div className="rounded-xl border border-border/80 bg-panel-2/50 p-4">
        <MarkdownContent content={m.content} />
        {m.truncated && <p className="mt-3 text-xs text-warn">{t('truncated', { max: MAX_CHIPS })}</p>}

        {m.sources && m.sources.length > 0 && <Sources sources={m.sources} />}

        {opens.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {opens.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onOpen(s)}
                className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-border px-2.5 text-xs font-medium text-accent hover:border-accent"
              >
                {t('openChart', { symbol: s })}
                <ArrowRightIcon width={12} height={12} />
              </button>
            ))}
          </div>
        )}

        <p className="mt-2 text-[11px] italic text-muted/80">{t('disclaimer')}</p>
      </div>
    </div>
  );
}

/**
 * Source chips. Answers about several stocks get one line per stock ("TSLA  News · Price · Key levels …",
 * full labels on hover) instead of a chip for every source.
 */
function Sources({ sources }: { sources: AskSource[] }) {
  const chip = 'inline-flex items-center gap-1.5 rounded-md border border-border bg-panel px-2 py-0.5 text-[11px] font-medium text-muted';
  const perStock = new Map<string, AskSource[]>();
  const other: AskSource[] = [];
  for (const s of sources) {
    if (s.symbol) perStock.set(s.symbol, [...(perStock.get(s.symbol) ?? []), s]);
    else other.push(s);
  }
  const grouped = perStock.size > 1 || (perStock.size === 1 && other.length > 0);
  return (
    <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-3">
      {(grouped ? other : sources).map((src) => (
        <span key={src.id} className={chip}>
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          {src.label}
        </span>
      ))}
      {grouped &&
        [...perStock].map(([symbol, list]) => (
          <span key={symbol} className={chip} title={list.map((s) => s.label).join('\n')}>
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            <span className="font-mono font-semibold text-text">{symbol}</span>
            {/* "TSLA · News · 8 articles" → "News" */}
            {list.map((s) => s.label.split(' · ')[1] ?? s.label).join(' · ')}
          </span>
        ))}
    </div>
  );
}

/** Inline stock search for "+ Add stock". */
function AddStock({ exclude, onPick }: { exclude: string[]; onPick: (s: string) => void }) {
  const t = useTranslations('askAi');
  const id = useId();
  const [q, setQ] = useState('');
  const debounced = useDebounced(q, 200);
  const { data, isLoading } = useSearch(debounced);
  const results = debounced.trim() ? (data ?? []).filter((r) => !exclude.includes(r.symbol)).slice(0, 6) : [];
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);

  return (
    <div className="space-y-1 rounded-lg border border-border bg-panel-2 p-2">
      <label htmlFor={id} className="sr-only">
        {t('findStock')}
      </label>
      <input
        id={id}
        ref={ref}
        type="text"
        autoComplete="off"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && results[0]) {
            e.preventDefault();
            onPick(results[0].symbol);
          }
        }}
        placeholder={t('findPlaceholder')}
        className="h-10 w-full rounded-md border border-border bg-panel px-3 text-sm text-text placeholder:text-muted/60 focus:border-accent focus:outline-none"
      />
      {results.map((r) => (
        <button
          key={r.symbol}
          type="button"
          onClick={() => onPick(r.symbol)}
          className="flex min-h-10 w-full items-center gap-3 rounded-md px-2 text-left text-sm hover:bg-panel"
        >
          <span className="w-16 shrink-0 font-mono font-semibold">{r.symbol}</span>
          <span className="min-w-0 flex-1 truncate text-muted">{r.name}</span>
        </button>
      ))}
      {debounced.trim() && !isLoading && results.length === 0 && q === debounced && <p className="px-2 py-1 text-xs text-muted">{t('noMatch')}</p>}
    </div>
  );
}

/** Markdown rendering with bolding, lists, and formatting. */
function parseInline(str: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(str)) !== null) {
    if (match.index > lastIndex) {
      parts.push(str.substring(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      parts.push(
        <strong key={match.index} className="font-semibold text-text">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith('`') && token.endsWith('`')) {
      parts.push(
        <code key={match.index} className="rounded bg-panel px-1 py-0.5 font-mono text-xs text-accent">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('*') && token.endsWith('*')) {
      parts.push(<em key={match.index}>{token.slice(1, -1)}</em>);
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < str.length) {
    parts.push(str.substring(lastIndex));
  }
  return parts;
}

/** A markdown table row: "| a | b |". */
const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isTableRule = (l: string) => /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes('-');
const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

function MarkdownContent({ content }: { content: string }) {
  const blocks = content.split(/\n\n+/);
  return (
    <div className="space-y-3 text-[14px] leading-relaxed text-text/90">
      {blocks.map((block, i) => {
        const lines = block.split('\n').filter((l) => l.trim() !== '');
        // Comparison answers often come as a table.
        if (lines.length >= 2 && lines.every(isTableRow) && isTableRule(lines[1])) {
          const head = cells(lines[0]);
          const body = lines.slice(2).map(cells);
          return (
            <div key={i} className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-left text-[13px]">
                <thead className="bg-panel text-xs text-muted">
                  <tr>
                    {head.map((h, j) => (
                      <th key={j} scope="col" className="px-2.5 py-1.5 font-medium">
                        {parseInline(h)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {body.map((r, j) => (
                    <tr key={j} className="border-t border-border">
                      {r.map((c, k) => (
                        <td key={k} className="px-2.5 py-1.5 tabular-nums">
                          {parseInline(c)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        const isList = lines.length > 0 && lines.every((l) => /^\s*([•\-*]|\d+\.)\s+/.test(l));
        if (isList) {
          return (
            <ul key={i} className="space-y-1.5 pl-0.5">
              {lines.map((line, j) => (
                <li key={j} className={cx('flex items-start gap-2', /^\s{2,}/.test(line) && 'ml-5')}>
                  <span className={cx('mt-2 h-1.5 w-1.5 shrink-0 rounded-full', /^\s{2,}/.test(line) ? 'border border-accent' : 'bg-accent')} />
                  <span className="flex-1">{parseInline(line.replace(/^\s*([•\-*]|\d+\.)\s+/, ''))}</span>
                </li>
              ))}
            </ul>
          );
        }
        if (lines.length === 1 && /^\s*([-*_])\1{2,}\s*$/.test(lines[0])) return <hr key={i} className="border-border" />;
        const heading = lines.length === 1 && /^#{1,4}\s+/.test(lines[0]);
        if (heading) {
          return (
            <p key={i} className="font-semibold text-text">
              {parseInline(lines[0].replace(/^#{1,4}\s+/, ''))}
            </p>
          );
        }
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <span key={j}>
                {j > 0 && <br />}
                {parseInline(l)}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

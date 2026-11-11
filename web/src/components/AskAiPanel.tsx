'use client';

import type { AskSource, ChatMessage, Quote } from '@tm/shared';
import { useTranslations } from 'next-intl';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { askAi } from '@/lib/api';
import { fmtPrice, fmtSigned, fmtSignedPct } from '@/lib/format';
import { ArrowRightIcon, ChevronLeftIcon, PlusIcon, SparkIcon, XIcon } from './icons';
import { btn, cx, useLang } from './ui';

interface Props {
  open: boolean;
  onClose: () => void;
  symbol: string;
  quote?: Quote;
}

export function AskAiPanel({ open, onClose, symbol, quote }: Props) {
  const t = useTranslations('askAi');
  const tc = useTranslations('common');
  const lang = useLang();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeModel, setActiveModel] = useState<string>('combo1');

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom when messages update or loading changes
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [open]);

  // Handle ESC key to close
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const handleSend = async (questionText: string) => {
    const q = questionText.trim();
    if (!q || loading) return;

    setError(null);
    setInput('');

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: q,
      ts: Date.now(),
    };

    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setLoading(true);

    try {
      const history = messages.map((m) => ({ role: m.role, content: m.content }));
      const res = await askAi(symbol, q, lang, history);

      if (res.model) {
        setActiveModel(res.model);
      }

      const aiMsg: ChatMessage = {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: res.answer,
        sources: res.sources,
        ts: Date.now(),
      };
      setMessages([...nextMessages, aiMsg]);
    } catch {
      setError(t('error'));
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    setMessages([]);
    setError(null);
    setInput('');
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const suggestions: string[] = [
    t('suggestions.levels'),
    t('suggestions.guidance'),
    t('suggestions.earnings', { symbol }),
    t('suggestions.translate'),
  ];

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${t('title')} · ${symbol}`}
      className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-xs transition-opacity lg:bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside
        className={cx(
          'flex h-full w-full flex-col border-border bg-panel shadow-2xl animate-in slide-in-from-right duration-200',
          'lg:max-w-[460px] lg:border-l',
        )}
      >
        {/* Header - Desktop & Mobile responsive */}
        <header className="border-b border-border px-4 py-3 sm:px-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg text-muted hover:bg-panel-2 hover:text-text lg:hidden"
                onClick={onClose}
                aria-label={t('back')}
              >
                <ChevronLeftIcon width={22} height={22} />
              </button>
              <h2 className="flex items-center gap-2 font-semibold text-text text-base sm:text-lg">
                <SparkIcon className="text-accent" width={18} height={18} />
                <span>{t('title')}</span>
                <span className="text-muted font-normal">·</span>
                <span className="font-mono">{symbol}</span>
              </h2>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className={btn.icon}
                onClick={handleReset}
                title={t('newChat')}
                aria-label={t('newChat')}
              >
                <PlusIcon width={18} height={18} />
              </button>
              <button
                type="button"
                className={cx(btn.icon, 'hidden lg:inline-flex')}
                onClick={onClose}
                title={t('close')}
                aria-label={t('close')}
              >
                <XIcon width={18} height={18} />
              </button>
            </div>
          </div>

          {/* Subtitle: On mobile shows price/change if available, on desktop shows description */}
          {quote && quote.price != null ? (
            <div className="mt-1 flex flex-wrap items-baseline gap-2 text-xs lg:hidden">
              <span className="font-mono font-medium text-text">{fmtPrice(quote.price, lang, quote.currency)}</span>
              {quote.changePct != null && (
                <span className={quote.changePct >= 0 ? 'text-up' : 'text-down'}>
                  {quote.changePct >= 0 ? '▲' : '▼'} {fmtSigned(quote.change, lang, { currency: quote.currency })} ({fmtSignedPct(quote.changePct, lang)})
                </span>
              )}
            </div>
          ) : null}

          <p className="mt-1 text-xs text-muted leading-relaxed hidden lg:block">
            {t('subtitle', { symbol })}
          </p>
        </header>

        {/* Message history */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <div className="rounded-full bg-accent/10 p-3 text-accent">
                <SparkIcon width={28} height={28} />
              </div>
              <p className="mt-3 text-sm text-text font-medium">{t('title')} · {symbol}</p>
              <p className="mt-1 max-w-xs text-xs text-muted leading-relaxed">
                {t('emptyState', { symbol })}
              </p>
            </div>
          ) : (
            messages.map((m) => (
              <div key={m.id} className={cx('flex flex-col', m.role === 'user' ? 'items-end' : 'items-start')}>
                {m.role === 'user' ? (
                  <div className="max-w-[85%] rounded-2xl rounded-tr-xs bg-button px-4 py-2.5 text-white text-[14px] sm:text-[15px] leading-relaxed shadow-sm">
                    {m.content}
                  </div>
                ) : (
                  <div className="w-full space-y-3">
                    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-accent">
                      <SparkIcon width={14} height={14} />
                      <span>{t('title')}</span>
                    </div>

                    <div className="rounded-xl border border-border/80 bg-panel-2/50 p-4">
                      <MarkdownContent content={m.content} />

                      {m.sources && m.sources.length > 0 && (
                        <div className="mt-4 pt-3 border-t border-border/60">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {m.sources.map((src) => (
                              <span
                                key={src.id}
                                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-panel px-2 py-0.5 text-[11px] font-medium text-muted"
                              >
                                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                                {src.label}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      <p className="mt-2 text-[11px] text-muted/80 italic">
                        {t('disclaimer')}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}

          {loading && (
            <div className="flex items-center gap-2.5 rounded-xl border border-accent/20 bg-accent/5 p-4 text-sm text-accent" role="status">
              <SparkIcon className="animate-pulse" width={16} height={16} />
              <span>{t('thinking')}</span>
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-down/30 bg-down/10 p-3 text-xs text-down">
              {error}
            </div>
          )}
        </div>

        {/* Try asking suggestions */}
        <div className="border-t border-border/60 px-4 py-2.5 sm:px-5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            {t('tryAsking')}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {suggestions.map((suggestion, idx) => (
              <button
                key={idx}
                type="button"
                disabled={loading}
                onClick={() => handleSend(suggestion)}
                className="inline-flex items-center rounded-full border border-border bg-panel-2/60 px-3 py-1 text-xs text-text transition-colors hover:border-accent/40 hover:bg-panel-2 hover:text-accent disabled:opacity-50"
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>

        {/* Input box */}
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
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={t('placeholder', { symbol })}
                disabled={loading}
                className="flex-1 rounded-lg border border-border bg-panel-2 px-3.5 py-2.5 text-sm text-text placeholder:text-muted/60 focus:border-accent focus:outline-none disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={!input.trim() || loading}
                aria-label={t('send')}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-button text-white transition-colors hover:bg-button-hover disabled:opacity-40 disabled:hover:bg-button"
              >
                <ArrowRightIcon width={18} height={18} />
              </button>
            </div>
            <p className="text-[11px] text-muted/80 text-center sm:text-left">
              {t('modelNote', { model: activeModel })}
            </p>
          </form>
        </footer>
      </aside>
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

function MarkdownContent({ content }: { content: string }) {
  const blocks = content.split(/\n\n+/);
  return (
    <div className="space-y-3 text-[14px] leading-relaxed text-text/90">
      {blocks.map((block, i) => {
        const lines = block.split('\n');
        const isList = lines.length > 0 && lines.every((l) => /^\s*([•\-\*]|\d+\.)\s+/.test(l));
        if (isList) {
          return (
            <ul key={i} className="space-y-1.5 pl-0.5">
              {lines.map((line, j) => {
                const clean = line.replace(/^\s*([•\-\*]|\d+\.)\s+/, '');
                return (
                  <li key={j} className="flex items-start gap-2">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                    <span className="flex-1">{parseInline(clean)}</span>
                  </li>
                );
              })}
            </ul>
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

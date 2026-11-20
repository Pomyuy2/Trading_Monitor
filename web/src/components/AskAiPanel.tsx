'use client';

import type { AskSource, ChatMessage, Quote } from '@tm/shared';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { askAi, askAiStream } from '@/lib/api';
import { fmtPrice, fmtSigned, fmtSignedPct } from '@/lib/format';
import { ArrowRightIcon, ChevronLeftIcon, PlusIcon, SparkIcon, StopIcon, XIcon } from './icons';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ResearchReportCard } from './ResearchReportCard';
import { btn, cx, useLang } from './ui';

interface Props {
  open: boolean;
  onClose: () => void;
  symbol: string;
  quote?: Quote;
}

export function AskAiPanel({ open, onClose, symbol, quote }: Props) {
  const t = useTranslations('askAi');
  const lang = useLang();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeModel, setActiveModel] = useState<string>('combo1');

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isNearBottomRef = useRef<boolean>(true);

  // Track if user has scrolled away from bottom
  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    // User is near bottom if within 80px
    isNearBottomRef.current = scrollHeight - (scrollTop + clientHeight) < 80;
  };

  // Auto-scroll to bottom only if user was already near bottom
  useEffect(() => {
    if (isNearBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [open]);

  // Cleanup abort controller on unmount or dialog close
  useEffect(() => {
    if (!open && abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
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

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setLoading(false);
    setMessages((prev) =>
      prev.map((msg) =>
        msg.isStreaming
          ? {
              ...msg,
              isStreaming: false,
              streamingStatus: undefined,
              content: msg.content || t('stopped'),
            }
          : msg,
      ),
    );
  };

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

    const assistantMsgId = `a-${Date.now()}`;
    const initialAssistantMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      isStreaming: true,
      streamingStatus: t('thinking'),
      ts: Date.now(),
      toolSteps: [],
    };

    const historyForBackend = messages.map((m) => ({ role: m.role, content: m.content }));
    const nextMessages = [...messages, userMsg, initialAssistantMsg];
    setMessages(nextMessages);
    setLoading(true);
    isNearBottomRef.current = true;

    const controller = new AbortController();
    abortControllerRef.current = controller;

    let receivedAnyStreamEvent = false;

    try {
      await askAiStream(
        symbol,
        q,
        lang,
        historyForBackend,
        (event) => {
          receivedAnyStreamEvent = true;

          switch (event.type) {
            case 'agent_start': {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId
                    ? { ...m, streamingStatus: t('thinking') }
                    : m,
                ),
              );
              break;
            }

            case 'tool_start': {
              const toolName = event.data.tool;
              const isCalc =
                toolName.includes('valuation') ||
                toolName.includes('risk') ||
                toolName.includes('financial') ||
                toolName.includes('scenario');
              const statusText = isCalc ? t('calculating') : t('fetching');

              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId
                    ? { ...m, streamingStatus: `${statusText} (${toolName})` }
                    : m,
                ),
              );
              break;
            }

            case 'tool_result': {
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== assistantMsgId) return m;
                  const steps = m.toolSteps ? [...m.toolSteps] : [];
                  steps.push({
                    tool: event.data.tool,
                    args: {},
                    durationMs: event.data.durationMs,
                    success: event.data.success,
                    summary: event.data.summary,
                  });
                  return { ...m, toolSteps: steps };
                }),
              );
              break;
            }

            case 'text_delta': {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId
                    ? {
                        ...m,
                        content: m.content + event.data.delta,
                        streamingStatus: t('responding'),
                      }
                    : m,
                ),
              );
              break;
            }

            case 'report_ready': {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId
                    ? { ...m, report: event.data.report }
                    : m,
                ),
              );
              break;
            }

            case 'done': {
              if (event.data.model) setActiveModel(event.data.model);
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId
                    ? {
                        ...m,
                        isStreaming: false,
                        streamingStatus: undefined,
                        sources: event.data.sources ?? m.sources,
                        toolSteps: event.data.toolSteps ?? m.toolSteps,
                      }
                    : m,
                ),
              );
              setLoading(false);
              break;
            }

            case 'error': {
              setError(event.data.message || t('error'));
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId
                    ? {
                        ...m,
                        isStreaming: false,
                        streamingStatus: undefined,
                        content: m.content || t('error'),
                      }
                    : m,
                ),
              );
              setLoading(false);
              break;
            }
          }
        },
        controller.signal,
      );
    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError') {
        // Aborted by user
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? {
                  ...m,
                  isStreaming: false,
                  streamingStatus: undefined,
                  content: m.content || t('stopped'),
                }
              : m,
          ),
        );
        setLoading(false);
        return;
      }

      // If SSE failed before delivering any tokens, fall back to non-streaming askAi
      if (!receivedAnyStreamEvent) {
        try {
          const res = await askAi(symbol, q, lang, historyForBackend);
          if (res.model) setActiveModel(res.model);

          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? {
                    ...m,
                    content: res.answer,
                    sources: res.sources,
                    report: res.report,
                    toolSteps: res.toolSteps,
                    isStreaming: false,
                    streamingStatus: undefined,
                  }
                : m,
            ),
          );
        } catch {
          setError(t('error'));
          setMessages((prev) => prev.filter((m) => m.id !== assistantMsgId));
        }
      } else {
        setError(t('error'));
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? { ...m, isStreaming: false, streamingStatus: undefined }
              : m,
          ),
        );
      }
    } finally {
      abortControllerRef.current = null;
      setLoading(false);
    }
  };

  const handleReset = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setMessages([]);
    setError(null);
    setInput('');
    setLoading(false);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const suggestions: string[] = [
    t('suggestions.valuation'),
    t('suggestions.risk'),
    t('suggestions.ratios'),
    t('suggestions.levels'),
    t('suggestions.guidance'),
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
          'lg:max-w-[540px] xl:max-w-[620px] lg:border-l',
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
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4"
        >
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
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-accent">
                        <SparkIcon width={14} height={14} />
                        <span>{t('title')}</span>
                      </div>
                      {m.isStreaming && (
                        <div className="flex items-center gap-2">
                          <span className="flex items-center gap-1.5 text-xs text-accent font-medium">
                            <span className="relative flex h-2 w-2">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
                              <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
                            </span>
                            <span>{m.streamingStatus || t('thinking')}</span>
                          </span>
                          <button
                            type="button"
                            onClick={handleStop}
                            className="inline-flex items-center gap-1 rounded-md border border-border bg-panel px-2 py-0.5 text-xs text-muted hover:border-accent hover:text-accent transition-colors"
                            aria-label={t('stop')}
                          >
                            <StopIcon width={11} height={11} />
                            <span>{t('stop')}</span>
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="rounded-xl border border-border/80 bg-panel-2/50 p-4">
                      {/* Tool Steps if any */}
                      {m.toolSteps && m.toolSteps.length > 0 && (
                        <div className="mb-3 rounded-lg border border-border bg-panel/70 p-2.5 text-xs">
                          <p className="font-mono text-[11px] text-muted flex items-center gap-1.5">
                            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                            <span>{m.toolSteps.length} tools executed:</span>
                          </p>
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {m.toolSteps.map((s, idx) => (
                              <span
                                key={idx}
                                className={cx(
                                  'rounded px-1.5 py-0.5 text-[10px] font-mono',
                                  s.success ? 'bg-panel-2 text-muted' : 'bg-down/10 text-down',
                                )}
                              >
                                {s.tool} ({s.durationMs}ms)
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Content or streaming placeholder */}
                      {m.content ? (
                        <MarkdownRenderer content={m.content} isStreaming={m.isStreaming} />
                      ) : m.isStreaming ? (
                        <div className="space-y-2 py-1 animate-pulse" role="status">
                          <div className="h-3.5 bg-panel-2 rounded w-4/5" />
                          <div className="h-3.5 bg-panel-2 rounded w-3/5" />
                          <div className="h-3.5 bg-panel-2 rounded w-2/5" />
                        </div>
                      ) : null}

                      {/* Research Report Card if ready */}
                      {m.report && (
                        <div className="mt-4">
                          <ResearchReportCard report={m.report} toolSteps={m.toolSteps} />
                        </div>
                      )}

                      {/* Sources */}
                      {m.sources && m.sources.length > 0 && (
                        <div className="mt-4 pt-3 border-t border-border/60">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {m.sources.map((src: AskSource) => (
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

                      <p className="mt-3 text-[11px] text-muted/80 italic">
                        {t('disclaimer')}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            ))
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
              {loading ? (
                <button
                  type="button"
                  onClick={handleStop}
                  aria-label={t('stop')}
                  title={t('stop')}
                  className="inline-flex h-10 px-3 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border bg-panel-2 text-text transition-colors hover:border-accent hover:text-accent"
                >
                  <StopIcon width={14} height={14} />
                  <span className="text-xs font-medium">{t('stop')}</span>
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim()}
                  aria-label={t('send')}
                  className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-button text-white transition-colors hover:bg-button-hover disabled:opacity-40 disabled:hover:bg-button"
                >
                  <ArrowRightIcon width={18} height={18} />
                </button>
              )}
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

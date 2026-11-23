'use client';

import type { AskSource, ChatContextMode, ChatMessage, ConversationSummary, PortfolioSummary, Quote } from '@tm/shared';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { askAi, askAiStream, createConversation, deleteConversation, fetchConversation, fetchConversations, fetchPortfolios } from '@/lib/api';
import { fmtPrice } from '@/lib/format';
import { ArrowRightIcon, ChevronLeftIcon, HistoryIcon, PlusIcon, SparkIcon, StopIcon, TrashIcon, XIcon } from './icons';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ResearchReportCard } from './ResearchReportCard';
import { btn, cx, useLang } from './ui';

interface Props {
  open: boolean;
  onClose: () => void;
  initialMode?: ChatContextMode;
  symbol?: string;
  quote?: Quote;
  pageSymbol?: string;
}

export function AskAiPanel({ open, onClose, initialMode = 'global', symbol, quote, pageSymbol }: Props) {
  const t = useTranslations('askAi');
  const lang = useLang();
  const effectiveSymbol = symbol || pageSymbol || '';

  // Context mode: 'global' | 'stock' | 'portfolio'
  const [contextMode, setContextMode] = useState<ChatContextMode>(initialMode || (effectiveSymbol ? 'stock' : 'global'));
  const [activeSymbol, setActiveSymbol] = useState<string>(effectiveSymbol);
  const [selectedPortfolioId, setSelectedPortfolioId] = useState<string>('');
  const [portfolios, setPortfolios] = useState<PortfolioSummary[]>([]);

  // Conversation history state
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [currentConversationId, setCurrentConversationId] = useState<string | undefined>(undefined);
  const [showHistory, setShowHistory] = useState<boolean>(false);

  // Chat message state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeModel, setActiveModel] = useState<string>('combo1');
  const [agentVersion, setAgentVersion] = useState<'v1' | 'v2'>('v1');

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isNearBottomRef = useRef<boolean>(true);

  // Synchronize initial mode & symbol when panel is opened
  useEffect(() => {
    if (open) {
      if (initialMode) {
        setContextMode(initialMode);
      } else if (effectiveSymbol) {
        setContextMode('stock');
      }
      if (effectiveSymbol) {
        setActiveSymbol(effectiveSymbol);
      }
    }
  }, [open, initialMode, effectiveSymbol]);

  // Load conversations list and portfolios when opened
  const loadConversations = useCallback(async () => {
    try {
      const list = await fetchConversations();
      setConversations(list);
    } catch {
      // ignore in offline/demo mode
    }
  }, []);

  useEffect(() => {
    if (open) {
      loadConversations();
      fetchPortfolios().then(setPortfolios).catch(() => {});
    }
  }, [open, loadConversations]);

  // Track if user has scrolled away from bottom
  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
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
        if (showHistory) {
          setShowHistory(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, showHistory, onClose]);

  const handleStop = useCallback(() => {
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
  }, [t]);

  // Switch context mode safely aborting any active generation
  const handleSwitchMode = (newMode: ChatContextMode) => {
    if (loading) handleStop();
    setContextMode(newMode);
    setError(null);
  };

  // Start a new chat
  const handleNewChat = () => {
    if (loading) handleStop();
    setCurrentConversationId(undefined);
    setMessages([]);
    setError(null);
    setInput('');
    setShowHistory(false);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  // Switch to an existing conversation from history
  const handleSelectConversation = async (convId: string) => {
    if (loading) handleStop();
    try {
      const detail = await fetchConversation(convId);
      setCurrentConversationId(detail.id);
      setContextMode(detail.contextMode);
      if (detail.contextMode === 'stock' && detail.contextRef) {
        setActiveSymbol(detail.contextRef);
      } else if (detail.contextMode === 'portfolio' && detail.contextRef) {
        setSelectedPortfolioId(detail.contextRef);
      }
      setMessages(detail.messages || []);
      setError(null);
      setShowHistory(false);
    } catch {
      setError(t('error'));
    }
  };

  // Delete a conversation
  const handleDeleteConversation = async (e: React.MouseEvent, convId: string) => {
    e.stopPropagation();
    if (!confirm(t('deleteConfirm'))) return;

    try {
      await deleteConversation(convId);
      setConversations((prev) => prev.filter((c) => c.id !== convId));
      if (currentConversationId === convId) {
        handleNewChat();
      }
    } catch {
      setError(t('error'));
    }
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

    // Resolve context values
    const querySymbol = contextMode === 'stock' ? activeSymbol || undefined : undefined;
    const contextRef =
      contextMode === 'stock'
        ? activeSymbol || undefined
        : contextMode === 'portfolio'
        ? selectedPortfolioId || undefined
        : undefined;

    // Create conversation upfront if this is the start of a new chat
    let activeConvId = currentConversationId;
    if (!activeConvId) {
      try {
        const created = await createConversation({
          title: q.slice(0, 40),
          contextMode,
          contextRef,
          messages: [userMsg],
        });
        activeConvId = created.id;
        setCurrentConversationId(created.id);
        loadConversations();
      } catch {
        // Continue even if local persistence fails
      }
    }

    try {
      await askAiStream(
        querySymbol,
        q,
        lang,
        historyForBackend,
        (event) => {
          receivedAnyStreamEvent = true;

          switch (event.type) {
            case 'agent_start': {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId ? { ...m, streamingStatus: t('thinking') } : m,
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
                prev.map((m) => (m.id === assistantMsgId ? { ...m, report: event.data.report } : m)),
              );
              break;
            }

            case 'done': {
              if (event.data.model) setActiveModel(event.data.model);
              if (event.data.conversationId && !currentConversationId) {
                setCurrentConversationId(event.data.conversationId);
              }
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId
                    ? {
                        ...m,
                        isStreaming: false,
                        streamingStatus: undefined,
                        sources: event.data.sources ?? m.sources,
                        toolSteps: event.data.toolSteps ?? m.toolSteps,
                        agentVersion: event.data.agentVersion ?? agentVersion,
                      }
                    : m,
                ),
              );
              setLoading(false);
              loadConversations();
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
        {
          contextMode,
          contextRef,
          conversationId: activeConvId,
          agentVersion,
        },
      );
    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError') {
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
          const res = await askAi(querySymbol, q, lang, historyForBackend, {
            contextMode,
            contextRef,
            conversationId: activeConvId,
            agentVersion,
          });
          if (res.model) setActiveModel(res.model);
          if (res.conversationId && !currentConversationId) {
            setCurrentConversationId(res.conversationId);
          }

          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? {
                    ...m,
                    content: res.answer,
                    sources: res.sources,
                    report: res.report,
                    toolSteps: res.toolSteps,
                    agentVersion: res.agentVersion ?? agentVersion,
                    isStreaming: false,
                    streamingStatus: undefined,
                  }
                : m,
            ),
          );
          loadConversations();
        } catch {
          setError(t('error'));
          setMessages((prev) => prev.filter((m) => m.id !== assistantMsgId));
        }
      } else {
        setError(t('error'));
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId ? { ...m, isStreaming: false, streamingStatus: undefined } : m,
          ),
        );
      }
    } finally {
      abortControllerRef.current = null;
      setLoading(false);
    }
  };

  const suggestions: string[] =
    contextMode === 'global'
      ? [
          t('suggestionsGlobal.compare'),
          t('suggestionsGlobal.valuation'),
          t('suggestionsGlobal.portfolio'),
          t('suggestionsGlobal.macro'),
        ]
      : contextMode === 'portfolio'
      ? [
          t('suggestionsGlobal.portfolio'),
          'Check portfolio asset weights and concentration HHI',
          'Simulate rebalancing actions',
        ]
      : [
          t('suggestions.valuation'),
          t('suggestions.risk'),
          t('suggestions.ratios'),
          t('suggestions.levels', { symbol: activeSymbol || 'this stock' }),
          t('suggestions.guidance'),
        ];

  if (!open) return null;

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
      <aside
        className={cx(
          'flex h-full w-full flex-col border-border bg-panel shadow-2xl animate-in slide-in-from-right duration-200',
          'lg:max-w-[560px] xl:max-w-[640px] lg:border-l',
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
                <span className="text-xs uppercase font-medium tracking-wider px-2 py-0.5 rounded-full bg-accent/10 text-accent">
                  {contextMode === 'stock'
                    ? activeSymbol || 'Stock'
                    : contextMode === 'portfolio'
                    ? t('portfolioMode')
                    : t('globalMode')}
                </span>
              </h2>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className={cx(btn.icon, showHistory && 'bg-panel-2 text-accent')}
                onClick={() => setShowHistory(!showHistory)}
                title={t('conversations')}
                aria-label={t('conversations')}
              >
                <HistoryIcon width={18} height={18} />
              </button>
              <button
                type="button"
                className={btn.icon}
                onClick={handleNewChat}
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

          {/* Context Selector Pill Bar & Engine Toggle */}
          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-2 text-xs">
            <div className="flex items-center gap-1">
              <span className="text-muted mr-1 font-medium">{t('context')}:</span>
              {(['global', 'stock', 'portfolio'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => handleSwitchMode(mode)}
                  className={cx(
                    'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                    contextMode === mode
                      ? 'bg-button text-white'
                      : 'bg-panel-2 text-muted hover:text-text hover:bg-panel-2/80',
                  )}
                >
                  {mode === 'global' ? t('globalMode') : mode === 'stock' ? t('stockMode') : t('portfolioMode')}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2">
              {/* Context Sub-controls: Stock symbol input or Portfolio select */}
              {contextMode === 'stock' && (
                <div className="flex items-center gap-1.5 font-mono">
                  <input
                    type="text"
                    value={activeSymbol}
                    onChange={(e) => setActiveSymbol(e.target.value.toUpperCase())}
                    placeholder="SYMBOL"
                    className="w-20 rounded border border-border bg-panel-2 px-1.5 py-0.5 text-xs text-text text-center font-bold focus:border-accent focus:outline-none"
                  />
                  {quote && quote.price != null && activeSymbol === symbol && (
                    <span className="text-muted hidden sm:inline">
                      {fmtPrice(quote.price, lang, quote.currency)}
                    </span>
                  )}
                </div>
              )}

              {contextMode === 'portfolio' && portfolios.length > 0 && (
                <select
                  value={selectedPortfolioId}
                  onChange={(e) => setSelectedPortfolioId(e.target.value)}
                  className="rounded border border-border bg-panel-2 px-2 py-0.5 text-xs text-text focus:border-accent focus:outline-none max-w-[140px] truncate"
                >
                  <option value="">{t('allPortfolios')}</option>
                  {portfolios.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}

              {/* Research Engine Toggle: V1 Standard vs V2 Beta */}
              <div
                className="flex items-center rounded-lg border border-border/60 bg-panel-2/60 p-0.5"
                title={t('versionTooltip')}
              >
                <button
                  type="button"
                  onClick={() => setAgentVersion('v1')}
                  className={cx(
                    'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                    agentVersion === 'v1'
                      ? 'bg-button text-white shadow-xs'
                      : 'text-muted hover:text-text',
                  )}
                >
                  {t('versionV1')}
                </button>
                <button
                  type="button"
                  onClick={() => setAgentVersion('v2')}
                  className={cx(
                    'rounded px-2 py-0.5 text-[11px] font-medium transition-colors flex items-center gap-1',
                    agentVersion === 'v2'
                      ? 'bg-accent text-white shadow-xs'
                      : 'text-muted hover:text-text',
                  )}
                >
                  <span>{t('versionV2')}</span>
                  <span
                    className={cx(
                      'text-[9px] uppercase px-1 py-0.2 rounded font-bold',
                      agentVersion === 'v2' ? 'bg-black/20 text-white' : 'bg-accent/15 text-accent',
                    )}
                  >
                    {t('versionV2Badge')}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </header>

        {/* Conversation History Drawer (toggled via HistoryIcon) */}
        {showHistory ? (
          <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-panel-2/40 animate-in fade-in duration-150">
            <div className="flex items-center justify-between pb-2 border-b border-border/60">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted">
                {t('conversations')} ({conversations.length})
              </span>
              <button
                type="button"
                onClick={handleNewChat}
                className="text-xs text-accent font-medium hover:underline flex items-center gap-1"
              >
                <PlusIcon width={14} height={14} />
                <span>{t('newChat')}</span>
              </button>
            </div>

            {conversations.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted">{t('noChats')}</p>
            ) : (
              conversations.map((c) => (
                <div
                  key={c.id}
                  onClick={() => handleSelectConversation(c.id)}
                  className={cx(
                    'group flex cursor-pointer items-center justify-between rounded-xl border p-3 text-left transition-colors',
                    c.id === currentConversationId
                      ? 'border-accent bg-accent/10 text-text'
                      : 'border-border bg-panel hover:border-accent/40 hover:bg-panel-2',
                  )}
                >
                  <div className="min-w-0 flex-1 pr-2">
                    <p className="truncate text-sm font-medium text-text">{c.title}</p>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-muted">
                      <span className="uppercase font-mono px-1 rounded bg-panel-2 text-[10px]">
                        {c.contextMode}
                        {c.contextRef ? `: ${c.contextRef}` : ''}
                      </span>
                      <span>·</span>
                      <span>{c.messageCount} msgs</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => handleDeleteConversation(e, c.id)}
                    className="opacity-0 group-hover:opacity-100 p-1.5 text-muted hover:text-down rounded transition-opacity"
                    title={t('deleteChat')}
                    aria-label={t('deleteChat')}
                  >
                    <TrashIcon width={16} height={16} />
                  </button>
                </div>
              ))
            )}
          </div>
        ) : (
          /* Message list */
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
                <p className="mt-3 text-sm text-text font-medium">
                  {contextMode === 'stock'
                    ? `${t('title')} · ${activeSymbol || 'Stock'}`
                    : contextMode === 'portfolio'
                    ? `${t('title')} · ${t('portfolioMode')}`
                    : `${t('title')} · ${t('globalMode')}`}
                </p>
                <p className="mt-1 max-w-sm text-xs text-muted leading-relaxed">
                  {contextMode === 'stock'
                    ? t('emptyState', { symbol: activeSymbol || 'Stock' })
                    : t('globalEmptyState')}
                </p>
              </div>
            ) : (
              messages.map((m) => (
                <div
                  key={m.id}
                  className={cx('flex flex-col', m.role === 'user' ? 'items-end' : 'items-start')}
                >
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
                          {m.agentVersion === 'v2' && (
                            <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-bold text-accent tracking-normal normal-case">
                              V2 Beta (SEC RAG)
                            </span>
                          )}
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
        )}

        {/* Try asking suggestions */}
        {!showHistory && (
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
        )}

        {/* Input box */}
        <footer className="border-t border-border bg-panel p-4 sm:p-5">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSend(input);
            }}
            className="space-y-2"
          >
            <label htmlFor="ask-ai-input" className="sr-only">
              {t('inputLabel')}
            </label>
            <div className="flex items-center gap-2">
              <input
                id="ask-ai-input"
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={
                  contextMode === 'stock'
                    ? t('placeholder', { symbol: activeSymbol || 'Stock' })
                    : t('placeholderGlobal')
                }
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

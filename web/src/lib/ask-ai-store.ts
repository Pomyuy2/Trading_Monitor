'use client';

import type { ChatMessage } from '@tm/shared';

/**
 * The Ask AI chat lives outside the page so it survives moving to another stock (each stock page
 * mounts a new Dashboard). Kept in memory only: a reload starts a new chat.
 */
interface AskAiChat {
  messages: ChatMessage[];
  /** "Stocks in this chat" (the chips). */
  chips: string[];
  /** Re-open the panel on the next stock page (set by "Open … chart" on wide screens). */
  reopen: boolean;
}

const chat: AskAiChat = { messages: [], chips: [], reopen: false };

export function loadAskChat(): Pick<AskAiChat, 'messages' | 'chips'> {
  return { messages: chat.messages, chips: chat.chips };
}

export function saveAskChat(messages: ChatMessage[], chips: string[]) {
  chat.messages = messages;
  chat.chips = chips;
}

export function requestAskReopen() {
  chat.reopen = true;
}

/** true once after requestAskReopen(). */
export function takeAskReopen(): boolean {
  const r = chat.reopen;
  chat.reopen = false;
  return r;
}

import type { PrismaClient } from '@prisma/client';
import type { ChatContextMode, ChatMessage, ConversationDetail, ConversationSummary } from '@tm/shared';

export class ConversationService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * List all conversations for the authenticated user, ordered by most recently updated.
   */
  async listConversations(userId: string): Promise<ConversationSummary[]> {
    const list = await this.prisma.conversation.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });

    return list.map((c) => {
      let msgs: ChatMessage[] = [];
      try {
        msgs = JSON.parse(c.messages);
      } catch {
        msgs = [];
      }
      const last = msgs[msgs.length - 1];
      return {
        id: c.id,
        userId: c.userId,
        title: c.title,
        contextMode: c.contextMode as ChatContextMode,
        contextRef: c.contextRef,
        messageCount: msgs.length,
        lastMessagePreview: last ? (last.content.length > 60 ? last.content.slice(0, 57) + '...' : last.content) : undefined,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      };
    });
  }

  /**
   * Retrieve a specific conversation by ID with server-side ownership validation.
   */
  async getConversation(userId: string, id: string): Promise<ConversationDetail | null> {
    const c = await this.prisma.conversation.findFirst({
      where: { id, userId },
    });
    if (!c) return null;

    let msgs: ChatMessage[] = [];
    try {
      msgs = JSON.parse(c.messages);
    } catch {
      msgs = [];
    }

    return {
      id: c.id,
      userId: c.userId,
      title: c.title,
      contextMode: c.contextMode as ChatContextMode,
      contextRef: c.contextRef,
      messages: msgs,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  }

  /**
   * Create a new conversation for the authenticated user.
   */
  async createConversation(
    userId: string,
    params: {
      title?: string;
      contextMode?: ChatContextMode;
      contextRef?: string | null;
      messages?: ChatMessage[];
    },
  ): Promise<ConversationDetail> {
    const msgs = params.messages || [];
    const title = params.title || this.generateTitle(msgs[0]?.content) || 'New Chat';
    const c = await this.prisma.conversation.create({
      data: {
        userId,
        title,
        contextMode: params.contextMode || 'global',
        contextRef: params.contextRef || null,
        messages: JSON.stringify(msgs),
      },
    });

    return {
      id: c.id,
      userId: c.userId,
      title: c.title,
      contextMode: c.contextMode as ChatContextMode,
      contextRef: c.contextRef,
      messages: msgs,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  }

  /**
   * Update an existing conversation (title, context, messages). Enforces user ownership.
   */
  async updateConversation(
    userId: string,
    id: string,
    data: {
      title?: string;
      contextMode?: ChatContextMode;
      contextRef?: string | null;
      messages?: ChatMessage[];
    },
  ): Promise<ConversationDetail | null> {
    const existing = await this.prisma.conversation.findFirst({
      where: { id, userId },
    });
    if (!existing) return null;

    const updateData: {
      title?: string;
      contextMode?: string;
      contextRef?: string | null;
      messages?: string;
    } = {};

    if (data.title !== undefined) updateData.title = data.title;
    if (data.contextMode !== undefined) updateData.contextMode = data.contextMode;
    if (data.contextRef !== undefined) updateData.contextRef = data.contextRef;
    if (data.messages !== undefined) {
      updateData.messages = JSON.stringify(data.messages);
      // Auto-update title from first message if title was default "New Chat"
      if ((existing.title === 'New Chat' || !existing.title) && data.messages.length > 0 && !data.title) {
        updateData.title = this.generateTitle(data.messages[0].content);
      }
    }

    const updated = await this.prisma.conversation.update({
      where: { id },
      data: updateData,
    });

    let msgs: ChatMessage[] = [];
    try {
      msgs = JSON.parse(updated.messages);
    } catch {
      msgs = [];
    }

    return {
      id: updated.id,
      userId: updated.userId,
      title: updated.title,
      contextMode: updated.contextMode as ChatContextMode,
      contextRef: updated.contextRef,
      messages: msgs,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  /**
   * Append one or more messages to an existing conversation, or create it if id is not found.
   */
  async appendMessages(
    userId: string,
    id: string | undefined,
    newMessages: ChatMessage[],
    contextMode: ChatContextMode = 'global',
    contextRef?: string | null,
  ): Promise<ConversationDetail> {
    if (id) {
      const existing = await this.getConversation(userId, id);
      if (existing) {
        const merged = [...existing.messages, ...newMessages];
        const updated = await this.updateConversation(userId, id, {
          messages: merged,
          contextMode,
          contextRef: contextRef !== undefined ? contextRef : existing.contextRef,
        });
        if (updated) return updated;
      }
    }

    return this.createConversation(userId, {
      contextMode,
      contextRef,
      messages: newMessages,
    });
  }

  /**
   * Delete a conversation owned by the authenticated user.
   */
  async deleteConversation(userId: string, id: string): Promise<boolean> {
    const existing = await this.prisma.conversation.findFirst({
      where: { id, userId },
    });
    if (!existing) return false;

    await this.prisma.conversation.delete({
      where: { id },
    });
    return true;
  }

  /**
   * Generate a clean, concise title from the user's initial prompt.
   */
  generateTitle(firstMessage?: string): string {
    if (!firstMessage) return 'New Chat';
    // Remove context tag prefixes like [Context Target Stock: NVDA] or [Context: Portfolio Primary]
    const clean = firstMessage.replace(/\[Context[^\]]*\]/g, '').trim();
    if (!clean) return 'New Chat';
    if (clean.length <= 40) return clean;
    return clean.slice(0, 38).trim() + '…';
  }
}

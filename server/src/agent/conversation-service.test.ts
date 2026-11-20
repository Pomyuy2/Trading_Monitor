import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationService } from './conversation-service.js';

describe('ConversationService (SQLite Persistence & User Isolation)', () => {
  let prisma: PrismaClient;
  let service: ConversationService;
  let tempDir: string;
  let dbUrl: string;

  beforeAll(async () => {
    tempDir = join(tmpdir(), `conv-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    const dbPath = join(tempDir, 'test.db');
    dbUrl = `file:${dbPath}`;

    prisma = new PrismaClient({
      datasources: { db: { url: dbUrl } },
    });

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "User" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "email" TEXT NOT NULL,
        "emailHash" TEXT,
        "name" TEXT,
        "passwordHash" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Conversation" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "userId" TEXT NOT NULL DEFAULT 'default-user',
        "title" TEXT NOT NULL,
        "contextMode" TEXT NOT NULL DEFAULT 'global',
        "contextRef" TEXT,
        "messages" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create 2 test users
    await prisma.user.createMany({
      data: [
        { id: 'user-alice', email: 'alice@example.com', passwordHash: 'hash-alice' },
        { id: 'user-bob', email: 'bob@example.com', passwordHash: 'hash-bob' },
      ],
    });

    service = new ConversationService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('creates and lists conversations scoped by user', async () => {
    const conv1 = await service.createConversation('user-alice', {
      title: 'NVDA Research',
      contextMode: 'stock',
      contextRef: 'NVDA',
      messages: [
        { id: 'm1', role: 'user', content: 'What is NVDA valuation?', ts: Date.now() },
        { id: 'm2', role: 'assistant', content: 'NVDA base fair value is $195.00', ts: Date.now() },
      ],
    });

    expect(conv1.id).toBeDefined();
    expect(conv1.userId).toBe('user-alice');
    expect(conv1.title).toBe('NVDA Research');
    expect(conv1.contextMode).toBe('stock');
    expect(conv1.contextRef).toBe('NVDA');
    expect(conv1.messages.length).toBe(2);

    // List Alice's conversations
    const aliceList = await service.listConversations('user-alice');
    expect(aliceList.length).toBe(1);
    expect(aliceList[0].id).toBe(conv1.id);
    expect(aliceList[0].messageCount).toBe(2);
    expect(aliceList[0].lastMessagePreview).toContain('NVDA base fair value');

    // Bob cannot see Alice's conversation
    const bobList = await service.listConversations('user-bob');
    expect(bobList.length).toBe(0);
  });

  it('enforces server-side authorization on getConversation', async () => {
    const conv = await service.createConversation('user-alice', {
      title: 'Global Macro Chat',
      contextMode: 'global',
      messages: [{ id: 'm1', role: 'user', content: 'What is the yield curve doing?', ts: Date.now() }],
    });

    // Alice can fetch it
    const aliceFetch = await service.getConversation('user-alice', conv.id);
    expect(aliceFetch).not.toBeNull();
    expect(aliceFetch?.title).toBe('Global Macro Chat');

    // Bob cannot fetch it (returns null -> 404 in API)
    const bobFetch = await service.getConversation('user-bob', conv.id);
    expect(bobFetch).toBeNull();
  });

  it('enforces server-side authorization on updateConversation', async () => {
    const conv = await service.createConversation('user-alice', {
      title: 'Initial Title',
      contextMode: 'global',
    });

    // Bob attempts to update Alice's conversation -> rejected
    const bobUpdate = await service.updateConversation('user-bob', conv.id, {
      title: 'Hacked Title',
    });
    expect(bobUpdate).toBeNull();

    // Alice can update it
    const aliceUpdate = await service.updateConversation('user-alice', conv.id, {
      title: 'Updated Title',
      contextMode: 'portfolio',
      contextRef: 'port-123',
    });
    expect(aliceUpdate?.title).toBe('Updated Title');
    expect(aliceUpdate?.contextMode).toBe('portfolio');
    expect(aliceUpdate?.contextRef).toBe('port-123');
  });

  it('enforces server-side authorization on deleteConversation', async () => {
    const conv = await service.createConversation('user-alice', {
      title: 'To Be Deleted',
    });

    // Bob attempts to delete Alice's conversation -> rejected
    const bobDelete = await service.deleteConversation('user-bob', conv.id);
    expect(bobDelete).toBe(false);

    // Conversation is still present
    const checkStillExists = await service.getConversation('user-alice', conv.id);
    expect(checkStillExists).not.toBeNull();

    // Alice deletes it -> success
    const aliceDelete = await service.deleteConversation('user-alice', conv.id);
    expect(aliceDelete).toBe(true);

    // Now it is gone
    const checkDeleted = await service.getConversation('user-alice', conv.id);
    expect(checkDeleted).toBeNull();
  });

  it('auto-generates concise conversation titles from first message', () => {
    expect(service.generateTitle('How does DCF work?')).toBe('How does DCF work?');
    expect(
      service.generateTitle('Please provide a comprehensive valuation analysis for Nvidia with Bull, Base and Bear scenarios'),
    ).toBe('Please provide a comprehensive valuati…');
    expect(service.generateTitle('[Context Target Stock: NVDA]\nWhat is the RSI?')).toBe('What is the RSI?');
    expect(service.generateTitle('')).toBe('New Chat');
  });

  it('appends messages and updates updatedAt timestamp', async () => {
    const conv = await service.createConversation('user-alice', {
      contextMode: 'global',
      messages: [{ id: 'm1', role: 'user', content: 'First question', ts: Date.now() }],
    });

    const updated = await service.appendMessages('user-alice', conv.id, [
      { id: 'm2', role: 'assistant', content: 'First answer', ts: Date.now() },
    ]);

    expect(updated.messages.length).toBe(2);
    expect(updated.messages[1].content).toBe('First answer');
  });
});

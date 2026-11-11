import { PrismaClient } from '@prisma/client';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodePayload } from '@tm/shared';
import { UserService } from './user-service.js';
import { decryptEmail } from './crypto.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'tm-users-'));
const db = new PrismaClient({ datasources: { db: { url: `file:${join(dir, 'test.db').replace(/\\/g, '/')}` } } });

beforeAll(async () => {
  const migrations = join(here, '../../prisma/migrations');
  for (const m of readdirSync(migrations).filter((d) => !d.endsWith('.toml')).sort()) {
    const sql = readFileSync(join(migrations, m, 'migration.sql'), 'utf8');
    for (const stmt of sql.split(';').map((s) => s.trim()).filter((s) => s && !/^--[^\n]*$/.test(s))) {
      await db.$executeRawUnsafe(stmt);
    }
  }
});

afterAll(async () => {
  await db.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe('UserService', () => {
  let svc: UserService;

  beforeEach(async () => {
    await db.inviteAttempt.deleteMany();
    await db.watchlistItem.deleteMany();
    await db.user.deleteMany({ where: { email: { not: 'default@trading.local' } } });
    svc = new UserService(db, { AUTH_INVITE_CODE: 'Y0DlUkMu@Y' }, { info() {}, warn() {} });
    await svc.init();
  });

  it('rejects registration with invalid invite code and tracks remaining attempts', async () => {
    const res = await svc.registerUser({
      email: 'user1@example.com',
      password: 'password123',
      inviteCode: 'WRONGCODE',
      ip: '192.168.1.100',
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('invalid_invite');
      expect(res.remaining).toBe(4);
    }
  });

  it('enforces 5 invalid attempts in 5 hours rate limit', async () => {
    const ip = '192.168.1.200';
    for (let i = 0; i < 4; i++) {
      const res = await svc.registerUser({
        email: `fail${i}@example.com`,
        password: 'password123',
        inviteCode: 'BADCODE',
        ip,
      });
      expect(res.ok).toBe(false);
    }

    // 5th attempt reaches the threshold
    const fifth = await svc.registerUser({
      email: 'fail5@example.com',
      password: 'password123',
      inviteCode: 'BADCODE',
      ip,
    });
    expect(fifth.ok).toBe(false);
    if (!fifth.ok) {
      expect(fifth.error).toBe('rate_limited');
      expect(fifth.remaining).toBe(0);
    }

    // 6th attempt is blocked immediately by rate limit
    const sixth = await svc.registerUser({
      email: 'fail6@example.com',
      password: 'password123',
      inviteCode: 'Y0DlUkMu@Y', // even with valid code!
      ip,
    });
    expect(sixth.ok).toBe(false);
    if (!sixth.ok) {
      expect(sixth.error).toBe('rate_limited');
    }
  });

  it('successfully registers user with valid invite code and seeds watchlist', async () => {
    const res = await svc.registerUser({
      email: 'valid@example.com',
      password: 'securePassword123',
      inviteCode: 'Y0DlUkMu@Y',
      ip: '192.168.1.50',
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.user.email).toBe('valid@example.com');
      // Watchlist is seeded
      const items = await db.watchlistItem.findMany({ where: { userId: res.user.id } });
      expect(items.length).toBe(6);
      expect(items.map((i) => i.symbol)).toContain('AAPL');
    }
  });

  it('rejects registration if email already exists', async () => {
    await svc.registerUser({
      email: 'dup@example.com',
      password: 'password123',
      inviteCode: 'Y0DlUkMu@Y',
      ip: '192.168.1.60',
    });

    const dup = await svc.registerUser({
      email: 'dup@example.com',
      password: 'password123',
      inviteCode: 'Y0DlUkMu@Y',
      ip: '192.168.1.61',
    });

    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.error).toBe('email_exists');
    }
  });

  it('stores email encrypted at rest with AES-256-GCM and computes emailHash blind index', async () => {
    const rawEmail = 'secret-agent@example.com';
    const res = await svc.registerUser({
      email: rawEmail,
      password: 'password123',
      inviteCode: 'Y0DlUkMu@Y',
      ip: '192.168.1.70',
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      const stored = await db.user.findUnique({ where: { id: res.user.id } });
      expect(stored).not.toBeNull();
      // Email in DB is encrypted with AES-256-GCM
      expect(stored?.email.startsWith('enc:')).toBe(true);
      expect(stored?.email).not.toContain(rawEmail);
      // Decrypting recovers original email
      expect(decryptEmail(stored!.email)).toBe(rawEmail);
      // emailHash blind index is stored and non-null
      expect(stored?.emailHash).toBeTruthy();
    }
  });

  it('supports encoded payloads (b64:...) in registration and credentials verification', async () => {
    const rawEmail = 'obfuscated@example.com';
    const rawPass = 'superSecretPass456';

    const reg = await svc.registerUser({
      email: encodePayload(rawEmail),
      password: encodePayload(rawPass),
      inviteCode: 'Y0DlUkMu@Y',
      ip: '192.168.1.80',
    });

    expect(reg.ok).toBe(true);
    if (reg.ok) {
      expect(reg.user.email).toBe(rawEmail);

      // Verify credentials with encoded payload
      const auth = await svc.verifyCredentials(encodePayload(rawEmail), encodePayload(rawPass));
      expect(auth).not.toBeNull();
      expect(auth?.email).toBe(rawEmail);

      // Verify credentials with plain payload also succeeds
      const authPlain = await svc.verifyCredentials(rawEmail, rawPass);
      expect(authPlain).not.toBeNull();
      expect(authPlain?.email).toBe(rawEmail);
    }
  });
});

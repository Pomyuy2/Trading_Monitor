import bcrypt from 'bcryptjs';
import type { PrismaClient, User } from '@prisma/client';
import { decodePayload } from '@tm/shared';
import { computeEmailHash, decryptEmail, encryptEmail } from './crypto.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
}

export const DEFAULT_INVITE_CODE = 'Y0DlUkMu@Y';
export const INVITE_RATE_LIMIT_MAX = 5;
export const INVITE_RATE_LIMIT_WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours

export class UserService {
  private readonly defaultEmail: string;
  private readonly defaultPass: string;
  private readonly inviteCode: string;
  private readonly secret: string;
  private defaultUserId: string = 'default-user';

  constructor(
    private readonly db: PrismaClient,
    env: { AUTH_USER_EMAIL?: string; AUTH_USER_PASSWORD?: string; AUTH_INVITE_CODE?: string; AUTH_SECRET?: string } = process.env,
    private readonly log: { info(m: string): void; warn(m: string): void } = console,
  ) {
    this.defaultEmail = env.AUTH_USER_EMAIL?.trim() ? env.AUTH_USER_EMAIL.trim().toLowerCase() : '';
    this.defaultPass = env.AUTH_USER_PASSWORD || '';
    this.inviteCode = env.AUTH_INVITE_CODE?.trim() || DEFAULT_INVITE_CODE;
    this.secret = env.AUTH_SECRET || process.env.AUTH_SECRET || '';
  }

  async init(): Promise<void> {
    try {
      // 1. Transparently migrate any unmigrated users in the DB:
      // compute emailHash and encrypt email if stored in plaintext
      const unmigratedUsers = await this.db.user.findMany({
        where: {
          OR: [
            { emailHash: null },
            { NOT: { email: { startsWith: 'enc:' } } },
          ],
        },
      });

      for (const u of unmigratedUsers) {
        if (u.id === 'default-user') continue;
        const plain = decryptEmail(u.email, this.secret);
        const enc = encryptEmail(plain, this.secret);
        const eHash = computeEmailHash(plain, this.secret);
        await this.db.user.update({
          where: { id: u.id },
          data: {
            email: enc,
            emailHash: eHash,
          },
        });
        this.log.info(`Encrypted email for user ${u.id}`);
      }

      // 2. Initialize configured admin user if explicitly set
      if (this.defaultEmail && this.defaultPass) {
        let admin = await this.findUserByEmail(this.defaultEmail);

        if (!admin) {
          const hash = await bcrypt.hash(this.defaultPass, 10);
          const encEmail = encryptEmail(this.defaultEmail, this.secret);
          const eHash = computeEmailHash(this.defaultEmail, this.secret);
          admin = await this.db.user.create({
            data: {
              email: encEmail,
              emailHash: eHash,
              name: this.defaultEmail.split('@')[0] || 'Admin',
              passwordHash: hash,
            },
          });
          this.log.info(`Initialized configured admin user: ${this.defaultEmail}`);
        }

        this.defaultUserId = admin.id;

        // Assign any legacy/unassigned watchlist items or alerts to the admin user
        await this.db.watchlistItem.updateMany({
          where: { userId: 'default-user' },
          data: { userId: admin.id },
        });
        await this.db.alert.updateMany({
          where: { userId: 'default-user' },
          data: { userId: admin.id },
        });
      }
    } catch (err) {
      this.log.warn(`User init check failed: ${(err as Error).message}`);
    }
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const cleanEmail = decodePayload(email).trim().toLowerCase();
    if (!cleanEmail) return null;
    const eHash = computeEmailHash(cleanEmail, this.secret);

    // Search by emailHash or plaintext email for backward compatibility
    const user = await this.db.user.findFirst({
      where: {
        OR: [
          { emailHash: eHash },
          { email: cleanEmail },
        ],
      },
    });

    if (!user) return null;

    return {
      ...user,
      email: decryptEmail(user.email, this.secret),
    };
  }

  async getDefaultUserId(): Promise<string> {
    if (this.defaultUserId && this.defaultUserId !== 'default-user') {
      return this.defaultUserId;
    }
    if (this.defaultEmail) {
      const admin = await this.findUserByEmail(this.defaultEmail);
      if (admin) {
        this.defaultUserId = admin.id;
        return admin.id;
      }
    }
    const anyUser = await this.db.user.findFirst({
      where: { id: { not: 'default-user' } },
      orderBy: { createdAt: 'asc' },
    });
    if (anyUser) {
      this.defaultUserId = anyUser.id;
      return anyUser.id;
    }
    return 'default-user';
  }

  async verifyCredentials(email: string, password: string): Promise<AuthUser | null> {
    const cleanEmail = decodePayload(email).trim().toLowerCase();
    const cleanPass = decodePayload(password);
    if (!cleanEmail || !cleanPass) return null;

    try {
      const user = await this.findUserByEmail(cleanEmail);

      if (user) {
        const valid = await bcrypt.compare(cleanPass, user.passwordHash);
        if (valid) {
          return { id: user.id, email: user.email, name: user.name };
        }
      }

      // Environment variable fallback check
      if (cleanEmail === this.defaultEmail && cleanPass === this.defaultPass) {
        return { id: this.defaultUserId, email: this.defaultEmail, name: 'Admin' };
      }

      return null;
    } catch {
      // Fallback to env comparison if DB query fails
      if (cleanEmail === this.defaultEmail && cleanPass === this.defaultPass) {
        return { id: this.defaultUserId, email: this.defaultEmail, name: 'Admin' };
      }
      return null;
    }
  }

  async checkInviteRateLimit(ip: string): Promise<{ allowed: boolean; remaining: number }> {
    const windowStart = new Date(Date.now() - INVITE_RATE_LIMIT_WINDOW_MS);
    const count = await this.db.inviteAttempt.count({
      where: {
        ip,
        createdAt: { gte: windowStart },
      },
    });

    const remaining = Math.max(0, INVITE_RATE_LIMIT_MAX - count);
    return {
      allowed: count < INVITE_RATE_LIMIT_MAX,
      remaining,
    };
  }

  async recordFailedInvite(ip: string): Promise<number> {
    await this.db.inviteAttempt.create({ data: { ip } });
    const { remaining } = await this.checkInviteRateLimit(ip);
    return remaining;
  }

  async registerUser(params: {
    email: string;
    password: string;
    inviteCode: string;
    ip: string;
    starterSymbols?: string[];
  }): Promise<
    | { ok: true; user: AuthUser }
    | { ok: false; error: 'rate_limited' | 'invalid_invite' | 'email_exists' | 'invalid_input'; remaining?: number }
  > {
    const cleanEmail = decodePayload(params.email).trim().toLowerCase();
    const cleanPass = decodePayload(params.password);
    const cleanInvite = params.inviteCode.trim();

    if (!cleanEmail || !cleanPass || cleanPass.length < 6) {
      return { ok: false, error: 'invalid_input' };
    }

    // 1. Check rate limit for this IP
    const rateCheck = await this.checkInviteRateLimit(params.ip);
    if (!rateCheck.allowed) {
      return { ok: false, error: 'rate_limited', remaining: 0 };
    }

    // 2. Validate invite code
    if (cleanInvite !== this.inviteCode) {
      const remaining = await this.recordFailedInvite(params.ip);
      if (remaining <= 0) {
        return { ok: false, error: 'rate_limited', remaining: 0 };
      }
      return { ok: false, error: 'invalid_invite', remaining };
    }

    // 3. Check if email already exists
    const existing = await this.findUserByEmail(cleanEmail);
    if (existing) {
      return { ok: false, error: 'email_exists' };
    }

    // 4. Create user with encrypted email and blind index
    const passwordHash = await bcrypt.hash(cleanPass, 10);
    const encryptedEmail = encryptEmail(cleanEmail, this.secret);
    const emailHash = computeEmailHash(cleanEmail, this.secret);

    const user = await this.db.user.create({
      data: {
        email: encryptedEmail,
        emailHash,
        passwordHash,
        name: cleanEmail.split('@')[0],
      },
    });

    // 5. Seed user's starter watchlist
    const starters = params.starterSymbols ?? ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL'];
    const now = Date.now();
    await this.db.watchlistItem.createMany({
      data: starters.map((symbol, i) => ({
        userId: user.id,
        symbol,
        position: i,
        addedAt: new Date(now + i),
      })),
    });

    // 6. Clean up old invite attempts for this IP
    await this.db.inviteAttempt.deleteMany({
      where: { ip: params.ip },
    }).catch(() => {});

    return {
      ok: true,
      user: {
        id: user.id,
        email: cleanEmail,
        name: user.name,
      },
    };
  }
}

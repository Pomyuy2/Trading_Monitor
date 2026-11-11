import bcrypt from 'bcryptjs';
import type { PrismaClient } from '@prisma/client';

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
}

export class UserService {
  private readonly defaultEmail: string;
  private readonly defaultPass: string;

  constructor(
    private readonly db: PrismaClient,
    env: { AUTH_USER_EMAIL?: string; AUTH_USER_PASSWORD?: string } = process.env,
    private readonly log: { info(m: string): void; warn(m: string): void } = console,
  ) {
    this.defaultEmail = (env.AUTH_USER_EMAIL?.trim() || 'admin@trading.local').toLowerCase();
    this.defaultPass = env.AUTH_USER_PASSWORD || 'admin1234';
  }

  async init(): Promise<void> {
    try {
      const count = await this.db.user.count();
      if (count === 0) {
        const hash = await bcrypt.hash(this.defaultPass, 10);
        await this.db.user.create({
          data: {
            email: this.defaultEmail,
            name: 'Admin',
            passwordHash: hash,
          },
        });
        this.log.info(`Initialized default admin user: ${this.defaultEmail}`);
      }
    } catch (err) {
      this.log.warn(`User init check failed: ${(err as Error).message}`);
    }
  }

  async verifyCredentials(email: string, password: string): Promise<AuthUser | null> {
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !password) return null;

    try {
      const user = await this.db.user.findUnique({
        where: { email: cleanEmail },
      });

      if (user) {
        const valid = await bcrypt.compare(password, user.passwordHash);
        if (valid) {
          return { id: user.id, email: user.email, name: user.name };
        }
      }

      // Environment variable fallback check
      if (cleanEmail === this.defaultEmail && password === this.defaultPass) {
        return { id: 'admin-env', email: this.defaultEmail, name: 'Admin' };
      }

      return null;
    } catch {
      // Fallback to env comparison if DB query fails
      if (cleanEmail === this.defaultEmail && password === this.defaultPass) {
        return { id: 'admin-env', email: this.defaultEmail, name: 'Admin' };
      }
      return null;
    }
  }
}

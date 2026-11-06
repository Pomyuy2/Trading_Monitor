import { PrismaClient } from '@prisma/client';

/** One Prisma client for the process (SQLite file: server/data/trading.db). */
export const db = new PrismaClient();

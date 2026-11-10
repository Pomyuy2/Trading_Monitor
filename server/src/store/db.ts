import { PrismaClient } from '@prisma/client';

/**
 * One Prisma client for the process. Default database: server/data/trading.db (see schema.prisma).
 * TM_DATABASE_URL overrides it (used by the end-to-end tests, so they never touch your real data).
 */
export const db = new PrismaClient(process.env.TM_DATABASE_URL ? { datasourceUrl: process.env.TM_DATABASE_URL } : undefined);

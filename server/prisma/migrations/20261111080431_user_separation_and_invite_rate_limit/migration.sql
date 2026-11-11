/*
  Warnings:

  - The primary key for the `WatchlistItem` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The required column `id` was added to the `WatchlistItem` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.

*/
-- CreateTable
CREATE TABLE "InviteAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ip" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Ensure default-user exists for foreign key references
INSERT OR IGNORE INTO "User" ("id", "email", "name", "passwordHash", "createdAt", "updatedAt")
VALUES ('default-user', 'default@trading.local', 'Default User', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Alert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL DEFAULT 'default-user',
    "symbol" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetPrice" REAL,
    "levelKind" TEXT,
    "levelPrice" REAL,
    "zoneLow" REAL,
    "zoneHigh" REAL,
    "levelRange" TEXT,
    "resolution" TEXT,
    "armed" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "triggeredAt" DATETIME,
    "triggerPrice" REAL,
    "seen" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Alert_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Alert" ("armed", "createdAt", "id", "kind", "levelKind", "levelPrice", "levelRange", "resolution", "seen", "status", "symbol", "targetPrice", "triggerPrice", "triggeredAt", "zoneHigh", "zoneLow") SELECT "armed", "createdAt", "id", "kind", "levelKind", "levelPrice", "levelRange", "resolution", "seen", "status", "symbol", "targetPrice", "triggerPrice", "triggeredAt", "zoneHigh", "zoneLow" FROM "Alert";
DROP TABLE "Alert";
ALTER TABLE "new_Alert" RENAME TO "Alert";
CREATE INDEX "Alert_userId_status_idx" ON "Alert"("userId", "status");
CREATE INDEX "Alert_symbol_status_idx" ON "Alert"("symbol", "status");
CREATE TABLE "new_PushSubscription" (
    "endpoint" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "lang" TEXT NOT NULL DEFAULT 'en',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_PushSubscription" ("auth", "createdAt", "endpoint", "lang", "p256dh") SELECT "auth", "createdAt", "endpoint", "lang", "p256dh" FROM "PushSubscription";
DROP TABLE "PushSubscription";
ALTER TABLE "new_PushSubscription" RENAME TO "PushSubscription";
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");
CREATE TABLE "new_WatchlistItem" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    "userId" TEXT NOT NULL DEFAULT 'default-user',
    "symbol" TEXT NOT NULL,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "position" INTEGER NOT NULL DEFAULT 0,
    "group" TEXT,
    CONSTRAINT "WatchlistItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_WatchlistItem" ("addedAt", "group", "position", "symbol") SELECT "addedAt", "group", "position", "symbol" FROM "WatchlistItem";
DROP TABLE "WatchlistItem";
ALTER TABLE "new_WatchlistItem" RENAME TO "WatchlistItem";
CREATE INDEX "WatchlistItem_userId_idx" ON "WatchlistItem"("userId");
CREATE UNIQUE INDEX "WatchlistItem_userId_symbol_key" ON "WatchlistItem"("userId", "symbol");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "InviteAttempt_ip_createdAt_idx" ON "InviteAttempt"("ip", "createdAt");

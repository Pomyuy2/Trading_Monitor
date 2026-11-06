-- CreateTable
CREATE TABLE "WatchlistItem" (
    "symbol" TEXT NOT NULL PRIMARY KEY,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "seen" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "AiCache" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "storedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "Alert_symbol_status_idx" ON "Alert"("symbol", "status");

-- CreateIndex
CREATE INDEX "AiCache_expiresAt_idx" ON "AiCache"("expiresAt");

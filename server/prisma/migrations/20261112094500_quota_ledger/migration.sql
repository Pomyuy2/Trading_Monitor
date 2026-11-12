-- CreateTable
CREATE TABLE "QuotaLedger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL DEFAULT 'default',
    "usedRequests" INTEGER NOT NULL DEFAULT 0,
    "usedCredits" INTEGER NOT NULL DEFAULT 0,
    "windowType" TEXT NOT NULL DEFAULT 'rolling',
    "windowStart" DATETIME NOT NULL,
    "windowEnd" DATETIME NOT NULL,
    "lastRateLimitAt" DATETIME,
    "lastSuccessAt" DATETIME,
    "circuitBreakerState" TEXT NOT NULL DEFAULT 'closed',
    "circuitBreakerUntil" DATETIME,
    "strikes" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "QuotaLedger_provider_endpoint_key" ON "QuotaLedger"("provider", "endpoint");

-- CreateIndex
CREATE INDEX "QuotaLedger_provider_idx" ON "QuotaLedger"("provider");

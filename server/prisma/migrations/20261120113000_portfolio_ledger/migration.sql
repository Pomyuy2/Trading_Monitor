-- CreateTable
CREATE TABLE "Portfolio" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL DEFAULT 'default-user',
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Portfolio_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PortfolioTransaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "portfolioId" TEXT NOT NULL,
    "symbol" TEXT,
    "type" TEXT NOT NULL,
    "quantity" REAL NOT NULL DEFAULT 0,
    "price" REAL NOT NULL DEFAULT 0,
    "fee" REAL NOT NULL DEFAULT 0,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    CONSTRAINT "PortfolioTransaction_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserInvestmentProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "horizon" TEXT NOT NULL DEFAULT 'medium',
    "riskTolerance" TEXT NOT NULL DEFAULT 'moderate',
    "liquidityNeeds" TEXT NOT NULL DEFAULT 'medium',
    "lossCapacity" TEXT NOT NULL DEFAULT 'moderate',
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserInvestmentProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Portfolio_userId_idx" ON "Portfolio"("userId");

-- CreateIndex
CREATE INDEX "PortfolioTransaction_portfolioId_timestamp_idx" ON "PortfolioTransaction"("portfolioId", "timestamp");

-- CreateIndex
CREATE INDEX "PortfolioTransaction_portfolioId_symbol_idx" ON "PortfolioTransaction"("portfolioId", "symbol");

-- CreateIndex
CREATE UNIQUE INDEX "UserInvestmentProfile_userId_key" ON "UserInvestmentProfile"("userId");

-- CreateIndex
CREATE INDEX "UserInvestmentProfile_userId_idx" ON "UserInvestmentProfile"("userId");

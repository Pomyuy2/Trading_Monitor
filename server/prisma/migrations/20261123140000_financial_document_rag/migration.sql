-- CreateTable FinancialDocument
CREATE TABLE "FinancialDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "cik" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "form" TEXT NOT NULL,
    "filingDate" DATETIME NOT NULL,
    "filingDateStr" TEXT NOT NULL,
    "reportDate" DATETIME,
    "reportDateStr" TEXT,
    "accessionNumber" TEXT NOT NULL,
    "primaryDoc" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "rawTextPath" TEXT,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable DocumentSection
CREATE TABLE "DocumentSection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "sectionCode" TEXT NOT NULL,
    "sectionTitle" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "content" TEXT NOT NULL,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "DocumentSection_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "FinancialDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable DocumentChunk
CREATE TABLE "DocumentChunk" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "form" TEXT NOT NULL,
    "filingDate" DATETIME NOT NULL,
    "filingDateStr" TEXT NOT NULL,
    "reportDate" DATETIME,
    "reportDateStr" TEXT,
    "sectionCode" TEXT NOT NULL,
    "sectionTitle" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "tokenCount" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    CONSTRAINT "DocumentChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "FinancialDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DocumentChunk_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "DocumentSection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Indexes for FinancialDocument
CREATE UNIQUE INDEX "FinancialDocument_symbol_form_filingDateStr_key" ON "FinancialDocument"("symbol", "form", "filingDateStr");
CREATE INDEX "FinancialDocument_symbol_filingDateStr_idx" ON "FinancialDocument"("symbol", "filingDateStr");
CREATE INDEX "FinancialDocument_filingDateStr_idx" ON "FinancialDocument"("filingDateStr");

-- Indexes for DocumentSection
CREATE UNIQUE INDEX "DocumentSection_documentId_sectionCode_key" ON "DocumentSection"("documentId", "sectionCode");
CREATE INDEX "DocumentSection_documentId_idx" ON "DocumentSection"("documentId");
CREATE INDEX "DocumentSection_sectionCode_idx" ON "DocumentSection"("sectionCode");

-- Indexes for DocumentChunk
CREATE INDEX "DocumentChunk_documentId_idx" ON "DocumentChunk"("documentId");
CREATE INDEX "DocumentChunk_sectionId_idx" ON "DocumentChunk"("sectionId");
CREATE INDEX "DocumentChunk_symbol_filingDateStr_idx" ON "DocumentChunk"("symbol", "filingDateStr");
CREATE INDEX "DocumentChunk_symbol_form_filingDateStr_idx" ON "DocumentChunk"("symbol", "form", "filingDateStr");
CREATE INDEX "DocumentChunk_symbol_sectionCode_idx" ON "DocumentChunk"("symbol", "sectionCode");

-- FTS5 Virtual Table for full-text search with Porter stemming
CREATE VIRTUAL TABLE IF NOT EXISTS "DocumentChunkFts" USING fts5(
    id UNINDEXED,
    symbol UNINDEXED,
    form UNINDEXED,
    filingDateStr UNINDEXED,
    sectionCode UNINDEXED,
    sectionTitle,
    content,
    tokenize = 'porter unicode61'
);

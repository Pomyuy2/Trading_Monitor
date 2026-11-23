import * as path from 'node:path';
import { db } from '../store/db.js';
import { SecClient, type SecFilingMeta } from './sec-client.js';
import { parseSecSections, type ParsedSection } from './sec-parser.js';
import { chunkSection, type GeneratedChunk } from './chunker.js';
import { secCikService, SecCikService } from './sec-cik-service.js';

export interface IngestionOptions {
  symbols?: string[]; // e.g. ['NVDA', 'AAPL', 'MSFT', 'TSLA']
  force?: boolean;
  max10KPerSymbol?: number; // default 2
  max10QPerSymbol?: number; // default 3
  max8KPerSymbol?: number; // default 2
  endDate?: string; // YYYY-MM-DD
  onProgress?: (msg: string) => void;
}

export interface IngestionStats {
  documentsIngested: number;
  sectionsCreated: number;
  chunksCreated: number;
  skippedDocuments: number;
  errors: { symbol: string; form: string; date: string; error: string }[];
}

export class SecIngestionPipeline {
  private client: SecClient;
  private cikService: SecCikService;

  constructor(client?: SecClient, cikService?: SecCikService) {
    this.client = client ?? new SecClient();
    this.cikService = cikService ?? secCikService;
  }

  async discoverTargetFilings(
    symbol: string,
    max10K = 2,
    max10Q = 3,
    max8K = 2,
    endDate?: string,
  ): Promise<SecFilingMeta[]> {
    const sym = symbol.toUpperCase().trim();
    const resolved = await this.cikService.resolveTicker(sym);
    if (!resolved) {
      throw new Error(`Symbol ${sym} is not a supported SEC-reporting public company.`);
    }

    const cik = resolved.cik;
    const sub = await this.client.getCompanySubmissions(cik);
    const r = sub.filings?.recent;
    if (!r || !r.form) {
      return [];
    }

    const companyName = sub.name ?? resolved.companyName ?? sym;

    const tenKs: SecFilingMeta[] = [];
    const tenQs: SecFilingMeta[] = [];
    const eightKs: SecFilingMeta[] = [];

    const numericCik = cik.replace(/^0+/, '');

    for (let i = 0; i < r.form.length; i++) {
      const form = r.form[i];
      const filingDate = r.filingDate[i];
      const reportDate = r.reportDate?.[i];
      const accessionNumber = r.accessionNumber[i];
      const primaryDoc = r.primaryDocument[i];

      // Historical cutoff: strictly skip filings after endDate
      if (endDate && filingDate > endDate) {
        continue;
      }

      const accNoHyphen = accessionNumber.replace(/-/g, '');
      const sourceUrl = `https://www.sec.gov/Archives/edgar/data/${numericCik}/${accNoHyphen}/${primaryDoc}`;

      const meta: SecFilingMeta = {
        symbol: sym,
        cik,
        companyName,
        form,
        filingDate,
        reportDate,
        accessionNumber,
        primaryDoc,
        sourceUrl,
      };

      if ((form === '10-K' || form === '10-K/A') && tenKs.length < max10K) {
        tenKs.push(meta);
      } else if ((form === '10-Q' || form === '10-Q/A') && tenQs.length < max10Q) {
        tenQs.push(meta);
      } else if (form === '8-K' && eightKs.length < max8K) {
        // Prioritize earnings-related 8-Ks if items metadata is present
        const items = r.items?.[i] || '';
        const isEarningsOrMaterial = items.includes('2.02') || items.includes('7.01') || items.length === 0;
        if (isEarningsOrMaterial || eightKs.length < 1) {
          eightKs.push(meta);
        }
      }

      if (tenKs.length >= max10K && tenQs.length >= max10Q && eightKs.length >= max8K) {
        break;
      }
    }

    return [...tenKs, ...tenQs, ...eightKs];
  }

  async ingestFiling(meta: SecFilingMeta, force = false): Promise<{ docId: string; sections: number; chunks: number }> {
    const docId = `sec-${meta.symbol}-${meta.form}-${meta.filingDate}`;

    if (!force) {
      const existing = await db.financialDocument.findUnique({
        where: { id: docId },
        include: { _count: { select: { chunks: true } } },
      });
      if (existing && existing._count.chunks > 0) {
        return { docId, sections: existing.chunkCount, chunks: existing._count.chunks };
      }
    }

    // Download or get from cache
    const { text, cachePath } = await this.client.getFilingDocument(
      meta.cik,
      meta.accessionNumber,
      meta.primaryDoc,
    );

    // Parse sections
    const parsedSections = parseSecSections(text, meta.form);

    // Disambiguate any duplicate sectionCodes within the document (e.g. TOC vs body)
    const codeOccurrences = new Map<string, number>();
    for (const sec of parsedSections) {
      const base = sec.sectionCode;
      const count = (codeOccurrences.get(base) ?? 0) + 1;
      codeOccurrences.set(base, count);
      if (count > 1) {
        sec.sectionCode = `${base}_${count}`;
      }
    }

    // Generate chunks for each section
    const filingDateObj = new Date(meta.filingDate);
    const reportDateObj = meta.reportDate ? new Date(meta.reportDate) : null;

    interface SectionWithChunks {
      section: ParsedSection;
      sectionId: string;
      chunks: GeneratedChunk[];
    }

    const sectionsWithChunks: SectionWithChunks[] = [];
    const seenChunkIds = new Set<string>();
    let totalChunkCount = 0;

    for (const sec of parsedSections) {
      const sectionId = `${docId}-${sec.sectionCode}`;
      const rawChunks = chunkSection({
        documentId: docId,
        sectionId,
        symbol: meta.symbol,
        form: meta.form,
        filingDate: filingDateObj,
        filingDateStr: meta.filingDate,
        reportDate: reportDateObj,
        reportDateStr: meta.reportDate ?? null,
        sectionCode: sec.sectionCode,
        sectionTitle: sec.sectionTitle,
        content: sec.content,
      });

      // Guarantee chunk ID uniqueness across the document
      const uniqueChunks = rawChunks.filter((c) => {
        if (seenChunkIds.has(c.id)) return false;
        seenChunkIds.add(c.id);
        return true;
      });

      sectionsWithChunks.push({
        section: sec,
        sectionId,
        chunks: uniqueChunks,
      });
      totalChunkCount += uniqueChunks.length;
    }

    // Persist to database in transaction (delete existing if force)
    await db.$transaction(async (tx) => {
      if (force) {
        await tx.$executeRawUnsafe(
          `DELETE FROM DocumentChunkFts WHERE id IN (SELECT id FROM DocumentChunk WHERE documentId = ?)`,
          docId,
        );
        await tx.documentChunk.deleteMany({ where: { documentId: docId } });
        await tx.documentSection.deleteMany({ where: { documentId: docId } });
        await tx.financialDocument.deleteMany({ where: { id: docId } });
      }

      await tx.financialDocument.upsert({
        where: { id: docId },
        update: {
          chunkCount: totalChunkCount,
          rawTextPath: cachePath,
        },
        create: {
          id: docId,
          symbol: meta.symbol,
          cik: meta.cik,
          companyName: meta.companyName,
          form: meta.form,
          filingDate: filingDateObj,
          filingDateStr: meta.filingDate,
          reportDate: reportDateObj,
          reportDateStr: meta.reportDate ?? null,
          accessionNumber: meta.accessionNumber,
          primaryDoc: meta.primaryDoc,
          sourceUrl: meta.sourceUrl,
          rawTextPath: cachePath,
          chunkCount: totalChunkCount,
        },
      });

      for (const item of sectionsWithChunks) {
        await tx.documentSection.upsert({
          where: { id: item.sectionId },
          update: {
            content: item.section.content,
            chunkCount: item.chunks.length,
          },
          create: {
            id: item.sectionId,
            documentId: docId,
            sectionCode: item.section.sectionCode,
            sectionTitle: item.section.sectionTitle,
            orderIndex: item.section.orderIndex,
            content: item.section.content,
            chunkCount: item.chunks.length,
          },
        });

        // Batch insert chunks
        if (item.chunks.length > 0) {
          // Prisma createMany is supported on SQLite
          await tx.documentChunk.createMany({
            data: item.chunks.map((c) => ({
              id: c.id,
              documentId: docId,
              sectionId: item.sectionId,
              symbol: c.symbol,
              form: c.form,
              filingDate: c.filingDate,
              filingDateStr: c.filingDateStr,
              reportDate: c.reportDate,
              reportDateStr: c.reportDateStr,
              sectionCode: c.sectionCode,
              sectionTitle: c.sectionTitle,
              chunkIndex: c.chunkIndex,
              tokenCount: c.tokenCount,
              content: c.content,
            })),
          });

          await tx.$executeRawUnsafe(
            `INSERT OR REPLACE INTO DocumentChunkFts(id, symbol, form, filingDateStr, sectionCode, sectionTitle, content)
             SELECT id, symbol, form, filingDateStr, sectionCode, sectionTitle, content FROM DocumentChunk WHERE sectionId = ?`,
            item.sectionId,
          );
        }
      }
    });

    return { docId, sections: parsedSections.length, chunks: totalChunkCount };
  }

  async run(options: IngestionOptions = {}): Promise<IngestionStats> {
    const symbols = options.symbols ?? ['NVDA', 'AAPL', 'MSFT'];
    const max10K = options.max10KPerSymbol ?? 2;
    const max10Q = options.max10QPerSymbol ?? 3;
    const max8K = options.max8KPerSymbol ?? 2;
    const force = options.force ?? false;
    const onProgress = options.onProgress ?? ((msg) => console.log(msg));

    const stats: IngestionStats = {
      documentsIngested: 0,
      sectionsCreated: 0,
      chunksCreated: 0,
      skippedDocuments: 0,
      errors: [],
    };

    for (const symbol of symbols) {
      onProgress(`\n[Ingestion] Discovering filings for ${symbol}...`);
      try {
        const filings = await this.discoverTargetFilings(symbol, max10K, max10Q, max8K, options.endDate);
        onProgress(`[Ingestion] Found ${filings.length} filings for ${symbol} (${filings.filter(f => f.form.includes('10-K')).length} 10-K, ${filings.filter(f => f.form.includes('10-Q')).length} 10-Q, ${filings.filter(f => f.form === '8-K').length} 8-K)`);

        for (const filing of filings) {
          try {
            onProgress(`[Ingestion] Processing ${symbol} ${filing.form} filed ${filing.filingDate} (${filing.primaryDoc})...`);
            const res = await this.ingestFiling(filing, force);
            stats.documentsIngested++;
            stats.sectionsCreated += res.sections;
            stats.chunksCreated += res.chunks;
            onProgress(`[Ingestion] Successfully ingested ${res.docId}: ${res.sections} sections, ${res.chunks} chunks`);
          } catch (err: any) {
            onProgress(`[Ingestion ERROR] Failed to ingest ${symbol} ${filing.form} ${filing.filingDate}: ${err.message}`);
            stats.errors.push({
              symbol,
              form: filing.form,
              date: filing.filingDate,
              error: err.message,
            });
          }
        }
      } catch (err: any) {
        onProgress(`[Ingestion ERROR] Discovery failed for ${symbol}: ${err.message}`);
      }
    }

    return stats;
  }
}

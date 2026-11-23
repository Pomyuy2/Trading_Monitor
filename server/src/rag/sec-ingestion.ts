import * as path from 'node:path';
import { db } from '../store/db.js';
import { SecClient, type SecFilingMeta } from './sec-client.js';
import { parseSecSections, type ParsedSection } from './sec-parser.js';
import { chunkSection, type GeneratedChunk } from './chunker.js';

export interface IngestionOptions {
  symbols?: string[]; // default ['NVDA', 'AAPL', 'MSFT']
  force?: boolean;
  max10KPerSymbol?: number; // default 3 (e.g. FY26, FY25, FY24)
  max10QPerSymbol?: number; // default 4
  onProgress?: (msg: string) => void;
}

export interface IngestionStats {
  documentsIngested: number;
  sectionsCreated: number;
  chunksCreated: number;
  skippedDocuments: number;
  errors: { symbol: string; form: string; date: string; error: string }[];
}

const CIK_MAP: Record<string, string> = {
  NVDA: '0001045810',
  AAPL: '0000320193',
  MSFT: '0000789019',
};

export class SecIngestionPipeline {
  private client: SecClient;

  constructor(client?: SecClient) {
    this.client = client ?? new SecClient();
  }

  async discoverTargetFilings(
    symbol: string,
    max10K = 3,
    max10Q = 4,
  ): Promise<SecFilingMeta[]> {
    const cik = CIK_MAP[symbol.toUpperCase()];
    if (!cik) throw new Error(`Unknown CIK for symbol ${symbol}`);

    const sub = await this.client.getCompanySubmissions(cik);
    const r = sub.filings.recent;
    const companyName = sub.name ?? symbol;

    const tenKs: SecFilingMeta[] = [];
    const tenQs: SecFilingMeta[] = [];

    for (let i = 0; i < r.form.length; i++) {
      const form = r.form[i];
      const filingDate = r.filingDate[i];
      const reportDate = r.reportDate?.[i];
      const accessionNumber = r.accessionNumber[i];
      const primaryDoc = r.primaryDocument[i];

      if (form === '10-K' && tenKs.length < max10K) {
        const numericCik = cik.replace(/^0+/, '');
        const accNoHyphen = accessionNumber.replace(/-/g, '');
        tenKs.push({
          symbol: symbol.toUpperCase(),
          cik,
          companyName,
          form: '10-K',
          filingDate,
          reportDate,
          accessionNumber,
          primaryDoc,
          sourceUrl: `https://www.sec.gov/Archives/edgar/data/${numericCik}/${accNoHyphen}/${primaryDoc}`,
        });
      } else if (form === '10-Q' && tenQs.length < max10Q) {
        const numericCik = cik.replace(/^0+/, '');
        const accNoHyphen = accessionNumber.replace(/-/g, '');
        tenQs.push({
          symbol: symbol.toUpperCase(),
          cik,
          companyName,
          form: '10-Q',
          filingDate,
          reportDate,
          accessionNumber,
          primaryDoc,
          sourceUrl: `https://www.sec.gov/Archives/edgar/data/${numericCik}/${accNoHyphen}/${primaryDoc}`,
        });
      }

      if (tenKs.length >= max10K && tenQs.length >= max10Q) break;
    }

    return [...tenKs, ...tenQs];
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
    const parsedSections = parseSecSections(text, meta.form as '10-K' | '10-Q');

    // Generate chunks for each section
    const filingDateObj = new Date(meta.filingDate);
    const reportDateObj = meta.reportDate ? new Date(meta.reportDate) : null;

    interface SectionWithChunks {
      section: ParsedSection;
      sectionId: string;
      chunks: GeneratedChunk[];
    }

    const sectionsWithChunks: SectionWithChunks[] = [];
    let totalChunkCount = 0;

    for (const sec of parsedSections) {
      const sectionId = `${docId}-${sec.sectionCode}`;
      const chunks = chunkSection({
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

      sectionsWithChunks.push({
        section: sec,
        sectionId,
        chunks,
      });
      totalChunkCount += chunks.length;
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
    const max10K = options.max10KPerSymbol ?? 3;
    const max10Q = options.max10QPerSymbol ?? 4;
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
        const filings = await this.discoverTargetFilings(symbol, max10K, max10Q);
        onProgress(`[Ingestion] Found ${filings.length} filings for ${symbol} (${filings.filter(f => f.form === '10-K').length} 10-K, ${filings.filter(f => f.form === '10-Q').length} 10-Q)`);

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

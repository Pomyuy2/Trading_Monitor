import { SecIngestionPipeline } from './sec-ingestion.js';
import { db } from '../store/db.js';

async function main() {
  console.log('=== TRADING MONITOR — SEC FILINGS RAG INGESTION ===\n');

  const pipeline = new SecIngestionPipeline();
  const startTime = Date.now();

  const stats = await pipeline.run({
    symbols: ['NVDA', 'AAPL', 'MSFT'],
    max10KPerSymbol: 3,
    max10QPerSymbol: 4,
    onProgress: (msg) => console.log(msg),
  });

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

  const docCount = await db.financialDocument.count();
  const secCount = await db.documentSection.count();
  const chunkCount = await db.documentChunk.count();
  const ftsCountRes = await db.$queryRawUnsafe<[{ c: bigint }]>('SELECT count(*) as c FROM DocumentChunkFts');
  const ftsCount = Number(ftsCountRes[0]?.c ?? 0);

  console.log('\n=== INGESTION SUMMARY ===');
  console.log(`Duration: ${durationSec}s`);
  console.log(`Documents Ingested / Verified: ${stats.documentsIngested}`);
  console.log(`Sections Created: ${stats.sectionsCreated}`);
  console.log(`Chunks Created: ${stats.chunksCreated}`);
  console.log(`Errors: ${stats.errors.length}`);
  if (stats.errors.length > 0) {
    console.error('Errors encountered:', stats.errors);
  }

  console.log('\n=== DATABASE TOTAL COUNTS ===');
  console.log(`Total FinancialDocument: ${docCount}`);
  console.log(`Total DocumentSection: ${secCount}`);
  console.log(`Total DocumentChunk: ${chunkCount}`);
  console.log(`Total DocumentChunkFts: ${ftsCount}`);

  await db.$disconnect();
}

main().catch((err) => {
  console.error('Fatal ingestion error:', err);
  process.exit(1);
});

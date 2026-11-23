import { BenchmarkRunner } from './evaluate.js';
import { db } from '../store/db.js';

async function main() {
  const args = process.argv.slice(2);
  let limit: number | undefined;
  let split: 'eval_frozen' | 'dev_tuning' | 'all' = 'all';
  let concurrency = 2;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit') {
      limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--split') {
      split = args[i + 1] as any;
      i++;
    } else if (args[i] === '--concurrency') {
      concurrency = parseInt(args[i + 1], 10);
      i++;
    }
  }

  console.log(`Starting benchmark with options: split=${split}, limit=${limit ?? 'all'}, concurrency=${concurrency}`);

  const runner = new BenchmarkRunner();
  const res = await runner.runBenchmark({
    split,
    limit,
    concurrency,
    verbose: true,
  });

  console.log('\n=============================================================');
  console.log('BENCHMARK EVALUATION SUMMARY');
  console.log('=============================================================');
  console.log('Retrieval Metrics:');
  console.log(`  Recall@1: ${(res.retrievalAggregates.recallAt1 * 100).toFixed(1)}%`);
  console.log(`  Recall@3: ${(res.retrievalAggregates.recallAt3 * 100).toFixed(1)}%`);
  console.log(`  Recall@5: ${(res.retrievalAggregates.recallAt5 * 100).toFixed(1)}%`);
  console.log(`  MRR:      ${res.retrievalAggregates.mrr.toFixed(3)}`);
  console.log('-------------------------------------------------------------');
  console.log('Agent Performance Comparison:');
  console.log(`  Metric                        | V1 (Baseline)  | V2 (Financial RAG)`);
  console.log(`  ----------------------------- | -------------- | ------------------`);
  console.log(`  Factual Correctness           | ${(res.aggregateV1.overall.avgFactualCorrectness * 100).toFixed(1)}%          | ${(res.aggregateV2.overall.avgFactualCorrectness * 100).toFixed(1)}%`);
  console.log(`  Citation Faithfulness         | ${(res.aggregateV1.overall.avgCitationFaithfulness * 100).toFixed(1)}%          | ${(res.aggregateV2.overall.avgCitationFaithfulness * 100).toFixed(1)}%`);
  console.log(`  Unsupported Claim Rate        | ${(res.aggregateV1.overall.avgUnsupportedClaimRate * 100).toFixed(1)}%          | ${(res.aggregateV2.overall.avgUnsupportedClaimRate * 100).toFixed(1)}%`);
  console.log(`  Cutoff Compliance (Lookahead) | ${(res.aggregateV1.overall.historicalCutoffComplianceRate * 100).toFixed(1)}%          | ${(res.aggregateV2.overall.historicalCutoffComplianceRate * 100).toFixed(1)}%`);
  console.log(`  Abstention Accuracy           | ${(res.aggregateV1.overall.appropriateAbstentionRate * 100).toFixed(1)}%          | ${(res.aggregateV2.overall.appropriateAbstentionRate * 100).toFixed(1)}%`);
  console.log(`  Mean Latency                  | ${res.aggregateV1.overall.avgLatencyMs} ms         | ${res.aggregateV2.overall.avgLatencyMs} ms`);
  console.log(`  P50 Latency                   | ${res.aggregateV1.overall.p50LatencyMs} ms         | ${res.aggregateV2.overall.p50LatencyMs} ms`);
  console.log(`  P90 Latency                   | ${res.aggregateV1.overall.p90LatencyMs} ms         | ${res.aggregateV2.overall.p90LatencyMs} ms`);
  console.log(`  Avg Tool Calls / Query        | ${res.aggregateV1.overall.avgToolCallsPerQuery}            | ${res.aggregateV2.overall.avgToolCallsPerQuery}`);
  console.log('=============================================================\n');
}

main().catch(console.error).finally(() => db.$disconnect());

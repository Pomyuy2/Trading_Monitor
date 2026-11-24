import 'dotenv/config';
import { BenchmarkRunner } from './evaluate.js';
import { db } from '../store/db.js';

async function main() {
  const args = process.argv.slice(2);
  let limit: number | undefined;
  let split: 'eval_frozen' | 'dev_tuning' | 'all' = 'all';
  let concurrency = 2;
  let compareMode: 'v1_v2' | 'v21_v22' = 'v21_v22';
  let deepOnly = false;
  let includeDeepScenarios = false;

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
    } else if (args[i] === '--compare') {
      compareMode = args[i + 1] as any;
      i++;
    } else if (args[i] === '--deep-only') {
      deepOnly = true;
    } else if (args[i] === '--include-deep') {
      includeDeepScenarios = true;
    }
  }

  console.log(
    `Starting benchmark with options: compareMode=${compareMode}, split=${split}, limit=${limit ?? 'all'}, concurrency=${concurrency}, deepOnly=${deepOnly}`,
  );

  const runner = new BenchmarkRunner();
  const res = await runner.runBenchmark({
    split,
    limit,
    concurrency,
    compareMode,
    deepOnly,
    includeDeepScenarios,
    verbose: true,
  });

  const baseLabel = compareMode === 'v1_v2' ? 'V1 (Baseline)' : 'V2.1 (Financial RAG)';
  const targetLabel = 'V2.2 (Plan & Verify)';

  console.log('\n=============================================================');
  console.log(`BENCHMARK EVALUATION SUMMARY (${baseLabel} vs ${targetLabel})`);
  console.log('=============================================================');
  console.log('Retrieval Metrics:');
  console.log(`  Recall@1: ${(res.retrievalAggregates.recallAt1 * 100).toFixed(1)}%`);
  console.log(`  Recall@3: ${(res.retrievalAggregates.recallAt3 * 100).toFixed(1)}%`);
  console.log(`  Recall@5: ${(res.retrievalAggregates.recallAt5 * 100).toFixed(1)}%`);
  console.log(`  MRR:      ${res.retrievalAggregates.mrr.toFixed(3)}`);
  console.log('-------------------------------------------------------------');
  console.log('Agent Performance Comparison:');
  console.log(`  Metric                        | ${baseLabel.padEnd(20)} | ${targetLabel.padEnd(20)}`);
  console.log(`  ----------------------------- | ${'--------------------'} | ${'--------------------'}`);
  console.log(
    `  Factual Correctness           | ${(res.aggregateBaseline.overall.avgFactualCorrectness * 100).toFixed(1)}%${' '.repeat(14)}| ${(res.aggregateTarget.overall.avgFactualCorrectness * 100).toFixed(1)}%`,
  );
  console.log(
    `  Citation Faithfulness         | ${(res.aggregateBaseline.overall.avgCitationFaithfulness * 100).toFixed(1)}%${' '.repeat(14)}| ${(res.aggregateTarget.overall.avgCitationFaithfulness * 100).toFixed(1)}%`,
  );
  console.log(
    `  Unsupported Claim Rate        | ${(res.aggregateBaseline.overall.avgUnsupportedClaimRate * 100).toFixed(1)}%${' '.repeat(14)}| ${(res.aggregateTarget.overall.avgUnsupportedClaimRate * 100).toFixed(1)}%`,
  );
  console.log(
    `  Cutoff Compliance (Lookahead) | ${(res.aggregateBaseline.overall.historicalCutoffComplianceRate * 100).toFixed(1)}%${' '.repeat(14)}| ${(res.aggregateTarget.overall.historicalCutoffComplianceRate * 100).toFixed(1)}%`,
  );
  console.log(
    `  Abstention Accuracy           | ${(res.aggregateBaseline.overall.appropriateAbstentionRate * 100).toFixed(1)}%${' '.repeat(14)}| ${(res.aggregateTarget.overall.appropriateAbstentionRate * 100).toFixed(1)}%`,
  );
  console.log(
    `  Mean Latency                  | ${res.aggregateBaseline.overall.avgLatencyMs} ms${' '.repeat(Math.max(1, 16 - String(res.aggregateBaseline.overall.avgLatencyMs).length))}| ${res.aggregateTarget.overall.avgLatencyMs} ms`,
  );
  console.log(
    `  P50 Latency                   | ${res.aggregateBaseline.overall.p50LatencyMs} ms${' '.repeat(Math.max(1, 16 - String(res.aggregateBaseline.overall.p50LatencyMs).length))}| ${res.aggregateTarget.overall.p50LatencyMs} ms`,
  );
  console.log(
    `  P90 Latency                   | ${res.aggregateBaseline.overall.p90LatencyMs} ms${' '.repeat(Math.max(1, 16 - String(res.aggregateBaseline.overall.p90LatencyMs).length))}| ${res.aggregateTarget.overall.p90LatencyMs} ms`,
  );
  console.log(
    `  Avg Tool Calls / Query        | ${res.aggregateBaseline.overall.avgToolCallsPerQuery}${' '.repeat(Math.max(1, 19 - String(res.aggregateBaseline.overall.avgToolCallsPerQuery).length))}| ${res.aggregateTarget.overall.avgToolCallsPerQuery}`,
  );
  console.log(
    `  Avg Tokens Consumed           | ${res.aggregateBaseline.overall.avgTokens}${' '.repeat(Math.max(1, 19 - String(res.aggregateBaseline.overall.avgTokens).length))}| ${res.aggregateTarget.overall.avgTokens}`,
  );
  console.log('=============================================================\n');
}

main().catch(console.error).finally(() => db.$disconnect());

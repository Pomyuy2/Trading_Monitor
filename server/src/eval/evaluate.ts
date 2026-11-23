import * as fs from 'node:fs';
import * as path from 'node:path';
import { db } from '../store/db.js';
import { BENCHMARK_QUESTIONS } from './fixtures/benchmark-questions.js';
import type { BenchmarkQuestion, BenchmarkCategory, QuestionEvaluationResult, BenchmarkAggregateResults } from './types.js';
import { retrievalService, type RetrievalChunk } from '../rag/retrieval-service.js';
import { InvestmentResearchAgent } from '../agent/research-agent.js';
import { PortfolioService } from '../portfolio/portfolio-service.js';
import { MarketService } from '../services/market-service.js';
import { ProviderRegistry } from '../providers/registry.js';
import { LruCache } from '../cache/cache.js';
import { SqliteCache } from '../cache/sqlite-cache.js';
import type { AgentContext } from '../agent/types.js';

interface EvalRunnerOptions {
  split?: 'eval_frozen' | 'dev_tuning' | 'all';
  limit?: number;
  concurrency?: number;
  verbose?: boolean;
}

const EVAL_STOP_WORDS = new Set([
  'a', 'about', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'did', 'do',
  'does', 'for', 'from', 'had', 'has', 'have', 'how', 'in', 'is', 'it',
  'its', 'me', 'much', 'of', 'on', 'or', 'tell', 'that', 'the', 'their',
  'this', 'to', 'was', 'were', 'what', 'when', 'where', 'which', 'who',
  'will', 'with', 'would',
]);

export function extractCitations(text: string): string[] {
  const matches = [...text.matchAll(/\[(SEC-[A-Za-z0-9_\-]+)\]/g)].map((m) => m[1]);
  const rawMatches = [...text.matchAll(/\b(SEC-[A-Z0-9]+-(?:10-K|10-Q)-\d{4}-\d{2}-\d{2}-[A-Za-z0-9_]+-c\d+)\b/g)].map((m) => m[1]);
  return Array.from(new Set([...matches, ...rawMatches]));
}

export function evaluateFactualClaims(
  answer: string,
  claims: string[],
  keywords: string[],
): number {
  if (claims.length === 0 && keywords.length === 0) return 1.0;

  const lower = answer.toLowerCase();
  let matchedClaims = 0;

  for (const claim of claims) {
    // Split on any non-alphanumeric, keeping words > 3 chars
    const words = claim
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3 && !EVAL_STOP_WORDS.has(w));

    if (words.length === 0) continue;
    // Word is matched if lower answer contains word or stem (slice 0, 5)
    const matches = words.filter((w) => {
      const stem = w.slice(0, Math.min(w.length, 5));
      return lower.includes(w) || (stem.length >= 4 && lower.includes(stem));
    });

    if (matches.length / words.length >= 0.4) {
      matchedClaims++;
    }
  }

  let matchedKw = 0;
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) matchedKw++;
  }

  const claimScore = claims.length > 0 ? matchedClaims / claims.length : 1.0;
  const kwScore = keywords.length > 0 ? matchedKw / Math.min(keywords.length, 4) : 1.0;

  return Math.min(1.0, Math.round((claimScore * 0.7 + Math.min(1.0, kwScore) * 0.3) * 100) / 100);
}

export function evaluateNumericalValues(
  answer: string,
  values?: { metric: string; value: number | string; tolerancePercent?: number }[],
): number {
  if (!values || values.length === 0) return 1.0;

  let matched = 0;
  for (const v of values) {
    if (typeof v.value === 'number') {
      // Look for the number or formatted versions (e.g. 109,842 or 109842 or 109.8B)
      const numStr = v.value.toString();
      const numWithCommas = v.value.toLocaleString('en-US');
      const inB = (v.value / 1000).toFixed(1); // e.g. in billions if value is in millions
      const inB2 = (v.value / 1000).toFixed(0);

      if (
        answer.includes(numStr) ||
        answer.includes(numWithCommas) ||
        answer.includes(`${inB}B`) ||
        answer.includes(`${inB} billion`) ||
        answer.includes(`${inB2}B`) ||
        answer.includes(`${inB2} billion`) ||
        answer.includes(`${v.value}%`) ||
        answer.includes(`${v.value} percent`)
      ) {
        matched++;
      } else {
        // Approximate tolerance regex
        const tol = (v.tolerancePercent ?? 5) / 100;
        const minVal = v.value * (1 - tol);
        const maxVal = v.value * (1 + tol);
        // Look for any number in the range
        const numRegex = /\$?\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\b%?/g;
        const matches = [...answer.matchAll(numRegex)].map((m) =>
          parseFloat(m[0].replace(/[$,%]/g, '')),
        );
        const inRange = matches.some((n) => n >= minVal && n <= maxVal);
        if (inRange) matched++;
      }
    } else {
      if (answer.toLowerCase().includes(v.value.toLowerCase())) {
        matched++;
      }
    }
  }

  return Math.round((matched / values.length) * 100) / 100;
}

export function evaluateAbstention(answer: string, expectAbstention: boolean): boolean {
  const lower = answer.toLowerCase();
  const abstentionKeywords = [
    'insufficient',
    'not disclosed',
    'not mentioned',
    'not provide',
    'does not disclose',
    'does not report',
    'not available',
    'cannot be verified',
    'no public disclosure',
    'insufficient_data',
    'no information',
    'unsupported',
    'unable to find',
  ];

  const hasAbstention = abstentionKeywords.some((kw) => lower.includes(kw));
  if (expectAbstention) {
    return hasAbstention;
  }
  return true;
}

export function evaluateCutoff(
  answer: string,
  cutoffDate?: string,
  citations: string[] = [],
): boolean {
  if (!cutoffDate) return true;

  // Check if any cited document post-dates cutoff
  for (const cite of citations) {
    const dateMatch = cite.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch && dateMatch[1] > cutoffDate) {
      return false; // Violation!
    }
  }

  const cutoffYear = parseInt(cutoffDate.split('-')[0], 10);
  const violationYear = cutoffYear + 1;
  const lower = answer.toLowerCase();

  // If asking about cutoff 2024, mentioning FY2025 or FY2026 results is a violation
  if (lower.includes(`fiscal ${violationYear}`) || lower.includes(`fy${violationYear}`) || lower.includes(`fy ${violationYear}`)) {
    if (lower.includes('revenue') || lower.includes('growth') || lower.includes('billion')) {
      return false;
    }
  }

  return true;
}

export async function verifyCitationsInDb(citationIds: string[]): Promise<{
  validCount: number;
  totalCount: number;
  faithfulnessScore: number;
}> {
  if (citationIds.length === 0) {
    return { validCount: 0, totalCount: 0, faithfulnessScore: 1.0 };
  }

  let valid = 0;
  for (const id of citationIds) {
    const chunk = await db.documentChunk.findUnique({ where: { id } });
    if (chunk) {
      valid++;
    } else {
      // Check if it matches a section ID without chunk number
      const section = await db.documentSection.findFirst({
        where: { id: { contains: id.replace(/^SEC-/, 'sec-') } },
      });
      if (section) valid++;
    }
  }

  return {
    validCount: valid,
    totalCount: citationIds.length,
    faithfulnessScore: Math.round((valid / citationIds.length) * 100) / 100,
  };
}

export async function evaluateRetrievalForQuestion(
  q: BenchmarkQuestion,
): Promise<{
  recallAt1: boolean;
  recallAt3: boolean;
  recallAt5: boolean;
  reciprocalRank: number;
  topChunkId?: string;
  chunksCount: number;
}> {
  const chunks = await retrievalService.search({
    symbol: q.symbols[0],
    query: q.question,
    endDate: q.historicalCutoff,
    limit: 5,
  });

  if (chunks.length === 0) {
    return {
      recallAt1: false,
      recallAt3: false,
      recallAt5: false,
      reciprocalRank: 0,
      chunksCount: 0,
    };
  }

  let matchedRank = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const matchesDoc = q.expectedDocuments.some(
      (ed) =>
        ed.symbol.toUpperCase() === c.symbol.toUpperCase() &&
        ed.form === c.form &&
        (!ed.reportPeriod || c.filingDate.startsWith(ed.reportPeriod.slice(0, 4))),
    );

    const matchesSection = q.expectedSections.some((es) => {
      const codeMatch = es.match(/item\s*([0-9a-z]+)/i);
      if (codeMatch && c.sectionCode.toLowerCase().includes(codeMatch[1].toLowerCase())) {
        return true;
      }
      return false;
    });

    const matchesKeywords = q.expectedPassageKeywords.some((kw) =>
      c.content.toLowerCase().includes(kw.toLowerCase()),
    );

    if ((matchesDoc && matchesSection) || matchesKeywords) {
      matchedRank = i + 1;
      break;
    }
  }

  return {
    recallAt1: matchedRank === 1,
    recallAt3: matchedRank > 0 && matchedRank <= 3,
    recallAt5: matchedRank > 0 && matchedRank <= 5,
    reciprocalRank: matchedRank > 0 ? 1 / matchedRank : 0,
    topChunkId: chunks[0]?.id,
    chunksCount: chunks.length,
  };
}

export class BenchmarkRunner {
  private v1Agent: InvestmentResearchAgent;
  private v2Agent: InvestmentResearchAgent;
  private portfolio: PortfolioService;
  private market: MarketService;

  constructor() {
    const baseUrl = process.env.AI_BASE_URL ?? 'https://ai.jarengjar.com/v1';
    const apiKey = process.env.AI_API_KEY ?? 'tm-mock-key';
    const model = process.env.AI_MODEL ?? 'combo1';

    this.v1Agent = new InvestmentResearchAgent(baseUrl, apiKey, model, console, { enableFinancialRag: false });
    this.v2Agent = new InvestmentResearchAgent(baseUrl, apiKey, model, console, { enableFinancialRag: true });

    this.portfolio = new PortfolioService(db);
    const providers = new ProviderRegistry();
    const cache = new LruCache(1000);
    const aiCache = new SqliteCache(db);
    this.market = new MarketService(providers, cache, { llm: null, keyword: null as any, mock: null as any }, aiCache);
  }

  private createAgentContext(): AgentContext {
    return {
      userId: 'eval-bench-user',
      lang: 'en',
      market: this.market,
      portfolio: this.portfolio,
    };
  }

  async runQuestion(
    q: BenchmarkQuestion,
    agentVersion: 'v1' | 'v2',
  ): Promise<QuestionEvaluationResult> {
    const agent = agentVersion === 'v1' ? this.v1Agent : this.v2Agent;
    const ctx = this.createAgentContext();
    const t0 = Date.now();

    let answer = '';
    let toolCalls: string[] = [];
    let success = true;

    try {
      const resp = await agent.research(q.question, q.symbols[0], 'en', ctx);
      answer = resp.answer;
      toolCalls = resp.toolSteps.map((s) => s.tool);
    } catch (err: any) {
      success = false;
      answer = `ERROR: ${err.message}`;
    }

    const durationMs = Date.now() - t0;
    const citations = extractCitations(answer);
    const citVerification = await verifyCitationsInDb(citations);

    const factualScore = evaluateFactualClaims(answer, q.requiredFactualClaims, q.expectedPassageKeywords);
    const numericalScore = evaluateNumericalValues(answer, q.requiredNumericalValues);
    const abstentionCorrect = evaluateAbstention(answer, q.expectAbstention);
    const cutoffCompliant = evaluateCutoff(answer, q.historicalCutoff, citations);

    const tokenEstimate = Math.ceil((q.question.length + answer.length) / 4);

    let retrievalInfo: QuestionEvaluationResult['retrieval'];
    if (agentVersion === 'v2') {
      const r = await evaluateRetrievalForQuestion(q);
      retrievalInfo = {
        chunksRetrieved: r.chunksCount,
        topChunkCitationId: r.topChunkId,
        recallAt3: r.recallAt3,
        recallAt5: r.recallAt5,
        reciprocalRank: r.reciprocalRank,
      };
    }

    return {
      questionId: q.id,
      category: q.category,
      agentVersion,
      success,
      answer,
      executionTimeMs: durationMs,
      toolCallCount: toolCalls.length,
      toolsUsed: toolCalls,
      tokenEstimate,
      retrieval: retrievalInfo,
      evaluation: {
        factualCorrectnessScore: factualScore,
        numericalCorrectnessScore: numericalScore,
        citationFaithfulnessScore: citVerification.faithfulnessScore,
        unsupportedClaimRate: Math.max(0, 1.0 - factualScore),
        historicalCutoffCompliant: cutoffCompliant,
        abstentionCorrect,
        reasoningNotes: `Citations: ${citations.length} found (${citVerification.validCount} valid). Tools: ${toolCalls.join(', ')}`,
      },
    };
  }

  async runBenchmark(options: EvalRunnerOptions = {}): Promise<{
    v1Results: QuestionEvaluationResult[];
    v2Results: QuestionEvaluationResult[];
    aggregateV1: BenchmarkAggregateResults;
    aggregateV2: BenchmarkAggregateResults;
    retrievalAggregates: { recallAt1: number; recallAt3: number; recallAt5: number; mrr: number };
  }> {
    const splitFilter = options.split ?? 'all';
    let questions = BENCHMARK_QUESTIONS;

    if (splitFilter !== 'all') {
      questions = questions.filter((q) => q.split === splitFilter);
    }
    if (options.limit && options.limit > 0) {
      questions = questions.slice(0, options.limit);
    }

    console.log(`[Benchmark] Starting evaluation on ${questions.length} questions (split: ${splitFilter})...`);

    // First evaluate retrieval metrics for all questions
    console.log('[Benchmark] Computing pure retrieval metrics across questions...');
    let r1Count = 0;
    let r3Count = 0;
    let r5Count = 0;
    let totalMrr = 0;

    for (const q of questions) {
      const r = await evaluateRetrievalForQuestion(q);
      if (r.recallAt1) r1Count++;
      if (r.recallAt3) r3Count++;
      if (r.recallAt5) r5Count++;
      totalMrr += r.reciprocalRank;
    }

    const retrievalAggregates = {
      recallAt1: Math.round((r1Count / questions.length) * 100) / 100,
      recallAt3: Math.round((r3Count / questions.length) * 100) / 100,
      recallAt5: Math.round((r5Count / questions.length) * 100) / 100,
      mrr: Math.round((totalMrr / questions.length) * 100) / 100,
    };

    console.log('[Benchmark] Retrieval Metrics:', retrievalAggregates);

    const v1Results: QuestionEvaluationResult[] = [];
    const v2Results: QuestionEvaluationResult[] = [];

    // Run evaluations sequentially or with limited concurrency to avoid API congestion
    const concurrency = options.concurrency ?? 2;
    for (let i = 0; i < questions.length; i += concurrency) {
      const batch = questions.slice(i, i + concurrency);
      console.log(`[Benchmark] Running batch ${Math.floor(i / concurrency) + 1}/${Math.ceil(questions.length / concurrency)} (${batch.map((b) => b.id).join(', ')})...`);

      const batchPromises = batch.map(async (q) => {
        // Paired evaluation: run V1 then V2 on the same question
        const v1 = await this.runQuestion(q, 'v1');
        const v2 = await this.runQuestion(q, 'v2');
        return { v1, v2 };
      });

      const batchOut = await Promise.all(batchPromises);
      for (const item of batchOut) {
        v1Results.push(item.v1);
        v2Results.push(item.v2);
        if (options.verbose) {
          console.log(`  [${item.v1.questionId}] V1 Factual: ${item.v1.evaluation.factualCorrectnessScore}, Tools: [${item.v1.toolsUsed.join(', ')}]`);
          console.log(`  [${item.v2.questionId}] V2 Factual: ${item.v2.evaluation.factualCorrectnessScore}, Citations: ${item.v2.evaluation.citationFaithfulnessScore}, Tools: [${item.v2.toolsUsed.join(', ')}]`);
        }
      }
    }

    const computeAggregate = (results: QuestionEvaluationResult[], version: 'v1' | 'v2'): BenchmarkAggregateResults => {
      const categories = Array.from(new Set(results.map((r) => r.category))) as BenchmarkCategory[];
      const byCategory: any = {};

      for (const cat of categories) {
        const catRes = results.filter((r) => r.category === cat);
        const count = catRes.length;
        const avgFactual = catRes.reduce((acc, r) => acc + r.evaluation.factualCorrectnessScore, 0) / count;
        const avgCit = catRes.reduce((acc, r) => acc + r.evaluation.citationFaithfulnessScore, 0) / count;
        const avgLatency = catRes.reduce((acc, r) => acc + r.executionTimeMs, 0) / count;
        const avgTools = catRes.reduce((acc, r) => acc + r.toolCallCount, 0) / count;
        const abstentionAcc = catRes.reduce((acc, r) => acc + (r.evaluation.abstentionCorrect ? 1 : 0), 0) / count;
        const cutoffComp = catRes.reduce((acc, r) => acc + (r.evaluation.historicalCutoffCompliant ? 1 : 0), 0) / count;

        byCategory[cat] = {
          count,
          avgFactualScore: Math.round(avgFactual * 100) / 100,
          avgCitationFaithfulness: Math.round(avgCit * 100) / 100,
          avgLatencyMs: Math.round(avgLatency),
          avgToolCalls: Math.round(avgTools * 10) / 10,
          abstentionAccuracy: Math.round(abstentionAcc * 100) / 100,
          cutoffCompliance: Math.round(cutoffComp * 100) / 100,
        };
      }

      const total = results.length;
      const avgFactual = results.reduce((acc, r) => acc + r.evaluation.factualCorrectnessScore, 0) / total;
      const avgCit = results.reduce((acc, r) => acc + r.evaluation.citationFaithfulnessScore, 0) / total;
      const avgUnsup = results.reduce((acc, r) => acc + r.evaluation.unsupportedClaimRate, 0) / total;
      const cutoffComp = results.reduce((acc, r) => acc + (r.evaluation.historicalCutoffCompliant ? 1 : 0), 0) / total;
      const abstentionAcc = results.reduce((acc, r) => acc + (r.evaluation.abstentionCorrect ? 1 : 0), 0) / total;

      const latencies = results.map((r) => r.executionTimeMs).sort((a, b) => a - b);
      const meanLatency = latencies.reduce((a, b) => a + b, 0) / total;
      const p50 = latencies[Math.floor(total * 0.5)] ?? 0;
      const p90 = latencies[Math.floor(total * 0.9)] ?? 0;
      const avgTools = results.reduce((acc, r) => acc + r.toolCallCount, 0) / total;
      const totalTokens = results.reduce((acc, r) => acc + r.tokenEstimate, 0);

      return {
        agentVersion: version,
        totalQuestions: total,
        byCategory,
        overall: {
          retrievalRecallAt3: version === 'v2' ? retrievalAggregates.recallAt3 : undefined,
          retrievalRecallAt5: version === 'v2' ? retrievalAggregates.recallAt5 : undefined,
          mrr: version === 'v2' ? retrievalAggregates.mrr : undefined,
          avgFactualCorrectness: Math.round(avgFactual * 100) / 100,
          avgCitationFaithfulness: Math.round(avgCit * 100) / 100,
          avgUnsupportedClaimRate: Math.round(avgUnsup * 100) / 100,
          historicalCutoffComplianceRate: Math.round(cutoffComp * 100) / 100,
          appropriateAbstentionRate: Math.round(abstentionAcc * 100) / 100,
          abstentionAccuracyRate: Math.round(abstentionAcc * 100) / 100,
          avgLatencyMs: Math.round(meanLatency),
          p50LatencyMs: Math.round(p50),
          p90LatencyMs: Math.round(p90),
          avgToolCalls: Math.round(avgTools * 10) / 10,
          avgToolCallsPerQuery: Math.round(avgTools * 10) / 10,
          avgTokens: Math.round(totalTokens / total),
          totalTokensConsumed: totalTokens,
        },
      };
    };

    const aggregateV1 = computeAggregate(v1Results, 'v1');
    const aggregateV2 = computeAggregate(v2Results, 'v2');

    // Persist results to disk
    const outDir = path.resolve(process.cwd().endsWith('server') ? process.cwd() : path.resolve(process.cwd(), 'server'), 'src/eval/results');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const outputPath = path.join(outDir, 'benchmark-results.json');
    fs.writeFileSync(
      outputPath,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          retrievalAggregates,
          aggregateV1,
          aggregateV2,
          v1Results,
          v2Results,
        },
        null,
        2,
      ),
      'utf8',
    );
    console.log(`[Benchmark] Results saved to ${outputPath}`);

    return {
      v1Results,
      v2Results,
      aggregateV1,
      aggregateV2,
      retrievalAggregates,
    };
  }
}

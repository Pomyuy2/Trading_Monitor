import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { db } from '../store/db.js';
import { BENCHMARK_QUESTIONS } from './fixtures/benchmark-questions.js';
import { V22_DEEP_RESEARCH_SCENARIOS } from './fixtures/v22-deep-research-scenarios.js';
import type {
  BenchmarkQuestion,
  BenchmarkCategory,
  QuestionEvaluationResult,
  BenchmarkAggregateResults,
} from './types.js';
import { retrievalService } from '../rag/retrieval-service.js';
import { InvestmentResearchAgent } from '../agent/research-agent.js';
import { PortfolioService } from '../portfolio/portfolio-service.js';
import { MarketService } from '../services/market-service.js';
import { ProviderRegistry } from '../providers/registry.js';
import { LruCache } from '../cache/cache.js';
import { SqliteCache } from '../cache/sqlite-cache.js';
import type { AgentContext } from '../agent/types.js';

export interface EvalRunnerOptions {
  split?: 'eval_frozen' | 'dev_tuning' | 'all';
  limit?: number;
  concurrency?: number;
  verbose?: boolean;
  deepOnly?: boolean;
  includeDeepScenarios?: boolean;
  compareMode?: 'v1_v2' | 'v21_v22';
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
  const rawMatches = [
    ...text.matchAll(/\b(SEC-[A-Z0-9]+-(?:10-K|10-Q|8-K)-\d{4}-\d{2}-\d{2}-[A-Za-z0-9_]+-c\d+)\b/g),
  ].map((m) => m[1]);
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
    const words = claim
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3 && !EVAL_STOP_WORDS.has(w));

    if (words.length === 0) continue;
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
      const numStr = v.value.toString();
      const numWithCommas = v.value.toLocaleString('en-US');
      const inB = (v.value / 1000).toFixed(1);
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
        const tol = (v.tolerancePercent ?? 5) / 100;
        const minVal = v.value * (1 - tol);
        const maxVal = v.value * (1 + tol);
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
    'private entity',
    'non-public',
    'does not file',
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

  for (const cite of citations) {
    const dateMatch = cite.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch && dateMatch[1] > cutoffDate) {
      return false;
    }
  }

  const cutoffYear = parseInt(cutoffDate.split('-')[0], 10);
  const violationYear = cutoffYear + 1;
  const lower = answer.toLowerCase();

  if (
    lower.includes(`fiscal ${violationYear}`) ||
    lower.includes(`fy${violationYear}`) ||
    lower.includes(`fy ${violationYear}`)
  ) {
    if (lower.includes('revenue') || lower.includes('growth') || lower.includes('billion') || lower.includes('reported')) {
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
  if (q.symbols.length === 0 || q.expectedDocuments.length === 0) {
    return {
      recallAt1: true,
      recallAt3: true,
      recallAt5: true,
      reciprocalRank: 1,
      chunksCount: 0,
    };
  }

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
  private v21Agent: InvestmentResearchAgent;
  private v22Agent: InvestmentResearchAgent;
  private portfolio: PortfolioService;
  private market: MarketService;

  constructor() {
    const baseUrl = process.env.AI_BASE_URL ?? 'https://ai.jarengjar.com/v1';
    const apiKey = process.env.AI_API_KEY ?? 'tm-mock-key';
    const model = process.env.AI_MODEL ?? 'combo1';

    this.v1Agent = new InvestmentResearchAgent(baseUrl, apiKey, model, console, {
      enableFinancialRag: false,
      agentVersion: 'v1',
    });
    this.v21Agent = new InvestmentResearchAgent(baseUrl, apiKey, model, console, {
      enableFinancialRag: true,
      agentVersion: 'v2.1',
      enablePlanning: false,
      enableVerification: false,
    });
    this.v22Agent = new InvestmentResearchAgent(baseUrl, apiKey, model, console, {
      enableFinancialRag: true,
      agentVersion: 'v2.2',
      enablePlanning: true,
      enableVerification: true,
    });

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
    agentVersion: 'v1' | 'v2' | 'v2.1' | 'v2.2',
  ): Promise<QuestionEvaluationResult> {
    let agent: InvestmentResearchAgent;
    if (agentVersion === 'v1') agent = this.v1Agent;
    else if (agentVersion === 'v2.1') agent = this.v21Agent;
    else agent = this.v22Agent;

    const ctx = this.createAgentContext();
    const t0 = Date.now();

    let answer = '';
    let toolCalls: string[] = [];
    let success = true;
    let planData: any;
    let verificationData: any;

    try {
      const resp = await agent.research(q.question, q.symbols[0], 'en', ctx);
      answer = resp.answer;
      toolCalls = resp.toolSteps.map((s) => s.tool);
      planData = resp.plan;
      verificationData = resp.verification;
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

    const lowerAns = answer.toLowerCase();
    const contradictionDetected =
      verificationData?.contradictions?.length > 0 ||
      lowerAns.includes('opposing evidence') ||
      lowerAns.includes('contradict') ||
      lowerAns.includes('conflict');

    const tokenEstimate = Math.ceil((q.question.length + answer.length) / 4);

    let retrievalInfo: QuestionEvaluationResult['retrieval'];
    if (agentVersion !== 'v1') {
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
      plan: planData,
      verification: verificationData,
      evaluation: {
        factualCorrectnessScore: factualScore,
        numericalCorrectnessScore: numericalScore,
        citationFaithfulnessScore: citVerification.faithfulnessScore,
        unsupportedClaimRate: Math.max(0, 1.0 - factualScore),
        historicalCutoffCompliant: cutoffCompliant,
        abstentionCorrect,
        contradictionDetected,
        reasoningNotes: `Citations: ${citations.length} found (${citVerification.validCount} valid). Tools: ${toolCalls.join(', ')}`,
      },
    };
  }

  async runBenchmark(options: EvalRunnerOptions = {}): Promise<{
    baselineResults: QuestionEvaluationResult[];
    targetResults: QuestionEvaluationResult[];
    aggregateBaseline: BenchmarkAggregateResults;
    aggregateTarget: BenchmarkAggregateResults;
    retrievalAggregates: { recallAt1: number; recallAt3: number; recallAt5: number; mrr: number };
  }> {
    const compareMode = options.compareMode ?? 'v21_v22';
    const baseVersion = compareMode === 'v1_v2' ? 'v1' : 'v2.1';
    const targetVersion = 'v2.2';

    let questions: BenchmarkQuestion[] = [];
    if (options.deepOnly) {
      questions = [...V22_DEEP_RESEARCH_SCENARIOS];
    } else if (options.includeDeepScenarios) {
      questions = [...BENCHMARK_QUESTIONS, ...V22_DEEP_RESEARCH_SCENARIOS];
    } else {
      questions = [...BENCHMARK_QUESTIONS];
    }

    const splitFilter = options.split ?? 'all';
    if (splitFilter !== 'all') {
      questions = questions.filter((q) => q.split === splitFilter);
    }
    if (options.limit && options.limit > 0) {
      questions = questions.slice(0, options.limit);
    }

    console.log(
      `[Benchmark] Running ${compareMode} evaluation on ${questions.length} questions (split: ${splitFilter}, deepOnly: ${Boolean(options.deepOnly)})...`,
    );

    // Compute retrieval metrics
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

    const baselineResults: QuestionEvaluationResult[] = [];
    const targetResults: QuestionEvaluationResult[] = [];

    const concurrency = options.concurrency ?? 2;
    for (let i = 0; i < questions.length; i += concurrency) {
      const batch = questions.slice(i, i + concurrency);
      console.log(
        `[Benchmark] Running batch ${Math.floor(i / concurrency) + 1}/${Math.ceil(questions.length / concurrency)} (${batch.map((b) => b.id).join(', ')})...`,
      );

      const batchPromises = batch.map(async (q) => {
        const base = await this.runQuestion(q, baseVersion);
        const tgt = await this.runQuestion(q, targetVersion);
        return { base, tgt };
      });

      const batchOut = await Promise.all(batchPromises);
      for (const item of batchOut) {
        baselineResults.push(item.base);
        targetResults.push(item.tgt);
        if (options.verbose) {
          console.log(`  [${item.base.questionId}] ${baseVersion} Factual: ${item.base.evaluation.factualCorrectnessScore}, Tools: [${item.base.toolsUsed.join(', ')}]`);
          console.log(`  [${item.tgt.questionId}] ${targetVersion} Factual: ${item.tgt.evaluation.factualCorrectnessScore}, Citations: ${item.tgt.evaluation.citationFaithfulnessScore}, Tools: [${item.tgt.toolsUsed.join(', ')}]`);
        }
      }
    }

    const computeAggregate = (
      results: QuestionEvaluationResult[],
      version: 'v1' | 'v2' | 'v2.1' | 'v2.2',
    ): BenchmarkAggregateResults => {
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
          retrievalRecallAt3: version !== 'v1' ? retrievalAggregates.recallAt3 : undefined,
          retrievalRecallAt5: version !== 'v1' ? retrievalAggregates.recallAt5 : undefined,
          mrr: version !== 'v1' ? retrievalAggregates.mrr : undefined,
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

    const aggregateBaseline = computeAggregate(baselineResults, baseVersion);
    const aggregateTarget = computeAggregate(targetResults, targetVersion);

    // Save results to disk
    const outDir = path.resolve(
      process.cwd().endsWith('server') ? process.cwd() : path.resolve(process.cwd(), 'server'),
      'src/eval/results',
    );
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const outputPath = path.join(outDir, 'v22-benchmark-results.json');
    fs.writeFileSync(
      outputPath,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          compareMode,
          retrievalAggregates,
          aggregateBaseline,
          aggregateTarget,
          baselineResults,
          targetResults,
        },
        null,
        2,
      ),
      'utf8',
    );
    console.log(`[Benchmark] Results saved to ${outputPath}`);

    return {
      baselineResults,
      targetResults,
      aggregateBaseline,
      aggregateTarget,
      retrievalAggregates,
    };
  }
}

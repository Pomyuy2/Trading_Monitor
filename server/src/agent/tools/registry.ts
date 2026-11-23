import { z } from 'zod/v4';
import type { AgentContext, ToolDefinition, ToolResult } from '../types.js';
import {
  getCandlesTool,
  getCompanyFactsTool,
  getCompanyInsightTool,
  getCompanyProfileTool,
  getNewsTool,
  getQuoteTool,
} from './market-tools.js';
import {
  analyzeStockRiskTool,
  calculateFinancialRatiosTool,
  calculateIndicatorsTool,
  calculateValuationTool,
  compareStocksTool,
} from './analytics-tools.js';
import {
  getPortfolioAnalysisTool,
  getUserPortfoliosTool,
} from './portfolio-tools.js';
import {
  searchFinancialDocumentsTool,
  getDocumentSectionTool,
  ensureFinancialDocumentCoverageTool,
} from './document-tools.js';

export interface OpenAiFunctionDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolRegistryOptions {
  enableFinancialRag?: boolean;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(options: ToolRegistryOptions = {}) {
    this.register(getQuoteTool);
    this.register(getCandlesTool);
    this.register(getCompanyProfileTool);
    this.register(getCompanyFactsTool);
    this.register(getCompanyInsightTool);
    this.register(getNewsTool);
    this.register(calculateIndicatorsTool);
    this.register(calculateFinancialRatiosTool);
    this.register(calculateValuationTool);
    this.register(analyzeStockRiskTool);
    this.register(compareStocksTool);
    this.register(getUserPortfoliosTool);
    this.register(getPortfolioAnalysisTool);

    const enableRag = options.enableFinancialRag ?? (process.env.FINANCIAL_RAG_ENABLED !== 'false');
    if (enableRag) {
      this.register(searchFinancialDocumentsTool);
      this.register(getDocumentSectionTool);
      this.register(ensureFinancialDocumentCoverageTool);
    }
  }

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Generates OpenAI-compatible function calling schemas using zod.toJSONSchema.
   */
  getOpenAiToolDefinitions(): OpenAiFunctionDefinition[] {
    return this.list().map((tool) => {
      let schema: Record<string, unknown> = {};
      try {
        schema = z.toJSONSchema(tool.parameters) as Record<string, unknown>;
      } catch {
        schema = { type: 'object', properties: {} };
      }

      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: schema,
        },
      };
    });
  }

  /**
   * Executes a tool by name with strict Zod validation, error isolation, and timeout guard.
   */
  async execute(name: string, rawArgs: unknown, ctx: AgentContext, timeoutMs = 15_000): Promise<ToolResult> {
    const tool = this.get(name);
    if (!tool) {
      return {
        success: false,
        error: `Unknown tool "${name}". Available tools: ${Array.from(this.tools.keys()).join(', ')}`,
        provenance: { source: 'ToolRegistry', updatedAt: new Date().toISOString() },
      };
    }

    // 1. Validate arguments with Zod
    const parsed = tool.parameters.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const errorMsg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return {
        success: false,
        error: `Invalid arguments for ${name}: ${errorMsg}`,
        provenance: { source: 'ToolRegistry', updatedAt: new Date().toISOString() },
      };
    }

    // 2. Execute with timeout
    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Tool ${name} timed out after ${timeoutMs}ms`)), timeoutMs),
      );
      return await Promise.race([tool.execute(parsed.data, ctx), timeoutPromise]);
    } catch (err) {
      return {
        success: false,
        error: (err as Error).message || 'Execution error',
        provenance: {
          source: 'ToolRegistry',
          updatedAt: new Date().toISOString(),
          warnings: [`Tool execution failed: ${(err as Error).message}`],
        },
      };
    }
  }
}

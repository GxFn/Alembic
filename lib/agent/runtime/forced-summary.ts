import type { RuntimeAiProvider, ToolCallEntry } from "./AgentRuntimeTypes.js";
import { cleanFinalAnswer } from "./final-answer.js";
import type { LoopContext } from "./LoopContext.js";
import { formatToolCallHistory } from "./MessageAdapter.js";

export interface ForcedSummaryOptions {
  readonly aiProvider?: RuntimeAiProvider | null;
  readonly systemPrompt?: string;
  readonly reason?: string;
  readonly maxTokens?: number;
}

export async function produceForcedSummary(
  ctx: LoopContext,
  options: ForcedSummaryOptions = {},
): Promise<string> {
  const mode = detectSummaryMode(ctx);
  const synthetic = buildSyntheticSummary(ctx, options.reason);
  const provider = options.aiProvider ?? null;
  if (!provider || isCircuitOpen(provider)) {
    return synthetic;
  }
  try {
    const prompt = buildSummaryPrompt(ctx, mode);
    const result = await provider.chatWithTools(prompt.prompt, {
      messages: [],
      toolChoice: "none",
      maxTokens: options.maxTokens ?? (mode.kind === "digest" ? 8192 : 2400),
      temperature: mode.kind === "digest" ? 0.3 : 0.5,
      abortSignal: ctx.abortSignal,
      systemPrompt: options.systemPrompt ?? prompt.systemPrompt,
    });
    if (result?.usage) {
      ctx.addTokenUsage(result.usage);
    }
    // 中文注释：bootstrap digest 需要保留 JSON 原样，不能用终答清理器剥掉结构。
    const text =
      mode.kind === "digest" ? (result?.text ?? "").trim() : cleanFinalAnswer(result?.text ?? "");
    return text || synthetic;
  } catch (error) {
    ctx.diagnostics?.recordAiError(
      `forced summary failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return synthetic;
  }
}

export function buildSyntheticSummary(ctx: LoopContext, reason?: string): string {
  const mode = detectSummaryMode(ctx);
  if (mode.kind === "digest") {
    return buildSyntheticDigest(ctx, reason);
  }
  if (mode.kind === "analyst") {
    return buildSyntheticAnalystReport(ctx, reason);
  }
  const lines = [
    "运行已停止，下面是基于已完成工具调用生成的强制总结。",
    reason ? `停止原因: ${reason}` : null,
    `迭代轮次: ${ctx.iteration}`,
    `工具调用数: ${ctx.toolCalls.length}`,
    "",
    formatToolCallHistory(ctx.toolCalls),
  ].filter(Boolean);
  return lines.join("\n");
}

interface SummaryMode {
  readonly kind: "digest" | "analyst" | "user";
  readonly pipelineType: string;
}

function detectSummaryMode(ctx: LoopContext): SummaryMode {
  const isSystem = ctx.source === "system";
  const pipelineType =
    stringValue(recordValue(ctx.tracker, "pipelineType")) ??
    stringValue(ctx.context.pipelineType) ??
    (isSystem ? "bootstrap" : "user");
  if (isSystem && pipelineType === "analyst") {
    return { kind: "analyst", pipelineType };
  }
  if (isSystem) {
    return { kind: "digest", pipelineType };
  }
  return { kind: "user", pipelineType };
}

function buildSummaryPrompt(
  ctx: LoopContext,
  mode: SummaryMode,
): { readonly prompt: string; readonly systemPrompt: string } {
  const toolContext = buildToolContext(ctx.toolCalls);
  if (mode.kind === "analyst") {
    return {
      prompt: [
        `你刚才通过 ${ctx.toolCalls.length} 次工具调用分析了项目代码。`,
        "请基于以下工具上下文，用清晰 Markdown 输出代码分析报告。",
        "",
        toolContext,
        "",
        "要求：包含具体文件路径、类名、模式名称；每个关键发现都要给出证据；末尾列出待探索事项。",
      ].join("\n"),
      systemPrompt:
        "你是项目代码分析专家。只输出 Markdown 分析报告，不要输出 JSON，不要继续调用工具。",
    };
  }
  if (mode.kind === "digest") {
    const candidateCount = countKnowledgeSubmits(ctx.toolCalls);
    return {
      prompt: [
        `你已完成 ${ctx.iteration} 轮工具调用（共 ${ctx.toolCalls.length} 次），提交了 ${candidateCount} 个候选。`,
        "必须输出 dimensionDigest JSON，并用 ```json 包裹：",
        "```json",
        JSON.stringify(
          {
            dimensionDigest: {
              summary: "本维度分析总结",
              candidateCount,
              keyFindings: ["发现1", "发现2"],
              crossRefs: {},
              gaps: ["未覆盖方面"],
              remainingTasks: [
                {
                  signal: "未处理信号名",
                  reason: "达到提交上限/时间限制",
                  priority: "high",
                  searchHints: ["搜索词"],
                },
              ],
            },
          },
          null,
          2,
        ),
        "```",
        "",
        toolContext,
      ].join("\n"),
      systemPrompt: "直接输出 dimensionDigest JSON 总结，不要调用工具。",
    };
  }
  return {
    prompt: [
      ctx.prompt ? `用户的原始问题：「${ctx.prompt.slice(0, 500)}」` : "",
      `你刚才通过 ${ctx.toolCalls.length} 次工具调用分析了项目代码。`,
      "请基于以下工具上下文，用清晰 Markdown 直接回答用户问题。",
      "",
      toolContext,
    ]
      .filter(Boolean)
      .join("\n"),
    systemPrompt:
      "你是项目分析助手。只输出人类可读的 Markdown 总结，不要输出 JSON，不要继续调用工具。",
  };
}

function buildSyntheticDigest(ctx: LoopContext, reason?: string): string {
  const candidateCount = countKnowledgeSubmits(ctx.toolCalls);
  const titles = ctx.toolCalls
    .filter((entry) => entry.tool === "knowledge.submit")
    .map((entry) => stringValue(entry.args.title) ?? stringValue(entry.args.category) ?? "untitled")
    .slice(0, 8);
  return [
    "```json",
    JSON.stringify(
      {
        dimensionDigest: {
          summary: `通过 ${ctx.toolCalls.length} 次工具调用分析了项目代码，提交了 ${candidateCount} 个候选。`,
          candidateCount,
          keyFindings: titles,
          crossRefs: {},
          gaps: reason ? [reason] : ["运行提前停止，部分分析未完成"],
          remainingTasks: [],
        },
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

function buildSyntheticAnalystReport(ctx: LoopContext, reason?: string): string {
  const toolNames = [...new Set(ctx.toolCalls.map((entry) => entry.tool))];
  return [
    "## 代码分析报告",
    "",
    `通过 **${ctx.toolCalls.length} 次工具调用**（${ctx.iteration} 轮迭代）探索了项目代码。`,
    reason ? `停止原因：${reason}` : null,
    "",
    "### 使用的工具",
    toolNames.length ? toolNames.map((tool) => `- ${tool}`).join("\n") : "- 无",
    "",
    "### 工具调用摘要",
    formatToolCallHistory(ctx.toolCalls),
  ]
    .filter(Boolean)
    .join("\n");
}

function buildToolContext(toolCalls: readonly ToolCallEntry[]): string {
  const searchQueries = toolCalls
    .filter((entry) => entry.tool === "code.search")
    .map((entry) => stringValue(entry.args.pattern) ?? stringValue(entry.args.query))
    .filter((value): value is string => !!value)
    .slice(0, 8);
  const readFiles = toolCalls
    .filter((entry) => entry.tool === "code.read")
    .map((entry) => stringValue(entry.args.path))
    .filter((value): value is string => !!value)
    .slice(0, 12);
  const sections = [
    searchQueries.length
      ? `**代码搜索**: ${searchQueries.map((query) => `\`${query}\``).join(", ")}`
      : null,
    readFiles.length ? `**文件读取**: ${readFiles.map((path) => `\`${path}\``).join(", ")}` : null,
    "",
    formatToolCallHistory(toolCalls),
  ].filter(Boolean);
  return sections.join("\n");
}

function countKnowledgeSubmits(toolCalls: readonly ToolCallEntry[]): number {
  return toolCalls.filter((entry) => entry.tool === "knowledge.submit").length;
}

function isCircuitOpen(provider: RuntimeAiProvider): boolean {
  const state = provider._circuitState?.toLowerCase();
  return state === "open" || provider.name === "mock";
}

function recordValue(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

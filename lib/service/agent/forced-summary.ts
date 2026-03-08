/**
 * forced-summary.js — 强制退出后的摘要生成
 *
 * 强制退出后的摘要生成独立模块，
 * 供 AgentRuntime.reactLoop() 在循环退出后调用。
 *
 * 支持三种模式 (根据 source + tracker.pipelineType 判断):
 *   - system + analyst: 输出 Markdown 分析报告 (供 Quality Gate 评估)
 *   - system + bootstrap: 输出 dimensionDigest JSON (供维度编排消费)
 *   - user: 输出人类可读的 Markdown 结构化总结 (前端 AI Chat 展示)
 *
 * @module forced-summary
 */

import type { AiProvider } from '../../external/ai/AiProvider.js';
import Logger from '../../infrastructure/logging/Logger.js';
import { cleanFinalAnswer } from './core/ChatAgentPrompts.js';

/* ── Local types ────────────────────────────────────────── */

/** Known tool-call argument fields accessed in this module */
interface ToolCallArgs {
  title?: string;
  category?: string;
  filePath?: string;
  filePaths?: string[];
  patterns?: string[];
  query?: string;
  pattern?: string;
  className?: string;
  name?: string;
  protocolName?: string;
  rootClass?: string;
  directory?: string;
  [key: string]: unknown;
}

/** A recorded tool invocation */
interface ToolCallRecord {
  tool: string;
  args?: ToolCallArgs;
  params?: ToolCallArgs;
  result?: unknown;
  durationMs?: number;
  name?: string;
}

/** chatWithTools result (providers may attach usage) */
interface ChatWithToolsResult {
  text: string | null;
  functionCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }> | null;
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** Token usage accumulator */
interface TokenUsage {
  input: number;
  output: number;
}

/** Options for {@link produceForcedSummary} */
interface ForcedSummaryOpts {
  aiProvider: AiProvider;
  source?: string;
  toolCalls?: ToolCallRecord[];
  tracker?: { iteration?: number; pipelineType?: string };
  contextWindow?: unknown;
  prompt: string;
  tokenUsage?: TokenUsage;
}

const logger = Logger.getInstance();

/**
 * 生成强制摘要
 *
 * @param {Object} opts
 * @param {import('../../external/ai/AiProvider.js').AiProvider} opts.aiProvider - LLM 提供商
 * @param {string} [opts.source] - 'user' | 'system'
 * @param {Array} opts.toolCalls 工具调用记录
 * @param {Object} [opts.tracker] - ExplorationTracker 实例
 * @param {Object} [opts.contextWindow] - ContextWindow 实例 (用于避免超出 token)
 * @param {string} opts.prompt 原始用户 prompt
 * @param {Object} [opts.tokenUsage] - token 用量 (会被修改)
 * @returns {Promise<{ reply: string, tokenUsage: { input: number, output: number } }>}
 */
export async function produceForcedSummary({
  aiProvider,
  source,
  toolCalls = [],
  tracker,
  contextWindow,
  prompt,
  tokenUsage,
}: ForcedSummaryOpts) {
  const isSystem = source === 'system';
  const iterations = tracker?.iteration || 0;
  const pipelineType = tracker?.pipelineType || (isSystem ? 'bootstrap' : 'user');
  // Analyst 管线虽然 source='system'，但期望 Markdown 分析报告而非 dimensionDigest JSON
  const isAnalyst = pipelineType === 'analyst';
  const resultTokenUsage = { input: 0, output: 0 };

  logger.info(
    `[ForcedSummary] ⚠ producing forced summary (${iterations} iters, ${toolCalls.length} calls, source=${source}, pipeline=${pipelineType})`
  );

  const candidateCount = toolCalls.filter(
    (tc: ToolCallRecord) => tc.tool === 'submit_knowledge' || tc.tool === 'submit_with_check'
  ).length;

  let finalReply: string | undefined;

  // 如果熔断器已打开，跳过 AI 调用直接合成摘要
  const isCircuitOpen = aiProvider._circuitState === 'OPEN';
  if (isCircuitOpen) {
    const outputType = isAnalyst ? 'analysis' : isSystem ? 'digest' : 'summary';
    logger.warn(
      `[ForcedSummary] circuit breaker is OPEN — skipping AI summary, using synthetic ${outputType}`
    );
  }

  // 收集工具调用摘要
  const submitSummary = toolCalls
    .filter(
      (tc: ToolCallRecord) => tc.tool === 'submit_knowledge' || tc.tool === 'submit_with_check'
    )
    .map(
      (tc: ToolCallRecord, i: number) =>
        `${i + 1}. ${tc.args?.title || tc.args?.category || tc.params?.title || tc.params?.category || 'untitled'}`
    )
    .join('\n');

  try {
    if (isCircuitOpen) {
      throw new Error('circuit open — skip to synthetic summary');
    }

    let summaryPrompt: string;
    let systemPrompt: string;

    if (isSystem && isAnalyst) {
      // Analyst 管线 (source=system): Markdown 分析报告 — 与 NudgeGenerator.buildTransitionNudge 对齐
      const toolContextSummary = buildToolContextForUserSummary(toolCalls);
      summaryPrompt = `你刚才通过 ${toolCalls.length} 次工具调用分析了项目代码。以下是你调用过的工具和获取到的关键信息：

${toolContextSummary}

请基于以上收集到的信息，用**清晰易读的 Markdown** 格式撰写代码分析报告。

要求：
- 使用二级/三级标题组织内容（## 和 ###）
- 包含具体的代码文件路径、类名、模式名称等细节
- 每个关键发现都要给出证据（文件路径 + 代码片段或行为描述）
- 至少涵盖 3 个核心发现
- 如有未覆盖的方面，在末尾用「## 待探索」章节列出`;
      systemPrompt =
        '你是项目代码分析专家。请用纯 Markdown 格式输出结构清晰的分析报告，包含具体文件路径和代码模式。不要输出 JSON 格式。';
    } else if (isSystem) {
      // Bootstrap 管线 (source=system): dimensionDigest JSON
      summaryPrompt = `你已完成 ${iterations} 轮工具调用（共 ${toolCalls.length} 次），提交了 ${candidateCount} 个候选。
${submitSummary ? `已提交候选:\n${submitSummary}\n` : ''}
**必须**输出 dimensionDigest JSON（用 \`\`\`json 包裹）：
\`\`\`json
{
  "dimensionDigest": {
    "summary": "本维度分析总结",
    "candidateCount": ${candidateCount},
    "keyFindings": ["发现1", "发现2"],
    "crossRefs": {},
    "gaps": ["未覆盖方面"],
    "remainingTasks": [
      { "signal": "未处理信号名", "reason": "达到提交上限/时间限制", "priority": "high", "searchHints": ["搜索词"] }
    ]
  }
}
\`\`\`
> remainingTasks: 列出本次未来得及处理的信号/主题。已全部覆盖则留空 \`[]\`。`;
      systemPrompt = '直接输出 dimensionDigest JSON 总结，不要调用工具。';
    } else {
      // user 源: Markdown 结构化总结
      const userQuestion = prompt ? `用户的原始问题：「${prompt.slice(0, 500)}」\n\n` : '';
      const toolContextSummary = buildToolContextForUserSummary(toolCalls);
      summaryPrompt = `${userQuestion}你刚才通过 ${toolCalls.length} 次工具调用分析了项目代码。以下是你调用过的工具和获取到的关键信息：

${toolContextSummary}

请基于以上收集到的信息，用**清晰易读的 Markdown** 格式撰写分析总结，直接回答用户的问题。

要求：
- 使用二级/三级标题组织内容
- 要有具体的代码文件路径、类名、模式名称等细节
- 关键发现用列表项罗列
- 如果发现了架构模式或最佳实践，用简短代码块举例
- 语言自然流畅，像一份技术分析报告`;
      systemPrompt =
        '你是项目分析助手。请用纯 Markdown 格式输出结构清晰的分析总结，只输出人类可读的自然语言文档，不要输出 JSON 格式的数据。';
    }

    // 用空 messages 避免累积上下文导致 400
    const summaryResult = await aiProvider.chatWithTools(summaryPrompt, {
      messages: [],
      toolChoice: 'none',
      systemPrompt,
      temperature: isSystem ? 0.3 : 0.5,
      maxTokens: 8192,
    });

    const result = summaryResult as ChatWithToolsResult;
    if (result.usage) {
      resultTokenUsage.input += result.usage.inputTokens || 0;
      resultTokenUsage.output += result.usage.outputTokens || 0;
    }
    // system 源 (非 analyst): dimensionDigest JSON 是预期输出，不能被 cleanFinalAnswer 剥掉
    // analyst 源: Markdown 分析报告，需要 cleanFinalAnswer 清理
    finalReply =
      isSystem && !isAnalyst
        ? (summaryResult.text || '').trim()
        : cleanFinalAnswer(summaryResult.text || '');
  } catch (err: unknown) {
    logger.warn(`[ForcedSummary] AI call failed: ${(err as Error).message}`);

    if (isSystem && isAnalyst) {
      // Analyst 管线兜底: 从工具调用记录合成 Markdown 分析报告
      const toolNames = [...new Set(toolCalls.map((tc: ToolCallRecord) => tc.tool))];
      const filesRead = toolCalls
        .filter((tc: ToolCallRecord) => tc.tool === 'read_project_file')
        .flatMap((tc: ToolCallRecord) => {
          const p: ToolCallArgs = tc.args || tc.params || {};
          if (p.filePaths) {
            return p.filePaths;
          }
          if (p.filePath) {
            return [p.filePath];
          }
          return [];
        })
        .slice(0, 15);
      const searches = toolCalls
        .filter(
          (tc: ToolCallRecord) =>
            tc.tool === 'search_project_code' || tc.tool === 'semantic_search_code'
        )
        .map((tc: ToolCallRecord) => {
          const p: ToolCallArgs = tc.args || tc.params || {};
          return p.patterns?.[0] || p.query || p.pattern;
        })
        .filter((v): v is string => Boolean(v))
        .slice(0, 8);
      const classesExplored = toolCalls
        .filter(
          (tc: ToolCallRecord) => tc.tool === 'get_class_info' || tc.tool === 'get_class_hierarchy'
        )
        .map((tc: ToolCallRecord) => (tc.args || tc.params || {}).className)
        .filter((v): v is string => Boolean(v))
        .slice(0, 10);

      finalReply = `## 代码分析报告\n\n通过 **${toolCalls.length} 次工具调用**（${iterations} 轮迭代）探索了项目代码。\n\n`;
      if (filesRead.length > 0) {
        finalReply += `### 分析的源文件\n${filesRead.map((f: string) => `- \`${f}\``).join('\n')}\n\n`;
      }
      if (classesExplored.length > 0) {
        finalReply += `### 探索的类/模块\n${classesExplored.map((c: string) => `- \`${c}\``).join('\n')}\n\n`;
      }
      if (searches.length > 0) {
        finalReply += `### 搜索的代码模式\n${searches.map((s: string) => `- \`${s}\``).join('\n')}\n\n`;
      }
      finalReply += `### 使用的工具\n${toolNames.map((t) => `- ${t}`).join('\n')}\n\n`;
      finalReply += '> ⚠️ AI 服务异常，未能生成完整分析。以上为工具调用记录摘要。';
    } else if (isSystem) {
      // system 源兜底: 合成 dimensionDigest JSON
      const titles = toolCalls
        .filter(
          (tc: ToolCallRecord) => tc.tool === 'submit_knowledge' || tc.tool === 'submit_with_check'
        )
        .map((tc: ToolCallRecord) => tc.args?.title || tc.params?.title || 'untitled');
      finalReply = `\`\`\`json
{
  "dimensionDigest": {
    "summary": "通过 ${toolCalls.length} 次工具调用分析了项目代码，提交了 ${candidateCount} 个候选。",
    "candidateCount": ${candidateCount},
    "keyFindings": ${JSON.stringify(titles.slice(0, 5))},
    "crossRefs": {},
    "gaps": ["AI 服务异常，部分分析未完成"]
  }
}
\`\`\``;
    } else {
      // user 源兜底: 合成 Markdown 摘要
      const toolNames = [...new Set(toolCalls.map((tc: ToolCallRecord) => tc.tool))];
      const filesRead = toolCalls
        .filter((tc: ToolCallRecord) => tc.tool === 'read_project_file')
        .flatMap((tc: ToolCallRecord) => {
          const p: ToolCallArgs = tc.args || tc.params || {};
          if (p.filePaths) {
            return p.filePaths;
          }
          if (p.filePath) {
            return [p.filePath];
          }
          return [];
        })
        .slice(0, 10);
      const searches = toolCalls
        .filter(
          (tc: ToolCallRecord) =>
            tc.tool === 'search_project_code' || tc.tool === 'semantic_search_code'
        )
        .map((tc: ToolCallRecord) => {
          const p: ToolCallArgs = tc.args || tc.params || {};
          return p.patterns?.[0] || p.query || p.pattern;
        })
        .filter((v): v is string => Boolean(v))
        .slice(0, 5);

      finalReply = `## 分析总结\n\n通过 **${toolCalls.length} 次工具调用**探索了项目代码。\n\n`;
      if (searches.length > 0) {
        finalReply += `### 搜索的关键词\n${searches.map((s: string) => `- \`${s}\``).join('\n')}\n\n`;
      }
      if (filesRead.length > 0) {
        finalReply += `### 读取的文件\n${filesRead.map((f: string) => `- \`${f}\``).join('\n')}\n\n`;
      }
      finalReply += `### 使用的工具\n${toolNames.map((t) => `- ${t}`).join('\n')}\n\n`;
      finalReply += '> ⚠️ AI 服务异常，未能生成完整分析。请稍后重试或缩小分析范围。';
    }
  }

  logger.info(`[ForcedSummary] ✅ forced summary — ${finalReply.length} chars`);
  return { reply: finalReply, tokenUsage: resultTokenUsage };
}

/**
 * 从工具调用记录中提取上下文摘要 (供 user 源强制总结使用)
 * @param {Array} toolCalls
 * @returns {string}
 */
function buildToolContextForUserSummary(toolCalls: ToolCallRecord[]) {
  const sections: string[] = [];

  // 目录结构探索
  const structureCalls = toolCalls.filter(
    (tc: ToolCallRecord) => tc.tool === 'list_project_structure'
  );
  if (structureCalls.length > 0) {
    const dirs = structureCalls
      .map((tc: ToolCallRecord) => (tc.args || tc.params)?.directory || '/')
      .slice(0, 5);
    sections.push(`**目录探索**: ${dirs.map((d: string) => `\`${d}\``).join(', ')}`);
  }

  // 项目概况
  const overviewCalls = toolCalls.filter(
    (tc: ToolCallRecord) => tc.tool === 'get_project_overview'
  );
  if (overviewCalls.length > 0) {
    sections.push('**项目概况**: 已获取');
  }

  // 代码搜索
  const searchCalls = toolCalls.filter(
    (tc: ToolCallRecord) => tc.tool === 'search_project_code' || tc.tool === 'semantic_search_code'
  );
  if (searchCalls.length > 0) {
    const queries = searchCalls
      .map((tc: ToolCallRecord) => {
        const p: ToolCallArgs = tc.args || tc.params || {};
        return p.patterns?.[0] || p.query || p.pattern;
      })
      .filter((v): v is string => Boolean(v))
      .slice(0, 8);
    sections.push(
      `**代码搜索** (${searchCalls.length} 次): ${queries.map((q: string) => `\`${q}\``).join(', ')}`
    );
  }

  // 文件读取
  const readCalls = toolCalls.filter((tc: ToolCallRecord) => tc.tool === 'read_project_file');
  if (readCalls.length > 0) {
    const files = readCalls
      .flatMap((tc: ToolCallRecord) => {
        const p: ToolCallArgs = tc.args || tc.params || {};
        if (p.filePaths) {
          return p.filePaths;
        }
        if (p.filePath) {
          return [p.filePath];
        }
        return [] as string[];
      })
      .slice(0, 10);
    sections.push(
      `**文件读取** (${readCalls.length} 次): ${files.map((f: string) => `\`${f}\``).join(', ')}`
    );
  }

  // AST 分析
  const astCalls = toolCalls.filter((tc: ToolCallRecord) =>
    [
      'get_class_hierarchy',
      'get_class_info',
      'get_protocol_info',
      'get_method_overrides',
      'get_category_map',
    ].includes(tc.tool)
  );
  if (astCalls.length > 0) {
    const entities = astCalls
      .map((tc: ToolCallRecord) => {
        const p: ToolCallArgs = tc.args || tc.params || {};
        return p.className || p.name || p.protocolName || p.rootClass;
      })
      .filter((v): v is string => Boolean(v))
      .slice(0, 5);
    sections.push(
      `**AST 结构分析** (${astCalls.length} 次): ${entities.map((e: string) => `\`${e}\``).join(', ')}`
    );
  }

  // 知识库搜索
  const kbCalls = toolCalls.filter((tc: ToolCallRecord) =>
    ['search_knowledge', 'search_recipes', 'knowledge_overview'].includes(tc.tool)
  );
  if (kbCalls.length > 0) {
    sections.push(`**知识库查询**: ${kbCalls.length} 次`);
  }

  return sections.length > 0 ? sections.join('\n') : '（工具调用记录为空）';
}

export default produceForcedSummary;

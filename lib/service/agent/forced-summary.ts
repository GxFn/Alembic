/**
 * forced-summary.js — 强制退出后的摘要生成
 *
 * 强制退出后的摘要生成独立模块，
 * 供 AgentRuntime.reactLoop() 在循环退出后调用。
 *
 * 支持两种模式:
 *   - system: 输出 dimensionDigest JSON (供 Bootstrap 管线消费)
 *   - user: 输出人类可读的 Markdown 结构化总结 (前端 AI Chat 展示)
 *
 * @module forced-summary
 */

import Logger from '../../infrastructure/logging/Logger.js';
import { cleanFinalAnswer } from './core/ChatAgentPrompts.js';

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
}) {
  const isSystem = source === 'system';
  const iterations = tracker?.iteration || 0;
  const resultTokenUsage = { input: 0, output: 0 };

  logger.info(
    `[ForcedSummary] ⚠ producing forced summary (${iterations} iters, ${toolCalls.length} calls, source=${source})`
  );

  const candidateCount = toolCalls.filter(
    (tc) => tc.tool === 'submit_knowledge' || tc.tool === 'submit_with_check'
  ).length;

  let finalReply;

  // 如果熔断器已打开，跳过 AI 调用直接合成摘要
  const isCircuitOpen = aiProvider._circuitState === 'OPEN';
  if (isCircuitOpen) {
    logger.warn(
      `[ForcedSummary] circuit breaker is OPEN — skipping AI summary, using synthetic ${isSystem ? 'digest' : 'summary'}`
    );
  }

  // 收集工具调用摘要
  const submitSummary = toolCalls
    .filter((tc) => tc.tool === 'submit_knowledge' || tc.tool === 'submit_with_check')
    .map(
      (tc, i) =>
        `${i + 1}. ${tc.args?.title || tc.args?.category || tc.params?.title || tc.params?.category || 'untitled'}`
    )
    .join('\n');

  try {
    if (isCircuitOpen) {
      throw new Error('circuit open — skip to synthetic summary');
    }

    let summaryPrompt;
    let systemPrompt;

    if (isSystem) {
      // system 源: dimensionDigest JSON
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

    if (summaryResult.usage) {
      resultTokenUsage.input += summaryResult.usage.inputTokens || 0;
      resultTokenUsage.output += summaryResult.usage.outputTokens || 0;
    }
    // system 源: dimensionDigest JSON 是预期输出，不能被 cleanFinalAnswer 剥掉
    finalReply = isSystem
      ? (summaryResult.text || '').trim()
      : cleanFinalAnswer(summaryResult.text || '');
  } catch (err: any) {
    logger.warn(`[ForcedSummary] AI call failed: ${err.message}`);

    if (isSystem) {
      // system 源兜底: 合成 dimensionDigest JSON
      const titles = toolCalls
        .filter((tc) => tc.tool === 'submit_knowledge' || tc.tool === 'submit_with_check')
        .map((tc) => tc.args?.title || tc.params?.title || 'untitled');
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
      const toolNames = [...new Set(toolCalls.map((tc) => tc.tool))];
      const filesRead = toolCalls
        .filter((tc) => tc.tool === 'read_project_file')
        .flatMap((tc) => {
          const p = tc.args || tc.params || {};
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
        .filter((tc) => tc.tool === 'search_project_code' || tc.tool === 'semantic_search_code')
        .map((tc) => {
          const p = tc.args || tc.params || {};
          return p.patterns?.[0] || p.query || p.pattern;
        })
        .filter(Boolean)
        .slice(0, 5);

      finalReply = `## 分析总结\n\n通过 **${toolCalls.length} 次工具调用**探索了项目代码。\n\n`;
      if (searches.length > 0) {
        finalReply += `### 搜索的关键词\n${searches.map((s) => `- \`${s}\``).join('\n')}\n\n`;
      }
      if (filesRead.length > 0) {
        finalReply += `### 读取的文件\n${filesRead.map((f) => `- \`${f}\``).join('\n')}\n\n`;
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
function buildToolContextForUserSummary(toolCalls) {
  const sections = [];

  // 目录结构探索
  const structureCalls = toolCalls.filter((tc) => tc.tool === 'list_project_structure');
  if (structureCalls.length > 0) {
    const dirs = structureCalls.map((tc) => (tc.args || tc.params)?.directory || '/').slice(0, 5);
    sections.push(`**目录探索**: ${dirs.map((d) => `\`${d}\``).join(', ')}`);
  }

  // 项目概况
  const overviewCalls = toolCalls.filter((tc) => tc.tool === 'get_project_overview');
  if (overviewCalls.length > 0) {
    sections.push('**项目概况**: 已获取');
  }

  // 代码搜索
  const searchCalls = toolCalls.filter(
    (tc) => tc.tool === 'search_project_code' || tc.tool === 'semantic_search_code'
  );
  if (searchCalls.length > 0) {
    const queries = searchCalls
      .map((tc) => {
        const p = tc.args || tc.params || {};
        return p.patterns?.[0] || p.query || p.pattern;
      })
      .filter(Boolean)
      .slice(0, 8);
    sections.push(
      `**代码搜索** (${searchCalls.length} 次): ${queries.map((q) => `\`${q}\``).join(', ')}`
    );
  }

  // 文件读取
  const readCalls = toolCalls.filter((tc) => tc.tool === 'read_project_file');
  if (readCalls.length > 0) {
    const files = readCalls
      .flatMap((tc) => {
        const p = tc.args || tc.params || {};
        if (p.filePaths) {
          return p.filePaths;
        }
        if (p.filePath) {
          return [p.filePath];
        }
        return [];
      })
      .slice(0, 10);
    sections.push(
      `**文件读取** (${readCalls.length} 次): ${files.map((f) => `\`${f}\``).join(', ')}`
    );
  }

  // AST 分析
  const astCalls = toolCalls.filter((tc) =>
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
      .map((tc) => {
        const p = tc.args || tc.params || {};
        return p.className || p.name || p.protocolName || p.rootClass;
      })
      .filter(Boolean)
      .slice(0, 5);
    sections.push(
      `**AST 结构分析** (${astCalls.length} 次): ${entities.map((e) => `\`${e}\``).join(', ')}`
    );
  }

  // 知识库搜索
  const kbCalls = toolCalls.filter((tc) =>
    ['search_knowledge', 'search_recipes', 'knowledge_overview'].includes(tc.tool)
  );
  if (kbCalls.length > 0) {
    sections.push(`**知识库查询**: ${kbCalls.length} 次`);
  }

  return sections.length > 0 ? sections.join('\n') : '（工具调用记录为空）';
}

export default produceForcedSummary;

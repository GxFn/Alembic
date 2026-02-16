/**
 * HandoffProtocol.js — Analyst → Producer 交接协议
 *
 * 职责:
 * 1. 从 Analyst 执行结果构建 AnalysisReport
 * 2. 质量门控: 判断分析是否足够深入
 * 3. 提供重试提示构建
 *
 * @module HandoffProtocol
 */

// ──────────────────────────────────────────────────────────────────
// AnalysisReport 构建
// ──────────────────────────────────────────────────────────────────

/**
 * 清理 Analyst 分析文本中可能泄漏的系统 nudge / graceful exit 指令。
 * 这些内容如果传给 Producer，会干扰其正常工作流。
 */
function sanitizeAnalysisText(text) {
  if (!text) return '';
  // 移除 graceful exit nudge 及 digest 模板指令
  const patterns = [
    /\*{0,2}⚠️?\s*(?:你已使用|轮次即将耗尽|仅剩|请立即停止|必须立即结束)[^\n]*\n?/gi,
    /\*{0,2}请立即停止所有工具调用[^\n]*\*{0,2}\n?/gi,
    /请在回复中直接输出\s*dimensionDigest\s*JSON[^\n]*\n?/gi,
    /> ?(?:remainingTasks|如果所有信号都已覆盖)[^\n]*\n?/gi,
    /> ?⚠️ 严禁输出任何非 JSON 内容[^\n]*\n?/gi,
    // 移除 AI 回显的 dimensionDigest JSON 块（对 Producer 无价值且会干扰）
    /```json\s*\n\s*\{\s*"dimensionDigest"\s*:[\s\S]*?\n```/g,
  ];
  let cleaned = text;
  for (const pat of patterns) {
    cleaned = cleaned.replace(pat, '');
  }
  // 移除可能残留的空行堆积
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return cleaned;
}

/**
 * 从 Analyst 的执行结果构建 AnalysisReport
 *
 * @param {object} analystResult — ChatAgent.execute() 返回值
 * @param {string} analystResult.reply — Analyst 的自然语言分析文本
 * @param {Array} analystResult.toolCalls — 工具调用记录
 * @param {string} dimensionId — 维度 ID
 * @param {object} [projectGraph] — ProjectGraph 实例 (用于从 className 反查文件路径)
 * @returns {AnalysisReport}
 */
export function buildAnalysisReport(analystResult, dimensionId, projectGraph = null) {
  const referencedFiles = new Set();
  const searchQueries = [];
  const classesExplored = [];

  for (const call of (analystResult.toolCalls || [])) {
    const tool = call.tool || call.name;
    const args = call.params || call.args || {};
    const result = call.result;

    switch (tool) {
      case 'read_project_file':
        if (args.filePath) referencedFiles.add(args.filePath);
        break;
      case 'search_project_code':
        if (args.pattern || args.query) searchQueries.push(args.pattern || args.query);
        // 从搜索结果中提取文件路径
        if (typeof result === 'string') {
          const fileMatches = result.match(/(?:^|\n)([\w/.-]+\.[mhswift]+)(?::\d+)?/g);
          if (fileMatches) {
            for (const m of fileMatches) {
              const clean = m.trim().replace(/:\d+$/, '').replace(/^\n/, '');
              if (clean.length > 2 && clean.length < 120) referencedFiles.add(clean);
            }
          }
        }
        break;
      case 'get_class_info':
        if (args.className) {
          classesExplored.push(args.className);
          // 从 ProjectGraph 反查文件路径
          if (projectGraph) {
            const info = projectGraph.getClassInfo(args.className);
            if (info?.filePath) referencedFiles.add(info.filePath);
          }
        }
        break;
      case 'get_protocol_info':
        if (args.protocolName && projectGraph) {
          const info = projectGraph.getProtocolInfo(args.protocolName);
          if (info?.filePath) referencedFiles.add(info.filePath);
        }
        break;
      case 'get_file_summary':
        if (args.filePath) referencedFiles.add(args.filePath);
        break;
    }
  }

  // 从分析文本中提取文件路径
  const text = sanitizeAnalysisText(analystResult.reply || '');
  const textFileRefs = text.match(/[\w/.-]+\.[mhswift]+/g);
  if (textFileRefs) {
    for (const f of textFileRefs) {
      if (f.length > 2 && f.length < 120 && /\.[mhswift]+$/.test(f)) {
        referencedFiles.add(f);
      }
    }
  }

  return {
    analysisText: text,
    referencedFiles: [...referencedFiles],
    searchQueries,
    classesExplored,
    dimensionId,
    metadata: {
      iterations: analystResult.toolCalls?.length || 0,
      toolCallCount: analystResult.toolCalls?.length || 0,
      tokenUsage: analystResult.tokenUsage || null,
    },
  };
}

// ──────────────────────────────────────────────────────────────────
// 质量门控 (Gate)
// ──────────────────────────────────────────────────────────────────

/**
 * 分析质量门控 — 判断 Analyst 的输出是否足够好
 *
 * @param {AnalysisReport} report
 * @param {object} [options]
 * @param {string} [options.outputType] — 'analysis' | 'dual' | 'candidate'
 * @returns {{ pass: boolean, reason?: string, action?: 'retry' | 'degrade' }}
 */
export function analysisQualityGate(report, options = {}) {
  const needsCandidates = options.outputType === 'dual' || options.outputType === 'candidate';
  // 需要产出候选的维度要求更高门槛
  const minChars = needsCandidates ? 400 : 200;
  const minFileRefs = needsCandidates ? 3 : 2;

  // 规则 1: 最少字符数 — 分析太短说明未充分探索
  if (report.analysisText.length < minChars) {
    return { pass: false, reason: 'Analysis too short', action: 'retry' };
  }

  // 规则 2: 最少引用文件数 — 未引用文件说明未看代码
  if (report.referencedFiles.length < minFileRefs) {
    return { pass: false, reason: 'Too few file references', action: 'retry' };
  }

  // 规则 3: 检测"拒绝回答"模式
  const refusalPatterns = [
    /I cannot|I'm unable|I don't have access/i,
    /无法分析|无法访问|没有足够/,
  ];
  if (refusalPatterns.some(p => p.test(report.analysisText))) {
    return { pass: false, reason: 'Agent refused to analyze', action: 'degrade' };
  }

  // 规则 4: 内容实质性检查 — 有结构化内容或足够多的探索
  // v3.1: 放宽条件 — tool calling 模式下 AI 往往不输出 markdown 格式
  // 只要分析足够长且引用了足够多的文件，就认为有实质性内容
  const hasStructure = /#{1,3}\s/.test(report.analysisText) ||
                       /\d+\.\s/.test(report.analysisText) ||
                       /[-•]\s/.test(report.analysisText) ||
                       /[：:].+\n/.test(report.analysisText) ||
                       report.analysisText.length >= 500 ||
                       (report.referencedFiles.length >= 3 && report.analysisText.length >= 200);
  if (!hasStructure) {
    return { pass: false, reason: 'Analysis lacks structure', action: 'retry' };
  }

  return { pass: true };
}

/**
 * 构建重试提示 — Gate 失败时给 Analyst 的追加指令
 *
 * @param {string} reason — Gate 失败原因
 * @returns {string}
 */
export function buildRetryPrompt(reason) {
  const hints = {
    'Analysis too short': '你的分析不够深入。请使用更多工具（get_class_info、read_project_file、search_project_code）查看实际代码，输出至少 500 字的分析。',
    'Too few file references': '你的分析缺少代码引用。请使用 get_class_info 和 read_project_file 查看至少 3 个相关文件，并在分析中引用具体文件和行号。',
    'Analysis lacks structure': '请将分析组织成结构化的段落，使用编号列表或标题来区分不同的发现。每个发现应包含具体的文件路径和代码位置。',
  };

  return hints[reason] || '请更深入地分析代码，引用至少 3 个具体文件，每个发现都要有代码证据。';
}

// ──────────────────────────────────────────────────────────────────
// 类型定义 (JSDoc)
// ──────────────────────────────────────────────────────────────────

/**
 * @typedef {object} AnalysisReport
 * @property {string} analysisText — Analyst 的完整回复文本
 * @property {string[]} referencedFiles — 从 toolCalls 中提取的已引用文件路径
 * @property {string[]} searchQueries — 从 toolCalls 中提取的搜索查询
 * @property {string[]} classesExplored — 从 toolCalls 中提取的已查看类名
 * @property {string} dimensionId — 维度 ID
 * @property {object} metadata — { iterations, toolCallCount }
 */

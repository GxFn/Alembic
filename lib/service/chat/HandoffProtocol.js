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

import { EvidenceCollector } from './EvidenceCollector.js';

// ──────────────────────────────────────────────────────────────────
// AnalysisReport 构建
// ──────────────────────────────────────────────────────────────────

/**
 * 清理 Analyst 分析文本中可能泄漏的系统 nudge / graceful exit 指令。
 * 这些内容如果传给 Producer，会干扰其正常工作流。
 */
function sanitizeAnalysisText(text) {
  if (!text) {
    return '';
  }
  // 移除 graceful exit nudge 及 digest 模板指令
  const patterns = [
    /\*{0,2}⚠️?\s*(?:你已使用|轮次即将耗尽|仅剩|请立即停止|必须立即结束)[^\n]*\n?/gi,
    /\*{0,2}请立即停止所有工具调用[^\n]*\*{0,2}\n?/gi,
    /请在回复中直接输出\s*dimensionDigest\s*JSON[^\n]*\n?/gi,
    /> ?(?:remainingTasks|如果所有信号都已覆盖)[^\n]*\n?/gi,
    /> ?⚠️ 严禁输出任何非 JSON 内容[^\n]*\n?/gi,
    // 移除 AI 回显的 dimensionDigest JSON 块（对 Producer 无价值且会干扰）
    /```json\s*\n\s*\{\s*"dimensionDigest"\s*:[\s\S]*?\n```/g,

    // ── AI 思考伪影清理 ──

    // 轮次/阶段计数器（如 "第 18/24 轮 | 验证阶段 | 剩余 6 轮"）
    /^-{2,3}\s*\n\s*第\s*\d+\/\d+\s*轮[^\n]*\n(-{2,3}\s*\n)?/gm,
    // 独立分隔线 + 空内容
    /^-{3}\s*$/gm,

    // AI 规划/反思段落（"计划偏差分析"、"最终总结阶段" 等）
    /^#{1,3}\s*(?:计划偏差分析|最终总结阶段|执行计划|下一步计划|分析计划)\s*\n[\s\S]*?(?=\n#{1,3}\s|\n\n(?=[^#\s-]))/gm,

    // 系统提示回显（"(提示: ...)"）
    /^\(提示[:：][^)]*\)\s*\n?/gm,

    // AI 英文思考泄漏（"Wait, I have enough information..."、"Let me..."、"I'll stop here..."）
    /^(?:Wait,|Let me|I'll stop here|I will stop|I need to|I should|I have enough)[^\n]*\n?/gm,

    // 工具提示循环（"尝试使用 `tool_name`..."、"- 尝试使用..."）
    /^[-•]\s*尝试使用\s*`[^`]+`[^\n]*\n?/gm,
    /^💡\s*提示[:：]?\s*\n?/gm,

    // 请继续 / 请接续 单行（AI 被截断后的续写请求）
    /^请(?:继续|接续)[。.]?\s*$/gm,

    // 📊 中期反思块（"📊 中期反思 (第 N/M 轮, X% 预算):" 及后续所有内容直到下一个 ## 或 📊）
    /📊\s*中期反思\s*\([^)]*\):?\s*\n(?:[\s\S]*?(?=\n#{1,3}\s(?!探索计划|第\s*\d)|\n(?=📊)|$))/gm,

    // AI 思考方向列表（"你最近的思考方向:" + 编号列表 + 嵌套的探索计划）
    /^你最近的思考方向:\s*\n(?:[\s\S]*?(?=\n#{1,3}\s(?!探索计划|第\s*\d)|\n(?=📊)|$))/gm,

    // AI 探索计划标题（"### 探索计划"）— 这是 AI 内部规划，不应出现在最终输出中
    /^#{1,3}\s*探索计划\s*\n(?:[\s\S]*?(?=\n#{1,3}\s(?!探索计划)|\n\n(?=[^#\s\d-])|\n(?=📊)|$))/gm,
    // 编号前缀的探索计划（"  1. ### 探索计划" + 紧随的编号列表项）
    /^\s*\d+\.\s+#{1,3}\s*探索计划[^\n]*\n(?:\d+\.\s+\*{0,2}[^\n]*\n?)*/gm,

    // AI 轮次标题（"### 第 N 轮：..." 开头的规划/反思段落）
    /^#{1,3}\s*第\s*\d+\s*轮[:：][^\n]*\n(?:[\s\S]*?(?=\n#{1,3}\s(?!探索计划|第\s*\d)|\n\n(?=#{1,3}\s)|\n(?=📊)|$))/gm,

    // 行动效率统计行（"行动效率: 最近 N 轮中 X% 获取到新信息"）
    /^行动效率[:：][^\n]*\n?/gm,
    /^累计[:：]\s*\d+\s*文件[^\n]*\n?/gm,

    // 计划进度（"📋 计划进度: 0/1 步骤已完成"）
    /^📋\s*计划进度[:：][^\n]*\n?/gm,

    // 请评估提示块（"请评估: 1. ..."）
    /^请评估[:：]\s*\n(?:\s*\d+\.\s+[^\n]*\n?)*/gm,

    // AI 对话提示回显（"(请在继续调用工具前...)", "(由于当前已是第 N 轮...)",  "(注意: 每一轮都必须...)"）
    /^\([请由注](?:在继续|于当前|意[:：])[^)]*\)\s*\n?/gm,

    // AI 步骤进度与计划更新（"已经读取，未完成步骤..."、"计划更新：..."、"更新后的计划：..."）
    /^(?:\d+\.\s+)?(?:`[^`]*`\s+)?(?:已经读取|未完成步骤仅剩|计划更新|更新后的计划)[^\n]*\n?/gm,
    /^更新后的计划[:：]\s*\n(?:\s*\d+\.\s+[^\n]*\n?)*/gm,

    // 纯数字编号残留行（清理被上面 pattern 删除后留下的孤立编号）
    /^\s*\d+\.\s*$/gm,
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

  for (const call of analystResult.toolCalls || []) {
    const tool = call.tool || call.name;
    const args = call.params || call.args || {};
    const result = call.result;

    switch (tool) {
      case 'read_project_file':
        if (args.filePath) {
          referencedFiles.add(args.filePath);
        }
        break;
      case 'search_project_code':
        if (args.pattern || args.query) {
          searchQueries.push(args.pattern || args.query);
        }
        // 从搜索结果中提取文件路径
        if (typeof result === 'string') {
          const fileMatches = result.match(
            /(?:^|\n)([\w/.-]+\.(?:go|mod|sum|py|pyi|java|kt|kts|js|ts|jsx|tsx|mjs|cjs|swift|m|h|c|cpp|cc|hpp|cs|rb|rs|sql|json|yaml|yml|toml|xml|html|css|scss|less|sh|md|txt|gradle|properties|proto|vue|svelte|graphql|cfg|conf|ini|env|lock|rst))(?::\d+)?/gi
          );
          if (fileMatches) {
            for (const m of fileMatches) {
              const clean = m.trim().replace(/:\d+$/, '').replace(/^\n/, '');
              if (clean.length > 2 && clean.length < 120) {
                referencedFiles.add(clean);
              }
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
            if (info?.filePath) {
              referencedFiles.add(info.filePath);
            }
          }
        }
        break;
      case 'get_protocol_info':
        if (args.protocolName && projectGraph) {
          const info = projectGraph.getProtocolInfo(args.protocolName);
          if (info?.filePath) {
            referencedFiles.add(info.filePath);
          }
        }
        break;
      case 'get_file_summary':
        if (args.filePath) {
          referencedFiles.add(args.filePath);
        }
        break;
    }
  }

  // 从分析文本中提取文件路径（支持多语言项目）
  const text = sanitizeAnalysisText(analystResult.reply || '');
  const FILE_EXT_RE =
    /[\w/.-]+\.(?:go|mod|sum|py|pyi|java|kt|kts|js|ts|jsx|tsx|mjs|cjs|swift|m|h|c|cpp|cc|hpp|cs|rb|rs|sql|json|yaml|yml|toml|xml|html|css|scss|less|sh|md|txt|gradle|properties|proto|vue|svelte|graphql|cfg|conf|ini|env|lock|rst)\b/gi;
  const textFileRefs = text.match(FILE_EXT_RE);
  if (textFileRefs) {
    for (const f of textFileRefs) {
      if (f.length > 2 && f.length < 120) {
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
      reasoningQuality: analystResult.reasoningQuality || null,
    },
  };
}

// ──────────────────────────────────────────────────────────────────
// AnalysisArtifact 构建 (v2)
// ──────────────────────────────────────────────────────────────────

/**
 * 从 Analyst 执行结果构建 AnalysisArtifact (v2 增强版)
 *
 * 在 v1 AnalysisReport 基础上增加:
 * - evidenceMap: 文件 → 代码片段 + 摘要 (Producer 可直接引用)
 * - explorationLog: 工具调用意图 + 结果摘要序列
 * - negativeSignals: 搜索但未找到的模式 (告知 Producer 不要猜测)
 * - findings: 来自 ActiveContext 的结构化发现
 * - qualityReport: 多维度质量评分
 *
 * 向后兼容: 返回对象包含 v1 的所有字段 (analysisText, referencedFiles, searchQueries, classesExplored, metadata)
 *
 * @param {object} analystResult — ChatAgent.execute() 返回值
 * @param {string} dimensionId — 维度 ID
 * @param {object} [projectGraph] — ProjectGraph 实例
 * @param {object} [activeContext] — ActiveContext 实例 (提供 distill 结果)
 * @returns {AnalysisArtifact}
 */
export function buildAnalysisArtifact(analystResult, dimensionId, projectGraph = null, activeContext = null) {
  const toolCalls = analystResult.toolCalls || [];

  // §1: 构建 v1 报告 (复用已有逻辑获取 referencedFiles, searchQueries 等)
  const baseReport = buildAnalysisReport(analystResult, dimensionId, projectGraph);

  // §2: 从工具调用中收集结构化证据
  const collector = new EvidenceCollector();
  for (let i = 0; i < toolCalls.length; i++) {
    collector.processToolCall(toolCalls[i], i);
  }
  const evidence = collector.build();

  // §3: 从 ActiveContext 获取结构化发现 (保持与 distill() 一致的规范形状)
  const distilled = activeContext?.distill() || { keyFindings: [], toolCallSummary: [] };
  const findings = distilled.keyFindings.map((f) => ({
    finding: f.finding,
    evidence: f.evidence || '',
    importance: f.importance,
  }));

  // §4: 合并引用文件 (v1 提取 + evidenceMap 中的文件)
  const allFiles = new Set(baseReport.referencedFiles);
  for (const filePath of evidence.evidenceMap.keys()) {
    allFiles.add(filePath);
  }

  // §5: 计算多维度质量评分
  const qualityReport = buildQualityScores(
    baseReport.analysisText,
    findings,
    evidence,
  );

  // §6: 构建 AnalysisArtifact (v1 超集)
  return {
    // ═══ Layer 1: Core (注入 Producer prompt) ═══
    analysisText: baseReport.analysisText,
    findings,
    referencedFiles: [...allFiles],
    dimensionId,

    // ═══ Layer 2: Detail (按需检索) ═══
    evidenceMap: evidence.evidenceMap,
    explorationLog: evidence.explorationLog,
    negativeSignals: evidence.negativeSignals,

    // ═══ Layer 3: Raw (仅审计/debug) ═══
    fullToolTrace: toolCalls,

    // ═══ Quality ═══
    qualityReport,

    // ═══ Metadata (v1 超集) ═══
    metadata: {
      ...baseReport.metadata,
      artifactVersion: 2,
    },

    // ═══ v1 backward compat ═══
    searchQueries: baseReport.searchQueries,
    classesExplored: baseReport.classesExplored,
  };
}

// ──────────────────────────────────────────────────────────────────
// 多维度质量评分 (v2)
// ──────────────────────────────────────────────────────────────────

/**
 * 计算 AnalysisArtifact 的多维度质量评分
 *
 * 4 个维度各 0-100 分, 加权计算总分:
 *   depthScore (30%)   — 文件覆盖深度
 *   breadthScore (20%) — 工具使用广度
 *   evidenceScore (30%) — 证据充分性
 *   coherenceScore (20%) — 分析连贯性
 *
 * @param {string} analysisText — 清洗后分析文本
 * @param {Array} findings — 结构化发现
 * @param {object} evidence — EvidenceCollector.build() 结果
 * @returns {{ scores: object, totalScore: number, suggestions: string[] }}
 */
function buildQualityScores(analysisText, findings, evidence) {
  const scores = {};

  // §1: depthScore — 文件覆盖深度
  const uniqueFilesRead = evidence.evidenceMap?.size || 0;
  const snippetCount = [...(evidence.evidenceMap?.values() || [])].reduce(
    (sum, e) => sum + e.codeSnippets.length,
    0,
  );
  scores.depthScore = Math.min(100, uniqueFilesRead * 15 + snippetCount * 5);

  // §2: breadthScore — 工具种类 + 有效率
  const toolTypes = new Set((evidence.explorationLog || []).map((e) => e.tool));
  const logLen = evidence.explorationLog?.length || 0;
  const effectiveRatio = logLen > 0
    ? (evidence.explorationLog || []).filter((e) => e.effective).length / logLen
    : 0;
  scores.breadthScore = Math.min(100, toolTypes.size * 20 + effectiveRatio * 40);

  // §3: evidenceScore — 发现数量 + 有证据的发现比例
  const findingCount = findings?.length || 0;
  const evidencedFindings = (findings || []).filter((f) => f.evidence && f.evidence.length > 0).length;
  scores.evidenceScore =
    findingCount > 0
      ? Math.min(100, (evidencedFindings / findingCount) * 60 + findingCount * 10)
      : 0;

  // §4: coherenceScore — 文本长度 + 结构标记
  const textLen = analysisText?.length || 0;
  const hasHeaders = /#{1,3}\s/.test(analysisText || '');
  const hasLists = /\d+\.\s|[-•]\s/.test(analysisText || '');
  scores.coherenceScore = Math.min(
    100,
    (textLen > 500 ? 40 : textLen / 12.5) +
      (hasHeaders ? 20 : 0) +
      (hasLists ? 20 : 0) +
      (findingCount >= 3 ? 20 : findingCount * 7),
  );

  // 加权总分
  const totalScore = Math.round(
    scores.depthScore * 0.3 +
      scores.breadthScore * 0.2 +
      scores.evidenceScore * 0.3 +
      scores.coherenceScore * 0.2,
  );

  // 改进建议
  const suggestions = [];
  if (scores.depthScore < 50) suggestions.push('Need more read_project_file to examine code');
  if (scores.evidenceScore < 50) suggestions.push('Findings lack file-level evidence');
  if (scores.coherenceScore < 50) suggestions.push('Analysis text is too short or unstructured');

  return { scores, totalScore, suggestions };
}

// ──────────────────────────────────────────────────────────────────
// 质量门控 (Gate)
// ──────────────────────────────────────────────────────────────────

/**
 * 分析质量门控 — 判断 Analyst 的输出是否足够好
 *
 * 自动检测 v1 (AnalysisReport) 和 v2 (AnalysisArtifact):
 * - v2: 从 qualityReport.totalScore 计算门控结果
 * - v1: 使用原有的 4 条规则
 *
 * @param {AnalysisReport|AnalysisArtifact} report
 * @param {object} [options]
 * @param {string} [options.outputType] — 'analysis' | 'dual' | 'candidate'
 * @returns {{ pass: boolean, reason?: string, action?: 'retry' | 'degrade' }}
 */
export function analysisQualityGate(report, options = {}) {
  // v2: AnalysisArtifact 带有 qualityReport
  if (report.qualityReport?.scores) {
    return applyGateThresholds(report.qualityReport, options);
  }
  // v1: 原有逻辑
  return analysisQualityGateV1(report, options);
}

/**
 * v2 质量门控 — 基于多维度评分 + 阈值
 */
function applyGateThresholds(qualityReport, options = {}) {
  const { totalScore } = qualityReport;
  const needsCandidates = options.outputType === 'dual' || options.outputType === 'candidate';
  const threshold = needsCandidates ? 60 : 45;

  if (totalScore >= threshold) {
    return { pass: true };
  }
  if (totalScore >= threshold - 20) {
    return {
      pass: false,
      reason: `Quality score ${totalScore}/${threshold}`,
      action: 'retry',
    };
  }
  return {
    pass: false,
    reason: `Quality score ${totalScore}/${threshold}`,
    action: 'degrade',
  };
}

/**
 * v1 质量门控 — 原有 4 条规则 (保留向后兼容)
 */
function analysisQualityGateV1(report, options = {}) {
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
  if (refusalPatterns.some((p) => p.test(report.analysisText))) {
    return { pass: false, reason: 'Agent refused to analyze', action: 'degrade' };
  }

  // 规则 4: 内容实质性检查 — 有结构化内容或足够多的探索
  // v3.1: 放宽条件 — tool calling 模式下 AI 往往不输出 markdown 格式
  // 只要分析足够长且引用了足够多的文件，就认为有实质性内容
  const hasStructure =
    /#{1,3}\s/.test(report.analysisText) ||
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
    'Analysis too short':
      '你的分析不够深入。请使用更多工具（get_class_info、read_project_file、search_project_code）查看实际代码，输出至少 500 字的分析。',
    'Too few file references':
      '你的分析缺少代码引用。请使用 get_class_info 和 read_project_file 查看至少 3 个相关文件，并在分析中引用具体文件和行号。',
    'Analysis lacks structure':
      '请将分析组织成结构化的段落，使用编号列表或标题来区分不同的发现。每个发现应包含具体的文件路径和代码位置。',
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

/**
 * @typedef {object} AnalysisArtifact
 * @property {string} analysisText — 清洗后的分析全文
 * @property {Array<{claim: string, evidence: string[], importance: number, source: string}>} findings — 结构化发现
 * @property {string[]} referencedFiles — 引用文件列表
 * @property {string} dimensionId — 维度 ID
 * @property {Map<string, import('./EvidenceCollector.js').EvidenceEntry>} evidenceMap — 证据地图
 * @property {import('./EvidenceCollector.js').ExplorationEntry[]} explorationLog — 探索日志
 * @property {import('./EvidenceCollector.js').NegativeSignal[]} negativeSignals — 负空间信号
 * @property {Array} [fullToolTrace] — 完整工具调用追踪 (Layer 3)
 * @property {{ scores: object, totalScore: number, suggestions: string[] }} qualityReport — 质量评分
 * @property {object} metadata — { iterations, toolCallCount, artifactVersion: 2 }
 * @property {string[]} searchQueries — 搜索查询 (v1 兼容)
 * @property {string[]} classesExplored — 查看的类 (v1 兼容)
 */

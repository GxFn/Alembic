/**
 * insight-gate.js — Insight 质量门控领域函数
 *
 * 从旧 HandoffProtocol.js 完整迁移的纯函数模块:
 * - 分析文本清洗 (sanitizeAnalysisText)
 * - AnalysisReport 构建 (v1)
 * - AnalysisArtifact 构建 (v2, 含 evidenceMap/findings/negativeSignals)
 * - 多维度质量评分 (buildQualityScores)
 * - 质量门控 (v1 + v2)
 * - 重试 Prompt 构建
 * - PipelineStrategy gate.evaluator 适配器 (insightGateEvaluator)
 *
 * 被 PipelineStrategy 的 bootstrap preset 直接引用。
 *
 * @module insight-gate
 */

import { EvidenceCollector } from './EvidenceCollector.js';

// ──────────────────────────────────────────────────────────────────
// AnalysisReport 构建
// ──────────────────────────────────────────────────────────────────

/**
 * 清理 Analyst 分析文本中可能泄漏的系统 nudge / graceful exit 指令。
 * 这些内容如果传给 Producer，会干扰其正常工作流。
 */
export function sanitizeAnalysisText(text) {
  if (!text) {
    return '';
  }
  const patterns = [
    /\*{0,2}⚠️?\s*(?:你已使用|轮次即将耗尽|仅剩|请立即停止|必须立即结束)[^\n]*\n?/gi,
    /\*{0,2}请立即停止所有工具调用[^\n]*\*{0,2}\n?/gi,
    /请在回复中直接输出\s*dimensionDigest\s*JSON[^\n]*\n?/gi,
    /> ?(?:remainingTasks|如果所有信号都已覆盖)[^\n]*\n?/gi,
    /> ?⚠️ 严禁输出任何非 JSON 内容[^\n]*\n?/gi,
    /```json\s*\n\s*\{\s*"dimensionDigest"\s*:[\s\S]*?\n```/g,
    /^-{2,3}\s*\n\s*第\s*\d+\/\d+\s*轮[^\n]*\n(-{2,3}\s*\n)?/gm,
    /^-{3}\s*$/gm,
    /^#{1,3}\s*(?:计划偏差分析|最终总结阶段|执行计划|下一步计划|分析计划)\s*\n[\s\S]*?(?=\n#{1,3}\s|\n\n(?=[^#\s-]))/gm,
    /^\(提示[:：][^)]*\)\s*\n?/gm,
    /^(?:Wait,|Let me|I'll stop here|I will stop|I need to|I should|I have enough)[^\n]*\n?/gm,
    /^[-•]\s*尝试使用\s*`[^`]+`[^\n]*\n?/gm,
    /^💡\s*提示[:：]?\s*\n?/gm,
    /^请(?:继续|接续)[。.]?\s*$/gm,
    /📊\s*中期反思\s*\([^)]*\):?\s*\n(?:[\s\S]*?(?=\n#{1,3}\s(?!探索计划|第\s*\d)|\n(?=📊)|$))/gm,
    /^你最近的思考方向:\s*\n(?:[\s\S]*?(?=\n#{1,3}\s(?!探索计划|第\s*\d)|\n(?=📊)|$))/gm,
    /^#{1,3}\s*探索计划\s*\n(?:[\s\S]*?(?=\n#{1,3}\s(?!探索计划)|\n\n(?=[^#\s\d-])|\n(?=📊)|$))/gm,
    /^\s*\d+\.\s+#{1,3}\s*探索计划[^\n]*\n(?:\d+\.\s+\*{0,2}[^\n]*\n?)*/gm,
    /^#{1,3}\s*第\s*\d+\s*轮[:：][^\n]*\n(?:[\s\S]*?(?=\n#{1,3}\s(?!探索计划|第\s*\d)|\n\n(?=#{1,3}\s)|\n(?=📊)|$))/gm,
    /^行动效率[:：][^\n]*\n?/gm,
    /^累计[:：]\s*\d+\s*文件[^\n]*\n?/gm,
    /^📋\s*计划进度[:：][^\n]*\n?/gm,
    /^请评估[:：]\s*\n(?:\s*\d+\.\s+[^\n]*\n?)*/gm,
    /^\([请由注](?:在继续|于当前|意[:：])[^)]*\)\s*\n?/gm,
    /^(?:\d+\.\s+)?(?:`[^`]*`\s+)?(?:已经读取|未完成步骤仅剩|计划更新|更新后的计划)[^\n]*\n?/gm,
    /^更新后的计划[:：]\s*\n(?:\s*\d+\.\s+[^\n]*\n?)*/gm,
    /^\s*\d+\.\s*$/gm,
    /^>\s*(?:searchHints|remainingTasks|candidateCount|crossRefs|keyFindings|gaps)\s*[:：][^\n]*\n?/gm,
    /^\*{0,2}(?:请在|请直接|请确保|请务必|现在开始|输出你的|不要输出|不要再|不要包含)\s*[^。\n]*(?:分析文本|分析总结|分析报告|JSON|工具|输出|文本|报告)[^。\n]*[。.]?\s*\*{0,2}$/gm,
    /^\*{0,2}重要\s*[：:][^。\n]*\*{0,2}$/gm,
    /^注意[：:]\s*到达第\s*\d+\s*轮时[^\n]*$/gm,
    /^第\s*\d+\/\d+\s*轮\s*\|[^\n]*$/gm,
  ];
  let cleaned = text;
  for (const pat of patterns) {
    cleaned = cleaned.replace(pat, '');
  }
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return cleaned;
}

/**
 * 从 Analyst 的执行结果构建 AnalysisReport (v1)
 *
 * @param {object} analystResult - { reply, toolCalls }
 * @param {string} dimensionId 维度 ID
 * @param {object} [projectGraph] - ProjectGraph 实例
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

  // 从分析文本中提取文件路径
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
 * - evidenceMap: 文件 → 代码片段 + 摘要
 * - explorationLog: 工具调用意图 + 结果摘要序列
 * - negativeSignals: 搜索但未找到的模式
 * - findings: 来自 ActiveContext 的结构化发现
 * - qualityReport: 多维度质量评分
 *
 * @param {object} analystResult - { reply, toolCalls }
 * @param {string} dimensionId 维度 ID
 * @param {object} [projectGraph] - ProjectGraph 实例
 * @param {object} [activeContext] - ActiveContext 实例
 * @returns {AnalysisArtifact}
 */
export function buildAnalysisArtifact(analystResult, dimensionId, projectGraph = null, activeContext = null) {
  const toolCalls = analystResult.toolCalls || [];

  const baseReport = buildAnalysisReport(analystResult, dimensionId, projectGraph);

  const collector = new EvidenceCollector();
  for (let i = 0; i < toolCalls.length; i++) {
    collector.processToolCall(toolCalls[i], i);
  }
  const evidence = collector.build();

  const distilled = activeContext?.distill() || { keyFindings: [], toolCallSummary: [] };
  const findings = distilled.keyFindings.map((f) => ({
    finding: f.finding,
    evidence: typeof f.evidence === 'string' ? f.evidence : Array.isArray(f.evidence) ? f.evidence.join(', ') : f.evidence ? String(f.evidence) : '',
    importance: f.importance,
  }));

  const allFiles = new Set(baseReport.referencedFiles);
  for (const filePath of evidence.evidenceMap.keys()) {
    allFiles.add(filePath);
  }

  const qualityReport = buildQualityScores(
    baseReport.analysisText,
    findings,
    evidence,
  );

  return {
    // Layer 1: Core
    analysisText: baseReport.analysisText,
    findings,
    referencedFiles: [...allFiles],
    dimensionId,

    // Layer 2: Detail
    evidenceMap: evidence.evidenceMap,
    explorationLog: evidence.explorationLog,
    negativeSignals: evidence.negativeSignals,

    // Layer 3: Raw
    fullToolTrace: toolCalls,

    // Quality
    qualityReport,

    // Metadata
    metadata: {
      ...baseReport.metadata,
      artifactVersion: 2,
    },

    // v1 backward compat
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
 * 4 维度各 0-100, 加权:
 *   depthScore (30%) — 文件覆盖深度
 *   breadthScore (20%) — 工具使用广度
 *   evidenceScore (30%) — 证据充分性
 *   coherenceScore (20%) — 分析连贯性
 */
function buildQualityScores(analysisText, findings, evidence) {
  const scores = {};

  const uniqueFilesRead = evidence.evidenceMap?.size || 0;
  const snippetCount = [...(evidence.evidenceMap?.values() || [])].reduce(
    (sum, e) => sum + e.codeSnippets.length,
    0,
  );
  scores.depthScore = Math.min(100, uniqueFilesRead * 15 + snippetCount * 5);

  const toolTypes = new Set((evidence.explorationLog || []).map((e) => e.tool));
  const logLen = evidence.explorationLog?.length || 0;
  const effectiveRatio = logLen > 0
    ? (evidence.explorationLog || []).filter((e) => e.effective).length / logLen
    : 0;
  scores.breadthScore = Math.min(100, toolTypes.size * 20 + effectiveRatio * 40);

  const findingCount = findings?.length || 0;
  const evidencedFindings = (findings || []).filter((f) => f.evidence && f.evidence.length > 0).length;
  scores.evidenceScore =
    findingCount > 0
      ? Math.min(100, (evidencedFindings / findingCount) * 60 + findingCount * 10)
      : 0;

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

  const totalScore = Math.round(
    scores.depthScore * 0.3 +
      scores.breadthScore * 0.2 +
      scores.evidenceScore * 0.3 +
      scores.coherenceScore * 0.2,
  );

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
 * 分析质量门控
 *
 * 自动检测 v1 (AnalysisReport) 和 v2 (AnalysisArtifact):
 * - v2: 从 qualityReport.totalScore 计算
 * - v1: 使用 4 条规则
 *
 * @param {AnalysisReport|AnalysisArtifact} report
 * @param {object} [options]
 * @param {string} [options.outputType] - 'analysis' | 'dual' | 'candidate'
 * @returns {{ pass: boolean, reason?: string, action?: 'retry' | 'degrade' }}
 */
export function analysisQualityGate(report, options = {}) {
  if (report.qualityReport?.scores) {
    return applyGateThresholds(report.qualityReport, options);
  }
  return analysisQualityGateV1(report, options);
}

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

function analysisQualityGateV1(report, options = {}) {
  const needsCandidates = options.outputType === 'dual' || options.outputType === 'candidate';
  const minChars = needsCandidates ? 400 : 200;
  const minFileRefs = needsCandidates ? 3 : 2;

  if (report.analysisText.length < minChars) {
    return { pass: false, reason: 'Analysis too short', action: 'retry' };
  }
  if (report.referencedFiles.length < minFileRefs) {
    return { pass: false, reason: 'Too few file references', action: 'retry' };
  }

  const refusalPatterns = [
    /I cannot|I'm unable|I don't have access/i,
    /无法分析|无法访问|没有足够/,
  ];
  if (refusalPatterns.some((p) => p.test(report.analysisText))) {
    return { pass: false, reason: 'Agent refused to analyze', action: 'degrade' };
  }

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
 * 构建重试提示
 *
 * @param {string} reason - Gate 失败原因
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
// PipelineStrategy gate.evaluator 适配器
// ──────────────────────────────────────────────────────────────────

/**
 * 面向 PipelineStrategy gate.evaluator 的包装函数。
 *
 * 将 PipelineStrategy 的 (source, phaseResults, strategyContext) 签名
 * 适配到 buildAnalysisArtifact + analysisQualityGate 调用链。
 *
 * @param {object} source 前一阶段 (analyze) 的 reactLoop 返回值
 * @param {object} phaseResults 所有阶段结果
 * @param {object} strategyContext - orchestrator 注入的运行时上下文
 * @returns {{ action: 'pass'|'retry'|'degrade', reason: string, artifact: object }}
 */
export function insightGateEvaluator(source, phaseResults, strategyContext = {}) {
  if (!source?.reply) {
    return { action: 'degrade', reason: 'No analysis output', artifact: null };
  }

  const { projectGraph, activeContext, dimId, outputType } = strategyContext;

  const artifact = activeContext
    ? buildAnalysisArtifact(source, dimId, projectGraph, activeContext)
    : buildAnalysisReport(source, dimId, projectGraph);

  const gate = analysisQualityGate(artifact, { outputType: outputType || 'analysis' });

  return {
    action: gate.action || (gate.pass ? 'pass' : 'retry'),
    reason: gate.reason || '',
    artifact,
  };
}

// ──────────────────────────────────────────────────────────────────
// 类型定义 (JSDoc)
// ──────────────────────────────────────────────────────────────────

/**
 * @typedef {object} AnalysisReport
 * @property {string} analysisText
 * @property {string[]} referencedFiles
 * @property {string[]} searchQueries
 * @property {string[]} classesExplored
 * @property {string} dimensionId
 * @property {object} metadata - { iterations, toolCallCount }
 */

/**
 * @typedef {object} AnalysisArtifact
 * @property {string} analysisText
 * @property {Array<{claim: string, evidence: string[], importance: number, source: string}>} findings
 * @property {string[]} referencedFiles
 * @property {string} dimensionId
 * @property {Map<string, import('./EvidenceCollector.js').EvidenceEntry>} evidenceMap
 * @property {import('./EvidenceCollector.js').ExplorationEntry[]} explorationLog
 * @property {import('./EvidenceCollector.js').NegativeSignal[]} negativeSignals
 * @property {Array} [fullToolTrace]
 * @property {{ scores: object, totalScore: number, suggestions: string[] }} qualityReport
 * @property {object} metadata
 * @property {string[]} searchQueries
 * @property {string[]} classesExplored
 */

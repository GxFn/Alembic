/**
 * insight-producer.js — Insight Producer 领域函数
 *
 * 从旧 ProducerAgent.js 提取的纯领域逻辑:
 * - Producer System Prompt
 * - 工具白名单
 * - 预算常量
 * - Prompt 构建器 (v1 + v2)
 * - 代码上下文注入 (evidenceMap → prompt section)
 * - 拒绝率门控 (producerRejectionGateEvaluator)
 *
 * 被 PipelineStrategy 的 bootstrap preset 直接引用。
 * 不再包含任何 Agent 类 — Agent 由 AgentRuntime + PipelineStrategy 驱动。
 *
 * @module insight-producer
 */

import { buildProducerStyleGuide, SUBMIT_REQUIREMENTS } from '#domain/knowledge/StyleGuide.js';
import type { EvidenceEntry } from './EvidenceCollector.js';

// ──────────────────────────────────────────────────────────────────
// 本地类型定义
// ──────────────────────────────────────────────────────────────────

/** AnalysisReport 最小接口 (v1) */
interface AnalysisReportLike {
  analysisText: string;
  referencedFiles: string[];
}

/** AnalysisArtifact 最小接口 (v2) */
interface AnalysisArtifactLike extends AnalysisReportLike {
  findings: Array<{ finding: string; evidence?: string; importance: number }>;
  evidenceMap?: Map<string, EvidenceEntry>;
  negativeSignals: Array<{ searchPattern: string; implication: string }>;
}

/** 维度配置 */
interface DimConfig {
  id: string;
  label: string;
  allowedKnowledgeTypes?: string[];
  outputType?: string;
}

/** 项目基本信息 */
interface ProjectInfo {
  name: string;
}

/** reactLoop 返回值 (门控评估用) */
interface ReactLoopResult {
  toolCalls?: ToolCallRecord[];
}

/** 工具调用记录 */
interface ToolCallRecord {
  tool?: string;
  name?: string;
  result?: string | { status?: string; reason?: string };
}

/** 门控策略上下文 */
interface GateStrategyContext {
  submitToolNames?: string[];
  [key: string]: unknown;
}

// ──────────────────────────────────────────────────────────────────
// System Prompt — Producer 专用 (~150 tokens)
// ──────────────────────────────────────────────────────────────────

export const PRODUCER_SYSTEM_PROMPT = `你是知识管理专家。你会收到一段代码分析文本，需要将其中的知识点转化为结构化的知识候选。

核心原则: 分析文本已经包含了所有发现，你的唯一工作是将它们格式化为 submit_knowledge 调用。

每个候选必须:
1. 有清晰的标题 (描述知识点的核心，使用项目真实类名)
2. 有项目特写风格的正文 (content.markdown 字段，结合代码展示)
3. 标注相关文件路径
4. 选择正确的 kind (rule/pattern/fact)
5. 提供完整的 Cursor 交付字段 (trigger, doClause, whenClause 等)

工作流程:
1. 阅读分析文本，识别每个独立的知识点/发现
2. 用 read_project_file 批量获取关键代码片段:
   read_project_file({ filePaths: ["FileA.m", "FileB.m"], maxLines: 80 })
3. 立刻调用 submit_knowledge 提交
4. 重复直到分析中的所有知识点都已提交

关键规则:
- 分析中的每个要点/段落都应转化为至少一个候选
- read_project_file 支持 filePaths 数组批量读取多个文件，一次调用完成
- read_project_file 时读取足够多的行数（startLine + maxLines 至少 30 行）
- reasoning.sources 必须是非空数组，填写相关文件路径如 ["FileName.m"]
- 如果分析提到了 3 个模式，就应该提交 3 个候选，不要合并
- 禁止: 不要搜索新文件、不要做额外分析，专注于格式化和提交

容错规则:
- 如果 read_project_file 返回"文件不存在"或错误，不要重试同一文件的其他路径变体
- 文件读取失败时，直接使用分析文本中已有的代码和描述来提交候选
- 永远不要因为文件读取失败而跳过知识点 — 分析文本已经包含足够信息
- 先提交候选，再考虑是否需要读取更多代码（提交优先于验证）`;

// ──────────────────────────────────────────────────────────────────
// Producer 可用工具白名单 — 只做格式化和提交
// ──────────────────────────────────────────────────────────────────

export const PRODUCER_TOOLS = ['submit_knowledge', 'submit_with_check', 'read_project_file'];

// ──────────────────────────────────────────────────────────────────
// Producer 预算
// ──────────────────────────────────────────────────────────────────

export const PRODUCER_BUDGET = {
  maxIterations: 24,
  searchBudget: 4,
  searchBudgetGrace: 3,
  maxSubmits: 10,
  softSubmitLimit: 10,
  idleRoundsToExit: 3,
};

// ──────────────────────────────────────────────────────────────────
// 项目特写风格指南 (从共享 StyleGuide.js 获取)
// ──────────────────────────────────────────────────────────────────

const STYLE_GUIDE = buildProducerStyleGuide();

// ──────────────────────────────────────────────────────────────────
// Prompt 构建
// ──────────────────────────────────────────────────────────────────

/**
 * 构建 Producer Prompt (v1 — 用于 AnalysisReport)
 *
 * @param dimConfig { id, label, allowedKnowledgeTypes, outputType }
 * @param projectInfo { name }
 */
export function buildProducerPrompt(
  analysisReport: AnalysisReportLike,
  dimConfig: DimConfig,
  projectInfo: ProjectInfo
) {
  const parts: string[] = [];

  parts.push(`将以下对 ${projectInfo.name} 项目 "${dimConfig.label}" 维度的分析，转化为知识候选:`);
  parts.push(`---\n${analysisReport.analysisText}\n---`);

  if (analysisReport.referencedFiles.length > 0) {
    parts.push(`分析中引用的关键文件: ${analysisReport.referencedFiles.join(', ')}`);
  }

  parts.push(`维度约束:
- dimensionId: ${dimConfig.id}
- 允许的 knowledgeType: ${(dimConfig.allowedKnowledgeTypes || []).join(', ') || '(all)'}
- category: ${dimConfig.id}`);

  parts.push(STYLE_GUIDE);
  parts.push(SUBMIT_REQUIREMENTS);

  return parts.join('\n\n');
}

/**
 * 构建 Producer Prompt v2 — 用于 AnalysisArtifact
 *
 * 相比 v1 增加:
 * - §3 结构化发现 (findings)
 * - §4 代码证据 (evidenceMap → code context)
 * - §5 负空间信号
 */
export function buildProducerPromptV2(
  artifact: AnalysisArtifactLike,
  dimConfig: DimConfig,
  projectInfo: ProjectInfo
) {
  const parts: string[] = [];

  parts.push(`将以下对 ${projectInfo.name} 项目 "${dimConfig.label}" 维度的分析，转化为知识候选:`);
  parts.push(`---\n${artifact.analysisText}\n---`);

  // §3 结构化发现
  if (artifact.findings?.length > 0) {
    const findingLines = ['## 关键发现 (Analyst 已确认)'];
    const sorted = [...artifact.findings].sort((a, b) => b.importance - a.importance);
    for (const f of sorted) {
      const badge = f.importance >= 8 ? '⚠️' : '📋';
      findingLines.push(`${badge} **[${f.importance}/10]** ${f.finding}`);
      if (f.evidence) {
        findingLines.push(`  证据: ${f.evidence}`);
      }
    }
    findingLines.push('');
    findingLines.push('☝️ 上述每个发现都应至少转化为一个候选。');
    parts.push(findingLines.join('\n'));
  }

  // §4 代码证据
  const codeContext = buildCodeContextSection(artifact.evidenceMap);
  if (codeContext) {
    parts.push(codeContext);
  }

  // §5 负空间信号
  if (artifact.negativeSignals?.length > 0) {
    const nsLines = ['## ⛔ 不存在的模式 (不要猜测)'];
    for (const ns of artifact.negativeSignals.slice(0, 5)) {
      nsLines.push(`- "${ns.searchPattern}" — ${ns.implication}`);
    }
    parts.push(nsLines.join('\n'));
  }

  // §6 引用文件
  if (artifact.referencedFiles.length > 0) {
    parts.push(`分析中引用的关键文件: ${artifact.referencedFiles.slice(0, 15).join(', ')}`);
  }

  // §7 维度约束
  parts.push(`维度约束:
- dimensionId: ${dimConfig.id}
- 允许的 knowledgeType: ${(dimConfig.allowedKnowledgeTypes || []).join(', ') || '(all)'}
- category: ${dimConfig.id}`);

  // §8 写作指南 + 提交要求
  parts.push(STYLE_GUIDE);
  parts.push(SUBMIT_REQUIREMENTS);

  return parts.join('\n\n');
}

// ──────────────────────────────────────────────────────────────────
// 代码上下文注入 (Producer v2 辅助)
// ──────────────────────────────────────────────────────────────────

/**
 * 从 evidenceMap 构建代码上下文段
 *
 * 策略: 按代码片段数量排序
 * 预算: ≤ 4000 chars (~1000 tokens)
 */
export function buildCodeContextSection(
  evidenceMap: Map<string, EvidenceEntry> | null | undefined
) {
  if (!evidenceMap || evidenceMap.size === 0) {
    return null;
  }

  const parts = ['## 📄 Analyst 已读取的代码 (直接引用, 无需 read_file)'];
  let totalChars = 0;
  const BUDGET = 4000;

  const sortedEntries = [...evidenceMap.values()]
    .filter((e) => e.codeSnippets.length > 0)
    .sort((a, b) => b.codeSnippets.length - a.codeSnippets.length);

  for (const entry of sortedEntries) {
    if (totalChars >= BUDGET) {
      break;
    }

    const header = `### ${entry.filePath}${entry.role ? ` (${entry.role})` : ''}`;
    parts.push(header);
    totalChars += header.length;

    if (entry.summary) {
      parts.push(entry.summary);
      totalChars += entry.summary.length;
    }

    for (const snippet of entry.codeSnippets.slice(0, 2)) {
      if (totalChars >= BUDGET) {
        break;
      }
      const codeBlock = `\`\`\`\n// L${snippet.startLine}-${snippet.endLine}\n${snippet.content}\n\`\`\``;
      if (snippet.analystNote) {
        parts.push(`> ${snippet.analystNote}`);
        totalChars += snippet.analystNote.length + 4;
      }
      parts.push(codeBlock);
      totalChars += codeBlock.length;
    }
  }

  return parts.length > 1 ? parts.join('\n') : null;
}

// ──────────────────────────────────────────────────────────────────
// PipelineStrategy gate.evaluator — 拒绝率门控
// ──────────────────────────────────────────────────────────────────

/**
 * Producer 拒绝率门控 — 面向 PipelineStrategy gate.evaluator
 *
 * 当 produce 阶段的提交拒绝率过高时触发 retry。
 *
 * @param source produce 阶段的 reactLoop 返回值
 * @returns }
 */
export function producerRejectionGateEvaluator(
  source: ReactLoopResult | null | undefined,
  _phaseResults: unknown,
  _strategyContext: GateStrategyContext = {}
) {
  if (!source?.toolCalls) {
    return { action: 'pass', reason: '' };
  }

  // 可配置的提交工具名 — bootstrap 用 submit_knowledge/submit_with_check，scan 用 collect_scan_recipe
  const submitToolNames = _strategyContext.submitToolNames || [
    'submit_knowledge',
    'submit_with_check',
  ];
  const submitCalls = (source.toolCalls || []).filter((tc: ToolCallRecord) =>
    submitToolNames.includes(tc.tool || tc.name || '')
  );
  const rejected = submitCalls.filter((tc: ToolCallRecord) => {
    const res = tc.result;
    if (!res) {
      return false;
    }
    if (typeof res === 'string') {
      return res.includes('rejected') || res.includes('error');
    }
    return (
      res.status === 'rejected' || res.status === 'error' || res.reason === 'validation_failed'
    );
  }).length;
  const success = submitCalls.length - rejected;

  if (rejected > success && rejected >= 2) {
    return { action: 'retry', reason: `${rejected} rejections vs ${success} successes` };
  }
  return { action: 'pass', reason: '' };
}

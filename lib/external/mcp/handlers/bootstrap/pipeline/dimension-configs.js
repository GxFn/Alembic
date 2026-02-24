/**
 * dimension-configs.js — v3.0 维度配置 + Tier Reflection
 *
 * 从 orchestrator.js 拆分，包含:
 * - DIMENSION_CONFIGS_V3: 仅保留内部 Agent 专属配置 (outputType + allowedKnowledgeTypes)
 * - getFullDimensionConfig(): 合并 baseDimensions + V3 专属配置
 * - buildTierReflection: Tier 级反思聚合 (规则化, 不需要 AI)
 *
 * label / guide → 从 baseDimensions 获取（唯一权威来源）
 * SOP / commonMistakes → 从 dimension-sop.js 获取
 *
 * @module pipeline/dimension-configs
 */

import { baseDimensions } from '../base-dimensions.js';
import { getDimensionSOP, getDimensionFocusKeywords } from '../shared/dimension-sop.js';

// ──────────────────────────────────────────────────────────────────
// v3.0 维度配置 — 仅保留内部 Agent 专属字段
// label / guide / focusAreas 已移至 baseDimensions（唯一权威来源）
// ──────────────────────────────────────────────────────────────────

export const DIMENSION_CONFIGS_V3 = {
  'project-profile':            { outputType: 'dual',      allowedKnowledgeTypes: ['architecture'] },
  'objc-deep-scan':             { outputType: 'dual',      allowedKnowledgeTypes: ['code-standard', 'code-pattern'] },
  'category-scan':              { outputType: 'dual',      allowedKnowledgeTypes: ['code-standard', 'code-pattern'] },
  'code-standard':              { outputType: 'dual',      allowedKnowledgeTypes: ['code-standard', 'code-style'] },
  'architecture':               { outputType: 'dual',      allowedKnowledgeTypes: ['architecture', 'module-dependency', 'boundary-constraint'] },
  'code-pattern':               { outputType: 'candidate', allowedKnowledgeTypes: ['code-pattern', 'code-relation', 'inheritance'] },
  'event-and-data-flow':        { outputType: 'candidate', allowedKnowledgeTypes: ['call-chain', 'data-flow', 'event-and-data-flow'] },
  'best-practice':              { outputType: 'candidate', allowedKnowledgeTypes: ['best-practice'] },
  'agent-guidelines':           { outputType: 'skill',     allowedKnowledgeTypes: ['boundary-constraint', 'code-standard'] },
  'module-export-scan':         { outputType: 'dual',      allowedKnowledgeTypes: ['code-standard', 'architecture'] },
  'framework-convention-scan':  { outputType: 'dual',      allowedKnowledgeTypes: ['code-standard', 'architecture'] },
  'python-package-scan':        { outputType: 'dual',      allowedKnowledgeTypes: ['code-standard', 'architecture'] },
  'jvm-annotation-scan':        { outputType: 'dual',      allowedKnowledgeTypes: ['code-pattern', 'architecture'] },
};

// ──────────────────────────────────────────────────────────────────
// 完整维度配置获取（合并 baseDimensions + V3 专属 + SOP）
// ──────────────────────────────────────────────────────────────────

/**
 * 获取完整维度配置（合并 baseDimensions + V3 专属配置 + SOP）
 *
 * @param {string} dimId — 维度 ID
 * @returns {object|null} — 完整维度配置，或 null（未知维度）
 */
export function getFullDimensionConfig(dimId) {
  const base = baseDimensions.find(d => d.id === dimId);
  const v3 = DIMENSION_CONFIGS_V3[dimId];
  if (!base) return null;

  const sop = getDimensionSOP(dimId);

  return {
    id: dimId,
    label: base.label,
    guide: base.guide,
    outputType: v3?.outputType || (base.dualOutput ? 'dual' : base.skillWorthy ? 'skill' : 'candidate'),
    allowedKnowledgeTypes: v3?.allowedKnowledgeTypes || base.knowledgeTypes || [],
    skillWorthy: base.skillWorthy || false,
    dualOutput: base.dualOutput || false,
    skillMeta: base.skillMeta,
    knowledgeTypes: base.knowledgeTypes || [],
    // SOP 结构化分析步骤
    sopSteps: sop?.steps || null,
    commonMistakes: sop?.commonMistakes || [],
    timeEstimate: sop?.timeEstimate || null,
    // 关键关注域词汇（用于 EpisodicMemory 跨维度 findings 相关性匹配）
    focusKeywords: getDimensionFocusKeywords(dimId, base.guide),
  };
}

// ──────────────────────────────────────────────────────────────────
// v4.0: Tier Reflection — 综合分析 (规则化, 不需要 AI)
// ──────────────────────────────────────────────────────────────────

/**
 * 构建 Tier 级 Reflection — 在每个 Tier 完成后调用
 *
 * 无需 AI 调用，通过规则化聚合维度发现:
 * - 收集所有维度的关键发现并按重要性排序
 * - 检测跨维度重复模式
 * - 为下一 Tier 生成建议
 *
 * @param {number} tierIndex — Tier 索引 (0-based)
 * @param {Map<string, object>} tierResults — 本 Tier 的维度结果
 * @param {import('./EpisodicMemory.js').EpisodicMemory} episodicMemory
 * @returns {object} TierReflection
 */
export function buildTierReflection(tierIndex, tierResults, episodicMemory) {
  const completedDimensions = [...tierResults.keys()];

  // 收集本 Tier 所有维度的 findings
  const allFindings = [];
  for (const dimId of completedDimensions) {
    const report = episodicMemory.getDimensionReport(dimId);
    if (report?.findings) {
      for (const f of report.findings) {
        allFindings.push({ dimId, ...f });
      }
    }
  }

  // Top findings by importance
  const topFindings = allFindings
    .sort((a, b) => (b.importance || 5) - (a.importance || 5))
    .slice(0, 10);

  // 检测跨维度模式 (多个维度提到同一文件/关键词)
  const fileMentions = {};
  const keywordMentions = {};

  for (const f of allFindings) {
    // 统计文件引用频率
    if (f.evidence) {
      const file = f.evidence.split(':')[0];
      if (file) {
        fileMentions[file] = (fileMentions[file] || 0) + 1;
      }
    }
    // 统计关键词
    const words = (f.finding || '').split(/[\s,，。.]+/).filter((w) => w.length > 3);
    for (const w of words) {
      keywordMentions[w] = (keywordMentions[w] || 0) + 1;
    }
  }

  const crossDimensionPatterns = [];

  // 多维度引用的文件 = 跨维度热点
  for (const [file, count] of Object.entries(fileMentions)) {
    if (count >= 2) {
      crossDimensionPatterns.push(`文件 "${file}" 被 ${count} 个维度引用 — 可能是系统核心组件`);
    }
  }

  // 多维度提及的关键词
  for (const [word, count] of Object.entries(keywordMentions)) {
    if (count >= 3) {
      crossDimensionPatterns.push(`关键词 "${word}" 出现 ${count} 次 — 跨维度关联主题`);
    }
  }

  // 为下一 Tier 生成建议
  const suggestionsForNextTier = [];

  // 找出 gaps (各维度报告的未覆盖方面)
  for (const dimId of completedDimensions) {
    const report = episodicMemory.getDimensionReport(dimId);
    const gaps = report?.digest?.gaps || [];
    for (const gap of gaps) {
      if (gap && typeof gap === 'string' && gap.length > 5) {
        suggestionsForNextTier.push(`[${dimId}] 未覆盖: ${gap}`);
      }
    }
  }

  // remainingTasks
  for (const dimId of completedDimensions) {
    const report = episodicMemory.getDimensionReport(dimId);
    const remaining = report?.digest?.remainingTasks || [];
    for (const task of remaining) {
      if (task?.signal) {
        suggestionsForNextTier.push(
          `[${dimId}] 遗留信号: ${task.signal} (${task.reason || '未处理'})`
        );
      }
    }
  }

  return {
    tierIndex,
    completedDimensions,
    topFindings,
    crossDimensionPatterns: crossDimensionPatterns.slice(0, 5),
    suggestionsForNextTier: suggestionsForNextTier.slice(0, 8),
  };
}

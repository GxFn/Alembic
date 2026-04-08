/**
 * dimension-configs.js — v3.0 维度配置 + Tier Reflection
 *
 * **v2: 从统一维度注册表 (DimensionRegistry) 派生**
 *
 * 从 orchestrator.js 拆分，包含:
 * - DIMENSION_CONFIGS_V3: 维度的 outputType + allowedKnowledgeTypes
 *   现在从 DimensionRegistry 自动生成，无需手动维护
 * - getFullDimensionConfig(): 合并 baseDimensions + V3 专属配置
 * - buildTierReflection: Tier 级反思聚合 (规则化, 不需要 AI)
 *
 * @module pipeline/dimension-configs
 */

import { getDimensionFocusKeywords, getDimensionSOP } from '#domain/dimension/DimensionSop.js';
import { DIMENSION_REGISTRY, getDimension } from '#domain/dimension/index.js';
import { baseDimensions } from '../base-dimensions.js';

// ──────────────────────────────────────────────────────────────────
// v3.0 维度配置 — 从统一注册表自动生成
// ──────────────────────────────────────────────────────────────────

/**
 * 从统一注册表生成 V3 配置映射
 * 所有维度统一为 candidate-only outputType
 */
export const DIMENSION_CONFIGS_V3: Record<
  string,
  { outputType: string; allowedKnowledgeTypes: string[] }
> = Object.fromEntries(
  DIMENSION_REGISTRY.map((dim) => [
    dim.id,
    {
      outputType: 'candidate',
      allowedKnowledgeTypes: [...dim.allowedKnowledgeTypes],
    },
  ])
);

// ──────────────────────────────────────────────────────────────────
// 完整维度配置获取（合并 baseDimensions + V3 专属 + SOP）
// ──────────────────────────────────────────────────────────────────

/**
 * 获取完整维度配置（合并 baseDimensions + V3 专属配置 + SOP）
 *
 * @param dimId 维度 ID
 * @returns 完整维度配置，或 null（未知维度）
 */
export function getFullDimensionConfig(dimId: string) {
  // 优先从统一注册表获取
  const unified = getDimension(dimId);
  // 回退到旧 baseDimensions（兼容 Enhancement Pack 动态维度）
  const base = unified
    ? {
        id: unified.id,
        label: unified.label,
        guide: unified.extractionGuide,
        knowledgeTypes: [...unified.allowedKnowledgeTypes],
      }
    : baseDimensions.find((d) => d.id === dimId);
  const v3 = DIMENSION_CONFIGS_V3[dimId];

  if (!base) {
    return null;
  }

  const sop = getDimensionSOP(dimId);

  return {
    id: dimId,
    label: base.label,
    guide: base.guide,
    outputType: v3?.outputType || 'candidate',
    allowedKnowledgeTypes: v3?.allowedKnowledgeTypes || base.knowledgeTypes || [],
    skillWorthy: false,
    dualOutput: false,
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

/** A single finding from a dimension analysis */
interface DimensionFinding {
  dimId?: string;
  importance?: number;
  evidence?: string | unknown;
  finding?: string;
}

/** Minimal session store interface for tier reflection */
interface TierSessionStore {
  getDimensionReport(dimId: string):
    | {
        findings?: DimensionFinding[];
        digest?: {
          gaps?: string[];
          remainingTasks?: Array<{ signal?: string; reason?: string }>;
        };
      }
    | undefined;
}

/**
 * 构建 Tier 级 Reflection — 在每个 Tier 完成后调用
 *
 * 无需 AI 调用，通过规则化聚合维度发现:
 * - 收集所有维度的关键发现并按重要性排序
 * - 检测跨维度重复模式
 * - 为下一 Tier 生成建议
 *
 * @param tierIndex Tier 索引 (0-based)
 * @param tierResults 本 Tier 的维度结果
 * @returns TierReflection
 */
export function buildTierReflection(
  tierIndex: number,
  tierResults: Map<string, unknown>,
  sessionStore: TierSessionStore
) {
  const completedDimensions = [...tierResults.keys()];

  // 收集本 Tier 所有维度的 findings
  const allFindings: DimensionFinding[] = [];
  for (const dimId of completedDimensions) {
    const report = sessionStore.getDimensionReport(dimId);
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
  const fileMentions: Record<string, number> = {};
  const keywordMentions: Record<string, number> = {};

  for (const f of allFindings) {
    // 统计文件引用频率
    if (f.evidence) {
      const ev = typeof f.evidence === 'string' ? f.evidence : String(f.evidence);
      const file = ev.split(':')[0];
      if (file) {
        fileMentions[file] = (fileMentions[file] || 0) + 1;
      }
    }
    // 统计关键词
    const words = (f.finding || '').split(/[\s,，。.]+/).filter((w: string) => w.length > 3);
    for (const w of words) {
      keywordMentions[w] = (keywordMentions[w] || 0) + 1;
    }
  }

  const crossDimensionPatterns: string[] = [];

  // 多维度引用的文件 = 跨维度热点
  for (const [file, count] of Object.entries(fileMentions)) {
    if ((count as number) >= 2) {
      crossDimensionPatterns.push(`文件 "${file}" 被 ${count} 个维度引用 — 可能是系统核心组件`);
    }
  }

  // 多维度提及的关键词
  for (const [word, count] of Object.entries(keywordMentions)) {
    if ((count as number) >= 3) {
      crossDimensionPatterns.push(`关键词 "${word}" 出现 ${count} 次 — 跨维度关联主题`);
    }
  }

  // 为下一 Tier 生成建议
  const suggestionsForNextTier: string[] = [];

  // 找出 gaps (各维度报告的未覆盖方面)
  for (const dimId of completedDimensions) {
    const report = sessionStore.getDimensionReport(dimId);
    const gaps = report?.digest?.gaps || [];
    for (const gap of gaps) {
      if (gap && typeof gap === 'string' && gap.length > 5) {
        suggestionsForNextTier.push(`[${dimId}] 未覆盖: ${gap}`);
      }
    }
  }

  // remainingTasks
  for (const dimId of completedDimensions) {
    const report = sessionStore.getDimensionReport(dimId);
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

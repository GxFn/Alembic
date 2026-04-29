import type { RescanBriefingInput } from '#workflows/capabilities/execution/external-agent/mission-briefing/MissionBriefingProfiles.js';
import type { ExternalRescanEvidencePlan } from '#workflows/capabilities/planning/knowledge/KnowledgeRescanPlanner.js';

export interface RescanEvidenceHints {
  allRecipes: ExternalRescanEvidencePlan['allRecipes'];
  rescanMode: true;
  dimensionGaps: ExternalRescanEvidencePlan['dimensionGaps'];
  executionReasons: ExternalRescanEvidencePlan['executionReasons'];
  evolutionPrescreen: {
    needsVerification: unknown[];
    autoResolved: unknown[];
    dimensionGapsByPrescreen: unknown;
  };
  evolutionGuide: {
    decayCount: number;
    totalCount: number;
    instructions: string;
  };
  constraints: {
    occupiedTriggers: string[];
    rules: string[];
  };
}

export function projectRescanEvidenceHints({
  evidencePlan,
  prescreen,
}: RescanBriefingInput): RescanEvidenceHints {
  return {
    allRecipes: evidencePlan.allRecipes,
    rescanMode: true,
    dimensionGaps: evidencePlan.dimensionGaps,
    executionReasons: evidencePlan.executionReasons,
    evolutionPrescreen: {
      needsVerification: prescreen.needsVerification,
      autoResolved: prescreen.autoResolved,
      dimensionGapsByPrescreen: prescreen.dimensionGaps,
    },
    evolutionGuide: {
      decayCount: evidencePlan.decayCount,
      totalCount: evidencePlan.allRecipes.length,
      instructions:
        evidencePlan.decayCount > 0
          ? `${evidencePlan.decayCount} 个 Recipe 标记为衰退，需优先验证。每个维度内先 evolve 再补齐。`
          : '所有 Recipe 状态健康，快速确认后补齐新知识。',
    },
    constraints: {
      occupiedTriggers: evidencePlan.occupiedTriggers,
      rules: [
        '禁止提交 occupiedTriggers 列表中已存在的 trigger',
        '每个维度的补齐数量参考 dimensionGaps[].gap，gap=0 的维度可以跳过或只提交真正的新发现',
        '专注于尚未覆盖的新模式，不要重复已有知识的内容',
      ],
    },
  };
}

import type { DimensionDef } from '#types/project-snapshot.js';
import type {
  BriefingProfile,
  RescanBriefingInput,
} from '#workflows/common-capabilities/agent-execution/mission-briefing/MissionBriefingProfiles.js';
import { TierScheduler } from '#workflows/common-capabilities/dimension-planning/TierScheduler.js';

export interface ExecutionPlanTier {
  tier: number;
  label: string;
  dimensions: string[];
  note: string;
}

export interface ExecutionInstructions {
  tiers: ExecutionPlanTier[];
  totalDimensions: number;
  workflow: string;
}

export function buildExecutionInstructions({
  activeDimensions,
  profile,
  rescan,
}: {
  activeDimensions: DimensionDef[];
  profile: BriefingProfile;
  rescan?: RescanBriefingInput;
}): ExecutionInstructions {
  return {
    tiers: buildExecutionTiers(activeDimensions),
    totalDimensions: activeDimensions.length,
    workflow: buildWorkflowInstruction({ profile, rescan }),
  };
}

function buildExecutionTiers(activeDimensions: DimensionDef[]): ExecutionPlanTier[] {
  const scheduler = new TierScheduler();
  const tiers = scheduler.getTiers();
  const activeDimIds = new Set(activeDimensions.map((dimension) => dimension.id));

  const tierLabels = [
    '基础数据层',
    '规范 + 设计 + 网络',
    '核心质量',
    '领域专项',
    '终端优化 + 总结',
  ];
  const tierNotes = [
    '这些维度相互独立，可以任意顺序分析。产出的上下文将帮助后续维度。',
    '建议利用 Tier 1 中了解到的项目结构和代码特征。',
    '利用前两层建立的架构和规范上下文深入分析。',
    '各维度相对独立，可充分利用并行能力。',
    'agent-guidelines 应综合前序所有维度的发现。',
  ];

  const plan = tiers
    .map((tierDimIds, index) => {
      const filteredDims = tierDimIds.filter((id) => activeDimIds.has(id));
      if (filteredDims.length === 0) {
        return null;
      }
      return {
        tier: index + 1,
        label: tierLabels[index] || `Tier ${index + 1}`,
        dimensions: filteredDims,
        note: tierNotes[index] || '',
      };
    })
    .filter((tier): tier is ExecutionPlanTier => tier !== null);

  const scheduledIds = new Set(tiers.flat());
  const unscheduled = activeDimensions.filter((dimension) => !scheduledIds.has(dimension.id));
  if (unscheduled.length > 0 && plan.length > 0) {
    for (const dimension of unscheduled) {
      const hint = typeof dimension.tierHint === 'number' ? dimension.tierHint : 1;
      const targetIdx = Math.max(0, Math.min(hint - 1, plan.length - 1));
      plan[targetIdx]?.dimensions.push(dimension.id);
    }
  }

  return plan;
}

function buildWorkflowInstruction({
  profile,
  rescan,
}: {
  profile: BriefingProfile;
  rescan?: RescanBriefingInput;
}): string {
  if (profile === 'rescan-external') {
    const needsVerification = rescan?.prescreen.needsVerification.length ?? 0;
    const autoResolved = rescan?.prescreen.autoResolved.length ?? 0;
    return (
      '【增量扫描模式 — 进化前置 + 按维度 Gap-Fill】 ' +
      'Step 0 — 自动前置过滤 (已完成): ' +
      `healthy 无修改的 Recipe 已自动 skip (${autoResolved} 条)，` +
      `仅 ${needsVerification} 条需要验证。 ` +
      '对每个维度 (按 tiers 顺序): ' +
      'Step 1 — Evolve (仅 needsVerification 中的 Recipe): ' +
      '读 sourceRefs 源码验证 → 调用 alembic_evolve({ decisions: [本维度决策] }) → ' +
      'Step 2 — Gap-Fill: ' +
      '分析代码发现新模式 → 调用 alembic_submit_knowledge 提交 (数量参考 gap 值) → ' +
      'Step 3 — Complete: 调用 alembic_dimension_complete 完成维度'
    );
  }

  return '对每个维度: (1) 用你的原生能力阅读代码分析 → (2) 调用 alembic_submit_knowledge_batch 批量提交候选（**每维度最少 3 条，目标 5 条**，将不同关注点拆分为独立候选，1-2 条视为不合格） → (3) 调用 alembic_dimension_complete 完成维度（必须传 referencedFiles=[分析过的文件路径] 和 keyFindings=[3-5条关键发现]）';
}

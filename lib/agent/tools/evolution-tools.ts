/**
 * evolution-tools.ts — Evolution Agent 专用工具
 *
 * 两个轻量级决策工具，供 Evolution Agent 在 rescan 时对衰退 Recipe 做出明确决策：
 *   - confirm_deprecation: 确认 Recipe 应被废弃（加速 deprecate 流程）
 *   - skip_evolution: 显式跳过进化决策（信息不足）
 *
 * @module agent/tools/evolution-tools
 */

import type { ProposalRepository } from '../../repository/evolution/ProposalRepository.js';
import type { ToolHandlerContext } from './_shared.js';

// ── Param types ──────────────────────────────────────────

interface ConfirmDeprecationParams {
  recipeId: string;
  reason: string;
}

interface SkipEvolutionParams {
  recipeId: string;
  reason: string;
}

// ──────────────────────────────────────────────────────────
// confirm_deprecation — 确认 Recipe 应被废弃
// ──────────────────────────────────────────────────────────

export const confirmDeprecation = {
  name: 'confirm_deprecation',
  description: '确认一个衰退 Recipe 应被废弃（加速废弃流程，跳过观察窗口）',
  parameters: {
    type: 'object',
    properties: {
      recipeId: { type: 'string', description: '要废弃的 Recipe ID' },
      reason: { type: 'string', description: '废弃原因（人类可读）' },
    },
    required: ['recipeId', 'reason'],
  },
  handler: async (params: ConfirmDeprecationParams, ctx: ToolHandlerContext) => {
    const { recipeId, reason } = params;

    // 1. 通过 knowledgeService 将 lifecycle 转为 deprecated
    const knowledgeService = ctx.container.get('knowledgeService') as {
      deprecate(id: string, reason: string, opts: { userId: string }): unknown;
    };
    const result = knowledgeService.deprecate(recipeId, reason, { userId: 'evolution-agent' });

    // 2. 尝试解决关联的 deprecate proposal（status → executed）
    try {
      const proposalRepo = ctx.container.get('proposalRepository') as ProposalRepository | null;
      if (proposalRepo) {
        const existing = proposalRepo.findByTarget(recipeId);
        for (const p of existing) {
          if (p.type === 'deprecate') {
            proposalRepo.markExecuted(
              p.id,
              `Evolution Agent confirmed deprecation: ${reason}`,
              'evolution-agent'
            );
          }
        }
      }
    } catch {
      // ProposalRepository 不可用时静默失败
    }

    return { status: 'deprecated', recipeId, reason, result };
  },
};

// ──────────────────────────────────────────────────────────
// skip_evolution — 显式跳过进化决策
// ──────────────────────────────────────────────────────────

export const skipEvolution = {
  name: 'skip_evolution',
  description: '显式跳过一个 Recipe 的进化决策（信息不足或不紧急，交给时限机制处理）',
  parameters: {
    type: 'object',
    properties: {
      recipeId: { type: 'string', description: '跳过的 Recipe ID' },
      reason: { type: 'string', description: '跳过原因' },
    },
    required: ['recipeId', 'reason'],
  },
  handler: async (params: SkipEvolutionParams, _ctx: ToolHandlerContext) => {
    // 不修改 proposal 状态，仅记录决策
    return { status: 'skipped', recipeId: params.recipeId, reason: params.reason };
  },
};

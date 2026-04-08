/**
 * evolution-tools.ts — Evolution Agent 专用工具
 *
 * 三个提案驱动的决策工具，供 Evolution Agent 在 rescan 时对现有 Recipe 做出明确决策：
 *   - propose_evolution: 附加进化提案（代码已变但知识仍有价值）
 *   - confirm_deprecation: 确认 Recipe 应被废弃（加速 deprecate 流程）
 *   - skip_evolution: 显式跳过进化决策（仍然有效或信息不足）
 *
 * @module agent/tools/evolution-tools
 */

import type { ProposalRepository } from '../../repository/evolution/ProposalRepository.js';
import type { ToolHandlerContext } from './_shared.js';

// ── Param types ──────────────────────────────────────────

export interface ProposeEvolutionParams {
  recipeId: string;
  type: 'enhance' | 'correction';
  description: string;
  evidence: {
    sourceStatus: 'exists' | 'moved' | 'modified' | 'deleted';
    currentCode?: string;
    newLocation?: string;
    suggestedChanges: string;
  };
  confidence: number;
}

interface ConfirmDeprecationParams {
  recipeId: string;
  reason: string;
}

interface SkipEvolutionParams {
  recipeId: string;
  reason: string;
}

// ──────────────────────────────────────────────────────────
// propose_evolution — 为现有 Recipe 附加进化提案
// ──────────────────────────────────────────────────────────

export const proposeEvolution = {
  name: 'propose_evolution',
  description: '为现有 Recipe 附加进化提案（代码已变化但知识仍有价值时使用，不创建新 Recipe）',
  parameters: {
    type: 'object',
    properties: {
      recipeId: { type: 'string', description: '目标 Recipe ID' },
      type: {
        type: 'string',
        enum: ['enhance', 'correction'],
        description:
          '提案类型: enhance=增强补充（代码迁移/扩展）, correction=纠正错误（代码变更导致描述不准确）',
      },
      description: {
        type: 'string',
        description: '描述发生了什么变化、为什么需要更新（人类可读）',
      },
      evidence: {
        type: 'object',
        description: '代码验证证据',
        properties: {
          sourceStatus: {
            type: 'string',
            enum: ['exists', 'moved', 'modified', 'deleted'],
            description:
              '源文件状态: exists=存在但内容变化, moved=迁移到新位置, modified=签名/结构变化, deleted=已删除但有替代',
          },
          currentCode: {
            type: 'string',
            description: '当前实际代码片段（验证时读到的）',
          },
          newLocation: {
            type: 'string',
            description: '新文件路径（仅 moved 时填写）',
          },
          suggestedChanges: {
            type: 'string',
            description: '建议对 Recipe 做出的具体更新',
          },
        },
        required: ['sourceStatus', 'suggestedChanges'],
      },
      confidence: {
        type: 'number',
        description: '置信度 0.0-1.0（基于代码验证的确定程度）',
      },
    },
    required: ['recipeId', 'type', 'description', 'evidence', 'confidence'],
  },
  handler: async (params: ProposeEvolutionParams, ctx: ToolHandlerContext) => {
    const { recipeId, type, description, evidence, confidence } = params;

    // 通过 ProposalRepository 创建提案
    const proposalRepo = ctx.container.get('proposalRepository') as ProposalRepository | null;
    if (!proposalRepo) {
      return {
        status: 'error' as const,
        message: 'ProposalRepository not available',
        recipeId,
      };
    }

    const proposal = proposalRepo.create({
      type,
      targetRecipeId: recipeId,
      relatedRecipeIds: [],
      confidence: Math.max(0, Math.min(1, confidence)),
      source: 'decay-scan',
      description,
      evidence: [
        {
          sourceStatus: evidence.sourceStatus,
          currentCode: evidence.currentCode,
          newLocation: evidence.newLocation,
          suggestedChanges: evidence.suggestedChanges,
          verifiedBy: 'evolution-agent',
          verifiedAt: Date.now(),
        },
      ],
    });

    if (!proposal) {
      return {
        status: 'error' as const,
        message: 'Failed to create proposal (target recipe may not exist or duplicate proposal)',
        recipeId,
      };
    }

    return {
      status: 'proposed' as const,
      proposalId: proposal.id,
      recipeId,
      type,
      expiresAt: proposal.expiresAt,
    };
  },
};

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

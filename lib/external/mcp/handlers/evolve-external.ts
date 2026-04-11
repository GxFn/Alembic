/**
 * MCP Handler — autosnippet_evolve (批量 Recipe 进化决策)
 *
 * 双入口工具：
 *   - Rescan 模式: 每个维度内先 evolve 再 gap-fill，与内部 Agent Pipeline 一致
 *   - 独立模式: 用户通过提示词触发，验证已有 Recipe 的有效性
 *
 * 三种决策委托给 evolution-tools.ts 中已有的 handler 实现：
 *   - propose_evolution → ProposalRepository.create (观察窗口)
 *   - confirm_deprecation → RecipeLifecycleSupervisor.transition → deprecated (优先) / KnowledgeService.deprecate (回退)
 *   - skip → 不变更状态，skip(still_valid) 刷新 stats.lastVerifiedAt
 *
 * @module handlers/evolve-external
 */

import type { ServiceContainer } from '#inject/ServiceContainer.js';
import type { ProposalRepository } from '#repo/evolution/ProposalRepository.js';
import { getDeveloperIdentity } from '#shared/developer-identity.js';
import type { EvolveInput } from '#shared/schemas/mcp-tools.js';
import type { RecipeLifecycleSupervisor } from '../../../service/evolution/RecipeLifecycleSupervisor.js';
import { envelope } from '../envelope.js';

/** MCP handler context */

/** MCP handler context */
interface McpContext {
  container: ServiceContainer;
  logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
  startedAt?: number;
  [key: string]: unknown;
}

// ── 返回类型 ─────────────────────────────────────────────

interface EvolveResult {
  processed: number;
  proposed: number;
  deprecated: number;
  skipped: number;
  refreshed: number;
  quotaChange: { freed: number; occupied: number };
  errors: Array<{ recipeId: string; error: string }>;
}

// ── 主入口 ─────────────────────────────────────────────────

export async function evolveExternal(ctx: McpContext, args: EvolveInput) {
  const t0 = Date.now();
  const { decisions } = args;

  if (!decisions || decisions.length === 0) {
    return envelope({
      success: true,
      data: {
        processed: 0,
        proposed: 0,
        deprecated: 0,
        skipped: 0,
        refreshed: 0,
        quotaChange: { freed: 0, occupied: 0 },
        errors: [],
      },
      message: '⚠️ 没有提交任何 evolve 决策',
      meta: { tool: 'autosnippet_evolve', responseTimeMs: Date.now() - t0 },
    });
  }

  const result: EvolveResult = {
    processed: 0,
    proposed: 0,
    deprecated: 0,
    skipped: 0,
    refreshed: 0,
    quotaChange: { freed: 0, occupied: 0 },
    errors: [],
  };

  const proposalRepo = ctx.container.get('proposalRepository') as ProposalRepository | null;
  const knowledgeService = ctx.container.get('knowledgeService') as {
    deprecate(id: string, reason: string, opts: { userId: string }): Promise<unknown>;
  } | null;
  const supervisor = ctx.container.get('lifecycleSupervisor') as RecipeLifecycleSupervisor | null;
  const knowledgeRepo = ctx.container.get('knowledgeRepository') as {
    findById(id: string): Promise<{ id: string } | null>;
    updateStats(id: string, stats: Record<string, unknown>): Promise<boolean>;
    getStats(): Promise<Record<string, number>>;
  } | null;

  for (const decision of decisions) {
    try {
      // O4: Recipe 存在性前置检查
      if (knowledgeRepo) {
        const exists = await knowledgeRepo.findById(decision.recipeId);
        if (!exists) {
          result.errors.push({ recipeId: decision.recipeId, error: 'Recipe not found' });
          result.processed++;
          continue;
        }
      }

      switch (decision.action) {
        case 'propose_evolution': {
          if (!proposalRepo) {
            result.errors.push({
              recipeId: decision.recipeId,
              error: 'ProposalRepository not available',
            });
            break;
          }
          if (!decision.evidence) {
            result.errors.push({
              recipeId: decision.recipeId,
              error: 'evidence is required for propose_evolution',
            });
            break;
          }

          const proposal = proposalRepo.create({
            type: decision.evidence.type,
            targetRecipeId: decision.recipeId,
            relatedRecipeIds: [],
            confidence: 0.8,
            source: 'ide-agent',
            description: decision.evidence.suggestedChanges,
            evidence: [
              {
                sourceStatus: 'modified',
                currentCode: decision.evidence.codeSnippet,
                filePath: decision.evidence.filePath,
                suggestedChanges: decision.evidence.suggestedChanges,
                verifiedBy: 'ide-agent',
                verifiedAt: Date.now(),
              },
            ],
          });

          if (proposal) {
            result.proposed++;
            ctx.logger.info(
              `[Evolve] propose_evolution: ${decision.recipeId} → proposal ${proposal.id}`
            );
          } else {
            result.errors.push({
              recipeId: decision.recipeId,
              error:
                'Failed to create proposal (target recipe may not exist or duplicate proposal)',
            });
          }
          break;
        }

        case 'confirm_deprecation': {
          // O1: 优先通过 RecipeLifecycleSupervisor 执行，回退到 KnowledgeService
          const reason = decision.reason || 'IDE Agent confirmed deprecation';

          if (supervisor) {
            const transResult = await supervisor.transition({
              recipeId: decision.recipeId,
              targetState: 'deprecated',
              trigger: 'manual-deprecation',
              evidence: { reason },
              operatorId: 'ide-agent',
            });

            if (!transResult.success) {
              // Supervisor 拒绝（可能状态不允许直接转 deprecated），回退到 KnowledgeService
              if (knowledgeService) {
                await knowledgeService.deprecate(decision.recipeId, reason, {
                  userId: getDeveloperIdentity(),
                });
              } else {
                result.errors.push({
                  recipeId: decision.recipeId,
                  error: `Supervisor rejected: ${transResult.error}`,
                });
                break;
              }
            }
          } else if (knowledgeService) {
            // P3: 添加 await
            await knowledgeService.deprecate(decision.recipeId, reason, {
              userId: getDeveloperIdentity(),
            });
          } else {
            result.errors.push({
              recipeId: decision.recipeId,
              error: 'Neither Supervisor nor KnowledgeService available',
            });
            break;
          }

          // 解决关联的 deprecate proposal
          if (proposalRepo) {
            try {
              const existing = proposalRepo.findByTarget(decision.recipeId);
              for (const p of existing) {
                if (p.type === 'deprecate') {
                  proposalRepo.markExecuted(
                    p.id,
                    `IDE Agent confirmed deprecation: ${reason}`,
                    'ide-agent'
                  );
                }
              }
            } catch {
              // ProposalRepository 操作失败时静默
            }
          }

          result.deprecated++;
          result.quotaChange.freed++;
          ctx.logger.info(`[Evolve] confirm_deprecation: ${decision.recipeId}`);
          break;
        }

        case 'skip': {
          if (decision.skipReason === 'still_valid' && knowledgeRepo) {
            // P4: 更新 stats.lastVerifiedAt 而非 updated_at
            try {
              const entry = await knowledgeRepo.findById(decision.recipeId);
              if (entry) {
                const stats = (
                  typeof (entry as Record<string, unknown>).stats === 'object'
                    ? (entry as Record<string, unknown>).stats
                    : {}
                ) as Record<string, unknown>;
                stats.lastVerifiedAt = Date.now();
                await knowledgeRepo.updateStats(decision.recipeId, stats);
              }
              result.refreshed++;
            } catch {
              // DB 更新失败时静默
            }
          }
          result.skipped++;
          ctx.logger.info(
            `[Evolve] skip: ${decision.recipeId} (${decision.skipReason || 'no reason'})`
          );
          break;
        }

        default: {
          result.errors.push({
            recipeId: decision.recipeId,
            error: `Unknown action: ${(decision as { action: string }).action}`,
          });
        }
      }
      result.processed++;
    } catch (err: unknown) {
      result.errors.push({
        recipeId: decision.recipeId,
        error: err instanceof Error ? err.message : String(err),
      });
      result.processed++;
    }
  }

  const parts: string[] = [];
  if (result.proposed > 0) {
    parts.push(`${result.proposed} 个进化提案`);
  }
  if (result.deprecated > 0) {
    parts.push(`${result.deprecated} 个废弃`);
  }
  if (result.refreshed > 0) {
    parts.push(`${result.refreshed} 个仍然有效`);
  }
  if (result.skipped - result.refreshed > 0) {
    parts.push(`${result.skipped - result.refreshed} 个跳过`);
  }

  const summary = parts.length > 0 ? parts.join(', ') : '无变更';

  return envelope({
    success: true,
    data: result,
    message:
      `✅ 处理了 ${result.processed} 个 Recipe: ${summary}` +
      (result.errors.length > 0 ? ` (${result.errors.length} 个错误)` : ''),
    meta: { tool: 'autosnippet_evolve', responseTimeMs: Date.now() - t0 },
  });
}

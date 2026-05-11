/**
 * MCP Handler — alembic_consolidate (语义融合审查决策)
 *
 * 处理 Agent 对 pendingSemanticReview 条目的决策：
 *   - keep    → 无操作（Recipe 保留原样）
 *   - merge   → EvolutionGateway.submit({ action: 'update' }) + deprecate 新 Recipe
 *   - reject  → EvolutionGateway.submit({ action: 'deprecate' })
 *
 * @module handlers/consolidate
 */

import type { ServiceContainer } from '#inject/ServiceContainer.js';
import type { ConsolidateInput } from '#shared/schemas/mcp-tools.js';
import type { EvolutionGateway } from '../../../service/evolution/EvolutionGateway.js';
import { envelope } from '../envelope.js';

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

interface ConsolidateResult {
  processed: number;
  kept: number;
  merged: number;
  rejected: number;
  errors: Array<{ newRecipeId: string; error: string }>;
}

// ── 主入口 ─────────────────────────────────────────────────

export async function consolidateHandler(ctx: McpContext, args: ConsolidateInput) {
  const t0 = Date.now();
  const { decisions } = args;

  if (!decisions || decisions.length === 0) {
    return envelope({
      success: true,
      data: {
        processed: 0,
        kept: 0,
        merged: 0,
        rejected: 0,
        errors: [],
      },
      message: '⚠️ 没有提交任何 consolidate 决策',
      meta: { tool: 'alembic_consolidate', responseTimeMs: Date.now() - t0 },
    });
  }

  const gateway = ctx.container.get('evolutionGateway') as EvolutionGateway | null;
  if (!gateway) {
    return envelope({
      success: false,
      errorCode: 'SERVICE_UNAVAILABLE',
      message: 'EvolutionGateway 不可用，无法处理 consolidate 决策。',
      data: { processed: 0, kept: 0, merged: 0, rejected: 0, errors: [] },
      meta: { tool: 'alembic_consolidate', responseTimeMs: Date.now() - t0 },
    });
  }

  const result: ConsolidateResult = {
    processed: 0,
    kept: 0,
    merged: 0,
    rejected: 0,
    errors: [],
  };

  for (const decision of decisions) {
    result.processed++;
    try {
      switch (decision.action) {
        case 'keep': {
          // 无操作 — Recipe 保留原样
          result.kept++;
          ctx.logger.info(`[Consolidate] keep: ${decision.newRecipeId} — ${decision.reasoning}`);
          break;
        }

        case 'merge': {
          if (!decision.mergeTargetId) {
            result.errors.push({
              newRecipeId: decision.newRecipeId,
              error: 'action=merge requires mergeTargetId',
            });
            break;
          }

          // Step 1: 更新目标 Recipe（注入合并内容）
          const updateResult = await gateway.submit({
            recipeId: decision.mergeTargetId,
            action: 'update',
            source: 'consolidation',
            confidence: 0.8,
            description: `Consolidate merge: ${decision.reasoning}`,
            evidence: [
              {
                snapshotAt: Date.now(),
                sourceRecipeId: decision.newRecipeId,
                mergeStrategy: decision.mergeStrategy ?? 'complement',
                agentReasoning: decision.reasoning,
              },
            ],
          });

          // Step 2: 废弃新 Recipe（已合并到目标）
          if (!updateResult.error) {
            await gateway.submit({
              recipeId: decision.newRecipeId,
              action: 'deprecate',
              source: 'consolidation',
              confidence: 0.85,
              description: `Merged into ${decision.mergeTargetId}: ${decision.reasoning}`,
              evidence: [
                {
                  snapshotAt: Date.now(),
                  mergedInto: decision.mergeTargetId,
                },
              ],
              replacedByRecipeId: decision.mergeTargetId,
            });
            result.merged++;
          } else {
            result.errors.push({
              newRecipeId: decision.newRecipeId,
              error: `merge update failed: ${updateResult.error}`,
            });
          }

          ctx.logger.info(
            `[Consolidate] merge: ${decision.newRecipeId} → ${decision.mergeTargetId} (${decision.mergeStrategy ?? 'complement'})`
          );
          break;
        }

        case 'reject': {
          // 直接废弃新 Recipe
          const depResult = await gateway.submit({
            recipeId: decision.newRecipeId,
            action: 'deprecate',
            source: 'consolidation',
            confidence: 0.8,
            description: `Consolidate reject: ${decision.reasoning}`,
            evidence: [
              {
                snapshotAt: Date.now(),
                agentReasoning: decision.reasoning,
              },
            ],
          });

          if (!depResult.error) {
            result.rejected++;
          } else {
            result.errors.push({
              newRecipeId: decision.newRecipeId,
              error: `reject deprecate failed: ${depResult.error}`,
            });
          }

          ctx.logger.info(`[Consolidate] reject: ${decision.newRecipeId} — ${decision.reasoning}`);
          break;
        }
      }
    } catch (err: unknown) {
      result.errors.push({
        newRecipeId: decision.newRecipeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const hasErrors = result.errors.length > 0;
  return envelope({
    success: !hasErrors || result.processed > result.errors.length,
    data: result,
    message:
      `处理 ${result.processed} 条 consolidate 决策: ` +
      `${result.kept} 保留, ${result.merged} 合并, ${result.rejected} 拒绝` +
      (hasErrors ? `, ${result.errors.length} 错误` : '') +
      '。',
    meta: { tool: 'alembic_consolidate', responseTimeMs: Date.now() - t0 },
  });
}

/**
 * MCP Handler — alembic_evolve (批量 Recipe 进化决策)
 *
 * 所有决策统一通过 EvolutionGateway 提交：
 *   - propose_evolution → gateway.submit({ action: 'update' })
 *   - confirm_deprecation → gateway.submit({ action: 'deprecate' })
 *   - skip → gateway.submit({ action: 'valid' }) 或直接 skip
 *
 * @module handlers/evolve-external
 */

import type { ServiceContainer } from '#inject/ServiceContainer.js';
import type { EvolveInput } from '#shared/schemas/mcp-tools.js';
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
      meta: { tool: 'alembic_evolve', responseTimeMs: Date.now() - t0 },
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

  const gateway = ctx.container.get('evolutionGateway') as EvolutionGateway | null;
  if (!gateway) {
    return envelope({
      success: false,
      data: result,
      message: '❌ EvolutionGateway not available',
      meta: { tool: 'alembic_evolve', responseTimeMs: Date.now() - t0 },
    });
  }

  for (const decision of decisions) {
    try {
      switch (decision.action) {
        case 'propose_evolution': {
          if (!decision.evidence) {
            result.errors.push({
              recipeId: decision.recipeId,
              error: 'evidence is required for propose_evolution',
            });
            break;
          }

          const gResult = await gateway.submit({
            recipeId: decision.recipeId,
            action: 'update',
            source: 'ide-agent',
            confidence: 0.8,
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

          if (gResult.outcome === 'proposal-created' || gResult.outcome === 'proposal-upgraded') {
            result.proposed++;
            ctx.logger.info(
              `[Evolve] propose_evolution: ${decision.recipeId} → ${gResult.outcome} ${gResult.proposalId}`
            );
          } else {
            result.errors.push({
              recipeId: decision.recipeId,
              error: gResult.error ?? `Unexpected outcome: ${gResult.outcome}`,
            });
          }
          break;
        }

        case 'confirm_deprecation': {
          const reason = decision.reason || 'IDE Agent confirmed deprecation';

          const gResult = await gateway.submit({
            recipeId: decision.recipeId,
            action: 'deprecate',
            source: 'ide-agent',
            confidence: 0.9,
            reason,
          });

          if (
            gResult.outcome === 'immediately-executed' ||
            gResult.outcome === 'proposal-created'
          ) {
            result.deprecated++;
            result.quotaChange.freed++;
            ctx.logger.info(`[Evolve] confirm_deprecation: ${decision.recipeId}`);
          } else {
            result.errors.push({
              recipeId: decision.recipeId,
              error: gResult.error ?? `Unexpected outcome: ${gResult.outcome}`,
            });
          }
          break;
        }

        case 'skip': {
          if (decision.skipReason === 'still_valid') {
            const gResult = await gateway.submit({
              recipeId: decision.recipeId,
              action: 'valid',
              source: 'ide-agent',
              confidence: 0.5,
              reason: decision.skipReason,
            });

            if (gResult.outcome === 'verified') {
              result.refreshed++;
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
    meta: { tool: 'alembic_evolve', responseTimeMs: Date.now() - t0 },
  });
}

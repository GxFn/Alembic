/**
 * MCP Handler — alembic_panorama
 *
 * Project panorama query tool with 8 operations:
 *   overview — project skeleton + layers + module roles
 *   module   — single module detail + neighbors + recipes + file groups
 *   gaps     — knowledge gaps (code without Recipes)
 *   health   — panorama health (coverage + coupling + cycles)
 *   governance_cycle       — full metabolism cycle (contradiction + redundancy + decay)
 *   decay_report           — decay assessment report
 *   staging_check          — staging entry check + auto-publish
 *   enhancement_suggestions — usage-data-based enhancement suggestions
 *
 * All read-only except governance_cycle and staging_check (which perform state transitions).
 */

import { envelope } from '../envelope.js';
import type { McpContext } from './types.js';

interface PanoramaArgs {
  operation?: string;
  module?: string;
}

/**
 * alembic_panorama — unified panorama query
 */
export async function panoramaHandler(ctx: McpContext, args: PanoramaArgs) {
  const op = args.operation || 'overview';

  const panoramaService = ctx.container.get('panoramaService') as
    | {
        ensureData(): Promise<void>;
        getOverview(): unknown;
        getModule(name: string): unknown;
        getGaps(): unknown;
        getHealth(): unknown;
      }
    | undefined;

  if (!panoramaService) {
    return envelope({
      success: false,
      message: 'Panorama service not initialized',
      meta: { tool: 'alembic_panorama' },
    });
  }

  // Auto-ensure data is ready (triggers built-in scan when no data exists)
  await panoramaService.ensureData();

  switch (op) {
    case 'overview': {
      const overview = await panoramaService.getOverview();
      return envelope({
        success: true,
        data: overview,
        meta: { tool: 'alembic_panorama' },
      });
    }

    case 'module': {
      const moduleName = args.module;
      if (!moduleName) {
        return envelope({
          success: false,
          message: 'operation=module requires the "module" parameter (module name)',
          meta: { tool: 'alembic_panorama' },
        });
      }
      const detail = await panoramaService.getModule(moduleName);
      if (!detail) {
        return envelope({
          success: false,
          message: `Module not found: ${moduleName}`,
          meta: { tool: 'alembic_panorama' },
        });
      }
      return envelope({
        success: true,
        data: detail,
        meta: { tool: 'alembic_panorama' },
      });
    }

    case 'gaps': {
      const gaps = await panoramaService.getGaps();
      return envelope({
        success: true,
        data: { gaps },
        meta: { tool: 'alembic_panorama' },
      });
    }

    case 'health': {
      const health = await panoramaService.getHealth();
      return envelope({
        success: true,
        data: health,
        meta: { tool: 'alembic_panorama' },
      });
    }

    default:
      // ── Governance operations (independent of panoramaService) ──
      return handleGovernanceOps(ctx, op);
  }
}

/* ────────────────────── Governance Handlers ────────────────────── */

async function handleGovernanceOps(ctx: McpContext, op: string) {
  switch (op) {
    case 'governance_cycle': {
      return envelope({
        success: false,
        message: 'KnowledgeMetabolism has been removed. Use rescan for governance.',
        meta: { tool: 'alembic_panorama', operation: 'governance_cycle' },
      });
    }

    case 'decay_report': {
      const decayDetector = ctx.container.get('decayDetector') as
        | { scanAll(): unknown }
        | undefined;

      if (!decayDetector) {
        return envelope({
          success: false,
          message: 'Decay detector not initialized (decayDetector not registered)',
          meta: { tool: 'alembic_panorama' },
        });
      }

      const results = await decayDetector.scanAll();
      return envelope({
        success: true,
        data: { results },
        meta: { tool: 'alembic_panorama', operation: 'decay_report' },
      });
    }

    case 'staging_check': {
      const stagingManager = ctx.container.get('stagingManager') as
        | { checkAndPromote(): unknown; listStaging(): unknown }
        | undefined;

      if (!stagingManager) {
        return envelope({
          success: false,
          message: 'Staging manager not initialized (stagingManager not registered)',
          meta: { tool: 'alembic_panorama' },
        });
      }

      const checkResult = await stagingManager.checkAndPromote();
      const currentStaging = await stagingManager.listStaging();
      return envelope({
        success: true,
        data: { checkResult, currentStaging },
        meta: { tool: 'alembic_panorama', operation: 'staging_check' },
      });
    }

    case 'enhancement_suggestions': {
      const suggester = ctx.container.get('enhancementSuggester') as
        | { analyzeAll(): unknown }
        | undefined;

      if (!suggester) {
        return envelope({
          success: false,
          message: 'Enhancement suggester not initialized (enhancementSuggester not registered)',
          meta: { tool: 'alembic_panorama' },
        });
      }

      const suggestions = await suggester.analyzeAll();
      return envelope({
        success: true,
        data: { suggestions },
        meta: { tool: 'alembic_panorama', operation: 'enhancement_suggestions' },
      });
    }

    default:
      throw new Error(
        `Unknown panorama operation: ${op}. Expected: overview, module, gaps, health, governance_cycle, decay_report, staging_check, enhancement_suggestions`
      );
  }
}

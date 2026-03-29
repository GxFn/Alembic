/**
 * MCP Handler — autosnippet_panorama
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
 * autosnippet_panorama — unified panorama query
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
      meta: { tool: 'autosnippet_panorama' },
    });
  }

  // Auto-ensure data is ready (triggers built-in scan when no data exists)
  await panoramaService.ensureData();

  switch (op) {
    case 'overview': {
      const overview = panoramaService.getOverview();
      return envelope({
        success: true,
        data: overview,
        meta: { tool: 'autosnippet_panorama' },
      });
    }

    case 'module': {
      const moduleName = args.module;
      if (!moduleName) {
        return envelope({
          success: false,
          message: 'operation=module requires the "module" parameter (module name)',
          meta: { tool: 'autosnippet_panorama' },
        });
      }
      const detail = panoramaService.getModule(moduleName);
      if (!detail) {
        return envelope({
          success: false,
          message: `Module not found: ${moduleName}`,
          meta: { tool: 'autosnippet_panorama' },
        });
      }
      return envelope({
        success: true,
        data: detail,
        meta: { tool: 'autosnippet_panorama' },
      });
    }

    case 'gaps': {
      const gaps = panoramaService.getGaps();
      return envelope({
        success: true,
        data: { gaps },
        meta: { tool: 'autosnippet_panorama' },
      });
    }

    case 'health': {
      const health = panoramaService.getHealth();
      return envelope({
        success: true,
        data: health,
        meta: { tool: 'autosnippet_panorama' },
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
      const metabolism = ctx.container.get('knowledgeMetabolism') as
        | { runFullCycle(): unknown }
        | undefined;

      if (!metabolism) {
        return envelope({
          success: false,
          message: 'Governance service not initialized (knowledgeMetabolism not registered)',
          meta: { tool: 'autosnippet_panorama' },
        });
      }

      const report = metabolism.runFullCycle();
      return envelope({
        success: true,
        data: report,
        meta: { tool: 'autosnippet_panorama', operation: 'governance_cycle' },
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
          meta: { tool: 'autosnippet_panorama' },
        });
      }

      const results = decayDetector.scanAll();
      return envelope({
        success: true,
        data: { results },
        meta: { tool: 'autosnippet_panorama', operation: 'decay_report' },
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
          meta: { tool: 'autosnippet_panorama' },
        });
      }

      const checkResult = stagingManager.checkAndPromote();
      const currentStaging = stagingManager.listStaging();
      return envelope({
        success: true,
        data: { checkResult, currentStaging },
        meta: { tool: 'autosnippet_panorama', operation: 'staging_check' },
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
          meta: { tool: 'autosnippet_panorama' },
        });
      }

      const suggestions = suggester.analyzeAll();
      return envelope({
        success: true,
        data: { suggestions },
        meta: { tool: 'autosnippet_panorama', operation: 'enhancement_suggestions' },
      });
    }

    default:
      throw new Error(
        `Unknown panorama operation: ${op}. Expected: overview, module, gaps, health, governance_cycle, decay_report, staging_check, enhancement_suggestions`
      );
  }
}

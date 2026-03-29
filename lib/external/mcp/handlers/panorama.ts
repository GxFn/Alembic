/**
 * MCP Handler — autosnippet_panorama
 *
 * 项目全景查询工具，提供 8 个 operation：
 *   overview — 项目骨架 + 层级 + 模块角色
 *   module   — 单模块详情 + 邻居关系
 *   gaps     — 知识空白区 (有代码无 Recipe)
 *   health   — 全景健康度 (覆盖率 + 耦合度 + 循环)
 *   governance_cycle       — 新陈代谢完整周期 (矛盾+冗余+衰退)
 *   decay_report           — 衰退评估报告
 *   staging_check          — staging 条目检查 + 自动发布
 *   enhancement_suggestions — 基于使用数据的增强建议
 *
 * 全部为只读操作（governance_cycle 和 staging_check 除外，会执行状态转换）。
 */

import { envelope } from '../envelope.js';
import type { McpContext } from './types.js';

interface PanoramaArgs {
  operation?: string;
  module?: string;
}

/**
 * autosnippet_panorama — 统合全景查询
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
      message: '全景服务未初始化',
      meta: { tool: 'autosnippet_panorama' },
    });
  }

  // 自动确保数据就绪（无数据时触发内置扫描）
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
          message: 'operation=module 需要提供 module 参数（模块名称）',
          meta: { tool: 'autosnippet_panorama' },
        });
      }
      const detail = panoramaService.getModule(moduleName);
      if (!detail) {
        return envelope({
          success: false,
          message: `未找到模块: ${moduleName}`,
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
      // ── Governance operations (不依赖 panoramaService) ──
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
          message: '治理服务未初始化（knowledgeMetabolism 未注册）',
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
          message: '衰退检测器未初始化（decayDetector 未注册）',
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
          message: 'staging 管理器未初始化（stagingManager 未注册）',
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
          message: '增强建议器未初始化（enhancementSuggester 未注册）',
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

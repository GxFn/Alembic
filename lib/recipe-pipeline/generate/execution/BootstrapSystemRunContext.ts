import type { SystemRunContext } from '@alembic/agent/runtime';

/**
 * Bootstrap 的运行资源投影：项目/证据等大块事实仍由 strategyContext 持有。
 * 只裁剪顶层字段，不复制 Set、台账、计数盒或上下文实例，供两个真实构建入口共用。
 */
export function compactBootstrapSystemRunContext(
  systemRunContext: SystemRunContext
): SystemRunContext {
  return {
    scopeId: systemRunContext.scopeId,
    contextWindow: systemRunContext.contextWindow || null,
    tracker: systemRunContext.tracker || null,
    trace: systemRunContext.trace,
    activeContext: systemRunContext.activeContext,
    memoryCoordinator: systemRunContext.memoryCoordinator,
    sharedState: systemRunContext.sharedState,
    source: systemRunContext.source,
    outputType: systemRunContext.outputType,
    dimId: systemRunContext.dimId,
    dimensionId: systemRunContext.dimensionId,
    dimensionLabel: systemRunContext.dimensionLabel,
    projectLanguage: systemRunContext.projectLanguage,
    submitToolName: systemRunContext.submitToolName,
    pipelineType: systemRunContext.pipelineType,
    _computedBudget: systemRunContext._computedBudget,
    pcvStageNodeMap: systemRunContext.pcvStageNodeMap,
    pcvChainNodes: systemRunContext.pcvChainNodes,
    pcvStageNodeMapContract: systemRunContext.pcvStageNodeMapContract,
  };
}

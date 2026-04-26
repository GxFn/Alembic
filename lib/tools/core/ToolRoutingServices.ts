import type { ToolCallContext, ToolRoutingServiceContract } from '#tools/core/ToolCallContext.js';
import type { ToolRouterContract } from '#tools/core/ToolContracts.js';

export function createToolRoutingServiceContract(
  toolRouter: ToolRouterContract | null | undefined
): ToolRoutingServiceContract {
  return {
    toolRouter: toolRouter || null,
  };
}

export function resolveToolRouterFromContext(context: ToolCallContext): ToolRouterContract | null {
  const routed = context.serviceContracts?.toolRouting?.toolRouter;
  if (isToolRouterContract(routed)) {
    return routed;
  }
  return null;
}

function isToolRouterContract(value: unknown): value is ToolRouterContract {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as ToolRouterContract).execute === 'function' &&
    typeof (value as ToolRouterContract).executeChildCall === 'function' &&
    typeof (value as ToolRouterContract).explain === 'function'
  );
}

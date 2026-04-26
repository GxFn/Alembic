import Logger from '../../infrastructure/logging/Logger.js';
import type { ServiceContainer } from '../../injection/ServiceContainer.js';
import type { ToolExecutionRequest } from '../core/ToolContracts.js';
import type { ToolCapabilityManifest } from '../tools/CapabilityManifest.js';

export type DashboardOperationHandler = (request: ToolExecutionRequest) => Promise<unknown>;

const logger = Logger.getInstance();

export const DASHBOARD_OPERATION_IDS = {
  updateModuleMap: 'dashboard.update_module_map',
  rebuildSemanticIndex: 'dashboard.rebuild_semantic_index',
  scanProject: 'dashboard.scan_project',
  bootstrapProject: 'dashboard.bootstrap_project',
  cancelBootstrap: 'dashboard.cancel_bootstrap',
  rescanProject: 'dashboard.rescan_project',
} as const;

export const DASHBOARD_OPERATION_MANIFESTS: ToolCapabilityManifest[] = [
  manifest({
    id: DASHBOARD_OPERATION_IDS.updateModuleMap,
    title: 'Update Module Map',
    description: 'Refresh the project module map from Dashboard.',
    policyProfile: 'write',
  }),
  manifest({
    id: DASHBOARD_OPERATION_IDS.rebuildSemanticIndex,
    title: 'Rebuild Semantic Index',
    description: 'Rebuild the semantic vector index from Dashboard.',
    policyProfile: 'system',
    timeoutMs: 300_000,
  }),
  manifest({
    id: DASHBOARD_OPERATION_IDS.scanProject,
    title: 'Scan Project',
    description: 'Run a full project AI scan from Dashboard.',
    policyProfile: 'analysis',
    timeoutMs: 300_000,
  }),
  manifest({
    id: DASHBOARD_OPERATION_IDS.bootstrapProject,
    title: 'Bootstrap Project Knowledge',
    description: 'Start internal project bootstrap from Dashboard.',
    policyProfile: 'write',
    timeoutMs: 300_000,
  }),
  manifest({
    id: DASHBOARD_OPERATION_IDS.cancelBootstrap,
    title: 'Cancel Bootstrap Session',
    description: 'Cancel the active bootstrap or rescan background session from Dashboard.',
    policyProfile: 'write',
  }),
  manifest({
    id: DASHBOARD_OPERATION_IDS.rescanProject,
    title: 'Rescan Project Knowledge',
    description: 'Run internal project rescan from Dashboard.',
    policyProfile: 'write',
    timeoutMs: 300_000,
  }),
];

export const DASHBOARD_OPERATION_HANDLERS: Record<string, DashboardOperationHandler> = {
  [DASHBOARD_OPERATION_IDS.updateModuleMap]: updateModuleMap,
  [DASHBOARD_OPERATION_IDS.rebuildSemanticIndex]: rebuildSemanticIndex,
  [DASHBOARD_OPERATION_IDS.scanProject]: scanProject,
  [DASHBOARD_OPERATION_IDS.bootstrapProject]: bootstrapProject,
  [DASHBOARD_OPERATION_IDS.cancelBootstrap]: cancelBootstrap,
  [DASHBOARD_OPERATION_IDS.rescanProject]: rescanProject,
};

function manifest(input: {
  id: string;
  title: string;
  description: string;
  policyProfile: ToolCapabilityManifest['governance']['policyProfile'];
  timeoutMs?: number;
}): ToolCapabilityManifest {
  return {
    id: input.id,
    title: input.title,
    kind: 'dashboard-operation',
    description: input.description,
    owner: 'dashboard',
    lifecycle: 'active',
    surfaces: ['dashboard'],
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    risk: {
      sideEffect: true,
      dataAccess: 'project',
      writeScope: 'data-root',
      network: 'none',
      credentialAccess: 'none',
      requiresHumanConfirmation: 'on-risk',
      owaspTags: ['excessive-agency'],
    },
    execution: {
      adapter: 'dashboard',
      timeoutMs: input.timeoutMs || 60_000,
      maxOutputBytes: 256_000,
      abortMode: 'cooperative',
      cachePolicy: 'none',
      concurrency: 'single',
      artifactMode: 'inline',
    },
    governance: {
      gatewayAction: `dashboard:${input.id.split('.').at(-1) || input.id}`,
      gatewayResource: 'dashboard_operations',
      auditLevel: 'checkOnly',
      policyProfile: input.policyProfile,
      approvalPolicy: 'explain-then-run',
      allowedRoles: ['admin', 'developer', 'owner'],
      allowInComposer: false,
      allowInRemoteMcp: false,
      allowInNonInteractive: false,
    },
    evals: { required: false, cases: [] },
  };
}

async function updateModuleMap(request: ToolExecutionRequest) {
  const container = getContainer(request);
  const moduleService = container.get('moduleService') as {
    updateModuleMap(options: Record<string, unknown>): Promise<unknown>;
  };
  const result = await moduleService.updateModuleMap({
    aggressive: request.args.aggressive ?? true,
  });
  logger.info('Module map updated via dashboard router', { result });
  return result;
}

async function rebuildSemanticIndex(request: ToolExecutionRequest) {
  const container = getContainer(request);
  const manager = container.singletons?._aiProviderManager as { isMock?: boolean } | undefined;
  if (manager?.isMock) {
    return { error: 'AI Provider 未配置，当前为 Mock 模式。Embedding 不可用。' };
  }

  const clear = request.args.clear !== false;
  const force = Boolean(request.args.force ?? false);
  const vectorService = container.services.vectorService
    ? (container.get('vectorService') as unknown as {
        clear(): Promise<void>;
        fullBuild(options: Record<string, unknown>): Promise<BuildResultLike>;
      })
    : null;

  let result: Record<string, unknown>;
  if (vectorService) {
    if (clear) {
      await vectorService.clear();
    }
    const buildResult = await vectorService.fullBuild({ force });
    result = {
      scanned: buildResult.scanned,
      chunked: buildResult.chunked,
      embedded: buildResult.embedded,
      upserted: buildResult.upserted,
      skipped: buildResult.skipped,
      errors: buildResult.errors,
    };
  } else {
    const indexingPipeline = container.get('indexingPipeline') as {
      run(options: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    result = await indexingPipeline.run({ clear, force });
  }

  logger.info('Semantic index rebuilt via dashboard router', { result });
  return {
    scanned: result.scanned || 0,
    chunked: result.chunked || 0,
    embedded: result.embedded || 0,
    upserted: result.upserted || 0,
    skipped: result.skipped || 0,
    errors: result.errors || 0,
  };
}

async function scanProject(request: ToolExecutionRequest) {
  const container = getContainer(request);
  const moduleService = container.get('moduleService') as {
    load(): Promise<void>;
    scanProject(options: Record<string, unknown>): Promise<unknown>;
  };
  await moduleService.load();
  logger.info('Full project scan started via dashboard router');
  return moduleService.scanProject(
    (request.args.options as Record<string, unknown> | undefined) || {}
  );
}

async function bootstrapProject(request: ToolExecutionRequest) {
  const container = getContainer(request);
  const { bootstrapKnowledge } = await import('../../external/mcp/handlers/bootstrap-internal.js');
  const raw = await bootstrapKnowledge(
    { container, logger },
    {
      maxFiles: numberArg(request.args.maxFiles, 500),
      skipGuard: Boolean(request.args.skipGuard || false),
      contentMaxLines: numberArg(request.args.contentMaxLines, 120),
      loadSkills: true,
    }
  );
  const result = unwrapEnvelope(raw);
  return { ...asRecord(result), asyncFill: true };
}

async function cancelBootstrap(request: ToolExecutionRequest) {
  const container = getContainer(request);
  const taskManager = getOptionalService<{
    isRunning: boolean;
    abortSession(reason: string): void;
    getSessionStatus(): Record<string, unknown>;
  }>(container, 'bootstrapTaskManager');

  if (!taskManager) {
    return { message: 'No bootstrap task manager initialized' };
  }
  if (!taskManager.isRunning) {
    return { message: 'No active bootstrap session' };
  }

  const reason = (request.args.reason as string | undefined) || 'Cancelled by user via Dashboard';
  taskManager.abortSession(reason);
  logger.info('Bootstrap session cancelled via dashboard router', { reason });
  return taskManager.getSessionStatus();
}

async function rescanProject(request: ToolExecutionRequest) {
  const container = getContainer(request);
  const { rescanInternal } = await import('../../external/mcp/handlers/rescan-internal.js');
  logger.info('Rescan initiated via dashboard router', {
    reason: request.args.reason,
    dimensions: request.args.dimensions,
  });
  const raw = await rescanInternal(
    { container, logger },
    {
      reason: (request.args.reason as string | undefined) || 'dashboard-rescan',
      dimensions: Array.isArray(request.args.dimensions)
        ? request.args.dimensions.filter(
            (dimension): dimension is string => typeof dimension === 'string'
          )
        : undefined,
    }
  );
  return unwrapEnvelope(raw);
}

function getContainer(request: ToolExecutionRequest) {
  return request.context.services as ServiceContainer;
}

function getOptionalService<T>(container: ServiceContainer, name: string): T | null {
  try {
    return container.get(name) as T;
  } catch {
    return null;
  }
}

function unwrapEnvelope(raw: unknown) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (parsed && typeof parsed === 'object' && 'data' in parsed) {
    return (parsed as { data?: unknown }).data || parsed;
  }
  return parsed;
}

function asRecord(value: unknown) {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : { value };
}

function numberArg(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

interface BuildResultLike {
  scanned?: unknown;
  chunked?: unknown;
  embedded?: unknown;
  upserted?: unknown;
  skipped?: unknown;
  errors?: unknown;
}

import type { InternalToolHandlerContext } from './InternalToolHandler.js';
import type { ToolInfraServiceContract, ToolServiceLocator } from './ToolCallContext.js';

export interface KnowledgeGraphImpactServiceLike {
  getImpactAnalysis(id: string, type: string, maxDepth: number): unknown[];
}

export interface IndexingPipelineLike {
  run(options: { force: boolean; dryRun: boolean }): Promise<unknown> | unknown;
}

export interface AuditLoggerLike {
  getByActor(actor: string, limit: number): Promise<unknown> | unknown;
  getByAction(action: string, limit: number): Promise<unknown> | unknown;
  getStats(): Promise<unknown> | unknown;
}

export function createInfraServiceContract(services: ToolServiceLocator): ToolInfraServiceContract {
  return {
    getKnowledgeGraphService() {
      return resolveService(services, 'knowledgeGraphService');
    },
    getIndexingPipeline() {
      return resolveService(services, 'indexingPipeline');
    },
    getAuditLogger() {
      return resolveService(services, 'auditLogger');
    },
  };
}

export function resolveInfraServicesFromContext(
  context: InternalToolHandlerContext
): ToolInfraServiceContract {
  return (
    context.serviceContracts?.infra ||
    context.toolCallContext?.serviceContracts?.infra ||
    EMPTY_INFRA_SERVICE_CONTRACT
  );
}

const EMPTY_INFRA_SERVICE_CONTRACT: ToolInfraServiceContract = {
  getKnowledgeGraphService() {
    return null;
  },
  getIndexingPipeline() {
    return null;
  },
  getAuditLogger() {
    return null;
  },
};

export function requireKnowledgeGraphImpactService(
  services: ToolInfraServiceContract
): KnowledgeGraphImpactServiceLike {
  const service = services.getKnowledgeGraphService();
  if (!isKnowledgeGraphImpactService(service)) {
    throw new Error('Knowledge graph service is not available in internal tool context');
  }
  return service;
}

export function requireIndexingPipeline(services: ToolInfraServiceContract): IndexingPipelineLike {
  const service = services.getIndexingPipeline();
  if (!isIndexingPipeline(service)) {
    throw new Error('Indexing pipeline is not available in internal tool context');
  }
  return service;
}

export function requireAuditLogger(services: ToolInfraServiceContract): AuditLoggerLike {
  const service = services.getAuditLogger();
  if (!isAuditLogger(service)) {
    throw new Error('Audit logger is not available in internal tool context');
  }
  return service;
}

function resolveService(services: ToolServiceLocator, name: string): unknown | null {
  try {
    return services.get(name) || null;
  } catch {
    return null;
  }
}

function isKnowledgeGraphImpactService(value: unknown): value is KnowledgeGraphImpactServiceLike {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as KnowledgeGraphImpactServiceLike).getImpactAnalysis === 'function'
  );
}

function isIndexingPipeline(value: unknown): value is IndexingPipelineLike {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as IndexingPipelineLike).run === 'function'
  );
}

function isAuditLogger(value: unknown): value is AuditLoggerLike {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as AuditLoggerLike).getByActor === 'function' &&
    typeof (value as AuditLoggerLike).getByAction === 'function' &&
    typeof (value as AuditLoggerLike).getStats === 'function'
  );
}

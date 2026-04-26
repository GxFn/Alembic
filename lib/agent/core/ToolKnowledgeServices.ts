import type { InternalToolHandlerContext } from './InternalToolHandler.js';
import type { ToolKnowledgeServiceContract, ToolServiceLocator } from './ToolCallContext.js';

export interface KnowledgeServiceLike {
  search(query: string, options: Record<string, unknown>): Promise<unknown> | unknown;
  list(
    filters: Record<string, unknown>,
    options: Record<string, unknown>
  ): Promise<unknown> | unknown;
  get(id: string): Promise<unknown> | unknown;
  getStats(): Promise<unknown> | unknown;
}

export interface KnowledgeSearchEngineLike {
  search(query: string, options: Record<string, unknown>): Promise<unknown> | unknown;
}

export interface KnowledgeGraphServiceLike {
  getStats(): unknown;
  getRelated(id: string, type: string, relation: string): unknown;
  getEdges(id: string, type: string, direction: string): unknown;
}

export interface KnowledgeGraphMutationServiceLike {
  addEdge(
    fromId: string,
    fromType: string,
    toId: string,
    toType: string,
    relation: string,
    options: Record<string, unknown>
  ): Promise<unknown> | unknown;
}

export function createKnowledgeServiceContract(
  services: ToolServiceLocator
): ToolKnowledgeServiceContract {
  return {
    getKnowledgeService() {
      return resolveService(services, 'knowledgeService');
    },
    getSearchEngine() {
      return resolveService(services, 'searchEngine');
    },
    getKnowledgeGraphService() {
      return resolveService(services, 'knowledgeGraphService');
    },
  };
}

export function resolveKnowledgeServicesFromContext(
  context: InternalToolHandlerContext
): ToolKnowledgeServiceContract {
  return (
    context.serviceContracts?.knowledge ||
    context.toolCallContext?.serviceContracts?.knowledge ||
    EMPTY_KNOWLEDGE_SERVICE_CONTRACT
  );
}

const EMPTY_KNOWLEDGE_SERVICE_CONTRACT: ToolKnowledgeServiceContract = {
  getKnowledgeService() {
    return null;
  },
  getSearchEngine() {
    return null;
  },
  getKnowledgeGraphService() {
    return null;
  },
};

export function requireKnowledgeService(
  services: ToolKnowledgeServiceContract
): KnowledgeServiceLike {
  const service = services.getKnowledgeService();
  if (!isKnowledgeService(service)) {
    throw new Error('Knowledge service is not available in internal tool context');
  }
  return service;
}

export function getSearchEngine(
  services: ToolKnowledgeServiceContract
): KnowledgeSearchEngineLike | null {
  const service = services.getSearchEngine();
  return isSearchEngine(service) ? service : null;
}

export function requireKnowledgeGraphService(
  services: ToolKnowledgeServiceContract
): KnowledgeGraphServiceLike {
  const service = services.getKnowledgeGraphService();
  if (!isKnowledgeGraphService(service)) {
    throw new Error('Knowledge graph service is not available in internal tool context');
  }
  return service;
}

export function requireKnowledgeGraphMutationService(
  services: ToolKnowledgeServiceContract
): KnowledgeGraphMutationServiceLike {
  const service = services.getKnowledgeGraphService();
  if (!isKnowledgeGraphMutationService(service)) {
    throw new Error('Knowledge graph mutation service is not available in internal tool context');
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

function isKnowledgeService(value: unknown): value is KnowledgeServiceLike {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as KnowledgeServiceLike).search === 'function' &&
    typeof (value as KnowledgeServiceLike).list === 'function' &&
    typeof (value as KnowledgeServiceLike).get === 'function' &&
    typeof (value as KnowledgeServiceLike).getStats === 'function'
  );
}

function isSearchEngine(value: unknown): value is KnowledgeSearchEngineLike {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as KnowledgeSearchEngineLike).search === 'function'
  );
}

function isKnowledgeGraphService(value: unknown): value is KnowledgeGraphServiceLike {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as KnowledgeGraphServiceLike).getStats === 'function' &&
    typeof (value as KnowledgeGraphServiceLike).getRelated === 'function' &&
    typeof (value as KnowledgeGraphServiceLike).getEdges === 'function'
  );
}

function isKnowledgeGraphMutationService(
  value: unknown
): value is KnowledgeGraphMutationServiceLike {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as KnowledgeGraphMutationServiceLike).addEdge === 'function'
  );
}

import type { InternalToolHandlerContext } from '#tools/core/InternalToolHandler.js';
import type {
  ToolLifecycleServiceContract,
  ToolServiceLocator,
} from '#tools/core/ToolCallContext.js';

export interface KnowledgeLifecycleServiceLike {
  create(
    data: Record<string, unknown>,
    context: { userId: string }
  ): Promise<{ id: string; title: string; lifecycle: string; [key: string]: unknown }>;
  updateQuality(id: string, context: { userId: string }): Promise<unknown>;
  approve(id: string, context: { userId: string }): Promise<unknown> | unknown;
  reject(id: string, reason: string, context: { userId: string }): Promise<unknown> | unknown;
  publish(id: string, context: { userId: string }): Promise<unknown> | unknown;
  deprecate(id: string, reason: string, context: { userId: string }): Promise<unknown> | unknown;
  update(
    id: string,
    updates: Record<string, unknown>,
    context: { userId: string }
  ): Promise<unknown> | unknown;
  incrementUsage(id: string, type?: string): Promise<unknown> | unknown;
  get(id: string): Promise<unknown> | unknown;
}

export interface LifecycleProposalRepositoryLike {
  create(data: Record<string, unknown>): unknown;
}

export interface LifecycleEvolutionGatewayLike {
  submit(decision: Record<string, unknown>): Promise<unknown> | unknown;
}

export interface LifecycleConsolidationAdvisorLike {
  analyzeBatch(candidates: Array<Record<string, unknown>>): Promise<unknown> | unknown;
}

export function createLifecycleServiceContract(
  services: ToolServiceLocator
): ToolLifecycleServiceContract {
  return {
    getKnowledgeLifecycleService() {
      return resolveService(services, 'knowledgeService');
    },
    getProposalRepository() {
      return resolveService(services, 'proposalRepository');
    },
    getEvolutionGateway() {
      return resolveService(services, 'evolutionGateway');
    },
    getConsolidationAdvisor() {
      return resolveService(services, 'consolidationAdvisor');
    },
  };
}

export function resolveLifecycleServicesFromContext(
  context: InternalToolHandlerContext
): ToolLifecycleServiceContract {
  return (
    context.serviceContracts?.lifecycle ||
    context.toolCallContext?.serviceContracts?.lifecycle ||
    createLifecycleServiceContract(context.container) ||
    EMPTY_LIFECYCLE_SERVICE_CONTRACT
  );
}

const EMPTY_LIFECYCLE_SERVICE_CONTRACT: ToolLifecycleServiceContract = {
  getKnowledgeLifecycleService() {
    return null;
  },
  getProposalRepository() {
    return null;
  },
  getEvolutionGateway() {
    return null;
  },
  getConsolidationAdvisor() {
    return null;
  },
};

export function requireKnowledgeLifecycleService(
  services: ToolLifecycleServiceContract
): KnowledgeLifecycleServiceLike {
  const service = services.getKnowledgeLifecycleService();
  if (!isKnowledgeLifecycleService(service)) {
    throw new Error('Knowledge lifecycle service is not available in internal tool context');
  }
  return service;
}

export function getProposalRepository(
  services: ToolLifecycleServiceContract
): LifecycleProposalRepositoryLike | null {
  const service = services.getProposalRepository();
  return isProposalRepository(service) ? service : null;
}

export function getEvolutionGateway(
  services: ToolLifecycleServiceContract
): LifecycleEvolutionGatewayLike | null {
  const service = services.getEvolutionGateway();
  return isEvolutionGateway(service) ? service : null;
}

export function getConsolidationAdvisor(
  services: ToolLifecycleServiceContract
): LifecycleConsolidationAdvisorLike | null {
  const service = services.getConsolidationAdvisor();
  return isConsolidationAdvisor(service) ? service : null;
}

function resolveService(services: ToolServiceLocator, name: string): unknown | null {
  try {
    return services.get(name) || null;
  } catch {
    return null;
  }
}

function isKnowledgeLifecycleService(value: unknown): value is KnowledgeLifecycleServiceLike {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as KnowledgeLifecycleServiceLike).create === 'function' &&
    typeof (value as KnowledgeLifecycleServiceLike).updateQuality === 'function' &&
    typeof (value as KnowledgeLifecycleServiceLike).approve === 'function' &&
    typeof (value as KnowledgeLifecycleServiceLike).reject === 'function' &&
    typeof (value as KnowledgeLifecycleServiceLike).publish === 'function' &&
    typeof (value as KnowledgeLifecycleServiceLike).deprecate === 'function' &&
    typeof (value as KnowledgeLifecycleServiceLike).update === 'function' &&
    typeof (value as KnowledgeLifecycleServiceLike).incrementUsage === 'function' &&
    typeof (value as KnowledgeLifecycleServiceLike).get === 'function'
  );
}

function isProposalRepository(value: unknown): value is LifecycleProposalRepositoryLike {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as LifecycleProposalRepositoryLike).create === 'function'
  );
}

function isEvolutionGateway(value: unknown): value is LifecycleEvolutionGatewayLike {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as LifecycleEvolutionGatewayLike).submit === 'function'
  );
}

function isConsolidationAdvisor(value: unknown): value is LifecycleConsolidationAdvisorLike {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as LifecycleConsolidationAdvisorLike).analyzeBatch === 'function'
  );
}

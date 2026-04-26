import type { InternalToolHandlerContext } from '#tools/core/InternalToolHandler.js';
import type { ToolGuardServiceContract, ToolServiceLocator } from '#tools/core/ToolCallContext.js';

export interface GuardServiceLike {
  listRules(
    filters: Record<string, unknown>,
    options: Record<string, unknown>
  ): Promise<unknown> | unknown;
  checkCode(code: string, options: Record<string, unknown>): Promise<unknown> | unknown;
}

export interface GuardCheckEngineLike {
  getRules(language: string | null): unknown[];
  checkCode(code: string, language: string, options: Record<string, unknown>): unknown[];
}

export interface ViolationsStoreLike {
  getStats(): unknown;
  getRunsByFile(file: string): unknown;
  list(filters: Record<string, unknown>, options: Record<string, unknown>): unknown;
}

export function createGuardServiceContract(services: ToolServiceLocator): ToolGuardServiceContract {
  return {
    getGuardService() {
      return resolveService(services, 'guardService');
    },
    getGuardCheckEngine() {
      return resolveService(services, 'guardCheckEngine');
    },
    getViolationsStore() {
      return resolveService(services, 'violationsStore');
    },
  };
}

export function resolveGuardServicesFromContext(
  context: InternalToolHandlerContext
): ToolGuardServiceContract {
  return (
    context.serviceContracts?.guard ||
    context.toolCallContext?.serviceContracts?.guard ||
    createGuardServiceContract(context.container) ||
    EMPTY_GUARD_SERVICE_CONTRACT
  );
}

const EMPTY_GUARD_SERVICE_CONTRACT: ToolGuardServiceContract = {
  getGuardService() {
    return null;
  },
  getGuardCheckEngine() {
    return null;
  },
  getViolationsStore() {
    return null;
  },
};

export function getGuardService(services: ToolGuardServiceContract): GuardServiceLike | null {
  const service = services.getGuardService();
  return isGuardService(service) ? service : null;
}

export function getGuardCheckEngine(
  services: ToolGuardServiceContract
): GuardCheckEngineLike | null {
  const service = services.getGuardCheckEngine();
  return isGuardCheckEngine(service) ? service : null;
}

export function requireViolationsStore(services: ToolGuardServiceContract): ViolationsStoreLike {
  const service = services.getViolationsStore();
  if (!isViolationsStore(service)) {
    throw new Error('Violations store is not available in internal tool context');
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

function isGuardService(value: unknown): value is GuardServiceLike {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as GuardServiceLike).listRules === 'function' &&
    typeof (value as GuardServiceLike).checkCode === 'function'
  );
}

function isGuardCheckEngine(value: unknown): value is GuardCheckEngineLike {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as GuardCheckEngineLike).getRules === 'function' &&
    typeof (value as GuardCheckEngineLike).checkCode === 'function'
  );
}

function isViolationsStore(value: unknown): value is ViolationsStoreLike {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as ViolationsStoreLike).getStats === 'function' &&
    typeof (value as ViolationsStoreLike).getRunsByFile === 'function' &&
    typeof (value as ViolationsStoreLike).list === 'function'
  );
}

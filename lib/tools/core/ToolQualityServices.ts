import type { InternalToolHandlerContext } from '#tools/core/InternalToolHandler.js';
import type {
  ToolQualityServiceContract,
  ToolServiceLocator,
} from '#tools/core/ToolCallContext.js';

export interface QualityScorerLike {
  score(recipe: Record<string, unknown>): Promise<unknown> | unknown;
}

export interface RecipeCandidateValidatorLike {
  validate(candidate: Record<string, unknown>): Promise<unknown> | unknown;
}

export interface FeedbackCollectorLike {
  getGlobalStats(): Promise<unknown> | unknown;
  getTopRecipes(limit: number): Promise<unknown> | unknown;
  getRecipeStats(recipeId: string): Promise<unknown> | unknown;
}

export function createQualityServiceContract(
  services: ToolServiceLocator
): ToolQualityServiceContract {
  return {
    getQualityScorer() {
      return resolveService(services, 'qualityScorer');
    },
    getRecipeCandidateValidator() {
      return resolveService(services, 'recipeCandidateValidator');
    },
    getFeedbackCollector() {
      return resolveService(services, 'feedbackCollector');
    },
  };
}

export function resolveQualityServicesFromContext(
  context: InternalToolHandlerContext
): ToolQualityServiceContract {
  return (
    context.serviceContracts?.quality ||
    context.toolCallContext?.serviceContracts?.quality ||
    createQualityServiceContract(context.container) ||
    EMPTY_QUALITY_SERVICE_CONTRACT
  );
}

const EMPTY_QUALITY_SERVICE_CONTRACT: ToolQualityServiceContract = {
  getQualityScorer() {
    return null;
  },
  getRecipeCandidateValidator() {
    return null;
  },
  getFeedbackCollector() {
    return null;
  },
};

export function requireQualityScorer(services: ToolQualityServiceContract): QualityScorerLike {
  const service = services.getQualityScorer();
  if (!isQualityScorer(service)) {
    throw new Error('Quality scorer is not available in internal tool context');
  }
  return service;
}

export function requireRecipeCandidateValidator(
  services: ToolQualityServiceContract
): RecipeCandidateValidatorLike {
  const service = services.getRecipeCandidateValidator();
  if (!isRecipeCandidateValidator(service)) {
    throw new Error('Recipe candidate validator is not available in internal tool context');
  }
  return service;
}

export function getFeedbackCollector(
  services: ToolQualityServiceContract
): FeedbackCollectorLike | null {
  const service = services.getFeedbackCollector();
  return isFeedbackCollector(service) ? service : null;
}

export function requireFeedbackCollector(
  services: ToolQualityServiceContract
): FeedbackCollectorLike {
  const service = getFeedbackCollector(services);
  if (!service) {
    throw new Error('Feedback collector is not available in internal tool context');
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

function isQualityScorer(value: unknown): value is QualityScorerLike {
  return (
    !!value && typeof value === 'object' && typeof (value as QualityScorerLike).score === 'function'
  );
}

function isRecipeCandidateValidator(value: unknown): value is RecipeCandidateValidatorLike {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as RecipeCandidateValidatorLike).validate === 'function'
  );
}

function isFeedbackCollector(value: unknown): value is FeedbackCollectorLike {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as FeedbackCollectorLike).getGlobalStats === 'function' &&
    typeof (value as FeedbackCollectorLike).getTopRecipes === 'function' &&
    typeof (value as FeedbackCollectorLike).getRecipeStats === 'function'
  );
}

import { resolveRecipeDimensionId } from '#domain/dimension/RecipeDimension.js';
import Logger from '#infra/logging/Logger.js';
import { BootstrapDedup } from '#service/bootstrap/BootstrapDedup.js';

const logger = Logger.getInstance();

export interface BootstrapExistingRecipe {
  id: string;
  title: string;
  trigger: string;
  dimensionId?: string;
  category?: string;
  knowledgeType: string;
  status?: string;
  decayReason?: string;
  auditScore?: number;
  content?: { markdown?: string; rationale?: string; coreCode?: string };
  sourceRefs?: string[];
  auditEvidence?: Record<string, unknown>;
}

export interface BootstrapRescanContext {
  existingRecipes: BootstrapExistingRecipe[];
  decayingRecipes: BootstrapExistingRecipe[];
  occupiedTriggers: string[];
  coverageByDim: Record<string, number>;
  evolutionPrescreen?: unknown;
}

export interface BootstrapDedupState {
  globalSubmittedTitles: Set<string>;
  globalSubmittedPatterns: Set<string>;
  globalSubmittedTriggers: Set<string>;
  bootstrapDedup: BootstrapDedup;
  existingRecipesList: BootstrapExistingRecipe[] | null;
  rescanContext: BootstrapRescanContext | null;
}

export function prepareBootstrapRescanState({
  existingRecipes,
  evolutionPrescreen,
}: {
  existingRecipes: unknown;
  evolutionPrescreen: unknown;
}): BootstrapDedupState {
  const globalSubmittedTitles = new Set<string>();
  const globalSubmittedPatterns = new Set<string>();
  const globalSubmittedTriggers = new Set<string>();
  const bootstrapDedup = new BootstrapDedup();
  const existingRecipesList = Array.isArray(existingRecipes)
    ? (existingRecipes as BootstrapExistingRecipe[])
    : null;

  if (existingRecipesList && existingRecipesList.length > 0) {
    for (const recipe of existingRecipesList) {
      if (recipe.title && recipe.status !== 'decaying') {
        globalSubmittedTitles.add(recipe.title.toLowerCase().trim());
      }
      if (recipe.trigger) {
        globalSubmittedTriggers.add(recipe.trigger.toLowerCase().trim());
      }
    }
    logger.info(
      `[Insight-v3] Rescan mode: seeded ${globalSubmittedTitles.size} titles + ${globalSubmittedTriggers.size} triggers into dedup set`
    );
  }

  return {
    globalSubmittedTitles,
    globalSubmittedPatterns,
    globalSubmittedTriggers,
    bootstrapDedup,
    existingRecipesList,
    rescanContext: buildBootstrapRescanContext({ existingRecipesList, evolutionPrescreen }),
  };
}

function buildBootstrapRescanContext({
  existingRecipesList,
  evolutionPrescreen,
}: {
  existingRecipesList: BootstrapExistingRecipe[] | null;
  evolutionPrescreen: unknown;
}): BootstrapRescanContext | null {
  if (!existingRecipesList) {
    return null;
  }
  return {
    existingRecipes: existingRecipesList.filter((recipe) => recipe.status !== 'decaying'),
    decayingRecipes: existingRecipesList.filter((recipe) => recipe.status === 'decaying'),
    occupiedTriggers: existingRecipesList.map((recipe) => recipe.trigger).filter(Boolean),
    coverageByDim: existingRecipesList.reduce(
      (acc, recipe) => {
        if (recipe.status !== 'decaying') {
          const dim = recipeDimensionKey(recipe);
          acc[dim] = (acc[dim] || 0) + 1;
        }
        return acc;
      },
      {} as Record<string, number>
    ),
    evolutionPrescreen: evolutionPrescreen ?? undefined,
  };
}

export function getBootstrapDimensionExistingRecipes({
  rescanContext,
  dimId,
}: {
  rescanContext: BootstrapRescanContext | null;
  dimId: string;
}) {
  return [
    ...(rescanContext?.existingRecipes?.filter((recipe) => recipeDimensionKey(recipe) === dimId) ??
      []),
    ...(rescanContext?.decayingRecipes?.filter((recipe) => recipeDimensionKey(recipe) === dimId) ??
      []),
  ];
}

export function projectBootstrapDimensionRescanContext({
  rescanContext,
  dimId,
}: {
  rescanContext: BootstrapRescanContext | null;
  dimId: string;
}) {
  if (!rescanContext) {
    return null;
  }
  return {
    existingRecipes: rescanContext.existingRecipes.filter(
      (recipe) => recipeDimensionKey(recipe) === dimId
    ),
    decayingRecipes: rescanContext.decayingRecipes.filter(
      (recipe) => recipeDimensionKey(recipe) === dimId
    ),
    occupiedTriggers: rescanContext.occupiedTriggers,
    gap: Math.max(0, 5 - (rescanContext.coverageByDim[dimId] || 0)),
    existing: rescanContext.coverageByDim[dimId] || 0,
  };
}

function recipeDimensionKey(recipe: BootstrapExistingRecipe): string {
  return (
    resolveRecipeDimensionId(recipe) ||
    recipe.dimensionId ||
    recipe.category ||
    recipe.knowledgeType ||
    'unknown'
  );
}

export function projectBootstrapExistingRecipesForPrompt(recipes: BootstrapExistingRecipe[]) {
  return recipes.map((recipe) => ({
    id: recipe.id,
    title: recipe.title,
    trigger: recipe.trigger,
    content: recipe.content,
    sourceRefs: recipe.sourceRefs,
    auditHint:
      recipe.auditScore != null
        ? {
            relevanceScore: recipe.auditScore,
            verdict: recipe.status === 'decaying' ? 'decay' : 'watch',
            evidence: recipe.auditEvidence ?? {},
            decayReasons: recipe.decayReason ? [String(recipe.decayReason)] : [],
          }
        : null,
  }));
}

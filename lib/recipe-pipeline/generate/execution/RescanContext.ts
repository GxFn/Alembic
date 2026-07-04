import { resolveRecipeDimensionId } from '@alembic/core/dimensions';
import type {
  KnowledgeRescanExecutionDecision,
  RescanExecutionMode,
} from '@alembic/core/host-agent-workflows';
export interface GenerateExistingRecipe {
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

export interface GenerateRescanContext {
  existingRecipes: GenerateExistingRecipe[];
  decayingRecipes: GenerateExistingRecipe[];
  occupiedTriggers: string[];
  coverageByDim: Record<string, number>;
  executionDecisions: Record<string, KnowledgeRescanExecutionDecision>;
  evolutionPrescreen?: unknown;
}

/** rescan 上下文构造（W1 起由 dedup/GenerateDedupSeeder 的 prepareGenerateRescanState 消费） */
export function buildBootstrapRescanContext({
  existingRecipesList,
  evolutionPrescreen,
  executionDecisions,
}: {
  existingRecipesList: GenerateExistingRecipe[] | null;
  evolutionPrescreen: unknown;
  executionDecisions?: readonly KnowledgeRescanExecutionDecision[];
}): GenerateRescanContext | null {
  if (!existingRecipesList) {
    return null;
  }
  return {
    existingRecipes: existingRecipesList.filter((recipe) => recipe.status !== 'decaying'),
    decayingRecipes: existingRecipesList.filter((recipe) => recipe.status === 'decaying'),
    occupiedTriggers: existingRecipesList.map((recipe) => recipe.trigger).filter(Boolean),
    executionDecisions: Object.fromEntries(
      (executionDecisions ?? []).map((decision) => [decision.dimensionId, decision])
    ),
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

export function getGenerateDimensionExistingRecipes({
  rescanContext,
  dimId,
}: {
  rescanContext: GenerateRescanContext | null;
  dimId: string;
}) {
  return [
    ...(rescanContext?.existingRecipes?.filter((recipe) => recipeDimensionKey(recipe) === dimId) ??
      []),
    ...(rescanContext?.decayingRecipes?.filter((recipe) => recipeDimensionKey(recipe) === dimId) ??
      []),
  ];
}

export function projectGenerateDimensionRescanContext({
  rescanContext,
  dimId,
}: {
  rescanContext: GenerateRescanContext | null;
  dimId: string;
}) {
  if (!rescanContext) {
    return null;
  }
  const fallbackExisting = rescanContext.coverageByDim[dimId] || 0;
  const fallbackGap = Math.max(0, 5 - fallbackExisting);
  const executionDecision = rescanContext.executionDecisions[dimId];
  const executionMode: RescanExecutionMode =
    executionDecision?.mode ?? (fallbackGap > 0 ? 'produce' : 'skip');
  return {
    existingRecipes: rescanContext.existingRecipes.filter(
      (recipe) => recipeDimensionKey(recipe) === dimId
    ),
    decayingRecipes: rescanContext.decayingRecipes.filter(
      (recipe) => recipeDimensionKey(recipe) === dimId
    ),
    occupiedTriggers: rescanContext.occupiedTriggers,
    gap: executionDecision?.gap ?? fallbackGap,
    createBudget: executionDecision?.createBudget ?? fallbackGap,
    executionMode,
    shouldExecute: executionDecision?.shouldExecute ?? executionMode !== 'skip',
    existing: executionDecision?.existingCount ?? fallbackExisting,
  };
}

function recipeDimensionKey(recipe: GenerateExistingRecipe): string {
  return (
    resolveRecipeDimensionId(recipe) ||
    recipe.dimensionId ||
    recipe.category ||
    recipe.knowledgeType ||
    'unknown'
  );
}

export function projectGenerateExistingRecipesForPrompt(recipes: GenerateExistingRecipe[]) {
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

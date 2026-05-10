import { epochSecondsNow } from "../core/index.js";
import type { BundleAction, BundleRisk, CapturePrompt, ContextBundle } from "../knowledge/index.js";
import type { RuntimeRetrievalResult } from "./RuntimeRetrievalPipeline.js";

/**
 * ContextBundleBuilder 把检索结果整理成运行期 bundle。
 * bundle 是给 Codex/Guard/Tools 的小型结构化上下文，不是 Wiki 页面。
 */
export class ContextBundleBuilder {
  build(result: RuntimeRetrievalResult): ContextBundle {
    const recipeIds = result.recipes.map((recipe) => recipe.id);
    return {
      id: `bundle:${epochSecondsNow()}`,
      activeContext: result.activeContext,
      recipes: [...result.recipes],
      edges: [...result.edges],
      sourceRefs: [...result.sourceRefs],
      guardFindings: [],
      risks: risksFromHints(result),
      suggestedActions: actionsFromRecipes(recipeIds),
      capturePrompts: capturePromptsFromContext(result),
      createdAt: epochSecondsNow(),
      metadata: {
        runtimeRetrieval: {
          hints: result.hints,
          searchHits: result.searchHits.map((hit) => ({ id: hit.document.id, score: hit.score })),
          degradedSourceRefIds: result.degradedSourceRefs.map((sourceRef) => sourceRef.id),
        },
      },
    };
  }
}

function risksFromHints(result: RuntimeRetrievalResult): BundleRisk[] {
  return result.hints
    .filter((hint) => hint.kind === "degraded-source-ref" || hint.kind === "missing-source-ref")
    .map((hint, index) => ({
      id: `runtime-risk:${index + 1}`,
      message: hint.message,
      severity: "warning",
      recipeIds: [...(hint.recipeIds ?? [])],
    }));
}

function actionsFromRecipes(recipeIds: readonly string[]): BundleAction[] {
  return recipeIds.length > 0
    ? [
        {
          id: "review-runtime-recipes",
          label: "Review recalled Recipes",
          kind: "read",
          recipeIds: [...recipeIds],
        },
      ]
    : [];
}

function capturePromptsFromContext(result: RuntimeRetrievalResult): CapturePrompt[] {
  return result.recipes.length === 0 && result.activeContext.taskText
    ? [
        {
          id: "capture-empty-prime",
          prompt:
            "No Recipe matched this work context. Capture the missing project convention if it repeats.",
          sourceRefIds: [],
        },
      ]
    : [];
}

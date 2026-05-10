import { describe, expect, it } from "vitest";
import { MainlinePrimeRunner } from "../agent/MainlinePrimeRunner.js";
import { InMemoryContextIndex } from "../data/index.js";
import {
  type ContextBundle,
  createRecipe,
  createRecipeEdge,
  createSourceRef,
  type Recipe,
  type RecipeKnowledgePayload,
} from "../knowledge/index.js";
import { InMemoryMainlineSearchIndex, projectMainlineSearchDocuments } from "../search/index.js";
import { RecipeInjectionCompressor } from "./RecipeInjectionCompressor.js";
import { RuntimeContextLoader } from "./RuntimeContextLoader.js";

describe("MainlinePrimeRunner", () => {
  it("injects compressed Recipe delivery from compiled context artifacts", async () => {
    const contextIndex = new InMemoryContextIndex();
    const searchIndex = new InMemoryMainlineSearchIndex();
    const activeSource = createSourceRef({
      id: "src:runtime",
      path: "lib/codex/runtime.ts",
      status: "active",
      summary: "Codex runtime entry",
    });
    const staleSource = createSourceRef({
      id: "src:stale-doc",
      path: "docs/old-runtime.md",
      status: "stale",
    });
    const recipe = createRecipe({
      id: "runtime-prime",
      title: "Prime Codex with runtime Recipes",
      status: "active",
      kind: "workflow",
      trigger: "codex runtime prime",
      summary: "Use compiled context artifacts before answering Codex tasks.",
      sourceRefIds: [activeSource.id, staleSource.id],
      confidence: 0.9,
      knowledge: createKnowledgePayload(),
    });

    await contextIndex.upsertContextArtifacts({
      recipes: [recipe],
      sourceRefs: [activeSource, staleSource],
    });
    searchIndex.upsert(projectMainlineSearchDocuments({ recipes: [recipe] }));

    const result = await new MainlinePrimeRunner({ contextIndex, searchIndex }).run({
      projectRoot: "/project",
      taskText: "prime codex runtime",
      files: ["lib/codex/runtime.ts"],
    });

    expect(result.recipeIds).toEqual(["runtime-prime"]);
    expect(result.markdown).toContain("### Prime Codex with runtime Recipes");
    expect(result.markdown).toContain("when: Before Codex answers a task");
    expect(result.markdown).toContain("do: Read the compiled context index");
    expect(result.markdown).toContain("don't: Scan Markdown docs during runtime injection");
    expect(result.markdown).toContain("```ts");
    expect(result.hints).toContain("degraded-source-ref:src:stale-doc");
  });

  it("expands related Recipes from RecipeEdge artifacts and emits graph risks", async () => {
    const contextIndex = new InMemoryContextIndex();
    const searchIndex = new InMemoryMainlineSearchIndex();
    const seed = recipeFixture("runtime-prime", "Prime Codex with runtime Recipes");
    const required = recipeFixture("runtime-budget", "Respect runtime budget");
    const conflict = recipeFixture("legacy-markdown-scan", "Legacy Markdown scan");

    await contextIndex.upsertContextArtifacts({
      recipes: [seed, required, conflict],
      edges: [
        createRecipeEdge({
          fromRecipeId: seed.id,
          toRecipeId: required.id,
          relation: "requires",
          evidenceSource: "manual",
        }),
        createRecipeEdge({
          fromRecipeId: seed.id,
          toRecipeId: conflict.id,
          relation: "conflicts_with",
          evidenceSource: "manual",
        }),
      ],
    });
    searchIndex.upsert(projectMainlineSearchDocuments({ recipes: [seed] }));

    const result = await new MainlinePrimeRunner({ contextIndex, searchIndex }).run({
      projectRoot: "/project",
      taskText: "prime codex runtime",
      files: [],
    });

    expect(result.bundle.recipes.map((recipe) => recipe.id)).toEqual([
      "runtime-prime",
      "runtime-budget",
    ]);
    expect(result.bundle.risks.map((risk) => risk.message)).toContain(
      "Recipe graph risk: runtime-prime conflicts_with legacy-markdown-scan.",
    );
    expect(result.bundle.metadata?.runtimeRetrieval).toMatchObject({
      graphExpansion: {
        expandedRecipeIds: ["runtime-budget"],
      },
    });
  });

  it("records runtime budget drops and truncated Recipes", () => {
    const bundle = bundleFixture([
      recipeFixture("short", "Short Recipe", {
        usageGuide: "one\ntwo\nthree\nfour\nfive\nsix\nseven",
      }),
      recipeFixture("long", "Long Recipe", {
        doClause: "x ".repeat(2_000),
      }),
    ]);
    const compressed = new RecipeInjectionCompressor().compress(bundle, { maxTokens: 80 });

    expect(compressed.recipes.map((recipe) => recipe.id)).toEqual(["short"]);
    expect(compressed.droppedRecipeIds).toEqual(["long"]);
    expect(compressed.truncatedRecipeIds).toEqual(["short", "long"]);
    expect(compressed.tokensUsed).toBeGreaterThan(0);
  });

  it("loads prime dependencies through read-only runtime loader without Markdown lookup", async () => {
    class ReadOnlyContextIndex extends InMemoryContextIndex {
      markdownLookupCount = 0;

      override async findRecipesByMarkdownPaths(): Promise<Recipe[]> {
        this.markdownLookupCount += 1;
        throw new Error("runtime prime must not query Markdown paths");
      }
    }

    const contextIndex = new ReadOnlyContextIndex();
    const searchIndex = new InMemoryMainlineSearchIndex();
    const recipe = recipeFixture("readonly-prime", "Read only prime");
    let disposed = false;

    await contextIndex.upsertContextArtifacts({ recipes: [recipe] });
    searchIndex.upsert(projectMainlineSearchDocuments({ recipes: [recipe] }));

    const loader = new RuntimeContextLoader({
      provider: {
        loadRuntimeContext: () => ({
          contextIndex,
          searchIndex,
          dispose: () => {
            disposed = true;
          },
        }),
      },
    });

    const result = await new MainlinePrimeRunner({ contextLoader: loader }).run({
      projectRoot: "/project",
      taskText: "read only prime",
      files: [],
    });

    expect(result.recipeIds).toEqual(["readonly-prime"]);
    expect(contextIndex.markdownLookupCount).toBe(0);
    await loader.dispose();
    expect(disposed).toBe(true);
  });
});

function recipeFixture(
  id: string,
  title: string,
  delivery: Partial<RecipeKnowledgePayload["delivery"]> = {},
): Recipe {
  return createRecipe({
    id,
    title,
    status: "active",
    kind: "workflow",
    trigger: title.toLowerCase(),
    summary: `Summary for ${title}`,
    confidence: 0.9,
    knowledge: createKnowledgePayload(delivery),
  });
}

function bundleFixture(recipes: readonly Recipe[]): ContextBundle {
  return {
    id: "bundle:test",
    activeContext: { projectRoot: "/project", files: [] },
    recipes: [...recipes],
    edges: [],
    sourceRefs: [],
    guardFindings: [],
    risks: [],
    suggestedActions: [],
    capturePrompts: [],
    createdAt: 1,
  };
}

function createKnowledgePayload(
  delivery: Partial<RecipeKnowledgePayload["delivery"]> = {},
): RecipeKnowledgePayload {
  return {
    schemaVersion: 1,
    classification: { language: "typescript", scope: "project" },
    delivery: {
      whenClause: "Before Codex answers a task",
      doClause: "Read the compiled context index and inject only matched Recipes.",
      dontClause: "Scan Markdown docs during runtime injection.",
      coreCode: "await runner.run({ taskText, files });",
      usageGuide: "Prime is a runtime-only handoff for IDE plugins.",
      ...delivery,
    },
    body: {
      steps: [],
      codeChanges: [],
    },
    relations: { buckets: {} },
    constraints: {
      guards: [],
      boundaries: [],
      preconditions: [],
      sideEffects: [],
    },
    reasoning: {
      sources: [],
      qualitySignals: {},
      alternatives: [],
    },
    quality: {},
    usage: {},
    governance: {
      lifecycleHistory: [],
    },
    source: {},
    headers: {
      headers: [],
      headerPaths: [],
    },
    ai: {},
  };
}

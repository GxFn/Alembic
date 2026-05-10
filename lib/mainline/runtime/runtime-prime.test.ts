import { describe, expect, it } from "vitest";
import { MainlinePrimeRunner } from "../agent/MainlinePrimeRunner.js";
import { InMemoryContextIndex } from "../data/index.js";
import { createRecipe, createSourceRef, type RecipeKnowledgePayload } from "../knowledge/index.js";
import { InMemoryMainlineSearchIndex, projectMainlineSearchDocuments } from "../search/index.js";

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
});

function createKnowledgePayload(): RecipeKnowledgePayload {
  return {
    schemaVersion: 1,
    classification: { language: "typescript", scope: "project" },
    delivery: {
      whenClause: "Before Codex answers a task",
      doClause: "Read the compiled context index and inject only matched Recipes.",
      dontClause: "Scan Markdown docs during runtime injection.",
      coreCode: "await runner.run({ taskText, files });",
      usageGuide: "Prime is a runtime-only handoff for IDE plugins.",
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

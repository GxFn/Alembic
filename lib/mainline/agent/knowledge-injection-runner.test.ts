import { describe, expect, it } from "vitest";
import { InMemoryContextIndex } from "../data/index.js";
import { createRecipe, createRecipeKnowledgePayload, createSourceRef } from "../knowledge/index.js";
import { InMemoryMainlineSearchIndex, projectMainlineSearchDocuments } from "../search/index.js";
import { KnowledgeInjectionRunner } from "./KnowledgeInjectionRunner.js";

describe("KnowledgeInjectionRunner", () => {
  it("builds an agent injection plan from runtime ContextIndex and SearchIndex", async () => {
    const contextIndex = new InMemoryContextIndex();
    const searchIndex = new InMemoryMainlineSearchIndex();
    const sourceRef = createSourceRef({
      id: "src/runtime.ts",
      path: "src/runtime.ts",
      status: "active",
      summary: "Runtime entrypoint",
    });
    const recipe = createRecipe({
      id: "agent-runtime-injection",
      title: "Agent Runtime Injection",
      kind: "workflow",
      status: "active",
      summary: "Inject runtime Recipes before agent work.",
      trigger: "agent runtime",
      sourceRefIds: [sourceRef.id],
      confidence: 0.9,
      knowledge: createRecipeKnowledgePayload({
        language: "typescript",
        trigger: "agent runtime",
        doClause: "Read runtime ContextIndex and SearchIndex.",
      }),
    });

    await contextIndex.upsertContextArtifacts({ recipes: [recipe], sourceRefs: [sourceRef] });
    searchIndex.upsert(
      projectMainlineSearchDocuments({ recipes: [recipe], sourceRefs: [sourceRef] }),
    );

    const result = await new KnowledgeInjectionRunner(contextIndex, { searchIndex }).run({
      activeWorkContext: {
        projectRoot: "/project",
        taskText: "agent runtime",
        files: ["src/runtime.ts"],
      },
    });

    expect(result.plan.recipeIds).toEqual(["agent-runtime-injection"]);
    expect(result.bundle.sourceRefs.map((entry) => entry.id)).toContain("src/runtime.ts");
    expect(result.markdown).toContain("### Agent Runtime Injection");
  });
});

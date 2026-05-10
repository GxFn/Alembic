import { describe, expect, it } from "vitest";
import { MainlineProjectIntelligenceBuilder } from "../graph/index.js";
import { createRecipe, createRecipeKnowledgePayload, createSourceRef } from "../knowledge/index.js";
import {
  mainlineRecipeImpactCandidates,
  RecipeImpactAnalyzer,
  summarizeMainlineProjectPanorama,
} from "./index.js";

describe("project summary and recipe impact compile layer", () => {
  it("summarizes project intelligence into module and dependency panorama", async () => {
    const artifact = await new MainlineProjectIntelligenceBuilder().build({
      projectRoot: "/project",
      knownFiles: ["src/api/client.ts", "src/app.ts", "tests/app.test.ts"],
      files: [
        {
          path: "src/api/client.ts",
          content:
            'import axios from "axios";\nexport function fetchUser() { return axios.get("/api/user"); }\n',
          languageId: "typescript",
        },
        {
          path: "src/app.ts",
          content:
            'import { fetchUser } from "./api/client";\nexport function App() { return fetchUser(); }\n',
          languageId: "typescript",
        },
        {
          path: "tests/app.test.ts",
          content: "export function appTest() { return true; }\n",
          languageId: "typescript",
        },
      ],
      generatedAt: 1,
    });

    const summary = summarizeMainlineProjectPanorama(artifact);

    expect(summary.fileCount).toBe(3);
    expect(summary.dominantLanguage).toBe("typescript");
    expect(summary.modules.map((module) => [module.name, module.role])).toContainEqual([
      "src/api",
      "service",
    ]);
    expect(summary.externalDependencies[0]).toEqual(
      expect.objectContaining({ specifier: "axios" }),
    );
  });

  it("analyzes changed and deleted files into recipe impact candidates", () => {
    const recipe = createRecipe({
      id: "recipe-api-client",
      title: "API Client",
      status: "active",
      sourceRefIds: ["src/api/client.ts"],
      knowledge: createRecipeKnowledgePayload({
        coreCode: "fetchUser();",
        content: {
          pattern: "Use fetchUser for user API loading.",
          steps: [{ code: "return fetchUser();" }],
        },
        sourceFile: "src/api/client.ts",
      }),
    });
    const plan = new RecipeImpactAnalyzer().analyze({
      recipes: [recipe],
      changedFiles: ["src/api/client.ts"],
      deletedFiles: ["src/api/client.ts"],
      diffTextByPath: {
        "src/api/client.ts": [
          "@@ -1,2 +1,2 @@",
          "-export function fetchUser() { return null; }",
          "+export function fetchUser() { return fetch('/api/user'); }",
        ].join("\n"),
      },
      sourceRefs: [
        createSourceRef({
          id: "src/api/client.ts",
          path: "src/api/client.ts",
          status: "active",
        }),
      ],
    });

    expect(plan.summary.impactCount).toBe(2);
    expect(plan.impacts).toContainEqual(
      expect.objectContaining({
        recipeId: "recipe-api-client",
        changedPath: "src/api/client.ts",
        reason: "source-modified-pattern",
        suggestedAction: "update",
      }),
    );
    expect(plan.impacts).toContainEqual(
      expect.objectContaining({
        reason: "source-deleted",
        suggestedAction: "deprecate",
      }),
    );
    expect(mainlineRecipeImpactCandidates(plan)).toEqual([
      expect.objectContaining({
        recipeId: "recipe-api-client",
        suggestedAction: "deprecate",
      }),
    ]);
  });
});

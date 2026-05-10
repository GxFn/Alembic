import { describe, expect, it } from "vitest";
import { createRecipe, createSourceRef } from "../knowledge/index.js";
import { RecipeImpactAnalyzer, SourceRefRepairService } from "./index.js";

describe("source ref repair planning", () => {
  it("marks moved recipe SourceRefs as repaired and removed SourceRefs as stale", () => {
    const movedRecipe = createRecipe({
      id: "recipe-moved",
      title: "Moved API",
      status: "active",
      sourceRefIds: ["src/old-api.ts"],
    });
    const removedRecipe = createRecipe({
      id: "recipe-removed",
      title: "Removed API",
      status: "active",
      sourceRefIds: ["src/removed-api.ts"],
    });
    const sourceRefs = [
      createSourceRef({
        id: "src/old-api.ts",
        path: "src/old-api.ts",
        status: "active",
      }),
      createSourceRef({
        id: "src/removed-api.ts",
        path: "src/removed-api.ts",
        status: "active",
      }),
    ];

    const repairPlan = new SourceRefRepairService().repair({
      recipes: [movedRecipe, removedRecipe],
      sourceRefs,
      fingerprintDiff: {
        added: ["src/new-api.ts"],
        modified: [],
        deleted: ["src/old-api.ts", "src/removed-api.ts"],
        unchanged: [],
        changeRatio: 1,
      },
      previousFingerprintSnapshot: {
        id: "previous",
        projectRoot: "/project",
        createdAt: 1,
        files: {
          "src/old-api.ts": "same-hash",
          "src/removed-api.ts": "removed-hash",
        },
      },
      currentFingerprintSnapshot: {
        id: "current",
        projectRoot: "/project",
        createdAt: 2,
        files: {
          "src/new-api.ts": "same-hash",
        },
      },
      generatedAt: 2,
    });

    expect(repairPlan.movedFiles).toEqual([
      { fromPath: "src/old-api.ts", toPath: "src/new-api.ts", contentHash: "same-hash" },
    ]);
    expect(repairPlan.summary).toEqual({
      movedFileCount: 1,
      removedFileCount: 1,
      repairedSourceRefCount: 1,
      staleSourceRefCount: 1,
      affectedRecipeCount: 2,
    });
    expect(repairPlan.repairs).toContainEqual(
      expect.objectContaining({
        recipeId: "recipe-moved",
        sourceRefId: "src/old-api.ts",
        previousPath: "src/old-api.ts",
        nextPath: "src/new-api.ts",
        status: "repaired",
      }),
    );
    expect(repairPlan.repairs).toContainEqual(
      expect.objectContaining({
        recipeId: "recipe-removed",
        sourceRefId: "src/removed-api.ts",
        previousPath: "src/removed-api.ts",
        status: "stale",
      }),
    );
    expect(repairPlan.sourceRefs).toContainEqual(
      expect.objectContaining({
        id: "src/old-api.ts",
        status: "repaired",
        location: expect.objectContaining({ path: "src/new-api.ts" }),
      }),
    );
  });

  it("feeds moved and removed files into recipe impact analysis", () => {
    const movedRecipe = createRecipe({
      id: "recipe-moved",
      title: "Moved API",
      status: "active",
      sourceRefIds: ["src/old-api.ts"],
    });
    const removedRecipe = createRecipe({
      id: "recipe-removed",
      title: "Removed API",
      status: "active",
      sourceRefIds: ["src/removed-api.ts"],
    });
    const sourceRefs = [
      createSourceRef({
        id: "src/old-api.ts",
        path: "src/old-api.ts",
        status: "active",
      }),
      createSourceRef({
        id: "src/removed-api.ts",
        path: "src/removed-api.ts",
        status: "active",
      }),
    ];
    const repairPlan = new SourceRefRepairService().repair({
      recipes: [movedRecipe, removedRecipe],
      sourceRefs,
      movedFiles: [{ fromPath: "src/old-api.ts", toPath: "src/new-api.ts" }],
      removedFiles: ["src/removed-api.ts"],
    });

    const impactPlan = new RecipeImpactAnalyzer().analyze({
      recipes: [movedRecipe, removedRecipe],
      createdFiles: ["src/new-api.ts"],
      deletedFiles: ["src/old-api.ts", "src/removed-api.ts"],
      movedFiles: repairPlan.movedFiles,
      sourceRefs: [...sourceRefs, ...repairPlan.sourceRefs],
    });

    expect(impactPlan.impacts).toContainEqual(
      expect.objectContaining({
        recipeId: "recipe-moved",
        changedPath: "src/old-api.ts",
        targetPath: "src/new-api.ts",
        reason: "source-moved",
        suggestedAction: "verify",
      }),
    );
    expect(impactPlan.impacts).toContainEqual(
      expect.objectContaining({
        recipeId: "recipe-removed",
        changedPath: "src/removed-api.ts",
        reason: "source-deleted",
        suggestedAction: "deprecate",
      }),
    );
  });
});

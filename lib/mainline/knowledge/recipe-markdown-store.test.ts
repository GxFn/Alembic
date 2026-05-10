import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MainlineWorkspacePaths, MainlineWriteBoundary } from "../core/index.js";
import { createRecipe } from "./Recipe.js";
import { createRecipeKnowledgePayload } from "./RecipeKnowledgePayload.js";
import {
  RecipeMarkdownStore,
  recipeMarkdownBucket,
  recipeMarkdownRelativePath,
} from "./RecipeMarkdownStore.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe("RecipeMarkdownStore", () => {
  it("writes candidates and active recipes inside the knowledge write boundary", async () => {
    const root = await makeTempRoot();
    const store = new RecipeMarkdownStore(
      new MainlineWriteBoundary({
        workspacePaths: new MainlineWorkspacePaths({
          projectRoot: path.join(root, "project"),
          dataRoot: path.join(root, "ghost"),
        }),
      }),
    );
    const candidate = createRecipe({
      id: "candidate-box-helper",
      title: "Candidate Box Helper",
      kind: "pattern",
      status: "candidate",
      summary: "Store candidate knowledge safely.",
      trigger: "candidate box",
      dimensionIds: ["codex-runtime"],
      confidence: 0.8,
      knowledge: createRecipeKnowledgePayload({ language: "typescript" }),
      metadata: { markdownSource: { path: "old.md" }, kept: true },
    });
    const active = createRecipe({ ...candidate, id: "active-box-helper", status: "active" });

    const writes = await store.writeMany([candidate, active]);

    expect(writes.map((write) => write.bucket)).toEqual(["candidates", "recipes"]);
    expect(writes[0]?.relativePath).toMatch(/^Alembic[/\\]candidates[/\\]/);
    expect(writes[1]?.relativePath).toMatch(/^Alembic[/\\]recipes[/\\]/);
    await expect(fs.readFile(writes[0]?.absolutePath ?? "", "utf8")).resolves.not.toContain(
      "markdownSource",
    );

    const loaded = await store.loadAll();
    expect(loaded.warnings).toEqual([]);
    expect(loaded.recipes.map((recipe) => recipe.id).sort()).toEqual([
      "active-box-helper",
      "candidate-box-helper",
    ]);
    expect(loaded.files).toHaveLength(2);
  });

  it("keeps bucket and relative path decisions deterministic", () => {
    const recipe = createRecipe({
      id: "Recipe With Spaces",
      title: "Use Shared Runtime",
      kind: "workflow",
      status: "superseded",
      summary: "Use the shared runtime.",
      dimensionIds: ["Mainline Runtime"],
    });

    expect(recipeMarkdownBucket(recipe)).toBe("recipes");
    expect(recipeMarkdownRelativePath(recipe)).toBe(
      "recipes/mainline-runtime/use-shared-runtime-recipe-with-spaces.md",
    );
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alembic-recipe-store-"));
  tempRoots.push(root);
  return root;
}

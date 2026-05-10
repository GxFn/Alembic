import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRecipe, createRecipeKnowledgePayload } from "../knowledge/index.js";
import {
  deleteRecipesFromMainlineRuntimeArtifacts,
  writeRecipeToMainlineRuntimeArtifacts,
} from "./RecipeRuntimeArtifactWriter.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe("RecipeRuntimeArtifactWriter", () => {
  it("writes and deletes Recipe runtime artifacts through JSON mainline snapshots", async () => {
    const root = await makeTempRoot();
    const projectRoot = path.join(root, "project");
    const dataRoot = path.join(root, "ghost");
    const recipe = createRecipe({
      id: "runtime-writer",
      title: "Runtime Writer",
      kind: "workflow",
      status: "active",
      summary: "Persist a Recipe into runtime artifacts.",
      trigger: "runtime writer",
      sourceRefIds: ["src/app.ts#run"],
      confidence: 0.9,
      knowledge: createRecipeKnowledgePayload({
        language: "typescript",
        trigger: "runtime writer",
        doClause: "Persist runtime artifacts together.",
      }),
    });

    const written = await writeRecipeToMainlineRuntimeArtifacts({
      projectRoot,
      dataRoot,
      recipe,
      source: "unit-test",
    });

    expect(written.searchDocumentCount).toBe(2);
    await expect(
      readJson(path.join(dataRoot, ".asd/context/context-index.json")),
    ).resolves.toMatchObject({
      recipes: [expect.objectContaining({ id: recipe.id })],
      recipeFiles: [expect.objectContaining({ recipeId: recipe.id })],
      sourceRefs: [
        expect.objectContaining({
          id: "src/app.ts#run",
          location: expect.objectContaining({ path: "src/app.ts", symbol: "run" }),
        }),
      ],
    });
    await expect(
      readJson(path.join(dataRoot, ".asd/context/search-index.json")),
    ).resolves.toMatchObject({
      documents: expect.arrayContaining([
        expect.objectContaining({ id: "recipe:runtime-writer" }),
        expect.objectContaining({ id: "source-ref:src/app.ts#run" }),
      ]),
    });
    await expect(pathExists(written.markdown.absolutePath)).resolves.toBe(true);

    const deleted = await deleteRecipesFromMainlineRuntimeArtifacts({
      projectRoot,
      dataRoot,
      recipeIds: [recipe.id],
    });

    expect(deleted.searchDocumentIds).toEqual([
      "recipe:runtime-writer",
      "source-ref:src/app.ts#run",
    ]);
    await expect(pathExists(written.markdown.absolutePath)).resolves.toBe(false);
    await expect(
      readJson(path.join(dataRoot, ".asd/context/context-index.json")),
    ).resolves.toMatchObject({
      recipes: [],
      sourceRefs: [],
    });
    await expect(
      readJson(path.join(dataRoot, ".asd/context/search-index.json")),
    ).resolves.toMatchObject({
      documents: [],
    });
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alembic-runtime-writer-"));
  tempRoots.push(root);
  return root;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

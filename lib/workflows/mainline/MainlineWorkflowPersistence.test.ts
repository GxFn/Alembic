import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRecipe, createRecipeKnowledgePayload } from "../../mainline/knowledge/index.js";
import { MainlineWorkflowEntrypoint } from "./MainlineWorkflowEntrypoint.js";
import { createMainlineWorkflowPersistence } from "./MainlineWorkflowPersistence.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe("mainline workflow dataRoot persistence", () => {
  it("writes workflow artifacts to dataRoot without touching projectRoot runtime", async () => {
    const projectRoot = await makeFixtureProject();
    const dataRoot = await makeTempRoot("alembic-workflow-data-");
    const persistence = await createMainlineWorkflowPersistence({
      projectRoot,
      dataRoot,
      mode: "ghost",
      now: () => 1,
    });

    const result = await new MainlineWorkflowEntrypoint(persistence.dependencies).run({
      kind: "bootstrap",
      projectRoot,
    });

    expect(result.status).toBe("completed");
    expect(result.persisted).toEqual(persistence.persistedArtifacts);
    await expect(
      readJson(path.join(dataRoot, ".asd/context/project-intelligence-artifact.json")),
    ).resolves.toMatchObject({
      files: expect.arrayContaining([expect.objectContaining({ path: "src/app.ts" })]),
    });
    await expect(
      readJson(path.join(dataRoot, ".asd/context/context-index.json")),
    ).resolves.toMatchObject({ sourceRefs: expect.any(Array) });
    await expect(
      readJson(path.join(dataRoot, ".asd/context/search-index.json")),
    ).resolves.toMatchObject({ documents: expect.any(Array), updatedAt: 1 });
    await expect(
      pathExists(path.join(projectRoot, ".asd/context/search-index.json")),
    ).resolves.toBe(false);
  });

  it("restores context and search snapshots on the next workflow dependency build", async () => {
    const projectRoot = await makeFixtureProject();
    const dataRoot = await makeTempRoot("alembic-workflow-data-");

    const first = await createMainlineWorkflowPersistence({ projectRoot, dataRoot, mode: "ghost" });
    await new MainlineWorkflowEntrypoint(first.dependencies).run({
      kind: "bootstrap",
      projectRoot,
    });

    const restored = await createMainlineWorkflowPersistence({
      projectRoot,
      dataRoot,
      mode: "ghost",
    });
    const sourceRefs = await restored.contextIndex.findSourceRefsByPaths(["src/app.ts"]);
    const searchDocuments = restored.searchIndex.snapshot();

    expect(sourceRefs.map((sourceRef) => sourceRef.id)).toContain("src/app.ts");
    expect(searchDocuments.some((document) => document.id === "file:src/app.ts")).toBe(true);
    await expect(restored.artifactStore.load()).resolves.toMatchObject({
      files: expect.arrayContaining([expect.objectContaining({ path: "src/app.ts" })]),
    });
  });

  it("exposes internal agent tool dependencies backed by dataRoot snapshots", async () => {
    const projectRoot = await makeFixtureProject();
    const dataRoot = await makeTempRoot("alembic-workflow-data-");

    const persistence = await createMainlineWorkflowPersistence({
      projectRoot,
      dataRoot,
      mode: "ghost",
    });
    await new MainlineWorkflowEntrypoint(persistence.dependencies).run({
      kind: "bootstrap",
      projectRoot,
    });

    const tools = persistence.agentToolDependencies;
    const searchIndex = tools.searchIndex;
    const contextIndex = tools.contextIndex;
    const artifactProvider = tools.projectIntelligenceArtifactProvider;
    expect(tools.projectRoot).toBe(projectRoot);
    expect(searchIndex).toBeDefined();
    expect(contextIndex).toBeDefined();
    expect(artifactProvider).toBeDefined();
    expect(searchIndex?.search({ text: "helper", limit: 5 })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          document: expect.objectContaining({ path: "src/util.ts" }),
        }),
      ]),
    );
    await expect(contextIndex?.findSourceRefsByPaths(["src/app.ts"])).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "src/app.ts" })]),
    );
    await expect(artifactProvider?.load()).resolves.toMatchObject({
      files: expect.arrayContaining([expect.objectContaining({ path: "src/app.ts" })]),
    });
  });

  it("persists recipe Markdown file indexes across dependency rebuilds", async () => {
    const projectRoot = await makeFixtureProject();
    const dataRoot = await makeTempRoot("alembic-workflow-data-");
    const first = await createMainlineWorkflowPersistence({ projectRoot, dataRoot, mode: "ghost" });
    const recipe = createRecipe({
      id: "recipe-runtime-file-index",
      title: "Runtime File Index",
      kind: "pattern",
      status: "candidate",
      summary: "Keep Recipe Markdown file indexes in the runtime snapshot.",
      confidence: 0.8,
      knowledge: createRecipeKnowledgePayload({
        language: "typescript",
        do: ["Persist recipeFiles together with recipes."],
      }),
    });

    await first.contextIndex.upsertContextArtifacts({
      recipes: [recipe],
      recipeFiles: [
        {
          recipeId: recipe.id,
          bucket: "candidates",
          relativePath: "Alembic/candidates/runtime-file-index.md",
          contentHash: "sha256:test",
          updatedAt: 1,
        },
      ],
    });

    const restored = await createMainlineWorkflowPersistence({
      projectRoot,
      dataRoot,
      mode: "ghost",
    });

    await expect(restored.contextIndex.findRecipeFilesByRecipeIds([recipe.id])).resolves.toEqual([
      expect.objectContaining({
        recipeId: recipe.id,
        relativePath: "Alembic/candidates/runtime-file-index.md",
      }),
    ]);
  });
});

async function makeFixtureProject(): Promise<string> {
  const root = await makeTempRoot("alembic-workflow-project-");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "app.ts"),
    ['import { helper } from "./util";', "export function app() { return helper(); }", ""].join(
      "\n",
    ),
  );
  await fs.writeFile(path.join(root, "src", "util.ts"), "export function helper() { return 1; }\n");
  return root;
}

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

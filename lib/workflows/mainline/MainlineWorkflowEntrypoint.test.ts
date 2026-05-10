import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryMainlineProjectIntelligenceArtifactStore } from "../../mainline/compile/index.js";
import { InMemoryContextIndex } from "../../mainline/data/index.js";
import { InMemoryMainlineSearchIndex } from "../../mainline/search/index.js";
import { MainlineWorkflowEntrypoint } from "./MainlineWorkflowEntrypoint.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe("mainline workflow entrypoint", () => {
  it("runs bootstrap through scan, project intelligence, and materialization", async () => {
    const projectRoot = await makeFixtureProject();
    const contextIndex = new InMemoryContextIndex();
    const searchIndex = new InMemoryMainlineSearchIndex();
    const artifactStore = new InMemoryMainlineProjectIntelligenceArtifactStore();

    const result = await new MainlineWorkflowEntrypoint({
      contextIndex,
      searchIndex,
      artifactStore,
    }).run({
      kind: "bootstrap",
      projectRoot,
    });

    expect(result.status).toBe("completed");
    expect(result.summary).toMatchObject({
      scannedFiles: 2,
      sourceFiles: 2,
      selectedFiles: 2,
      recipes: 0,
      truncated: false,
    });
    expect(result.summary.sourceRefs).toBeGreaterThan(0);
    expect(result.summary.searchDocuments).toBeGreaterThan(0);
    expect(result.warnings).not.toContain("recipe_generation_deferred");
    await expect(artifactStore.load()).resolves.toMatchObject({
      projectRoot,
      files: expect.arrayContaining([expect.objectContaining({ path: "src/app.ts" })]),
    });
    expect(searchIndex.snapshot().some((document) => document.id === "file:src/app.ts")).toBe(true);
  });

  it("honors cancellation before materializing finalizer writes", async () => {
    const projectRoot = await makeFixtureProject();
    const contextIndex = new InMemoryContextIndex();
    let checks = 0;

    const result = await new MainlineWorkflowEntrypoint({ contextIndex }).run({
      kind: "rescan",
      projectRoot,
      cancellation: {
        isCancelled: () => {
          checks += 1;
          return checks > 6;
        },
      },
    });

    expect(result.status).toBe("cancelled");
    expect(result.summary.sourceRefs).toBe(0);
    expect(result.warnings.some((warning) => warning.startsWith("cancelled_before_"))).toBe(true);
    await expect(contextIndex.listRecipes()).resolves.toEqual([]);
  });
});

async function makeFixtureProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alembic-workflow-"));
  tempRoots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "app.ts"),
    ['import { helper } from "./util";', "export function app() { return helper(); }", ""].join(
      "\n",
    ),
  );
  await fs.writeFile(path.join(root, "src", "util.ts"), "export function helper() { return 1; }\n");
  await fs.writeFile(path.join(root, "README.md"), "# Fixture\n");
  return root;
}

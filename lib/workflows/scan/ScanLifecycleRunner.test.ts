import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRecipe, createRecipeKnowledgePayload } from "../../mainline/knowledge/index.js";
import { ScanLifecycleRunner } from "./ScanLifecycleRunner.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe("scan lifecycle runner", () => {
  it("runs complete cold-start and incremental scan lifecycles", async () => {
    const projectRoot = await makeFixtureProject();
    const dataRoot = await makeTempRoot("alembic-scan-data-");
    const recipe = createRecipe({
      id: "recipe-api-client",
      title: "API Client",
      status: "active",
      sourceRefIds: ["src/api.ts"],
      knowledge: createRecipeKnowledgePayload({
        coreCode: "fetchUser();",
        content: {
          pattern: "Use fetchUser for user API loading.",
          steps: [{ code: "return fetchUser();" }],
        },
        sourceFile: "src/api.ts",
      }),
    });
    const runner = new ScanLifecycleRunner();

    const coldStart = await runner.run({
      kind: "bootstrap",
      projectRoot,
      workspace: { dataRoot, mode: "ghost" },
      recipes: [recipe],
      generatedAt: 1,
    });

    expect(coldStart.status).toBe("completed");
    expect(coldStart.plan).toMatchObject({
      mode: "cold-start",
      cleanupPolicy: "full-reset",
      requiresBaseline: false,
    });
    expect(coldStart.summary).toMatchObject({
      scannedFiles: 1,
      sourceFiles: 1,
      recipes: 1,
      addedFiles: 1,
      modifiedFiles: 0,
      deletedFiles: 0,
    });
    expect(coldStart.evidence?.origin).toBe("snapshot");
    expect(coldStart.compile?.progress.checkpoints.map((checkpoint) => checkpoint.phase)).toEqual([
      "scan",
      "fingerprint",
      "recipe-markdown",
      "content-mining",
      "project-intelligence",
      "source-ref-repair",
      "recipe-impact",
      "search-index",
      "fingerprint-store",
    ]);

    await fs.writeFile(
      path.join(projectRoot, "src", "api.ts"),
      "export function fetchUser() { return fetch('/api/user'); }\n",
    );
    const rescan = await runner.run({
      kind: "rescan",
      projectRoot,
      workspace: { dataRoot, mode: "ghost" },
      recipes: [recipe],
      generatedAt: 2,
      diffTextByPath: {
        "src/api.ts": [
          "@@ -1 +1 @@",
          "-export function fetchUser() { return null; }",
          "+export function fetchUser() { return fetch('/api/user'); }",
        ].join("\n"),
      },
    });

    expect(rescan.status).toBe("completed");
    expect(rescan.plan).toMatchObject({
      mode: "incremental",
      cleanupPolicy: "rescan-clean",
      requiresBaseline: true,
    });
    expect(rescan.summary).toMatchObject({
      modifiedFiles: 1,
      recipeImpacts: 1,
      recipes: 1,
    });
    expect(rescan.evidence?.origin).toBe("diff");
    expect(rescan.recommendations.map((recommendation) => recommendation.id)).toContain(
      "review-recipe-impact",
    );
  });

  it("cancels before compile writes when the token is set", async () => {
    const projectRoot = await makeFixtureProject();
    const result = await new ScanLifecycleRunner().run({
      kind: "bootstrap",
      projectRoot,
      cancellation: { isCancelled: () => true },
    });

    expect(result.status).toBe("cancelled");
    expect(result.compile).toBeUndefined();
    expect(result.warnings[0]).toMatch(/^cancelled_before_/);
  });
});

async function makeFixtureProject(): Promise<string> {
  const root = await makeTempRoot("alembic-scan-project-");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "api.ts"),
    "export function fetchUser() { return null; }\n",
  );
  return root;
}

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

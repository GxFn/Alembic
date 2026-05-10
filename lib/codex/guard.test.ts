import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRecipe, createRecipeKnowledgePayload } from "../mainline/knowledge/index.js";
import { projectMainlineSearchDocuments } from "../mainline/search/index.js";
import { createMainlineWorkflowPersistence } from "../workflows/mainline/MainlineWorkflowPersistence.js";
import { runCodexGuard } from "./guard.js";
import { initializeCodexWorkspace } from "./workspace.js";

const tempRoots: string[] = [];

let previousAlembicHome: string | undefined;
let previousHome: string | undefined;
let previousProjectDir: string | undefined;

beforeEach(async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "alembic-guard-home-"));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alembic-guard-project-"));
  tempRoots.push(home, projectRoot);

  previousAlembicHome = process.env.ALEMBIC_HOME;
  previousHome = process.env.HOME;
  previousProjectDir = process.env.ALEMBIC_PROJECT_DIR;
  process.env.ALEMBIC_HOME = path.join(home, ".asd");
  process.env.HOME = home;
  process.env.ALEMBIC_PROJECT_DIR = projectRoot;
});

afterEach(async () => {
  restoreEnv("ALEMBIC_HOME", previousAlembicHome);
  restoreEnv("HOME", previousHome);
  restoreEnv("ALEMBIC_PROJECT_DIR", previousProjectDir);
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe("runCodexGuard", () => {
  it("loads guard-rule Recipes from runtime snapshots and checks inline code", async () => {
    const workspace = initializeCodexWorkspace({ projectRoot: currentProjectRoot() });
    const persistence = await createMainlineWorkflowPersistence({
      projectRoot: workspace.projectRoot,
      dataRoot: workspace.dataRoot,
      mode: workspace.mode,
    });
    const recipe = createRecipe({
      id: "guard-no-console-log",
      title: "No console.log",
      kind: "guard-rule",
      status: "active",
      summary: "Do not leave console.log in production code.",
      confidence: 0.9,
      knowledge: createRecipeKnowledgePayload({
        language: "typescript",
        constraints: {
          guards: [
            {
              id: "no-console-log",
              pattern: "console\\.log\\s*\\(",
              severity: "warning",
              message: "Use the project logger instead of console.log.",
              skipComments: true,
            },
          ],
        },
      }),
    });

    await persistence.contextIndex.upsertContextArtifacts({ recipes: [recipe] });
    persistence.searchIndex.upsert(projectMainlineSearchDocuments({ recipes: [recipe] }));
    await persistence.searchIndex.flush();

    const result = await runCodexGuard({
      code: ["// console.log is a comment", "console.log('debug');"].join("\n"),
      language: "typescript",
      filePath: "src/app.ts",
    });

    expect(result.status).toBe("completed");
    expect(result.summary).toMatchObject({ files: 1, rules: 1, findings: 1, warnings: 1 });
    expect(result.findings?.[0]).toMatchObject({
      ruleId: "no-console-log",
      ruleRecipeId: "guard-no-console-log",
      file: "src/app.ts",
      line: 2,
      language: "typescript",
    });
  });

  it("rejects file paths outside projectRoot", async () => {
    const workspace = initializeCodexWorkspace({ projectRoot: currentProjectRoot() });
    const persistence = await createMainlineWorkflowPersistence({
      projectRoot: workspace.projectRoot,
      dataRoot: workspace.dataRoot,
      mode: workspace.mode,
    });
    await persistence.contextIndex.flush();

    const result = await runCodexGuard({
      files: [{ path: "../outside.ts", content: "console.log('debug');", language: "typescript" }],
    });

    expect(result.status).toBe("invalid-input");
    expect(result.message).toContain("outside projectRoot");
  });

  it("completes with a warning when no guard-rule Recipes exist", async () => {
    const workspace = initializeCodexWorkspace({ projectRoot: currentProjectRoot() });
    const persistence = await createMainlineWorkflowPersistence({
      projectRoot: workspace.projectRoot,
      dataRoot: workspace.dataRoot,
      mode: workspace.mode,
    });
    await persistence.contextIndex.flush();

    const result = await runCodexGuard({
      code: "console.log('debug');",
      language: "typescript",
      filePath: "src/app.ts",
    });

    expect(result.status).toBe("completed");
    expect(result.summary).toMatchObject({ files: 1, rules: 0, findings: 0 });
    expect(result.warnings?.[0]).toContain("No active guard-rule Recipes");
  });
});

function currentProjectRoot(): string {
  const projectRoot = process.env.ALEMBIC_PROJECT_DIR;
  if (!projectRoot) {
    throw new Error("ALEMBIC_PROJECT_DIR is missing.");
  }
  return projectRoot;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

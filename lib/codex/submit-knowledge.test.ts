import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecipeLifecycleStore } from "../mainline/knowledge/index.js";
import { createMainlineWorkflowPersistence } from "../workflows/mainline/MainlineWorkflowPersistence.js";
import { submitCodexKnowledge } from "./submit-knowledge.js";
import { initializeCodexWorkspace } from "./workspace.js";

let home: string;
let projectRoot: string;
let previousHome: string | undefined;
let previousAlembicHome: string | undefined;
let previousProjectDir: string | undefined;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "alembic-submit-home-"));
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alembic-submit-project-"));
  previousHome = process.env.HOME;
  previousAlembicHome = process.env.ALEMBIC_HOME;
  previousProjectDir = process.env.ALEMBIC_PROJECT_DIR;
  process.env.HOME = home;
  process.env.ALEMBIC_PROJECT_DIR = projectRoot;
  delete process.env.ALEMBIC_HOME;
});

afterEach(async () => {
  restoreEnv("HOME", previousHome);
  restoreEnv("ALEMBIC_HOME", previousAlembicHome);
  restoreEnv("ALEMBIC_PROJECT_DIR", previousProjectDir);
  await Promise.all([
    fs.rm(home, { force: true, recursive: true }),
    fs.rm(projectRoot, { force: true, recursive: true }),
  ]);
});

describe("submitCodexKnowledge", () => {
  it("stages accepted candidates through lifecycle storage without publishing active recipes", async () => {
    const workspace = initializeCodexWorkspace({ projectRoot });
    const item = validKnowledgeItem();

    const result = await submitCodexKnowledge({ projectRoot, items: [item] });

    expect(result.status).toBe("completed");
    expect(result.accepted).toBe(1);
    expect(result.rejected).toBe(0);
    expect(result.candidatesDir).toBe(workspace.candidatesDir);
    expect(result.items[0]?.accepted).toBe(true);
    const candidateId = result.items[0]?.id;
    const candidatePath = result.items[0]?.path;
    expect(candidateId).toBeTruthy();
    expect(candidatePath).toBeTruthy();
    const candidateStat = await fs.stat(candidatePath as string);
    expect(candidateStat.isFile()).toBe(true);
    expect((candidatePath as string).startsWith(workspace.dataRoot)).toBe(true);
    await expect(fs.stat(path.join(projectRoot, ".asd"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(projectRoot, "Alembic"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readdir(workspace.recipesDir)).resolves.toEqual([]);

    const persistence = await createMainlineWorkflowPersistence({
      projectRoot: workspace.projectRoot,
      dataRoot: workspace.dataRoot,
    });
    const lifecycleStore = new RecipeLifecycleStore(persistence.writeBoundary);
    const staged = await lifecycleStore.load(candidateId as string, { status: "candidate" });

    expect(staged).toMatchObject({
      id: candidateId,
      status: "candidate",
      recipe: { status: "candidate" },
      file: {
        absolutePath: candidatePath,
        bucket: "candidates",
      },
    });
    await expect(lifecycleStore.load(candidateId as string)).resolves.toBeNull();
    await expect(lifecycleStore.list()).resolves.toEqual([]);

    const snapshot = persistence.contextIndex.snapshot();
    const indexedRecipe = snapshot.recipes.find((recipe) => recipe.id === candidateId);
    const indexedFile = snapshot.recipeFiles.find((file) => file.recipeId === candidateId);
    const searchDoc = persistence.searchIndex
      .snapshot()
      .find((document) => document.id === `recipe:${candidateId}`);

    expect(indexedRecipe).toBeUndefined();
    expect(indexedFile).toBeUndefined();
    expect(searchDoc).toBeUndefined();
  });

  it("rejects invalid submissions without writing candidate files", async () => {
    const workspace = initializeCodexWorkspace({ projectRoot });

    const result = await submitCodexKnowledge({
      projectRoot,
      items: [{ title: "Missing V3 fields" }],
    });

    expect(result.status).toBe("completed");
    expect(result.accepted).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.items[0]?.accepted).toBe(false);
    expect(result.items[0]?.errors.join("\n")).toContain("缺少必填字段");
    await expect(fs.readdir(workspace.candidatesDir)).resolves.toEqual([]);
  });
});

function validKnowledgeItem(): Record<string, unknown> {
  const markdown = [
    "Use the candidate box helper when Codex needs to turn a reviewed item into runtime-readable knowledge.",
    "The helper keeps writes in Ghost storage and records source references so readiness checks can inspect the staged candidate.",
    "来源: src/candidate-box.ts:12",
    "",
    "```ts",
    "export function candidateBox(title: string) {",
    "  return { title, status: 'candidate' as const };",
    "}",
    "```",
    "",
    "This candidate intentionally includes a concrete file reference and a code block so the quality gate can",
    "distinguish it from generic prose while still keeping the behavior focused on Codex candidate submission.",
  ].join("\n");

  return {
    title: "Codex Candidate Box Helper",
    description: "Store Codex knowledge submissions as review-only candidate Recipes.",
    trigger: "Use the candidate box helper pattern",
    kind: "pattern",
    doClause:
      "Write accepted Codex submissions as candidate Recipes through the lifecycle store in Ghost storage.",
    dontClause: "Do not publish or activate a Recipe from the Codex submission helper.",
    whenClause: "When Codex submits project knowledge through alembic_submit_knowledge.",
    coreCode:
      "export function candidateBox(title: string) { return { title, status: 'candidate' as const }; }",
    category: "codex",
    headers: ["Codex Candidate Box Helper"],
    reasoning: {
      whyStandard:
        "It preserves review boundaries while making accepted candidates available to review readiness.",
      sources: ["src/candidate-box.ts"],
      confidence: 0.82,
    },
    content: {
      markdown,
      rationale:
        "Codex submissions need a review-only storage path before publish refreshes runtime indexes.",
    },
    knowledgeType: "code-pattern",
    language: "typescript",
    usageGuide:
      "Call submitCodexKnowledge with V3 fields and inspect the returned accepted item id.",
    dimensionId: "codex-runtime",
    topicHint: "candidate knowledge submission",
    confidence: 0.82,
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

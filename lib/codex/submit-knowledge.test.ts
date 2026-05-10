import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCodexPrime } from "./prime.js";
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
  it("writes accepted candidates to Ghost storage and makes them prime-readable", async () => {
    const workspace = initializeCodexWorkspace({ projectRoot });
    const item = validKnowledgeItem();

    const result = await submitCodexKnowledge({ projectRoot, items: [item] });

    expect(result.status).toBe("completed");
    expect(result.accepted).toBe(1);
    expect(result.rejected).toBe(0);
    expect(result.candidatesDir).toBe(workspace.candidatesDir);
    expect(result.items[0]?.accepted).toBe(true);
    const candidatePath = result.items[0]?.path;
    expect(candidatePath).toBeTruthy();
    await expect(fs.stat(candidatePath as string)).resolves.toMatchObject({
      isFile: expect.any(Function),
    });
    await expect(fs.stat(path.join(projectRoot, ".asd"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(projectRoot, "Alembic"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const prime = await runCodexPrime({
      projectRoot,
      task: "Use the candidate box helper pattern",
      files: ["src/candidate-box.ts"],
    });

    expect(prime.status).toBe("completed");
    expect(prime.recipeIds).toContain(result.items[0]?.id);
    expect(prime.markdown).toContain("Codex Candidate Box Helper");
  });

  it("rejects invalid submissions without writing candidate Markdown", async () => {
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
    "The helper keeps writes in Ghost storage and records source references so prime can recall the candidate.",
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
    doClause: "Write accepted Codex submissions as candidate Recipe markdown in Ghost storage.",
    dontClause: "Do not publish or activate a Recipe from the Codex submission helper.",
    whenClause: "When Codex submits project knowledge through alembic_submit_knowledge.",
    coreCode:
      "export function candidateBox(title: string) { return { title, status: 'candidate' as const }; }",
    category: "codex",
    headers: ["Codex Candidate Box Helper"],
    reasoning: {
      whyStandard:
        "It preserves review boundaries while making accepted candidates available to prime.",
      sources: ["src/candidate-box.ts"],
      confidence: 0.82,
    },
    content: {
      markdown,
      rationale:
        "Codex submissions need a review-only storage path that still refreshes runtime indexes.",
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

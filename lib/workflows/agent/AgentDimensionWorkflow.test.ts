import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRecipe, createRecipeKnowledgePayload } from "../../mainline/knowledge/index.js";
import { ScanLifecycleRunner } from "../scan/ScanLifecycleRunner.js";
import { AgentDimensionWorkflow, planAgentWorkflowTasks } from "./AgentDimensionWorkflow.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe("agent dimension workflow", () => {
  it("plans and runs dimension tasks from scan lifecycle activations", async () => {
    const projectRoot = await makeFixtureProject();
    const scan = await new ScanLifecycleRunner().run({
      kind: "bootstrap",
      projectRoot,
      generatedAt: 1,
    });

    const planned = planAgentWorkflowTasks(scan, { maxTasks: 3, includeEvolution: false });
    expect(planned.map((task) => task.kind)).toEqual(["dimension", "dimension", "dimension"]);
    expect(planned[0]?.allowedToolIds).toContain("knowledge.submit");

    const result = await new AgentDimensionWorkflow().run({
      scan,
      maxTasks: 2,
      includeEvolution: false,
    });

    expect(result.status).toBe("degraded");
    expect(result.summary).toMatchObject({
      totalTasks: 2,
      degradedTasks: 2,
      failedTasks: 0,
    });
    expect(result.results[0]?.digest?.summary).toContain("工具调用");
  });

  it("adds decision-only evolution tasks for impacted Recipes", async () => {
    const projectRoot = await makeFixtureProject();
    const dataRoot = await makeTempRoot("alembic-agent-data-");
    const recipe = createRecipe({
      id: "recipe-api-client",
      title: "API Client",
      status: "active",
      sourceRefIds: ["src/api.ts"],
      knowledge: createRecipeKnowledgePayload({
        coreCode: "fetchUser();",
        content: {
          pattern: "Use fetchUser for API loading.",
          steps: [{ code: "return fetchUser();" }],
        },
        sourceFile: "src/api.ts",
      }),
    });
    const runner = new ScanLifecycleRunner();
    await runner.run({
      kind: "bootstrap",
      projectRoot,
      workspace: { dataRoot, mode: "ghost" },
      recipes: [recipe],
      generatedAt: 1,
    });
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

    const tasks = planAgentWorkflowTasks(rescan, { maxTasks: 10, includeEvolution: true });
    const evolutionTask = tasks.find((task) => task.kind === "evolution");
    expect(evolutionTask).toMatchObject({
      id: "evolution:recipe-api-client",
      allowedToolIds: ["knowledge.manage"],
      sharedState: { _evolutionDecisionOnly: true },
    });
  });
});

async function makeFixtureProject(): Promise<string> {
  const root = await makeTempRoot("alembic-agent-project-");
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

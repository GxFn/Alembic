import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentDimensionWorkflowResult } from "../agent/AgentDimensionWorkflow.js";
import { DisabledWorkflowFinalizer } from "../finalizer/index.js";
import { ScanLifecycleRunner } from "../scan/ScanLifecycleRunner.js";
import { JsonWorkflowReportStore } from "./WorkflowReportStore.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe("workflow report store", () => {
  it("writes scan and finalizer summaries to JSON and Markdown reports", async () => {
    const projectRoot = await makeFixtureProject();
    const dataRoot = await makeTempRoot("alembic-report-data-");
    const scan = await new ScanLifecycleRunner().run({
      kind: "bootstrap",
      projectRoot,
      workspace: { dataRoot, mode: "ghost" },
      generatedAt: 123,
    });
    const finalizer = await new DisabledWorkflowFinalizer().run({
      kind: "bootstrap",
      projectRoot,
      scan,
    });
    const store = new JsonWorkflowReportStore({
      reportsDir: path.join(dataRoot, ".asd", "logs", "reports"),
      now: () => new Date("2026-05-11T00:00:00.000Z"),
    });

    const reference = await store.save({
      kind: "bootstrap",
      scan,
      finalizer,
      source: "test",
      jobId: "bootstrap_test",
    });

    await expect(readJson(reference.jsonPath)).resolves.toMatchObject({
      version: 1,
      id: reference.id,
      kind: "bootstrap",
      status: "completed",
      source: "test",
      jobId: "bootstrap_test",
      summary: {
        scan: expect.objectContaining({ scannedFiles: 2 }),
        finalizer: { completedSteps: 0, skippedSteps: 4, failedSteps: 0 },
      },
      phases: {
        finalizer: expect.arrayContaining([
          expect.objectContaining({
            id: "delivery",
            status: "skipped",
            reason: "disabled_for_codex_plugin_stage",
          }),
        ]),
      },
    });
    await expect(fs.readFile(reference.markdownPath, "utf8")).resolves.toContain(
      "Alembic bootstrap report",
    );
  });

  it("marks reports degraded when internal agent fill degrades", async () => {
    const projectRoot = await makeFixtureProject();
    const dataRoot = await makeTempRoot("alembic-report-data-");
    const scan = await new ScanLifecycleRunner().run({
      kind: "bootstrap",
      projectRoot,
      workspace: { dataRoot, mode: "ghost" },
      generatedAt: 124,
    });
    const finalizer = await new DisabledWorkflowFinalizer().run({
      kind: "bootstrap",
      projectRoot,
      scan,
      agent: degradedAgent(scan),
    });
    const store = new JsonWorkflowReportStore({
      reportsDir: path.join(dataRoot, ".asd", "logs", "reports"),
      now: () => new Date("2026-05-11T00:01:00.000Z"),
    });

    const reference = await store.save({
      kind: "bootstrap",
      scan,
      agent: degradedAgent(scan),
      finalizer,
      source: "test-agent-fill",
      jobId: "bootstrap_agent_degraded",
    });

    await expect(readJson(reference.jsonPath)).resolves.toMatchObject({
      status: "degraded",
      source: "test-agent-fill",
      jobId: "bootstrap_agent_degraded",
      summary: {
        agent: {
          totalTasks: 1,
          completedTasks: 0,
          degradedTasks: 1,
          failedTasks: 0,
          candidateCount: 0,
        },
        finalizer: { completedSteps: 0, skippedSteps: 4, failedSteps: 0 },
      },
      warnings: expect.arrayContaining(["ai_provider_missing_for_agent_dimension"]),
    });
    await expect(fs.readFile(reference.markdownPath, "utf8")).resolves.toContain(
      "- status: degraded",
    );
  });
});

async function makeFixtureProject(): Promise<string> {
  const root = await makeTempRoot("alembic-report-project-");
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

function degradedAgent(
  scan: Awaited<ReturnType<ScanLifecycleRunner["run"]>>,
): AgentDimensionWorkflowResult {
  return {
    status: "degraded",
    mode: scan.mode,
    projectRoot: scan.projectRoot,
    tasks: [],
    results: [],
    summary: {
      totalTasks: 1,
      completedTasks: 0,
      degradedTasks: 1,
      failedTasks: 0,
      candidateCount: 0,
      toolCallCount: 0,
    },
    warnings: ["ai_provider_missing_for_agent_dimension"],
  };
}

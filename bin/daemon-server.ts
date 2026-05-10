#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { readPackageInfo } from "../lib/codex/package-info.js";
import { inspectWorkspace, resolveProjectRoot } from "../lib/codex/workspace.js";
import { startDaemonHttpBridge } from "../lib/daemon/DaemonHttpBridge.js";
import type { DaemonJobHandler } from "../lib/daemon/DaemonJobRunner.js";
import { clearDaemonState, writeDaemonState } from "../lib/daemon/DaemonState.js";
import { JsonDaemonJobStore } from "../lib/daemon/JobStore.js";
import {
  createMainlineWorkflowPersistence,
  MainlineWorkflowEntrypoint,
} from "../lib/workflows/index.js";

const projectRoot = resolveProjectRoot(process.env.ALEMBIC_PROJECT_DIR);
const workspace = inspectWorkspace(projectRoot);
if (!workspace.projectId) {
  throw new Error("Alembic workspace is not initialized. Run `alembic codex init` first.");
}

const info = readPackageInfo();
const startedAt = new Date().toISOString();
const dataRoot = process.env.ALEMBIC_DAEMON_DATA_ROOT ?? workspace.dataRoot;
const workflowPersistence = await createMainlineWorkflowPersistence({
  projectRoot: workspace.projectRoot,
  dataRoot,
  mode: workspace.mode,
});
const initialState = {
  pid: process.pid,
  port: Number.parseInt(process.env.ALEMBIC_DAEMON_PORT ?? "0", 10) || 0,
  token: process.env.ALEMBIC_DAEMON_TOKEN ?? randomBytes(24).toString("hex"),
  projectRoot: workspace.projectRoot,
  dataRoot,
  projectId: workspace.projectId,
  databasePath: workflowPersistence.workspacePaths.databasePath,
  version: info.version,
  startedAt,
  updatedAt: startedAt,
};

const interruptedJobs = await new JsonDaemonJobStore(initialState.dataRoot).markInterrupted();
let currentState = initialState;
const workflow = new MainlineWorkflowEntrypoint(workflowPersistence.dependencies);
const workflowHandlers: Record<"bootstrap" | "rescan", DaemonJobHandler> = {
  bootstrap: async (job, context) =>
    runWorkflowJob(workflow, "bootstrap", workspace.projectRoot, job.input, context.isCancelled),
  rescan: async (job, context) =>
    runWorkflowJob(workflow, "rescan", workspace.projectRoot, job.input, context.isCancelled),
};
const bridge = await startDaemonHttpBridge({
  state: () => currentState,
  requestedPort: initialState.port,
  jobHandlers: workflowHandlers,
  autoRunJobs: true,
});
const readyState = {
  ...initialState,
  port: bridge.port,
  updatedAt: new Date().toISOString(),
};
currentState = readyState;
await writeDaemonState(readyState);

process.stderr.write(
  `Alembic daemon ready on ${bridge.url}; interruptedJobs=${interruptedJobs.length}\n`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await shutdown();
  });
}

async function shutdown(): Promise<void> {
  await bridge.close();
  await clearDaemonState(readyState.dataRoot);
  process.exit(0);
}

async function runWorkflowJob(
  workflow: MainlineWorkflowEntrypoint,
  kind: "bootstrap" | "rescan",
  projectRoot: string,
  input: Record<string, unknown> | undefined,
  isCancelled: () => Promise<boolean>,
): Promise<Record<string, unknown>> {
  const result = await workflow.run({
    kind,
    projectRoot,
    scan: isRecord(input?.scan) ? input.scan : {},
    changedFiles: stringList(input?.changedFiles),
    cancellation: { isCancelled },
  });
  return JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

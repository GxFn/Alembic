#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { readPackageInfo } from "../lib/codex/package-info.js";
import { inspectWorkspace, resolveProjectRoot } from "../lib/codex/workspace.js";
import { startDaemonHttpBridge } from "../lib/daemon/DaemonHttpBridge.js";
import type { DaemonJobExecutionContext, DaemonJobHandler } from "../lib/daemon/DaemonJobRunner.js";
import { clearDaemonState, writeDaemonState } from "../lib/daemon/DaemonState.js";
import { type DaemonJobProgressStep, JsonDaemonJobStore } from "../lib/daemon/JobStore.js";
import { MainlineCompileSession } from "../lib/mainline/compile/index.js";
import {
  createMainlineWorkflowPersistence,
  type ScanLifecycleResult,
  type ScanLifecycleRunInput,
  ScanLifecycleRunner,
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
const compileSession = new MainlineCompileSession({
  workspacePaths: workflowPersistence.workspacePaths,
  writeBoundary: workflowPersistence.writeBoundary,
  contextIndex: workflowPersistence.contextIndex,
  searchIndex: workflowPersistence.searchIndex,
  artifactStore: workflowPersistence.artifactStore,
});
const scanLifecycleRunner =
  workflowPersistence.dependencies.lifecycleRunner ??
  new ScanLifecycleRunner({
    workspacePaths: workflowPersistence.workspacePaths,
    compileSession,
    persistedArtifacts: workflowPersistence.persistedArtifacts,
    ...(workflowPersistence.dependencies.resetRuntimeState === undefined
      ? {}
      : { resetRuntimeState: workflowPersistence.dependencies.resetRuntimeState }),
  });
// 中文注释：daemon 是 Codex 插件后台入口，bootstrap/rescan 这类长任务在 daemon 中执行；
// MCP stdio 只负责把请求排入 durable queue，HTTP enqueue 返回后不等待编译完成。
const workflowHandlers: Record<"bootstrap" | "rescan", DaemonJobHandler> = {
  bootstrap: async (job, context) =>
    runScanLifecycleJob(
      scanLifecycleRunner,
      "bootstrap",
      workspace.projectRoot,
      job.input,
      context,
    ),
  rescan: async (job, context) =>
    runScanLifecycleJob(scanLifecycleRunner, "rescan", workspace.projectRoot, job.input, context),
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

async function runScanLifecycleJob(
  runner: ScanLifecycleRunner,
  kind: "bootstrap" | "rescan",
  projectRoot: string,
  input: Record<string, unknown> | undefined,
  context: DaemonJobExecutionContext,
): Promise<Record<string, unknown>> {
  await context.reportProgress({
    phase: "scan:preparing",
    message: `Preparing ${kind} scan lifecycle.`,
    percent: 10,
  });
  if (await context.isCancelled()) {
    return { kind, cancelled: true };
  }
  await context.reportProgress({
    phase: "scan:running",
    message: `Running ${kind} scan lifecycle.`,
    percent: 20,
  });
  const result = await runner.run({
    kind,
    projectRoot,
    ...scanLifecycleInput(input),
    cancellation: { isCancelled: () => context.isCancelled() },
  });
  if (await context.isCancelled()) {
    return { kind, cancelled: true };
  }
  await context.reportProgress({
    phase: "scan:completed",
    message: `${kind} scan lifecycle completed.`,
    percent: 90,
    steps: scanLifecycleProgressSteps(result),
  });
  return JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
}

function scanLifecycleProgressSteps(result: ScanLifecycleResult): DaemonJobProgressStep[] {
  const lifecycleSteps = result.phases.map((phase) => ({
    phase: phase.id,
    status: phase.status,
    ...(phase.error === undefined ? {} : { message: phase.error }),
  }));
  const compileSteps =
    result.compile?.progress.checkpoints.map((checkpoint) => ({
      phase: `compile:${checkpoint.phase}`,
      status: checkpoint.status,
      ...(checkpoint.detail === undefined ? {} : { message: checkpoint.detail }),
    })) ?? [];
  const steps = [...lifecycleSteps, ...compileSteps];
  const stepCount = steps.length;

  return steps.map((step, index) => ({
    ...step,
    percent: stepCount === 0 ? 100 : Math.round(((index + 1) / stepCount) * 100),
  }));
}

function scanLifecycleInput(
  input: Record<string, unknown> | undefined,
): Omit<ScanLifecycleRunInput, "projectRoot" | "kind" | "cancellation"> {
  if (!input) {
    return {};
  }

  return {
    ...(isRecord(input.scan) ? { scan: input.scan } : {}),
    ...optionalStringList("changedFiles", input.changedFiles),
    ...optionalStringList("removedFiles", input.removedFiles),
    ...optionalStringMap("diffTextByPath", input.diffTextByPath),
    ...optionalStringList("notes", input.notes),
    ...optionalFiniteNumber("maxFileBytes", input.maxFileBytes),
    ...optionalFiniteNumber("dependentDepth", input.dependentDepth),
    ...optionalFiniteNumber("fullRebuildChangeRatio", input.fullRebuildChangeRatio),
    ...optionalCleanupPolicy(input.cleanup),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalStringList(
  key: "changedFiles" | "removedFiles" | "notes",
  value: unknown,
): Partial<Pick<ScanLifecycleRunInput, typeof key>> {
  if (!Array.isArray(value)) {
    return {};
  }
  const strings = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
  return strings.length > 0 ? { [key]: strings } : {};
}

function optionalStringMap(
  key: "diffTextByPath",
  value: unknown,
): Partial<Pick<ScanLifecycleRunInput, typeof key>> {
  if (!isRecord(value)) {
    return {};
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] =>
      typeof entry[0] === "string" && typeof entry[1] === "string",
  );
  return entries.length > 0 ? { [key]: Object.fromEntries(entries) } : {};
}

function optionalFiniteNumber(
  key: "maxFileBytes" | "dependentDepth" | "fullRebuildChangeRatio",
  value: unknown,
): Partial<Pick<ScanLifecycleRunInput, typeof key>> {
  return typeof value === "number" && Number.isFinite(value) ? { [key]: value } : {};
}

function optionalCleanupPolicy(value: unknown): Partial<Pick<ScanLifecycleRunInput, "cleanup">> {
  return value === "full-reset" || value === "rescan-clean" || value === "none"
    ? { cleanup: value }
    : {};
}

#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { readPackageInfo } from "../lib/codex/package-info.js";
import { inspectWorkspace, resolveProjectRoot } from "../lib/codex/workspace.js";
import { startDaemonHttpBridge } from "../lib/daemon/DaemonHttpBridge.js";
import type { DaemonJobHandler } from "../lib/daemon/DaemonJobRunner.js";
import { clearDaemonState, writeDaemonState } from "../lib/daemon/DaemonState.js";
import { JsonDaemonJobStore } from "../lib/daemon/JobStore.js";
import {
  MainlineCompileSession,
  type MainlineCompileSessionRequest,
} from "../lib/mainline/compile/index.js";
import { createMainlineWorkflowPersistence } from "../lib/workflows/index.js";

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
  artifactStore: workflowPersistence.artifactStore,
});
// 中文注释：daemon 是 Codex 插件后台入口，bootstrap/rescan 这类长任务在 daemon 中执行；
// MCP stdio 只负责把请求排入 durable queue，HTTP enqueue 返回后不等待编译完成。
const workflowHandlers: Record<"bootstrap" | "rescan", DaemonJobHandler> = {
  bootstrap: async (job, context) =>
    runCompileSessionJob(
      compileSession,
      "cold-start",
      workspace.projectRoot,
      job.input,
      context.isCancelled,
    ),
  rescan: async (job, context) =>
    runCompileSessionJob(
      compileSession,
      "incremental",
      workspace.projectRoot,
      job.input,
      context.isCancelled,
    ),
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

async function runCompileSessionJob(
  compileSession: MainlineCompileSession,
  mode: "cold-start" | "incremental",
  projectRoot: string,
  input: Record<string, unknown> | undefined,
  isCancelled: () => Promise<boolean>,
): Promise<Record<string, unknown>> {
  if (await isCancelled()) {
    return { mode, cancelled: true };
  }
  const result = await compileSession.run({
    projectRoot,
    mode,
    ...compileSessionInput(input),
  });
  if (await isCancelled()) {
    return { mode, cancelled: true };
  }
  return JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
}

function compileSessionInput(
  input: Record<string, unknown> | undefined,
): Omit<MainlineCompileSessionRequest, "projectRoot" | "mode"> {
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
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalStringList(
  key: "changedFiles" | "removedFiles" | "notes",
  value: unknown,
): Partial<Pick<MainlineCompileSessionRequest, typeof key>> {
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
): Partial<Pick<MainlineCompileSessionRequest, typeof key>> {
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
): Partial<Pick<MainlineCompileSessionRequest, typeof key>> {
  return typeof value === "number" && Number.isFinite(value) ? { [key]: value } : {};
}

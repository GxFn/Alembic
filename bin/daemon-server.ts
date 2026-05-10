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
  ColdStartWorkflow,
  createMainlineWorkflowPersistence,
  InternalColdStartWorkflow,
  InternalKnowledgeRescanWorkflow,
  KnowledgeRescanWorkflow,
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
const internalColdStartWorkflow = new InternalColdStartWorkflow({
  coldStart: new ColdStartWorkflow(scanLifecycleRunner),
  toolDependencies: workflowPersistence.agentToolDependencies,
});
const internalKnowledgeRescanWorkflow = new InternalKnowledgeRescanWorkflow({
  rescan: new KnowledgeRescanWorkflow(scanLifecycleRunner),
  toolDependencies: workflowPersistence.agentToolDependencies,
});
// 中文注释：daemon 是 Codex 插件后台入口，bootstrap/rescan 这类长任务在 daemon 中执行；
// MCP stdio 只负责把请求排入 durable queue，HTTP enqueue 返回后不等待编译完成。
const workflowHandlers: Record<"bootstrap" | "rescan", DaemonJobHandler> = {
  bootstrap: async (job, context) =>
    runWorkflowJob(
      scanLifecycleRunner,
      internalColdStartWorkflow,
      internalKnowledgeRescanWorkflow,
      "bootstrap",
      workspace.projectRoot,
      job.input,
      context,
    ),
  rescan: async (job, context) =>
    runWorkflowJob(
      scanLifecycleRunner,
      internalColdStartWorkflow,
      internalKnowledgeRescanWorkflow,
      "rescan",
      workspace.projectRoot,
      job.input,
      context,
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

async function runWorkflowJob(
  runner: ScanLifecycleRunner,
  internalColdStart: InternalColdStartWorkflow,
  internalRescan: InternalKnowledgeRescanWorkflow,
  kind: "bootstrap" | "rescan",
  projectRoot: string,
  input: Record<string, unknown> | undefined,
  context: DaemonJobExecutionContext,
): Promise<Record<string, unknown>> {
  const agentFill = input?.agentFill === true;
  await context.reportProgress({
    phase: "scan:preparing",
    message: agentFill
      ? `Preparing ${kind} scan and internal agent workflow.`
      : `Preparing ${kind} scan lifecycle.`,
    percent: 10,
  });
  if (await context.isCancelled()) {
    return { kind, cancelled: true };
  }
  await context.reportProgress({
    phase: "scan:running",
    message: agentFill
      ? `Running ${kind} scan and internal agent workflow.`
      : `Running ${kind} scan lifecycle.`,
    percent: 20,
  });
  const cancellation = { isCancelled: () => context.isCancelled() };
  const result = agentFill
    ? await runInternalAgentWorkflowJob({
        internalColdStart,
        internalRescan,
        kind,
        projectRoot,
        input,
        cancellation,
      })
    : await runner.run({
        kind,
        projectRoot,
        ...scanLifecycleInput(input),
        cancellation,
      });
  if (await context.isCancelled()) {
    return { kind, cancelled: true };
  }
  await context.reportProgress({
    phase: "scan:completed",
    message: agentFill
      ? `${kind} scan and internal agent workflow completed.`
      : `${kind} scan lifecycle completed.`,
    percent: 90,
    steps: workflowProgressSteps(result),
  });
  return JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
}

async function runInternalAgentWorkflowJob(input: {
  readonly internalColdStart: InternalColdStartWorkflow;
  readonly internalRescan: InternalKnowledgeRescanWorkflow;
  readonly kind: "bootstrap" | "rescan";
  readonly projectRoot: string;
  readonly input: Record<string, unknown> | undefined;
  readonly cancellation: { isCancelled(): boolean | Promise<boolean> };
}) {
  const agentOptions = agentWorkflowInput(input.input);
  if (input.kind === "bootstrap") {
    return input.internalColdStart.run({
      projectRoot: input.projectRoot,
      ...coldStartInput(input.input),
      ...coldStartAgentWorkflowInput(agentOptions),
      cancellation: input.cancellation,
    });
  }
  return input.internalRescan.run({
    projectRoot: input.projectRoot,
    ...knowledgeRescanInput(input.input),
    ...agentOptions,
    cancellation: input.cancellation,
  });
}

function workflowProgressSteps(
  result: ScanLifecycleResult | Awaited<ReturnType<InternalColdStartWorkflow["run"]>>,
): DaemonJobProgressStep[] {
  if ("scan" in result) {
    const scanSteps = scanLifecycleProgressSteps(result.scan);
    const agentResults = result.agent?.results ?? [];
    const agentSteps = agentResults.map((taskResult) => ({
      phase: `agent:${taskResult.task.kind}:${taskResult.task.id}`,
      status: taskResult.status,
      message: `${taskResult.task.label}: ${taskResult.candidateCount} candidate(s), ${taskResult.toolCallCount} tool call(s)`,
    }));
    const rawSteps = [...scanSteps, ...agentSteps];
    return rawSteps.map((step, index) => ({
      ...step,
      percent: rawSteps.length === 0 ? 100 : Math.round(((index + 1) / rawSteps.length) * 100),
    }));
  }
  return scanLifecycleProgressSteps(result);
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

function coldStartInput(input: Record<string, unknown> | undefined): Pick<
  ScanLifecycleRunInput,
  "scan" | "maxFileBytes" | "notes"
> & {
  readonly cleanup?: "full-reset" | "none";
} {
  const lifecycleInput = scanLifecycleInput(input);
  return {
    ...(lifecycleInput.scan === undefined ? {} : { scan: lifecycleInput.scan }),
    ...(lifecycleInput.maxFileBytes === undefined
      ? {}
      : { maxFileBytes: lifecycleInput.maxFileBytes }),
    ...(lifecycleInput.notes === undefined ? {} : { notes: lifecycleInput.notes }),
    ...(lifecycleInput.cleanup === "full-reset" || lifecycleInput.cleanup === "none"
      ? { cleanup: lifecycleInput.cleanup }
      : {}),
  };
}

function knowledgeRescanInput(input: Record<string, unknown> | undefined): Omit<
  ScanLifecycleRunInput,
  "projectRoot" | "kind" | "cancellation" | "cleanup"
> & {
  readonly cleanup?: "rescan-clean" | "none";
} {
  const lifecycleInput = scanLifecycleInput(input);
  const { cleanup, ...rescanInput } = lifecycleInput;
  return {
    ...rescanInput,
    ...(cleanup === "rescan-clean" || cleanup === "none" ? { cleanup } : {}),
  };
}

function agentWorkflowInput(input: Record<string, unknown> | undefined): {
  readonly maxAgentTasks?: number;
  readonly skipAgentFill?: boolean;
  readonly includeEvolution?: boolean;
} {
  return {
    ...(typeof input?.maxAgentTasks === "number" && Number.isFinite(input.maxAgentTasks)
      ? { maxAgentTasks: input.maxAgentTasks }
      : {}),
    ...(typeof input?.includeEvolution === "boolean"
      ? { includeEvolution: input.includeEvolution }
      : {}),
    skipAgentFill: false,
  };
}

function coldStartAgentWorkflowInput(input: ReturnType<typeof agentWorkflowInput>): {
  readonly maxAgentTasks?: number;
  readonly skipAgentFill?: boolean;
} {
  return {
    ...(input.maxAgentTasks === undefined ? {} : { maxAgentTasks: input.maxAgentTasks }),
    ...(input.skipAgentFill === undefined ? {} : { skipAgentFill: input.skipAgentFill }),
  };
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

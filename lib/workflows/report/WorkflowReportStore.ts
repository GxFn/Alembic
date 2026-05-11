import fs from "node:fs/promises";
import path from "node:path";
import type { AgentDimensionWorkflowResult } from "../agent/AgentDimensionWorkflow.js";
import type { WorkflowFinalizerResult } from "../finalizer/index.js";
import type { ScanLifecycleResult } from "../scan/ScanLifecycleRunner.js";

export interface WorkflowReportReference {
  readonly id: string;
  readonly jsonPath: string;
  readonly markdownPath: string;
}

export interface WorkflowReportStoreInput {
  readonly kind: ScanLifecycleResult["kind"];
  readonly scan: ScanLifecycleResult;
  readonly agent?: AgentDimensionWorkflowResult;
  readonly finalizer?: WorkflowFinalizerResult;
  readonly source?: string;
  readonly jobId?: string;
}

export interface WorkflowReportStorePort {
  save(input: WorkflowReportStoreInput): Promise<WorkflowReportReference>;
}

export interface JsonWorkflowReportStoreOptions {
  readonly reportsDir: string;
  readonly now?: () => Date;
}

interface WorkflowReportDocument {
  readonly version: 1;
  readonly id: string;
  readonly kind: ScanLifecycleResult["kind"];
  readonly status: "completed" | "cancelled" | "failed" | "degraded";
  readonly mode: ScanLifecycleResult["mode"];
  readonly projectRoot: string;
  readonly createdAt: string;
  readonly source?: string;
  readonly jobId?: string;
  readonly summary: {
    readonly scan: ScanLifecycleResult["summary"];
    readonly agent?: AgentDimensionWorkflowResult["summary"];
    readonly finalizer?: WorkflowFinalizerResult["summary"];
  };
  readonly warnings: readonly string[];
  readonly persisted?: ScanLifecycleResult["persisted"];
  readonly phases: {
    readonly scan: ScanLifecycleResult["phases"];
    readonly finalizer?: WorkflowFinalizerResult["steps"];
  };
  readonly recommendations: ScanLifecycleResult["recommendations"];
}

/**
 * WorkflowReportStore 是上层编排的可恢复报告边界。
 * 中文注释：daemon job result 只保存当前 job 状态；这里额外把 scan/agent/finalizer
 * 摘要落到 dataRoot/.asd/logs/reports，供后续 Dashboard/IDE adapter 读取。
 */
export class JsonWorkflowReportStore implements WorkflowReportStorePort {
  readonly #reportsDir: string;
  readonly #now: () => Date;

  constructor(options: JsonWorkflowReportStoreOptions) {
    this.#reportsDir = options.reportsDir;
    this.#now = options.now ?? (() => new Date());
  }

  async save(input: WorkflowReportStoreInput): Promise<WorkflowReportReference> {
    const createdAt = this.#now().toISOString();
    const id = reportId(input, createdAt);
    const reference = {
      id,
      jsonPath: path.join(this.#reportsDir, `${id}.json`),
      markdownPath: path.join(this.#reportsDir, `${id}.md`),
    };
    const document = reportDocument(input, { id, createdAt });

    await fs.mkdir(this.#reportsDir, { recursive: true });
    await Promise.all([
      fs.writeFile(reference.jsonPath, `${JSON.stringify(document, null, 2)}\n`, "utf8"),
      fs.writeFile(reference.markdownPath, `${markdownReport(document)}\n`, "utf8"),
    ]);

    return reference;
  }
}

function reportDocument(
  input: WorkflowReportStoreInput,
  meta: { readonly id: string; readonly createdAt: string },
): WorkflowReportDocument {
  const warnings = [
    ...input.scan.warnings,
    ...(input.agent?.warnings ?? []),
    ...(input.finalizer?.warnings ?? []),
  ];
  return {
    version: 1,
    id: meta.id,
    kind: input.kind,
    status: reportStatus(input),
    mode: input.scan.mode,
    projectRoot: input.scan.projectRoot,
    createdAt: meta.createdAt,
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
    summary: {
      scan: input.scan.summary,
      ...(input.agent === undefined ? {} : { agent: input.agent.summary }),
      ...(input.finalizer === undefined ? {} : { finalizer: input.finalizer.summary }),
    },
    warnings,
    ...(input.scan.persisted === undefined ? {} : { persisted: input.scan.persisted }),
    phases: {
      scan: input.scan.phases,
      ...(input.finalizer === undefined ? {} : { finalizer: input.finalizer.steps }),
    },
    recommendations: input.scan.recommendations,
  };
}

function reportStatus(input: WorkflowReportStoreInput): WorkflowReportDocument["status"] {
  if (input.scan.status !== "completed") {
    return input.scan.status;
  }
  if (input.agent?.status === "failed" || input.finalizer?.status === "failed") {
    return "failed";
  }
  if (input.agent?.status === "degraded") {
    return "degraded";
  }
  return "completed";
}

function reportId(input: WorkflowReportStoreInput, createdAt: string): string {
  return [
    "mainline",
    input.kind,
    String(input.scan.plan.generatedAt),
    createdAt.replace(/[:.]/g, "-"),
  ]
    .map((part) => part.replace(/[^A-Za-z0-9_-]/g, "-"))
    .join("-");
}

function markdownReport(report: WorkflowReportDocument): string {
  const lines = [
    `# Alembic ${report.kind} report`,
    "",
    `- id: ${report.id}`,
    `- status: ${report.status}`,
    `- mode: ${report.mode}`,
    `- projectRoot: ${report.projectRoot}`,
    `- createdAt: ${report.createdAt}`,
    "",
    "## Scan Summary",
    "",
    `- scannedFiles: ${report.summary.scan.scannedFiles}`,
    `- parsedFiles: ${report.summary.scan.parsedFiles}`,
    `- recipes: ${report.summary.scan.recipes}`,
    `- searchDocuments: ${report.summary.scan.searchDocuments}`,
    `- recipeImpacts: ${report.summary.scan.recipeImpacts}`,
    "",
    "## Agent Summary",
    "",
    report.summary.agent
      ? `- tasks: ${report.summary.agent.totalTasks}, completed: ${report.summary.agent.completedTasks}, degraded: ${report.summary.agent.degradedTasks}, failed: ${report.summary.agent.failedTasks}, candidates: ${report.summary.agent.candidateCount}`
      : "- not run",
    "",
    "## Finalizer",
    "",
    report.summary.finalizer
      ? `- completed: ${report.summary.finalizer.completedSteps}, skipped: ${report.summary.finalizer.skippedSteps}, failed: ${report.summary.finalizer.failedSteps}`
      : "- not run",
  ];
  if (report.warnings.length > 0) {
    lines.push("", "## Warnings", "", ...report.warnings.map((warning) => `- ${warning}`));
  }
  return lines.join("\n");
}

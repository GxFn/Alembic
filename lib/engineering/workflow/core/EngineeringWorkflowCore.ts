import path from "node:path";
import type {
  EngineeringWorkflowDiagnostic,
  EngineeringWorkflowDiagnosticSeverity,
  EngineeringWorkflowPhaseName,
  EngineeringWorkflowPhaseReport,
  EngineeringWorkflowPhaseStatus,
} from "../EngineeringWorkflowTypes.js";

export const ENGINEERING_WORKFLOW_PHASES: readonly EngineeringWorkflowPhaseName[] = [
  "discover",
  "cache",
  "collectFacts",
  "buildGraphs",
  "panorama",
  "optional",
];

const ALEMBIC_GENERATED_BASENAMES = new Set(["AGENTS.md", "CLAUDE.md", "copilot-instructions.md"]);

const ALEMBIC_GENERATED_PATH_SEGMENTS = ["/.cursor/", "/.github/copilot-instructions.md"];

export function isEngineeringGeneratedArtifact(filePath: string): boolean {
  const normalized = normalizeWorkflowPath(filePath);
  const base = path.posix.basename(normalized);
  if (ALEMBIC_GENERATED_BASENAMES.has(base)) {
    return true;
  }
  if (base.endsWith(".mdc")) {
    return true;
  }
  return ALEMBIC_GENERATED_PATH_SEGMENTS.some((segment) => normalized.includes(segment));
}

export function normalizeWorkflowPath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replaceAll(path.sep, "/");
}

export function workflowDiagnostic(
  phase: EngineeringWorkflowPhaseName,
  severity: EngineeringWorkflowDiagnosticSeverity,
  message: string,
  cause?: unknown,
): EngineeringWorkflowDiagnostic {
  return {
    phase,
    severity,
    message,
    ...(cause === undefined
      ? {}
      : { cause: cause instanceof Error ? cause.message : String(cause) }),
  };
}

export async function runWorkflowPhase<T>(
  name: EngineeringWorkflowPhaseName,
  fn: () => Promise<T> | T,
): Promise<
  | {
      readonly ok: true;
      readonly value: T;
      readonly report: EngineeringWorkflowPhaseReport;
    }
  | {
      readonly ok: false;
      readonly error: unknown;
      readonly report: EngineeringWorkflowPhaseReport;
    }
> {
  const startedAt = Date.now();
  try {
    const value = await fn();
    const endedAt = Date.now();
    return {
      ok: true,
      value,
      report: phaseReport(name, "success", startedAt, endedAt),
    };
  } catch (error: unknown) {
    const endedAt = Date.now();
    return {
      ok: false,
      error,
      report: phaseReport(name, "failed", startedAt, endedAt, [
        workflowDiagnostic(name, "error", `${phaseDisplayName(name)} failed`, error),
      ]),
    };
  }
}

export function phaseReport(
  name: EngineeringWorkflowPhaseName,
  status: EngineeringWorkflowPhaseStatus,
  startedAt: number,
  endedAt: number,
  diagnostics: readonly EngineeringWorkflowDiagnostic[] = [],
  summary: Readonly<Record<string, unknown>> = {},
): EngineeringWorkflowPhaseReport {
  return {
    name,
    status,
    timing: {
      startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
    },
    diagnostics,
    summary,
  };
}

export function withPhaseReport(
  report: EngineeringWorkflowPhaseReport,
  updates: {
    readonly status?: EngineeringWorkflowPhaseStatus;
    readonly diagnostics?: readonly EngineeringWorkflowDiagnostic[];
    readonly summary?: Readonly<Record<string, unknown>>;
  },
): EngineeringWorkflowPhaseReport {
  return {
    ...report,
    ...(updates.status === undefined ? {} : { status: updates.status }),
    diagnostics: updates.diagnostics ?? report.diagnostics,
    summary: updates.summary ?? report.summary,
  };
}

function phaseDisplayName(name: EngineeringWorkflowPhaseName): string {
  switch (name) {
    case "discover":
      return "Discovery";
    case "cache":
      return "Cache";
    case "collectFacts":
      return "Fact collection";
    case "buildGraphs":
      return "Graph build";
    case "panorama":
      return "Panorama";
    case "optional":
      return "Optional stage";
  }
}

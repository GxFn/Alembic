import type {
  EngineeringWorkflowDiagnostic,
  EngineeringWorkflowPhaseReport,
  EngineeringWorkflowResult,
} from "../types.js";
import { phaseReport } from "./core.js";

export function phaseStatus(
  diagnostics: readonly EngineeringWorkflowDiagnostic[],
  partial = false,
) {
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return "failed";
  }
  if (partial || diagnostics.length > 0) {
    return "partial";
  }
  return "success";
}

export function workflowStatus(
  reports: readonly EngineeringWorkflowPhaseReport[],
): EngineeringWorkflowResult["status"] {
  if (reports.every((report) => report.status === "failed")) {
    return "failed";
  }
  if (reports.some((report) => report.status === "failed" || report.status === "partial")) {
    return "partial";
  }
  return "success";
}

export function skippedWorkflowPhase(
  name: "collectFacts" | "buildGraphs" | "panorama",
  summary: Readonly<Record<string, unknown>>,
): EngineeringWorkflowPhaseReport {
  const now = Date.now();
  return phaseReport(name, "skipped", now, now, [], summary);
}

export function dedupeDiagnostics(
  diagnostics: readonly EngineeringWorkflowDiagnostic[],
): readonly EngineeringWorkflowDiagnostic[] {
  const byKey = new Map<string, EngineeringWorkflowDiagnostic>();
  for (const diagnostic of diagnostics) {
    byKey.set(
      `${diagnostic.phase}\0${diagnostic.severity}\0${diagnostic.message}\0${diagnostic.cause ?? ""}`,
      diagnostic,
    );
  }
  return [...byKey.values()];
}

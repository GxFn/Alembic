import { phaseReport, runWorkflowPhase, withPhaseReport } from "../core/core.js";
import type {
  EngineeringWorkflowArtifact,
  EngineeringWorkflowDiagnostic,
  EngineeringWorkflowFactBundle,
  EngineeringWorkflowInput,
  EngineeringWorkflowPhaseReport,
} from "../types.js";
import { runEngineeringWorkflowOptionalStage } from "./optional-stage.js";
import type {
  EngineeringWorkflowOptionalDiagnostic,
  EngineeringWorkflowOptionalDimension,
  EngineeringWorkflowOptionalStageInput,
} from "./types.js";

export interface OptionalStagePhaseRun {
  readonly artifact: EngineeringWorkflowArtifact["optionalStage"];
  readonly phaseReport: EngineeringWorkflowPhaseReport;
  readonly workflowDiagnostics: readonly EngineeringWorkflowDiagnostic[];
}

export async function runOptionalStagePhase({
  input,
  facts,
  panoramaSnapshot,
  generatedArtifactPaths,
}: {
  readonly input: EngineeringWorkflowInput;
  readonly facts: EngineeringWorkflowFactBundle;
  readonly panoramaSnapshot: EngineeringWorkflowArtifact["panoramaSnapshot"];
  readonly generatedArtifactPaths: readonly string[];
}): Promise<OptionalStagePhaseRun> {
  const options = normalizeOptionalStageOptions(input);
  if (!options.enabled) {
    const diagnostic: EngineeringWorkflowOptionalDiagnostic = {
      code: "optional.stage.disabled",
      severity: "info",
      message: "Optional workflow stage disabled by input configuration.",
      source: "optional-stage",
    };
    const workflowDiagnostics = optionalDiagnosticsToWorkflow([diagnostic]);
    const now = Date.now();
    return {
      artifact: {
        status: "disabled",
        result: null,
        enhancementSignals: [],
        guardFindings: [],
        dimensionGates: [],
        dimensionFileRefs: [],
        diagnostics: [diagnostic],
      },
      phaseReport: phaseReport("optional", "skipped", now, now, workflowDiagnostics, {
        enabled: false,
        reason: "disabled",
      }),
      workflowDiagnostics,
    };
  }

  const stageInput: EngineeringWorkflowOptionalStageInput = {
    files: facts.files,
    fileContents: facts.fileContents,
    importFacts: facts.importFacts,
    ...(facts.astSummaries === undefined ? {} : { astSummaries: facts.astSummaries }),
    ...(panoramaSnapshot === null ? {} : { panoramaSnapshot }),
    ...(panoramaSnapshot === null ? {} : { gaps: panoramaSnapshot.gaps }),
    ...(options.guardFiles === undefined ? {} : { guardFiles: options.guardFiles }),
    ...(options.guardRuleFacts === undefined ? {} : { guardRuleFacts: options.guardRuleFacts }),
    ...(options.guardCallbacks === undefined ? {} : { guardCallbacks: options.guardCallbacks }),
    dimensions: optionalDimensionsFromInput(input, options),
    generatedArtifactBlacklist: [
      ...generatedArtifactPaths,
      ...(options.generatedArtifactBlacklist ?? []),
    ],
    ...(options.enhancement?.techStackItems === undefined
      ? {}
      : { techStackItems: options.enhancement.techStackItems }),
    ...(options.enhancement?.minConfidence === undefined
      ? {}
      : { minConfidence: options.enhancement.minConfidence }),
  };

  const optionalPhase = await runWorkflowPhase("optional", () =>
    runEngineeringWorkflowOptionalStage(stageInput),
  );

  if (!optionalPhase.ok) {
    const diagnostic: EngineeringWorkflowOptionalDiagnostic = {
      code: "optional.stage.failed",
      severity: "error",
      message: `Optional workflow stage failed: ${errorMessage(optionalPhase.error)}`,
      source: "optional-stage",
    };
    const workflowDiagnostics = optionalDiagnosticsToWorkflow([diagnostic]);
    return {
      artifact: {
        status: "failed",
        result: null,
        enhancementSignals: [],
        guardFindings: [],
        dimensionGates: [],
        dimensionFileRefs: [],
        diagnostics: [diagnostic],
      },
      phaseReport: withPhaseReport(optionalPhase.report, {
        status: "failed",
        diagnostics: [...optionalPhase.report.diagnostics, ...workflowDiagnostics],
        summary: {
          enabled: true,
          enhancementSignals: 0,
          guardFindings: 0,
          dimensionGates: 0,
          dimensionFileRefs: 0,
        },
      }),
      workflowDiagnostics,
    };
  }

  const result = optionalPhase.value;
  const workflowDiagnostics = optionalDiagnosticsToWorkflow(result.diagnostics);
  const status = optionalArtifactStatus(result.diagnostics);
  return {
    artifact: {
      status,
      result,
      enhancementSignals: result.enhancement.signals,
      guardFindings: [...result.guard.findings, ...(result.enhancementReaudit?.findings ?? [])],
      dimensionGates: result.dimensions.gates,
      dimensionFileRefs: result.dimensions.fileRefs,
      diagnostics: result.diagnostics,
    },
    phaseReport: withPhaseReport(optionalPhase.report, {
      status: status === "partial" ? "partial" : "success",
      diagnostics: [...optionalPhase.report.diagnostics, ...workflowDiagnostics],
      summary: {
        enabled: true,
        enhancementPacks: result.enhancement.packs.length,
        enhancementSignals: result.enhancement.signals.length,
        enhancementPatterns: result.enhancement.patterns.length,
        enhancementGuardRules: result.enhancement.guardRules.length,
        guardFindings: result.guard.findings.length,
        enhancementReauditFindings: result.enhancementReaudit?.findings.length ?? 0,
        reAuditDiagnostics: result.enhancementReaudit?.diagnostics.length ?? 0,
        dimensionGates: result.dimensions.gates.length,
        activeDimensions: result.dimensions.activeDimensions.length,
        dimensionFileRefs: result.dimensions.fileRefs.length,
      },
    }),
    workflowDiagnostics,
  };
}

export function skippedOptionalStageArtifact(reason: string): OptionalStagePhaseRun {
  const diagnostic: EngineeringWorkflowOptionalDiagnostic = {
    code: "optional.stage.skipped",
    severity: "info",
    message:
      "Optional workflow stage skipped by incremental plan; cached optional artifacts require an external adapter.",
    source: "optional-stage",
  };
  const workflowDiagnostics = optionalDiagnosticsToWorkflow([diagnostic]);
  const now = Date.now();
  return {
    artifact: {
      status: "skipped",
      result: null,
      enhancementSignals: [],
      guardFindings: [],
      dimensionGates: [],
      dimensionFileRefs: [],
      diagnostics: [diagnostic],
    },
    phaseReport: phaseReport("optional", "skipped", now, now, workflowDiagnostics, {
      enabled: true,
      mode: "skip",
      reason,
    }),
    workflowDiagnostics,
  };
}

function normalizeOptionalStageOptions(input: EngineeringWorkflowInput): Exclude<
  EngineeringWorkflowInput["optionalStage"],
  boolean | undefined
> & {
  readonly enabled: boolean;
} {
  if (input.optionalStage === false) {
    return { enabled: false };
  }
  if (input.optionalStage === true || input.optionalStage === undefined) {
    return { enabled: true };
  }
  return {
    ...input.optionalStage,
    enabled: input.optionalStage.enabled ?? true,
  };
}

function optionalDimensionsFromInput(
  input: EngineeringWorkflowInput,
  options: ReturnType<typeof normalizeOptionalStageOptions>,
): readonly EngineeringWorkflowOptionalDimension[] {
  const configured = options.dimensions ?? [];
  const configuredIds = new Set(configured.map((dimension) => dimension.id));
  const dimensionIds = [...(input.dimensionIds ?? []), ...(options.dimensionIds ?? [])];
  const fromIds = dimensionIds
    .filter((dimensionId) => !configuredIds.has(dimensionId))
    .map((dimensionId) => ({
      id: dimensionId,
      label: humanizeDimensionId(dimensionId),
      knowledgeTypes: [],
      source: "input",
    }));
  return [...configured, ...fromIds];
}

function humanizeDimensionId(dimensionId: string): string {
  return dimensionId
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function optionalArtifactStatus(
  diagnostics: readonly EngineeringWorkflowOptionalDiagnostic[],
): "success" | "partial" {
  return diagnostics.some((diagnostic) => diagnostic.severity !== "info") ? "partial" : "success";
}

function optionalDiagnosticsToWorkflow(
  diagnostics: readonly EngineeringWorkflowOptionalDiagnostic[],
): readonly EngineeringWorkflowDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    phase: "optional",
    severity: optionalSeverityToWorkflow(diagnostic.severity),
    code: diagnostic.code,
    message: diagnostic.message,
    ...(diagnostic.source === undefined ? {} : { cause: diagnostic.source }),
  }));
}

function optionalSeverityToWorkflow(
  severity: EngineeringWorkflowOptionalDiagnostic["severity"],
): EngineeringWorkflowDiagnostic["severity"] {
  switch (severity) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "info":
      return "info";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

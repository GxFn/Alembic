import type {
  EngineeringWorkflowPhaseReport,
  EngineeringWorkflowResult,
} from "../workflow/EngineeringWorkflowTypes.js";
import { buildProjectSnapshot } from "./ProjectSnapshotBuilder.js";
import type {
  ProjectSnapshot,
  ProjectSnapshotDiscoverer,
  ProjectSnapshotInput,
  ProjectSnapshotLanguageProfile,
} from "./ProjectSnapshotTypes.js";

export interface ProjectSnapshotProjectionOptions {
  readonly sourceTag?: string;
  readonly createdAt?: string;
  readonly timestamp?: number;
  readonly discoverer?: ProjectSnapshotDiscoverer;
  readonly fileContents?: Readonly<Record<string, string>>;
  readonly language?: Partial<ProjectSnapshotLanguageProfile> | null;
}

export function projectSnapshotInputFromEngineeringWorkflowResult(
  result: EngineeringWorkflowResult,
  options: ProjectSnapshotProjectionOptions = {},
): ProjectSnapshotInput {
  const artifact = result.artifact;
  const createdAt = options.createdAt ?? createdAtFromPhases(result.phases);
  const discoverer = options.discoverer ?? discovererFromPhases(result.phases);
  return {
    projectRoot: artifact.projectRoot,
    ...(options.sourceTag === undefined ? {} : { sourceTag: options.sourceTag }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
    workflowStatus: result.status,

    allFiles: artifact.files,
    ...(options.fileContents === undefined ? {} : { fileContents: options.fileContents }),
    allTargets: artifact.targets,
    discoverer,
    truncated: result.truncated || artifact.truncated,
    ...(options.language === undefined ? {} : { language: options.language }),

    codeGraph: artifact.codeGraph,
    callGraph: artifact.callGraph,
    dataFlow: artifact.dataFlow,
    entityGraph: artifact.entityGraph,
    panoramaSnapshot: artifact.panoramaSnapshot,
    dependencyGraph: artifact.dependencyGraph,

    optionalStage: artifact.optionalStage,
    dimensionFileRefs: artifact.dimensionFileRefs,
    generatedArtifactBlacklist: artifact.generatedArtifactBlacklist,

    phaseReports: result.phases,
    diagnostics: result.diagnostics,
    capabilities: result.capabilities,
    incrementalPlan: result.incrementalPlan ?? artifact.incrementalPlan ?? null,
    snapshotRun: result.snapshot ?? null,
    snapshotId: artifact.snapshotId ?? result.snapshot?.snapshotId ?? null,
  };
}

export function projectSnapshotFromEngineeringWorkflowResult(
  result: EngineeringWorkflowResult,
  options: ProjectSnapshotProjectionOptions = {},
): ProjectSnapshot {
  return buildProjectSnapshot(projectSnapshotInputFromEngineeringWorkflowResult(result, options));
}

function createdAtFromPhases(
  phases: readonly EngineeringWorkflowPhaseReport[],
): string | undefined {
  const startedAt = phases[0]?.timing.startedAt;
  if (startedAt === undefined || !Number.isFinite(startedAt)) {
    return undefined;
  }
  return new Date(startedAt).toISOString();
}

function discovererFromPhases(
  phases: readonly EngineeringWorkflowPhaseReport[],
): ProjectSnapshotDiscoverer {
  const discoverSummary = phases.find((phase) => phase.name === "discover")?.summary;
  if (!isRecord(discoverSummary)) {
    return { id: "unknown", displayName: "Unknown" };
  }
  const id = nonEmptyString(discoverSummary.discovererId) ?? "unknown";
  const displayName =
    nonEmptyString(discoverSummary.discovererName) ??
    nonEmptyString(discoverSummary.displayName) ??
    nonEmptyString(discoverSummary.name) ??
    (id === "unknown" ? "Unknown" : id);
  return { id, displayName };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

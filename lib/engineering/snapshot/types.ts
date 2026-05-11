import type {
  EngineeringCodeCallGraphEdge,
  EngineeringCodeDataFlowEdge,
  EngineeringCodeGraphSnapshot,
} from "../code/types.js";
import type {
  EngineeringDependencyGraph,
  EngineeringFile,
  EngineeringTarget,
} from "../foundation/types.js";
import type { EngineeringPanoramaSnapshot } from "../panorama/types.js";
import type { EngineeringWorkflowIncrementalPlan } from "../workflow/incremental/types.js";
import type {
  EngineeringWorkflowDimensionFileRef,
  EngineeringWorkflowEnhancementPackInfo,
  EngineeringWorkflowEnhancementPatternCandidate,
  EngineeringWorkflowGuardAuditResult,
  EngineeringWorkflowGuardRuleFact,
  EngineeringWorkflowOptionalDimension,
} from "../workflow/optional/types.js";
import type {
  EngineeringWorkflowCapabilities,
  EngineeringWorkflowDiagnostic,
  EngineeringWorkflowOptionalStageArtifact,
  EngineeringWorkflowPhaseReport,
  EngineeringWorkflowResult,
  EngineeringWorkflowSnapshotRunSummary,
} from "../workflow/types.js";

export const ENGINEERING_PROJECT_SNAPSHOT_VERSION = "engineering-project-snapshot/v1";

export interface ProjectSnapshotFile {
  readonly name: string;
  readonly path: string;
  readonly relativePath: string;
  readonly language: string;
  readonly targetName?: string;
  readonly moduleName?: string;
  readonly isTest?: boolean;
  readonly content?: string;
  readonly totalLines?: number;
}

export interface ProjectSnapshotTarget {
  readonly name: string;
  readonly path?: string;
  readonly type?: string;
  readonly language?: string;
  readonly framework?: string | null;
  readonly packageName?: string;
  readonly inferredRole?: string;
  readonly fileCount?: number;
  readonly isLocalPackage?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ProjectSnapshotDiscoverer {
  readonly id: string;
  readonly displayName: string;
}

export interface ProjectSnapshotLanguageProfile {
  readonly primaryLang: string;
  readonly stats: Readonly<Record<string, number>>;
  readonly secondary: readonly string[];
  readonly isMultiLang: boolean;
}

export interface ProjectSnapshotLocalPackageModule {
  readonly name: string;
  readonly packageName: string;
  readonly fileCount: number;
  readonly inferredRole?: string;
  readonly keyFiles: readonly string[];
}

export interface ProjectSnapshotInput {
  readonly projectRoot: string;
  readonly sourceTag?: string;
  readonly createdAt?: string;
  readonly timestamp?: number;
  readonly workflowStatus?: EngineeringWorkflowResult["status"];

  readonly allFiles?: unknown;
  readonly fileContents?: Readonly<Record<string, string>>;
  readonly allTargets?: unknown;
  readonly discoverer?: unknown;
  readonly truncated?: boolean;
  readonly isEmpty?: boolean;

  readonly language?: Partial<ProjectSnapshotLanguageProfile> | null;
  readonly primaryLang?: string | null;
  readonly langStats?: Readonly<Record<string, number>> | null;

  readonly codeGraph?: EngineeringCodeGraphSnapshot | null;
  readonly callGraph?: readonly EngineeringCodeCallGraphEdge[] | null;
  readonly dataFlow?: readonly EngineeringCodeDataFlowEdge[] | null;
  readonly entityGraph?: EngineeringWorkflowResult["artifact"]["entityGraph"] | null;
  readonly panoramaSnapshot?: EngineeringPanoramaSnapshot | null;
  readonly dependencyGraph?: EngineeringDependencyGraph | null;

  readonly optionalStage?: EngineeringWorkflowOptionalStageArtifact | null;
  readonly guardAudit?: EngineeringWorkflowGuardAuditResult | null;
  readonly activeDimensions?: unknown;
  readonly enhancementPackInfo?: unknown;
  readonly enhancementPatterns?: unknown;
  readonly enhancementGuardRules?: unknown;
  readonly detectedFrameworks?: readonly string[];
  readonly dimensionFileRefs?: readonly EngineeringWorkflowDimensionFileRef[];
  readonly generatedArtifactBlacklist?: readonly string[];

  readonly targetsSummary?: unknown;
  readonly localPackageModules?: unknown;

  readonly phaseReports?: readonly EngineeringWorkflowPhaseReport[];
  readonly diagnostics?: readonly EngineeringWorkflowDiagnostic[];
  readonly capabilities?: EngineeringWorkflowCapabilities;
  readonly incrementalPlan?: EngineeringWorkflowIncrementalPlan | null;
  readonly snapshotRun?: EngineeringWorkflowSnapshotRunSummary | null;
  readonly snapshotId?: string | null;
}

export interface ProjectSnapshot {
  readonly version: string;
  readonly createdAt: string;
  readonly timestamp: number;
  readonly projectRoot: string;
  readonly sourceTag?: string;
  readonly workflowStatus?: EngineeringWorkflowResult["status"];

  readonly allFiles: readonly ProjectSnapshotFile[];
  readonly allTargets: readonly ProjectSnapshotTarget[];
  readonly discoverer: ProjectSnapshotDiscoverer;
  readonly truncated: boolean;
  readonly isEmpty: boolean;

  readonly language: ProjectSnapshotLanguageProfile;
  readonly langProfile: ProjectSnapshotLanguageProfile;
  readonly codeGraph: EngineeringCodeGraphSnapshot | null;
  readonly callGraph: readonly EngineeringCodeCallGraphEdge[];
  readonly dataFlow: readonly EngineeringCodeDataFlowEdge[];
  readonly entityGraph: EngineeringWorkflowResult["artifact"]["entityGraph"] | null;
  readonly panorama: EngineeringPanoramaSnapshot | null;
  readonly dependencyGraph: EngineeringDependencyGraph | null;

  readonly optionalStage: EngineeringWorkflowOptionalStageArtifact | null;
  readonly guardAudit: EngineeringWorkflowGuardAuditResult | null;
  readonly activeDimensions: readonly EngineeringWorkflowOptionalDimension[];
  readonly enhancementPackInfo: readonly EngineeringWorkflowEnhancementPackInfo[];
  readonly enhancementPatterns: readonly EngineeringWorkflowEnhancementPatternCandidate[];
  readonly enhancementGuardRules: readonly EngineeringWorkflowGuardRuleFact[];
  readonly detectedFrameworks: readonly string[];
  readonly dimensionFileRefs: readonly EngineeringWorkflowDimensionFileRef[];
  readonly generatedArtifactBlacklist: readonly string[];

  readonly targetsSummary: readonly ProjectSnapshotTarget[];
  readonly localPackageModules: readonly ProjectSnapshotLocalPackageModule[];

  readonly phaseReports: readonly EngineeringWorkflowPhaseReport[];
  readonly diagnostics: readonly EngineeringWorkflowDiagnostic[];
  readonly capabilities: EngineeringWorkflowCapabilities | null;
  readonly incrementalPlan: EngineeringWorkflowIncrementalPlan | null;
  readonly snapshotRun: EngineeringWorkflowSnapshotRunSummary | null;
  readonly snapshotId: string | null;
}

export type ProjectSnapshotFileInput = EngineeringFile | ProjectSnapshotFile | string;
export type ProjectSnapshotTargetInput = EngineeringTarget | ProjectSnapshotTarget | string;

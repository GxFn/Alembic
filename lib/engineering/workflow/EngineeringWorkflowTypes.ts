import type { EngineeringCodeImportPathHints } from "../code/analysis/index.js";
import type {
  EngineeringCodeAstSummaryInput,
  EngineeringCodeCallGraphEdge,
  EngineeringCodeDataFlowEdge,
  EngineeringCodeGraphSnapshot,
} from "../code/EngineeringCodeGraphModel.js";
import type { EngineeringEntity, EngineeringEntityEdge } from "../entity/EngineeringEntityGraph.js";
import type {
  EngineeringDependencyGraph,
  EngineeringDiscoverer,
  EngineeringFile,
  EngineeringTarget,
} from "../foundation/EngineeringCoreTypes.js";
import type { EngineeringImportFact } from "../panorama/EngineeringModuleDiscoverer.js";
import type {
  EngineeringPanoramaService,
  EngineeringPanoramaServiceInput,
} from "../panorama/EngineeringPanoramaService.js";
import type {
  EngineeringPanoramaSnapshot,
  EngineeringRecipeCoverageFact,
  EngineeringTechStackItem,
} from "../panorama/EngineeringPanoramaTypes.js";
import type {
  EngineeringWorkflowDimensionSnapshot,
  EngineeringWorkflowFileInput,
  EngineeringWorkflowSnapshotStore,
} from "./cache/EngineeringWorkflowCacheTypes.js";
import type {
  EngineeringWorkflowIncrementalMode,
  EngineeringWorkflowIncrementalPlan,
} from "./incremental/EngineeringWorkflowIncrementalTypes.js";
import type {
  EngineeringWorkflowDimensionFileRef,
  EngineeringWorkflowDimensionGate,
  EngineeringWorkflowEnhancementSignal,
  EngineeringWorkflowGuardFile,
  EngineeringWorkflowGuardFinding,
  EngineeringWorkflowGuardRuleCallback,
  EngineeringWorkflowGuardRuleFact,
  EngineeringWorkflowOptionalDiagnostic,
  EngineeringWorkflowOptionalDimension,
  EngineeringWorkflowOptionalStageResult,
} from "./optional/EngineeringWorkflowOptionalTypes.js";

export type EngineeringWorkflowPhaseName =
  | "discover"
  | "cache"
  | "collectFacts"
  | "buildGraphs"
  | "panorama"
  | "optional";

export type EngineeringWorkflowPhaseStatus = "success" | "partial" | "failed" | "skipped";

export type EngineeringWorkflowDiagnosticSeverity = "info" | "warning" | "error";

export interface EngineeringWorkflowDiagnostic {
  readonly phase: EngineeringWorkflowPhaseName;
  readonly severity: EngineeringWorkflowDiagnosticSeverity;
  readonly message: string;
  readonly code?: string;
  readonly cause?: string;
}

export interface EngineeringWorkflowPhaseTiming {
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
}

export interface EngineeringWorkflowPhaseReport {
  readonly name: EngineeringWorkflowPhaseName;
  readonly status: EngineeringWorkflowPhaseStatus;
  readonly timing: EngineeringWorkflowPhaseTiming;
  readonly diagnostics: readonly EngineeringWorkflowDiagnostic[];
  readonly summary: Readonly<Record<string, unknown>>;
}

export interface EngineeringWorkflowCapabilities {
  readonly injectedDiscovery: boolean;
  readonly injectedAstSummaries: boolean;
  readonly injectedFileContents: boolean;
  readonly injectedImportFacts: boolean;
  readonly discovery: boolean;
  readonly factCollection: boolean;
  readonly codeGraph: boolean;
  readonly callGraph: boolean;
  readonly dataFlow: boolean;
  readonly entityGraph: boolean;
  readonly panorama: boolean;
  readonly optionalStage: boolean;
  readonly dimensionFileRefs: boolean;
  readonly cache: boolean;
  readonly incrementalStore: boolean;
}

export interface EngineeringWorkflowDiscoveryResult {
  readonly targets: readonly EngineeringTarget[];
  readonly files: readonly EngineeringFile[];
  readonly dependencyGraph: EngineeringDependencyGraph;
  readonly discovererId?: string;
  readonly discovererName?: string;
  readonly diagnostics?: readonly EngineeringWorkflowDiagnostic[];
  readonly truncated?: boolean;
}

export interface EngineeringWorkflowInput {
  readonly projectRoot: string;
  readonly maxFiles?: number;
  readonly discoveryResult?: EngineeringWorkflowDiscoveryResult;
  readonly discoverer?: EngineeringDiscoverer;
  readonly astSummaries?: EngineeringCodeAstSummaryInput;
  readonly fileContents?: Readonly<Record<string, string>>;
  readonly importFacts?: readonly EngineeringImportFact[];
  readonly pathHints?: EngineeringCodeImportPathHints;
  readonly panoramaService?: EngineeringPanoramaService;
  readonly generatedAt?: number | null;
  readonly computedAt?: number;
  readonly staleAfterMs?: number | null;
  readonly stale?: boolean;
  readonly snapshotStore?: EngineeringWorkflowSnapshotStore;
  readonly currentFingerprints?: readonly EngineeringWorkflowFileInput[];
  readonly baselineSnapshotId?: string;
  readonly baselineSelector?: EngineeringWorkflowBaselineSelector;
  readonly incremental?: boolean | EngineeringWorkflowIncrementalOptions;
  readonly dimensionIds?: readonly string[];
  readonly optionalStage?: boolean | EngineeringWorkflowOptionalStageOptions;
  readonly snapshotDimensionStats?: Readonly<
    Record<string, Partial<EngineeringWorkflowDimensionSnapshot>>
  >;
  readonly snapshotMeta?: {
    readonly sessionId?: string | null;
    readonly candidateCount?: number;
    readonly primaryLang?: string | null;
  };
}

export type EngineeringWorkflowBaselineSelector =
  | "latest"
  | {
      readonly id: string;
    };

export interface EngineeringWorkflowIncrementalOptions {
  readonly enabled?: boolean;
  readonly mode?: "auto" | EngineeringWorkflowIncrementalMode;
  readonly baselineSnapshotId?: string;
  readonly baselineSelector?: EngineeringWorkflowBaselineSelector;
  readonly allDimensions?: readonly string[];
  readonly fullRescanThreshold?: number;
  readonly saveSnapshot?: boolean;
}

export interface EngineeringWorkflowOptionalStageOptions {
  readonly enabled?: boolean;
  readonly guardRuleFacts?: readonly EngineeringWorkflowGuardRuleFact[];
  readonly guardCallbacks?: readonly EngineeringWorkflowGuardRuleCallback[];
  readonly guardFiles?: readonly EngineeringWorkflowGuardFile[];
  readonly recipeFacts?: readonly EngineeringRecipeCoverageFact[];
  readonly dimensionIds?: readonly string[];
  readonly dimensions?: readonly EngineeringWorkflowOptionalDimension[];
  readonly generatedArtifactBlacklist?: readonly string[];
  readonly enhancement?: {
    readonly minConfidence?: number;
    readonly techStackItems?: readonly EngineeringTechStackItem[];
  };
}

export interface EngineeringWorkflowFactBundle {
  readonly files: readonly EngineeringFile[];
  readonly fileContents: Readonly<Record<string, string>>;
  readonly importFacts: readonly EngineeringImportFact[];
  readonly astSummaries?: EngineeringCodeAstSummaryInput;
  readonly generatedArtifactPaths: readonly string[];
}

export interface EngineeringEntityGraphSnapshot {
  readonly entities: readonly EngineeringEntity[];
  readonly edges: readonly EngineeringEntityEdge[];
  readonly topology: {
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly roots: readonly string[];
    readonly leaves: readonly string[];
    readonly isolated: readonly string[];
    readonly components: readonly (readonly string[])[];
    readonly cycles: readonly (readonly string[])[];
  };
}

export interface EngineeringWorkflowArtifact {
  readonly projectRoot: string;
  readonly targets: readonly EngineeringTarget[];
  readonly files: readonly EngineeringFile[];
  readonly dependencyGraph: EngineeringDependencyGraph;
  readonly codeGraph: EngineeringCodeGraphSnapshot;
  readonly callGraph: readonly EngineeringCodeCallGraphEdge[];
  readonly dataFlow: readonly EngineeringCodeDataFlowEdge[];
  readonly entityGraph: EngineeringEntityGraphSnapshot;
  readonly panoramaSnapshot: EngineeringPanoramaSnapshot | null;
  readonly optionalStage: EngineeringWorkflowOptionalStageArtifact;
  readonly dimensionFileRefs: readonly EngineeringWorkflowDimensionFileRef[];
  readonly generatedArtifactBlacklist: readonly string[];
  readonly truncated: boolean;
  readonly incrementalPlan?: EngineeringWorkflowIncrementalPlan | null;
  readonly snapshotId?: string | null;
}

export type EngineeringWorkflowOptionalStageArtifactStatus =
  | "success"
  | "partial"
  | "failed"
  | "disabled"
  | "skipped";

export interface EngineeringWorkflowOptionalStageArtifact {
  readonly status: EngineeringWorkflowOptionalStageArtifactStatus;
  readonly result: EngineeringWorkflowOptionalStageResult | null;
  readonly enhancementSignals: readonly EngineeringWorkflowEnhancementSignal[];
  readonly guardFindings: readonly EngineeringWorkflowGuardFinding[];
  readonly dimensionGates: readonly EngineeringWorkflowDimensionGate[];
  readonly dimensionFileRefs: readonly EngineeringWorkflowDimensionFileRef[];
  readonly diagnostics: readonly EngineeringWorkflowOptionalDiagnostic[];
}

export interface EngineeringWorkflowResult {
  readonly status: "success" | "partial" | "failed";
  readonly artifact: EngineeringWorkflowArtifact;
  readonly phases: readonly EngineeringWorkflowPhaseReport[];
  readonly diagnostics: readonly EngineeringWorkflowDiagnostic[];
  readonly capabilities: EngineeringWorkflowCapabilities;
  readonly truncated: boolean;
  readonly incrementalPlan?: EngineeringWorkflowIncrementalPlan | null;
  readonly snapshot?: EngineeringWorkflowSnapshotRunSummary;
}

export interface EngineeringWorkflowSnapshotRunSummary {
  readonly baselineSnapshotId: string | null;
  readonly snapshotId: string | null;
  readonly saved: boolean;
  readonly prunedIds: readonly string[];
}

export interface EngineeringWorkflowPanoramaAdapter {
  buildSnapshot(input: EngineeringPanoramaServiceInput): EngineeringPanoramaSnapshot;
}

import type {
  EngineeringCodeAstFileSummaryInput,
  EngineeringCodeAstSummaryInput,
} from "../../code/EngineeringCodeGraphModel.js";
import type { EngineeringFile } from "../../foundation/EngineeringCoreTypes.js";
import type { EngineeringImportFact } from "../../panorama/EngineeringModuleDiscoverer.js";
import type {
  EngineeringPanoramaGap,
  EngineeringPanoramaSnapshot,
  EngineeringTechStackItem,
} from "../../panorama/EngineeringPanoramaTypes.js";

export type EngineeringWorkflowOptionalSeverity = "info" | "warning" | "error";

export type EngineeringWorkflowOptionalDiagnosticCode =
  | "optional.guard.empty"
  | "optional.guard.callback-failed"
  | "optional.enhancement.no-match"
  | "optional.dimension.no-snapshot"
  | "optional.stage.disabled"
  | "optional.stage.failed"
  | "optional.stage.skipped";

export interface EngineeringWorkflowOptionalDiagnostic {
  readonly code: EngineeringWorkflowOptionalDiagnosticCode;
  readonly severity: EngineeringWorkflowOptionalSeverity;
  readonly message: string;
  readonly source?: string;
}

export type EngineeringWorkflowEnhancementSignalSource =
  | "tech-stack"
  | "file"
  | "import"
  | "panorama-role"
  | "ast";

export interface EngineeringWorkflowEnhancementSignal {
  readonly packId: string;
  readonly source: EngineeringWorkflowEnhancementSignalSource;
  readonly value: string;
  readonly confidence: number;
  readonly reason: string;
  readonly filePath?: string;
}

export interface EngineeringWorkflowEnhancementPatternCandidate {
  readonly type: string;
  readonly packId: string;
  readonly confidence: number;
  readonly source: EngineeringWorkflowEnhancementSignalSource | "pack";
  readonly evidence: readonly string[];
  readonly filePath?: string;
  readonly line?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface EngineeringWorkflowOptionalDimension {
  readonly id: string;
  readonly label: string;
  readonly guide?: string;
  readonly knowledgeTypes: readonly string[];
  readonly tierHint?: number;
  readonly skillWorthy?: boolean;
  readonly dualOutput?: boolean;
  readonly skillMeta?: {
    readonly name: string;
    readonly description: string;
  };
  readonly conditions?: {
    readonly languages?: readonly string[];
    readonly frameworks?: readonly string[];
  };
  readonly source?: string;
}

export interface EngineeringWorkflowGuardRuleFact {
  readonly ruleId: string;
  readonly category: string;
  readonly dimension: string;
  readonly severity: EngineeringWorkflowOptionalSeverity;
  readonly languages?: readonly string[];
  readonly pattern?: RegExp | string;
  readonly message: string;
  readonly source?: string;
}

export interface EngineeringWorkflowGuardFile {
  readonly path: string;
  readonly relativePath?: string;
  readonly content: string;
  readonly language?: string;
  readonly isTest?: boolean;
}

export interface EngineeringWorkflowGuardFinding {
  readonly ruleId: string;
  readonly severity: EngineeringWorkflowOptionalSeverity;
  readonly message: string;
  readonly filePath: string;
  readonly line?: number;
  readonly category?: string;
  readonly dimension?: string;
  readonly source?: string;
  readonly evidence?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface EngineeringWorkflowGuardRuleContext {
  readonly file: EngineeringWorkflowGuardFile;
  readonly ruleFacts: readonly EngineeringWorkflowGuardRuleFact[];
}

export type EngineeringWorkflowGuardRuleCallback = (
  context: EngineeringWorkflowGuardRuleContext,
) =>
  | EngineeringWorkflowGuardFinding
  | readonly EngineeringWorkflowGuardFinding[]
  | null
  | undefined;

export interface EngineeringWorkflowGuardAuditInput {
  readonly files: readonly EngineeringWorkflowGuardFile[];
  readonly ruleFacts?: readonly EngineeringWorkflowGuardRuleFact[];
  readonly callbacks?: readonly EngineeringWorkflowGuardRuleCallback[];
  readonly generatedArtifactBlacklist?: readonly string[];
}

export interface EngineeringWorkflowGuardAuditResult {
  readonly rules: readonly EngineeringWorkflowGuardRuleFact[];
  readonly findings: readonly EngineeringWorkflowGuardFinding[];
  readonly diagnostics: readonly EngineeringWorkflowOptionalDiagnostic[];
  readonly summary: {
    readonly fileCount: number;
    readonly ruleCount: number;
    readonly callbackCount: number;
    readonly totalFindings: number;
    readonly errors: number;
    readonly warnings: number;
    readonly infos: number;
  };
}

export interface EngineeringWorkflowDimensionGate {
  readonly dimensionId: string;
  readonly active: boolean;
  readonly reason: string;
  readonly priority: "high" | "medium" | "low";
  readonly source: "snapshot" | "gap" | "enhancement" | "input";
}

export interface EngineeringWorkflowDimensionFileRef {
  readonly dimensionId: string;
  readonly filePath: string;
  readonly source: "gap-evidence" | "module-role" | "dimension-module" | "enhancement-signal";
  readonly reason: string;
  readonly confidence: number;
  readonly module?: string;
}

export interface EngineeringWorkflowDimensionGateInput {
  readonly snapshot?: EngineeringPanoramaSnapshot | null;
  readonly dimensions?: readonly EngineeringWorkflowOptionalDimension[];
  readonly gaps?: readonly EngineeringPanoramaGap[];
  readonly files?: readonly EngineeringFile[];
  readonly enhancementSignals?: readonly EngineeringWorkflowEnhancementSignal[];
  readonly generatedArtifactBlacklist?: readonly string[];
}

export interface EngineeringWorkflowDimensionGateResult {
  readonly activeDimensions: readonly EngineeringWorkflowOptionalDimension[];
  readonly gates: readonly EngineeringWorkflowDimensionGate[];
  readonly fileRefs: readonly EngineeringWorkflowDimensionFileRef[];
  readonly diagnostics: readonly EngineeringWorkflowOptionalDiagnostic[];
}

export interface EngineeringWorkflowEnhancementPackInfo {
  readonly id: string;
  readonly displayName: string;
  readonly matched: boolean;
  readonly confidence: number;
  readonly signals: readonly EngineeringWorkflowEnhancementSignal[];
}

export interface EngineeringWorkflowEnhancementPreprocessInput {
  readonly files?: readonly EngineeringFile[];
  readonly fileContents?: Readonly<Record<string, string>>;
  readonly importFacts?: readonly EngineeringImportFact[];
  readonly astSummaries?: EngineeringCodeAstSummaryInput;
  readonly panoramaSnapshot?: EngineeringPanoramaSnapshot | null;
  readonly techStackItems?: readonly EngineeringTechStackItem[];
  readonly minConfidence?: number;
}

export interface EngineeringWorkflowEnhancementPreprocessResult {
  readonly packs: readonly EngineeringWorkflowEnhancementPackInfo[];
  readonly signals: readonly EngineeringWorkflowEnhancementSignal[];
  readonly patterns: readonly EngineeringWorkflowEnhancementPatternCandidate[];
  readonly guardRules: readonly EngineeringWorkflowGuardRuleFact[];
  readonly dimensions: readonly EngineeringWorkflowOptionalDimension[];
  readonly diagnostics: readonly EngineeringWorkflowOptionalDiagnostic[];
}

export interface EngineeringWorkflowOptionalStageInput
  extends EngineeringWorkflowEnhancementPreprocessInput {
  readonly guardFiles?: readonly EngineeringWorkflowGuardFile[];
  readonly guardRuleFacts?: readonly EngineeringWorkflowGuardRuleFact[];
  readonly guardCallbacks?: readonly EngineeringWorkflowGuardRuleCallback[];
  readonly dimensions?: readonly EngineeringWorkflowOptionalDimension[];
  readonly gaps?: readonly EngineeringPanoramaGap[];
  readonly generatedArtifactBlacklist?: readonly string[];
}

export interface EngineeringWorkflowOptionalStageResult {
  readonly enhancement: EngineeringWorkflowEnhancementPreprocessResult;
  readonly guard: EngineeringWorkflowGuardAuditResult;
  readonly enhancementReaudit: EngineeringWorkflowGuardAuditResult | null;
  readonly dimensions: EngineeringWorkflowDimensionGateResult;
  readonly diagnostics: readonly EngineeringWorkflowOptionalDiagnostic[];
}

export interface NormalizedEngineeringAstSummary {
  readonly files: readonly EngineeringCodeAstFileSummaryInput[];
}

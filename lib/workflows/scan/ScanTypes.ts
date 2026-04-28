import type { EvolutionAuditResult } from '#agent/runs/evolution/EvolutionAgentRun.js';
import type { ScanKnowledgeProjection } from '#agent/runs/scan/ScanRunProjection.js';
import type { ProposalExecutionResult } from '#service/evolution/ProposalExecutor.js';
import type { ReconcileReport, RepairReport } from '#service/knowledge/SourceRefReconciler.js';
import type {
  FileChangeEvent,
  FileChangeEventSource,
  ImpactLevel,
  ReactiveEvolutionReport,
} from '#types/reactive-evolution.js';

export type ScanMode = 'cold-start' | 'deep-mining' | 'incremental-correction' | 'maintenance';

export type ScanDepth = 'light' | 'standard' | 'deep' | 'exhaustive';

export type ScanRecommendationStatus = 'pending' | 'queued' | 'dismissed' | 'executed';

export type ScanRecommendationPriority = 'low' | 'medium' | 'high';

export type ScanIntent =
  | 'build-baseline'
  | 'fill-coverage-gap'
  | 'repair-stale-knowledge'
  | 'audit-impacted-recipes'
  | 'maintain-health';

export interface ScanScope {
  dimensions?: string[];
  files?: string[];
  modules?: string[];
  symbols?: string[];
  recipeIds?: string[];
  query?: string;
}

export interface ScanChangeSet {
  added: string[];
  modified: string[];
  deleted: string[];
  renamed?: Array<{ oldPath: string; newPath: string }>;
  source?: FileChangeEventSource | 'manual';
}

export interface ScanBudget {
  maxFiles?: number;
  maxFileChars?: number;
  maxKnowledgeItems?: number;
  maxGraphEdges?: number;
  maxTotalChars?: number;
}

export interface ScanBaselineRef {
  runId: string | null;
  snapshotId: string | null;
  source?: 'request' | 'latest-cold-start' | 'missing';
}

export interface ScanFileEvidenceInput {
  relativePath: string;
  path?: string;
  name?: string;
  language?: string;
  content?: string;
  hash?: string;
}

export interface KnowledgeRetrievalInput {
  projectRoot: string;
  mode: ScanMode;
  intent: ScanIntent;
  baseline?: ScanBaselineRef | null;
  depth?: ScanDepth;
  scope?: ScanScope;
  changeSet?: ScanChangeSet;
  files?: ScanFileEvidenceInput[];
  budget?: ScanBudget;
  primaryLang?: string | null;
  reports?: {
    reactive?: ReactiveEvolutionReport;
  };
}

export interface EvidenceFile {
  relativePath: string;
  language?: string;
  role?: 'changed' | 'neighbor' | 'evidence' | 'entrypoint';
  excerpt?: string;
  content?: string;
  hash?: string;
}

export interface EvidenceKnowledgeContent {
  markdown?: string;
  rationale?: string;
  coreCode?: string;
  [key: string]: unknown;
}

export interface EvidenceKnowledgeItem {
  id: string;
  title: string;
  description?: string;
  trigger?: string;
  lifecycle: string;
  knowledgeType?: string;
  kind?: string;
  category?: string;
  language?: string;
  content?: EvidenceKnowledgeContent;
  sourceRefs?: string[];
  reason?: 'source-ref' | 'search' | 'graph' | 'stale' | 'coverage-gap';
  score?: number;
}

export interface EvidenceImpactDetail {
  recipeId: string;
  file: string;
  level: ImpactLevel;
  matchedTokens: string[];
  score: number;
}

export interface EvidenceGraphEntity {
  id: string;
  name: string;
  kind: string;
  file?: string;
}

export interface EvidenceGraphEdge {
  from: string;
  to: string;
  relation: string;
}

export interface EvidenceGap {
  dimension: string;
  reason: 'low-coverage' | 'new-module' | 'changed-hotspot' | 'decaying-knowledge';
  priority: 'low' | 'medium' | 'high';
}

export interface KnowledgeEvidencePack {
  project: {
    root: string;
    primaryLang: string;
    fileCount: number;
    modules: string[];
  };
  changes?: {
    files: string[];
    impactedDimensions: string[];
    impactedRecipeIds: string[];
    impactDetails: EvidenceImpactDetail[];
  };
  files: EvidenceFile[];
  knowledge: EvidenceKnowledgeItem[];
  graph: {
    entities: EvidenceGraphEntity[];
    edges: EvidenceGraphEdge[];
  };
  gaps: EvidenceGap[];
  diagnostics: {
    truncated: boolean;
    warnings: string[];
    retrievalMs: number;
  };
}

export interface ScanPlan {
  mode: ScanMode;
  depth: ScanDepth;
  reason: string;
  baseline?: ScanBaselineRef | null;
  activeDimensions: string[];
  skippedDimensions: string[];
  scope: ScanScope;
  changeSet?: ScanChangeSet;
  fallback?: 'cold-start' | 'deep-mining' | null;
  budgets: Required<Pick<ScanBudget, 'maxFiles' | 'maxKnowledgeItems' | 'maxTotalChars'>> & {
    maxAgentIterations: number;
  };
  rawIncrementalPlan?: unknown;
}

export interface ScanPlanRequest {
  projectRoot: string;
  intent?: 'bootstrap' | 'change-set' | 'deep-mining' | 'maintenance';
  requestedMode?: ScanMode;
  force?: boolean;
  hasBaseline?: boolean;
  baselineRunId?: string | null;
  baselineSnapshotId?: string | null;
  totalFileCount?: number;
  allDimensionIds?: string[];
  currentFiles?: ScanFileEvidenceInput[];
  dimensions?: string[];
  modules?: string[];
  recipeIds?: string[];
  query?: string;
  changeSet?: ScanChangeSet;
  impactedRecipeIds?: string[];
  budget?: ScanBudget;
  precomputedIncrementalPlan?: unknown;
}

export interface IncrementalCorrectionRunInput {
  projectRoot: string;
  events: FileChangeEvent[];
  reactiveReport?: ReactiveEvolutionReport;
  runDeterministic?: boolean;
  runAgent?: boolean;
  depth?: ScanDepth;
  budget?: ScanBudget;
  primaryLang?: string | null;
}

export interface IncrementalCorrectionResult {
  mode: 'incremental-correction';
  reactiveReport: ReactiveEvolutionReport;
  evidencePack: KnowledgeEvidencePack;
  auditResult: EvolutionAuditResult | null;
  skippedAgentReason?: string;
}

export interface DeepMiningRequest {
  projectRoot: string;
  baseline?: ScanBaselineRef | null;
  baselineRunId?: string | null;
  baselineSnapshotId?: string | null;
  dimensions?: string[];
  modules?: string[];
  query?: string;
  depth?: Extract<ScanDepth, 'deep' | 'exhaustive'>;
  maxNewCandidates?: number;
  files?: ScanFileEvidenceInput[];
  runAgent?: boolean;
  primaryLang?: string | null;
}

export interface DeepMiningResult {
  mode: 'deep-mining';
  baseline: ScanBaselineRef | null;
  evidencePack: KnowledgeEvidencePack;
  scanResult: ScanKnowledgeProjection | null;
  skippedAgentReason?: string;
}

export interface MaintenanceWorkflowOptions {
  projectRoot: string;
  forceSourceRefReconcile?: boolean;
  refreshSearchIndex?: boolean;
  includeDecay?: boolean;
  includeEnhancements?: boolean;
  includeRedundancy?: boolean;
}

export interface ScanRecommendedRun {
  mode: 'incremental-correction' | 'deep-mining';
  reason: string;
  scope: ScanScope;
  priority?: ScanRecommendationPriority;
  depth?: ScanDepth;
  budget?: ScanBudget;
}

export interface MaintenanceWorkflowResult {
  mode: 'maintenance';
  sourceRefs: ReconcileReport;
  repairedRenames: RepairReport;
  proposals: ProposalExecutionResult;
  decaySignals: number;
  enhancementSuggestions: number;
  redundancyFindings: number;
  indexRefreshed: boolean;
  recommendedRuns: ScanRecommendedRun[];
  warnings: string[];
}

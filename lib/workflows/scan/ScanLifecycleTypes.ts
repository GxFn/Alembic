import type { ScanEvidencePackRecord } from '#repo/scan/ScanEvidencePackRepository.js';
import type { ScanRecommendationRecord } from '#repo/scan/ScanRecommendationRepository.js';
import type { ScanRunRecord } from '#repo/scan/ScanRunRepository.js';
import type { FileChangeEvent, ReactiveEvolutionReport } from '#types/reactive-evolution.js';
import type { ScanJobRecord } from '#workflows/scan/ScanJobQueue.js';
import type {
  KnowledgeEvidencePack,
  ScanBudget,
  ScanChangeSet,
  ScanDepth,
  ScanFileEvidenceInput,
  ScanMode,
  ScanPlan,
  ScanPlanRequest,
  ScanScope,
} from '#workflows/scan/ScanTypes.js';

export type ScanLifecycleSource =
  | 'http'
  | 'mcp-internal'
  | 'mcp-external'
  | 'file-changes'
  | 'scheduler'
  | 'cli'
  | 'test';

export interface ScanLifecycleRequest {
  projectRoot: string;
  source: ScanLifecycleSource;
  requestedMode?: ScanMode;
  intent?: ScanPlanRequest['intent'];
  force?: boolean;
  hasBaseline?: boolean;
  baseline?: {
    runId?: string | null;
    snapshotId?: string | null;
  };
  scope?: ScanScope;
  dimensions?: string[];
  modules?: string[];
  query?: string;
  files?: ScanFileEvidenceInput[];
  changeSet?: ScanChangeSet;
  events?: FileChangeEvent[];
  reactiveReport?: ReactiveEvolutionReport;
  impactedRecipeIds?: string[];
  budget?: ScanBudget;
  depth?: ScanDepth;
  primaryLang?: string;
  execution?: {
    async?: boolean;
    runAgent?: boolean;
    runDeterministic?: boolean;
    maxAttempts?: number;
    allowSideEffects?: boolean;
    reason?: string;
    label?: string;
  };
  coldStart?: {
    ctx?: unknown;
    sourceTag?: string;
    phaseOptions?: {
      maxFiles?: number;
      contentMaxLines?: number;
      skipGuard?: boolean;
      clearOldData?: boolean;
      generateReport?: boolean;
      generateAstContext?: boolean;
      incremental?: boolean;
      dataRoot?: string;
      summaryPrefix?: string;
    };
    terminalTest?: boolean;
    terminalToolset?: string;
    allowedTerminalModes?: string[];
    loadSkills?: boolean;
  };
  maintenance?: {
    forceSourceRefReconcile?: boolean;
    refreshSearchIndex?: boolean;
    includeDecay?: boolean;
    includeEnhancements?: boolean;
    includeRedundancy?: boolean;
  };
  metadata?: Record<string, unknown>;
}

export interface ScanLifecycleResult<T = unknown> {
  run: ScanRunRecord | null;
  plan: ScanPlan;
  evidencePack: KnowledgeEvidencePack | null;
  evidencePackRecord: ScanEvidencePackRecord | null;
  result: T;
  summary: Record<string, unknown>;
  recommendations: ScanRecommendationRecord[];
  job?: ScanJobRecord<unknown, unknown>;
}

export interface ScanLifecyclePlanResult {
  request: ScanLifecycleRequest;
  plan: ScanPlan;
}

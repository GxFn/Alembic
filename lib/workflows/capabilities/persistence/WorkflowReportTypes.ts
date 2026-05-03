import type { SessionStore } from '#agent/memory/SessionStore.js';
import type { BootstrapFile, IncrementalPlan } from '#types/workflows.js';
import type {
  WorkflowCompletionSummary,
  WorkflowSemanticMemoryConsolidationResult,
} from '#workflows/capabilities/completion/WorkflowCompletionTypes.js';
import type {
  CandidateResults,
  DimensionStat,
  SkillResults,
} from '#workflows/capabilities/execution/internal-agent/BootstrapConsumers.js';
import type { FileDiffPlanner } from '#workflows/capabilities/project-intelligence/FileDiffPlanner.js';

export type WorkflowReportConsolidationResult = WorkflowSemanticMemoryConsolidationResult;

export interface WorkflowReport {
  version: string;
  timestamp: string;
  project: { name: string; files: number; lang: string };
  duration: { totalMs: number; totalSec: number };
  dimensions: Record<string, Record<string, unknown>>;
  totals: Record<string, unknown>;
  checkpoints: { restored: string[] };
  incremental: Record<string, unknown> | null;
  semanticMemory: Record<string, unknown> | null;
  completion?: WorkflowCompletionSummary | null;
  snapshot?: WorkflowSnapshotSummary | null;
  codeEntityGraph?: Record<string, unknown>;
  [key: string]: unknown;
}

export type WorkflowSnapshotStatus = 'saved' | 'skipped' | 'failed';

export interface WorkflowSnapshotSummary {
  status: WorkflowSnapshotStatus;
  id: string | null;
  reason?: string;
  fileCount?: number;
  dimensionCount?: number;
}

export interface WorkflowResultPersistenceContext {
  container: {
    get(name: string): unknown;
    singletons?: Record<string, unknown>;
  };
}

export interface PersistWorkflowResultOptions {
  ctx: WorkflowResultPersistenceContext;
  dataRoot: string;
  projectRoot: string;
  projectInfo: { name: string; fileCount: number; lang: string };
  sessionId: string;
  allFiles: BootstrapFile[] | null;
  sessionStore: SessionStore;
  dimensionStats: Record<string, DimensionStat>;
  candidateResults: CandidateResults;
  skillResults: SkillResults;
  consolidationResult: WorkflowReportConsolidationResult | null;
  completionSummary?: WorkflowCompletionSummary | null;
  skippedDims: string[];
  incrementalSkippedDims: string[];
  isIncremental?: boolean | null;
  incrementalPlan?: IncrementalPlan | null;
  enableParallel: boolean;
  concurrency: number;
  startedAtMs: number;
  createFileDiffPlanner?: (
    db: unknown,
    projectRoot: string
  ) => Pick<FileDiffPlanner, 'saveSnapshot'>;
}

export interface WorkflowResultPersistenceResult {
  totalTimeMs: number;
  totalTokenUsage: { input: number; output: number };
  totalToolCalls: number;
  report: WorkflowReport | null;
  snapshotId: string | null;
  snapshot: WorkflowSnapshotSummary;
}

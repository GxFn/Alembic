export interface CompletionContainerLike {
  services?: Record<string, unknown>;
  get?(name: string): unknown;
}

export interface CompletionContextLike {
  container: CompletionContainerLike;
}

export interface CompletionFindingLike {
  finding?: string;
  evidence?: string;
  importance?: number;
  dimId?: string;
}

export interface CompletionDimensionReportLike {
  analysisText?: string;
  findings?: CompletionFindingLike[];
}

export interface CompletionTierReflectionLike {
  tierIndex: number;
  completedDimensions?: string[];
  topFindings?: CompletionFindingLike[];
  crossDimensionPatterns?: string[];
}

export interface CompletionSessionStoreLike {
  getCompletedDimensions(): string[];
  getDimensionReport(dimId: string): CompletionDimensionReportLike | undefined;
  toJSON(): { tierReflections?: CompletionTierReflectionLike[] };
}

export interface CompletionSessionLike {
  id: string;
  sessionStore?: unknown;
}

export interface CompletionLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface ServiceContainerLike extends CompletionContainerLike {
  singletons?: Record<string, unknown>;
}

export interface PanoramaServiceLike {
  rescan(): Promise<void>;
  getOverview(): Promise<{ moduleCount: number; gapCount: number }>;
}

export type LoadServiceContainer = () => Promise<ServiceContainerLike> | ServiceContainerLike;
export type ScheduleTask = (task: () => Promise<void>) => void;
export type PersistentMemoryDb =
  | import('#agent/memory/MemoryStore.js').SqliteDatabase
  | { getDb(): import('#agent/memory/MemoryStore.js').SqliteDatabase };

export type ShouldAbortFn = () => boolean;

export interface WorkflowCompletionFinalizerDependencies {
  getServiceContainer?: LoadServiceContainer;
  scheduleTask?: ScheduleTask;
}

export type WorkflowSemanticMemoryMode = 'scheduled' | 'immediate' | 'skip';

export interface WorkflowCompletionStepOptions {
  panorama?: 'run' | 'skip';
}

export interface WorkflowSemanticMemoryConsolidationResult {
  total: { added: number; updated: number; merged: number; skipped: number };
  durationMs: number;
  [key: string]: unknown;
}

export interface WorkflowCompletionFinalizerResult {
  semanticMemoryResult: WorkflowSemanticMemoryConsolidationResult | null;
  panoramaStatus?: WorkflowCompletionStepStatus;
}

export type WorkflowCompletionStepStatus = 'completed' | 'scheduled' | 'skipped';

export interface WorkflowCompletionSummary {
  mode: 'bootstrap' | 'rescan';
  isolation: 'full-completion' | 'pipeline-isolation';
  reason?: string;
  semanticMemory: {
    status: WorkflowCompletionStepStatus;
    result?: WorkflowSemanticMemoryConsolidationResult | null;
  };
}

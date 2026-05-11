import type { SessionStore } from '#agent/memory/SessionStore.js';

export interface WorkflowServiceContainer {
  get(name: string): unknown;
  getServiceNames?(): string[];
  singletons?: Record<string, unknown>;
}

export interface WorkflowMcpContext {
  container: WorkflowServiceContainer;
  startedAt?: number;
  session?: unknown;
  [key: string]: unknown;
}

export type McpContext = WorkflowMcpContext;

export interface WorkflowSkillHooks {
  run(
    event: string,
    payload: Record<string, unknown>,
    context: { projectRoot: string }
  ): Promise<unknown>;
}

export interface WorkflowDatabaseLike {
  filename?: string;
}

export interface BootstrapFile {
  path: string;
  relativePath: string;
  content: string;
}

export interface FileDiffSummary {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: string[];
  changeRatio: number;
}

export interface FileDiffPlan {
  canIncremental: boolean;
  mode: 'incremental' | 'full';
  affectedDimensions: string[];
  skippedDimensions: string[];
  previousSnapshot: ({ id?: string } & Record<string, unknown>) | null;
  diff: FileDiffSummary | null;
  reason: string;
  restoredEpisodic: SessionStore | null;
}

export type IncrementalPlan = FileDiffPlan;

export interface SaveSnapshotParams {
  sessionId: string;
  allFiles: BootstrapFile[];
  dimensionStats: Record<string, Record<string, unknown>>;
  episodicMemory?: {
    toJSON(): unknown;
    getCompletedDimensions(): string[];
    getDimensionReport?(dimId: string): { referencedFiles?: string[] } | null;
  } | null;
  meta?: Record<string, unknown>;
  plan?: FileDiffPlan | null;
}

export interface DimensionCheckpointResult {
  dimId?: string;
  sessionId?: string;
  completedAt?: number;
  digest?: unknown;
  [key: string]: unknown;
}

export interface LoggerLike {
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
  debug?(...args: unknown[]): void;
}

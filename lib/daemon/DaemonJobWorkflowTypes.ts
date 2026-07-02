import type { DaemonJobKind, DaemonJobRecord, DaemonJobSource } from '@alembic/core/daemon';
import type { PlanSelection, PlanSelectionProjection } from '@alembic/core/plans';
import type { ServiceContainer } from '../injection/ServiceContainer.js';
import type { ProjectContextWorkflowFacts } from '../workflows/project-context/ProjectContextWorkflowFacts.js';

export interface LoggerLike {
  error(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface DaemonJobOptions {
  args?: Record<string, unknown>;
  container: ServiceContainer;
  kind: DaemonJobKind;
  logger: LoggerLike;
  source?: DaemonJobSource;
}

export interface RunDaemonJobOptions extends DaemonJobOptions {
  jobId: string;
}

export interface RunDaemonJobResult {
  job: DaemonJobRecord | null;
  result: unknown;
}

export interface ModuleDimensionTarget {
  dimensionId: string;
  moduleId?: string;
  moduleName?: string;
  targetRecipes: number;
}

export interface DaemonRescanWorkflowArgs {
  [key: string]: unknown;
  contentMaxLines?: unknown;
  dimensions?: string[];
  internalExecution?: {
    runAsyncFillInline?: boolean;
  };
  maxFiles?: unknown;
  miningMode?: 'deepMining' | 'moduleMining' | 'per-module';
  moduleDimensionTargets?: ModuleDimensionTarget[];
  moduleScope?: string[];
  perDimensionTargets?: Record<string, number>;
  reason: string;
  roundIndex?: number;
}

export interface GeneratePlanGateResult {
  projectContextFacts: ProjectContextWorkflowFacts;
  projection: PlanSelectionProjection;
  selection: PlanSelection;
}

export interface DeepMiningRoundPlanContext {
  moduleCount: number;
  moduleDimensionTargets: ModuleDimensionTarget[];
  perDimensionTargets: Record<string, number>;
  planK?: number;
  planMaxRounds?: number;
}

export interface ModuleMiningModule {
  [key: string]: unknown;
  dimensionIds?: string[];
  dimensions?: string[];
  moduleId: string;
  moduleName: string;
  modulePath?: string;
  ownedFiles?: string[];
  plannedDimensionTargets?: Record<string, number>;
  plannedDimensions?: string[];
  targetRecipes?: number;
}

export interface ModuleMiningKnowledgeRepositoryLike {
  findAllByLifecycles?(
    lifecycles: readonly string[]
  ): Promise<readonly unknown[]> | readonly unknown[];
  findWithPagination?(
    filters?: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<{ data?: readonly unknown[] }> | { data?: readonly unknown[] };
}

export interface ModuleMiningSourceRefRepositoryLike {
  findAll?(): readonly unknown[];
}

export interface ModuleMiningPersistenceSnapshot {
  recipeIds: Set<string>;
  sourceRefCountByRecipeId: Map<string, number>;
}

export interface ModuleMiningPersistedOutputDelta {
  recipeIds: string[];
  sourceRefCount: number;
}

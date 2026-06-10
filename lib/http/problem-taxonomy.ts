import {
  CORE_FAILURE_TAXONOMY_VERSION,
  type CoreFailureAgentBranch,
  type CoreFailureProblemClass,
  type CoreFailureRefPolicy,
  type CoreFailureRetryPolicy,
  type CoreFailureStatus,
  type CoreFieldClass,
  type CoreFieldFailureKind,
  getCoreFailureTaxonomyEntry,
} from '@alembic/core/shared';

export type AlembicHttpProblemReason = CoreFieldFailureKind;

export interface BuildAlembicHttpProblemOptions {
  readonly artifactRefs?: readonly string[];
  readonly detailRefs?: readonly string[];
  readonly retryable?: boolean;
  readonly status?: number;
}

export interface AlembicHttpProblem {
  readonly agentBranch: CoreFailureAgentBranch;
  readonly artifactRefs?: string[];
  readonly canonicalHttpStatus: number;
  readonly code: string;
  readonly dashboardState: CoreFieldFailureKind;
  readonly detailExposureClass: CoreFieldClass;
  readonly detailRefs?: string[];
  readonly exposureClass: CoreFieldClass;
  readonly failureId: `core.failure.${CoreFieldFailureKind}`;
  readonly failureStatus: CoreFailureStatus;
  readonly mcpErrorCode: `core.failure.${CoreFieldFailureKind}`;
  readonly mcpStatus: CoreFieldFailureKind;
  readonly message: string;
  readonly privateDataSafe: true;
  readonly problemClass: CoreFailureProblemClass;
  readonly reasonCode: CoreFieldFailureKind;
  readonly refPolicy: CoreFailureRefPolicy;
  readonly retryPolicy: CoreFailureRetryPolicy;
  readonly retryable: boolean;
  readonly status: number;
  readonly taxonomyVersion: typeof CORE_FAILURE_TAXONOMY_VERSION;
}

export function buildAlembicHttpProblem(
  code: string,
  message: string,
  reasonCode: AlembicHttpProblemReason,
  options: BuildAlembicHttpProblemOptions = {}
): AlembicHttpProblem {
  const taxonomy = getCoreFailureTaxonomyEntry(reasonCode);
  return {
    agentBranch: taxonomy.agentBranch,
    ...(options.artifactRefs ? { artifactRefs: [...options.artifactRefs] } : {}),
    canonicalHttpStatus: taxonomy.httpStatus,
    code,
    dashboardState: taxonomy.dashboardState,
    detailExposureClass: taxonomy.detailExposureClass,
    ...(options.detailRefs ? { detailRefs: [...options.detailRefs] } : {}),
    exposureClass: taxonomy.exposureClass,
    failureId: taxonomy.stableId,
    failureStatus: taxonomy.status,
    mcpErrorCode: taxonomy.mcpErrorCode,
    mcpStatus: taxonomy.mcpStatus,
    message,
    privateDataSafe: taxonomy.privateDataSafe,
    problemClass: taxonomy.problemClass,
    reasonCode: taxonomy.kind,
    refPolicy: taxonomy.refPolicy,
    retryPolicy: taxonomy.retryPolicy,
    retryable: options.retryable ?? taxonomy.retryable,
    status: options.status ?? taxonomy.httpStatus,
    taxonomyVersion: CORE_FAILURE_TAXONOMY_VERSION,
  };
}

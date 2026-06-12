/**
 * Tool usage-problem objects (Train B MT3, closes the D25 gap for
 * Alembic-owned resident surfaces).
 *
 * Every structured usage error carries the Core failure-taxonomy projection
 * plus the agent-actionable fields the certification harness extracts:
 * reason code, failing step, next action, retry safety, and optional
 * field-level detail. Attached to responses via envelope({ problem }).
 */

import {
  CORE_FAILURE_TAXONOMY_VERSION,
  type CoreFieldFailureKind,
  getCoreFailureTaxonomyEntry,
} from '@alembic/core/shared';

export interface ToolFieldProblem {
  readonly field: string;
  readonly error: string;
}

export interface ToolUsageProblem {
  readonly code: string;
  readonly reasonCode: CoreFieldFailureKind;
  readonly failureId: string;
  readonly problemClass: string;
  readonly failingStep: string;
  readonly nextAction: string;
  readonly retryable: boolean;
  readonly retryPolicy: string;
  readonly taxonomyVersion: typeof CORE_FAILURE_TAXONOMY_VERSION;
  readonly fieldProblems?: readonly ToolFieldProblem[];
}

export interface BuildToolUsageProblemOptions {
  code: string;
  reasonCode: CoreFieldFailureKind;
  failingStep: string;
  nextAction: string;
  retryable?: boolean;
  fieldProblems?: readonly ToolFieldProblem[];
}

export function buildToolUsageProblem(options: BuildToolUsageProblemOptions): ToolUsageProblem {
  const taxonomy = getCoreFailureTaxonomyEntry(options.reasonCode);
  return {
    code: options.code,
    reasonCode: taxonomy.kind,
    failureId: taxonomy.stableId,
    problemClass: taxonomy.problemClass,
    failingStep: options.failingStep,
    nextAction: options.nextAction,
    retryable: options.retryable ?? taxonomy.retryable,
    retryPolicy: taxonomy.retryPolicy,
    taxonomyVersion: CORE_FAILURE_TAXONOMY_VERSION,
    ...(options.fieldProblems && options.fieldProblems.length > 0
      ? { fieldProblems: [...options.fieldProblems] }
      : {}),
  };
}

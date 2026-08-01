type PublicPhase =
  | 'AUTOMATIC_SELECTION_READY'
  | 'SELECTION_AUTO_SELECTED'
  | 'PRIVATE_WORKSPACE_READY'
  | 'STRICT_TEST_COMPLETED_PRIVATE'
  | 'STRICT_TEST_FAILED';

interface PublicSelectionSummaryV1 {
  readonly selectedDimensionId: string;
  readonly selectedCellIds: readonly string[];
  readonly selectedCellSetHash: string;
  readonly automaticSelectionHash: string;
  readonly projectionHash: string;
}

/**
 * HTTP 只公开消费者需要的 authority 摘要。完整 checkpoint、冻结源码和 trust material
 * 始终留在 run-scoped 私有存储，不能依赖 JSON 序列化时“刚好没被读取”。
 */
export interface StrictTestPreflightPublicDtoV1 {
  readonly schemaVersion: 1;
  readonly profile: 'strict-test-dimension';
  readonly demandKey: string;
  readonly runId: string;
  readonly phase: 'AUTOMATIC_SELECTION_READY';
  readonly preflightHash: string;
  readonly previewHash: string;
  readonly canAutoSelect: boolean;
  readonly recommendation: {
    readonly dimensionId: string;
    readonly reasonCode: string;
  };
  readonly fullUniverse: {
    readonly dimensionCount: number;
    readonly cellCount: number;
    readonly eligibleCellCount: number;
    readonly excludedCellCount: number;
    readonly fullCellUniverseHash: string;
  };
}

export interface StrictTestRunStatusPublicDtoV1 {
  readonly schemaVersion: 1;
  readonly profile: 'strict-test-dimension';
  readonly demandKey: string;
  readonly runId: string;
  readonly phase: PublicPhase;
  readonly preflightHash: string;
  readonly automaticSelection: PublicSelectionSummaryV1 | null;
  readonly terminal: {
    readonly terminalState: 'STRICT_TEST_COMPLETED_PRIVATE' | 'STRICT_TEST_FAILED';
    readonly terminalHash: string;
    readonly failedStage: string | null;
    readonly errorCode: string | null;
    readonly productionFinalized: false;
    readonly publicRouteChanged: false;
  } | null;
  readonly reportHash: string | null;
  readonly evidenceRefs: readonly string[];
}

export interface StrictTestReportPublicDtoV1 {
  readonly schemaVersion: 1;
  readonly profile: 'strict-test-dimension';
  readonly demandKey: string;
  readonly runId: string;
  readonly terminalState: 'STRICT_TEST_COMPLETED_PRIVATE' | 'STRICT_TEST_FAILED';
  readonly terminalHash: string;
  readonly reportHash: string;
  readonly preflightHash: string | null;
  readonly automaticSelectionHash: string | null;
  readonly projectionHash: string | null;
  readonly fullUniverse: {
    readonly dimensionCount: number;
    readonly cellCount: number;
    readonly eligibleCellCount: number;
    readonly excludedCellCount: number;
    readonly cellUniverseHash: string;
  } | null;
  readonly executedProjection: {
    readonly dimensionId: string;
    readonly cellCount: number;
    readonly cellSetHash: string;
  } | null;
  readonly unexecutedDimensionIds: readonly string[] | null;
  readonly failure: { readonly failedStage: string; readonly errorCode: string } | null;
  readonly evidenceRefs: readonly string[];
  readonly productionFinalized: false;
  readonly publicRouteChanged: false;
}

export function toStrictTestPreflightPublicDtoV1(value: unknown): StrictTestPreflightPublicDtoV1 {
  const source = record(value);
  const preflight = record(source.preflight ?? value);
  const preview = record(source.preview);
  const cellUniverse = record(preflight.cellUniverse);
  const recommendation = record(preflight.recommendation ?? preview.recommendation);
  const dimensions = array(preflight.dimensionResults ?? preview.dimensions);
  return Object.freeze({
    schemaVersion: 1,
    profile: 'strict-test-dimension',
    demandKey: text(preflight.demandKey ?? source.demandKey),
    runId: text(preflight.runId ?? source.runId),
    phase: 'AUTOMATIC_SELECTION_READY',
    preflightHash: text(preflight.preflightHash),
    previewHash: text(preview.previewHash),
    canAutoSelect: preview.canAutoSelect === true,
    recommendation: Object.freeze({
      dimensionId: text(recommendation.dimensionId),
      reasonCode: text(recommendation.reasonCode),
    }),
    fullUniverse: Object.freeze({
      dimensionCount: dimensions.length,
      cellCount: integer(cellUniverse.universeCount),
      eligibleCellCount: integer(cellUniverse.eligibleCount),
      excludedCellCount: integer(cellUniverse.excludedCount),
      fullCellUniverseHash: text(preflight.fullCellUniverseHash),
    }),
  });
}

export function toStrictTestRunStatusPublicDtoV1(value: unknown): StrictTestRunStatusPublicDtoV1 {
  const source = record(value);
  const preflight = record(source.preflight);
  const automaticSelection = recordOrNull(source.automaticSelection);
  const projection = recordOrNull(source.projection);
  const terminal = recordOrNull(source.terminal);
  const report = recordOrNull(source.report);
  const phase = publicPhase(source.phase);
  return Object.freeze({
    schemaVersion: 1,
    profile: 'strict-test-dimension',
    demandKey: text(source.demandKey ?? preflight.demandKey),
    runId: text(source.runId ?? preflight.runId),
    phase,
    preflightHash: text(preflight.preflightHash ?? source.preflightHash),
    automaticSelection:
      automaticSelection && projection
        ? Object.freeze({
            selectedDimensionId: text(automaticSelection.selectedDimensionId),
            selectedCellIds: strings(
              projection.executionCellIds ?? automaticSelection.selectedEligibleCellIds
            ),
            selectedCellSetHash: text(
              projection.executionCellSetHash ?? automaticSelection.selectedEligibleCellsHash
            ),
            automaticSelectionHash: text(automaticSelection.automaticSelectionHash),
            projectionHash: text(projection.projectionHash),
          })
        : null,
    terminal: terminal
      ? Object.freeze({
          terminalState: terminalState(terminal.terminalState),
          terminalHash: text(terminal.terminalHash),
          failedStage: nullableText(terminal.failedStage),
          errorCode: nullablePublicErrorCode(terminal.errorCode),
          productionFinalized: false,
          publicRouteChanged: false,
        })
      : null,
    reportHash: report ? text(report.reportHash) : null,
    evidenceRefs: safeEvidenceRefs(
      source.privateEvidenceRefs ?? terminal?.privateEvidenceRefs ?? report?.privateArtifactRefs
    ),
  });
}

export function toStrictTestReportPublicDtoV1(value: unknown): StrictTestReportPublicDtoV1 {
  const source = record(value);
  const report = record(source.report ?? value);
  const failure = recordOrNull(report.failure);
  const fullUniverse = recordOrNull(report.fullUniverse);
  const executedProjection = recordOrNull(report.executedProjection);
  return Object.freeze({
    schemaVersion: 1,
    profile: 'strict-test-dimension',
    demandKey: text(report.demandKey ?? source.demandKey),
    runId: text(report.runId ?? source.runId),
    terminalState: terminalState(report.terminalState),
    terminalHash: text(report.terminalHash),
    reportHash: text(report.reportHash),
    preflightHash: nullableText(report.preflightHash),
    automaticSelectionHash: nullableText(report.automaticSelectionHash),
    projectionHash: nullableText(report.projectionHash),
    fullUniverse: fullUniverse
      ? Object.freeze({
          dimensionCount: integer(fullUniverse.dimensionCount),
          cellCount: integer(fullUniverse.cellCount),
          eligibleCellCount: integer(fullUniverse.eligibleCellCount),
          excludedCellCount: integer(fullUniverse.excludedCellCount),
          cellUniverseHash: text(fullUniverse.cellUniverseHash),
        })
      : null,
    executedProjection: executedProjection
      ? Object.freeze({
          dimensionId: text(executedProjection.dimensionId),
          cellCount: integer(executedProjection.cellCount),
          cellSetHash: text(executedProjection.cellSetHash),
        })
      : null,
    unexecutedDimensionIds:
      report.unexecutedDimensionIds === null ? null : strings(report.unexecutedDimensionIds),
    failure: failure
      ? Object.freeze({
          failedStage: text(failure.failedStage),
          errorCode: publicErrorCode(failure.errorCode),
        })
      : null,
    evidenceRefs: safeEvidenceRefs(report.privateArtifactRefs),
    productionFinalized: false,
    publicRouteChanged: false,
  });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('STRICT_TEST_PUBLIC_RESPONSE_INVALID');
  }
  return value as Record<string, unknown>;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value === null || value === undefined ? null : record(value);
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('STRICT_TEST_PUBLIC_RESPONSE_INVALID');
  }
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function nullablePublicErrorCode(value: unknown): string | null {
  return value === null || value === undefined ? null : publicErrorCode(value);
}

function publicErrorCode(value: unknown): string {
  const code = text(value);
  return /^STRICT_TEST_[A-Z0-9_]+$/u.test(code) ? code : 'STRICT_TEST_FAILED';
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('STRICT_TEST_PUBLIC_RESPONSE_INVALID');
  }
  return value;
}

function strings(value: unknown): string[] {
  const rows = array(value);
  if (rows.some((row) => typeof row !== 'string' || !row.trim())) {
    throw new Error('STRICT_TEST_PUBLIC_RESPONSE_INVALID');
  }
  return rows as string[];
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error('STRICT_TEST_PUBLIC_RESPONSE_INVALID');
  }
  return Number(value);
}

function safeEvidenceRefs(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  return strings(value).filter(
    (ref) =>
      ref.startsWith('strict-test:') &&
      !ref.includes('/') &&
      !ref.includes('\\') &&
      !ref.includes('..')
  );
}

function publicPhase(value: unknown): PublicPhase {
  if (
    value === 'AUTOMATIC_SELECTION_READY' ||
    value === 'SELECTION_AUTO_SELECTED' ||
    value === 'PRIVATE_WORKSPACE_READY' ||
    value === 'STRICT_TEST_COMPLETED_PRIVATE' ||
    value === 'STRICT_TEST_FAILED'
  ) {
    return value;
  }
  throw new Error('STRICT_TEST_PUBLIC_RESPONSE_INVALID');
}

function terminalState(value: unknown): 'STRICT_TEST_COMPLETED_PRIVATE' | 'STRICT_TEST_FAILED' {
  if (value === 'STRICT_TEST_COMPLETED_PRIVATE' || value === 'STRICT_TEST_FAILED') {
    return value;
  }
  throw new Error('STRICT_TEST_PUBLIC_RESPONSE_INVALID');
}

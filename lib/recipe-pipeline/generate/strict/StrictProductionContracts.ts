import path from 'node:path';

export interface StrictProductionRequestV1 {
  readonly schemaVersion: 1;
  readonly authorizationReceiptHash: string;
  readonly authorizationReceiptPath: string;
  readonly runId: string;
  readonly resumeOwnerId?: string;
  readonly setupAuthority?: StrictSetupAuthorityRequestV1;
}

export interface StrictSetupAuthorityRequestV1 {
  readonly schemaVersion: 1;
  readonly action: 'execute' | 'recover' | 'complete';
  readonly scenario: 'pristine' | 'rebuild';
  readonly snapshotRootRef: string;
  readonly operationLockRootRef: string;
  readonly evidenceRootRef: string;
  readonly plannedAbsentPathReceiptHash: string;
  readonly preResetObservationRef: string;
  readonly restorePolicyRef: string;
  readonly pathPlanHash: string;
}

export interface StrictProductionRuntimeRequestV1 extends StrictProductionRequestV1 {
  readonly ownerId: string;
}

export function parseStrictProductionRequest(value: unknown): StrictProductionRequestV1 | null {
  if (value === undefined || value === null || value === false) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error('STRICT_PRODUCTION_REQUEST_INVALID');
  }
  const receiptPath = readText(value.authorizationReceiptPath);
  const receiptHash = readText(value.authorizationReceiptHash);
  const runId = readIdentity(value.runId);
  const resumeOwnerId =
    value.resumeOwnerId === undefined ? undefined : readIdentity(value.resumeOwnerId);
  const setupAuthority =
    value.setupAuthority === undefined ? undefined : parseSetupAuthority(value.setupAuthority);
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'authorizationReceiptHash',
      'authorizationReceiptPath',
      'runId',
      'resumeOwnerId',
      'setupAuthority',
    ]) ||
    value.schemaVersion !== 1 ||
    !receiptPath ||
    path.isAbsolute(receiptPath) ||
    receiptPath.split(/[\\/]/u).some((segment) => segment === '..' || segment === '') ||
    !/^sha256:[a-f0-9]{64}$/u.test(receiptHash ?? '') ||
    !runId ||
    (value.resumeOwnerId !== undefined && !resumeOwnerId)
  ) {
    throw new Error('STRICT_PRODUCTION_REQUEST_INVALID');
  }
  if (!receiptHash) {
    throw new Error('STRICT_PRODUCTION_REQUEST_INVALID');
  }
  return Object.freeze({
    schemaVersion: 1,
    authorizationReceiptHash: receiptHash,
    authorizationReceiptPath: receiptPath,
    runId,
    ...(resumeOwnerId ? { resumeOwnerId } : {}),
    ...(setupAuthority ? { setupAuthority } : {}),
  });
}

function parseSetupAuthority(value: unknown): StrictSetupAuthorityRequestV1 {
  if (!isRecord(value)) {
    throw new Error('STRICT_PRODUCTION_REQUEST_INVALID');
  }
  const exactKeys = [
    'schemaVersion',
    'action',
    'scenario',
    'snapshotRootRef',
    'operationLockRootRef',
    'evidenceRootRef',
    'plannedAbsentPathReceiptHash',
    'preResetObservationRef',
    'restorePolicyRef',
    'pathPlanHash',
  ];
  const action = value.action;
  const scenario = value.scenario;
  const snapshotRootRef = readSymbol(value.snapshotRootRef);
  const operationLockRootRef = readSymbol(value.operationLockRootRef);
  const evidenceRootRef = readSymbol(value.evidenceRootRef);
  const preResetObservationRef = readSymbol(value.preResetObservationRef);
  const restorePolicyRef = readSymbol(value.restorePolicyRef);
  if (
    !hasExactKeys(value, exactKeys) ||
    value.schemaVersion !== 1 ||
    (action !== 'execute' && action !== 'recover' && action !== 'complete') ||
    (scenario !== 'pristine' && scenario !== 'rebuild') ||
    !snapshotRootRef ||
    !operationLockRootRef ||
    !evidenceRootRef ||
    !preResetObservationRef ||
    !restorePolicyRef ||
    !isSha(value.plannedAbsentPathReceiptHash) ||
    !isSha(value.pathPlanHash) ||
    (scenario === 'pristine' &&
      (snapshotRootRef !== 'NOT_APPLICABLE_PHYSICAL_ABSENCE' ||
        preResetObservationRef !== 'NOT_APPLICABLE_PHYSICAL_ABSENCE')) ||
    (scenario === 'rebuild' &&
      (snapshotRootRef === 'NOT_APPLICABLE_PHYSICAL_ABSENCE' ||
        preResetObservationRef === 'NOT_APPLICABLE_PHYSICAL_ABSENCE'))
  ) {
    throw new Error('STRICT_PRODUCTION_REQUEST_INVALID');
  }
  return Object.freeze({
    schemaVersion: 1,
    action,
    scenario,
    snapshotRootRef,
    operationLockRootRef,
    evidenceRootRef,
    plannedAbsentPathReceiptHash: value.plannedAbsentPathReceiptHash,
    preResetObservationRef,
    restorePolicyRef,
    pathPlanHash: value.pathPlanHash,
  });
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() === value && value.length > 0 ? value : null;
}

function readIdentity(value: unknown): string | null {
  const text = readText(value);
  return text && /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,255}$/u.test(text) ? text : null;
}

function readSymbol(value: unknown): string | null {
  const text = readText(value);
  return text && /^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,511}$/u.test(text) ? text : null;
}

function isSha(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

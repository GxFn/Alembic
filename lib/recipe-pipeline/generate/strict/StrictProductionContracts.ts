import path from 'node:path';

export interface StrictProductionRequestV1 {
  readonly schemaVersion: 1;
  readonly authorizationReceiptHash: string;
  readonly authorizationReceiptPath: string;
  readonly runId: string;
  readonly resumeOwnerId?: string;
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
  if (
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
  });
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() === value && value.length > 0 ? value : null;
}

function readIdentity(value: unknown): string | null {
  const text = readText(value);
  return text && /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,255}$/u.test(text) ? text : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

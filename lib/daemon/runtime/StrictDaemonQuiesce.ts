import { createHash, timingSafeEqual } from 'node:crypto';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';

export interface StrictQuiesceBindingV1 {
  readonly runId: string;
  readonly setupAuthorityHash: string;
  readonly journalHeaderHash: string;
  readonly externalLeaseHash: string;
  readonly projectRootHash: string;
  readonly dataRootHash: string;
  readonly daemonIdentityHash: string;
}

export interface StrictQuiesceRequestV1 extends StrictQuiesceBindingV1 {
  readonly schemaVersion: 1;
  readonly kind: 'StrictQuiesceRequestV1';
  readonly requestHash: string;
}

export interface StrictQuiesceAcceptedAckV1 extends StrictQuiesceBindingV1 {
  readonly schemaVersion: 1;
  readonly kind: 'StrictQuiesceAcceptedAckV1';
  readonly requestHash: string;
  readonly ackHash: string;
}

export type StrictQuiesceAcceptResult =
  | { readonly status: 202; readonly ack: StrictQuiesceAcceptedAckV1 }
  | { readonly status: 400 | 401 | 409; readonly code: string };

export function createStrictQuiesceRequest(
  binding: StrictQuiesceBindingV1
): StrictQuiesceRequestV1 {
  assertBinding(binding);
  const semantic = {
    schemaVersion: 1 as const,
    kind: 'StrictQuiesceRequestV1' as const,
    ...binding,
  };
  return Object.freeze({ ...semantic, requestHash: hashCanonicalJson(semantic) });
}

export class StrictDaemonQuiesceController {
  readonly #daemonToken: string;
  readonly #dataRootHash: string;
  readonly #daemonIdentityHash: string;
  readonly #projectRootHash: string;
  readonly #triggerShutdown: (ack: StrictQuiesceAcceptedAckV1) => void;
  #accepted: { request: StrictQuiesceRequestV1; ack: StrictQuiesceAcceptedAckV1 } | null = null;

  constructor(options: {
    readonly daemonToken: string;
    readonly dataRootHash: string;
    readonly daemonIdentityHash: string;
    readonly projectRootHash: string;
    readonly triggerShutdown: (ack: StrictQuiesceAcceptedAckV1) => void;
  }) {
    if (!options.daemonToken) {
      throw new Error('STRICT_QUIESCE_DAEMON_TOKEN_REQUIRED');
    }
    assertSha(options.dataRootHash);
    assertSha(options.daemonIdentityHash);
    assertSha(options.projectRootHash);
    this.#daemonToken = options.daemonToken;
    this.#dataRootHash = options.dataRootHash;
    this.#daemonIdentityHash = options.daemonIdentityHash;
    this.#projectRootHash = options.projectRootHash;
    this.#triggerShutdown = options.triggerShutdown;
  }

  accept(value: unknown, providedToken: string | undefined): StrictQuiesceAcceptResult {
    if (!providedToken || !sameSecret(this.#daemonToken, providedToken)) {
      return { status: 401, code: 'STRICT_QUIESCE_TOKEN_INVALID' };
    }
    let request: StrictQuiesceRequestV1;
    try {
      request = readStrictQuiesceRequest(value);
    } catch {
      return { status: 400, code: 'STRICT_QUIESCE_REQUEST_INVALID' };
    }
    if (
      request.projectRootHash !== this.#projectRootHash ||
      request.dataRootHash !== this.#dataRootHash ||
      request.daemonIdentityHash !== this.#daemonIdentityHash
    ) {
      return { status: 409, code: 'STRICT_QUIESCE_ROOT_IDENTITY_CONFLICT' };
    }
    if (this.#accepted) {
      if (this.#accepted.request.requestHash !== request.requestHash) {
        return { status: 409, code: 'STRICT_QUIESCE_REQUEST_CONFLICT' };
      }
      return { status: 202, ack: this.#accepted.ack };
    }
    const semantic = {
      schemaVersion: 1 as const,
      kind: 'StrictQuiesceAcceptedAckV1' as const,
      runId: request.runId,
      setupAuthorityHash: request.setupAuthorityHash,
      journalHeaderHash: request.journalHeaderHash,
      externalLeaseHash: request.externalLeaseHash,
      projectRootHash: request.projectRootHash,
      dataRootHash: request.dataRootHash,
      daemonIdentityHash: request.daemonIdentityHash,
      requestHash: request.requestHash,
    };
    const ack = Object.freeze({ ...semantic, ackHash: hashCanonicalJson(semantic) });
    this.#accepted = { request, ack };
    this.#triggerShutdown(ack);
    return { status: 202, ack };
  }
}

export function readStrictQuiesceAcceptedAck(value: unknown): StrictQuiesceAcceptedAckV1 {
  if (!isRecord(value)) {
    throw new Error('STRICT_QUIESCE_ACK_INVALID');
  }
  const { ackHash, ...semantic } = value;
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'runId',
      'setupAuthorityHash',
      'journalHeaderHash',
      'externalLeaseHash',
      'projectRootHash',
      'dataRootHash',
      'daemonIdentityHash',
      'requestHash',
      'ackHash',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'StrictQuiesceAcceptedAckV1' ||
    !isBinding(value) ||
    !isSha(value.requestHash) ||
    !isSha(ackHash) ||
    ackHash !== hashCanonicalJson(semantic)
  ) {
    throw new Error('STRICT_QUIESCE_ACK_INVALID');
  }
  return Object.freeze(value as unknown as StrictQuiesceAcceptedAckV1);
}

function readStrictQuiesceRequest(value: unknown): StrictQuiesceRequestV1 {
  if (!isRecord(value)) {
    throw new Error('STRICT_QUIESCE_REQUEST_INVALID');
  }
  const { requestHash, ...semantic } = value;
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'runId',
      'setupAuthorityHash',
      'journalHeaderHash',
      'externalLeaseHash',
      'projectRootHash',
      'dataRootHash',
      'daemonIdentityHash',
      'requestHash',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'StrictQuiesceRequestV1' ||
    !isBinding(value) ||
    !isSha(requestHash) ||
    requestHash !== hashCanonicalJson(semantic)
  ) {
    throw new Error('STRICT_QUIESCE_REQUEST_INVALID');
  }
  return Object.freeze(value as unknown as StrictQuiesceRequestV1);
}

function assertBinding(value: StrictQuiesceBindingV1): void {
  if (!isBinding(value)) {
    throw new Error('STRICT_QUIESCE_BINDING_INVALID');
  }
}

function isBinding(value: Record<string, unknown> | StrictQuiesceBindingV1): boolean {
  return (
    typeof value.runId === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,255}$/u.test(value.runId) &&
    isSha(value.setupAuthorityHash) &&
    isSha(value.journalHeaderHash) &&
    isSha(value.externalLeaseHash) &&
    isSha(value.projectRootHash) &&
    isSha(value.dataRootHash) &&
    isSha(value.daemonIdentityHash)
  );
}

function assertSha(value: string): void {
  if (!isSha(value)) {
    throw new Error('STRICT_QUIESCE_BINDING_INVALID');
  }
}

function isSha(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function sameSecret(expected: string, actual: string): boolean {
  const expectedDigest = createHash('sha256').update(expected).digest();
  const actualDigest = createHash('sha256').update(actual).digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

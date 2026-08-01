import {
  assertSemanticDispositionReviewDurableAttestationV5,
  assertSemanticDispositionReviewTrustPolicyV3,
  consumeMainSemanticDispositionReviewDurableAttestationV5,
  type FactQueryExecutionReceiptV1,
  type KnowledgeDispositionReviewV1,
  type SemanticDispositionReviewDurableAttestationV5,
  type SemanticDispositionReviewEvidenceV1,
  type SemanticDispositionReviewRequestV1,
  type SemanticDispositionReviewTrustPolicyV3,
} from '@alembic/core/production';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import type { StrictSemanticReviewSessionV1 } from '../../../service/semantic-review/StrictSemanticReviewRuntimeFactory.js';

export type StrictSemanticReviewRecordStateV1 = 'intent' | 'attested' | 'consumed';

export interface StrictSemanticReviewCheckpointRecordV1 {
  readonly schemaVersion: 1;
  readonly state: StrictSemanticReviewRecordStateV1;
  readonly request: SemanticDispositionReviewRequestV1;
  readonly requestHash: string;
  readonly attestation: SemanticDispositionReviewDurableAttestationV5 | null;
  readonly attestationHash: string | null;
  readonly executionHash: string | null;
  readonly review: KnowledgeDispositionReviewV1 | null;
  readonly reviewReceiptHash: string | null;
  readonly recordHash: string;
}

export interface StrictSemanticReviewCheckpointV1 {
  readonly schemaVersion: 1;
  readonly policy: SemanticDispositionReviewTrustPolicyV3;
  readonly policyHash: string;
  readonly enrollmentHash: string;
  readonly records: readonly StrictSemanticReviewCheckpointRecordV1[];
  readonly manifestHash: string;
}

export interface StrictSemanticReviewCheckpointPortV1 {
  read(): StrictSemanticReviewCheckpointV1 | undefined;
  persist(checkpoint: StrictSemanticReviewCheckpointV1): Promise<void>;
}

/**
 * Main 的唯一 durable semantic-disposition 执行入口。
 *
 * Agent V5 mint factory 与 key/provider/Ledger/witness 都被封在 DI session 内。这里仅提交
 * Core semantic request；返回后强制 JSON round-trip，再用独立 checkpoint policy 走
 * Core assert/consume。terminal row、私库、G3/G4/CAS 只能消费本函数返回的 review。
 */
export async function executeStrictDispositionReviewV5(input: {
  readonly checkpoint: StrictSemanticReviewCheckpointPortV1;
  readonly semanticRequest: SemanticDispositionReviewRequestV1;
  readonly session: StrictSemanticReviewSessionV1;
  readonly abortSignal?: AbortSignal;
}): Promise<{
  readonly dispositionReview: KnowledgeDispositionReviewV1;
  readonly attestation: SemanticDispositionReviewDurableAttestationV5;
  readonly replayed: boolean;
}> {
  let checkpoint = ensureCheckpoint(input.checkpoint.read(), input.session);
  const existing = checkpoint.records.find(
    (record) => record.requestHash === input.semanticRequest.requestHash
  );
  if (existing) {
    return recoverExistingRecord(existing, checkpoint, input);
  }

  const intent = createRecord({
    state: 'intent',
    request: input.semanticRequest,
    attestation: null,
    review: null,
  });
  checkpoint = replaceRecord(checkpoint, intent);
  await input.checkpoint.persist(checkpoint);

  let minted: SemanticDispositionReviewDurableAttestationV5;
  try {
    minted = await input.session.execute({
      semanticRequest: input.semanticRequest,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
  } catch (err: unknown) {
    // 可观察的 provider/permission/validation/cancel/timeout 失败没有产生可恢复 attestation。
    // 清掉 intent，恢复调用前 checkpoint 语义；进程在 provider 返回与本 catch 之间崩溃时
    // intent 会留下，fresh process 将按 ambiguous 分支 fail closed，绝不自动重放。
    await input.checkpoint.persist(removeRecord(checkpoint, intent.requestHash));
    throw err;
  }

  const serialized = JSON.parse(
    JSON.stringify(minted)
  ) as SemanticDispositionReviewDurableAttestationV5;
  assertSerializedAttestation(serialized, input.semanticRequest, checkpoint.policy);
  const attested = createRecord({
    state: 'attested',
    request: input.semanticRequest,
    attestation: serialized,
    review: null,
  });
  checkpoint = replaceRecord(checkpoint, attested);
  await input.checkpoint.persist(checkpoint);

  const dispositionReview = consumeAttestation(
    serialized,
    input.semanticRequest,
    checkpoint.policy
  );
  const consumed = createRecord({
    state: 'consumed',
    request: input.semanticRequest,
    attestation: serialized,
    review: dispositionReview,
  });
  checkpoint = replaceRecord(checkpoint, consumed);
  await input.checkpoint.persist(checkpoint);
  return Object.freeze({ dispositionReview, attestation: serialized, replayed: false });
}

export function verifyStrictSemanticReviewCheckpointV1(
  checkpoint: StrictSemanticReviewCheckpointV1
): readonly KnowledgeDispositionReviewV1[] {
  assertCheckpoint(checkpoint);
  const reviews: KnowledgeDispositionReviewV1[] = [];
  for (const record of checkpoint.records) {
    assertRecord(record);
    if (record.state !== 'consumed' || !record.attestation || !record.review) {
      throw new Error('STRICT_SEMANTIC_REVIEW_CHECKPOINT_INCOMPLETE');
    }
    const consumed = consumeAttestation(record.attestation, record.request, checkpoint.policy);
    if (
      consumed.receiptHash !== record.reviewReceiptHash ||
      hashCanonicalJson(consumed) !== hashCanonicalJson(record.review)
    ) {
      throw new Error('STRICT_SEMANTIC_REVIEW_CHECKPOINT_CONSUMPTION_MISMATCH');
    }
    reviews.push(consumed);
  }
  return Object.freeze(reviews);
}

export function createStrictSemanticReviewEvidenceV1(input: {
  readonly evidenceEntryIds: readonly string[];
  readonly executionReceipts: readonly FactQueryExecutionReceiptV1[];
  readonly session: StrictSemanticReviewSessionV1;
  readonly sourceRevisionVectorHash: string;
  readonly semanticRole: string;
}): Omit<SemanticDispositionReviewEvidenceV1, 'evidenceHash'>[] {
  const requestedIds = [...new Set(input.evidenceEntryIds)].sort();
  if (requestedIds.length === 0) {
    throw new Error('STRICT_SEMANTIC_REVIEW_EVIDENCE_REQUIRED');
  }
  return requestedIds.map((evidenceEntryId) => {
    const entry = input.session.factEvidence.entries.find(
      (candidate) => candidate.id === evidenceEntryId
    );
    if (!entry?.file) {
      throw new Error(`STRICT_SEMANTIC_REVIEW_EVIDENCE_ENTRY_MISSING:${evidenceEntryId}`);
    }
    const bindings = input.executionReceipts.flatMap((receipt) => {
      const executions = receipt.fileExecutions.filter(
        (execution) =>
          execution.evidenceEntryId === evidenceEntryId &&
          execution.relativePath === entry.file &&
          execution.status === 'complete' &&
          execution.truncated === false &&
          execution.continuation === null
      );
      if (executions.length > 1) {
        throw new Error(
          `STRICT_SEMANTIC_REVIEW_EVIDENCE_RECEIPT_UNION_MISMATCH:${evidenceEntryId}:${receipt.obligationId}`
        );
      }
      const execution = executions[0];
      if (!execution) {
        return [];
      }
      return [{ receipt, execution }];
    });
    if (bindings.length === 0) {
      throw new Error(`STRICT_SEMANTIC_REVIEW_EVIDENCE_RECEIPT_UNION_MISSING:${evidenceEntryId}`);
    }
    const canonicalSubjectRefs = new Set(
      bindings.map(({ receipt }) => receipt.canonicalSubjectRef)
    );
    const blobHashes = new Set(bindings.map(({ execution }) => execution.blobHash));
    if (canonicalSubjectRefs.size !== 1 || blobHashes.size !== 1) {
      throw new Error(`STRICT_SEMANTIC_REVIEW_PHYSICAL_ROOT_MIXED:${evidenceEntryId}`);
    }
    const canonicalSubjectRef = [...canonicalSubjectRefs][0];
    const blobHash = [...blobHashes][0];
    if (!canonicalSubjectRef || !blobHash) {
      throw new Error(`STRICT_SEMANTIC_REVIEW_PHYSICAL_ROOT_MISSING:${evidenceEntryId}`);
    }
    return {
      evidenceEntryId: entry.id,
      evidenceSessionId: entry.sessionId,
      sourceRevisionVectorHash: input.sourceRevisionVectorHash,
      canonicalSubjectRef,
      relativePath: entry.file,
      blobHash,
      content: entry.content,
      contentHash: entry.contentHash,
      semanticRole: input.semanticRole,
    };
  });
}

async function recoverExistingRecord(
  record: StrictSemanticReviewCheckpointRecordV1,
  checkpoint: StrictSemanticReviewCheckpointV1,
  input: {
    readonly checkpoint: StrictSemanticReviewCheckpointPortV1;
    readonly semanticRequest: SemanticDispositionReviewRequestV1;
    readonly session: StrictSemanticReviewSessionV1;
  }
): Promise<{
  readonly dispositionReview: KnowledgeDispositionReviewV1;
  readonly attestation: SemanticDispositionReviewDurableAttestationV5;
  readonly replayed: boolean;
}> {
  assertRecord(record);
  if (hashCanonicalJson(record.request) !== hashCanonicalJson(input.semanticRequest)) {
    throw new Error('STRICT_SEMANTIC_REVIEW_REQUEST_REBOUND');
  }
  if (record.state === 'intent') {
    throw new Error('STRICT_SEMANTIC_REVIEW_EXECUTION_AMBIGUOUS');
  }
  if (!record.attestation) {
    throw new Error('STRICT_SEMANTIC_REVIEW_ATTESTATION_MISSING');
  }
  const attestation = record.attestation;
  const dispositionReview = consumeAttestation(
    attestation,
    input.semanticRequest,
    checkpoint.policy
  );
  if (record.state === 'consumed') {
    if (
      !record.review ||
      record.reviewReceiptHash !== dispositionReview.receiptHash ||
      hashCanonicalJson(record.review) !== hashCanonicalJson(dispositionReview)
    ) {
      throw new Error('STRICT_SEMANTIC_REVIEW_CHECKPOINT_CONSUMPTION_MISMATCH');
    }
    return Object.freeze({
      dispositionReview,
      attestation,
      replayed: true,
    });
  }
  const consumed = createRecord({
    state: 'consumed',
    request: input.semanticRequest,
    attestation,
    review: dispositionReview,
  });
  await input.checkpoint.persist(replaceRecord(checkpoint, consumed));
  return Object.freeze({
    dispositionReview,
    attestation,
    replayed: true,
  });
}

function ensureCheckpoint(
  checkpoint: StrictSemanticReviewCheckpointV1 | undefined,
  session: StrictSemanticReviewSessionV1
): StrictSemanticReviewCheckpointV1 {
  if (checkpoint) {
    assertCheckpoint(checkpoint);
    if (
      checkpoint.policyHash !== session.policy.policyHash ||
      checkpoint.enrollmentHash !== session.enrollmentHash ||
      hashCanonicalJson(checkpoint.policy) !== hashCanonicalJson(session.policy)
    ) {
      throw new Error('STRICT_SEMANTIC_REVIEW_CHECKPOINT_POLICY_REBOUND');
    }
    return checkpoint;
  }
  return createCheckpoint(session.policy, session.enrollmentHash, []);
}

function createCheckpoint(
  policy: SemanticDispositionReviewTrustPolicyV3,
  enrollmentHash: string,
  records: readonly StrictSemanticReviewCheckpointRecordV1[]
): StrictSemanticReviewCheckpointV1 {
  const semantic = {
    schemaVersion: 1 as const,
    policy: structuredClone(policy),
    policyHash: policy.policyHash,
    enrollmentHash,
    records: [...records].sort((left, right) => left.requestHash.localeCompare(right.requestHash)),
  };
  return Object.freeze({ ...semantic, manifestHash: hashCanonicalJson(semantic) });
}

function replaceRecord(
  checkpoint: StrictSemanticReviewCheckpointV1,
  record: StrictSemanticReviewCheckpointRecordV1
): StrictSemanticReviewCheckpointV1 {
  return createCheckpoint(checkpoint.policy, checkpoint.enrollmentHash, [
    ...checkpoint.records.filter((candidate) => candidate.requestHash !== record.requestHash),
    record,
  ]);
}

function removeRecord(
  checkpoint: StrictSemanticReviewCheckpointV1,
  requestHash: string
): StrictSemanticReviewCheckpointV1 {
  return createCheckpoint(
    checkpoint.policy,
    checkpoint.enrollmentHash,
    checkpoint.records.filter((candidate) => candidate.requestHash !== requestHash)
  );
}

function createRecord(input: {
  readonly state: StrictSemanticReviewRecordStateV1;
  readonly request: SemanticDispositionReviewRequestV1;
  readonly attestation: SemanticDispositionReviewDurableAttestationV5 | null;
  readonly review: KnowledgeDispositionReviewV1 | null;
}): StrictSemanticReviewCheckpointRecordV1 {
  const semantic = {
    schemaVersion: 1 as const,
    state: input.state,
    request: structuredClone(input.request),
    requestHash: input.request.requestHash,
    attestation: input.attestation ? structuredClone(input.attestation) : null,
    attestationHash: input.attestation?.attestationHash ?? null,
    executionHash: input.attestation?.execution.executionHash ?? null,
    review: input.review ? structuredClone(input.review) : null,
    reviewReceiptHash: input.review?.receiptHash ?? null,
  };
  return Object.freeze({ ...semantic, recordHash: hashCanonicalJson(semantic) });
}

function assertCheckpoint(checkpoint: StrictSemanticReviewCheckpointV1): void {
  assertSemanticDispositionReviewTrustPolicyV3(checkpoint.policy);
  const { manifestHash, ...semantic } = checkpoint;
  if (
    checkpoint.schemaVersion !== 1 ||
    checkpoint.policyHash !== checkpoint.policy.policyHash ||
    manifestHash !== hashCanonicalJson(semantic) ||
    new Set(checkpoint.records.map((record) => record.requestHash)).size !==
      checkpoint.records.length
  ) {
    throw new Error('STRICT_SEMANTIC_REVIEW_CHECKPOINT_INVALID');
  }
}

function assertRecord(record: StrictSemanticReviewCheckpointRecordV1): void {
  const { recordHash, ...semantic } = record;
  if (
    record.schemaVersion !== 1 ||
    !['intent', 'attested', 'consumed'].includes(record.state) ||
    record.requestHash !== record.request.requestHash ||
    recordHash !== hashCanonicalJson(semantic) ||
    !isCheckpointRecordPayloadValid(record)
  ) {
    throw new Error('STRICT_SEMANTIC_REVIEW_CHECKPOINT_RECORD_INVALID');
  }
}

function isCheckpointRecordPayloadValid(record: StrictSemanticReviewCheckpointRecordV1): boolean {
  if (record.state === 'intent') {
    return (
      record.attestation === null &&
      record.attestationHash === null &&
      record.executionHash === null &&
      record.review === null &&
      record.reviewReceiptHash === null
    );
  }
  if (
    !record.attestation ||
    record.attestation.schemaVersion !== 5 ||
    record.attestationHash !== record.attestation.attestationHash ||
    record.executionHash !== record.attestation.execution.executionHash
  ) {
    return false;
  }
  if (record.state === 'attested') {
    return record.review === null && record.reviewReceiptHash === null;
  }
  return Boolean(record.review && record.reviewReceiptHash === record.review.receiptHash);
}

function assertSerializedAttestation(
  attestation: SemanticDispositionReviewDurableAttestationV5,
  request: SemanticDispositionReviewRequestV1,
  policy: SemanticDispositionReviewTrustPolicyV3
): void {
  if (attestation.schemaVersion !== 5) {
    throw new Error('STRICT_SEMANTIC_REVIEW_V5_REQUIRED');
  }
  assertSemanticDispositionReviewDurableAttestationV5({
    attestation,
    expectedTrustPolicy: policy,
  });
  if (
    attestation.execution.request.semanticRequest.requestHash !== request.requestHash ||
    hashCanonicalJson(attestation.execution.request.semanticRequest) !== hashCanonicalJson(request)
  ) {
    throw new Error('STRICT_SEMANTIC_REVIEW_ATTESTATION_REQUEST_REBOUND');
  }
}

function consumeAttestation(
  attestation: SemanticDispositionReviewDurableAttestationV5,
  request: SemanticDispositionReviewRequestV1,
  policy: SemanticDispositionReviewTrustPolicyV3
): KnowledgeDispositionReviewV1 {
  assertSerializedAttestation(attestation, request, policy);
  const review = consumeMainSemanticDispositionReviewDurableAttestationV5({
    attestation,
    expectedSemanticRequest: request,
    expectedTrustPolicy: policy,
  });
  if (review.verdict !== 'pass') {
    throw new Error(`STRICT_SEMANTIC_REVIEW_REJECTED:${review.reviewKind}:${review.reasonCode}`);
  }
  return review;
}

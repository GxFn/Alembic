import type { ReviewerIdentityV1 } from '@alembic/agent/evaluation';
import type { AgentService } from '@alembic/agent/service';
import {
  createKnowledgeDispositionReviewV1,
  createProductionActorIdentityV1,
  type FactQueryExecutionReceiptV1,
  type FinalExpandedMiningScheduleReceiptV1,
  type KnowledgeDispositionReviewV1,
  type ProductionActorIdentityV1,
} from '@alembic/core/production';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';

type StrictExecutedReviewKind = Extract<
  KnowledgeDispositionReviewV1['reviewKind'],
  'producer-non-draft' | 'investigated-empty'
>;

interface StrictDispositionReviewOutputV1 {
  readonly schemaVersion: 1;
  readonly reviewKind: StrictExecutedReviewKind;
  readonly currentAnalysisFixpointHash: string;
  readonly populationHash: string;
  readonly proposedDispositionHash: string;
  readonly finalExpandedScheduleHash: string;
  readonly verdict: KnowledgeDispositionReviewV1['verdict'];
  readonly reasonCode: string;
  readonly evidenceEntryIds: readonly string[];
}

export interface StrictDispositionReviewExecutionRecordV1 {
  readonly schemaVersion: 1;
  readonly reviewKind: StrictExecutedReviewKind;
  readonly agentRunId: string;
  readonly invocationId: string;
  readonly promptHash: string;
  readonly responseOutputHash: string;
  readonly proposedDispositionHash: string;
  readonly evidenceEntryIds: readonly string[];
}

export interface ExecuteStrictDispositionReviewInputV1 {
  readonly agentService: Pick<AgentService, 'run'>;
  readonly reviewKind: StrictExecutedReviewKind;
  readonly currentAnalysisFixpointHash: string;
  readonly populationHash: string;
  readonly proposedDispositionHash: string;
  readonly executionReceipts: readonly FactQueryExecutionReceiptV1[];
  readonly finalExpandedSchedule: FinalExpandedMiningScheduleReceiptV1;
  readonly terminalObligations: KnowledgeDispositionReviewV1['executionScope']['terminalObligations'];
  readonly producer: ProductionActorIdentityV1;
  readonly reviewer: {
    readonly calibrationReceiptHash: string;
    readonly identity: ReviewerIdentityV1;
    readonly loadReceiptHash: string;
  };
  readonly evidenceEntryIds: readonly string[];
  readonly subject: Readonly<Record<string, unknown>>;
  readonly usedInvocationIds?: Set<string>;
  readonly usedResponseOutputHashes?: Set<string>;
}

export interface ExecuteStrictDispositionReviewResultV1 {
  readonly dispositionReview: KnowledgeDispositionReviewV1;
  readonly executionRecord: StrictDispositionReviewExecutionRecordV1;
}

/**
 * Main 只负责把既有生产语义交给独立 reviewer，并把真实 host 调用封装为 Core receipt。
 * reviewer verdict、reason 和 evidence 必须来自 AgentService reply；Main 不提供 pass fallback。
 */
export async function executeStrictDispositionReviewV1(
  input: ExecuteStrictDispositionReviewInputV1
): Promise<ExecuteStrictDispositionReviewResultV1> {
  const evidenceEntryIds = normalizeEvidenceEntryIds(input.evidenceEntryIds);
  const prompt = buildStrictDispositionReviewPrompt(input, evidenceEntryIds);
  const promptHash = hashCanonicalJson(prompt);
  const result = await input.agentService.run({
    profile: { id: 'plan-selection' },
    message: {
      role: 'internal',
      content: prompt,
      metadata: {
        task: 'strict-knowledge-disposition-review',
        reviewKind: input.reviewKind,
        strictRunId: input.producer.runId,
      },
    },
    context: { source: 'system-workflow', runtimeSource: 'system' },
    execution: { toolChoiceOverride: 'none' },
    presentation: { responseShape: 'system-task-result' },
  });
  if (result.status !== 'success' || !result.reply.trim()) {
    throw new Error(`STRICT_DISPOSITION_REVIEW_RUN_FAILED:${input.reviewKind}:${result.status}`);
  }
  if (result.toolCalls.length > 0) {
    throw new Error(`STRICT_DISPOSITION_REVIEW_TOOL_FORBIDDEN:${input.reviewKind}`);
  }
  const output = parseStrictDispositionReviewOutput(result.reply);
  assertStrictDispositionReviewOutput(input, output, evidenceEntryIds);
  const responseOutputHash = hashCanonicalJson(result.reply);
  const invocationId = [
    'strict-disposition-review',
    input.reviewKind,
    result.runId,
    promptHash.slice(7, 23),
    responseOutputHash.slice(7, 23),
  ].join(':');
  assertFreshReviewIdentity(input, invocationId, responseOutputHash);
  const dispositionReview = createKnowledgeDispositionReviewV1({
    reviewKind: input.reviewKind,
    currentAnalysisFixpointHash: input.currentAnalysisFixpointHash,
    populationHash: input.populationHash,
    proposedDispositionHash: input.proposedDispositionHash,
    executionReceipts: input.executionReceipts,
    finalExpandedSchedule: input.finalExpandedSchedule,
    terminalObligations: input.terminalObligations,
    producer: input.producer,
    reviewer: createProductionActorIdentityV1({
      providerId: input.reviewer.identity.provider,
      modelId: input.reviewer.identity.model,
      modelVersion: input.reviewer.identity.method,
      promptHash,
      runId: input.producer.runId,
      invocationId,
      loadReceiptHash: input.reviewer.loadReceiptHash,
      outputHash: responseOutputHash,
    }),
    calibrationReceiptHash: input.reviewer.calibrationReceiptHash,
    verdict: output.verdict,
    reasonCode: output.reasonCode,
  });
  if (dispositionReview.verdict !== 'pass') {
    throw new Error(
      `STRICT_DISPOSITION_REVIEW_REJECTED:${input.reviewKind}:${dispositionReview.reasonCode}`
    );
  }
  return Object.freeze({
    dispositionReview,
    executionRecord: Object.freeze({
      schemaVersion: 1,
      reviewKind: input.reviewKind,
      agentRunId: result.runId,
      invocationId,
      promptHash,
      responseOutputHash,
      proposedDispositionHash: input.proposedDispositionHash,
      evidenceEntryIds,
    }),
  });
}

function buildStrictDispositionReviewPrompt(
  input: ExecuteStrictDispositionReviewInputV1,
  evidenceEntryIds: readonly string[]
): string {
  const reviewContext = {
    schemaVersion: 1,
    reviewKind: input.reviewKind,
    currentAnalysisFixpointHash: input.currentAnalysisFixpointHash,
    populationHash: input.populationHash,
    proposedDispositionHash: input.proposedDispositionHash,
    finalExpandedScheduleHash: input.finalExpandedSchedule.finalExpandedScheduleHash,
    executionBindings: [...input.executionReceipts]
      .sort((left, right) => left.obligationId.localeCompare(right.obligationId))
      .map((receipt) => ({
        obligationId: receipt.obligationId,
        executionReceiptHash: receipt.receiptHash,
        executionOutputHash: receipt.outputHash,
        denominatorHash: receipt.denominatorHash,
        disposition: receipt.disposition,
        terminalReceiptId: receipt.terminalReceiptId,
      })),
    evidenceEntryIds,
    subject: input.subject,
  };
  return [
    'You are the independent strict knowledge-disposition reviewer.',
    'Review only the immutable context below. Do not call tools and fail closed on uncertainty.',
    'Return exactly one JSON object with these fields:',
    'schemaVersion=1, reviewKind, currentAnalysisFixpointHash, populationHash, proposedDispositionHash, finalExpandedScheduleHash, verdict(pass|revise|reject), reasonCode, evidenceEntryIds.',
    'Echo every authority hash exactly and return the complete supplied evidenceEntryIds array.',
    '',
    JSON.stringify(reviewContext, null, 2),
  ].join('\n');
}

function parseStrictDispositionReviewOutput(reply: string): StrictDispositionReviewOutputV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.trim());
  } catch (err: unknown) {
    throw new Error(
      `STRICT_DISPOSITION_REVIEW_OUTPUT_INVALID:${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!isRecord(parsed)) {
    throw new Error('STRICT_DISPOSITION_REVIEW_OUTPUT_INVALID:object-required');
  }
  const expectedKeys = [
    'currentAnalysisFixpointHash',
    'evidenceEntryIds',
    'finalExpandedScheduleHash',
    'populationHash',
    'proposedDispositionHash',
    'reasonCode',
    'reviewKind',
    'schemaVersion',
    'verdict',
  ];
  if (
    JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(expectedKeys) ||
    parsed.schemaVersion !== 1 ||
    !['producer-non-draft', 'investigated-empty'].includes(String(parsed.reviewKind)) ||
    !['pass', 'revise', 'reject'].includes(String(parsed.verdict)) ||
    typeof parsed.reasonCode !== 'string' ||
    !parsed.reasonCode.trim() ||
    !Array.isArray(parsed.evidenceEntryIds) ||
    parsed.evidenceEntryIds.some((value) => typeof value !== 'string')
  ) {
    throw new Error('STRICT_DISPOSITION_REVIEW_OUTPUT_INVALID:shape');
  }
  return parsed as unknown as StrictDispositionReviewOutputV1;
}

function assertStrictDispositionReviewOutput(
  input: ExecuteStrictDispositionReviewInputV1,
  output: StrictDispositionReviewOutputV1,
  evidenceEntryIds: readonly string[]
): void {
  for (const [field, expected, actual] of [
    ['reviewKind', input.reviewKind, output.reviewKind],
    [
      'currentAnalysisFixpointHash',
      input.currentAnalysisFixpointHash,
      output.currentAnalysisFixpointHash,
    ],
    ['populationHash', input.populationHash, output.populationHash],
    ['proposedDispositionHash', input.proposedDispositionHash, output.proposedDispositionHash],
    [
      'finalExpandedScheduleHash',
      input.finalExpandedSchedule.finalExpandedScheduleHash,
      output.finalExpandedScheduleHash,
    ],
  ] as const) {
    if (actual !== expected) {
      throw new Error(`STRICT_DISPOSITION_REVIEW_OUTPUT_REBOUND:${field}`);
    }
  }
  if (
    JSON.stringify(normalizeEvidenceEntryIds(output.evidenceEntryIds)) !==
    JSON.stringify(evidenceEntryIds)
  ) {
    throw new Error('STRICT_DISPOSITION_REVIEW_OUTPUT_REBOUND:evidenceEntryIds');
  }
}

function assertFreshReviewIdentity(
  input: ExecuteStrictDispositionReviewInputV1,
  invocationId: string,
  responseOutputHash: string
): void {
  if (input.usedInvocationIds?.has(invocationId)) {
    throw new Error(`STRICT_DISPOSITION_REVIEW_INVOCATION_REUSED:${input.reviewKind}`);
  }
  if (input.usedResponseOutputHashes?.has(responseOutputHash)) {
    throw new Error(`STRICT_DISPOSITION_REVIEW_OUTPUT_REUSED:${input.reviewKind}`);
  }
  input.usedInvocationIds?.add(invocationId);
  input.usedResponseOutputHashes?.add(responseOutputHash);
}

function normalizeEvidenceEntryIds(values: readonly string[]): string[] {
  const normalized = [...values]
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();
  if (normalized.length === 0 || new Set(normalized).size !== normalized.length) {
    throw new Error('STRICT_DISPOSITION_REVIEW_EVIDENCE_INVALID');
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

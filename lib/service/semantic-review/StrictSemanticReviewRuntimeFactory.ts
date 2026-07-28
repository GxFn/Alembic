import { randomUUID } from 'node:crypto';
import type { AiProvider } from '@alembic/agent/ai';
import {
  createDurableSemanticReviewRuntime,
  createProductionEvidenceLedgerAuthority,
  type ProductionEvidenceLedgerAuthorityV1,
  type SemanticReviewWitnessAuthorityPortV1,
} from '@alembic/agent/production';
import {
  createStrictFactDirectWitnessBindingV1,
  createStrictFactWitnessAuthorityV1,
  type StrictEvidenceLedgerSnapshotV1,
  type StrictFactDirectWitnessBindingV1,
} from '@alembic/core/host-agent-workflows';
import type { EvidenceEntry } from '@alembic/core/knowledge';
import type {
  SemanticDispositionReviewAxisIdV1,
  SemanticDispositionReviewCalibrationV1,
  SemanticDispositionReviewDurableAttestationV5,
  SemanticDispositionReviewerModelLoadReceiptV1,
  SemanticDispositionReviewRequestV1,
  SemanticDispositionReviewTrustPolicyV3,
} from '@alembic/core/production';
import type { ProjectContextRef } from '@alembic/core/project-context';
import {
  type CertifiedProjectFactsArtifactV1,
  createProjectContextFileRef,
  hashBytes,
  hashCanonicalJson,
} from '@alembic/core/project-context-foundation';
import {
  type SemanticReviewTrustPreparationV1,
  SemanticReviewTrustStore,
} from '../../infrastructure/config/SemanticReviewTrustStore.js';
import type {
  MainCertifiedProjectionPayload,
  MainCertifiedSourceFile,
} from '../../project-facts/CertifiedProjectFactsRuntime.js';

const SEMANTIC_REVIEW_DIMENSION = 'strict-production-semantic-review';
const COMMON_AXES = [
  'frozen-semantic-evidence-grounding',
  'fixpoint-population-execution-lineage',
  'reviewer-independence',
  'verdict-sufficiency',
] as const satisfies readonly SemanticDispositionReviewAxisIdV1[];
const AXES_BY_REVIEW_KIND = {
  'producer-non-draft': [
    ...COMMON_AXES,
    'admission-comparison-completeness',
    'target-disposition-consistency',
    'hypothesis-falsification-context',
  ],
  'investigated-empty': [
    ...COMMON_AXES,
    'sealed-schedule-terminal-denominator',
    'negative-evidence-sufficiency',
    'empty-population-consistency',
  ],
} as const satisfies Readonly<
  Record<
    SemanticDispositionReviewRequestV1['reviewKind'],
    readonly SemanticDispositionReviewAxisIdV1[]
  >
>;

export interface MainStrictFactEvidenceAuthorityV1 {
  readonly entries: readonly EvidenceEntry[];
  readonly snapshot: StrictEvidenceLedgerSnapshotV1;
  readonly witnessAuthority: ReturnType<typeof createStrictFactWitnessAuthorityV1>;
  readonly witnessBindings: readonly StrictFactDirectWitnessBindingV1[];
}

export interface StrictSemanticReviewSessionMetricsV1 {
  readonly ledgerLoadCount: number;
  readonly witnessResolveCount: number;
  readonly providerInvocationCount: number;
}

export interface StrictSemanticReviewSessionV1 {
  readonly enrollmentHash: string;
  readonly factEvidence: MainStrictFactEvidenceAuthorityV1;
  readonly modelLoadReceipt: SemanticDispositionReviewerModelLoadReceiptV1;
  readonly policy: SemanticDispositionReviewTrustPolicyV3;
  calibration(
    reviewKind: SemanticDispositionReviewRequestV1['reviewKind']
  ): Omit<SemanticDispositionReviewCalibrationV1, 'calibrationHash'>;
  execute(input: {
    readonly semanticRequest: SemanticDispositionReviewRequestV1;
    readonly abortSignal?: AbortSignal;
  }): Promise<SemanticDispositionReviewDurableAttestationV5>;
  metrics(): StrictSemanticReviewSessionMetricsV1;
}

export interface OpenStrictSemanticReviewSessionInputV1 {
  readonly artifact: CertifiedProjectFactsArtifactV1;
  readonly credentialLocationSymbol: string;
  readonly expectedPolicyHash?: string;
  readonly modelVersion: string;
  readonly projection: MainCertifiedProjectionPayload;
  readonly projectRoot: string;
  readonly reviewer: {
    readonly calibrationReceiptHash: string;
    readonly identity: {
      readonly provider: string;
      readonly model: string;
      readonly method: string;
    };
  };
  readonly runId: string;
  readonly runtimeConfigHash: string;
  readonly sourceRevisionVectorHash: string;
}

/**
 * DI composition factory。provider 与 stable custody 在宿主启动层绑定；per-run 调用方只能
 * 提供已经由 authorization/runtime receipt 验过的语义坐标，不能注入 key、policy、
 * Ledger、witness、gateway、provider 或预制 attestation。
 */
export class StrictSemanticReviewRuntimeFactory {
  readonly #dataRoot: string;
  readonly #provider: Pick<AiProvider, 'name' | 'model' | 'chatWithTools'>;
  readonly #trustStore: SemanticReviewTrustStore;

  constructor(input: {
    readonly dataRoot: string;
    readonly provider: Pick<AiProvider, 'name' | 'model' | 'chatWithTools'>;
    readonly trustStore?: SemanticReviewTrustStore;
  }) {
    if (
      !input.provider ||
      typeof input.provider.name !== 'string' ||
      typeof input.provider.model !== 'string' ||
      typeof input.provider.chatWithTools !== 'function'
    ) {
      throw new Error('STRICT_SEMANTIC_REVIEW_PROVIDER_UNAVAILABLE');
    }
    this.#dataRoot = input.dataRoot;
    this.#provider = Object.freeze({
      name: input.provider.name,
      model: input.provider.model,
      chatWithTools: input.provider.chatWithTools.bind(input.provider),
    });
    this.#trustStore =
      input.trustStore ?? new SemanticReviewTrustStore({ dataRoot: input.dataRoot });
  }

  async openSession(
    input: OpenStrictSemanticReviewSessionInputV1
  ): Promise<StrictSemanticReviewSessionV1> {
    assertOpenInput(input, this.#provider);
    const ledger = createProductionEvidenceLedgerAuthority({
      dataRoot: this.#dataRoot,
      jobId: input.runId,
      sessionId: input.runId,
      dimensionId: SEMANTIC_REVIEW_DIMENSION,
    });
    const factEvidence = openFactEvidenceAuthority({
      artifact: input.artifact,
      ledger,
      projection: input.projection,
      projectRoot: input.projectRoot,
      sourceRevisionVectorHash: input.sourceRevisionVectorHash,
    });
    const modelLoadReceipt = createModelLoadReceipt(input, this.#provider);
    const trust = await this.#trustStore.openCustody({
      evidenceStoreId: ledger.identity.storeId,
      evidenceStoreConfigHash: ledger.identity.storeConfigHash,
      reviewerModelLoadReceipt: modelLoadReceipt,
      ...(input.expectedPolicyHash ? { expectedPolicyHash: input.expectedPolicyHash } : {}),
    });
    const counters = {
      ledgerLoadCount: 0,
      witnessResolveCount: 0,
      providerInvocationCount: 0,
    };
    const witnessAuthority = createReviewWitnessAuthority(factEvidence, counters);
    const runtime = await createDurableSemanticReviewRuntime({
      signingKey: {
        trustRootId: trust.policy.trustRootId,
        keyId: trust.policy.keyId,
        loadPrivateKey: async () => trust.privateKey,
      },
      reviewer: {
        provider: {
          ...this.#provider,
          chatWithTools: async (...args) => {
            counters.providerInvocationCount += 1;
            return this.#provider.chatWithTools(...args);
          },
        },
        modelLoadReceipt,
        evaluatorRunId: `main-semantic-review:${input.runId}`,
        createInvocationId: () => `semantic-review:${input.runId}:${randomUUID()}`,
      },
      evidence: {
        // Agent 通过 private WeakMap 验证这个 facet 的真实性，不能用结构相同的 wrapper。
        ledger: ledger.read,
        witnessAuthority,
      },
      timeoutMs: 120_000,
    });
    assertRuntimePolicyMatchesEnrollment(runtime.trustPolicy, trust);
    const session: StrictSemanticReviewSessionV1 = {
      enrollmentHash: trust.enrollmentHash,
      factEvidence,
      modelLoadReceipt,
      policy: structuredClone(trust.policy),
      calibration: (reviewKind: SemanticDispositionReviewRequestV1['reviewKind']) =>
        createCalibration(input.reviewer.calibrationReceiptHash, modelLoadReceipt, reviewKind),
      execute: async (executeInput: {
        readonly semanticRequest: SemanticDispositionReviewRequestV1;
        readonly abortSignal?: AbortSignal;
      }) => runtime.execute(executeInput),
      metrics: () => Object.freeze({ ...counters }),
    };
    return Object.freeze(session);
  }

  /**
   * finalized/fresh-process replay 只重读公开 policy registry，不加载私钥、Ledger 或
   * provider。这样旧 checkpoint 不能把自带 policy 当成独立批准来源。
   */
  async verifyApprovedPolicy(input: {
    readonly policy: SemanticDispositionReviewTrustPolicyV3;
    readonly enrollmentHash: string;
  }): Promise<void> {
    const approved = await this.#trustStore.readApprovedPolicy({
      policyHash: input.policy.policyHash,
      enrollmentHash: input.enrollmentHash,
    });
    if (hashCanonicalJson(approved) !== hashCanonicalJson(input.policy)) {
      throw new Error('STRICT_SEMANTIC_REVIEW_POLICY_REGISTRY_MISMATCH');
    }
  }
}

function openFactEvidenceAuthority(input: {
  readonly artifact: CertifiedProjectFactsArtifactV1;
  readonly ledger: ProductionEvidenceLedgerAuthorityV1;
  readonly projection: MainCertifiedProjectionPayload;
  readonly projectRoot: string;
  readonly sourceRevisionVectorHash: string;
}): MainStrictFactEvidenceAuthorityV1 {
  if (input.ledger.read.get('E-1') === null) {
    for (const [index, file] of input.projection.files.entries()) {
      input.ledger.capture.capture({
        tool: 'code.read',
        callId: `strict-frozen-file-${index + 1}`,
        file: file.relativePath,
        content: decodeFile(file),
      });
    }
  }
  const snapshot = input.ledger.read.strictSnapshot();
  assertExactLedgerProjection(snapshot.entries, input.projection.files, input.ledger);
  const projectContextRefs = input.projection.files.map((file) =>
    resolveProjectContextFileRef(input.projection, file, input.projectRoot)
  );
  const witnessAuthority = createStrictFactWitnessAuthorityV1({
    artifact: input.artifact,
    evidenceLedgerSnapshot: snapshot,
    projectContextRefs,
  });
  const witnessBindings = input.projection.files.map((file, index) => {
    const evidenceEntry = snapshot.entries[index];
    const projectContextRef = projectContextRefs[index];
    if (!evidenceEntry || !projectContextRef) {
      throw new Error(`STRICT_SEMANTIC_REVIEW_WITNESS_INPUT_MISSING:${file.relativePath}`);
    }
    return createStrictFactDirectWitnessBindingV1({
      artifact: input.artifact,
      repoId: file.repoId,
      relativePath: file.relativePath,
      evidenceEntry,
      evidenceLedgerSnapshot: snapshot,
      projectContextRef,
    });
  });
  if (
    witnessBindings.some(
      (binding) => binding.sourceRevisionVectorHash !== input.sourceRevisionVectorHash
    )
  ) {
    throw new Error('STRICT_SEMANTIC_REVIEW_SOURCE_REVISION_MISMATCH');
  }
  return Object.freeze({
    entries: snapshot.entries,
    snapshot,
    witnessAuthority,
    witnessBindings,
  });
}

function assertExactLedgerProjection(
  entries: readonly EvidenceEntry[],
  files: readonly MainCertifiedSourceFile[],
  ledger: ProductionEvidenceLedgerAuthorityV1
): void {
  if (entries.length !== files.length) {
    throw new Error('STRICT_SEMANTIC_REVIEW_LEDGER_PROJECTION_COUNT_MISMATCH');
  }
  for (const [index, file] of files.entries()) {
    const entry = entries[index];
    if (
      !entry ||
      entry.id !== `E-${index + 1}` ||
      entry.sessionId !== ledger.identity.sessionId ||
      entry.dimensionId !== ledger.identity.dimensionId ||
      entry.tool !== 'code.read' ||
      entry.callId !== `strict-frozen-file-${index + 1}` ||
      entry.file !== file.relativePath ||
      entry.content !== decodeFile(file) ||
      entry.contentHash !== hashBytes(Buffer.from(decodeFile(file)))
    ) {
      throw new Error(`STRICT_SEMANTIC_REVIEW_LEDGER_PROJECTION_MISMATCH:${file.relativePath}`);
    }
  }
}

function createReviewWitnessAuthority(
  factEvidence: MainStrictFactEvidenceAuthorityV1,
  counters: { ledgerLoadCount: number; witnessResolveCount: number }
): SemanticReviewWitnessAuthorityPortV1 {
  const authority: SemanticReviewWitnessAuthorityPortV1 = {
    async resolve(lookup) {
      counters.ledgerLoadCount += 1;
      counters.witnessResolveCount += 1;
      const matches = factEvidence.witnessBindings.filter(
        (binding) =>
          binding.evidenceEntryId === lookup.evidenceEntryId &&
          binding.evidenceSessionId === lookup.evidenceSessionId &&
          binding.bindingHash === lookup.witnessBindingHash &&
          binding.projectContextRefId === lookup.projectContextRefId &&
          binding.sourceRevisionVectorHash === lookup.sourceRevisionVectorHash &&
          binding.relativePath === lookup.relativePath &&
          binding.blobHash === lookup.blobHash
      );
      if (matches.length !== 1) {
        return null;
      }
      const witnessBinding = matches[0];
      if (!witnessBinding) {
        return null;
      }
      return Object.freeze({
        evidenceLedgerSnapshot: factEvidence.snapshot,
        witnessBinding,
      });
    },
  };
  return Object.freeze(authority);
}

function createModelLoadReceipt(
  input: OpenStrictSemanticReviewSessionInputV1,
  provider: Pick<AiProvider, 'name' | 'model'>
): SemanticDispositionReviewerModelLoadReceiptV1 {
  const semantic = {
    schemaVersion: 1 as const,
    providerId: provider.name,
    modelId: provider.model,
    modelVersion: input.modelVersion,
    methodId: 'semantic-disposition-review',
    methodVersion: input.reviewer.identity.method,
    runtimeConfigHash: input.runtimeConfigHash,
    credentialLocationSymbol: input.credentialLocationSymbol,
  };
  return Object.freeze({ ...semantic, loadReceiptHash: hashCanonicalJson(semantic) });
}

function createCalibration(
  calibrationReceiptHash: string,
  modelLoadReceipt: SemanticDispositionReviewerModelLoadReceiptV1,
  reviewKind: SemanticDispositionReviewRequestV1['reviewKind']
): Omit<SemanticDispositionReviewCalibrationV1, 'calibrationHash'> {
  return Object.freeze({
    providerId: modelLoadReceipt.providerId,
    modelId: modelLoadReceipt.modelId,
    modelVersion: modelLoadReceipt.modelVersion,
    methodId: modelLoadReceipt.methodId,
    methodVersion: modelLoadReceipt.methodVersion,
    reviewerModelLoadReceipt: modelLoadReceipt,
    calibrationReceiptHash,
    rubricVersion: 'semantic-disposition-rubric-v1',
    axes: [...AXES_BY_REVIEW_KIND[reviewKind]].sort().map((axisId) => ({
      axisId,
      minimumScore: 0.8,
      calibrationEvidenceHash: hashCanonicalJson({
        calibrationReceiptHash,
        axisId,
        rubricVersion: 'semantic-disposition-rubric-v1',
      }),
    })),
  });
}

function resolveProjectContextFileRef(
  projection: MainCertifiedProjectionPayload,
  file: MainCertifiedSourceFile,
  projectRoot: string
): ProjectContextRef {
  const exact = projection.envelopes
    .flatMap((envelope) => envelope.refs)
    .find(
      (ref) =>
        ref.kind === 'file' &&
        ref.scope.repoId === file.repoId &&
        ref.scope.filePath === file.relativePath &&
        ref.metadata?.hash === file.blobHash
    );
  if (exact) {
    return exact;
  }
  // Certified projection 并不保证每个物理文件都已经被 ProjectContext 图遍历到。
  // 缺口只能通过 Core 公共构造器从受信 projectRoot/repoId/blobHash 重建；
  // 后续 strict witness authority 会再次按 artifact 证明校验，不能由调用方自造 ref。
  return createProjectContextFileRef({
    projectRoot,
    repoId: file.repoId,
    filePath: file.relativePath,
    hash: file.blobHash,
  });
}

function decodeFile(file: MainCertifiedSourceFile): string {
  return Buffer.from(file.contentBase64, 'base64').toString('utf8');
}

function assertRuntimePolicyMatchesEnrollment(
  runtimePolicy: SemanticDispositionReviewTrustPolicyV3,
  trust: SemanticReviewTrustPreparationV1
): void {
  if (
    runtimePolicy.policyHash !== trust.policy.policyHash ||
    hashCanonicalJson(runtimePolicy) !== hashCanonicalJson(trust.policy)
  ) {
    throw new Error('STRICT_SEMANTIC_REVIEW_RUNTIME_POLICY_MISMATCH');
  }
}

function assertOpenInput(
  input: OpenStrictSemanticReviewSessionInputV1,
  provider: Pick<AiProvider, 'name' | 'model'>
): void {
  if (
    input.reviewer.identity.provider !== provider.name ||
    input.reviewer.identity.model !== provider.model ||
    !input.runId.trim() ||
    !input.projectRoot.startsWith('/') ||
    !input.credentialLocationSymbol.trim() ||
    !input.modelVersion.trim() ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.runtimeConfigHash) ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.sourceRevisionVectorHash)
  ) {
    throw new Error('STRICT_SEMANTIC_REVIEW_SESSION_BINDING_INVALID');
  }
}

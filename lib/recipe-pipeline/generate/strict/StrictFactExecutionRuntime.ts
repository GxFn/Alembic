import { createHash } from 'node:crypto';
import {
  assertCodeFactGenerationManifestV1,
  createAstFactQueryBackendV1,
  createAstFactQueryFamilyV1,
  createConfigFactQueryBackendV1,
  createConfigFactQueryFamilyV1,
  createProjectContextFactQueryBackendV1,
  createProjectContextFactQueryFamilyV1,
  createStrictAstFactQueryPackV1,
  createStrictEvidenceLedgerSnapshotV1,
  createStrictFactBackendRegistryV1,
  createStrictFactDirectWitnessBindingV1,
  createStrictFactSubjectBindingV1,
  createStrictFactWitnessAuthorityV1,
  executeStrictFactScheduleV1,
  type StrictConfigParserIdV1,
  type StrictFactQueryBackendV1,
} from '@alembic/core/host-agent-workflows';
import type {
  CertifiedPlanningFactsV1,
  FactHarvestObligationV1,
  FactQueryFamilyV1,
  MiningWorkScheduleV1,
} from '@alembic/core/plans';
import type { ProjectContextRef } from '@alembic/core/project-context';
import {
  type CertifiedProjectFactsArtifactV1,
  hashCanonicalJson,
} from '@alembic/core/project-context-foundation';
import type {
  MainCertifiedProjectionPayload,
  MainCertifiedSourceFile,
} from '../../../project-facts/CertifiedProjectFactsRuntime.js';

type MainStrictBackendSpec =
  | {
      readonly kind: 'ast';
      readonly id: string;
      readonly supportedScales: FactQueryFamilyV1['supportedScales'];
    }
  | {
      readonly kind: 'project-context';
      readonly id: string;
      readonly supportedScales: FactQueryFamilyV1['supportedScales'];
    }
  | {
      readonly kind: 'config';
      readonly id: string;
      readonly parser: StrictConfigParserIdV1;
      readonly supportedScales: FactQueryFamilyV1['supportedScales'];
    };

export interface MainStrictAnalysisExpansionRowV1 {
  readonly obligationId: string;
  readonly purpose: 'exploration' | 'counterexample';
  readonly factFamilyId: string;
  readonly capabilityId: string;
  readonly canonicalSubjectRef: string;
  readonly analysisScale:
    | 'source-range'
    | 'symbol'
    | 'file'
    | 'module'
    | 'package'
    | 'repository'
    | 'project';
  readonly reasonCode: string;
}

/**
 * Main 只声明 Core 当前真正能够加载并自证 fixture 的 backend。family id 仍对应
 * 规划语义；queryPackHash/loadReceiptHash 等执行权限完全由 Core factory 生成。
 */
const MAIN_STRICT_BACKEND_SPECS: readonly MainStrictBackendSpec[] = [
  {
    kind: 'ast',
    id: 'syntax-idiom',
    supportedScales: ['source-range', 'symbol', 'file'],
  },
  {
    kind: 'project-context',
    id: 'architecture-dependency',
    supportedScales: ['module'],
  },
  {
    kind: 'ast',
    id: 'api-protocol',
    supportedScales: ['source-range', 'symbol', 'module'],
  },
  {
    kind: 'ast',
    id: 'lifecycle-error-invariant',
    supportedScales: ['source-range', 'symbol', 'module'],
  },
  {
    kind: 'config',
    id: 'config-build-test-migration',
    parser: 'react-native-package-json',
    supportedScales: ['file', 'module'],
  },
  {
    kind: 'project-context',
    id: 'history-fix-pattern',
    supportedScales: ['symbol'],
  },
  {
    kind: 'project-context',
    id: 'synthesis-cross-cutting',
    supportedScales: ['module'],
  },
  {
    kind: 'ast',
    id: 'strict-counterexample',
    supportedScales: ['file'],
  },
];

export interface MainStrictFactExecutionResultV1 {
  readonly facts: Awaited<ReturnType<typeof executeStrictFactScheduleV1>>['facts'];
  readonly receipts: Awaited<ReturnType<typeof executeStrictFactScheduleV1>>['receipts'];
  readonly manifest: Awaited<ReturnType<typeof executeStrictFactScheduleV1>>['manifest'];
  readonly terminalObligations: readonly {
    readonly obligationId: string;
    readonly disposition: 'matched' | 'inspected-no-pattern' | 'failed' | 'unknown';
    readonly terminalReceiptId: string;
  }[];
}

export function createMainStrictFactQueryFamiliesV1(): FactQueryFamilyV1[] {
  return MAIN_STRICT_BACKEND_SPECS.map(createFamily);
}

export async function executeMainStrictFactScheduleV1(input: {
  readonly artifact: CertifiedProjectFactsArtifactV1;
  readonly certifiedPlanningFacts: CertifiedPlanningFactsV1;
  readonly projection: MainCertifiedProjectionPayload;
  readonly projectRoot: string;
  readonly schedule: MiningWorkScheduleV1;
  readonly catalog: {
    readonly schemaVersion: 1;
    readonly capabilities: readonly string[];
    readonly families: readonly FactQueryFamilyV1[];
    readonly catalogHash: `sha256:${string}`;
  };
  readonly evidenceSessionId: string;
}): Promise<MainStrictFactExecutionResultV1> {
  const evidenceEntries = input.projection.files.map((file, index) =>
    createEvidenceEntry(file, index, input.evidenceSessionId)
  );
  const evidenceLedgerSnapshot = createStrictEvidenceLedgerSnapshotV1(evidenceEntries);
  const projectContextRefs = input.projection.files.map((file) =>
    resolveProjectContextFileRef(input.projection, input.projectRoot, file)
  );
  const witnessAuthority = createStrictFactWitnessAuthorityV1({
    artifact: input.artifact,
    evidenceLedgerSnapshot,
    projectContextRefs,
  });
  const witnessBindings = input.projection.files.map((file, index) => {
    const evidenceEntry = evidenceEntries[index];
    const projectContextRef = projectContextRefs[index];
    if (!evidenceEntry || !projectContextRef) {
      throw new Error(`STRICT_FACT_WITNESS_INPUT_MISSING:${file.repoId}:${file.relativePath}`);
    }
    return createStrictFactDirectWitnessBindingV1({
      artifact: input.artifact,
      repoId: file.repoId,
      relativePath: file.relativePath,
      evidenceEntry,
      evidenceLedgerSnapshot,
      projectContextRef,
    });
  });
  const modulesById = new Map(input.projection.modules.map((module) => [module.moduleId, module]));
  const subjectBindings = input.certifiedPlanningFacts.modules.map((module) => {
    const owner = modulesById.get(module.moduleId);
    if (!owner) {
      throw new Error(`STRICT_FACT_SUBJECT_UNAVAILABLE:${module.scopeId}`);
    }
    return createStrictFactSubjectBindingV1({
      artifact: input.artifact,
      planningFacts: input.certifiedPlanningFacts,
      selector: {
        kind: 'owner-module',
        repoId: owner.repoId,
        ownerModuleId: owner.moduleId,
      },
    });
  });
  const registry = createStrictFactBackendRegistryV1(input.catalog.families.map(createBackend));
  const executed = await executeStrictFactScheduleV1({
    artifact: input.artifact,
    planningFacts: input.certifiedPlanningFacts,
    catalog: input.catalog,
    schedule: input.schedule,
    subjectBindings,
    witnessBindings,
    witnessAuthority,
    registry,
  });
  assertCodeFactGenerationManifestV1(executed);
  if (executed.manifest.verdict !== 'passed') {
    throw new Error(
      `STRICT_FACT_EXECUTION_MANIFEST_FAILED:${JSON.stringify({
        manifestHash: executed.manifest.manifestHash,
        failedObligationIds: executed.manifest.failedObligationIds,
        unknownObligationIds: executed.manifest.unknownObligationIds,
        unexecutableCatalogFamilyIds: executed.manifest.unexecutableCatalogFamilyIds,
        unregisteredBackendFamilyIds: executed.manifest.unregisteredBackendFamilyIds,
        dispositions: executed.receipts.map((receipt) => ({
          obligationId: receipt.obligationId,
          familyId: receipt.factFamilyId,
          disposition: receipt.disposition,
          reasonCode: receipt.reasonCode,
        })),
      })}`
    );
  }
  return Object.freeze({
    ...executed,
    terminalObligations: executed.receipts.map((receipt) => ({
      obligationId: receipt.obligationId,
      disposition: receipt.disposition,
      terminalReceiptId: receipt.terminalReceiptId,
    })),
  });
}

export function createMainStrictExpandedFactScheduleV1(
  baseline: MiningWorkScheduleV1,
  expansionRows: readonly MainStrictAnalysisExpansionRowV1[]
): MiningWorkScheduleV1 {
  const appended = expansionRows.map((row) => {
    const identity = {
      factFamilyId: row.factFamilyId,
      capabilityId: row.capabilityId,
      canonicalSubjectRef: row.canonicalSubjectRef,
      analysisScale: row.analysisScale,
      denominator: 'complete-frozen-subject' as const,
    };
    const obligationId = `fact:${hashCanonicalJson(identity).slice(7, 31)}`;
    if (row.obligationId !== obligationId) {
      throw new Error(`STRICT_ANALYSIS_EXPANSION_IDENTITY_MISMATCH:${row.obligationId}`);
    }
    return {
      obligationId,
      ...identity,
      source: 'accepted-plan-addition' as const,
    } satisfies FactHarvestObligationV1;
  });
  const factHarvestObligations = uniqueObligations([
    ...baseline.factHarvestObligations,
    ...appended,
  ]);
  const factHarvestScheduleHash = hashCanonicalJson(factHarvestObligations);
  const lensBindings = baseline.lensBindings;
  const lensBindingsHash = hashCanonicalJson(lensBindings);
  return Object.freeze({
    schemaVersion: 1,
    factHarvestObligations,
    lensBindings,
    factHarvestScheduleHash,
    lensBindingsHash,
    baselineScheduleHash: hashCanonicalJson({ factHarvestScheduleHash, lensBindingsHash }),
  });
}

export function createMainStrictExpansionRowV1(input: {
  readonly purpose: MainStrictAnalysisExpansionRowV1['purpose'];
  readonly factFamilyId: string;
  readonly capabilityId: string;
  readonly canonicalSubjectRef: string;
  readonly analysisScale: MainStrictAnalysisExpansionRowV1['analysisScale'];
  readonly reasonCode: string;
}): MainStrictAnalysisExpansionRowV1 {
  const identity = {
    factFamilyId: input.factFamilyId,
    capabilityId: input.capabilityId,
    canonicalSubjectRef: input.canonicalSubjectRef,
    analysisScale: input.analysisScale,
    denominator: 'complete-frozen-subject' as const,
  };
  return Object.freeze({
    ...input,
    obligationId: `fact:${hashCanonicalJson(identity).slice(7, 31)}`,
  });
}

function createFamily(spec: MainStrictBackendSpec): FactQueryFamilyV1 {
  if (spec.kind === 'ast') {
    return createAstFactQueryFamilyV1({
      queryPack: createAstPack(spec.id),
      supportedScales: spec.supportedScales,
    });
  }
  if (spec.kind === 'project-context') {
    return createProjectContextFactQueryFamilyV1({
      familyId: spec.id,
      supportedScales: spec.supportedScales,
    });
  }
  return createConfigFactQueryFamilyV1({
    familyId: spec.id,
    supportedScales: spec.supportedScales,
    parser: spec.parser,
  });
}

function createBackend(family: FactQueryFamilyV1): StrictFactQueryBackendV1 {
  const spec = MAIN_STRICT_BACKEND_SPECS.find((candidate) => candidate.id === family.id);
  if (!spec) {
    throw new Error(`STRICT_FACT_QUERY_FAMILY_UNIMPLEMENTED:${family.id}`);
  }
  if (spec.kind === 'ast') {
    return createAstFactQueryBackendV1({ family, queryPack: createAstPack(spec.id) });
  }
  if (spec.kind === 'project-context') {
    return createProjectContextFactQueryBackendV1({ family });
  }
  return createConfigFactQueryBackendV1({ family, parser: spec.parser });
}

function createAstPack(familyId: string) {
  return createStrictAstFactQueryPackV1({
    familyId,
    queryId: `alembic-main-${familyId}-declarations`,
    queryVersion: '1',
    extractorId: 'declarations-v1',
  });
}

function createEvidenceEntry(
  file: MainCertifiedSourceFile,
  index: number,
  evidenceSessionId: string
) {
  const content = Buffer.from(file.contentBase64, 'base64').toString('utf8');
  return {
    id: `E-${index + 1}`,
    sessionId: evidenceSessionId,
    dimensionId: 'strict-production',
    tool: 'code.read' as const,
    callId: `strict-frozen-file-${index + 1}`,
    file: file.relativePath,
    content,
    contentHash: `sha256:${createHash('sha256').update(Buffer.from(content)).digest('hex')}`,
    capturedAt: 0,
  };
}

function resolveProjectContextFileRef(
  projection: MainCertifiedProjectionPayload,
  projectRoot: string,
  file: MainCertifiedSourceFile
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
  // Core 尚未公开 file-ref factory；这里机械复刻其 public contract，并由 Core authority
  // 对 id/scope/hash 与冻结 artifact 做全量重算校验，任何漂移都会 fail closed。
  return {
    id: `file:${encodeRefPart(file.repoId)}:${encodeRefPart(file.relativePath)}:${encodeRefPart(
      file.blobHash
    )}`,
    kind: 'file',
    label: file.relativePath,
    level: 'source-slice',
    metadata: { hash: file.blobHash },
    scope: {
      projectRoot,
      repoId: file.repoId,
      filePath: file.relativePath,
    },
  };
}

function encodeRefPart(value: string): string {
  return encodeURIComponent(value).replaceAll('%2F', '/');
}

function uniqueObligations(rows: readonly FactHarvestObligationV1[]): FactHarvestObligationV1[] {
  const byId = new Map<string, FactHarvestObligationV1>();
  for (const row of rows) {
    const existing = byId.get(row.obligationId);
    if (existing && hashCanonicalJson(existing) !== hashCanonicalJson(row)) {
      throw new Error(`STRICT_ANALYSIS_EXPANSION_DUPLICATE:${row.obligationId}`);
    }
    byId.set(row.obligationId, row);
  }
  return [...byId.values()].sort((left, right) =>
    left.obligationId.localeCompare(right.obligationId)
  );
}

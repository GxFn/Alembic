import path from 'node:path';
import type { DimensionDef } from '@alembic/core/host-agent-workflows';
import {
  buildProjectContextPresenterInput,
  type ProjectContextEnvelope,
  type ProjectContextPresenterInput,
  type ProjectContextRequestKind,
  type ProjectContextResult,
} from '@alembic/core/project-context';
import {
  buildProjectContextRequestMatrixV2,
  buildProjectScopeManifestV1,
  type CertifiedProjectFactsArtifactV1,
  type CertifiedProjectFactsConsumer,
  CertifiedProjectFactsConsumerPort,
  captureCertifiedProjectFactsV2,
  createProjectContextRequestAuditPlansV2,
  FileCertifiedProjectFactsStore,
  hashCanonicalJson,
  NodeProjectContextFoundationHostPorts,
  type ProjectContextConsumerProjectionReceiptV2,
  type ProjectContextFoundationFileDescriptor,
  type ProjectContextFoundationRepositoryInput,
  type ProjectContextInventoryPolicyV1,
  type ProjectContextLegacyEntryAuditRowV1,
  readCertifiedProjectFactsFrozenFile,
  verifyProjectContextConsumerProjectionReceiptV2,
} from '@alembic/core/project-context-foundation';
import type { PlanProjectContextAnalysis } from '@alembic/core/service/planFacts';
import type { GenerateFileEntry } from '#recipe-pipeline/generate/execution/AgentRunInputBuilders.js';
import type { ProjectScopeAnalysisContext } from '../project-scope/ProjectScopeAnalysis.js';
import type { ProjectContextDependencyGraph } from './ProjectContextConsumerFacts.js';
import type {
  ProjectContextModule,
  ProjectContextWorkflowFacts,
} from './ProjectContextWorkflowFacts.js';

export const MAIN_CERTIFIED_PROJECT_FACTS_ADAPTER_VERSION = 'alembic-main-pcf-adapters-v1';

const MAIN_CERTIFIED_CONSUMERS = [
  'plan',
  'recipe-generation',
  'dependency-graph',
  'module-coverage',
] as const satisfies readonly CertifiedProjectFactsConsumer[];

export const MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS = {
  'dependency-graph': 'lib/recipe-pipeline/generate/execution/AiDimensionPreparation.js',
  'module-coverage': 'lib/service/module/ModuleService.js',
  plan: 'lib/recipe-pipeline/plan/PlanSelectionGate.js',
  'recipe-generation': 'lib/recipe-pipeline/generate/ColdStartWorkflow.js',
} as const satisfies Record<(typeof MAIN_CERTIFIED_CONSUMERS)[number], string>;

const SOURCE_EXTENSIONS = [
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.cxx',
  '.go',
  '.h',
  '.hpp',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.kts',
  '.m',
  '.mm',
  '.mjs',
  '.py',
  '.rb',
  '.rs',
  '.swift',
  '.ts',
  '.tsx',
  '.vue',
] as const;

const INVENTORY_POLICY: ProjectContextInventoryPolicyV1 = {
  excludeDirectories: [
    '.asd',
    '.git',
    '.next',
    '.turbo',
    'DerivedData',
    'Pods',
    'build',
    'coverage',
    'dist',
    'node_modules',
    'vendor',
  ],
  includeExtensions: [...SOURCE_EXTENSIONS],
  version: 'alembic-main-source-inventory-v1',
};

export interface MainCertifiedProjectionPayload {
  canonicalScopeHash: string;
  consumer: (typeof MAIN_CERTIFIED_CONSUMERS)[number];
  files: MainCertifiedSourceFile[];
  modules: MainCertifiedModule[];
  requestKinds: ProjectContextRequestKind[];
  envelopes: ProjectContextEnvelope<ProjectContextResult>[];
  dependencyGraph?: MainCertifiedDependencyGraph;
}

export interface MainCertifiedDependencyGraph {
  dependencySummary?: Record<string, unknown>;
  edges: Array<{ from: string; to: string; type: string; source: string }>;
  nodes: Array<Record<string, unknown>>;
  projectInformationSource: 'project-context';
}

export interface MainCertifiedSourceFile {
  blobHash: string;
  byteLength: number;
  contentBase64: string;
  language: string;
  moduleIds: string[];
  relativePath: string;
  repositoryRelativeRoot: string;
  repoId: string;
}

export interface MainCertifiedModule {
  moduleId: string;
  moduleName: string;
  ownedFiles: string[];
  repoId: string;
}

export interface MainCertifiedProjectFactsCounters {
  cappedModuleProjectionCount: number;
  directProjectContextCallCount: number;
  rawFilesystemFallbackCount: number;
  synthesizedProjectScopeFactCount: number;
}

export type MainCertifiedProjectFactsInstrumentationEvent =
  | {
      consumer: (typeof MAIN_CERTIFIED_CONSUMERS)[number];
      entrypoint: string;
      kind: 'consumer-reopen';
      receiptHash: string;
    }
  | {
      emittedModuleCount: number;
      expectedOwnerModuleCount: number;
      kind: 'module-projection';
    }
  | {
      entrypoint: string;
      kind: 'legacy-route';
      route: 'direct-project-context' | 'raw-filesystem' | 'synthesized-project-scope';
    };

export interface MainCertifiedProjectFactsCarrier {
  artifactId: CertifiedProjectFactsArtifactV1['artifactId'];
  baseReadbackUnchanged: true;
  canonicalScopeHash: CertifiedProjectFactsArtifactV1['certificationBindingHash'];
  certificationBindingHash: CertifiedProjectFactsArtifactV1['certificationBindingHash'];
  counters: MainCertifiedProjectFactsCounters;
  factsContentHash: CertifiedProjectFactsArtifactV1['factsContentHash'];
  instrumentation: MainCertifiedProjectFactsInstrumentationEvent[];
  receipts: Partial<
    Record<(typeof MAIN_CERTIFIED_CONSUMERS)[number], ProjectContextConsumerProjectionReceiptV2>
  >;
  sourceVectorHash: CertifiedProjectFactsArtifactV1['sourceVectorHash'];
}

export interface MainCertifiedProjectFactsState extends MainCertifiedProjectFactsCarrier {
  storeReceiptHash: string;
}

export interface MainCertifiedProjectFactsConsumerResult {
  projection: MainCertifiedProjectionPayload;
  receipt: ProjectContextConsumerProjectionReceiptV2;
}

/**
 * strict fact executor 需要 Core 冻结 artifact 本体，而 checkpoint 只保存轻量 carrier。
 * 该入口仅回读并复核既有 artifact，不创建第二份事实存储，也不把大对象写回 checkpoint。
 */
export async function openMainCertifiedProjectFactsArtifact(input: {
  carrier: MainCertifiedProjectFactsCarrier;
  dataRoot: string;
}): Promise<CertifiedProjectFactsArtifactV1> {
  assertMainCertifiedProjectFactsCarrier(input.carrier);
  const store = new FileCertifiedProjectFactsStore(mainCertifiedStoreRoot(input.dataRoot));
  const artifact = await store.open(
    input.carrier.artifactId,
    input.carrier.certificationBindingHash
  );
  assertSameCertifiedCarrierBase(input.carrier, artifact);
  return artifact;
}

export interface MainCertifiedProjectFactsSessionPort {
  id: string;
  projectRoot: string;
  replaceProjectContext(projectContext: Record<string, unknown>): void;
  toSnapshot(): { projectContext: Record<string, unknown> };
}

interface MainCertifiedProjectScopeInput {
  analysisScope?: ProjectScopeAnalysisContext;
  projectRoot: string;
}

interface CaptureMainCertifiedProjectFactsInput extends MainCertifiedProjectScopeInput {
  dimensions: DimensionDef[];
  source: 'alembic-main-bootstrap' | 'alembic-main-rescan';
}

export function resolveMainCertifiedProjectScopeHash(
  input: MainCertifiedProjectScopeInput
): string {
  return createMainScopeBinding(input).manifest.canonicalScopeHash;
}

export async function captureMainCertifiedProjectFacts(
  input: CaptureMainCertifiedProjectFactsInput
): Promise<MainCertifiedProjectFactsState> {
  const scope = createMainScopeBinding(input);
  const inventoryPolicy = inventoryPolicyForScope(scope.manifest.repositories);
  const ports = new NodeProjectContextFoundationHostPorts(undefined, {
    portableRoots: scope.repositories.map((repository) => ({
      portableId: repository.repoId,
      sourceRoot: repository.sourceRoot,
    })),
  });
  const inventoryRows: Array<{
    files: ProjectContextFoundationFileDescriptor[];
    repository: ProjectContextFoundationRepositoryInput;
  }> = [];
  for (const repository of scope.repositories) {
    inventoryRows.push({
      files: await ports.enumerateEligibleFiles({
        policy: inventoryPolicy,
        repository,
      }),
      repository,
    });
  }
  const plans = inventoryRows.flatMap(({ files, repository }) =>
    createProjectContextRequestAuditPlansV2({
      eligibleFiles: files,
      projectScopeManifest: scope.manifest,
      repository,
    })
  );
  const requestMatrix = buildProjectContextRequestMatrixV2(scope.manifest, plans);
  const selectedFiles = inventoryRows.flatMap(({ files, repository }) =>
    files.map((file) => ({ repoId: repository.repoId, relativePath: file.relativePath }))
  );
  const artifact = await captureCertifiedProjectFactsV2(
    {
      certification: {
        acceptedConfigHash: hashCanonicalJson({ inventoryPolicy }),
        acceptedRuntimeHash: hashCanonicalJson({
          adapterVersion: MAIN_CERTIFIED_PROJECT_FACTS_ADAPTER_VERSION,
          runtime: 'alembic-main',
        }),
        capabilityHash: hashCanonicalJson({
          consumers: MAIN_CERTIFIED_CONSUMERS,
          foundation: 'strict-v2',
        }),
        parserHash: hashCanonicalJson({ authority: 'core-node-project-context-host-ports' }),
        scopeIdentityHash: scope.manifest.canonicalScopeHash,
      },
      detailPolicy: {
        chunkBytes: 4 * 1024 * 1024,
        maxPreviewBytes: 4096,
        maxSelectedFiles: Math.max(1, selectedFiles.length),
        selectedFiles,
      },
      inventoryPolicy,
      legacyEntries: mainStrictLegacyEntryInventory(input.source, []),
      projectMode: scope.manifest.projectMode,
      projectScope: scope,
      projections: emptyCompatibilityProjections(),
      repositories: scope.repositories,
      requestMatrix,
      requestPlans: requestMatrix.plans,
    },
    ports
  );

  const storeRoot = mainCertifiedStoreRoot(input.analysisScope?.dataRoot ?? input.projectRoot);
  const store = new FileCertifiedProjectFactsStore(storeRoot);
  const storeReceipt = await store.put(artifact);
  const reopenedStore = new FileCertifiedProjectFactsStore(storeRoot);
  const reopened = await reopenedStore.open(artifact.artifactId, artifact.certificationBindingHash);
  assertSameCertifiedBase(artifact, reopened);
  const finalReadback = await reopenedStore.open(
    artifact.artifactId,
    artifact.certificationBindingHash
  );
  assertSameCertifiedBase(artifact, finalReadback);

  const state: MainCertifiedProjectFactsState = {
    artifactId: artifact.artifactId,
    baseReadbackUnchanged: true,
    canonicalScopeHash: scope.manifest.canonicalScopeHash,
    certificationBindingHash: artifact.certificationBindingHash,
    counters: summarizeMainCertifiedInstrumentation([]),
    factsContentHash: artifact.factsContentHash,
    instrumentation: [],
    receipts: {},
    sourceVectorHash: artifact.sourceVectorHash,
    storeReceiptHash: storeReceipt.receiptHash,
  };
  assertMainCertifiedProjectFactsCarrier(state);
  return state;
}

export async function reopenMainCertifiedProjectFactsConsumer(input: {
  carrier: MainCertifiedProjectFactsCarrier;
  consumer: (typeof MAIN_CERTIFIED_CONSUMERS)[number];
  dataRoot: string;
  entrypoint: string;
  runId?: string;
}): Promise<MainCertifiedProjectFactsConsumerResult> {
  assertMainCertifiedProjectFactsCarrier(input.carrier);
  if (input.entrypoint !== MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS[input.consumer]) {
    throw new TypeError(
      `Certified ${input.consumer} adapter must reopen at its actual production entrypoint.`
    );
  }
  const store = new FileCertifiedProjectFactsStore(mainCertifiedStoreRoot(input.dataRoot));
  const artifact = await store.open(
    input.carrier.artifactId,
    input.carrier.certificationBindingHash
  );
  assertSameCertifiedCarrierBase(input.carrier, artifact);
  const preparation = await store.createPreparation(
    artifact.artifactId,
    artifact.certificationBindingHash
  );
  const runId = input.runId ?? `main-${input.consumer}`;
  const projected = await new CertifiedProjectFactsConsumerPort(store).reopenWithAdapter({
    adapter: mainConsumerAdapter(input.consumer, input.entrypoint),
    consumer: input.consumer,
    expectedCertificationBindingHash: artifact.certificationBindingHash,
    preparationId: preparation.preparationId,
    runId,
  });
  const projection = projected.payload as unknown as MainCertifiedProjectionPayload;
  assertMainCertifiedProjection(input.carrier, input.consumer, projection, projected.receipt);
  await store.completeRunLease({
    expectedCertificationBindingHash: artifact.certificationBindingHash,
    preparationId: preparation.preparationId,
    runId,
  });
  input.carrier.receipts[input.consumer] = projected.receipt;
  input.carrier.instrumentation = input.carrier.instrumentation.filter(
    (event) =>
      !(event.kind === 'consumer-reopen' && event.consumer === input.consumer) &&
      event.kind !== 'module-projection'
  );
  input.carrier.instrumentation.push(
    {
      consumer: input.consumer,
      entrypoint: input.entrypoint,
      kind: 'consumer-reopen',
      receiptHash: projected.receipt.receiptHash,
    },
    {
      emittedModuleCount: projection.modules.length,
      expectedOwnerModuleCount: expectedOwnerModuleCount(projection.files),
      kind: 'module-projection',
    }
  );
  input.carrier.counters = summarizeMainCertifiedInstrumentation(input.carrier.instrumentation);
  assertMainCertifiedProjectFactsCarrier(input.carrier);
  return { projection, receipt: projected.receipt };
}

export function buildStrictProjectContextWorkflowFacts(input: {
  certified: MainCertifiedProjectFactsCarrier;
  controlRoot: string;
  dimensions: DimensionDef[];
  projection: MainCertifiedProjectionPayload;
  projectRoot: string;
  source: 'alembic-main-bootstrap' | 'alembic-main-rescan';
}): ProjectContextWorkflowFacts {
  assertMainCertifiedProjectFactsCarrier(input.certified);
  const recipe = input.projection;
  if (recipe.consumer !== 'recipe-generation' && recipe.consumer !== 'plan') {
    throw new TypeError('Strict workflow facts require a recipe-generation or plan projection.');
  }
  const allFiles = recipe.files.map((file) =>
    certifiedFileToGenerateEntry(file, input.controlRoot)
  );
  const modules = recipe.modules.map(certifiedModuleToWorkflowModule);
  const presenterInput = presenterInputFromProjection(recipe);
  const languageStats = countLanguages(recipe.files);
  const primaryLang = primaryLanguage(languageStats);
  const secondaryLanguages = Object.keys(languageStats)
    .filter((language) => language !== primaryLang)
    .sort();
  const allTargets = modules.map((module) => ({
    fileCount: module.ownedFiles?.length ?? 0,
    name: module.moduleName,
    type: module.kind ?? 'certified-module',
  }));
  const filesByTarget = Object.fromEntries(
    modules.map((module) => [
      module.moduleName,
      allFiles
        .filter((file) => module.ownedFiles?.includes(file.relativePath))
        .map((file) => ({
          content: file.content,
          name: file.name,
          path: file.path,
          relativePath: file.relativePath,
        })),
    ])
  );
  const requestKinds = [...recipe.requestKinds];
  return {
    allFiles,
    allTargets,
    certifiedProjectFacts: input.certified,
    dimensions: [...input.dimensions],
    envelopes: recipe.envelopes,
    fileCount: allFiles.length,
    filesByTarget,
    incrementalPlan: null,
    isEmpty: allFiles.length === 0,
    isMultiLang: secondaryLanguages.length > 0,
    languageStats,
    moduleCount: modules.length,
    moduleSeeds: modules.map((module) => ({
      kind: module.kind,
      moduleName: module.moduleName,
      modulePath: module.modulePath,
      ownedFiles: module.ownedFiles,
      role: module.role,
    })),
    presenterInput,
    primaryLang,
    projectContextSummary: {
      artifactId: input.certified.artifactId,
      certificationBindingHash: input.certified.certificationBindingHash,
      files: allFiles.length,
      modules: modules.length,
      source: 'certified-project-facts',
    },
    projectMapModules: modules,
    projectRoot: input.projectRoot,
    projectType: 'certified-project',
    report: {
      certifiedProjectFacts: {
        artifactId: input.certified.artifactId,
        baseReadbackUnchanged: input.certified.baseReadbackUnchanged,
        counters: input.certified.counters,
        receipts: Object.fromEntries(
          Object.entries(input.certified.receipts).map(([consumer, receipt]) => [
            consumer,
            receipt.receiptHash,
          ])
        ),
      },
      phases: {
        projectContext: {
          files: allFiles.length,
          modules: modules.length,
          requestKinds,
          truncated: false,
        },
      },
      projectInformationSource: 'certified-project-facts',
    },
    requestKinds,
    secondaryLanguages,
    targetCount: allTargets.length,
    warnings: [],
  };
}

export function buildPlanAnalysisFromCertifiedFacts(
  facts: ProjectContextWorkflowFacts,
  plan: MainCertifiedProjectionPayload
): PlanProjectContextAnalysis {
  requireCertifiedState(facts);
  if (plan.consumer !== 'plan') {
    throw new TypeError('Plan analysis requires the plan certified projection.');
  }
  return {
    contextStatus: 'complete',
    dimensions: facts.dimensions,
    envelopes: plan.envelopes,
    factSource: 'project-context',
    fileCount: plan.files.length,
    frameworks: [],
    moduleCount: plan.modules.length,
    moduleSeeds: plan.modules.map((module) => ({
      moduleName: module.moduleName,
      modulePath: module.ownedFiles[0] ? path.posix.dirname(module.ownedFiles[0]) : undefined,
      ownedFiles: module.ownedFiles,
      role: 'certified-module',
    })),
    presenterInput: presenterInputFromProjection(plan),
    primaryLanguage: primaryLanguage(countLanguages(plan.files)),
    projectType: 'certified-project',
    requestKinds: plan.requestKinds,
    secondaryLanguages: Object.keys(countLanguages(plan.files))
      .filter((language) => language !== primaryLanguage(countLanguages(plan.files)))
      .sort(),
    sourceFileFacts: plan.files.map((file) => ({
      filePath: qualifyMainCertifiedPath(file),
      language: file.language,
      sizeBytes: file.byteLength,
    })),
    understandingGaps: [],
  };
}

export function dependencyGraphFromCertifiedFacts(
  facts: ProjectContextWorkflowFacts,
  projection: MainCertifiedProjectionPayload
): ProjectContextDependencyGraph {
  requireCertifiedState(facts);
  if (projection.consumer !== 'dependency-graph') {
    throw new TypeError('Dependency graph analysis requires its certified projection.');
  }
  if (!projection.dependencyGraph) {
    throw new TypeError('Certified dependency-graph projection is missing its graph payload.');
  }
  return {
    dependencySummary: projection.dependencyGraph.dependencySummary,
    edges: projection.dependencyGraph.edges,
    generatedAt: 'certified-artifact',
    nodes: projection.dependencyGraph.nodes,
    projectInformationSource: projection.dependencyGraph.projectInformationSource,
    projectRoot: facts.projectRoot,
  };
}

export function serializeMainCertifiedProjectFactsCarrier(
  state: MainCertifiedProjectFactsCarrier
): MainCertifiedProjectFactsCarrier {
  assertMainCertifiedProjectFactsCarrier(state);
  return {
    artifactId: state.artifactId,
    baseReadbackUnchanged: true,
    canonicalScopeHash: state.canonicalScopeHash,
    certificationBindingHash: state.certificationBindingHash,
    counters: { ...state.counters },
    factsContentHash: state.factsContentHash,
    instrumentation: structuredClone(state.instrumentation),
    receipts: structuredClone(state.receipts),
    sourceVectorHash: state.sourceVectorHash,
  };
}

export function sameMainCertifiedProjectFactsBinding(
  left: MainCertifiedProjectFactsCarrier,
  right: MainCertifiedProjectFactsCarrier
): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.sourceVectorHash === right.sourceVectorHash &&
    left.factsContentHash === right.factsContentHash &&
    left.certificationBindingHash === right.certificationBindingHash &&
    left.canonicalScopeHash === right.canonicalScopeHash
  );
}

/**
 * 把实际 consumer 刚产生的 receipt 同步写回原 Generate session。
 * Core 的 replaceProjectContext() 在返回前完成持久化；这里再读当前实例，防止
 * 调用方误把 toSnapshot() 的副本当作活动会话或覆盖掉更早的 receipt。
 */
export function persistMainCertifiedProjectFactsCarrier(input: {
  carrier: MainCertifiedProjectFactsCarrier;
  projectRoot: string;
  session: MainCertifiedProjectFactsSessionPort;
}): string {
  assertMainCertifiedProjectFactsCarrier(input.carrier);
  if (path.resolve(input.session.projectRoot) !== path.resolve(input.projectRoot)) {
    throw new TypeError(
      'Certified project facts cannot move to a different Generate session root.'
    );
  }
  const snapshot = input.session.toSnapshot();
  const previous = readMainCertifiedCarrierFromProjectContext(snapshot.projectContext);
  if (!previous || !sameMainCertifiedProjectFactsBinding(previous, input.carrier)) {
    throw new TypeError('Generate session has a stale certified project facts binding.');
  }
  for (const [consumer, receipt] of Object.entries(previous.receipts)) {
    if (
      input.carrier.receipts[consumer as keyof typeof input.carrier.receipts]?.receiptHash !==
      receipt?.receiptHash
    ) {
      throw new TypeError(`Generate session would lose its existing ${consumer} receipt.`);
    }
  }

  input.session.replaceProjectContext({
    ...snapshot.projectContext,
    certifiedProjectFacts: serializeMainCertifiedProjectFactsCarrier(input.carrier),
  });
  const persisted = readMainCertifiedCarrierFromProjectContext(
    input.session.toSnapshot().projectContext
  );
  if (
    !persisted ||
    hashCanonicalJson(serializeMainCertifiedProjectFactsCarrier(persisted)) !==
      hashCanonicalJson(serializeMainCertifiedProjectFactsCarrier(input.carrier))
  ) {
    throw new TypeError('Generate session did not persist the certified project facts update.');
  }
  return input.session.id;
}

export function assertMainCertifiedProjectFactsCarrier(
  value: unknown
): asserts value is MainCertifiedProjectFactsCarrier {
  const carrier = value as MainCertifiedProjectFactsCarrier;
  if (!carrier || typeof carrier !== 'object') {
    throw new TypeError('Certified project facts carrier is missing.');
  }
  if (carrier.baseReadbackUnchanged !== true) {
    throw new TypeError('Certified project facts carrier is missing its base readback proof.');
  }
  const identities = [
    carrier.artifactId,
    carrier.sourceVectorHash,
    carrier.factsContentHash,
    carrier.certificationBindingHash,
  ];
  if (identities.some((identity) => typeof identity !== 'string' || !identity)) {
    throw new TypeError('Certified project facts carrier has a partial binding.');
  }
  assertMainCertifiedReceipts(carrier);
  if (!/^sha256:[a-f0-9]{64}$/.test(carrier.canonicalScopeHash)) {
    throw new TypeError('Certified project facts carrier has a scope binding mismatch.');
  }
  assertMainCertifiedInstrumentation(carrier);
}

function assertMainCertifiedReceipts(carrier: MainCertifiedProjectFactsCarrier): void {
  if (!carrier.receipts || typeof carrier.receipts !== 'object') {
    throw new TypeError('Certified project facts carrier receipt ledger is missing.');
  }
  for (const [consumer, receipt] of Object.entries(carrier.receipts)) {
    if (!MAIN_CERTIFIED_CONSUMERS.includes(consumer as never) || !receipt) {
      throw new TypeError(`Certified project facts carrier has an unknown ${consumer} receipt.`);
    }
    verifyProjectContextConsumerProjectionReceiptV2(receipt);
    if (
      receipt.artifactId !== carrier.artifactId ||
      receipt.sourceVectorHash !== carrier.sourceVectorHash ||
      receipt.factsContentHash !== carrier.factsContentHash ||
      receipt.certificationBindingHash !== carrier.certificationBindingHash ||
      receipt.consumer !== consumer ||
      receipt.entrypoint !==
        MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS[
          consumer as (typeof MAIN_CERTIFIED_CONSUMERS)[number]
        ]
    ) {
      throw new TypeError(`Certified project facts carrier has a stale ${consumer} binding.`);
    }
  }
}

function assertMainCertifiedInstrumentation(carrier: MainCertifiedProjectFactsCarrier): void {
  if (!Array.isArray(carrier.instrumentation)) {
    throw new TypeError('Certified project facts carrier instrumentation is missing.');
  }
  const observedCounters = summarizeMainCertifiedInstrumentation(carrier.instrumentation);
  if (
    !carrier.counters ||
    Object.entries(observedCounters).some(
      ([key, count]) => carrier.counters[key as keyof MainCertifiedProjectFactsCounters] !== count
    )
  ) {
    throw new TypeError('Strict certified consumer counters do not match observed routes.');
  }
  if (Object.values(observedCounters).some((count) => count !== 0)) {
    throw new TypeError('Strict certified consumer counters must remain zero.');
  }
}

export function recordMainCertifiedLegacyRoute(
  carrier: MainCertifiedProjectFactsCarrier,
  event: Extract<MainCertifiedProjectFactsInstrumentationEvent, { kind: 'legacy-route' }>
): never {
  carrier.instrumentation = carrier.instrumentation.filter(
    (candidate) =>
      !(
        candidate.kind === 'legacy-route' &&
        candidate.route === event.route &&
        candidate.entrypoint === event.entrypoint
      )
  );
  carrier.instrumentation.push(event);
  carrier.counters = summarizeMainCertifiedInstrumentation(carrier.instrumentation);
  throw new TypeError(
    `Strict certified consumer attempted forbidden ${event.route} route at ${event.entrypoint}.`
  );
}

export function summarizeMainCertifiedInstrumentation(
  events: readonly MainCertifiedProjectFactsInstrumentationEvent[]
): MainCertifiedProjectFactsCounters {
  const counters: MainCertifiedProjectFactsCounters = {
    cappedModuleProjectionCount: 0,
    directProjectContextCallCount: 0,
    rawFilesystemFallbackCount: 0,
    synthesizedProjectScopeFactCount: 0,
  };
  for (const event of events) {
    if (!event || typeof event !== 'object' || typeof event.kind !== 'string') {
      throw new TypeError('Certified project facts instrumentation event is malformed.');
    }
    if (event.kind === 'module-projection') {
      counters.cappedModuleProjectionCount += Math.max(
        0,
        event.expectedOwnerModuleCount - event.emittedModuleCount
      );
    } else if (event.kind === 'legacy-route') {
      if (event.route === 'direct-project-context') {
        counters.directProjectContextCallCount += 1;
      } else if (event.route === 'raw-filesystem') {
        counters.rawFilesystemFallbackCount += 1;
      } else if (event.route === 'synthesized-project-scope') {
        counters.synthesizedProjectScopeFactCount += 1;
      } else {
        throw new TypeError('Certified project facts instrumentation route is unknown.');
      }
    } else if (event.kind === 'consumer-reopen') {
      if (
        !MAIN_CERTIFIED_CONSUMERS.includes(event.consumer) ||
        event.entrypoint !== MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS[event.consumer] ||
        typeof event.receiptHash !== 'string'
      ) {
        throw new TypeError('Certified project facts consumer instrumentation is malformed.');
      }
    } else {
      throw new TypeError('Certified project facts instrumentation kind is unknown.');
    }
  }
  return counters;
}

export function readMainCertifiedCarrierFromProjectContext(
  projectContext: unknown
): MainCertifiedProjectFactsCarrier | null {
  if (!projectContext || typeof projectContext !== 'object') {
    return null;
  }
  const carrier = (projectContext as Record<string, unknown>).certifiedProjectFacts;
  if (carrier === undefined) {
    return null;
  }
  assertMainCertifiedProjectFactsCarrier(carrier);
  return carrier;
}

function createMainScopeBinding(input: MainCertifiedProjectScopeInput) {
  const declared = input.analysisScope?.projectScope;
  if (declared?.folders.length && input.analysisScope?.controlRoot) {
    const controlRoot = path.resolve(input.analysisScope.controlRoot);
    const repositories = declared.folders.map((folder, index) => ({
      relativeRoot: portableRelativeRoot(path.relative(controlRoot, path.resolve(folder.path))),
      repoId: opaqueId(folder.repositoryId ?? folder.id ?? `repo-${index + 1}`),
      sourceRoot: path.resolve(folder.path),
    }));
    return buildProjectScopeManifestV1({
      acceptedScope: {
        projectIdentity: {
          projectId: opaqueId(declared.projectId),
          scopeId: opaqueId(declared.projectScopeId),
        },
        projectMode: 'project-scope',
        repositories: repositories.map(({ relativeRoot, repoId }) => ({ relativeRoot, repoId })),
      },
      controlRoot,
      sourceRoots: repositories.map(({ repoId, sourceRoot }) => ({ repoId, sourceRoot })),
    });
  }
  const projectRoot = path.resolve(input.projectRoot);
  const repoId = opaqueId(path.basename(projectRoot) || 'project');
  return buildProjectScopeManifestV1({
    acceptedScope: {
      projectIdentity: { projectId: repoId, scopeId: `scope-${repoId}` },
      projectMode: 'single-repository',
      repositories: [{ relativeRoot: '.', repoId }],
    },
    controlRoot: projectRoot,
    sourceRoots: [{ repoId, sourceRoot: projectRoot }],
  });
}

function mainConsumerAdapter(
  consumer: (typeof MAIN_CERTIFIED_CONSUMERS)[number],
  entrypoint: string
) {
  return {
    adapterVersion: MAIN_CERTIFIED_PROJECT_FACTS_ADAPTER_VERSION,
    entrypoint,
    loadEvidenceHash: hashCanonicalJson({
      entrypoint,
      implementation: MAIN_CERTIFIED_PROJECT_FACTS_ADAPTER_VERSION,
      loaded: true,
    }),
    payloadSchemaHash: hashCanonicalJson({ consumer, schema: 1 }),
    project: (artifact: Readonly<CertifiedProjectFactsArtifactV1>) =>
      projectMainCertifiedConsumerPayload(artifact as CertifiedProjectFactsArtifactV1, consumer),
  };
}

export function projectMainCertifiedConsumerPayload(
  artifact: CertifiedProjectFactsArtifactV1,
  consumer: (typeof MAIN_CERTIFIED_CONSUMERS)[number]
): MainCertifiedProjectionPayload {
  const scopeManifest = artifact.manifest.projectScopeManifest;
  if (!scopeManifest) {
    throw new TypeError('Certified projection is missing its ProjectScope manifest.');
  }
  const relativeRoots = new Map(
    scopeManifest.repositories.map((repository) => [repository.repoId, repository.relativeRoot])
  );
  const files = artifact.facts.inventory.files.map((file) => ({
    blobHash: file.blobSha256,
    byteLength: file.sizeBytes,
    contentBase64: readCertifiedProjectFactsFrozenFile(artifact, file).toString('base64'),
    language: file.language,
    moduleIds: [...file.ownerModuleIds].sort(),
    relativePath: file.relativePath,
    repositoryRelativeRoot: requireRepositoryRelativeRoot(relativeRoots, file.repoId),
    repoId: file.repoId,
  }));
  const modules = buildCertifiedModules(files);
  const envelopes = artifact.facts.requestOutcomes
    .filter(
      (outcome) => outcome.applicability === 'applicable' && outcome.terminalStatus === 'completed'
    )
    .map((outcome) => {
      if (!isProjectContextEnvelope(outcome.output)) {
        throw new TypeError(`Certified ${outcome.kind} outcome is not a ProjectContext envelope.`);
      }
      return outcome.output as unknown as ProjectContextEnvelope<ProjectContextResult>;
    });
  const requestKinds = [...new Set(artifact.facts.requestOutcomes.map((row) => row.kind))].sort();
  const payload: MainCertifiedProjectionPayload = {
    canonicalScopeHash:
      artifact.manifest.projectScopeManifest?.canonicalScopeHash ??
      artifact.certification.scopeIdentityHash,
    consumer,
    envelopes,
    files,
    modules,
    requestKinds,
  };
  if (consumer === 'plan' || consumer === 'recipe-generation') {
    buildProjectContextPresenterInput(envelopes);
  }
  if (consumer === 'dependency-graph' || consumer === 'module-coverage') {
    payload.dependencyGraph = buildCertifiedDependencyGraph(artifact, modules);
  }
  return payload;
}

function buildCertifiedDependencyGraph(
  artifact: CertifiedProjectFactsArtifactV1,
  modules: MainCertifiedModule[]
): MainCertifiedProjectionPayload['dependencyGraph'] {
  const graphOutcomes = artifact.facts.requestOutcomes.filter(
    (outcome) =>
      outcome.kind === 'map' &&
      outcome.applicability === 'applicable' &&
      outcome.terminalStatus === 'completed'
  );
  if (graphOutcomes.length === 0) {
    throw new TypeError('Certified dependency graph has no completed map authority.');
  }
  const declaredEdges = graphOutcomes.flatMap((outcome) => collectDeclaredEdges(outcome.output));
  return {
    dependencySummary: {
      declaredEdgeSource: 'certified-project-facts',
      edgeCount: declaredEdges.length,
    },
    edges: declaredEdges,
    nodes: modules.map((module) => ({
      fileCount: module.ownedFiles.length,
      id: module.moduleId,
      label: module.moduleName,
      projectInformationSource: 'certified-project-facts',
      type: 'module',
    })),
    projectInformationSource: 'project-context',
  };
}

function collectDeclaredEdges(value: unknown): ProjectContextDependencyGraph['edges'] {
  const edges: ProjectContextDependencyGraph['edges'] = [];
  const visit = (candidate: unknown) => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item);
      }
      return;
    }
    if (!candidate || typeof candidate !== 'object') {
      return;
    }
    const record = candidate as Record<string, unknown>;
    const declaresEdge = 'from' in record || 'to' in record;
    if (declaresEdge) {
      if (
        typeof record.from !== 'string' ||
        typeof record.to !== 'string' ||
        (typeof record.type !== 'string' && record.type !== undefined)
      ) {
        throw new TypeError('Certified dependency graph contains a malformed declared edge.');
      }
      edges.push({
        from: record.from,
        source: 'certified-project-facts',
        to: record.to,
        type: typeof record.type === 'string' ? record.type : 'dependency',
      });
    }
    for (const child of Object.values(record)) {
      visit(child);
    }
  };
  visit(value);
  return edges
    .filter(
      (edge, index, rows) =>
        rows.findIndex(
          (candidate) =>
            candidate.from === edge.from && candidate.to === edge.to && candidate.type === edge.type
        ) === index
    )
    .sort((left, right) =>
      `${left.from}\u0000${left.to}\u0000${left.type}`.localeCompare(
        `${right.from}\u0000${right.to}\u0000${right.type}`
      )
    );
}

function buildCertifiedModules(files: MainCertifiedSourceFile[]): MainCertifiedModule[] {
  const owned = new Map<string, { files: Set<string>; repoId: string }>();
  for (const file of files) {
    for (const moduleId of requireCertifiedModuleOwners(file)) {
      const row = owned.get(moduleId) ?? { files: new Set<string>(), repoId: file.repoId };
      row.files.add(qualifyMainCertifiedPath(file));
      owned.set(moduleId, row);
    }
  }
  return [...owned.entries()]
    .map(([moduleId, row]) => ({
      moduleId,
      moduleName: moduleId.replace(/^module:/, '').replace(/^repo:/, ''),
      ownedFiles: [...row.files].sort(),
      repoId: row.repoId,
    }))
    .sort((left, right) => left.moduleId.localeCompare(right.moduleId));
}

function certifiedFileToGenerateEntry(
  file: MainCertifiedSourceFile,
  projectRoot: string
): GenerateFileEntry {
  const relativePath = qualifyMainCertifiedPath(file);
  const absolutePath = path.resolve(projectRoot, relativePath);
  assertContainedCertifiedPath(projectRoot, absolutePath);
  return {
    content: Buffer.from(file.contentBase64, 'base64').toString('utf8'),
    name: path.posix.basename(file.relativePath),
    path: absolutePath,
    relativePath,
    targetName: file.moduleIds[0]?.replace(/^module:/, '') ?? file.repoId,
  };
}

function certifiedModuleToWorkflowModule(module: MainCertifiedModule): ProjectContextModule {
  return {
    kind: 'certified-module',
    moduleId: module.moduleId,
    moduleName: module.moduleName,
    modulePath: module.ownedFiles[0] ? path.posix.dirname(module.ownedFiles[0]) : '.',
    ownedFileCount: module.ownedFiles.length,
    ownedFiles: [...module.ownedFiles],
    role: 'certified-module',
  };
}

function presenterInputFromProjection(
  projection: MainCertifiedProjectionPayload
): ProjectContextPresenterInput {
  return buildProjectContextPresenterInput(projection.envelopes);
}

function isProjectContextEnvelope(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.queryLevel === 'string' && 'data' in record;
}

function requireCertifiedState(
  facts: ProjectContextWorkflowFacts
): MainCertifiedProjectFactsCarrier {
  const state = facts.certifiedProjectFacts;
  if (!state) {
    throw new TypeError('Strict workflow facts are missing their certified binding.');
  }
  assertMainCertifiedProjectFactsCarrier(state);
  return state;
}

function countLanguages(files: readonly MainCertifiedSourceFile[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of files) {
    counts[file.language] = (counts[file.language] ?? 0) + 1;
  }
  return counts;
}

function primaryLanguage(counts: Record<string, number>): string {
  return (
    Object.entries(counts).sort(
      ([leftName, leftCount], [rightName, rightCount]) =>
        rightCount - leftCount || leftName.localeCompare(rightName)
    )[0]?.[0] ?? 'unknown'
  );
}

export function qualifyMainCertifiedPath(
  file: Pick<MainCertifiedSourceFile, 'relativePath' | 'repositoryRelativeRoot'>
) {
  return file.repositoryRelativeRoot === '.'
    ? file.relativePath
    : path.posix.join(file.repositoryRelativeRoot, file.relativePath);
}

function emptyCompatibilityProjections() {
  return Object.fromEntries(
    [
      'plan',
      'recipe-generation',
      'dependency-graph',
      'module-coverage',
      'dimension-completion',
    ].map((consumer) => [consumer, { consumer, strictAdapterRequired: true }])
  ) as Record<CertifiedProjectFactsConsumer, unknown>;
}

function mainStrictLegacyEntryInventory(
  source: CaptureMainCertifiedProjectFactsInput['source'],
  instrumentation: readonly MainCertifiedProjectFactsInstrumentationEvent[]
): ProjectContextLegacyEntryAuditRowV1[] {
  const counters = summarizeMainCertifiedInstrumentation(instrumentation);
  if (
    counters.directProjectContextCallCount !== 0 ||
    counters.rawFilesystemFallbackCount !== 0 ||
    counters.synthesizedProjectScopeFactCount !== 0
  ) {
    throw new TypeError('Strict capture observed a reachable legacy ProjectContext route.');
  }
  const unreachable = (entryId: string, entrypoint: string, typedReason: string) => ({
    directProjectContextCallCount: counters.directProjectContextCallCount,
    entryId,
    entrypoint,
    rawFilesystemFallbackCount: counters.rawFilesystemFallbackCount,
    reachability: 'unreachable' as const,
    synthesizedProjectScopeFactCount: counters.synthesizedProjectScopeFactCount,
    typedReason: `${typedReason};instrumentation-events=${instrumentation.length}`,
  });
  return [
    unreachable(
      'main-workflow-direct-project-context',
      'lib/project-facts/ProjectContextWorkflowFacts.ts',
      'strict-entry-branches-to-certified-capture-before-legacy-request-code'
    ),
    unreachable(
      'main-plan-raw-collector',
      'lib/recipe-pipeline/plan/PlanSelectionGate.ts',
      'plan-is-projected-from-the-certified-artifact'
    ),
    unreachable(
      'main-consumer-direct-project-context',
      'lib/project-facts/ProjectContextConsumerFacts.ts',
      'strict-consumers-use-named-certified-projections'
    ),
    unreachable(
      'main-project-map-live-scan',
      'lib/project-facts/ProjectMapModules.ts',
      'strict-module-coverage-is-complete-and-artifact-derived'
    ),
    unreachable(
      'main-ai-dimension-direct-graph',
      'lib/recipe-pipeline/generate/execution/AiDimensionPreparation.ts',
      'strict-ai-preparation-requires-the-certified-dependency-projection'
    ),
    unreachable(
      'main-module-service-live-fallback',
      'lib/service/module/ModuleService.ts',
      'certified-session-carrier-disables-repo-map-and-filesystem-fallbacks'
    ),
    unreachable(
      'main-incremental-rescan-strict-coldstart',
      'lib/recipe-pipeline/generate/incremental/IncrementalRescanWorkflow.ts',
      source === 'alembic-main-bootstrap'
        ? 'typed-not-applicable-to-the-strict-coldstart-entry'
        : 'strict-plan-gate-does-not-enter-the-separate-incremental-rescan-workflow'
    ),
    {
      directProjectContextCallCount: counters.directProjectContextCallCount,
      entryId: 'main-certified-production-adapters',
      entrypoint: Object.values(MAIN_CERTIFIED_PROJECT_FACTS_ENTRYPOINTS).join(','),
      rawFilesystemFallbackCount: counters.rawFilesystemFallbackCount,
      reachability: 'artifact-only-adapter',
      synthesizedProjectScopeFactCount: counters.synthesizedProjectScopeFactCount,
      typedReason:
        'four-actual-main-entrypoints-independently-reopen-one-persisted-artifact;' +
        `instrumentation-events=${instrumentation.length}`,
    },
  ];
}

function assertSameCertifiedBase(
  expected: CertifiedProjectFactsArtifactV1,
  actual: CertifiedProjectFactsArtifactV1
) {
  if (
    expected.artifactId !== actual.artifactId ||
    expected.sourceVectorHash !== actual.sourceVectorHash ||
    expected.factsContentHash !== actual.factsContentHash ||
    expected.certificationBindingHash !== actual.certificationBindingHash
  ) {
    throw new TypeError('Certified artifact base changed after persisted readback.');
  }
}

function assertSameCertifiedCarrierBase(
  carrier: MainCertifiedProjectFactsCarrier,
  artifact: CertifiedProjectFactsArtifactV1
) {
  if (
    carrier.artifactId !== artifact.artifactId ||
    carrier.sourceVectorHash !== artifact.sourceVectorHash ||
    carrier.factsContentHash !== artifact.factsContentHash ||
    carrier.certificationBindingHash !== artifact.certificationBindingHash ||
    carrier.canonicalScopeHash !==
      (artifact.manifest.projectScopeManifest?.canonicalScopeHash ??
        artifact.certification.scopeIdentityHash)
  ) {
    throw new TypeError('Certified artifact does not match its persisted carrier binding.');
  }
}

function assertMainCertifiedProjection(
  carrier: MainCertifiedProjectFactsCarrier,
  consumer: (typeof MAIN_CERTIFIED_CONSUMERS)[number],
  projection: MainCertifiedProjectionPayload,
  receipt: ProjectContextConsumerProjectionReceiptV2
) {
  verifyProjectContextConsumerProjectionReceiptV2(receipt);
  if (
    projection.consumer !== consumer ||
    projection.canonicalScopeHash !== carrier.canonicalScopeHash ||
    receipt.consumer !== consumer ||
    receipt.artifactId !== carrier.artifactId ||
    receipt.sourceVectorHash !== carrier.sourceVectorHash ||
    receipt.factsContentHash !== carrier.factsContentHash ||
    receipt.certificationBindingHash !== carrier.certificationBindingHash ||
    receipt.projectionContentHash !== hashCanonicalJson(projection)
  ) {
    throw new TypeError(`Certified ${consumer} projection has a stale persisted binding.`);
  }
}

function expectedOwnerModuleCount(files: readonly MainCertifiedSourceFile[]): number {
  return new Set(files.flatMap((file) => [...requireCertifiedModuleOwners(file)])).size;
}

function requireCertifiedModuleOwners(file: MainCertifiedSourceFile): readonly string[] {
  if (file.moduleIds.length === 0) {
    throw new TypeError(
      `Certified eligible source ${file.repoId}/${file.relativePath} has no module owner.`
    );
  }
  return file.moduleIds;
}

function requireRepositoryRelativeRoot(
  relativeRoots: ReadonlyMap<string, string>,
  repoId: string
): string {
  const relativeRoot = relativeRoots.get(repoId);
  if (relativeRoot === undefined) {
    throw new TypeError(`Certified inventory repository is absent from ProjectScope: ${repoId}.`);
  }
  return portableRelativeRoot(relativeRoot);
}

function mainCertifiedStoreRoot(dataRoot: string): string {
  return path.join(dataRoot, 'context', 'certified-project-facts', 'v2');
}

function inventoryPolicyForScope(
  repositories: readonly { relativeRoot: string }[]
): ProjectContextInventoryPolicyV1 {
  const nestedRoots = repositories
    .map((repository) => repository.relativeRoot)
    .filter((relativeRoot) => relativeRoot !== '.')
    .sort();
  return {
    ...INVENTORY_POLICY,
    excludeDirectories: [...INVENTORY_POLICY.excludeDirectories],
    includeExtensions: [...INVENTORY_POLICY.includeExtensions],
    ...(repositories.some((repository) => repository.relativeRoot === '.') && nestedRoots.length
      ? { excludeRelativePaths: nestedRoots }
      : {}),
  };
}

function assertContainedCertifiedPath(controlRoot: string, candidate: string) {
  const root = path.resolve(controlRoot);
  const absolute = path.resolve(candidate);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new TypeError('Certified projected source path escapes its accepted control root.');
  }
}

function portableRelativeRoot(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  if (!normalized || normalized === '.') {
    return '.';
  }
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new TypeError('ProjectScope folder escapes its accepted control root.');
  }
  return normalized;
}

function opaqueId(value: string): string {
  const normalized = value
    .trim()
    .replace(/[\\/\s]+/g, '-')
    .replace(/[^a-zA-Z0-9_.:-]/g, '-');
  return normalized || 'project';
}

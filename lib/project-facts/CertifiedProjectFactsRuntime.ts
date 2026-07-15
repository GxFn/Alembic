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

export const MAIN_CERTIFIED_PROJECT_FACTS_ADAPTER_ENTRYPOINT =
  'lib/project-facts/CertifiedProjectFactsRuntime.js';
export const MAIN_CERTIFIED_PROJECT_FACTS_ADAPTER_VERSION = 'alembic-main-pcf-adapters-v1';

const MAIN_CERTIFIED_CONSUMERS = [
  'plan',
  'recipe-generation',
  'dependency-graph',
  'module-coverage',
] as const satisfies readonly CertifiedProjectFactsConsumer[];

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

export interface MainCertifiedProjectFactsCarrier {
  artifactId: string;
  canonicalScopeHash: string;
  certificationBindingHash: string;
  counters: MainCertifiedProjectFactsCounters;
  factsContentHash: string;
  preparationId: string;
  projections: Record<string, MainCertifiedProjectionPayload>;
  receipts: Record<string, ProjectContextConsumerProjectionReceiptV2>;
  runId: string;
  sourceVectorHash: string;
}

export interface MainCertifiedProjectFactsState extends MainCertifiedProjectFactsCarrier {
  baseReadbackUnchanged: true;
  preparationReceiptHash: string;
  storeReceiptHash: string;
}

interface CaptureMainCertifiedProjectFactsInput {
  analysisScope?: ProjectScopeAnalysisContext;
  dimensions: DimensionDef[];
  projectRoot: string;
  source: 'alembic-main-bootstrap' | 'alembic-main-rescan';
}

export async function captureMainCertifiedProjectFacts(
  input: CaptureMainCertifiedProjectFactsInput
): Promise<MainCertifiedProjectFactsState> {
  const scope = createMainScopeBinding(input);
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
        policy: INVENTORY_POLICY,
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
        acceptedConfigHash: hashCanonicalJson({ inventoryPolicy: INVENTORY_POLICY }),
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
      inventoryPolicy: INVENTORY_POLICY,
      legacyEntries: mainStrictLegacyEntryInventory(input.source),
      projectMode: scope.manifest.projectMode,
      projectScope: scope,
      projections: emptyCompatibilityProjections(),
      repositories: scope.repositories,
      requestMatrix,
      requestPlans: requestMatrix.plans,
    },
    ports
  );

  const storeRoot = path.join(
    input.analysisScope?.dataRoot ?? input.projectRoot,
    'context',
    'certified-project-facts',
    'v2'
  );
  const store = new FileCertifiedProjectFactsStore(storeRoot);
  const storeReceipt = await store.put(artifact);
  const reopenedStore = new FileCertifiedProjectFactsStore(storeRoot);
  const reopened = await reopenedStore.open(artifact.artifactId, artifact.certificationBindingHash);
  assertSameCertifiedBase(artifact, reopened);
  const preparation = await reopenedStore.createPreparation(
    reopened.artifactId,
    reopened.certificationBindingHash
  );
  const runId = `main-${input.source === 'alembic-main-bootstrap' ? 'coldstart' : 'rescan'}`;
  const consumerPort = new CertifiedProjectFactsConsumerPort(reopenedStore);
  const projections = {} as Record<string, MainCertifiedProjectionPayload>;
  const receipts = {} as Record<string, ProjectContextConsumerProjectionReceiptV2>;
  for (const consumer of MAIN_CERTIFIED_CONSUMERS) {
    const projected = await consumerPort.reopenWithAdapter({
      adapter: mainConsumerAdapter(consumer),
      consumer,
      expectedCertificationBindingHash: reopened.certificationBindingHash,
      preparationId: preparation.preparationId,
      runId,
    });
    projections[consumer] = projected.payload as unknown as MainCertifiedProjectionPayload;
    receipts[consumer] = projected.receipt;
  }
  await reopenedStore.completeRunLease({
    expectedCertificationBindingHash: reopened.certificationBindingHash,
    preparationId: preparation.preparationId,
    runId,
  });
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
    counters: zeroMainCertifiedCounters(),
    factsContentHash: artifact.factsContentHash,
    preparationId: preparation.preparationId,
    preparationReceiptHash: preparation.receiptHash,
    projections,
    receipts,
    runId,
    sourceVectorHash: artifact.sourceVectorHash,
    storeReceiptHash: storeReceipt.receiptHash,
  };
  assertMainCertifiedProjectFactsCarrier(state);
  return state;
}

export function buildStrictProjectContextWorkflowFacts(input: {
  certified: MainCertifiedProjectFactsState;
  dimensions: DimensionDef[];
  projectRoot: string;
  source: 'alembic-main-bootstrap' | 'alembic-main-rescan';
}): ProjectContextWorkflowFacts {
  assertMainCertifiedProjectFactsCarrier(input.certified);
  const recipe = requireProjection(input.certified, 'recipe-generation');
  const modulesProjection = requireProjection(input.certified, 'module-coverage');
  const allFiles = recipe.files.map((file) =>
    certifiedFileToGenerateEntry(file, input.projectRoot)
  );
  const modules = modulesProjection.modules.map(certifiedModuleToWorkflowModule);
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
  facts: ProjectContextWorkflowFacts
): PlanProjectContextAnalysis {
  const certified = requireCertifiedState(facts);
  const plan = requireProjection(certified, 'plan');
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
      filePath: qualifyCertifiedPath(file),
      language: file.language,
      sizeBytes: file.byteLength,
    })),
    understandingGaps: [],
  };
}

export function dependencyGraphFromCertifiedFacts(
  facts: ProjectContextWorkflowFacts
): ProjectContextDependencyGraph {
  const certified = requireCertifiedState(facts);
  const projection = requireProjection(certified, 'dependency-graph');
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
  state: MainCertifiedProjectFactsState
): MainCertifiedProjectFactsCarrier {
  assertMainCertifiedProjectFactsCarrier(state);
  return {
    artifactId: state.artifactId,
    canonicalScopeHash: state.canonicalScopeHash,
    certificationBindingHash: state.certificationBindingHash,
    counters: { ...state.counters },
    factsContentHash: state.factsContentHash,
    preparationId: state.preparationId,
    projections: structuredClone(state.projections),
    receipts: structuredClone(state.receipts),
    runId: state.runId,
    sourceVectorHash: state.sourceVectorHash,
  };
}

export function assertMainCertifiedProjectFactsCarrier(
  value: unknown
): asserts value is MainCertifiedProjectFactsCarrier {
  const carrier = value as MainCertifiedProjectFactsCarrier;
  if (!carrier || typeof carrier !== 'object') {
    throw new TypeError('Certified project facts carrier is missing.');
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
  for (const consumer of MAIN_CERTIFIED_CONSUMERS) {
    const receipt = carrier.receipts?.[consumer];
    const projection = carrier.projections?.[consumer];
    if (!receipt || !projection || receipt.consumer !== consumer) {
      throw new TypeError(`Certified project facts carrier is missing ${consumer}.`);
    }
    verifyProjectContextConsumerProjectionReceiptV2(receipt);
    if (
      receipt.artifactId !== carrier.artifactId ||
      receipt.sourceVectorHash !== carrier.sourceVectorHash ||
      receipt.factsContentHash !== carrier.factsContentHash ||
      receipt.certificationBindingHash !== carrier.certificationBindingHash ||
      receipt.runId !== carrier.runId ||
      projection.canonicalScopeHash !== carrier.canonicalScopeHash ||
      projection.consumer !== consumer ||
      receipt.projectionContentHash !== hashCanonicalJson(projection)
    ) {
      throw new TypeError(`Certified project facts carrier has a stale ${consumer} binding.`);
    }
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(carrier.canonicalScopeHash)) {
    throw new TypeError('Certified project facts carrier has a scope binding mismatch.');
  }
  if (!carrier.counters || Object.values(carrier.counters).some((count) => count !== 0)) {
    throw new TypeError('Strict certified consumer counters must remain zero.');
  }
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

function createMainScopeBinding(input: CaptureMainCertifiedProjectFactsInput) {
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

function mainConsumerAdapter(consumer: (typeof MAIN_CERTIFIED_CONSUMERS)[number]) {
  return {
    adapterVersion: MAIN_CERTIFIED_PROJECT_FACTS_ADAPTER_VERSION,
    entrypoint: MAIN_CERTIFIED_PROJECT_FACTS_ADAPTER_ENTRYPOINT,
    loadEvidenceHash: hashCanonicalJson({
      entrypoint: MAIN_CERTIFIED_PROJECT_FACTS_ADAPTER_ENTRYPOINT,
      implementation: MAIN_CERTIFIED_PROJECT_FACTS_ADAPTER_VERSION,
      loaded: true,
    }),
    payloadSchemaHash: hashCanonicalJson({ consumer, schema: 1 }),
    project: (artifact: Readonly<CertifiedProjectFactsArtifactV1>) =>
      projectMainConsumerPayload(artifact as CertifiedProjectFactsArtifactV1, consumer),
  };
}

function projectMainConsumerPayload(
  artifact: CertifiedProjectFactsArtifactV1,
  consumer: (typeof MAIN_CERTIFIED_CONSUMERS)[number]
): MainCertifiedProjectionPayload {
  const files = artifact.facts.inventory.files.map((file) => ({
    blobHash: file.blobSha256,
    byteLength: file.sizeBytes,
    contentBase64: readCertifiedProjectFactsFrozenFile(artifact, file).toString('base64'),
    language: file.language,
    moduleIds: [...file.ownerModuleIds].sort(),
    relativePath: file.relativePath,
    repoId: file.repoId,
  }));
  const modules = buildCertifiedModules(files);
  const envelopes = artifact.facts.requestOutcomes
    .filter(
      (outcome) => outcome.applicability === 'applicable' && outcome.terminalStatus === 'completed'
    )
    .map((outcome) => outcome.output)
    .filter(isProjectContextEnvelope) as unknown as ProjectContextEnvelope<ProjectContextResult>[];
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
  if (consumer === 'dependency-graph') {
    payload.dependencyGraph = buildCertifiedDependencyGraph(artifact, modules);
  }
  return payload;
}

function buildCertifiedDependencyGraph(
  artifact: CertifiedProjectFactsArtifactV1,
  modules: MainCertifiedModule[]
): MainCertifiedProjectionPayload['dependencyGraph'] {
  const declaredEdges = artifact.facts.requestOutcomes.flatMap((outcome) =>
    collectDeclaredEdges(outcome.output)
  );
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
    if (
      typeof record.from === 'string' &&
      typeof record.to === 'string' &&
      (typeof record.type === 'string' || record.type === undefined)
    ) {
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
    const moduleIds = file.moduleIds.length ? file.moduleIds : [`repo:${file.repoId}`];
    for (const moduleId of moduleIds) {
      const row = owned.get(moduleId) ?? { files: new Set<string>(), repoId: file.repoId };
      row.files.add(qualifyCertifiedPath(file));
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
  const relativePath = qualifyCertifiedPath(file);
  return {
    content: Buffer.from(file.contentBase64, 'base64').toString('utf8'),
    name: path.posix.basename(file.relativePath),
    path: path.resolve(projectRoot, relativePath),
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
  try {
    return buildProjectContextPresenterInput(projection.envelopes);
  } catch {
    return buildProjectContextPresenterInput([]);
  }
}

function isProjectContextEnvelope(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.queryLevel === 'string' && 'data' in record;
}

function requireCertifiedState(facts: ProjectContextWorkflowFacts): MainCertifiedProjectFactsState {
  const state = facts.certifiedProjectFacts;
  if (!state) {
    throw new TypeError('Strict workflow facts are missing their certified binding.');
  }
  assertMainCertifiedProjectFactsCarrier(state);
  return state;
}

function requireProjection(
  carrier: MainCertifiedProjectFactsCarrier,
  consumer: (typeof MAIN_CERTIFIED_CONSUMERS)[number]
): MainCertifiedProjectionPayload {
  const projection = carrier.projections[consumer];
  if (!projection) {
    throw new TypeError(`Certified projection is unavailable: ${consumer}.`);
  }
  return projection;
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

function qualifyCertifiedPath(file: Pick<MainCertifiedSourceFile, 'repoId' | 'relativePath'>) {
  return `${file.repoId}/${file.relativePath}`;
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

function zeroMainCertifiedCounters(): MainCertifiedProjectFactsCounters {
  return {
    cappedModuleProjectionCount: 0,
    directProjectContextCallCount: 0,
    rawFilesystemFallbackCount: 0,
    synthesizedProjectScopeFactCount: 0,
  };
}

function mainStrictLegacyEntryInventory(
  source: CaptureMainCertifiedProjectFactsInput['source']
): ProjectContextLegacyEntryAuditRowV1[] {
  const unreachable = (entryId: string, entrypoint: string, typedReason: string) => ({
    directProjectContextCallCount: 0,
    entryId,
    entrypoint,
    rawFilesystemFallbackCount: 0,
    reachability: 'unreachable' as const,
    synthesizedProjectScopeFactCount: 0,
    typedReason,
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
      directProjectContextCallCount: 0,
      entryId: 'main-certified-production-adapters',
      entrypoint: MAIN_CERTIFIED_PROJECT_FACTS_ADAPTER_ENTRYPOINT,
      rawFilesystemFallbackCount: 0,
      reachability: 'artifact-only-adapter',
      synthesizedProjectScopeFactCount: 0,
      typedReason: 'four-main-consumers-reopen-one-persisted-certified-artifact',
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

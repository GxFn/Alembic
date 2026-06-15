import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  DimensionCopy,
  resolveActiveDimensions,
  type UnifiedDimension,
} from '@alembic/core/dimensions';
import {
  type AnchorRangeContext,
  ProjectContext as DefaultProjectContext,
  type FileFlowContext,
  type FileSymbolContext,
  type ModuleContext,
  type ModuleLayerContext,
  type ProjectContextContract,
  type ProjectContextEnvelope,
  type ProjectContextQueryError,
  type ProjectContextRef,
  type ProjectContextRequest,
  type ProjectContextRequestKind,
  type ProjectContextResult,
  type ProjectMap,
  type RepoContext,
  type SourceSliceContext,
  type SpaceContext,
} from '@alembic/core/project-context';
import type {
  BootstrapFile,
  DimensionDef,
  IncrementalPlan,
  SnapshotFile,
  SnapshotTarget,
} from '@alembic/core/types';

export const AGENT_PROJECT_CONTEXT_MAPPED_ROUTES = [
  'space',
  'repo',
  'map',
  'module',
  'module-layers',
  'source-slice',
  'file-symbols',
  'file-flow',
  'anchor-range',
] as const satisfies readonly ProjectContextRequestKind[];

const DEFAULT_MAX_FILES = 500;
const DEFAULT_CONTENT_MAX_LINES = 120;
const FLOW_CONTEXT_FILE_LIMIT = 80;
const MODULE_CONTEXT_LIMIT = 12;
const MAX_SOURCE_FILE_BYTES = 1_000_000;

const ALWAYS_EXCLUDED_DIRS = new Set([
  '.asd',
  '.git',
  '.next',
  '.nuxt',
  '.turbo',
  '.workspace-active',
  '.workspace-local',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'runtime',
  'scratch',
  'tmp',
]);

const VENDOR_DIRS = new Set(['vendor', 'vendors', 'third_party', 'third-party']);
const GENERATED_DIRS = new Set(['generated', '__generated__', '.generated']);
const SOURCE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.css',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.kt',
  '.m',
  '.md',
  '.mm',
  '.mjs',
  '.py',
  '.rb',
  '.rs',
  '.scss',
  '.sh',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.vue',
  '.xml',
  '.yaml',
  '.yml',
]);

const SOURCE_FILE_BASENAMES = new Set([
  'biome.json',
  'Cargo.toml',
  'go.mod',
  'package.json',
  'Package.swift',
  'pyproject.toml',
  'tsconfig.json',
  'vite.config.ts',
  'vitest.config.ts',
]);

export interface AgentProjectContextLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

export interface AgentProjectContextContainer {
  get?(name: string): unknown;
  resolve?(name: string): unknown;
}

export interface AgentProjectContextRunContext {
  container?: AgentProjectContextContainer;
  db?: unknown;
  logger: AgentProjectContextLogger;
}

export interface AgentProjectContextPrepareOptions {
  clearOldData?: boolean;
  dataRoot?: string;
}

export interface AgentProjectContextScanOptions {
  contentMaxLines?: number;
  generateAstContext?: boolean;
  generateReport?: boolean;
  includeGenerated?: boolean;
  includeVendor?: boolean;
  incremental?: boolean;
  maxFiles?: number;
  projectScope?: AgentProjectScope | null;
  skipGuard?: boolean;
  sourceTag?: string;
}

export interface AgentProjectScopeFolder {
  displayName?: string | null;
  id?: string | null;
  path: string;
  repositoryId?: string | null;
  role?: string | null;
}

export interface AgentProjectScope {
  controlRoot?: { path?: string } | null;
  currentFolderId?: string | null;
  folders: AgentProjectScopeFolder[];
  projectScopeId?: string | null;
}

export interface AgentProjectContextAnalysisScope {
  projectScope?: AgentProjectScope | null;
  projectScopeId?: string | null;
}

export interface AgentProjectContextAnalysisInput {
  analysisScope?: AgentProjectContextAnalysisScope;
  ctx: AgentProjectContextRunContext;
  materialize?: unknown;
  prepare?: AgentProjectContextPrepareOptions;
  projectContext?: ProjectContextContract;
  projectRoot: string;
  scan?: AgentProjectContextScanOptions;
  sourceTag?: string;
}

export interface AgentProjectContextAnalysisResult {
  activeDimensions: DimensionDef[];
  allFiles: SnapshotFile[];
  allTargets: SnapshotTarget[];
  astContext: string | null;
  astProjectSummary: Record<string, unknown> | null;
  callGraphResult: Record<string, unknown> | null;
  codeEntityResult: Record<string, unknown> | null;
  depEdgesWritten: number;
  depGraphData: { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };
  detectedFrameworks: string[];
  discoverer: { id: string; displayName: string };
  enhancementGuardRules: unknown[];
  enhancementPackInfo: unknown[];
  enhancementPatterns: Array<Record<string, unknown>>;
  guardAudit: null;
  guardEngine: null;
  incrementalPlan: IncrementalPlan | null;
  isEmpty: boolean;
  langProfile: Record<string, unknown>;
  langStats: Record<string, number>;
  localPackageModules: Array<Record<string, unknown>>;
  panoramaResult: Record<string, unknown> | null;
  primaryLang: string | null;
  report: Record<string, unknown>;
  sourceGraphResult: null;
  targetsSummary: SnapshotTarget[];
  truncated: boolean;
  warnings: string[];
}

interface RepoRouteScope {
  displayName: string;
  folder: AgentProjectScopeFolder | null;
  repoId?: string;
  sourceFolder: string;
}

interface AnalyzedRepo {
  context: RepoContext;
  projectRoot: string;
  scope: RepoRouteScope;
}

interface AnalyzedSourceFile {
  absolutePath: string;
  context: SourceSliceContext;
  repo: AnalyzedRepo;
  repoRelativePath: string;
  snapshotFile: SnapshotFile;
}

interface ProjectContextUnavailableData {
  available: false;
  kind: string;
  nextRefs: ProjectContextRef[];
  reason: string;
}

interface QueryTrace {
  errorCount: number;
  kind: ProjectContextRequestKind;
  ms: number;
  refCount: number;
  unavailableReason?: string;
}

interface QueryRuntime {
  projectContext: ProjectContextContract;
  projectRoot: string;
  scan: Required<
    Pick<
      AgentProjectContextScanOptions,
      'contentMaxLines' | 'includeGenerated' | 'includeVendor' | 'maxFiles'
    >
  > &
    AgentProjectContextScanOptions;
  traces: QueryTrace[];
  warnings: string[];
}

interface SourceFolderSummary {
  displayName?: string;
  path: string;
  repositoryId?: string;
}

export async function runAgentProjectContextAnalysis({
  analysisScope,
  ctx,
  materialize,
  prepare,
  projectContext = DefaultProjectContext,
  projectRoot,
  scan,
  sourceTag,
}: AgentProjectContextAnalysisInput): Promise<AgentProjectContextAnalysisResult> {
  const startedAt = Date.now();
  const normalizedProjectRoot = path.resolve(projectRoot);
  const warnings: string[] = [];
  const traces: QueryTrace[] = [];
  const normalizedScan = normalizeScanOptions(scan);

  if (prepare?.clearOldData) {
    ctx.logger.info(
      '[AgentProjectContextAnalysis] clearOldData is handled by the host workflow cleanup policy',
      { dataRoot: prepare.dataRoot ?? null }
    );
  }
  if (materialize && hasMaterializationRequest(materialize)) {
    warnings.push(
      'ProjectContext route does not materialize legacy project-intelligence side effects; durable writes remain host-owned.'
    );
  }

  const runtime: QueryRuntime = {
    projectContext,
    projectRoot: normalizedProjectRoot,
    scan: normalizedScan,
    traces,
    warnings,
  };

  const spaceEnvelope = await executeProjectContext<SpaceContext>(runtime, {
    kind: 'space',
    payload: {
      includeProjectTree: normalizedScan.generateReport === true,
      includeStructuralHotspots: true,
    },
    scope: {
      includeGenerated: normalizedScan.includeGenerated,
      includeVendor: normalizedScan.includeVendor,
      projectRoot: normalizedProjectRoot,
    },
  });
  const space = spaceEnvelope && isSpaceContext(spaceEnvelope.data) ? spaceEnvelope.data : null;
  const repoScopes = resolveRepoRouteScopes({
    analysisScope,
    projectRoot: normalizedProjectRoot,
    scan: normalizedScan,
    space,
  });

  const repos: AnalyzedRepo[] = [];
  const allTargets: SnapshotTarget[] = [];
  const localPackageModules: Array<Record<string, unknown>> = [];
  const mapContexts: ProjectMap[] = [];
  const moduleContexts: ModuleContext[] = [];
  const moduleLayerContexts: ModuleLayerContext[] = [];
  const detectedFrameworks = new Set<string>();

  for (const repoScope of repoScopes) {
    const repoEnvelope = await executeProjectContext<RepoContext>(runtime, {
      kind: 'repo',
      payload: {
        includeCommands: true,
        includeEntrypoints: true,
        includeMapSummary: true,
        includeTopAreas: true,
        maxFiles: normalizedScan.maxFiles,
        repoName: repoScope.displayName,
        repoRoot: repoScope.sourceFolder,
      },
      scope: createProjectContextScope(normalizedProjectRoot, repoScope, normalizedScan),
    });
    if (!repoEnvelope || !isRepoContext(repoEnvelope.data)) {
      continue;
    }

    const repo: AnalyzedRepo = {
      context: repoEnvelope.data,
      projectRoot: normalizedProjectRoot,
      scope: repoScope,
    };
    repos.push(repo);
    allTargets.push(...createSnapshotTargets(repoEnvelope.data));
    collectDetectedFrameworks(repoEnvelope.data, detectedFrameworks);
    localPackageModules.push(...createLocalPackageModules(repoEnvelope.data));

    const moduleSeeds = createModuleSeeds(repoEnvelope.data);
    for (const seed of moduleSeeds.slice(0, MODULE_CONTEXT_LIMIT)) {
      const moduleEnvelope = await executeProjectContext<ModuleContext>(runtime, {
        kind: 'module',
        payload: {
          ...seed,
          includeDependencies: true,
          includePublicSurfaces: true,
        },
        scope: createProjectContextScope(normalizedProjectRoot, repoScope, normalizedScan),
      });
      if (moduleEnvelope && isModuleContext(moduleEnvelope.data)) {
        moduleContexts.push(moduleEnvelope.data);
      }

      const moduleLayersEnvelope = await executeProjectContext<ModuleLayerContext>(runtime, {
        kind: 'module-layers',
        payload: {
          ...seed,
          includeBoundaryCrossings: true,
        },
        scope: createProjectContextScope(normalizedProjectRoot, repoScope, normalizedScan),
      });
      if (moduleLayersEnvelope && isModuleLayerContext(moduleLayersEnvelope.data)) {
        moduleLayerContexts.push(moduleLayersEnvelope.data);
      }
    }

    if (moduleSeeds.length > 0) {
      const mapEnvelope = await executeProjectContext<ProjectMap>(runtime, {
        kind: 'map',
        payload: {
          includeCycles: true,
          includeExternalDeps: true,
          includeHotspots: true,
          includeMajorFlows: true,
          moduleSeeds,
          repoName: repoEnvelope.data.repo.name,
        },
        scope: createProjectContextScope(normalizedProjectRoot, repoScope, normalizedScan),
      });
      if (mapEnvelope && isProjectMap(mapEnvelope.data)) {
        mapContexts.push(mapEnvelope.data);
      }
    }
  }

  const sourceFiles = await collectAnalyzedSourceFiles({
    repos,
    runtime,
  });
  const symbolContexts: FileSymbolContext[] = [];
  const flowContexts: FileFlowContext[] = [];
  const flowCandidates = sourceFiles.slice(0, FLOW_CONTEXT_FILE_LIMIT);
  for (const file of flowCandidates) {
    const symbolEnvelope = await executeProjectContext<FileSymbolContext>(runtime, {
      kind: 'file-symbols',
      payload: { filePath: file.context.file.filePath },
      scope: createProjectContextScope(normalizedProjectRoot, file.repo.scope, normalizedScan),
    });
    if (symbolEnvelope && isFileSymbolContext(symbolEnvelope.data)) {
      symbolContexts.push(symbolEnvelope.data);
    }

    const flowEnvelope = await executeProjectContext<FileFlowContext>(runtime, {
      kind: 'file-flow',
      payload: { filePath: file.context.file.filePath },
      scope: createProjectContextScope(normalizedProjectRoot, file.repo.scope, normalizedScan),
    });
    if (flowEnvelope && isFileFlowContext(flowEnvelope.data)) {
      flowContexts.push(flowEnvelope.data);
    }
  }

  const anchorCandidate = sourceFiles[0];
  if (anchorCandidate) {
    await executeProjectContext<AnchorRangeContext>(runtime, {
      kind: 'anchor-range',
      payload: {
        afterLines: 2,
        beforeLines: 2,
        filePath: anchorCandidate.context.file.filePath,
        includeContainingRefs: true,
        includeRelatedRefs: true,
        includeRelations: true,
        includeSourceSlices: true,
        includeSymbols: true,
        line: 1,
      },
      scope: createProjectContextScope(
        normalizedProjectRoot,
        anchorCandidate.repo.scope,
        normalizedScan
      ),
    });
  }

  const langStats = createLanguageStats(sourceFiles);
  const primaryLang = detectPrimaryLanguage(langStats);
  const langProfile = createLanguageProfile(langStats, primaryLang);
  const activeDimensions = createActiveDimensions(
    primaryLang,
    [...detectedFrameworks].sort(),
    langProfile.secondary as string[]
  );
  const incrementalPlan = await evaluateIncrementalPlan({
    activeDimensions,
    allFiles: sourceFiles.map((file) => file.snapshotFile),
    ctx,
    enabled: normalizedScan.incremental === true,
    projectRoot: normalizedProjectRoot,
    warnings,
  });
  const depGraphData = createDependencyGraph({
    flowContexts,
    mapContexts,
    moduleContexts,
    repos,
  });
  const astProjectSummary = createAstProjectSummary({
    sourceFiles,
    symbolContexts,
  });
  const report = createAnalysisReport({
    depGraphData,
    flowContexts,
    incrementalPlan,
    mapContexts,
    moduleContexts,
    moduleLayerContexts,
    repos,
    sourceFiles,
    sourceTag: sourceTag ?? normalizedScan.sourceTag ?? 'project-context',
    startedAt,
    symbolContexts,
    traces,
    warnings,
  });

  if (incrementalPlan && isRecord(report.phases)) {
    report.phases.incremental = { plan: incrementalPlan };
  }

  ctx.logger.info('[AgentProjectContextAnalysis] ProjectContext analysis complete', {
    files: sourceFiles.length,
    projectRoot: normalizedProjectRoot,
    routeCalls: traces.length,
    warnings: warnings.length,
  });

  return {
    activeDimensions,
    allFiles: sourceFiles.map((file) => file.snapshotFile),
    allTargets: dedupeTargets(allTargets),
    astContext: normalizedScan.generateAstContext ? createAstContext(symbolContexts) : null,
    astProjectSummary,
    callGraphResult: {
      durationMs: Date.now() - startedAt,
      edgesCreated: flowContexts.reduce(
        (sum, flow) => sum + flow.callers.length + flow.callees.length,
        0
      ),
      entitiesUpserted: symbolContexts.reduce((sum, context) => sum + context.symbols.length, 0),
    },
    codeEntityResult: {
      edgeCount: depGraphData.edges.length,
      entityCount: symbolContexts.reduce((sum, context) => sum + context.symbols.length, 0),
    },
    depEdgesWritten: depGraphData.edges.length,
    depGraphData,
    detectedFrameworks: [...detectedFrameworks].sort(),
    discoverer: { displayName: 'Core ProjectContext', id: 'project-context' },
    enhancementGuardRules: [],
    enhancementPackInfo: [],
    enhancementPatterns: [],
    guardAudit: null,
    guardEngine: null,
    incrementalPlan,
    isEmpty: sourceFiles.length === 0,
    langProfile,
    langStats,
    localPackageModules,
    panoramaResult: createPanoramaResult({ mapContexts, moduleContexts }),
    primaryLang,
    report,
    sourceGraphResult: null,
    targetsSummary: dedupeTargets(allTargets),
    truncated: sourceFiles.length >= normalizedScan.maxFiles,
    warnings,
  };
}

function normalizeScanOptions(
  scan: AgentProjectContextScanOptions | undefined
): Required<
  Pick<
    AgentProjectContextScanOptions,
    'contentMaxLines' | 'includeGenerated' | 'includeVendor' | 'maxFiles'
  >
> &
  AgentProjectContextScanOptions {
  return {
    ...(scan ?? {}),
    contentMaxLines: positiveInteger(scan?.contentMaxLines, DEFAULT_CONTENT_MAX_LINES),
    includeGenerated: scan?.includeGenerated === true,
    includeVendor: scan?.includeVendor === true,
    maxFiles: positiveInteger(scan?.maxFiles, DEFAULT_MAX_FILES),
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

function hasMaterializationRequest(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).some((item) => item !== false && item !== null && item !== undefined);
}

async function executeProjectContext<T extends ProjectContextResult>(
  runtime: QueryRuntime,
  request: ProjectContextRequest
): Promise<ProjectContextEnvelope<T> | null> {
  const startedAt = Date.now();
  try {
    const envelope = (await runtime.projectContext.execute(request)) as ProjectContextEnvelope<T>;
    const errors = envelope.errors ?? [];
    const unavailable = isUnavailableData(envelope.data) ? envelope.data : null;
    runtime.traces.push({
      errorCount: errors.length,
      kind: request.kind,
      ms: Date.now() - startedAt,
      refCount: envelope.refs.length,
      unavailableReason: unavailable?.reason,
    });
    for (const error of errors) {
      runtime.warnings.push(formatProjectContextError(request.kind, error));
    }
    if (unavailable) {
      runtime.warnings.push(`${request.kind} unavailable: ${unavailable.reason}`);
      return null;
    }
    return envelope;
  } catch (error) {
    runtime.traces.push({
      errorCount: 1,
      kind: request.kind,
      ms: Date.now() - startedAt,
      refCount: 0,
    });
    runtime.warnings.push(
      `${request.kind} failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

function formatProjectContextError(
  kind: ProjectContextRequestKind,
  error: ProjectContextQueryError
): string {
  const pathSuffix = error.path ? ` (${error.path})` : '';
  return `${kind} ${error.severity}: ${error.code}: ${error.message}${pathSuffix}`;
}

function resolveRepoRouteScopes(input: {
  analysisScope?: AgentProjectContextAnalysisScope;
  projectRoot: string;
  scan: AgentProjectContextScanOptions;
  space: SpaceContext | null;
}): RepoRouteScope[] {
  const projectScope = input.scan.projectScope ?? input.analysisScope?.projectScope ?? null;
  const fromProjectScope = projectScope?.folders
    .map((folder) => createRepoRouteScopeFromProjectScopeFolder(folder, input.projectRoot))
    .filter((scope): scope is RepoRouteScope => Boolean(scope));
  if (fromProjectScope && fromProjectScope.length > 0) {
    return dedupeRepoScopes(fromProjectScope);
  }

  const fromSpace = input.space?.sourceFolders
    .map((folder) => createRepoRouteScopeFromSourceFolder(folder, input.projectRoot))
    .filter((scope): scope is RepoRouteScope => Boolean(scope));
  if (fromSpace && fromSpace.length > 0) {
    return dedupeRepoScopes(fromSpace);
  }

  return [
    {
      displayName: path.basename(input.projectRoot) || 'project',
      folder: null,
      sourceFolder: '.',
    },
  ];
}

function createRepoRouteScopeFromProjectScopeFolder(
  folder: AgentProjectScopeFolder,
  projectRoot: string
): RepoRouteScope | null {
  const sourceFolder = toContainedRelativePath(projectRoot, folder.path);
  if (!sourceFolder) {
    return null;
  }
  return {
    displayName: folder.displayName || path.basename(folder.path) || sourceFolder,
    folder,
    repoId: folder.repositoryId ?? folder.id ?? undefined,
    sourceFolder,
  };
}

function createRepoRouteScopeFromSourceFolder(
  folder: SourceFolderSummary,
  projectRoot: string
): RepoRouteScope | null {
  const sourceFolder = toContainedRelativePath(projectRoot, folder.path);
  if (!sourceFolder) {
    return null;
  }
  return {
    displayName: folder.displayName || folder.repositoryId || path.basename(folder.path),
    folder: null,
    repoId: folder.repositoryId,
    sourceFolder,
  };
}

function toContainedRelativePath(projectRoot: string, candidatePath: string): string | null {
  const rawPath = candidatePath.trim();
  if (!rawPath) {
    return null;
  }
  const absolutePath = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(projectRoot, rawPath);
  const relativePath = path.relative(projectRoot, absolutePath);
  if (relativePath === '') {
    return '.';
  }
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }
  return toPosixPath(relativePath);
}

function dedupeRepoScopes(scopes: readonly RepoRouteScope[]): RepoRouteScope[] {
  return [
    ...new Map(
      scopes.map((scope) => [scope.sourceFolder === '' ? '.' : scope.sourceFolder, scope])
    ).values(),
  ].sort((left, right) => left.sourceFolder.localeCompare(right.sourceFolder));
}

function createProjectContextScope(
  projectRoot: string,
  repoScope: RepoRouteScope,
  scan: Pick<AgentProjectContextScanOptions, 'includeGenerated' | 'includeVendor'>
): ProjectContextRequest['scope'] {
  return {
    includeGenerated: scan.includeGenerated === true,
    includeVendor: scan.includeVendor === true,
    projectRoot,
    repoId: repoScope.repoId,
    sourceFolder: repoScope.sourceFolder === '.' ? undefined : repoScope.sourceFolder,
  };
}

function createSnapshotTargets(repo: RepoContext): SnapshotTarget[] {
  const targetSummaries = repo.targets.map((target) => ({
    fileCount: target.refs.length || undefined,
    name: target.name,
    type: target.kind,
  }));
  const packageTargets = repo.localPackages.map((item) => ({
    isLocalPackage: true,
    name: item.name,
    packageName: item.name,
  }));
  if (targetSummaries.length === 0 && packageTargets.length === 0) {
    return [{ name: repo.repo.name, type: 'repo' }];
  }
  return [...targetSummaries, ...packageTargets];
}

function collectDetectedFrameworks(repo: RepoContext, frameworks: Set<string>): void {
  for (const target of repo.targets) {
    const framework = readString((target as unknown as Record<string, unknown>).framework);
    if (framework) {
      frameworks.add(framework);
    }
  }
  for (const build of repo.buildSystems) {
    if (build.kind) {
      frameworks.add(build.kind);
    }
  }
}

function createLocalPackageModules(repo: RepoContext): Array<Record<string, unknown>> {
  return repo.localPackages.map((item) => ({
    fileCount: 0,
    inferredRole: 'local-package',
    keyFiles: item.ref?.scope.filePath ? [item.ref.scope.filePath] : [],
    name: item.name,
    packageName: item.name,
  }));
}

function createModuleSeeds(repo: RepoContext): Array<Record<string, unknown>> {
  const seeds = [
    ...repo.topAreas.map((area) => ({
      moduleName: area.role || path.basename(area.path),
      modulePath: area.path,
    })),
    ...repo.sourceRoots.map((root) => ({
      moduleName: root.role || path.basename(root.path),
      modulePath: root.path,
    })),
  ];
  return dedupeBy(seeds, (seed) => String(seed.modulePath)).sort((left, right) =>
    String(left.modulePath).localeCompare(String(right.modulePath))
  );
}

async function collectAnalyzedSourceFiles(input: {
  repos: readonly AnalyzedRepo[];
  runtime: QueryRuntime;
}): Promise<AnalyzedSourceFile[]> {
  const files: AnalyzedSourceFile[] = [];
  for (const repo of input.repos) {
    const remaining = input.runtime.scan.maxFiles - files.length;
    if (remaining <= 0) {
      break;
    }
    const candidates = await listSourceFileCandidates({
      projectRoot: input.runtime.projectRoot,
      repoScope: repo.scope,
      scan: input.runtime.scan,
      take: remaining,
      warnings: input.runtime.warnings,
    });
    for (const candidate of candidates) {
      if (files.length >= input.runtime.scan.maxFiles) {
        break;
      }
      const lineCount = await countFileLines(candidate.absolutePath, input.runtime.warnings);
      const sliceEnvelope = await executeProjectContext<SourceSliceContext>(input.runtime, {
        kind: 'source-slice',
        payload: {
          endLine: Math.min(input.runtime.scan.contentMaxLines, lineCount),
          filePath: candidate.projectRelativePath,
          includeText: true,
          startLine: 1,
        },
        scope: createProjectContextScope(input.runtime.projectRoot, repo.scope, input.runtime.scan),
      });
      if (!sliceEnvelope || !isSourceSliceContext(sliceEnvelope.data)) {
        continue;
      }
      files.push(
        createAnalyzedSourceFile({
          candidate,
          contentMaxLines: input.runtime.scan.contentMaxLines,
          repo,
          source: sliceEnvelope.data,
        })
      );
    }
  }
  return files.sort((left, right) =>
    left.snapshotFile.relativePath === right.snapshotFile.relativePath
      ? left.snapshotFile.path.localeCompare(right.snapshotFile.path)
      : left.snapshotFile.relativePath.localeCompare(right.snapshotFile.relativePath)
  );
}

interface SourceFileCandidate {
  absolutePath: string;
  projectRelativePath: string;
  repoRelativePath: string;
}

async function listSourceFileCandidates(input: {
  projectRoot: string;
  repoScope: RepoRouteScope;
  scan: Pick<AgentProjectContextScanOptions, 'includeGenerated' | 'includeVendor'>;
  take: number;
  warnings: string[];
}): Promise<SourceFileCandidate[]> {
  const repoRoot = path.resolve(input.projectRoot, input.repoScope.sourceFolder);
  const candidates: SourceFileCandidate[] = [];
  await walkSourceFiles({
    candidates,
    dir: repoRoot,
    projectRoot: input.projectRoot,
    repoRoot,
    scan: input.scan,
    take: input.take,
    warnings: input.warnings,
  });
  return candidates.sort((left, right) =>
    left.projectRelativePath.localeCompare(right.projectRelativePath)
  );
}

async function walkSourceFiles(input: {
  candidates: SourceFileCandidate[];
  dir: string;
  projectRoot: string;
  repoRoot: string;
  scan: Pick<AgentProjectContextScanOptions, 'includeGenerated' | 'includeVendor'>;
  take: number;
  warnings: string[];
}): Promise<void> {
  if (input.candidates.length >= input.take) {
    return;
  }
  let entries: Dirent[];
  try {
    entries = await fs.readdir(input.dir, { withFileTypes: true });
  } catch (error) {
    input.warnings.push(
      `source walk failed: ${toPosixPath(path.relative(input.projectRoot, input.dir))}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (input.candidates.length >= input.take) {
      return;
    }
    const absolutePath = path.join(input.dir, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDirectory(entry.name, input.scan)) {
        continue;
      }
      await walkSourceFiles({ ...input, dir: absolutePath });
      continue;
    }
    if (!entry.isFile() || !isSourceCandidate(entry.name)) {
      continue;
    }
    const stat = await fs.stat(absolutePath);
    if (stat.size > MAX_SOURCE_FILE_BYTES) {
      input.warnings.push(
        `source-slice skipped large file: ${toPosixPath(path.relative(input.projectRoot, absolutePath))}`
      );
      continue;
    }
    input.candidates.push({
      absolutePath,
      projectRelativePath: toPosixPath(path.relative(input.projectRoot, absolutePath)),
      repoRelativePath: toPosixPath(path.relative(input.repoRoot, absolutePath)),
    });
  }
}

function shouldSkipDirectory(
  name: string,
  scan: Pick<AgentProjectContextScanOptions, 'includeGenerated' | 'includeVendor'>
): boolean {
  if (ALWAYS_EXCLUDED_DIRS.has(name)) {
    return true;
  }
  if (scan.includeVendor !== true && VENDOR_DIRS.has(name)) {
    return true;
  }
  return scan.includeGenerated !== true && GENERATED_DIRS.has(name);
}

function isSourceCandidate(fileName: string): boolean {
  return SOURCE_FILE_BASENAMES.has(fileName) || SOURCE_EXTENSIONS.has(path.extname(fileName));
}

function createAnalyzedSourceFile(input: {
  candidate: SourceFileCandidate;
  contentMaxLines: number;
  repo: AnalyzedRepo;
  source: SourceSliceContext;
}): AnalyzedSourceFile {
  const { candidate, repo, source } = input;
  const lineCount = source.file.lineCount ?? countLines(source.text ?? '');
  const truncatedContent = truncateText(source.text ?? '', input.contentMaxLines);
  const snapshotFile: SnapshotFile = {
    content: truncatedContent.content,
    language: source.file.language,
    name: path.basename(source.file.filePath),
    path: candidate.absolutePath,
    relativePath: candidate.repoRelativePath,
    sourceIdentity: createSourceIdentity({ candidate, repo }),
    targetName: repo.context.repo.name,
    totalLines: lineCount,
    truncated: truncatedContent.truncated,
  };
  return {
    absolutePath: candidate.absolutePath,
    context: source,
    repo,
    repoRelativePath: candidate.repoRelativePath,
    snapshotFile,
  };
}

function createSourceIdentity(input: {
  candidate: SourceFileCandidate;
  repo: AnalyzedRepo;
}): SnapshotFile['sourceIdentity'] {
  const { candidate, repo } = input;
  const folder = repo.scope.folder;
  return {
    absolutePath: candidate.absolutePath,
    folderDisplayName: folder?.displayName ?? repo.context.repo.name,
    folderId: folder?.id ?? repo.context.repo.id,
    folderPath: path.resolve(repo.projectRoot, repo.scope.sourceFolder),
    folderRelativeRoot: repo.scope.sourceFolder === '.' ? null : repo.scope.sourceFolder,
    projectScopeId: readProjectScopeId(folder),
    qualifiedPath: candidate.projectRelativePath,
    relativePath: candidate.repoRelativePath,
  };
}

function readProjectScopeId(folder: AgentProjectScopeFolder | null): string | null {
  if (!folder || !isRecord(folder)) {
    return null;
  }
  const parent = (folder as Record<string, unknown>).projectScopeId;
  return typeof parent === 'string' ? parent : null;
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split(/\r\n|\n|\r/).length;
}

async function countFileLines(filePath: string, warnings: string[]): Promise<number> {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return Math.max(1, countLines(text));
  } catch (error) {
    warnings.push(
      `source-slice line count fallback used for ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return 1;
  }
}

function truncateText(text: string, maxLines: number): { content: string; truncated: boolean } {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length <= maxLines) {
    return { content: text, truncated: false };
  }
  return {
    content: lines.slice(0, maxLines).join('\n'),
    truncated: true,
  };
}

function createLanguageStats(files: readonly AnalyzedSourceFile[]): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const file of files) {
    const language =
      file.context.file.language || inferLanguageFromPath(file.context.file.filePath);
    stats[language] = (stats[language] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(stats).sort(([left], [right]) => left.localeCompare(right))
  );
}

function inferLanguageFromPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
      return 'javascript';
    case '.swift':
      return 'swift';
    case '.py':
      return 'python';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    case '.java':
    case '.kt':
      return 'jvm';
    default:
      return 'unknown';
  }
}

function detectPrimaryLanguage(langStats: Record<string, number>): string | null {
  const [primary] = Object.entries(langStats).sort(
    ([leftLang, leftCount], [rightLang, rightCount]) =>
      rightCount - leftCount || leftLang.localeCompare(rightLang)
  );
  return primary?.[0] ?? null;
}

function createLanguageProfile(
  langStats: Record<string, number>,
  primaryLang: string | null
): Record<string, unknown> {
  const secondary = Object.entries(langStats)
    .filter(([language]) => language !== primaryLang)
    .sort(([, leftCount], [, rightCount]) => rightCount - leftCount)
    .map(([language]) => language);
  return {
    isMultiLang: secondary.length > 0,
    primary: primaryLang ?? 'unknown',
    primaryLang: primaryLang ?? 'unknown',
    secondary,
    stats: langStats,
  };
}

function createActiveDimensions(
  primaryLang: string | null,
  detectedFrameworks: readonly string[],
  secondaryLanguages: readonly string[]
): DimensionDef[] {
  const dimensions = resolveActiveDimensions(primaryLang ?? 'unknown', [...detectedFrameworks]).map(
    toDimensionDef
  );
  DimensionCopy.applyMulti(
    dimensions as Array<{ id: string; label: string; guide: string }>,
    primaryLang ?? 'unknown',
    [...secondaryLanguages]
  );
  return dimensions;
}

function toDimensionDef(dimension: UnifiedDimension): DimensionDef {
  return {
    conditions: dimension.conditions
      ? {
          frameworks: dimension.conditions.frameworks
            ? [...dimension.conditions.frameworks]
            : undefined,
          languages: dimension.conditions.languages
            ? [...dimension.conditions.languages]
            : undefined,
        }
      : undefined,
    dualOutput: dimension.outputMode === 'dual',
    guide: dimension.extractionGuide,
    id: dimension.id,
    knowledgeTypes: [...dimension.allowedKnowledgeTypes],
    label: dimension.label,
    layer: dimension.layer,
    outputMode: dimension.outputMode,
    skillWorthy: dimension.outputMode === 'dual',
    tierHint: dimension.tierHint,
  };
}

async function evaluateIncrementalPlan(input: {
  activeDimensions: readonly DimensionDef[];
  allFiles: readonly SnapshotFile[];
  ctx: AgentProjectContextRunContext;
  enabled: boolean;
  projectRoot: string;
  warnings: string[];
}): Promise<IncrementalPlan | null> {
  if (!input.enabled) {
    return null;
  }
  const db = resolveDatabase(input.ctx);
  if (!db) {
    input.warnings.push('incremental: db not available, falling back to full');
    return null;
  }
  try {
    const { FileDiffPlanner } = await import(
      '@alembic/core/workflows/capabilities/project-intelligence'
    );
    const planner = new FileDiffPlanner(db, input.projectRoot, { logger: input.ctx.logger });
    return planner.evaluate(
      input.allFiles.map(toBootstrapFile),
      input.activeDimensions.map((dimension) => dimension.id)
    ) as IncrementalPlan;
  } catch (error) {
    input.warnings.push(
      `incremental evaluation failed (non-blocking): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}

function resolveDatabase(ctx: AgentProjectContextRunContext): unknown {
  return (
    resolveContainerService(ctx.container, 'get', 'database') ??
    resolveContainerService(ctx.container, 'get', 'db') ??
    resolveContainerService(ctx.container, 'resolve', 'database') ??
    resolveContainerService(ctx.container, 'resolve', 'db') ??
    ctx.db
  );
}

function resolveContainerService(
  container: AgentProjectContextContainer | undefined,
  method: 'get' | 'resolve',
  name: string
): unknown {
  const resolver = container?.[method];
  if (typeof resolver !== 'function') {
    return undefined;
  }
  try {
    return resolver.call(container, name);
  } catch {
    return undefined;
  }
}

function toBootstrapFile(file: SnapshotFile): BootstrapFile {
  return {
    content: file.content,
    path: file.path,
    relativePath: file.relativePath,
  };
}

function createDependencyGraph(input: {
  flowContexts: readonly FileFlowContext[];
  mapContexts: readonly ProjectMap[];
  moduleContexts: readonly ModuleContext[];
  repos: readonly AnalyzedRepo[];
}): { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> } {
  const nodes = new Map<string, Record<string, unknown>>();
  for (const repo of input.repos) {
    nodes.set(repo.context.repo.id, {
      id: repo.context.repo.id,
      label: repo.context.repo.name,
      type: 'repo',
    });
  }
  for (const moduleContext of input.moduleContexts) {
    nodes.set(moduleContext.module.id, {
      fileCount: moduleContext.module.ownedFileCount,
      id: moduleContext.module.id,
      label: moduleContext.module.name,
      type: moduleContext.module.kind ?? 'module',
    });
  }
  for (const mapContext of input.mapContexts) {
    for (const moduleSummary of mapContext.modules) {
      nodes.set(moduleSummary.id, {
        fileCount: moduleSummary.ownedFileCount,
        id: moduleSummary.id,
        label: moduleSummary.name,
        type: moduleSummary.kind ?? 'module',
      });
    }
  }

  const edges = new Map<string, Record<string, unknown>>();
  for (const flow of input.flowContexts) {
    for (const relation of [...flow.imports, ...flow.outflow, ...flow.callees]) {
      const from = relation.from?.filePath ?? relation.filePath ?? flow.file.filePath;
      const to = relation.to?.filePath ?? relation.to?.label ?? relation.label;
      if (!from || !to) {
        continue;
      }
      const id = `${from}->${to}:${relation.kind}`;
      edges.set(id, {
        from,
        id,
        to,
        type: relation.kind,
      });
    }
  }
  return {
    edges: [...edges.values()].sort((left, right) =>
      String(left.id).localeCompare(String(right.id))
    ),
    nodes: [...nodes.values()].sort((left, right) =>
      String(left.id).localeCompare(String(right.id))
    ),
  };
}

function createAstProjectSummary(input: {
  sourceFiles: readonly AnalyzedSourceFile[];
  symbolContexts: readonly FileSymbolContext[];
}): Record<string, unknown> | null {
  if (input.sourceFiles.length === 0) {
    return null;
  }
  const symbols = input.symbolContexts.flatMap((context) => context.symbols);
  return {
    classes: symbols
      .filter((symbol) => ['class', 'struct'].includes(symbol.kind))
      .map((symbol) => ({
        file: symbol.filePath,
        kind: symbol.kind,
        name: symbol.name,
        relativePath: symbol.filePath,
      })),
    fileCount: input.sourceFiles.length,
    fileSummaries: input.symbolContexts.map((context) => ({
      exports: context.symbols.filter((symbol) => symbol.exported),
      methods: context.symbols
        .filter((symbol) => ['function', 'method'].includes(symbol.kind))
        .map((symbol) => ({
          className: symbol.container,
          file: symbol.filePath,
          line: symbol.range?.startLine,
          name: symbol.name,
        })),
    })),
    projectMetrics: {
      totalMethods: symbols.filter((symbol) => ['function', 'method'].includes(symbol.kind)).length,
    },
    protocols: symbols
      .filter((symbol) => ['interface', 'protocol'].includes(symbol.kind))
      .map((symbol) => ({
        file: symbol.filePath,
        name: symbol.name,
        relativePath: symbol.filePath,
      })),
  };
}

function createAstContext(symbolContexts: readonly FileSymbolContext[]): string {
  return symbolContexts
    .flatMap((context) =>
      context.symbols
        .slice(0, 20)
        .map((symbol) => `${symbol.kind} ${symbol.name} ${symbol.filePath}`)
    )
    .slice(0, 200)
    .join('\n');
}

function createPanoramaResult(input: {
  mapContexts: readonly ProjectMap[];
  moduleContexts: readonly ModuleContext[];
}): Record<string, unknown> | null {
  if (input.mapContexts.length === 0 && input.moduleContexts.length === 0) {
    return null;
  }
  return {
    couplingHotspots: input.mapContexts.flatMap((mapContext) =>
      mapContext.hotspots.map((hotspot) => ({
        fanIn: hotspot.score,
        fanOut: hotspot.score,
        module: hotspot.ref.label ?? hotspot.ref.id,
      }))
    ),
    layers: input.mapContexts.flatMap((mapContext) =>
      mapContext.layers.map((layer, index) => ({
        level: layer.order ?? index,
        modules: input.moduleContexts
          .filter((moduleContext) => moduleContext.module.configLayer === layer.name)
          .map((moduleContext) => moduleContext.module.name),
        name: layer.name,
      }))
    ),
    modules: input.moduleContexts.map((moduleContext) => moduleContext.module),
  };
}

function createAnalysisReport(input: {
  depGraphData: { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };
  flowContexts: readonly FileFlowContext[];
  incrementalPlan: IncrementalPlan | null;
  mapContexts: readonly ProjectMap[];
  moduleContexts: readonly ModuleContext[];
  moduleLayerContexts: readonly ModuleLayerContext[];
  repos: readonly AnalyzedRepo[];
  sourceFiles: readonly AnalyzedSourceFile[];
  sourceTag: string;
  startedAt: number;
  symbolContexts: readonly FileSymbolContext[];
  traces: readonly QueryTrace[];
  warnings: readonly string[];
}): Record<string, unknown> {
  const routeCounts = countBy(input.traces, (trace) => trace.kind);
  return {
    phases: {
      ast: {
        classCount: input.symbolContexts.reduce(
          (sum, context) =>
            sum +
            context.symbols.filter((symbol) => ['class', 'struct'].includes(symbol.kind)).length,
          0
        ),
      },
      callGraph: {
        result: {
          edgesCreated: input.flowContexts.reduce(
            (sum, flow) => sum + flow.callers.length + flow.callees.length,
            0
          ),
        },
      },
      depGraph: {
        edgesWritten: input.depGraphData.edges.length,
      },
      fileCollection: {
        fileCount: input.sourceFiles.length,
        targetCount: input.repos.reduce((sum, repo) => sum + repo.context.targets.length, 0),
      },
      projectContext: {
        calls: input.traces.length,
        mappedRoutes: AGENT_PROJECT_CONTEXT_MAPPED_ROUTES,
        routeCounts,
      },
    },
    projectContext: {
      elapsedMs: Date.now() - input.startedAt,
      flowFiles: input.flowContexts.length,
      mapCount: input.mapContexts.length,
      mappedRoutes: AGENT_PROJECT_CONTEXT_MAPPED_ROUTES,
      moduleCount: input.moduleContexts.length,
      moduleLayerCount: input.moduleLayerContexts.length,
      repoCount: input.repos.length,
      routeCounts,
      sourceTag: input.sourceTag,
      symbolFiles: input.symbolContexts.length,
      warnings: input.warnings.length,
    },
    startTime: input.startedAt,
  };
}

function countBy<T>(items: readonly T[], keyOf: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyOf(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))
  );
}

function dedupeTargets(targets: readonly SnapshotTarget[]): SnapshotTarget[] {
  return dedupeBy(targets, (target) => target.name).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
}

function dedupeBy<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [keyOf(item), item])).values()];
}

function isSpaceContext(value: ProjectContextResult): value is SpaceContext {
  return isRecord(value) && isRecord(value.space) && Array.isArray(value.sourceFolders);
}

function isRepoContext(value: ProjectContextResult): value is RepoContext {
  return isRecord(value) && isRecord(value.repo) && Array.isArray(value.targets);
}

function isProjectMap(value: ProjectContextResult): value is ProjectMap {
  return isRecord(value) && Array.isArray(value.modules) && isRecord(value.dependencySummary);
}

function isModuleContext(value: ProjectContextResult): value is ModuleContext {
  return isRecord(value) && isRecord(value.module) && Array.isArray(value.ownedFiles);
}

function isModuleLayerContext(value: ProjectContextResult): value is ModuleLayerContext {
  return isRecord(value) && isRecord(value.module) && Array.isArray(value.layers);
}

function isSourceSliceContext(value: ProjectContextResult): value is SourceSliceContext {
  return isRecord(value) && isRecord(value.file) && isRecord(value.range);
}

function isFileSymbolContext(value: ProjectContextResult): value is FileSymbolContext {
  return isRecord(value) && isRecord(value.file) && Array.isArray(value.symbols);
}

function isFileFlowContext(value: ProjectContextResult): value is FileFlowContext {
  return isRecord(value) && isRecord(value.file) && Array.isArray(value.imports);
}

function isUnavailableData(value: unknown): value is ProjectContextUnavailableData {
  return isRecord(value) && value.available === false && typeof value.reason === 'string';
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/').replaceAll('\\', '/');
}

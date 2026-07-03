import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path, { basename, dirname } from 'node:path';
import {
  baseDimensions,
  buildCanonicalCoverageLedgerModuleId,
  buildHostAgentAnalysisPacketFromProjectContext,
  buildProjectContextMissionBriefing,
  type DimensionDef,
  getOrCreateSessionManager,
  type HostAgentAnalysisPacket,
  type KnowledgeRescanExecutionDecision,
} from '@alembic/core/host-agent-workflows';
import { RECIPE_PIPELINE_EVENTS } from '@alembic/core/knowledge';
import {
  buildProjectContextPresenterInput,
  type ModuleContext,
  type ProjectContextEnvelope,
  type ProjectContextPresenterInput,
  type ProjectContextRef,
  type ProjectContextRequestKind,
  type ProjectContextResult,
  type ProjectMap,
  type RepoContext,
  type SourceSliceContext,
  type SpaceContext,
} from '@alembic/core/project-context';
import { ProjectContextCapabilities } from '@alembic/core/project-context-capabilities';
import { createCanonicalSourceIdentity } from '@alembic/core/shared';
import type { FileDiffPlan, GenerateSessionShape } from '@alembic/core/types';
import type { GenerateFileEntry } from '#recipe-pipeline/generate/execution/AgentRunInputBuilders.js';
import {
  readLatestProjectContextFileSnapshotRow,
  saveProjectContextFileSnapshotRow,
} from '../infrastructure/database/SqliteDatabaseAccess.js';
import type {
  ProjectScopeAnalysisContext,
  ProjectScopeSourceIdentity,
} from '../project-scope/ProjectScopeAnalysis.js';
import { buildProjectMapModules, buildProjectMapModulesFromTargets } from './ProjectMapModules.js';

export {
  presentProjectContextColdStartEmptyProject,
  presentProjectContextColdStartResponse,
  presentProjectContextRescanResponse,
} from './ProjectContextPresenters.js';
export { buildProjectMapModules, buildProjectMapModulesFromTargets } from './ProjectMapModules.js';

type ProjectContextWorkflowSource = 'alembic-main-bootstrap' | 'alembic-main-rescan';

interface ProjectContextContainer {
  get(name: string): unknown;
}

interface ProjectContextLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

interface ProjectContextWorkflowEventBus {
  off?(eventName: string, listener: (payload: unknown) => void): void;
  on(eventName: string, listener: (payload: unknown) => void): void;
}

export interface ProjectContextWorkflowContext {
  container: ProjectContextContainer;
  logger: ProjectContextLogger;
}

export interface ProjectContextWorkflowFacts {
  allFiles: GenerateFileEntry[];
  allTargets: Array<Record<string, unknown>>;
  dimensions: DimensionDef[];
  envelopes: ProjectContextEnvelope<ProjectContextResult>[];
  fileCount: number;
  filesByTarget: Record<string, Array<Record<string, unknown>>>;
  incrementalPlan: FileDiffPlan | null;
  isEmpty: boolean;
  isMultiLang: boolean;
  languageStats: Record<string, number>;
  moduleCount: number;
  projectMapModules: ProjectContextModule[];
  moduleSeeds: ProjectContextModuleSeed[];
  presenterInput: ProjectContextPresenterInput;
  primaryLang: string;
  projectContextSummary: Record<string, unknown>;
  projectRoot: string;
  projectType: string;
  report: Record<string, unknown>;
  requestKinds: ProjectContextRequestKind[];
  secondaryLanguages: string[];
  targetCount: number;
  warnings: string[];
}

export interface ProjectContextFillView {
  readonly bootstrapSession: GenerateSessionShape | null;
  readonly ctx: Record<string, unknown>;
  readonly existingRecipes?: unknown;
  readonly evolutionPrescreen?: unknown;
  readonly mode?: 'bootstrap' | 'rescan';
  readonly onDimensionResult?: ProjectContextDimensionResultHook;
  readonly projectContextFacts: ProjectContextWorkflowFacts;
  readonly projectRoot: string;
  readonly rescanExecutionDecisions?: readonly KnowledgeRescanExecutionDecision[];
  readonly skipTargetDelivery?: boolean;
  readonly targetFileMap: Record<string, unknown[]>;
}

export interface ProjectContextDimensionResultHookInput {
  readonly acceptedSourceRefs: readonly string[];
  readonly candidateCount: number;
  readonly dimensionId: string;
  readonly referencedFiles: readonly string[];
  readonly rejectedCount: number;
}

export type ProjectContextDimensionResultHook = (
  input: ProjectContextDimensionResultHookInput
) => Promise<void> | void;

export interface ProjectContextMissionArtifacts {
  briefing: { meta?: unknown; [key: string]: unknown };
  hostAgentPacket: HostAgentAnalysisPacket;
  // R1 compatibility alias for report/runtime consumers still reading the old field.
  ideAgentPacket: HostAgentAnalysisPacket;
}

type ProjectContextWorkflowSession = ReturnType<
  ReturnType<typeof getOrCreateSessionManager>['createSession']
>;

type ProjectContextMissionRescanInput = NonNullable<
  Parameters<typeof buildProjectContextMissionBriefing>[0]['rescan']
>;

interface BuildProjectContextWorkflowFactsInput {
  analysisScope?: ProjectScopeAnalysisContext;
  contentMaxLines?: number;
  ctx: ProjectContextWorkflowContext;
  maxFiles?: unknown;
  maxModuleDetails?: number;
  maxModuleSeeds?: number;
  maxFileDetails?: number;
  projectRoot: string;
  source: ProjectContextWorkflowSource;
}

interface ProjectContextModuleSeed {
  configLayer?: string;
  kind?: string;
  moduleName: string;
  modulePath?: string;
  ownedFiles?: string[];
  ref?: ProjectContextRef;
  role?: string;
}

export interface ProjectContextModule {
  kind?: string;
  moduleId: string;
  moduleName: string;
  modulePath?: string;
  ownedFileCount?: number;
  ownedFiles?: string[];
  ref?: ProjectContextRef;
  role?: string;
}

interface ProjectContextScopePropagation {
  allowCurrentFolderRelativeIdentity: boolean;
  currentFolderId: string | null;
  identityFolders: ProjectContextSourceIdentityFolder[];
  sourceFolders?: string[];
  sourceFolderPayloads?: ProjectContextSourceFolderPayload[];
}

interface ProjectContextSourceIdentityFolder {
  controlRoot: string;
  displayName: string | null;
  folderId: string | null;
  folderPath: string;
  projectScopeId: string | null;
  relativeRoot: string;
  role: string | null;
}

interface ProjectContextSourceFolderPayload {
  displayName?: string;
  folderId?: string;
  id?: string;
  path: string;
  repoId?: string;
  repositoryId?: string;
  role?: string;
}

interface ProjectContextWorkflowFileCandidate {
  content?: string;
  language?: string;
  relativePath: string;
}

const PROJECT_SCOPE_SOURCE_SCAN_DEFAULT_MAX_FILES = 2000;

const PROJECT_SCOPE_SOURCE_SCAN_EXCLUDE_DIRS = new Set([
  '.asd',
  '.git',
  '.next',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
]);

const PROJECT_SCOPE_LANGUAGE_BY_EXTENSION = new Map<string, string>([
  ['.c', 'c'],
  ['.cc', 'cpp'],
  ['.cpp', 'cpp'],
  ['.cs', 'csharp'],
  ['.cxx', 'cpp'],
  ['.go', 'go'],
  ['.h', 'c'],
  ['.hpp', 'cpp'],
  ['.java', 'java'],
  ['.js', 'javascript'],
  ['.jsx', 'javascript'],
  ['.kt', 'kotlin'],
  ['.m', 'objective-c'],
  ['.mm', 'objective-cpp'],
  ['.mjs', 'javascript'],
  ['.py', 'python'],
  ['.rs', 'rust'],
  ['.swift', 'swift'],
  ['.ts', 'typescript'],
  ['.tsx', 'typescript'],
]);

export async function buildProjectContextWorkflowFacts(
  input: BuildProjectContextWorkflowFactsInput
): Promise<ProjectContextWorkflowFacts> {
  const maxFiles = readPositiveInteger(input.maxFiles);
  const maxModuleSeeds = input.maxModuleSeeds ?? 6;
  const maxModuleDetails = input.maxModuleDetails ?? 3;
  const maxFileDetails = input.maxFileDetails ?? 8;
  const contentMaxLines = input.contentMaxLines ?? 120;
  const basePayload = {
    ...(maxFiles !== undefined ? { maxFiles } : {}),
  };
  const scopePropagation = buildProjectContextScopePropagation(
    input.analysisScope,
    input.projectRoot
  );
  const scopedSourceFiles = await collectProjectScopeWorkflowFileCandidates(
    scopePropagation,
    maxFiles
  );

  const spaceEnvelope = await executeProjectContextRequest(
    'space',
    input.projectRoot,
    input.source,
    {
      includeProjectTree: true,
    },
    scopePropagation
  );
  const firstRepoEnvelope = await executeProjectContextRequest(
    'repo',
    input.projectRoot,
    input.source,
    {
      ...basePayload,
      includeMapSummary: false,
    },
    scopePropagation
  );
  const repoData = isRepoContext(firstRepoEnvelope.data) ? firstRepoEnvelope.data : undefined;
  const moduleSeeds = dedupeModuleSeeds([
    ...createProjectScopeModuleSeeds(scopePropagation, scopedSourceFiles),
    ...selectProjectContextModuleSeeds(repoData, maxModuleSeeds),
  ]).slice(0, maxModuleSeeds);
  const repoEnvelope =
    moduleSeeds.length > 0
      ? await executeProjectContextRequest(
          'repo',
          input.projectRoot,
          input.source,
          {
            ...basePayload,
            includeMapSummary: true,
            moduleSeeds,
          },
          scopePropagation
        )
      : firstRepoEnvelope;
  const envelopes: ProjectContextEnvelope<ProjectContextResult>[] = [spaceEnvelope, repoEnvelope];

  if (moduleSeeds.length > 0) {
    envelopes.push(
      await executeProjectContextRequest(
        'map',
        input.projectRoot,
        input.source,
        {
          moduleSeeds,
          repoName: repoData?.repo.name,
        },
        scopePropagation
      )
    );
  }

  for (const seed of moduleSeeds.slice(0, maxModuleDetails)) {
    envelopes.push(
      await executeProjectContextRequest(
        'module',
        input.projectRoot,
        input.source,
        {
          ...seed,
          includeDependencies: true,
          includePublicSurfaces: true,
        },
        scopePropagation
      )
    );
    envelopes.push(
      await executeProjectContextRequest(
        'module-layers',
        input.projectRoot,
        input.source,
        {
          ...seed,
          includeBoundaryCrossings: true,
        },
        scopePropagation
      )
    );
  }

  const detailFiles = selectProjectContextDetailFiles(envelopes, maxFileDetails);
  for (const filePath of detailFiles) {
    envelopes.push(
      await executeProjectContextRequest(
        'file-flow',
        input.projectRoot,
        input.source,
        {
          filePath,
        },
        scopePropagation
      )
    );
    envelopes.push(
      await executeProjectContextRequest(
        'file-symbols',
        input.projectRoot,
        input.source,
        {
          filePath,
        },
        scopePropagation
      )
    );
    envelopes.push(
      await executeProjectContextRequest(
        'source-slice',
        input.projectRoot,
        input.source,
        {
          endLine: contentMaxLines,
          filePath,
          includeText: true,
          startLine: 1,
        },
        scopePropagation
      )
    );
    envelopes.push(
      await executeProjectContextRequest(
        'anchor-range',
        input.projectRoot,
        input.source,
        {
          afterLines: Math.min(8, contentMaxLines),
          beforeLines: 0,
          filePath,
          includeRelations: false,
          includeSourceSlices: true,
          includeSymbols: true,
          line: 1,
          relationHops: 0,
        },
        scopePropagation
      )
    );
  }

  const presenterInput = buildProjectContextPresenterInput(envelopes);
  const dimensions: DimensionDef[] = [...baseDimensions];
  const allFiles = buildWorkflowFiles(presenterInput, scopePropagation, scopedSourceFiles);
  const languageStats = buildLanguageStats(presenterInput, allFiles, scopePropagation);
  const primaryLang = inferProjectContextPrimaryLanguage(languageStats);
  const secondaryLanguages = inferProjectContextSecondaryLanguages(languageStats, primaryLang);
  const allTargets = buildWorkflowTargets(presenterInput);
  const filesByTarget = buildProjectContextTargetFileMap(allFiles);
  const projectMapModules = buildScopedProjectMapModules({
    allFiles,
    input: presenterInput,
    projectRoot: input.projectRoot,
    scopePropagation,
  });
  if (projectMapModules.length === 0) {
    projectMapModules.push(
      ...(await buildProjectMapModulesFromTargets({
        allFiles,
        input: presenterInput,
        projectRoot: input.projectRoot,
      }))
    );
  }
  const incrementalPlan =
    input.source === 'alembic-main-rescan'
      ? buildProjectContextFileDiffPlan({
          allDimensionIds: dimensions.map((dimension) => dimension.id),
          allFiles,
          ctx: input.ctx,
          projectRoot: input.projectRoot,
        })
      : null;
  const moduleCount = projectMapModules.length || presenterInput.modules.length || 0;
  const warnings = [
    ...presenterInput.warnings.map((warning) => `${warning.queryLevel}:${warning.message}`),
    ...presenterInput.unavailable.map(
      (unavailable) => `${unavailable.queryLevel}:${unavailable.kind}:${unavailable.reason}`
    ),
  ];

  input.ctx.logger.info('[ProjectContextWorkflowFacts] ProjectContext facts ready', {
    fileCount: allFiles.length,
    moduleCount,
    projectInformationSource: 'project-context',
    requestKinds: uniqueRequestKinds(envelopes.map((envelope) => envelope.queryLevel)),
    source: input.source,
  });

  return {
    allFiles,
    allTargets,
    dimensions,
    envelopes,
    fileCount: allFiles.length,
    filesByTarget,
    incrementalPlan,
    isEmpty: allFiles.length === 0 && presenterInput.refs.length === 0,
    isMultiLang: secondaryLanguages.length > 0,
    languageStats,
    moduleCount,
    projectMapModules,
    moduleSeeds,
    presenterInput,
    primaryLang,
    projectContextSummary: buildProjectContextSummary(presenterInput, envelopes),
    projectRoot: input.projectRoot,
    projectType: inferProjectContextProjectType(presenterInput),
    report: buildProjectContextWorkflowReport({
      allFiles,
      allTargets,
      contentMaxLines,
      dimensions,
      maxFiles,
      moduleCount,
      presenterInput,
      warnings,
    }),
    requestKinds: uniqueRequestKinds(envelopes.map((envelope) => envelope.queryLevel)),
    secondaryLanguages,
    targetCount: allTargets.length,
    warnings,
  };
}

export function createProjectContextWorkflowSession(input: {
  container: ProjectContextContainer;
  dimensions: DimensionDef[];
  facts: ProjectContextWorkflowFacts;
  projectRoot: string;
  replaceExisting?: boolean;
}): ProjectContextWorkflowSession {
  const sessionManager = getOrCreateSessionManager(input.container);
  return sessionManager.createSession(buildProjectContextWorkflowSessionOptions(input), {
    replace: input.replaceExisting === true,
  });
}

export function openOrReturnProjectContextWorkflowSession(input: {
  container: ProjectContextContainer;
  dimensions: DimensionDef[];
  facts: ProjectContextWorkflowFacts;
  projectRoot: string;
}): {
  reusedExisting: boolean;
  session: ProjectContextWorkflowSession;
} {
  const sessionManager = getOrCreateSessionManager(input.container);
  try {
    return {
      reusedExisting: false,
      session: sessionManager.createSession(buildProjectContextWorkflowSessionOptions(input)),
    };
  } catch (err: unknown) {
    const existing = sessionManager.getSession(undefined, { projectRoot: input.projectRoot });
    if (existing) {
      return { reusedExisting: true, session: existing };
    }
    throw err;
  }
}

export function releaseProjectContextWorkflowSession(input: {
  container: ProjectContextContainer;
  logger: ProjectContextLogger;
  projectRoot: string;
  reason: string;
  workflowSessionId: string;
}): boolean {
  const sessionManager = getOrCreateSessionManager(input.container);
  const existing = sessionManager.getAnySession(input.workflowSessionId, {
    projectRoot: input.projectRoot,
  });
  if (!existing) {
    input.logger.info('[ProjectContextWorkflowFacts] Workflow session release skipped', {
      projectRoot: input.projectRoot,
      reason: input.reason,
      workflowSessionId: input.workflowSessionId,
    });
    return false;
  }

  sessionManager.clearSession(input.workflowSessionId);
  const released =
    sessionManager.getAnySession(input.workflowSessionId, { projectRoot: input.projectRoot }) ===
    null;
  input.logger.info('[ProjectContextWorkflowFacts] Workflow session lease released', {
    projectRoot: input.projectRoot,
    reason: input.reason,
    released,
    workflowSessionId: input.workflowSessionId,
  });
  return released;
}

export function releaseProjectContextWorkflowSessionByProjectRoot(input: {
  container: ProjectContextContainer;
  logger: ProjectContextLogger;
  projectRoot: string;
  reason: string;
}): {
  released: boolean;
  workflowSessionId: string | null;
} {
  const sessionManager = getOrCreateSessionManager(input.container);
  const existing = sessionManager.getAnySession(undefined, {
    projectRoot: input.projectRoot,
  });
  if (!existing) {
    input.logger.info('[ProjectContextWorkflowFacts] Workflow session release skipped', {
      projectRoot: input.projectRoot,
      reason: input.reason,
      workflowSessionId: null,
    });
    return { released: false, workflowSessionId: null };
  }

  sessionManager.releaseProjectLease(input.projectRoot);
  const released =
    sessionManager.getAnySession(existing.id, { projectRoot: input.projectRoot }) === null;
  input.logger.info('[ProjectContextWorkflowFacts] Workflow session lease released', {
    projectRoot: input.projectRoot,
    reason: input.reason,
    released,
    workflowSessionId: existing.id,
  });
  return { released, workflowSessionId: existing.id };
}

export function registerProjectContextWorkflowSessionReleaseOnGenerateCompletion(input: {
  bootstrapSessionId: string | null | undefined;
  container: ProjectContextContainer;
  logger: ProjectContextLogger;
  projectRoot: string;
  workflow: 'cold-start' | 'rescan';
  workflowSessionId: string;
}): (() => void) | null {
  if (!input.bootstrapSessionId) {
    input.logger.warn('[ProjectContextWorkflowFacts] Workflow session release hook skipped', {
      reason: 'missing-bootstrap-session',
      workflow: input.workflow,
      workflowSessionId: input.workflowSessionId,
    });
    return null;
  }

  const eventBus = resolveProjectContextWorkflowEventBus(input.container);
  if (!eventBus) {
    input.logger.warn('[ProjectContextWorkflowFacts] Workflow session release hook skipped', {
      bootstrapSessionId: input.bootstrapSessionId,
      reason: 'missing-event-bus',
      workflow: input.workflow,
      workflowSessionId: input.workflowSessionId,
    });
    return null;
  }

  const listener = (payload: unknown) => {
    const event = asRecord(payload);
    if (stringValue(event.sessionId) !== input.bootstrapSessionId) {
      return;
    }

    eventBus.off?.(RECIPE_PIPELINE_EVENTS.allCompleted, listener);
    const releaseDecision = classifyBootstrapCompletionRelease(event, input.workflow);
    if (!releaseDecision.release) {
      input.logger.warn('[ProjectContextWorkflowFacts] Workflow session lease retained', {
        bootstrapSessionId: input.bootstrapSessionId,
        reason: releaseDecision.reason,
        status: stringValue(event.status) ?? null,
        workflow: input.workflow,
        workflowSessionId: input.workflowSessionId,
      });
      return;
    }

    releaseProjectContextWorkflowSession({
      container: input.container,
      logger: input.logger,
      projectRoot: input.projectRoot,
      reason: releaseDecision.reason,
      workflowSessionId: input.workflowSessionId,
    });
  };

  eventBus.on(RECIPE_PIPELINE_EVENTS.allCompleted, listener);
  return () => eventBus.off?.(RECIPE_PIPELINE_EVENTS.allCompleted, listener);
}

function buildProjectContextWorkflowSessionOptions(input: {
  dimensions: DimensionDef[];
  facts: ProjectContextWorkflowFacts;
  projectRoot: string;
}) {
  return {
    dimensions: input.dimensions.map((dimension) => ({
      ...dimension,
      skillMeta: dimension.skillMeta ?? undefined,
    })),
    projectContext: {
      fileCount: input.facts.fileCount,
      modules: input.facts.moduleCount,
      primaryLang: input.facts.primaryLang,
      projectInformationSource: 'project-context',
      projectName: basename(input.projectRoot),
    },
    projectRoot: input.projectRoot,
  };
}

export function selectProjectContextWorkflowDimensions(
  dimensions: readonly DimensionDef[],
  requestedDimensionIds?: readonly string[]
): DimensionDef[] {
  if (!requestedDimensionIds?.length) {
    return [...dimensions];
  }
  const requested = new Set(requestedDimensionIds);
  return dimensions.filter((dimension) => requested.has(dimension.id));
}

export function buildProjectContextMissionArtifacts(input: {
  dimensions: DimensionDef[];
  facts: ProjectContextWorkflowFacts;
  profile: 'cold-start' | 'rescan';
  rescan?: ProjectContextMissionRescanInput;
  session: ProjectContextWorkflowSession;
}): ProjectContextMissionArtifacts {
  const briefing = buildProjectContextMissionBriefing({
    activeDimensions: input.dimensions,
    projectContext: input.facts.presenterInput,
    profile: input.profile === 'cold-start' ? 'cold-start-host-agent' : 'rescan-host-agent',
    rescan: input.profile === 'rescan' ? input.rescan : undefined,
    session: input.session,
  });
  const hostAgentPacket = buildHostAgentAnalysisPacketFromProjectContext({
    dimensions: input.dimensions,
    options: {
      profile: input.profile,
      projectRoot: input.facts.projectRoot,
    },
    projectContext: input.facts.presenterInput,
  });
  return {
    briefing: briefing as ProjectContextMissionArtifacts['briefing'],
    hostAgentPacket,
    ideAgentPacket: hostAgentPacket,
  };
}

function resolveProjectContextWorkflowEventBus(
  container: ProjectContextContainer
): ProjectContextWorkflowEventBus | null {
  try {
    const eventBus = container.get('eventBus') as ProjectContextWorkflowEventBus | null;
    return eventBus && typeof eventBus.on === 'function' ? eventBus : null;
  } catch {
    return null;
  }
}

function classifyBootstrapCompletionRelease(
  event: Record<string, unknown>,
  workflow: 'cold-start' | 'rescan'
): {
  reason: string;
  release: boolean;
} {
  if (isCancelledBootstrapCompletionEvent(event)) {
    return {
      reason: `${workflow}:bootstrap-session-cancelled`,
      release: true,
    };
  }

  if (isCleanBootstrapCompletionEvent(event)) {
    return {
      reason: `${workflow}:bootstrap-session-completed`,
      release: true,
    };
  }

  return {
    reason: 'bootstrap-session-not-clean-complete',
    release: false,
  };
}

function isCancelledBootstrapCompletionEvent(event: Record<string, unknown>): boolean {
  const status = stringValue(event.status);
  if (status === 'aborted' || status === 'cancelled' || event.userCancelled === true) {
    return true;
  }
  const summary = asRecord(event.summary);
  if (summary.aborted === true || summary.userCancelled === true) {
    return true;
  }
  const tasks = Array.isArray(event.tasks) ? event.tasks.filter(isRecord) : [];
  return tasks.some((task) => stringValue(task.status) === 'cancelled');
}

function isCleanBootstrapCompletionEvent(event: Record<string, unknown>): boolean {
  if (stringValue(event.status) !== 'completed') {
    return false;
  }

  const tasks = Array.isArray(event.tasks) ? event.tasks.filter(isRecord) : [];
  return tasks.every((task) => {
    if (stringValue(task.status) !== 'completed') {
      return false;
    }
    const result = asRecord(task.result);
    const resultType = stringValue(result.type);
    const resultStatus = stringValue(result.status);
    if (result.degraded === true) {
      return false;
    }
    if (resultType === 'error' || resultType === 'skipped') {
      return false;
    }
    return ![
      'timeout',
      'blocked',
      'aborted',
      'error',
      'skipped',
      'degraded_no_findings',
      'record_repair_incomplete',
      'l4_compaction_failed_budget_exhausted',
    ].includes(resultStatus ?? '');
  });
}

export function buildProjectContextFillView(input: {
  bootstrapSession: GenerateSessionShape | null;
  ctx: Record<string, unknown>;
  existingRecipes?: unknown;
  evolutionPrescreen?: unknown;
  facts: ProjectContextWorkflowFacts;
  mode: 'bootstrap' | 'rescan';
  onDimensionResult?: ProjectContextDimensionResultHook;
  projectRoot: string;
  rescanExecutionDecisions?: readonly KnowledgeRescanExecutionDecision[];
  skipTargetDelivery?: boolean;
}): ProjectContextFillView {
  return {
    bootstrapSession: input.bootstrapSession,
    ctx: input.ctx,
    existingRecipes: input.existingRecipes,
    evolutionPrescreen: input.evolutionPrescreen,
    mode: input.mode,
    onDimensionResult: input.onDimensionResult,
    projectContextFacts: input.facts,
    projectRoot: input.projectRoot,
    rescanExecutionDecisions: input.rescanExecutionDecisions,
    skipTargetDelivery: input.skipTargetDelivery,
    targetFileMap: input.facts.filesByTarget,
  };
}

export function saveProjectContextFileSnapshot(input: {
  allFiles: GenerateFileEntry[];
  ctx: ProjectContextWorkflowContext;
  plan: FileDiffPlan | null;
  primaryLang: string;
  projectRoot: string;
  sessionId: string;
}): string | null {
  try {
    const db = input.ctx.container.get('database');
    const id = `pc-${Date.now()}`;
    const saved = saveProjectContextFileSnapshotRow(db, {
      id,
      projectRoot: input.projectRoot,
      sessionId: input.sessionId,
      payload: JSON.stringify({
        allFiles: input.allFiles.map((file) => ({
          path: file.path,
          relativePath: file.relativePath,
        })),
        isIncremental: input.plan?.mode === 'incremental',
        primaryLang: input.primaryLang,
      }),
      createdAt: Date.now(),
    });
    if (!saved) {
      return null;
    }
    return id;
  } catch (err: unknown) {
    input.ctx.logger.warn('[ProjectContextWorkflowFacts] File snapshot save skipped', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function executeProjectContextRequest(
  kind: ProjectContextRequestKind,
  projectRoot: string,
  source: ProjectContextWorkflowSource,
  payload?: Record<string, unknown>,
  scopePropagation?: ProjectContextScopePropagation
): Promise<ProjectContextEnvelope<ProjectContextResult>> {
  const sourceFolderPayloads = scopePropagation?.sourceFolderPayloads;
  const primarySourceFolder = scopePropagation?.sourceFolders?.[0];
  const requestPayload = {
    ...(payload ?? {}),
    ...(kind === 'space' && sourceFolderPayloads?.length
      ? { sourceFolders: sourceFolderPayloads.map((folder) => ({ ...folder })) }
      : {}),
    ...(kind === 'repo' && primarySourceFolder ? { repoRoot: primarySourceFolder } : {}),
  };
  return ProjectContextCapabilities.execute({
    kind,
    payload: Object.keys(requestPayload).length > 0 ? requestPayload : undefined,
    project: {
      displayName: basename(projectRoot),
      projectRoot,
      source,
    },
    scope: {
      projectRoot,
    },
  });
}

function buildProjectContextScopePropagation(
  analysisScope: ProjectScopeAnalysisContext | undefined,
  requestProjectRoot: string
): ProjectContextScopePropagation {
  const projectScope = analysisScope?.projectScope;
  const controlRoot = analysisScope?.controlRoot ?? projectScope?.controlRoot.path ?? null;
  if (!projectScope || !controlRoot || projectScope.folders.length === 0) {
    return {
      allowCurrentFolderRelativeIdentity: false,
      currentFolderId: analysisScope?.currentFolderId ?? null,
      identityFolders: [],
    };
  }

  const sourceFolders: string[] = [];
  const sourceFolderPayloads: ProjectContextSourceFolderPayload[] = [];
  const identityFolders: ProjectContextSourceIdentityFolder[] = [];
  const seen = new Set<string>();
  for (const folder of projectScope.folders) {
    const relativeRoot = normalizeProjectContextSourcePath(path.relative(controlRoot, folder.path));
    if (!relativeRoot || seen.has(relativeRoot)) {
      continue;
    }
    seen.add(relativeRoot);
    sourceFolders.push(relativeRoot);
    const displayName = folder.displayName || basename(folder.path);
    sourceFolderPayloads.push({
      displayName,
      ...(folder.id ? { folderId: folder.id, id: folder.id } : {}),
      path: relativeRoot,
      repoId: displayName,
      repositoryId: displayName,
      ...(folder.role ? { role: folder.role } : {}),
    });
    identityFolders.push({
      controlRoot,
      displayName,
      folderId: folder.id || null,
      folderPath: folder.path,
      projectScopeId: projectScope.projectScopeId ?? null,
      relativeRoot,
      role: folder.role || null,
    });
  }

  return {
    allowCurrentFolderRelativeIdentity:
      path.resolve(requestProjectRoot) !== path.resolve(controlRoot),
    currentFolderId: analysisScope?.currentFolderId ?? projectScope.currentFolderId ?? null,
    identityFolders,
    sourceFolders: sourceFolders.length > 0 ? sourceFolders : undefined,
    sourceFolderPayloads: sourceFolderPayloads.length > 0 ? sourceFolderPayloads : undefined,
  };
}

function buildProjectContextFileDiffPlan(input: {
  allDimensionIds: string[];
  allFiles: GenerateFileEntry[];
  ctx: ProjectContextWorkflowContext;
  projectRoot: string;
}): FileDiffPlan {
  const previous = loadLatestProjectContextFileSnapshot(input.ctx, input.projectRoot);
  if (!previous) {
    return {
      affectedDimensions: input.allDimensionIds,
      canIncremental: false,
      diff: null,
      mode: 'full',
      previousSnapshot: null,
      reason: '无 ProjectContext 文件快照，需要全量重扫',
      restoredEpisodic: null,
      skippedDimensions: [],
    };
  }
  const current = input.allFiles.map((file) => file.relativePath).sort();
  const before = new Set(previous.files);
  const now = new Set(current);
  const added = current.filter((file) => !before.has(file));
  const deleted = previous.files.filter((file) => !now.has(file));
  const unchanged = current.filter((file) => before.has(file));
  const modified: string[] = [];
  const changed = added.length + deleted.length + modified.length;
  const total = Math.max(1, current.length);
  const changeRatio = changed / total;
  if (changed === 0) {
    return {
      affectedDimensions: [],
      canIncremental: true,
      diff: { added, changeRatio, deleted, modified, unchanged },
      mode: 'incremental',
      previousSnapshot: { id: previous.id },
      reason: 'ProjectContext 文件列表未变化，维度执行可由 rescan plan 决定',
      restoredEpisodic: null,
      skippedDimensions: input.allDimensionIds,
    };
  }
  return {
    affectedDimensions: input.allDimensionIds,
    canIncremental: false,
    diff: { added, changeRatio, deleted, modified, unchanged },
    mode: 'full',
    previousSnapshot: { id: previous.id },
    reason: 'ProjectContext 文件列表变化，执行全量维度评估',
    restoredEpisodic: null,
    skippedDimensions: [],
  };
}

function loadLatestProjectContextFileSnapshot(
  ctx: ProjectContextWorkflowContext,
  projectRoot: string
): { files: string[]; id: string } | null {
  try {
    const row = readLatestProjectContextFileSnapshotRow(ctx.container.get('database'), projectRoot);
    if (!row) {
      return null;
    }
    const payload = JSON.parse(row.payload) as { allFiles?: Array<{ relativePath?: string }> };
    return {
      files: (payload.allFiles ?? [])
        .map((file) => file.relativePath)
        .filter((file): file is string => typeof file === 'string'),
      id: row.id,
    };
  } catch {
    return null;
  }
}

async function collectProjectScopeWorkflowFileCandidates(
  scopePropagation: ProjectContextScopePropagation,
  maxFiles: number | undefined
): Promise<ProjectContextWorkflowFileCandidate[]> {
  if (scopePropagation.identityFolders.length === 0) {
    return [];
  }
  const maxTotal = maxFiles ?? PROJECT_SCOPE_SOURCE_SCAN_DEFAULT_MAX_FILES;
  if (maxTotal <= 0) {
    return [];
  }
  const perFolderBase = Math.max(1, Math.floor(maxTotal / scopePropagation.identityFolders.length));
  const remainder = maxTotal % scopePropagation.identityFolders.length;
  const candidates: ProjectContextWorkflowFileCandidate[] = [];
  for (const [index, folder] of scopePropagation.identityFolders.entries()) {
    const limit = perFolderBase + (index < remainder ? 1 : 0);
    candidates.push(...(await collectProjectScopeFolderFileCandidates(folder, limit)));
  }
  return dedupeFileCandidates(candidates).slice(0, maxTotal);
}

async function collectProjectScopeFolderFileCandidates(
  folder: ProjectContextSourceIdentityFolder,
  limit: number
): Promise<ProjectContextWorkflowFileCandidate[]> {
  const candidates: ProjectContextWorkflowFileCandidate[] = [];
  const pendingDirs = [''];
  while (pendingDirs.length > 0 && candidates.length < limit) {
    const relativeDir = pendingDirs.shift() ?? '';
    let entries: Dirent[];
    try {
      entries = await readdir(path.join(folder.folderPath, relativeDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort(compareProjectScopeScanEntries)) {
      const entryRelativePath = normalizeProjectContextSourcePath(
        path.posix.join(relativeDir, entry.name)
      );
      if (!entryRelativePath) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!PROJECT_SCOPE_SOURCE_SCAN_EXCLUDE_DIRS.has(entry.name)) {
          pendingDirs.push(entryRelativePath);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const language = languageFromProjectScopeFilePath(entryRelativePath);
      if (!language) {
        continue;
      }
      const qualifiedPath = normalizeProjectContextSourcePath(
        path.posix.join(folder.relativeRoot, entryRelativePath)
      );
      if (!qualifiedPath) {
        continue;
      }
      candidates.push({
        language,
        relativePath: qualifiedPath,
      });
      if (candidates.length >= limit) {
        break;
      }
    }
  }
  return candidates;
}

function compareProjectScopeScanEntries(left: Dirent, right: Dirent): number {
  const leftScore = projectScopeScanEntryScore(left.name, left.isDirectory());
  const rightScore = projectScopeScanEntryScore(right.name, right.isDirectory());
  return leftScore - rightScore || left.name.localeCompare(right.name);
}

function projectScopeScanEntryScore(name: string, isDirectory: boolean): number {
  if (!isDirectory) {
    return 50;
  }
  if (name === 'src' || name === 'lib') {
    return 0;
  }
  if (name === 'bin' || name === 'scripts' || name === 'test' || name === 'tests') {
    return 10;
  }
  if (name.startsWith('.')) {
    return 80;
  }
  return 40;
}

function languageFromProjectScopeFilePath(filePath: string): string | null {
  return PROJECT_SCOPE_LANGUAGE_BY_EXTENSION.get(path.extname(filePath).toLowerCase()) ?? null;
}

function dedupeFileCandidates(
  files: readonly ProjectContextWorkflowFileCandidate[]
): ProjectContextWorkflowFileCandidate[] {
  const byPath = new Map<string, ProjectContextWorkflowFileCandidate>();
  for (const file of files) {
    if (!byPath.has(file.relativePath)) {
      byPath.set(file.relativePath, file);
    }
  }
  return [...byPath.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath)
  );
}

function createProjectScopeModuleSeeds(
  scopePropagation: ProjectContextScopePropagation,
  files: readonly ProjectContextWorkflowFileCandidate[]
): ProjectContextModuleSeed[] {
  if (scopePropagation.identityFolders.length === 0) {
    return [];
  }
  return scopePropagation.identityFolders.map((folder) => {
    const ownedFiles = files
      .map((file) => file.relativePath)
      .filter((filePath) => pathWithinSourceFolder(filePath, folder.relativeRoot));
    return {
      kind: 'project-scope-folder',
      moduleName: folder.displayName ?? folder.relativeRoot,
      modulePath: folder.relativeRoot,
      ownedFiles: ownedFiles.slice(0, 12),
      role: folder.role ?? 'source',
    };
  });
}

function buildScopedProjectMapModules(input: {
  allFiles: readonly GenerateFileEntry[];
  input: ProjectContextPresenterInput;
  projectRoot: string;
  scopePropagation: ProjectContextScopePropagation;
}): ProjectContextModule[] {
  const mapModules = buildProjectMapModules(input.input.map, {
    projectRoot: input.projectRoot,
  });
  if (input.scopePropagation.identityFolders.length === 0) {
    return mapModules;
  }
  return dedupeProjectContextModules([
    ...mapModules.filter((module) => moduleBelongsToProjectScope(module, input.scopePropagation)),
    ...buildProjectScopeFolderModules(input.scopePropagation, input.allFiles, input.projectRoot),
  ]);
}

function moduleBelongsToProjectScope(
  module: ProjectContextModule,
  scopePropagation: ProjectContextScopePropagation
): boolean {
  const paths = [module.modulePath, ...(module.ownedFiles ?? [])]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => normalizeProjectContextSourcePath(value))
    .filter((value): value is string => Boolean(value));
  return paths.some((filePath) =>
    scopePropagation.identityFolders.some(
      (folder) =>
        filePath === folder.relativeRoot ||
        Boolean(pathWithinSourceFolder(filePath, folder.relativeRoot))
    )
  );
}

function buildProjectScopeFolderModules(
  scopePropagation: ProjectContextScopePropagation,
  allFiles: readonly GenerateFileEntry[],
  projectRoot: string
): ProjectContextModule[] {
  return scopePropagation.identityFolders.flatMap((folder) => {
    const ownedFiles = allFiles
      .map((file) => file.relativePath)
      .filter((filePath) => pathWithinSourceFolder(filePath, folder.relativeRoot));
    if (ownedFiles.length === 0) {
      return [];
    }
    const moduleName = folder.displayName ?? folder.relativeRoot;
    const moduleId = buildCanonicalCoverageLedgerModuleId({
      moduleName,
      modulePath: folder.relativeRoot,
      projectRoot,
    });
    if (!moduleId) {
      return [];
    }
    return [
      {
        kind: 'project-scope-folder',
        moduleId,
        moduleName,
        modulePath: folder.relativeRoot,
        ownedFileCount: ownedFiles.length,
        ownedFiles,
        role: folder.role ?? 'source',
      },
    ];
  });
}

function dedupeProjectContextModules(
  modules: readonly ProjectContextModule[]
): ProjectContextModule[] {
  const byId = new Map<string, ProjectContextModule>();
  for (const module of modules) {
    if (!byId.has(module.moduleId)) {
      byId.set(module.moduleId, module);
    }
  }
  return [...byId.values()].sort((left, right) => left.moduleId.localeCompare(right.moduleId));
}

function buildWorkflowFiles(
  input: ProjectContextPresenterInput,
  scopePropagation: ProjectContextScopePropagation,
  fallbackFiles: readonly ProjectContextWorkflowFileCandidate[] = []
): GenerateFileEntry[] {
  const sourceTextByFile = new Map(
    input.sourceSlices.map((slice) => [slice.file.filePath, sourceSliceText(slice)])
  );
  const filesByPath = new Map<string, GenerateFileEntry>();

  for (const file of input.files) {
    const relativePath = file.filePath;
    const sourceIdentity = resolveWorkflowFileSourceIdentity(scopePropagation, relativePath);
    if (scopePropagation.identityFolders.length > 0 && !sourceIdentity) {
      continue;
    }
    filesByPath.set(relativePath, {
      content: sourceTextByFile.get(file.filePath) ?? '',
      name: basename(file.filePath),
      path: file.filePath,
      relativePath,
      ...(sourceIdentity ? { sourceIdentity } : {}),
      targetName: targetNameForFile(input, file.filePath),
    });
  }

  for (const file of fallbackFiles) {
    const relativePath = file.relativePath;
    if (filesByPath.has(relativePath)) {
      continue;
    }
    const sourceIdentity = resolveWorkflowFileSourceIdentity(scopePropagation, relativePath);
    if (scopePropagation.identityFolders.length > 0 && !sourceIdentity) {
      continue;
    }
    filesByPath.set(relativePath, {
      content: file.content ?? '',
      name: basename(relativePath),
      path: relativePath,
      relativePath,
      ...(sourceIdentity ? { sourceIdentity } : {}),
      targetName: dirname(relativePath) || 'project',
    });
  }

  return [...filesByPath.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath)
  );
}

function resolveWorkflowFileSourceIdentity(
  scopePropagation: ProjectContextScopePropagation,
  filePath: string
): ProjectScopeSourceIdentity | null {
  const normalizedFilePath = normalizeProjectContextSourcePath(filePath);
  if (!normalizedFilePath || scopePropagation.identityFolders.length === 0) {
    return null;
  }
  const folders = [...scopePropagation.identityFolders].sort(
    (left, right) => right.relativeRoot.length - left.relativeRoot.length
  );
  for (const folder of folders) {
    const folderScopedPath = pathWithinSourceFolder(normalizedFilePath, folder.relativeRoot);
    if (folderScopedPath) {
      return createCanonicalSourceIdentity({
        folderDisplayName: folder.displayName,
        folderId: folder.folderId,
        folderPath: folder.folderPath,
        projectRoot: folder.controlRoot,
        projectScopeId: folder.projectScopeId,
        sourcePath: folderScopedPath,
      });
    }
  }
  const currentFolder = scopePropagation.allowCurrentFolderRelativeIdentity
    ? folders.find(
        (folder) => folder.folderId && folder.folderId === scopePropagation.currentFolderId
      )
    : null;
  if (!currentFolder) {
    return null;
  }
  return createCanonicalSourceIdentity({
    folderDisplayName: currentFolder.displayName,
    folderId: currentFolder.folderId,
    folderPath: currentFolder.folderPath,
    projectRoot: currentFolder.controlRoot,
    projectScopeId: currentFolder.projectScopeId,
    sourcePath: normalizedFilePath,
  });
}

function pathWithinSourceFolder(filePath: string, folderRoot: string): string | null {
  if (filePath === folderRoot) {
    return null;
  }
  const prefix = `${folderRoot}/`;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : null;
}

function normalizeProjectContextSourcePath(value: string): string | null {
  const trimmed = value.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed.startsWith('/') || path.isAbsolute(trimmed)) {
    return null;
  }
  const normalized = path.posix.normalize(trimmed);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    return null;
  }
  return normalized;
}

function buildWorkflowTargets(input: ProjectContextPresenterInput): Array<Record<string, unknown>> {
  const targets = input.repo?.targets ?? [];
  if (targets.length > 0) {
    return targets.map((target) => ({
      fileCount: target.refs.length,
      name: target.name,
      type: target.kind ?? 'target',
    }));
  }
  return input.modules.map((module) => ({
    fileCount: module.ownedFiles.length,
    name: module.module.name,
    type: module.module.kind ?? 'module',
  }));
}

function buildProjectContextTargetFileMap(
  files: readonly GenerateFileEntry[]
): Record<string, Array<Record<string, unknown>>> {
  const byTarget: Record<string, Array<Record<string, unknown>>> = {};
  for (const file of files) {
    const targetName = file.targetName ?? (dirname(file.relativePath) || 'project');
    byTarget[targetName] ??= [];
    byTarget[targetName].push({
      content: file.content,
      name: file.name,
      path: file.path,
      relativePath: file.relativePath,
    });
  }
  return byTarget;
}

function buildProjectContextWorkflowReport(input: {
  allFiles: readonly GenerateFileEntry[];
  allTargets: readonly Record<string, unknown>[];
  contentMaxLines: number;
  dimensions: readonly DimensionDef[];
  maxFiles?: number;
  moduleCount: number;
  presenterInput: ProjectContextPresenterInput;
  warnings: readonly string[];
}): Record<string, unknown> {
  return {
    phases: {
      projectContext: {
        envelopeCount: input.presenterInput.envelopes.length,
        files: input.allFiles.length,
        modules: input.moduleCount,
        requestKinds: uniqueRequestKinds(
          input.presenterInput.envelopes.map((envelope) => envelope.queryLevel)
        ),
        targets: input.allTargets.length,
        truncated: input.maxFiles !== undefined && input.allFiles.length >= input.maxFiles,
      },
      workflowMetadata: {
        dimensions: input.dimensions.length,
        sourceSliceMaxLines: input.contentMaxLines,
      },
    },
    projectInformationSource: 'project-context',
    totals: {
      files: input.allFiles.length,
      projectContextRefs: input.presenterInput.refs.length,
      warnings: input.warnings.length,
    },
  };
}

function buildProjectContextSummary(
  input: ProjectContextPresenterInput,
  envelopes: readonly ProjectContextEnvelope<ProjectContextResult>[]
): Record<string, unknown> {
  return {
    envelopeCount: envelopes.length,
    files: input.files.map((file) => ({
      filePath: file.filePath,
      language: file.language,
      lineCount: file.lineCount,
      repoId: file.repoId,
    })),
    modules: input.modules.map((module) => ({
      fileCount: module.ownedFiles.length,
      id: module.module.id,
      name: module.module.name,
      role: module.module.role,
    })),
    project: input.project,
    refs: input.refs.map((ref) => ({
      filePath: ref.scope.filePath,
      id: ref.id,
      kind: ref.kind,
      label: ref.label,
      range: ref.scope.range,
      repoId: ref.scope.repoId,
    })),
    requestKinds: uniqueRequestKinds(envelopes.map((envelope) => envelope.queryLevel)),
    source: 'project-context',
    unavailable: input.unavailable,
    warnings: input.warnings,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sourceSliceText(slice: SourceSliceContext): string {
  return typeof slice.text === 'string' ? slice.text : '';
}

function targetNameForFile(input: ProjectContextPresenterInput, filePath: string): string {
  const module = input.modules.find((candidate) =>
    candidate.ownedFiles.some((file) => file.filePath === filePath)
  );
  return module?.module.name ?? (dirname(filePath) || 'project');
}

function selectProjectContextModuleSeeds(
  repo: RepoContext | undefined,
  limit: number
): ProjectContextModuleSeed[] {
  if (!repo) {
    return [];
  }
  const candidates: ProjectContextModuleSeed[] = [
    ...repo.localPackages.map((pkg) => ({
      kind: 'local-package',
      moduleName: pkg.name,
      modulePath: normalizeModulePath(pkg.path ?? pkg.ref?.scope.filePath),
      ref: pkg.ref,
      role: 'local-package',
    })),
    ...repo.sourceRoots.map((root) => ({
      kind: 'source-root',
      moduleName: moduleNameFromPath(root.path, root.role ?? 'source'),
      modulePath: normalizeModulePath(root.path),
      ref: root.ref,
      role: root.role ?? 'source-root',
    })),
    ...repo.topAreas.map((area) => ({
      kind: 'top-area',
      moduleName: moduleNameFromPath(area.path, area.role ?? 'area'),
      modulePath: normalizeModulePath(area.path),
      ref: area.ref,
      role: area.role ?? 'top-area',
    })),
    ...repo.entrypoints.flatMap((entrypoint) =>
      entrypoint.refs.flatMap((ref) => seedFromFileRef(ref, entrypoint.name, entrypoint.kind))
    ),
    ...repo.targets.flatMap((target) =>
      target.refs.flatMap((ref) => seedFromFileRef(ref, target.name, target.kind ?? 'target'))
    ),
  ].filter(hasUsableSeedScope);

  return dedupeModuleSeeds(candidates).slice(0, limit);
}

function seedFromFileRef(
  ref: ProjectContextRef,
  moduleName: string,
  role: string
): ProjectContextModuleSeed[] {
  const filePath = ref.scope.filePath;
  if (!filePath) {
    return [];
  }
  return [
    {
      kind: 'file-anchor',
      moduleName: moduleNameFromPath(filePath, moduleName),
      ownedFiles: [filePath],
      ref,
      role,
    },
  ];
}

function selectProjectContextDetailFiles(
  envelopes: readonly ProjectContextEnvelope<ProjectContextResult>[],
  limit: number
): string[] {
  const fromModules = envelopes.flatMap((envelope) =>
    isModuleContext(envelope.data) ? envelope.data.ownedFiles.map((file) => file.filePath) : []
  );
  const fromRefs = envelopes.flatMap((envelope) =>
    envelope.refs.flatMap((ref) => (ref.scope.filePath ? [ref.scope.filePath] : []))
  );
  return dedupeStrings([...fromModules, ...fromRefs])
    .filter((filePath) => !filePath.endsWith('/'))
    .slice(0, limit);
}

function buildLanguageStats(
  input: ProjectContextPresenterInput,
  allFiles: readonly GenerateFileEntry[],
  scopePropagation: ProjectContextScopePropagation
): Record<string, number> {
  const stats: Record<string, number> = {};
  const preferScopedFiles =
    scopePropagation.identityFolders.length > 0 &&
    allFiles.some((file) => Boolean(file.sourceIdentity));
  if (!preferScopedFiles) {
    for (const language of input.repo?.languages ?? []) {
      stats[language.language] = language.fileCount ?? 0;
    }
  }
  for (const file of input.files) {
    if (file.language && stats[file.language] === undefined) {
      stats[file.language] = (stats[file.language] ?? 0) + 1;
    }
  }
  for (const file of allFiles) {
    const language = languageFromProjectScopeFilePath(file.relativePath);
    if (language) {
      stats[language] = (stats[language] ?? 0) + 1;
    }
  }
  return stats;
}

function inferProjectContextPrimaryLanguage(languageStats: Record<string, number>): string {
  return (
    Object.entries(languageStats).sort(
      ([leftLanguage, leftCount], [rightLanguage, rightCount]) =>
        rightCount - leftCount || leftLanguage.localeCompare(rightLanguage)
    )[0]?.[0] ?? 'unknown'
  );
}

function inferProjectContextSecondaryLanguages(
  languageStats: Record<string, number>,
  primaryLang: string
): string[] {
  return Object.keys(languageStats)
    .filter((language) => language !== primaryLang)
    .sort();
}

function inferProjectContextProjectType(input: ProjectContextPresenterInput): string {
  return (
    input.repo?.packageSystems[0]?.kind ??
    input.repo?.buildSystems[0]?.kind ??
    input.repo?.repo.name ??
    'project-context'
  );
}

function hasUsableSeedScope(seed: ProjectContextModuleSeed): boolean {
  return Boolean(seed.ownedFiles?.length || normalizeModulePath(seed.modulePath));
}

function normalizeModulePath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === '.') {
    return undefined;
  }
  return trimmed.replace(/\\/g, '/').replace(/\/$/, '');
}

function moduleNameFromPath(pathValue: string, fallback: string): string {
  return (
    pathValue
      .split(/[\\/]/)
      .filter(Boolean)
      .pop()
      ?.replace(/\.[^.]+$/, '') || fallback
  );
}

function dedupeModuleSeeds(seeds: readonly ProjectContextModuleSeed[]): ProjectContextModuleSeed[] {
  const byKey = new Map<string, ProjectContextModuleSeed>();
  for (const seed of seeds) {
    const key = `${seed.modulePath ?? seed.ownedFiles?.join(',') ?? ''}:${seed.moduleName}`;
    if (!byKey.has(key)) {
      byKey.set(key, seed);
    }
  }
  return [...byKey.values()];
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function uniqueRequestKinds(
  values: readonly ProjectContextRequestKind[]
): ProjectContextRequestKind[] {
  return [...new Set(values)];
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function isRepoContext(value: ProjectContextResult): value is RepoContext {
  return 'repo' in value && 'targets' in value && 'sourceRoots' in value;
}

function isModuleContext(value: ProjectContextResult): value is ModuleContext {
  return 'module' in value && 'ownedFiles' in value && 'publicSurfaces' in value;
}

export function isSpaceContext(value: ProjectContextResult): value is SpaceContext {
  return 'space' in value && 'sourceFolders' in value;
}

export function isProjectMapContext(value: ProjectContextResult): value is ProjectMap {
  return 'modules' in value && 'dependencySummary' in value && 'majorFlows' in value;
}

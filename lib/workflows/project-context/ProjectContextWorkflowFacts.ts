import { basename, dirname } from 'node:path';
import {
  baseDimensions,
  buildIDEAgentAnalysisPacketFromProjectContext,
  buildProjectContextMissionBriefing,
  type DimensionDef,
  getOrCreateSessionManager,
  type KnowledgeRescanExecutionDecision,
} from '@alembic/core/host-agent-workflows';
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
import type { BootstrapSessionShape, FileDiffPlan } from '@alembic/core/types';
import {
  readLatestProjectContextFileSnapshotRow,
  saveProjectContextFileSnapshotRow,
} from '../../infrastructure/database/SqliteDatabaseAccess.js';
import type { ProjectScopeAnalysisContext } from '../../project-scope/ProjectScopeAnalysis.js';
import type { BootstrapFileEntry } from '../ai-execution/AgentRunInputBuilders.js';
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
  allFiles: BootstrapFileEntry[];
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
  readonly bootstrapSession: BootstrapSessionShape | null;
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
  ideAgentPacket: { profile?: unknown; [key: string]: unknown };
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

  const spaceEnvelope = await executeProjectContextRequest(
    'space',
    input.projectRoot,
    input.source,
    {
      includeProjectTree: true,
    }
  );
  const firstRepoEnvelope = await executeProjectContextRequest(
    'repo',
    input.projectRoot,
    input.source,
    {
      ...basePayload,
      includeMapSummary: false,
    }
  );
  const repoData = isRepoContext(firstRepoEnvelope.data) ? firstRepoEnvelope.data : undefined;
  const moduleSeeds = selectProjectContextModuleSeeds(repoData, maxModuleSeeds);
  const repoEnvelope =
    moduleSeeds.length > 0
      ? await executeProjectContextRequest('repo', input.projectRoot, input.source, {
          ...basePayload,
          includeMapSummary: true,
          moduleSeeds,
        })
      : firstRepoEnvelope;
  const envelopes: ProjectContextEnvelope<ProjectContextResult>[] = [spaceEnvelope, repoEnvelope];

  if (moduleSeeds.length > 0) {
    envelopes.push(
      await executeProjectContextRequest('map', input.projectRoot, input.source, {
        moduleSeeds,
        repoName: repoData?.repo.name,
      })
    );
  }

  for (const seed of moduleSeeds.slice(0, maxModuleDetails)) {
    envelopes.push(
      await executeProjectContextRequest('module', input.projectRoot, input.source, {
        ...seed,
        includeDependencies: true,
        includePublicSurfaces: true,
      })
    );
    envelopes.push(
      await executeProjectContextRequest('module-layers', input.projectRoot, input.source, {
        ...seed,
        includeBoundaryCrossings: true,
      })
    );
  }

  const detailFiles = selectProjectContextDetailFiles(envelopes, maxFileDetails);
  for (const filePath of detailFiles) {
    envelopes.push(
      await executeProjectContextRequest('file-flow', input.projectRoot, input.source, {
        filePath,
      })
    );
    envelopes.push(
      await executeProjectContextRequest('file-symbols', input.projectRoot, input.source, {
        filePath,
      })
    );
    envelopes.push(
      await executeProjectContextRequest('source-slice', input.projectRoot, input.source, {
        endLine: contentMaxLines,
        filePath,
        includeText: true,
        startLine: 1,
      })
    );
    envelopes.push(
      await executeProjectContextRequest('anchor-range', input.projectRoot, input.source, {
        afterLines: Math.min(8, contentMaxLines),
        beforeLines: 0,
        filePath,
        includeRelations: false,
        includeSourceSlices: true,
        includeSymbols: true,
        line: 1,
        relationHops: 0,
      })
    );
  }

  const presenterInput = buildProjectContextPresenterInput(envelopes);
  const primaryLang = inferProjectContextPrimaryLanguage(presenterInput);
  const secondaryLanguages = inferProjectContextSecondaryLanguages(presenterInput, primaryLang);
  const dimensions: DimensionDef[] = [...baseDimensions];
  const allFiles = buildWorkflowFiles(presenterInput);
  const allTargets = buildWorkflowTargets(presenterInput);
  const filesByTarget = buildProjectContextTargetFileMap(allFiles);
  const projectMapModules = buildProjectMapModules(presenterInput.map);
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
    languageStats: buildLanguageStats(presenterInput),
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
}): ProjectContextWorkflowSession {
  const sessionManager = getOrCreateSessionManager(input.container);
  return sessionManager.createSession(buildProjectContextWorkflowSessionOptions(input));
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

export function registerProjectContextWorkflowSessionReleaseOnBootstrapCompletion(input: {
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

    eventBus.off?.('bootstrap:all-completed', listener);
    if (!isReleasableBootstrapCompletionEvent(event)) {
      input.logger.warn('[ProjectContextWorkflowFacts] Workflow session lease retained', {
        bootstrapSessionId: input.bootstrapSessionId,
        reason: 'bootstrap-session-not-clean-complete',
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
      reason: `${input.workflow}:bootstrap-session-completed`,
      workflowSessionId: input.workflowSessionId,
    });
  };

  eventBus.on('bootstrap:all-completed', listener);
  return () => eventBus.off?.('bootstrap:all-completed', listener);
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
  const ideAgentPacket = buildIDEAgentAnalysisPacketFromProjectContext({
    dimensions: input.dimensions,
    options: {
      profile: input.profile,
      projectRoot: input.facts.projectRoot,
    },
    projectContext: input.facts.presenterInput,
  });
  return {
    briefing: briefing as ProjectContextMissionArtifacts['briefing'],
    ideAgentPacket: ideAgentPacket as unknown as ProjectContextMissionArtifacts['ideAgentPacket'],
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

function isReleasableBootstrapCompletionEvent(event: Record<string, unknown>): boolean {
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
  bootstrapSession: BootstrapSessionShape | null;
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
  allFiles: BootstrapFileEntry[];
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
  payload?: Record<string, unknown>
): Promise<ProjectContextEnvelope<ProjectContextResult>> {
  return ProjectContextCapabilities.execute({
    kind,
    payload,
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

function buildProjectContextFileDiffPlan(input: {
  allDimensionIds: string[];
  allFiles: BootstrapFileEntry[];
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

function buildWorkflowFiles(input: ProjectContextPresenterInput): BootstrapFileEntry[] {
  const sourceTextByFile = new Map(
    input.sourceSlices.map((slice) => [slice.file.filePath, sourceSliceText(slice)])
  );
  return input.files.map((file) => {
    const relativePath = file.filePath;
    return {
      content: sourceTextByFile.get(file.filePath) ?? '',
      name: basename(file.filePath),
      path: file.filePath,
      relativePath,
      targetName: targetNameForFile(input, file.filePath),
    };
  });
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
  files: readonly BootstrapFileEntry[]
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
  allFiles: readonly BootstrapFileEntry[];
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

function buildLanguageStats(input: ProjectContextPresenterInput): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const language of input.repo?.languages ?? []) {
    stats[language.language] = language.fileCount ?? 0;
  }
  for (const file of input.files) {
    if (file.language && stats[file.language] === undefined) {
      stats[file.language] = (stats[file.language] ?? 0) + 1;
    }
  }
  return stats;
}

function inferProjectContextPrimaryLanguage(input: ProjectContextPresenterInput): string {
  const languages = input.repo?.languages ?? [];
  return (
    [...languages].sort((left, right) => (right.fileCount ?? 0) - (left.fileCount ?? 0))[0]
      ?.language ?? 'unknown'
  );
}

function inferProjectContextSecondaryLanguages(
  input: ProjectContextPresenterInput,
  primaryLang: string
): string[] {
  return (input.repo?.languages ?? [])
    .map((language) => language.language)
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

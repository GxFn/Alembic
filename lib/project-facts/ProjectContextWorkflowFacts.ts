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
import type {
  ProjectContextEnvelope,
  ProjectContextPresenterInput,
  ProjectContextRef,
  ProjectContextRequestKind,
  ProjectContextResult,
  ProjectMap,
  SourceSliceContext,
  SpaceContext,
} from '@alembic/core/project-context';
import {
  collectPlanProjectContext,
  isProjectCodeFile,
  type PlanCollectionReport,
  type PlanCollectScope,
  type PlanCollectSourceFolder,
  type PlanModuleSeed,
} from '@alembic/core/service/planFacts';
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
import {
  type MainCertifiedProjectFactsCarrier,
  serializeMainCertifiedProjectFactsCarrier,
} from './CertifiedProjectFactsRuntime.js';
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
  certifiedProjectFacts?: MainCertifiedProjectFactsCarrier;
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

export interface BuildProjectContextWorkflowFactsInput {
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
  /** 划分给出的模块种类（target / area / root）或 project-scope-folder。 */
  kind?: string;
  /** 划分给出的模块文件数。 */
  fileCount?: number;
  moduleId?: string;
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
  /** ProjectScope 的控制根；范围里的路径都相对它。没有 ProjectScope 时为 null。 */
  controlRoot: string | null;
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

/**
 * 采集改由 Core 的共用采集器完成（F6，2026-10-06）：请求顺序、种子（仓库的模块划分）、源码清单、
 * 语言统计都在 Core；这里只留主体自己的那层——ProjectScope 展开、源码身份标记、allFiles /
 * filesByTarget、增量计划、报告与摘要。模块种子默认不设上限（2026-10-06 决定：旧默认值 6 按文件数
 * 留大的会留下一半测试目标、丢掉 src 根与 shared 这类模块；划分出的模块数本身有界）；模块明细与
 * 文件明细沿用原来的默认值（3 / 8、正文 120 行）。
 */
export async function buildProjectContextWorkflowFacts(
  input: BuildProjectContextWorkflowFactsInput
): Promise<ProjectContextWorkflowFacts> {
  const maxFiles = readPositiveInteger(input.maxFiles);
  const maxModuleSeeds = input.maxModuleSeeds;
  const maxModuleDetails = input.maxModuleDetails ?? 3;
  const maxFileDetails = input.maxFileDetails ?? 8;
  const contentMaxLines = input.contentMaxLines ?? 120;
  const scopePropagation = buildProjectContextScopePropagation(
    input.analysisScope,
    input.projectRoot
  );
  // 范围里的路径都相对控制根；没有 ProjectScope 时控制根就是项目根。
  const collectRoot = scopePropagation.controlRoot ?? input.projectRoot;
  const analysis = await collectPlanProjectContext(collectRoot, undefined, {
    limits: {
      ...(maxFiles !== undefined ? { maxFiles } : {}),
      maxFileDetails,
      maxModuleDetails,
      ...(maxModuleSeeds !== undefined ? { maxModuleSeeds } : {}),
      sourceSliceLines: contentMaxLines,
    },
    scope: buildPlanCollectScope(input.projectRoot, scopePropagation),
    source: input.source,
  });

  const presenterInput = analysis.presenterInput;
  const envelopes = analysis.envelopes;
  const dimensions: DimensionDef[] = [...baseDimensions];
  const scopedSourceFiles: ProjectContextWorkflowFileCandidate[] = analysis.sourceFileFacts
    .filter((fact) => isProjectCodeFile(fact.filePath, fact.language))
    .map((fact) => ({ language: fact.language, relativePath: fact.filePath }));
  const allFiles = buildWorkflowFiles(presenterInput, scopePropagation, scopedSourceFiles);
  const languageStats = analysis.languageStats ?? {};
  const primaryLang = analysis.primaryLanguage;
  const secondaryLanguages = analysis.secondaryLanguages;
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
  const moduleSeeds = analysis.moduleSeeds.map(toWorkflowModuleSeed);
  const warnings = [
    ...presenterInput.warnings.map((warning) => `${warning.queryLevel}:${warning.message}`),
    ...presenterInput.unavailable.map(
      (unavailable) => `${unavailable.queryLevel}:${unavailable.kind}:${unavailable.reason}`
    ),
  ];

  input.ctx.logger.info('[ProjectContextWorkflowFacts] ProjectContext facts ready', {
    collection: analysis.collection,
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
    projectType: analysis.projectType,
    report: buildProjectContextWorkflowReport({
      allFiles,
      allTargets,
      collection: analysis.collection,
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
      ...(input.facts.certifiedProjectFacts
        ? {
            certifiedProjectFacts: serializeMainCertifiedProjectFactsCarrier(
              input.facts.certifiedProjectFacts
            ),
          }
        : {}),
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

/**
 * 交给 Core 采集器的范围：ProjectScope 的成员文件夹原样作为 space 的文件夹对象，第一个文件夹
 * （primary-source）是 repo 的主仓库。没有 ProjectScope 时只给显示名，采集器按 projectRoot 自己处理。
 */
function buildPlanCollectScope(
  projectRoot: string,
  scopePropagation: ProjectContextScopePropagation
): PlanCollectScope {
  const sourceFolders = (scopePropagation.sourceFolderPayloads ?? []).map(
    (folder): PlanCollectSourceFolder => ({
      path: folder.path,
      ...(folder.displayName ? { displayName: folder.displayName } : {}),
      ...((folder.folderId ?? folder.id) ? { id: folder.folderId ?? folder.id } : {}),
      ...((folder.repositoryId ?? folder.repoId)
        ? { repositoryId: folder.repositoryId ?? folder.repoId }
        : {}),
      ...(folder.role ? { role: folder.role } : {}),
    })
  );
  const primarySourceFolder = scopePropagation.sourceFolders?.[0];
  return {
    displayName: basename(projectRoot),
    ...(sourceFolders.length > 0 ? { sourceFolders } : {}),
    ...(primarySourceFolder ? { repoRoot: primarySourceFolder } : {}),
  };
}

function toWorkflowModuleSeed(seed: PlanModuleSeed): ProjectContextModuleSeed {
  return {
    ...(seed.kind ? { kind: seed.kind } : {}),
    ...(seed.fileCount !== undefined ? { fileCount: seed.fileCount } : {}),
    ...(seed.moduleId ? { moduleId: seed.moduleId } : {}),
    moduleName: seed.moduleName,
    ...(seed.modulePath ? { modulePath: seed.modulePath } : {}),
    ...(seed.ownedFiles ? { ownedFiles: [...seed.ownedFiles] } : {}),
    ...(seed.ref ? { ref: seed.ref } : {}),
    ...(seed.role ? { role: seed.role } : {}),
  };
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
      controlRoot: null,
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
    controlRoot,
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
  collection?: PlanCollectionReport;
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
        // 采集回执（种子来源、按上限丢掉的模块、明细文件）原样进报告，便于复核。
        ...(input.collection ? { collection: input.collection } : {}),
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

export function isSpaceContext(value: ProjectContextResult): value is SpaceContext {
  return 'space' in value && 'sourceFolders' in value;
}

export function isProjectMapContext(value: ProjectContextResult): value is ProjectMap {
  return 'modules' in value && 'dependencySummary' in value && 'majorFlows' in value;
}

import Logger from '#infra/logging/Logger.js';
import { BootstrapEventEmitter } from '#service/bootstrap/BootstrapEventEmitter.js';
import { getDeveloperIdentity } from '#shared/developer-identity.js';
import { resolveDataRoot } from '#shared/resolveProjectRoot.js';
import type { DimensionDef } from '#types/project-snapshot.js';
import {
  runWorkflowCompletionFinalizer,
  type WorkflowCompletionFinalizerDependencies,
} from '#workflows/capabilities/completion/WorkflowCompletionFinalizer.js';
import { BOOTSTRAP_COMPLETE_ACTIONS } from '#workflows/capabilities/execution/external/MissionBriefingSupport.js';
import { generateSkill as generateWorkflowSkill } from '#workflows/capabilities/execution/WorkflowSkillCompletionCapability.js';
import { saveDimensionCheckpoint } from '#workflows/capabilities/persistence/DimensionCheckpoint.js';

const logger = Logger.getInstance();

export interface ExternalDimensionCompleteArgs {
  sessionId?: unknown;
  dimensionId?: unknown;
  submittedRecipeIds?: unknown;
  analysisText?: unknown;
  referencedFiles?: unknown;
  keyFindings?: unknown;
  candidateCount?: unknown;
  crossDimensionHints?: unknown;
  [key: string]: unknown;
}

interface ExternalCompletionLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  debug?(msg: string, meta?: Record<string, unknown>): void;
}

export interface ExternalSessionContainer {
  get(name: string): unknown;
  services?: Record<string, unknown>;
  singletons?: Record<string, unknown>;
}

interface ExternalCompletionContainer extends ExternalSessionContainer {
  get(name: string): unknown;
}

export interface ExternalDimensionCompletionContext {
  container: ExternalCompletionContainer;
  logger?: ExternalCompletionLogger;
  [key: string]: unknown;
}

export interface ExternalDimensionCompletionResponse<T = unknown> {
  success: boolean;
  data?: T | null;
  message?: string;
  meta?: Record<string, unknown>;
  errorCode?: string | null;
}

export interface ExternalDimensionCompletionDependencies {
  getActiveSession?: (
    container: ExternalSessionContainer,
    sessionId?: string
  ) => Promise<ExternalWorkflowSession | null> | ExternalWorkflowSession | null;
  generateSkill?: GenerateExternalDimensionSkill;
  saveCheckpoint?: typeof saveDimensionCheckpoint;
  createEmitter?: (container: ExternalCompletionContainer) => ExternalDimensionCompletionEmitter;
  now?: () => number;
  runCompletionFinalizer?: typeof runWorkflowCompletionFinalizer;
  finalizerDependencies?: WorkflowCompletionFinalizerDependencies;
}

type GenerateExternalDimensionSkill = (
  ctx: ExternalDimensionCompletionContext,
  dimension: DimensionDef,
  analysisText: string,
  referencedFiles: string[],
  keyFindings: string[],
  source: string
) => Promise<{ success: boolean; error?: string }>;

export interface ExternalWorkflowSession {
  id: string;
  projectRoot: string;
  expiresAt?: number;
  dimensions: DimensionDef[];
  submissionTracker: {
    getSubmissions(dimId: string): Array<{ recipeId?: string; sources: string[] }>;
    getAccumulatedEvidence(dimId: string): unknown;
  };
  sessionStore: {
    getDimensionReport(dimId: string): unknown;
  };
  getSnapshotCache?(): {
    localPackageModules?: Array<{ packageName: string; name: string }>;
  } | null;
  getProgress(): {
    completed: number;
    total: number;
    completedDimIds: string[];
    remainingDimIds: string[];
  };
  readonly isComplete: boolean;
  markDimensionComplete(
    dimensionId: string,
    report: {
      analysisText: string;
      keyFindings: string[];
      referencedFiles: string[];
      recipeIds: string[];
      candidateCount: number;
    }
  ): {
    updated: boolean;
    qualityReport?: {
      totalScore: number;
      pass: boolean;
      scores: Record<string, number>;
      suggestions: string[];
    };
  };
  storeHints(dimId: string, hints: Record<string, unknown>): void;
  getAccumulatedHints(): Record<string, unknown>;
}

interface ExternalDimensionCompletionEmitter {
  emitDimensionComplete(
    dimId: string,
    data: Parameters<BootstrapEventEmitter['emitDimensionComplete']>[1]
  ): void;
  emitAllComplete(sessionId: string, total: number, source: string): void;
}

interface KnowledgeEntryLike {
  tags?: string[] | string;
  title?: string;
  description?: string;
  whenClause?: string;
  doClause?: string;
  dontClause?: string;
  coreCode?: string;
}

interface KnowledgeServiceLike {
  get(recipeId: string): Promise<KnowledgeEntryLike | null> | KnowledgeEntryLike | null;
  update(
    recipeId: string,
    patch: { category?: string; tags?: string[] },
    options: { userId: string }
  ): Promise<unknown> | unknown;
}

interface KnowledgeGraphServiceLike {
  addEdge(
    fromId: string,
    fromType: string,
    toId: string,
    toType: string,
    relation: string,
    meta?: Record<string, unknown>
  ): Promise<unknown> | unknown;
}

interface AccumulatedEvidenceLike {
  completedDimSummaries: Array<{
    dimId: string;
    submissionCount: number;
    titles: string[];
    referencedFiles: string[];
  }>;
  sharedFiles: unknown[];
  negativeSignals: Array<{ pattern?: string }>;
  usedTriggers: string[];
}

interface DimensionReportLike {
  analysisText?: string;
  findings?: Array<{ finding?: string; content?: string }>;
}

interface CompletionInput {
  sessionId?: string;
  dimensionId: string;
  submittedRecipeIds: string[];
  analysisText: string;
  referencedFiles: string[];
  keyFindings: string[];
  candidateCount?: number;
  crossDimensionHints?: Record<string, unknown>;
}

export async function runExternalDimensionCompletionWorkflow(
  ctx: ExternalDimensionCompletionContext,
  args: ExternalDimensionCompleteArgs,
  dependencies: ExternalDimensionCompletionDependencies = {}
): Promise<ExternalDimensionCompletionResponse> {
  const startedAtMs = dependencies.now?.() ?? Date.now();
  const input = normalizeCompletionInput(args);
  if (!input.success) {
    return input.response;
  }

  const session = await resolveExternalCompletionSession({ ctx, input: input.value, dependencies });
  if (!session.success) {
    return session.response;
  }

  extendSessionTtl(session.value);

  const dimension = session.value.dimensions.find(
    (dim: { id: string }) => dim.id === input.value.dimensionId
  );
  if (!dimension) {
    return validationFailure(
      `Unknown dimensionId: "${input.value.dimensionId}". Valid dimensions: ${session.value.dimensions.map((dim: { id: string }) => dim.id).join(', ')}`,
      'VALIDATION_ERROR'
    );
  }

  const projectRoot = session.value.projectRoot;
  const dataRoot = resolveDataRoot(ctx.container as never) || projectRoot;
  const referencedFiles =
    input.value.referencedFiles.length > 0
      ? input.value.referencedFiles
      : recoverReferencedFiles(session.value, input.value.dimensionId);
  const submittedRecipeIds =
    input.value.submittedRecipeIds.length > 0
      ? input.value.submittedRecipeIds
      : recoverSubmittedRecipeIds(session.value, input.value.dimensionId);

  const recipesBound = await bindSubmittedRecipes({
    ctx,
    session: session.value,
    dimensionId: input.value.dimensionId,
    submittedRecipeIds,
  });
  const skillCreated = await createExternalDimensionSkill({
    ctx,
    dimension,
    dimensionId: input.value.dimensionId,
    analysisText: input.value.analysisText,
    referencedFiles,
    keyFindings: input.value.keyFindings,
    submittedRecipeIds,
    dependencies,
  });

  const { updated, qualityReport } = session.value.markDimensionComplete(input.value.dimensionId, {
    analysisText: input.value.analysisText,
    keyFindings: input.value.keyFindings,
    referencedFiles,
    recipeIds: submittedRecipeIds,
    candidateCount: input.value.candidateCount || submittedRecipeIds.length,
  });

  await persistDimensionCheckpoint({
    session: session.value,
    dataRoot,
    dimensionId: input.value.dimensionId,
    candidateCount: input.value.candidateCount || submittedRecipeIds.length,
    analysisText: input.value.analysisText,
    referencedFiles,
    submittedRecipeIds,
    skillCreated,
    dependencies,
  });
  await persistKeyFindings({
    ctx,
    session: session.value,
    dimensionId: input.value.dimensionId,
    keyFindings: input.value.keyFindings,
  });

  const progress = session.value.getProgress();
  const isComplete = session.value.isComplete;
  emitExternalCompletionProgress({
    ctx,
    session: session.value,
    dimension,
    dimensionId: input.value.dimensionId,
    candidateCount: input.value.candidateCount || submittedRecipeIds.length,
    skillCreated,
    recipesBound,
    progress,
    isComplete,
    dependencies,
  });

  const completionFinalizer = isComplete
    ? await (dependencies.runCompletionFinalizer ?? runWorkflowCompletionFinalizer)({
        ctx,
        session: session.value,
        projectRoot,
        dataRoot,
        log: logger,
        dependencies: dependencies.finalizerDependencies,
      })
    : { deliveryVerification: null, semanticMemoryResult: null };

  if (input.value.crossDimensionHints) {
    session.value.storeHints(input.value.dimensionId, input.value.crossDimensionHints);
  }

  const accumulatedHints = session.value.getAccumulatedHints();
  const accumulatedEvidence = session.value.submissionTracker.getAccumulatedEvidence(
    input.value.dimensionId
  ) as AccumulatedEvidenceLike;

  const qualityFeedback = buildQualityFeedback({
    dimensionId: input.value.dimensionId,
    qualityReport,
  });
  const evidenceHints = buildEvidenceHints({
    session: session.value,
    isComplete,
    accumulatedEvidence,
  });
  const subpackageCoverageWarning = buildSubpackageCoverageWarning({
    session: session.value,
    dimensionId: input.value.dimensionId,
    referencedFiles,
  });

  return {
    success: true,
    data: {
      dimensionId: input.value.dimensionId,
      updated,
      skillCreated,
      recipesBound,
      progress: `${progress.completed}/${progress.total}`,
      completedDimensions: progress.completedDimIds,
      remainingDimensions: progress.remainingDimIds,
      isBootstrapComplete: isComplete,
      accumulatedHints: Object.keys(accumulatedHints).length > 0 ? accumulatedHints : undefined,
      qualityFeedback,
      evidenceHints,
      subpackageCoverageWarning,
      deliveryVerification: isComplete ? completionFinalizer.deliveryVerification : undefined,
      nextActions: isComplete ? BOOTSTRAP_COMPLETE_ACTIONS : undefined,
    },
    meta: {
      tool: 'alembic_dimension_complete',
      responseTimeMs: (dependencies.now?.() ?? Date.now()) - startedAtMs,
    },
  };
}

function normalizeCompletionInput(
  args: ExternalDimensionCompleteArgs
):
  | { success: true; value: CompletionInput }
  | { success: false; response: ExternalDimensionCompletionResponse } {
  const dimensionId = typeof args.dimensionId === 'string' ? args.dimensionId : undefined;
  const analysisText = typeof args.analysisText === 'string' ? args.analysisText : undefined;
  const submittedRecipeIds = args.submittedRecipeIds ?? [];

  if (!dimensionId) {
    return {
      success: false,
      response: validationFailure('Missing required parameter: dimensionId'),
    };
  }
  if (!analysisText || analysisText.length < 10) {
    return {
      success: false,
      response: validationFailure('analysisText is required and must be at least 10 characters'),
    };
  }
  if (!Array.isArray(submittedRecipeIds)) {
    return {
      success: false,
      response: validationFailure('submittedRecipeIds must be an array of recipe ID strings'),
    };
  }

  return {
    success: true,
    value: {
      sessionId: typeof args.sessionId === 'string' ? args.sessionId : undefined,
      dimensionId,
      submittedRecipeIds: submittedRecipeIds.filter((id): id is string => typeof id === 'string'),
      analysisText,
      referencedFiles: stringArray(args.referencedFiles),
      keyFindings: stringArray(args.keyFindings),
      candidateCount: typeof args.candidateCount === 'number' ? args.candidateCount : undefined,
      crossDimensionHints:
        args.crossDimensionHints && typeof args.crossDimensionHints === 'object'
          ? (args.crossDimensionHints as Record<string, unknown>)
          : undefined,
    },
  };
}

async function resolveExternalCompletionSession({
  ctx,
  input,
  dependencies,
}: {
  ctx: ExternalDimensionCompletionContext;
  input: CompletionInput;
  dependencies: ExternalDimensionCompletionDependencies;
}): Promise<
  | { success: true; value: ExternalWorkflowSession }
  | { success: false; response: ExternalDimensionCompletionResponse }
> {
  const getActiveSession = dependencies.getActiveSession ?? getActiveExternalWorkflowSession;
  const session = await getActiveSession(ctx.container, input.sessionId);
  if (session) {
    return { success: true, value: session };
  }

  return {
    success: false,
    response: {
      success: false,
      message: input.sessionId
        ? `No active bootstrap session found with id: ${input.sessionId}`
        : 'No active bootstrap session. Call alembic_bootstrap first.',
      errorCode: 'SESSION_NOT_FOUND',
      meta: { tool: 'alembic_dimension_complete' },
    },
  };
}

async function getActiveExternalWorkflowSession(
  container: ExternalSessionContainer,
  sessionId?: string
): Promise<ExternalWorkflowSession | null> {
  const { getActiveExternalWorkflowSession } = await import(
    '#workflows/capabilities/execution/external/ExternalMissionWorkflow.js'
  );
  return getActiveExternalWorkflowSession(
    container as never,
    sessionId
  ) as ExternalWorkflowSession | null;
}

function extendSessionTtl(session: ExternalWorkflowSession): void {
  if (session.expiresAt) {
    session.expiresAt = Math.max(session.expiresAt, Date.now() + 60 * 60 * 1000);
  }
}

function recoverReferencedFiles(session: ExternalWorkflowSession, dimensionId: string): string[] {
  try {
    const submissions = session.submissionTracker.getSubmissions(dimensionId);
    const filesFromSources = new Set<string>();
    for (const submission of submissions) {
      for (const source of submission.sources) {
        filesFromSources.add(source.split(':')[0]);
      }
    }
    if (filesFromSources.size > 0) {
      logger.debug(
        `[DimensionComplete] Auto-recovered ${filesFromSources.size} referencedFiles from submissions for "${dimensionId}"`
      );
    }
    return [...filesFromSources];
  } catch {
    return [];
  }
}

function recoverSubmittedRecipeIds(
  session: ExternalWorkflowSession,
  dimensionId: string
): string[] {
  try {
    const recoveredIds = session.submissionTracker
      .getSubmissions(dimensionId)
      .map((submission) => submission.recipeId)
      .filter((id): id is string => Boolean(id));
    if (recoveredIds.length > 0) {
      logger.debug(
        `[DimensionComplete] Auto-recovered ${recoveredIds.length} submittedRecipeIds from tracker for "${dimensionId}"`
      );
    }
    return recoveredIds;
  } catch {
    return [];
  }
}

async function bindSubmittedRecipes({
  ctx,
  session,
  dimensionId,
  submittedRecipeIds,
}: {
  ctx: ExternalDimensionCompletionContext;
  session: ExternalWorkflowSession;
  dimensionId: string;
  submittedRecipeIds: string[];
}): Promise<number> {
  if (submittedRecipeIds.length === 0) {
    return 0;
  }

  let recipesBound = 0;
  try {
    const knowledgeService = ctx.container.get('knowledgeService') as KnowledgeServiceLike | null;
    if (!knowledgeService) {
      return recipesBound;
    }

    for (const recipeId of submittedRecipeIds) {
      try {
        const entry = await knowledgeService.get(recipeId);
        if (!entry) {
          continue;
        }
        const newTags = [
          ...new Set([
            ...parseExistingTags(entry.tags),
            `dimension:${dimensionId}`,
            `bootstrap:${session.id}`,
          ]),
        ];
        await knowledgeService.update(
          recipeId,
          { category: dimensionId, tags: newTags },
          { userId: getDeveloperIdentity() }
        );
        recipesBound++;
      } catch (err: unknown) {
        logger.debug(
          `[DimensionComplete] Failed to tag recipe ${recipeId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  } catch (err: unknown) {
    logger.warn(
      `[DimensionComplete] Recipe tagging failed (degraded): ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return recipesBound;
}

function parseExistingTags(tags: string[] | string | undefined): string[] {
  if (Array.isArray(tags)) {
    return tags;
  }
  if (typeof tags !== 'string') {
    return [];
  }
  try {
    const parsed = JSON.parse(tags) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === 'string')
      : [];
  } catch {
    return tags
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
}

async function createExternalDimensionSkill({
  ctx,
  dimension,
  dimensionId,
  analysisText,
  referencedFiles,
  keyFindings,
  submittedRecipeIds,
  dependencies,
}: {
  ctx: ExternalDimensionCompletionContext;
  dimension: DimensionDef;
  dimensionId: string;
  analysisText: string;
  referencedFiles: string[];
  keyFindings: string[];
  submittedRecipeIds: string[];
  dependencies: ExternalDimensionCompletionDependencies;
}): Promise<boolean> {
  if (!dimension.skillWorthy) {
    return false;
  }

  const effectiveAnalysis = await synthesizeSkillAnalysisIfNeeded({
    ctx,
    dimension,
    dimensionId,
    analysisText,
    keyFindings,
    submittedRecipeIds,
  });
  const generateSkill = dependencies.generateSkill ?? generateWorkflowSkill;
  const skillResult = await generateSkill(
    ctx,
    dimension,
    effectiveAnalysis,
    referencedFiles,
    keyFindings,
    'external-agent-bootstrap'
  );
  if (!skillResult.success) {
    logger.warn(`[DimensionComplete] Skill skipped for "${dimensionId}": ${skillResult.error}`);
  }
  return skillResult.success;
}

async function synthesizeSkillAnalysisIfNeeded({
  ctx,
  dimension,
  dimensionId,
  analysisText,
  keyFindings,
  submittedRecipeIds,
}: {
  ctx: ExternalDimensionCompletionContext;
  dimension: DimensionDef;
  dimensionId: string;
  analysisText: string;
  keyFindings: string[];
  submittedRecipeIds: string[];
}): Promise<string> {
  if (analysisText.length >= 500 || submittedRecipeIds.length === 0) {
    return analysisText;
  }

  try {
    const knowledgeService = ctx.container.get('knowledgeService') as KnowledgeServiceLike | null;
    if (!knowledgeService) {
      return analysisText;
    }
    const parts: string[] = [`## ${dimension.label || dimensionId} — 分析报告\n`];
    if (analysisText.trim().length > 0) {
      parts.push(analysisText.trim(), '');
    }
    for (const recipeId of submittedRecipeIds) {
      const entry = await knowledgeService.get(recipeId);
      if (!entry) {
        continue;
      }
      parts.push(`### ${entry.title || 'Untitled'}`);
      if (entry.description) {
        parts.push(entry.description);
      }
      if (entry.whenClause || entry.doClause || entry.dontClause) {
        parts.push('');
        if (entry.whenClause) {
          parts.push(`- **When**: ${entry.whenClause}`);
        }
        if (entry.doClause) {
          parts.push(`- **Do**: ${entry.doClause}`);
        }
        if (entry.dontClause) {
          parts.push(`- **Don't**: ${entry.dontClause}`);
        }
      }
      if (entry.coreCode) {
        parts.push('', '```', entry.coreCode.substring(0, 500), '```');
      }
      parts.push('');
    }
    if (keyFindings.length > 0) {
      parts.push('## Key Findings', '');
      for (const finding of keyFindings) {
        parts.push(`- ${finding}`);
      }
    }

    const synthesized = parts.join('\n');
    if (synthesized.length > analysisText.length) {
      logger.info(
        `[DimensionComplete] Synthesized analysisText for "${dimensionId}" from ${submittedRecipeIds.length} candidates (${analysisText.length} → ${synthesized.length} chars)`
      );
      return synthesized;
    }
  } catch (err: unknown) {
    logger.debug(
      `[DimensionComplete] Failed to synthesize analysisText: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return analysisText;
}

async function persistDimensionCheckpoint({
  session,
  dataRoot,
  dimensionId,
  candidateCount,
  analysisText,
  referencedFiles,
  submittedRecipeIds,
  skillCreated,
  dependencies,
}: {
  session: ExternalWorkflowSession;
  dataRoot: string;
  dimensionId: string;
  candidateCount: number;
  analysisText: string;
  referencedFiles: string[];
  submittedRecipeIds: string[];
  skillCreated: boolean;
  dependencies: ExternalDimensionCompletionDependencies;
}): Promise<void> {
  try {
    const saveCheckpoint = dependencies.saveCheckpoint ?? saveDimensionCheckpoint;
    await saveCheckpoint(dataRoot, session.id, dimensionId, {
      candidateCount,
      analysisChars: analysisText.length,
      referencedFiles: referencedFiles.length,
      recipeIds: submittedRecipeIds,
      skillCreated,
    });
  } catch (err: unknown) {
    logger.warn(
      `[DimensionComplete] Checkpoint save failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function persistKeyFindings({
  ctx,
  session,
  dimensionId,
  keyFindings,
}: {
  ctx: ExternalDimensionCompletionContext;
  session: ExternalWorkflowSession;
  dimensionId: string;
  keyFindings: string[];
}): Promise<void> {
  try {
    const knowledgeGraphService = ctx.container.get(
      'knowledgeGraphService'
    ) as KnowledgeGraphServiceLike | null;
    if (!knowledgeGraphService || keyFindings.length === 0) {
      return;
    }
    for (const finding of keyFindings) {
      await knowledgeGraphService.addEdge(
        dimensionId,
        'dimension',
        finding.substring(0, 80),
        'finding',
        'discovered_in',
        { source: 'external-agent-bootstrap', sessionId: session.id }
      );
    }
  } catch (err: unknown) {
    logger.debug(
      `[DimensionComplete] SemanticMemory fixation skipped: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function emitExternalCompletionProgress({
  ctx,
  session,
  dimension,
  dimensionId,
  candidateCount,
  skillCreated,
  recipesBound,
  progress,
  isComplete,
  dependencies,
}: {
  ctx: ExternalDimensionCompletionContext;
  session: ExternalWorkflowSession;
  dimension: DimensionDef;
  dimensionId: string;
  candidateCount: number;
  skillCreated: boolean;
  recipesBound: number;
  progress: ReturnType<ExternalWorkflowSession['getProgress']>;
  isComplete: boolean;
  dependencies: ExternalDimensionCompletionDependencies;
}): void {
  const emitter = dependencies.createEmitter
    ? dependencies.createEmitter(ctx.container)
    : new BootstrapEventEmitter(ctx.container);
  emitter.emitDimensionComplete(dimensionId, {
    type: dimension.skillWorthy ? 'skill' : 'candidate',
    extracted: candidateCount,
    skillCreated,
    recipesBound,
    progress: `${progress.completed}/${progress.total}`,
    isBootstrapComplete: isComplete,
    source: 'external-agent',
  });
  if (isComplete) {
    emitter.emitAllComplete(session.id, progress.total, 'external-agent');
  }
}

function buildQualityFeedback({
  dimensionId,
  qualityReport,
}: {
  dimensionId: string;
  qualityReport: ReturnType<ExternalWorkflowSession['markDimensionComplete']>['qualityReport'];
}): Record<string, unknown> | undefined {
  if (!qualityReport) {
    return undefined;
  }
  const qualityFeedback = {
    totalScore: qualityReport.totalScore,
    pass: qualityReport.pass,
    scores: qualityReport.scores,
    suggestions: qualityReport.suggestions.length > 0 ? qualityReport.suggestions : undefined,
  };
  if (qualityReport.pass) {
    logger.info(
      `[DimensionComplete] Quality assessment for "${dimensionId}": score=${qualityReport.totalScore}/100 PASS`
    );
  } else {
    logger.warn(
      `[DimensionComplete] Quality assessment for "${dimensionId}": score=${qualityReport.totalScore}/100 BELOW_THRESHOLD`
    );
  }
  return qualityFeedback;
}

function buildSubpackageCoverageWarning({
  session,
  dimensionId,
  referencedFiles,
}: {
  session: ExternalWorkflowSession;
  dimensionId: string;
  referencedFiles: string[];
}): string | undefined {
  try {
    const localPackages = session.getSnapshotCache?.()?.localPackageModules;
    if (!localPackages || localPackages.length === 0 || referencedFiles.length === 0) {
      return undefined;
    }
    const uncoveredPackages: string[] = [];
    for (const localPackage of localPackages) {
      const packagePrefix = localPackage.packageName.replace(/\/$/, '');
      const covered = referencedFiles.some(
        (file) => file.includes(packagePrefix) || file.includes(localPackage.name)
      );
      if (!covered) {
        uncoveredPackages.push(localPackage.name);
      }
    }
    if (uncoveredPackages.length === 0) {
      return undefined;
    }
    logger.info(
      `[DimensionComplete] Subpackage coverage gap for "${dimensionId}": ${uncoveredPackages.join(', ')}`
    );
    return (
      `本维度未覆盖以下本地子包: ${uncoveredPackages.join(', ')}。` +
      `建议在分析中纳入这些模块的源码，以确保知识库完整性。`
    );
  } catch {
    return undefined;
  }
}

function buildEvidenceHints({
  session,
  isComplete,
  accumulatedEvidence,
}: {
  session: ExternalWorkflowSession;
  isComplete: boolean;
  accumulatedEvidence: AccumulatedEvidenceLike;
}): Record<string, unknown> | undefined {
  if (
    isComplete ||
    (accumulatedEvidence.completedDimSummaries.length === 0 &&
      accumulatedEvidence.negativeSignals.length === 0)
  ) {
    return undefined;
  }

  return {
    previousSubmissions: accumulatedEvidence.completedDimSummaries.map((summary) => ({
      dimId: summary.dimId,
      submissionCount: summary.submissionCount,
      titles: summary.titles,
      referencedFiles: summary.referencedFiles,
    })),
    previousDimensionAnalysis: buildPreviousDimensionAnalysis(session, accumulatedEvidence),
    sharedFiles:
      accumulatedEvidence.sharedFiles.length > 0 ? accumulatedEvidence.sharedFiles : undefined,
    negativeSignals:
      accumulatedEvidence.negativeSignals.length > 0
        ? accumulatedEvidence.negativeSignals.map((signal) => signal.pattern)
        : undefined,
    usedTriggers:
      accumulatedEvidence.usedTriggers.length > 0 ? accumulatedEvidence.usedTriggers : undefined,
    _note:
      '以上为前序维度的分析证据，包含分析摘要和关键发现。请利用其中的文件引用和负空间信号，避免重复分析已覆盖的内容',
  };
}

function buildPreviousDimensionAnalysis(
  session: ExternalWorkflowSession,
  accumulatedEvidence: AccumulatedEvidenceLike
) {
  try {
    const summaries: Array<{ dimId: string; analysisSummary: string; keyFindings: string[] }> = [];
    for (const dimensionSummary of accumulatedEvidence.completedDimSummaries) {
      const report = session.sessionStore.getDimensionReport(dimensionSummary.dimId) as
        | DimensionReportLike
        | undefined;
      if (!report) {
        continue;
      }
      summaries.push({
        dimId: dimensionSummary.dimId,
        analysisSummary: (report.analysisText || '').substring(0, 500),
        keyFindings: (report.findings || [])
          .slice(0, 5)
          .map((finding) => finding.finding || finding.content || ''),
      });
    }
    return summaries.length > 0 ? summaries : undefined;
  } catch {
    return undefined;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function validationFailure(
  message: string,
  errorCode = 'VALIDATION_ERROR'
): ExternalDimensionCompletionResponse {
  return {
    success: false,
    message,
    errorCode,
    meta: { tool: 'alembic_dimension_complete' },
  };
}

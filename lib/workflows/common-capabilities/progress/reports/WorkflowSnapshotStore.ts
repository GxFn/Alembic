import type { SessionStore } from '#agent/memory/SessionStore.js';
import Logger from '#infra/logging/Logger.js';
import type { BootstrapFile, IncrementalPlan } from '#types/workflows.js';
import type {
  CandidateResults,
  DimensionStat,
} from '#workflows/common-capabilities/agent-execution/internal/consumers/BootstrapDimensionConsumer.js';
import { FileDiffPlanner } from '#workflows/common-capabilities/file-diff/FileDiffPlanner.js';
import type { WorkflowResultPersistenceContext } from '#workflows/common-capabilities/progress/reports/WorkflowReportTypes.js';

const logger = Logger.getInstance();

export interface SaveWorkflowSnapshotOptions {
  ctx: WorkflowResultPersistenceContext;
  projectRoot: string;
  sessionId: string;
  allFiles: BootstrapFile[] | null;
  dimensionStats: Record<string, DimensionStat>;
  sessionStore: SessionStore;
  totalTimeMs: number;
  candidateResults: CandidateResults;
  primaryLang: string;
  isIncremental?: boolean | null;
  incrementalPlan?: IncrementalPlan | null;
  createFileDiffPlanner: (
    db: unknown,
    projectRoot: string
  ) => Pick<FileDiffPlanner, 'saveSnapshot'>;
}

export function saveWorkflowSnapshot({
  ctx,
  projectRoot,
  sessionId,
  allFiles,
  dimensionStats,
  sessionStore,
  totalTimeMs,
  candidateResults,
  primaryLang,
  isIncremental,
  incrementalPlan,
  createFileDiffPlanner,
}: SaveWorkflowSnapshotOptions) {
  try {
    const db = ctx.container.get('database');
    if (db && allFiles) {
      const fileDiffPlanner = createFileDiffPlanner(db, projectRoot);
      const snapshotId = fileDiffPlanner.saveSnapshot({
        sessionId,
        allFiles,
        dimensionStats,
        episodicMemory: sessionStore as unknown as Parameters<
          FileDiffPlanner['saveSnapshot']
        >[0]['episodicMemory'],
        meta: {
          durationMs: totalTimeMs,
          candidateCount: candidateResults.created,
          primaryLang,
        },
        plan: isIncremental ? incrementalPlan || null : null,
      });
      logger.info(`[Insight-v3] 📸 Snapshot saved: ${snapshotId}`);
      return snapshotId;
    }
  } catch (snapErr: unknown) {
    logger.warn(
      `[Insight-v3] Snapshot save failed (non-blocking): ${snapErr instanceof Error ? snapErr.message : String(snapErr)}`
    );
  }
  return null;
}

export function createDefaultFileDiffPlanner(db: unknown, projectRoot: string) {
  return new FileDiffPlanner(db, projectRoot, { logger });
}

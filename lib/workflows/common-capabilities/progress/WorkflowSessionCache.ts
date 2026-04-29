import path from 'node:path';
import type { DimensionDef, ProjectSnapshot } from '#types/project-snapshot.js';
import { toSessionCache } from '#types/snapshot-views.js';
import { getOrCreateSessionManager } from '#workflows/common-capabilities/progress/session/WorkflowSessionManagerProvider.js';

export type WorkflowSessionContainer = Parameters<typeof getOrCreateSessionManager>[0];

interface WorkflowSessionLogger {
  warn(message: string): void;
}

export function cacheProjectAnalysisSession(opts: {
  container: WorkflowSessionContainer;
  projectRoot: string;
  dimensions: DimensionDef[];
  snapshot: ProjectSnapshot;
  primaryLang: string | null;
  fileCount: number;
  moduleCount: number;
  logger: WorkflowSessionLogger;
  logPrefix: string;
}): string | null {
  try {
    const sessionManager = getOrCreateSessionManager(opts.container);
    const session = sessionManager.createSession({
      projectRoot: opts.projectRoot,
      dimensions: opts.dimensions.map((dimension) => ({
        ...dimension,
        skillMeta: dimension.skillMeta ?? undefined,
      })),
      projectContext: {
        projectName: path.basename(opts.projectRoot),
        primaryLang: opts.primaryLang,
        fileCount: opts.fileCount,
        modules: opts.moduleCount,
      },
    });
    session.setSnapshotCache(toSessionCache(opts.snapshot));
    return session.id;
  } catch (err: unknown) {
    opts.logger.warn(
      `[${opts.logPrefix}] BootstrapSessionManager setup failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

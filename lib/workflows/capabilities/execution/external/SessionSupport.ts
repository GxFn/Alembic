/**
 * SessionSupport — SessionManager 单例获取与项目分析 Session 缓存
 *
 * 为冷启动和增量扫描提供 BootstrapSessionManager 的单例解析，
 * 以及 Phase 1-4 分析结果的缓存，供后续维度执行复用。
 */

import path from 'node:path';
import type { DimensionDef, ProjectSnapshot } from '#types/project-snapshot.js';
import { toSessionCache } from '#types/snapshot-views.js';
import { BootstrapSessionManager } from '#workflows/capabilities/execution/external/BootstrapSession.js';

// ═══════════════════════════════════════════════════════════
// §1 — WorkflowSessionManagerProvider
// ═══════════════════════════════════════════════════════════

interface SessionManagerContainer {
  get(name: string): unknown;
  register?: (name: string, factory: () => unknown) => void;
}

let sessionManager: BootstrapSessionManager | null = null;

export function getOrCreateSessionManager(
  container: SessionManagerContainer
): BootstrapSessionManager {
  try {
    const manager = container.get('bootstrapSessionManager');
    if (manager) {
      return manager as BootstrapSessionManager;
    }
  } catch {
    // Not registered yet.
  }

  if (!sessionManager) {
    sessionManager = new BootstrapSessionManager();
  }

  try {
    container.register?.('bootstrapSessionManager', () => sessionManager);
  } catch {
    // Already registered or container does not support registration.
  }

  return sessionManager;
}

// ═══════════════════════════════════════════════════════════
// §2 — WorkflowSessionCache
// ═══════════════════════════════════════════════════════════

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

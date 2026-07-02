import path from 'node:path';
import {
  MemoryCoordinator,
  MemoryEmbeddingStore,
  PersistentMemory,
  SessionStore,
} from '@alembic/agent/memory';
import Logger from '@alembic/core/logging';
import type { IncrementalPlan } from '@alembic/core/types';
import {
  buildProjectScopeSourceIdentityMap,
  type ProjectScopeSourceIdentity,
} from '../../../project-scope/ProjectScopeAnalysis.js';
import { DimensionContext } from './DimensionContext.js';
import { syncRestoredSessionStoreDigests } from './DimensionRestoreState.js';

const logger = Logger.getInstance();

export interface GenerateRuntimeContainer {
  get(name: string): unknown;
  singletons: {
    aiProvider?: Record<string, unknown> | null;
    _embedProvider?: Record<string, unknown> | null;
    [key: string]: unknown;
  };
}

export interface InitializeGenerateRuntimeOptions {
  container: GenerateRuntimeContainer;
  projectRoot: string;
  dataRoot: string;
  primaryLang?: string | null;
  allFiles: unknown[] | null;
  targetFileMap?: Record<string, unknown> | null;
  depGraphData?: unknown;
  astProjectSummary?: Record<string, unknown> | null;
  guardAudit?: Record<string, unknown> | null;
  isIncremental?: boolean | null;
  incrementalPlan?: IncrementalPlan | null;
  projectScopeSourceIdentities?: ProjectScopeSourceIdentity[];
}

export async function initializeGenerateRuntime({
  container,
  projectRoot,
  dataRoot,
  primaryLang,
  allFiles,
  targetFileMap,
  depGraphData,
  astProjectSummary,
  guardAudit,
  isIncremental,
  incrementalPlan,
  projectScopeSourceIdentities = [],
}: InitializeGenerateRuntimeOptions) {
  const projectGraph = null;
  logger.info(
    '[Insight-v7] Using unified AgentRuntime pipeline (no legacy Analyst/Producer wrappers)'
  );

  container.singletons._fileCache = allFiles;
  const projectScopeSourceIdentityMap = buildProjectScopeSourceIdentityMap(
    projectScopeSourceIdentities
  );
  container.singletons._projectScopeSourceIdentities = projectScopeSourceIdentities;
  container.singletons._projectScopeSourceIdentityMap = projectScopeSourceIdentityMap;
  const projectInfo = {
    name: path.basename(projectRoot),
    lang: primaryLang || 'unknown',
    fileCount: allFiles?.length || 0,
  };
  const modules = Object.keys(targetFileMap || {});
  const dimContext = new DimensionContext({
    projectName: projectInfo.name,
    primaryLang: projectInfo.lang,
    fileCount: projectInfo.fileCount,
    targetCount: modules.length,
    modules,
    depGraph: (depGraphData as Record<string, unknown>) ?? undefined,
    astMetrics: (astProjectSummary?.projectMetrics as Record<string, unknown>) ?? undefined,
    guardSummary: (guardAudit?.summary as Record<string, unknown>) ?? undefined,
  });
  const sessionStore = createBootstrapSessionStore({
    projectInfo,
    modules,
    isIncremental,
    incrementalPlan,
  });
  if (isIncremental && incrementalPlan?.restoredEpisodic) {
    syncRestoredSessionStoreDigests({ sessionStore, dimContext });
  }

  const semanticMemory = createBootstrapSemanticMemory({
    container,
    dataRoot,
  });
  const memoryCoordinator = new MemoryCoordinator({
    persistentMemory: semanticMemory,
    sessionStore,
    mode: 'bootstrap',
  });

  return {
    projectGraph,
    projectInfo,
    dimContext,
    sessionStore,
    semanticMemory,
    memoryCoordinator,
    projectScopeSourceIdentities,
    projectScopeSourceIdentityMap,
  };
}

function createBootstrapSessionStore({
  projectInfo,
  modules,
  isIncremental,
  incrementalPlan,
}: {
  projectInfo: { name: string; lang: string; fileCount: number };
  modules: string[];
  isIncremental?: boolean | null;
  incrementalPlan?: IncrementalPlan | null;
}) {
  if (isIncremental && incrementalPlan?.restoredEpisodic) {
    const restored = restoreBootstrapSessionStore(incrementalPlan.restoredEpisodic);
    if (restored) {
      return restored;
    }
  }

  return new SessionStore({
    projectName: projectInfo.name,
    primaryLang: projectInfo.lang,
    fileCount: projectInfo.fileCount,
    modules,
  });
}

function restoreBootstrapSessionStore(
  restoredEpisodic: NonNullable<IncrementalPlan['restoredEpisodic']>
) {
  try {
    const data = restoredEpisodic.toJSON();
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      logger.warn('[BootstrapRuntime] Restored episodic memory is not object-shaped');
      return null;
    }
    return SessionStore.fromJSON(data as Record<string, unknown>);
  } catch (err: unknown) {
    logger.warn(
      `[BootstrapRuntime] Failed to restore SessionStore: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
}

function createBootstrapSemanticMemory({
  container,
  dataRoot,
}: {
  container: GenerateRuntimeContainer;
  dataRoot: string;
}) {
  try {
    const db = container.get('database');
    if (!db) {
      return null;
    }
    let embeddingFn: ((text: string) => Promise<number[]>) | undefined;
    try {
      const ep = container.singletons?._embedProvider ?? container.singletons?.aiProvider;
      if (ep && typeof (ep as Record<string, unknown>).embed === 'function') {
        const provider = ep as { embed(t: string | string[]): Promise<number[] | number[][]> };
        embeddingFn = async (text: string) => {
          const result = await provider.embed(text);
          return result as number[];
        };
      }
    } catch {
      /* EmbedProvider is optional. */
    }
    const semanticMemory = new PersistentMemory(
      db as ConstructorParameters<typeof PersistentMemory>[0],
      {
        logger,
        embeddingFn,
        embeddingStore: new MemoryEmbeddingStore(dataRoot),
      }
    );
    const smStats = semanticMemory.getStats();
    if (smStats.total > 0) {
      logger.info(
        `[generate] Loaded ${smStats.total} semantic memories from previous bootstrap ` +
          `(fact: ${smStats.byType.fact || 0}, insight: ${smStats.byType.insight || 0}, preference: ${smStats.byType.preference || 0})`
      );
    }
    return semanticMemory;
  } catch (smErr: unknown) {
    logger.warn(
      `[generate] SemanticMemory init failed (non-blocking): ${smErr instanceof Error ? smErr.message : String(smErr)}`
    );
    return null;
  }
}

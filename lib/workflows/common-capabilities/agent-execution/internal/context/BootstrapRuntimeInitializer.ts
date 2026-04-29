import path from 'node:path';
import { MemoryCoordinator } from '#agent/memory/MemoryCoordinator.js';
import { MemoryEmbeddingStore } from '#agent/memory/MemoryEmbeddingStore.js';
import { PersistentMemory } from '#agent/memory/PersistentMemory.js';
import { SessionStore } from '#agent/memory/SessionStore.js';
import Logger from '#infra/logging/Logger.js';
import type { IncrementalPlan } from '#types/workflows.js';
import { DimensionContext } from '#workflows/common-capabilities/agent-execution/internal/context/DimensionContext.js';
import { syncRestoredSessionStoreDigests } from '#workflows/common-capabilities/progress/checkpoint/DimensionRestoreState.js';

const logger = Logger.getInstance();

export interface BootstrapProjectGraphLike {
  getOverview(): { totalClasses: number; totalProtocols: number; [key: string]: unknown };
  [key: string]: unknown;
}

export interface BootstrapRuntimeContainer {
  get(name: string): unknown;
  singletons: {
    aiProvider?: Record<string, unknown> | null;
    _embedProvider?: Record<string, unknown> | null;
    [key: string]: unknown;
  };
  buildProjectGraph?(
    projectRoot: string,
    options?: Record<string, unknown>
  ): Promise<BootstrapProjectGraphLike | null>;
}

export interface InitializeBootstrapRuntimeOptions {
  container: BootstrapRuntimeContainer;
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
}

export async function initializeBootstrapRuntime({
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
}: InitializeBootstrapRuntimeOptions) {
  const projectGraph = await buildBootstrapProjectGraph({ container, projectRoot });
  logger.info(
    '[Insight-v7] Using unified AgentRuntime pipeline (no legacy Analyst/Producer wrappers)'
  );

  container.singletons._fileCache = allFiles;
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
  const sessionStore =
    isIncremental && incrementalPlan?.restoredEpisodic
      ? incrementalPlan.restoredEpisodic
      : new SessionStore({
          projectName: projectInfo.name,
          primaryLang: projectInfo.lang,
          fileCount: projectInfo.fileCount,
          modules,
        });
  if (isIncremental && incrementalPlan?.restoredEpisodic) {
    syncRestoredSessionStoreDigests({ sessionStore, dimContext });
  }

  const semanticMemory = createBootstrapSemanticMemory({
    container,
    dataRoot,
  });
  const codeEntityGraphInst = await createBootstrapCodeEntityGraph({
    container,
    projectRoot,
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
    codeEntityGraphInst,
    memoryCoordinator,
  };
}

async function buildBootstrapProjectGraph({
  container,
  projectRoot,
}: {
  container: BootstrapRuntimeContainer;
  projectRoot: string;
}) {
  try {
    const projectGraph =
      (await container.buildProjectGraph?.(projectRoot, {
        maxFiles: 500,
        timeoutMs: 15_000,
      })) ?? null;
    if (projectGraph) {
      const overview = await projectGraph.getOverview();
      logger.info(
        `[Insight-v3] ProjectGraph: ${overview.totalClasses} classes, ${overview.totalProtocols} protocols (${(overview as Record<string, unknown>).buildTimeMs}ms)`
      );
    }
    return projectGraph;
  } catch (e: unknown) {
    logger.warn(
      `[Insight-v3] ProjectGraph build failed: ${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  }
}

function createBootstrapSemanticMemory({
  container,
  dataRoot,
}: {
  container: BootstrapRuntimeContainer;
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
        `[Insight-v3] Loaded ${smStats.total} semantic memories from previous bootstrap ` +
          `(fact: ${smStats.byType.fact || 0}, insight: ${smStats.byType.insight || 0}, preference: ${smStats.byType.preference || 0})`
      );
    }
    return semanticMemory;
  } catch (smErr: unknown) {
    logger.warn(
      `[Insight-v3] SemanticMemory init failed (non-blocking): ${smErr instanceof Error ? smErr.message : String(smErr)}`
    );
    return null;
  }
}

async function createBootstrapCodeEntityGraph({
  container,
  projectRoot,
}: {
  container: BootstrapRuntimeContainer;
  projectRoot: string;
}) {
  try {
    const { CodeEntityGraph } = await import('#service/knowledge/CodeEntityGraph.js');
    const entityRepo = container.get('codeEntityRepository');
    const edgeRepo = container.get('knowledgeEdgeRepository');
    if (entityRepo && edgeRepo) {
      const codeEntityGraphInst = new CodeEntityGraph(
        entityRepo as ConstructorParameters<typeof CodeEntityGraph>[0],
        edgeRepo as ConstructorParameters<typeof CodeEntityGraph>[1],
        { projectRoot, logger }
      );
      const topo = await codeEntityGraphInst.getTopology();
      if (topo.totalEntities > 0) {
        logger.info(
          `[Insight-v3] CodeEntityGraph: ${topo.totalEntities} entities, ${topo.totalEdges} edges`
        );
      }
      return codeEntityGraphInst;
    }
  } catch (cegErr: unknown) {
    logger.warn(
      `[Insight-v3] CodeEntityGraph init failed (non-blocking): ${cegErr instanceof Error ? cegErr.message : String(cegErr)}`
    );
  }
  return null;
}

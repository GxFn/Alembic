import Logger from '#infra/logging/Logger.js';

const logger = Logger.getInstance();

export interface BootstrapProjectGraphLike {
  getOverview?(): unknown;
  [key: string]: unknown;
}

interface BootstrapServiceContainerLike {
  services?: Record<string, unknown>;
  singletons?: Record<string, unknown>;
  get(name: string): unknown;
}

interface WikiGeneratorLike {
  generate(): Promise<Record<string, unknown>>;
}

type WikiGeneratorCtor = new (options: Record<string, unknown>) => WikiGeneratorLike;
type PatchWikiTask = (data: Record<string, unknown>) => void;
type GetServiceContainer = () =>
  | BootstrapServiceContainerLike
  | Promise<BootstrapServiceContainerLike>;

export interface ConsumeBootstrapDeliveryAndWikiOptions {
  projectRoot: string;
  dataRoot: string;
  projectGraph: BootstrapProjectGraphLike | null;
  wikiLanguage?: string;
  getServiceContainer?: GetServiceContainer;
  loadWikiGenerator?: () => Promise<WikiGeneratorCtor>;
  loadPatchWikiTask?: () => Promise<PatchWikiTask | null>;
}

export async function consumeBootstrapDeliveryAndWiki({
  projectRoot,
  dataRoot,
  projectGraph,
  wikiLanguage = process.env.ALEMBIC_WIKI_LANG || 'zh',
  getServiceContainer = defaultGetServiceContainer,
  loadWikiGenerator = defaultLoadWikiGenerator,
  loadPatchWikiTask = defaultLoadPatchWikiTask,
}: ConsumeBootstrapDeliveryAndWikiOptions) {
  await consumeCursorDelivery({ getServiceContainer });
  await consumeRepoWiki({
    projectRoot,
    dataRoot,
    projectGraph,
    wikiLanguage,
    getServiceContainer,
    loadWikiGenerator,
    loadPatchWikiTask,
  });
}

async function consumeCursorDelivery({
  getServiceContainer,
}: {
  getServiceContainer: GetServiceContainer;
}) {
  try {
    const container = await getServiceContainer();
    if (container.services?.cursorDeliveryPipeline) {
      const pipeline = container.get('cursorDeliveryPipeline') as
        | { deliver(): Promise<Record<string, any>> }
        | undefined;
      const deliveryResult = await pipeline?.deliver();
      if (deliveryResult) {
        logger.info(
          `[Insight-v3] 🚀 Cursor Delivery complete — ` +
            `A: ${deliveryResult.channelA?.rulesCount || 0} rules, ` +
            `B: ${deliveryResult.channelB?.topicCount || 0} topics, ` +
            `C: ${deliveryResult.channelC?.synced || 0} skills, ` +
            `D: ${deliveryResult.channelD?.documentsCount || 0} documents, ` +
            `F: ${deliveryResult.channelF?.filesWritten || 0} agent files`
        );
      }
    }
  } catch (deliveryErr: unknown) {
    logger.warn(
      `[Insight-v3] Cursor Delivery failed (non-blocking): ${deliveryErr instanceof Error ? deliveryErr.message : String(deliveryErr)}`
    );
  }
}

async function consumeRepoWiki({
  projectRoot,
  dataRoot,
  projectGraph,
  wikiLanguage,
  getServiceContainer,
  loadWikiGenerator,
  loadPatchWikiTask,
}: {
  projectRoot: string;
  dataRoot: string;
  projectGraph: BootstrapProjectGraphLike | null;
  wikiLanguage: string;
  getServiceContainer: GetServiceContainer;
  loadWikiGenerator: () => Promise<WikiGeneratorCtor>;
  loadPatchWikiTask: () => Promise<PatchWikiTask | null>;
}) {
  let patchWikiTask: PatchWikiTask | null = null;
  try {
    const wikiContainer = await getServiceContainer();
    const WikiGenerator = await loadWikiGenerator();
    patchWikiTask = await loadPatchWikiTask();
    const realtimeService = (wikiContainer.singletons?.realtimeService || null) as {
      broadcastEvent?(event: string, data: Record<string, unknown>): void;
    } | null;

    patchWikiTask?.({
      status: 'running',
      startedAt: Date.now(),
      phase: null,
      progress: 0,
      message: 'Bootstrap Wiki 生成中...',
      finishedAt: null,
      result: null,
      error: null,
    });

    const wiki = new WikiGenerator({
      projectRoot,
      dataRoot,
      moduleService: getOptionalService(wikiContainer, 'moduleService'),
      knowledgeService: getOptionalService(wikiContainer, 'knowledgeService'),
      projectGraph,
      codeEntityGraph: getOptionalService(wikiContainer, 'codeEntityGraph'),
      aiProvider: wikiContainer.singletons?.aiProvider || null,
      onProgress: (phase: string, progress: number, message: string) => {
        patchWikiTask?.({ phase, progress, message });
        try {
          realtimeService?.broadcastEvent?.('wiki:progress', {
            phase,
            progress,
            message,
            timestamp: Date.now(),
          });
        } catch {
          /* non-critical */
        }
      },
      options: { language: wikiLanguage },
    });

    const wikiResult = await wiki.generate();
    if (wikiResult.success) {
      logger.info(
        `[Insight-v3] 📖 Wiki generated — ${wikiResult.filesGenerated} files, ` +
          `AI: ${wikiResult.aiComposed || 0}, Synced: ${wikiResult.syncedDocs || 0}, ` +
          `Dedup removed: ${extractDedupRemovedCount(wikiResult)}`
      );
    }

    patchWikiTask?.({
      status: wikiResult.success ? 'done' : 'error',
      finishedAt: Date.now(),
      result: wikiResult,
      error: wikiResult.success ? null : (wikiResult.error as string) || 'Unknown error',
      progress: 100,
    });
    try {
      realtimeService?.broadcastEvent?.('wiki:completed', {
        success: wikiResult.success,
        filesGenerated: wikiResult.filesGenerated,
        duration: wikiResult.duration,
      });
    } catch {
      /* non-critical */
    }
  } catch (wikiErr: unknown) {
    const wikiErrMsg = wikiErr instanceof Error ? wikiErr.message : String(wikiErr);
    logger.warn(`[Insight-v3] Wiki generation failed (non-blocking): ${wikiErrMsg}`);
    if (!patchWikiTask) {
      patchWikiTask = await loadPatchWikiTask();
    }
    patchWikiTask?.({
      status: 'error',
      finishedAt: Date.now(),
      error: wikiErrMsg,
    });
  }
}

function getOptionalService(container: BootstrapServiceContainerLike, name: string) {
  try {
    return container.get(name);
  } catch {
    return null;
  }
}

function extractDedupRemovedCount(wikiResult: Record<string, unknown>) {
  const removed = (wikiResult.dedup as Record<string, unknown> | undefined)?.removed;
  return Array.isArray(removed) ? removed.length : 0;
}

async function defaultGetServiceContainer() {
  const { getServiceContainer } = await import('#inject/ServiceContainer.js');
  return getServiceContainer() as BootstrapServiceContainerLike;
}

async function defaultLoadWikiGenerator() {
  const { WikiGenerator } = await import('#service/wiki/WikiGenerator.js');
  return WikiGenerator as unknown as WikiGeneratorCtor;
}

async function defaultLoadPatchWikiTask() {
  try {
    const wikiRoute = await import('#http/routes/wiki.js');
    return wikiRoute.patchWikiTask || null;
  } catch {
    return null;
  }
}

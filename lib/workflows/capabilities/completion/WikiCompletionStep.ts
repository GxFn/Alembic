import type {
  CompletionLogger,
  LoadServiceContainer,
  WikiGeneratorLike,
} from '#workflows/capabilities/completion/WorkflowCompletionTypes.js';

export async function generateWiki({
  getServiceContainer,
  projectRoot,
  log,
}: {
  getServiceContainer: LoadServiceContainer;
  projectRoot: string;
  log: CompletionLogger;
}): Promise<void> {
  try {
    const container = await getServiceContainer();
    const { WikiGenerator } = await import('#service/wiki/WikiGenerator.js');
    const moduleService = container.get?.('moduleService');
    const knowledgeService = container.get?.('knowledgeService');
    if (!moduleService || !knowledgeService) {
      return;
    }

    const wikiDeps: import('#service/wiki/WikiGenerator.js').WikiDeps = {
      projectRoot,
      moduleService: moduleService as import('#service/wiki/WikiGenerator.js').WikiModuleService,
      knowledgeService:
        knowledgeService as import('#service/wiki/WikiGenerator.js').WikiKnowledgeService,
      options: { mode: 'bootstrap' },
    };
    const wikiGenerator: WikiGeneratorLike = new WikiGenerator(wikiDeps);
    const wikiResult = await wikiGenerator.generate();
    log.info(
      `[DimensionComplete] Auto Wiki generation: ${(wikiResult as { totalPages?: number }).totalPages || 0} pages`
    );
  } catch (err: unknown) {
    log.warn(
      `[DimensionComplete] Wiki generation failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

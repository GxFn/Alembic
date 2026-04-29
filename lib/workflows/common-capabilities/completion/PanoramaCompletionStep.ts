import type {
  CompletionLogger,
  LoadServiceContainer,
  PanoramaServiceLike,
} from '#workflows/common-capabilities/completion/WorkflowCompletionTypes.js';

export async function refreshPanorama({
  getServiceContainer,
  log,
}: {
  getServiceContainer: LoadServiceContainer;
  log: CompletionLogger;
}): Promise<void> {
  try {
    const container = await getServiceContainer();
    const panoramaService = container.services?.panoramaService
      ? (container.get?.('panoramaService') as PanoramaServiceLike | undefined)
      : undefined;
    if (!panoramaService || typeof panoramaService.rescan !== 'function') {
      return;
    }

    await panoramaService.rescan();
    const overview = await panoramaService.getOverview();
    log.info(
      `[DimensionComplete] Panorama refreshed — ${overview.moduleCount} modules, ${overview.gapCount} gaps`
    );
  } catch (err: unknown) {
    log.warn(
      `[DimensionComplete] Panorama refresh failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

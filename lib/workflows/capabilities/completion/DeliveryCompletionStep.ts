import type {
  CompletionLogger,
  DeliveryPipelineLike,
  LoadServiceContainer,
} from '#workflows/capabilities/completion/WorkflowCompletionTypes.js';

export async function runCursorDelivery({
  getServiceContainer,
  log,
}: {
  getServiceContainer: LoadServiceContainer;
  log: CompletionLogger;
}): Promise<void> {
  try {
    const container = await getServiceContainer();
    const pipeline = container.services?.cursorDeliveryPipeline
      ? (container.get?.('cursorDeliveryPipeline') as DeliveryPipelineLike | undefined)
      : undefined;
    if (!pipeline) {
      return;
    }

    const deliveryResult = await pipeline.deliver();
    log.info(
      `[DimensionComplete] Auto Cursor Delivery complete — ` +
        `A: ${deliveryResult.channelA?.rulesCount || 0} rules, ` +
        `B: ${deliveryResult.channelB?.topicCount || 0} topics, ` +
        `C: ${deliveryResult.channelC?.synced || 0} skills, ` +
        `F: ${deliveryResult.channelF?.filesWritten || 0} agent files`
    );
  } catch (err: unknown) {
    log.warn(
      `[DimensionComplete] Auto CursorDelivery failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

import type {
  CompletionContextLike,
  CompletionLogger,
} from '#workflows/capabilities/completion/WorkflowCompletionTypes.js';

export async function verifyDelivery({
  ctx,
  log,
}: {
  ctx: CompletionContextLike;
  log: CompletionLogger;
}): Promise<import('#service/bootstrap/DeliveryVerifier.js').DeliveryVerification | null> {
  try {
    const { DeliveryVerifier } = await import('#service/bootstrap/DeliveryVerifier.js');
    const { resolveDataRoot, resolveProjectRoot } = await import('#shared/resolveProjectRoot.js');
    const projectRoot = resolveProjectRoot(ctx.container as never);
    const dataRoot = resolveDataRoot(ctx.container as never) || projectRoot;
    const verifier = new DeliveryVerifier(projectRoot, dataRoot);
    const verification = verifier.verify();
    if (!verification.allPassed) {
      log.warn('[DimensionComplete] Delivery verification incomplete', {
        failures: verification.failures,
      });
    } else {
      log.info('[DimensionComplete] Delivery verification passed — all channels OK');
    }
    return verification;
  } catch (err: unknown) {
    log.warn(
      `[DimensionComplete] DeliveryVerifier failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

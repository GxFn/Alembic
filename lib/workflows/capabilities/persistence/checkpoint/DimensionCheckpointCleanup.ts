import { clearDimensionCheckpoints } from '#workflows/capabilities/persistence/checkpoint/DimensionCheckpointStore.js';

export async function cleanupDimensionCheckpoints(dataRoot: string): Promise<void> {
  await clearDimensionCheckpoints(dataRoot);
}

export { clearDimensionCheckpoints };

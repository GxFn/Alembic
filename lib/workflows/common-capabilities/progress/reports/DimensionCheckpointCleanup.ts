import { clearDimensionCheckpoints } from '#workflows/common-capabilities/progress/checkpoint/DimensionCheckpointStore.js';

export async function cleanupDimensionCheckpoints(dataRoot: string): Promise<void> {
  await clearDimensionCheckpoints(dataRoot);
}

export { clearDimensionCheckpoints };

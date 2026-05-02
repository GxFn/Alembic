import { describe, expect, test, vi } from 'vitest';
import { runCursorDelivery } from '#workflows/capabilities/completion/CompletionSteps.js';

describe('DeliveryCompletionStep', () => {
  test('runs cursor delivery through the workflow completion boundary', async () => {
    const deliver = vi.fn(async () => ({
      channelA: { rulesCount: 1 },
      channelB: { topicCount: 2 },
      channelC: { synced: 3 },
      channelF: { filesWritten: 4 },
    }));
    const log = { info: vi.fn(), warn: vi.fn() };

    await runCursorDelivery({
      getServiceContainer: () => ({
        services: { cursorDeliveryPipeline: true },
        get: (name: string) => (name === 'cursorDeliveryPipeline' ? { deliver } : undefined),
      }),
      log,
    });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Auto Cursor Delivery complete'));
  });

  test('treats missing delivery pipeline as a no-op', async () => {
    const log = { info: vi.fn(), warn: vi.fn() };

    await runCursorDelivery({
      getServiceContainer: () => ({ services: {}, get: () => undefined }),
      log,
    });

    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

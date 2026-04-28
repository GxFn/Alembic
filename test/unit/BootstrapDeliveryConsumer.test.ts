import { describe, expect, test, vi } from 'vitest';
import { consumeBootstrapDeliveryAndWiki } from '#workflows/deprecated-cold-start/delivery/BootstrapDeliveryConsumer.js';

describe('bootstrap delivery consumer', () => {
  test('runs cursor delivery and wiki generation through injected boundaries', async () => {
    const deliver = vi.fn(async () => ({
      channelA: { rulesCount: 1 },
      channelB: { topicCount: 2 },
      channelC: { synced: 3 },
      channelD: { documentsCount: 4 },
      channelF: { filesWritten: 5 },
    }));
    const broadcastEvent = vi.fn();
    const patchWikiTask = vi.fn();
    const generate = vi.fn(async () => ({
      success: true,
      filesGenerated: 2,
      aiComposed: 1,
      syncedDocs: 1,
      dedup: { removed: ['a'] },
      duration: 10,
    }));
    const wikiCtorOptions: Array<Record<string, any>> = [];
    class FakeWikiGenerator {
      constructor(options: Record<string, any>) {
        wikiCtorOptions.push(options);
        options.onProgress('compose', 50, 'halfway');
      }

      generate = generate;
    }
    const container = {
      services: { cursorDeliveryPipeline: true },
      singletons: { realtimeService: { broadcastEvent }, aiProvider: { model: 'test' } },
      get: vi.fn((name: string) => {
        if (name === 'cursorDeliveryPipeline') {
          return { deliver };
        }
        return { service: name };
      }),
    };

    await consumeBootstrapDeliveryAndWiki({
      projectRoot: '/repo',
      dataRoot: '/data',
      projectGraph: { marker: 'graph' },
      wikiLanguage: 'zh',
      getServiceContainer: () => container,
      loadWikiGenerator: async () => FakeWikiGenerator,
      loadPatchWikiTask: async () => patchWikiTask,
    });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(wikiCtorOptions[0]).toMatchObject({
      projectRoot: '/repo',
      dataRoot: '/data',
      projectGraph: { marker: 'graph' },
      moduleService: { service: 'moduleService' },
      knowledgeService: { service: 'knowledgeService' },
      codeEntityGraph: { service: 'codeEntityGraph' },
      options: { language: 'zh' },
    });
    expect(patchWikiTask).toHaveBeenCalledWith(expect.objectContaining({ status: 'running' }));
    expect(patchWikiTask).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'compose', progress: 50, message: 'halfway' })
    );
    expect(patchWikiTask).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'done',
        result: expect.objectContaining({ success: true }),
      })
    );
    expect(broadcastEvent).toHaveBeenCalledWith(
      'wiki:progress',
      expect.objectContaining({ phase: 'compose', progress: 50 })
    );
    expect(broadcastEvent).toHaveBeenCalledWith(
      'wiki:completed',
      expect.objectContaining({ success: true, filesGenerated: 2, duration: 10 })
    );
  });

  test('records wiki task failure without throwing', async () => {
    const patchWikiTask = vi.fn();
    await consumeBootstrapDeliveryAndWiki({
      projectRoot: '/repo',
      dataRoot: '/data',
      projectGraph: null,
      getServiceContainer: () => ({
        services: {},
        singletons: {},
        get: () => null,
      }),
      loadWikiGenerator: async () => {
        throw new Error('wiki unavailable');
      },
      loadPatchWikiTask: async () => patchWikiTask,
    });

    expect(patchWikiTask).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', error: 'wiki unavailable' })
    );
  });
});

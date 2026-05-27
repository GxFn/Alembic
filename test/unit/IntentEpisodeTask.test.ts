import { describe, expect, test, vi } from 'vitest';
import { taskHandler } from '../../lib/resident/tool-handlers/task.js';
import { createIdleIntent } from '../../lib/resident/tool-schema/types.js';

describe('task handler intent episode integration', () => {
  test('starts, attaches, and closes an intent episode across resident task lifecycle', async () => {
    const store = {
      attachTask: vi.fn(),
      start: vi.fn().mockReturnValue({
        episodeId: 'episode_1',
        sessionKey: 'sha256:session',
        status: 'active',
      }),
      updateOutcome: vi.fn(),
    };
    const pipeline = {
      search: vi.fn().mockResolvedValue({
        guardRules: [],
        relatedKnowledge: [{ id: 'recipe-1', sourceRefs: ['src/recipe.ts:1'], title: 'Recipe' }],
        searchMeta: {
          filteredCount: 0,
          hostIntentApplied: true,
          hostIntentConfidence: 0.9,
          hostIntentSourceRefs: ['host:intent'],
          queries: ['episode store'],
          resultCount: 1,
        },
      }),
    };
    const signalBus = { send: vi.fn() };
    const ctx = {
      container: {
        get: vi.fn((name: string) => {
          if (name === 'intentEpisodeStore') {
            return store;
          }
          if (name === 'primeSearchPipeline') {
            return pipeline;
          }
          if (name === 'signalBus') {
            return signalBus;
          }
          throw new Error(`unexpected service: ${name}`);
        }),
      },
      session: {
        id: 'raw-session-id',
        intent: createIdleIntent(),
        lastActivityAt: Date.now(),
        startedAt: Date.now(),
        toolCallCount: 0,
        toolsUsed: new Set<string>(),
      },
    };

    const prime = await taskHandler(ctx, {
      activeFile: '/Users/private/project/src/task.ts',
      hostDeclaredIntent: {
        confidence: 0.9,
        intent: 'generate',
        query: 'episode store',
        sourceRefs: ['host:intent'],
      },
      hostTurnMeta: {
        id: 'turn-1',
        language: 'typescript',
      },
      operation: 'prime',
      userQuery: 'fallback',
    });

    expect(store.start).toHaveBeenCalledWith(
      expect.objectContaining({
        activeFile: '/Users/private/project/src/task.ts',
        hostIntent: expect.objectContaining({
          applied: true,
          confidence: 0.9,
          sourceRefs: ['host:intent'],
        }),
        query: 'episode store',
        searchMeta: expect.objectContaining({
          hostIntentApplied: true,
          hostIntentSourceRefs: ['host:intent'],
          primeInjectionPackage: expect.objectContaining({
            selectedKnowledge: expect.arrayContaining([
              expect.objectContaining({ itemId: 'recipe-1', sourceRefs: ['src/recipe.ts:1'] }),
            ]),
          }),
          queries: ['episode store'],
        }),
        sessionId: 'raw-session-id',
        turnId: 'turn-1',
      })
    );
    expect(prime).toMatchObject({
      data: {
        intentEpisode: {
          episodeId: 'episode_1',
          sessionKey: 'sha256:session',
        },
        primeInjectionPackage: expect.objectContaining({
          selectedKnowledge: expect.arrayContaining([
            expect.objectContaining({ itemId: 'recipe-1' }),
          ]),
        }),
      },
      success: true,
    });
    expect(ctx.session.intent.episodeId).toBe('episode_1');
    expect(ctx.session.intent.episodeSessionKey).toBe('sha256:session');

    const create = await taskHandler(ctx, {
      operation: 'create',
      title: 'Implement episode store',
    });
    const created = (create.data as Record<string, unknown>).id as string;

    expect(created).toMatch(/^alembic-/);
    expect(store.attachTask).toHaveBeenCalledWith('episode_1', created);
    expect(create).toMatchObject({
      data: {
        intentEpisode: {
          episodeId: 'episode_1',
          sessionKey: 'sha256:session',
        },
      },
      success: true,
    });

    await taskHandler(ctx, {
      id: created,
      operation: 'close',
      reason: 'done',
    });

    expect(signalBus.send).toHaveBeenCalledWith(
      'intent',
      'TaskHandler',
      0,
      expect.objectContaining({
        metadata: {
          chain: expect.objectContaining({
            outcome: 'completed',
            taskId: created,
          }),
        },
        target: created,
      })
    );
    expect(store.updateOutcome).toHaveBeenCalledWith('episode_1', {
      reason: 'done',
      searchMeta: expect.objectContaining({ queries: ['episode store'] }),
      status: 'completed',
      taskId: created,
    });
    expect(ctx.session.intent.phase).toBe('idle');
  });
});

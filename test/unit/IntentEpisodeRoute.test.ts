import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { invokeRouter } from '../helpers/express.js';

const mocks = vi.hoisted(() => {
  return {
    container: {
      get: vi.fn(),
    },
  };
});

vi.mock('../../lib/injection/ServiceContainer.js', () => ({
  getServiceContainer: vi.fn(() => mocks.container),
}));

import intentEpisodesRouter, {
  buildIntentEpisodeCapability,
} from '../../lib/http/routes/intent-episodes.js';
import { IntentEpisodeStore } from '../../lib/service/task/IntentEpisodeStore.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'alembic-intent-episode-route-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('intent episode route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const store = new IntentEpisodeStore({
      dataRoot: tempRoot(),
      now: () => new Date('2026-05-26T15:30:00.000Z'),
      workspace: {
        dataRootSource: 'project-root',
        projectId: 'project-route',
        projectScopeId: 'scope-route',
        workspaceMode: 'standard',
      },
    });
    mocks.container.get.mockImplementation((name: string) => {
      if (name === 'intentEpisodeStore') {
        return store;
      }
      throw new Error(`unexpected service: ${name}`);
    });
  });

  test('starts, reads, lists, and updates ProjectScope episodes through resident API', async () => {
    const start = await invokeRouter(intentEpisodesRouter, {
      body: {
        activeFile: '/Users/private/project/src/route.ts',
        hostIntent: { applied: true, sourceRefs: ['/Users/private/project/src/route.ts:1'] },
        query: 'route episode',
        searchMeta: { queries: ['route episode'], resultCount: 1 },
        sessionId: 'route-thread',
      },
      method: 'POST',
      mountPath: '/api/v1/intent-episodes',
      path: '/api/v1/intent-episodes',
    });
    const startData = start.body.data as Record<string, unknown>;
    const started = startData.episode as Record<string, unknown>;

    expect(start.status).toBe(201);
    expect(startData.capability).toEqual(buildIntentEpisodeCapability());
    expect(started).toMatchObject({
      activeFileRef: '[absolute-path]/route.ts',
      dataRootSource: 'project-root',
      projectId: 'project-route',
      query: 'route episode',
      status: 'active',
    });
    expect(JSON.stringify(started)).not.toContain('/Users/private');
    expect(JSON.stringify(started)).not.toContain('route-thread');

    const episodeId = String(started.episodeId);
    const update = await invokeRouter(intentEpisodesRouter, {
      body: { reason: 'finished', status: 'completed', taskId: 'task-route' },
      method: 'PATCH',
      mountPath: '/api/v1/intent-episodes',
      path: `/api/v1/intent-episodes/${episodeId}`,
    });
    expect(update.status).toBe(200);
    expect((update.body.data as Record<string, unknown>).episode).toMatchObject({
      episodeId,
      outcomeReason: 'finished',
      status: 'completed',
      taskId: 'task-route',
    });

    const latest = await invokeRouter(intentEpisodesRouter, {
      method: 'GET',
      mountPath: '/api/v1/intent-episodes',
      path: '/api/v1/intent-episodes/latest?sessionId=route-thread',
    });
    expect((latest.body.data as Record<string, unknown>).episode).toMatchObject({
      episodeId,
      status: 'completed',
    });

    const recent = await invokeRouter(intentEpisodesRouter, {
      method: 'GET',
      mountPath: '/api/v1/intent-episodes',
      path: '/api/v1/intent-episodes/recent?sessionId=route-thread&limit=5',
    });
    expect((recent.body.data as Record<string, unknown>).count).toBe(1);
  });
});

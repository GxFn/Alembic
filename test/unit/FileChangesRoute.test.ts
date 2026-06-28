import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileChangeEvent } from '@alembic/core/types';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { invokeRouter } from '../helpers/express.js';

const mockAssessFileImpact = vi.fn();
const mockExtractRecipeTokens = vi.fn(() => ({ tokens: new Set(), sources: new Map() }));

vi.mock('@alembic/core/evolution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@alembic/core/evolution')>();
  return {
    ...actual,
    assessFileImpact: (...args: unknown[]) => mockAssessFileImpact(...args),
    extractRecipeTokens: (...args: unknown[]) => mockExtractRecipeTokens(...args),
  };
});

const mocks = vi.hoisted(() => ({
  container: {
    get: vi.fn(),
  },
}));

vi.mock('../../lib/injection/ServiceContainer.js', () => ({
  getServiceContainer: vi.fn(() => mocks.container),
}));

import fileChangesRouter from '../../lib/http/routes/file-changes.js';
import { DaemonFileChangeCollector } from '../../lib/service/evolution/DaemonFileChangeCollector.js';
import { InProcessFileChangeHandler } from '../../lib/service/evolution/InProcessFileChangeHandler.js';
import { FileChangeDispatcher } from '../../lib/service/FileChangeDispatcher.js';

const tempDirs: string[] = [];

describe('file-changes route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssessFileImpact.mockReset();
    mockExtractRecipeTokens.mockReset();
    mockAssessFileImpact.mockReturnValue({
      level: 'pattern',
      matchedTokens: ['NetworkKitRetryPolicy'],
      score: 0.42,
    });
    mockExtractRecipeTokens.mockReturnValue({ tokens: new Set(), sources: new Map() });
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test('routes git fallback file-change events into reviewable evolution proposals', async () => {
    const sourceRefRepo = mockSourceRefRepo();
    const knowledgeRepo = mockKnowledgeRepo();
    const contentPatcher = mockContentPatcher();
    const signalBus = mockSignalBus();
    const gateway = mockGateway();
    sourceRefRepo._seed('recipe-1', 'Sources/RetryPolicy.swift');
    knowledgeRepo._seed('recipe-1', {
      coreCode: 'final class NetworkKitRetryPolicy {}',
      lifecycle: 'active',
      title: 'RetryPolicy pattern',
    });

    const dispatcher = new FileChangeDispatcher();
    dispatcher.register(
      new InProcessFileChangeHandler(
        sourceRefRepo as never,
        knowledgeRepo as never,
        contentPatcher as never,
        {
          evolutionGateway: gateway as never,
          projectRoot: '/tmp/alembic-route-probe',
          signalBus: signalBus as never,
        }
      )
    );
    mocks.container.get.mockImplementation((name: string) => {
      if (name === 'fileChangeDispatcher') {
        return dispatcher;
      }
      throw new Error(`Unexpected service requested: ${name}`);
    });

    const response = await invokeRouter(fileChangesRouter, {
      body: {
        events: [
          {
            eventSource: 'git-worktree',
            path: 'Sources/RetryPolicy.swift',
            type: 'modified',
          } satisfies FileChangeEvent,
        ],
      },
      method: 'POST',
      mountPath: '/api/v1/file-changes',
      path: '/api/v1/file-changes',
    });
    const data = response.body.data as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(data).toMatchObject({
      eventSource: 'git-worktree',
      needsReview: 1,
      suggestReview: true,
    });
    expect(data.details).toEqual([
      expect.objectContaining({
        action: 'needs-review',
        impactLevel: 'pattern',
        modifiedPath: 'Sources/RetryPolicy.swift',
        recipeId: 'recipe-1',
      }),
    ]);
    expect(gateway.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'update',
        recipeId: 'recipe-1',
        source: 'file-change',
      })
    );
    expect(contentPatcher.applyProposal).not.toHaveBeenCalled();
  });

  test('rejects unsafe file-change paths instead of dispatching them', async () => {
    const response = await invokeRouter(fileChangesRouter, {
      body: {
        events: [{ path: '../secret.txt', type: 'modified' }],
      },
      method: 'POST',
      mountPath: '/api/v1/file-changes',
      path: '/api/v1/file-changes',
    });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toMatchObject({
      code: 'INVALID_FILE_CHANGE_PATH',
      reasonCode: 'invalid-input',
    });
    expect(mocks.container.get).not.toHaveBeenCalled();
  });

  test('returns a typed failure when file-change dispatch fails', async () => {
    const dispatch = vi.fn(async () => {
      throw new Error('dispatcher unavailable');
    });
    mocks.container.get.mockImplementation((name: string) => {
      if (name === 'fileChangeDispatcher') {
        return { dispatch };
      }
      throw new Error(`Unexpected service requested: ${name}`);
    });

    const response = await invokeRouter(fileChangesRouter, {
      body: {
        events: [{ eventSource: 'host-edit', path: 'Sources/RetryPolicy.swift', type: 'modified' }],
      },
      method: 'POST',
      mountPath: '/api/v1/file-changes',
      path: '/api/v1/file-changes',
    });

    expect(response.status).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toMatchObject({
      code: 'FILE_CHANGE_DISPATCH_FAILED',
      reasonCode: 'internal-error',
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  test('native watcher events enter dispatcher and create reviewable proposals', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'alembic-native-proposal-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'Sources'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'Sources', 'RetryPolicy.swift'),
      'final class NetworkKitRetryPolicy {}\n'
    );
    const sourceRefRepo = mockSourceRefRepo();
    const knowledgeRepo = mockKnowledgeRepo();
    const contentPatcher = mockContentPatcher();
    const signalBus = mockSignalBus();
    const gateway = mockGateway();
    sourceRefRepo._seed('recipe-1', 'Sources/RetryPolicy.swift');
    knowledgeRepo._seed('recipe-1', {
      coreCode: 'final class NetworkKitRetryPolicy {}',
      lifecycle: 'active',
      title: 'RetryPolicy pattern',
    });

    const dispatcher = new FileChangeDispatcher();
    dispatcher.register(
      new InProcessFileChangeHandler(
        sourceRefRepo as never,
        knowledgeRepo as never,
        contentPatcher as never,
        {
          evolutionGateway: gateway as never,
          projectRoot,
          signalBus: signalBus as never,
        }
      )
    );
    const collector = new DaemonFileChangeCollector({
      dispatcher,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      nativeWatcherFactory: () => ({ close: vi.fn(), on: vi.fn() }),
      projectRoot,
    });

    collector.start();
    appendFileSync(join(projectRoot, 'Sources', 'RetryPolicy.swift'), '\nfunc retry() {}\n');
    await collector.scanNativeOnce(2_000);

    expect(collector.getStatus()).toMatchObject({
      activeEventSource: 'native-watch',
      state: 'running',
    });
    expect(gateway.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'update',
        recipeId: 'recipe-1',
        source: 'file-change',
      })
    );
    expect(contentPatcher.applyProposal).not.toHaveBeenCalled();

    collector.stop();
  });
});

function mockSourceRefRepo() {
  const refs: Array<{ recipeId: string; sourcePath: string; status: string }> = [];
  return {
    findByRecipeId: vi.fn((id: string) => refs.filter((ref) => ref.recipeId === id)),
    findBySourcePath: vi.fn((path: string) =>
      refs.filter((ref) => ref.sourcePath === path && ref.status === 'active')
    ),
    replaceSourcePath: vi.fn(),
    upsert: vi.fn(),
    _seed(recipeId: string, sourcePath: string, status = 'active') {
      refs.push({ recipeId, sourcePath, status });
    },
  };
}

function mockKnowledgeRepo() {
  const store = new Map<string, Record<string, unknown>>();
  return {
    findById: vi.fn(async (id: string) => store.get(id) ?? null),
    findSourceFileAndReasoning: vi.fn(async (id: string) => {
      const entry = store.get(id);
      return entry ? { reasoning: JSON.stringify(entry.reasoning ?? {}) } : null;
    }),
    updateReasoning: vi.fn(),
    _seed(id: string, data: Record<string, unknown>) {
      store.set(id, { id, ...data });
    },
  };
}

function mockContentPatcher() {
  return {
    applyProposal: vi.fn(async () => ({ success: true })),
  };
}

function mockSignalBus() {
  return {
    send: vi.fn(),
  };
}

function mockGateway() {
  return {
    submit: vi.fn(async () => ({
      action: 'update',
      outcome: 'needs-review',
      recipeId: 'recipe-1',
    })),
  };
}

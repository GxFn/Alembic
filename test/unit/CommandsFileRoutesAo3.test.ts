import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createEmbeddingProvider } from '../../lib/injection/EmbeddingProvider.js';
import { invokeRouter } from '../helpers/express.js';

const mocks = vi.hoisted(() => ({
  container: {
    get: vi.fn(),
    singletons: {} as Record<string, unknown>,
    services: {} as Record<string, () => unknown>,
  },
}));

vi.mock('../../lib/injection/ServiceContainer.js', () => ({
  getServiceContainer: vi.fn(() => mocks.container),
}));

import commandsRouter from '../../lib/http/routes/commands.js';

const tempDirs: string[] = [];

describe('commands file routes AO3 path boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const projectRoot = mkdtempSync(join(tmpdir(), 'alembic-commands-route-'));
    tempDirs.push(projectRoot);
    mocks.container.singletons = { _projectRoot: projectRoot };
    mocks.container.services = {};
    mocks.container.get.mockImplementation((name: string) => {
      throw new Error(`Unexpected service requested: ${name}`);
    });
    writeFileSync(join(projectRoot, 'allowed.swift'), 'let value = 1\n');
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test('rejects traversal reads with the Core failure taxonomy envelope', async () => {
    const response = await invokeRouter(commandsRouter, {
      method: 'GET',
      mountPath: '/api/v1/commands',
      path: '/api/v1/commands/files/read?path=../secret.swift',
    });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toMatchObject({
      code: 'INVALID_FILE_PATH',
      reasonCode: 'invalid-input',
    });
  });

  test('rejects absolute save paths before reaching the filesystem', async () => {
    const response = await invokeRouter(commandsRouter, {
      body: { content: 'let escaped = true\n', path: '/tmp/escaped.swift' },
      method: 'POST',
      mountPath: '/api/v1/commands',
      path: '/api/v1/commands/files/save',
    });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toMatchObject({
      code: 'INVALID_FILE_PATH',
      reasonCode: 'invalid-input',
    });
  });
});

describe('Dashboard semantic-index embedding boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const projectRoot = mkdtempSync(join(tmpdir(), 'alembic-dashboard-embed-'));
    tempDirs.push(projectRoot);
    mocks.container.singletons = { _projectRoot: projectRoot };
    mocks.container.services = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Dashboard admission must not probe a model service');
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function configuredBuild(useVectorService: boolean) {
    const stats = { scanned: 2, chunked: 3, embedded: 3, upserted: 3, skipped: 0, errors: 0 };
    const vector = { clear: vi.fn(async () => undefined), fullBuild: vi.fn(async () => stats) };
    const pipeline = { run: vi.fn(async () => stats) };
    mocks.container.services = useVectorService ? { vectorService: () => vector } : {};
    mocks.container.get.mockImplementation((name: string) => {
      if (name === 'vectorService') {
        return vector;
      }
      if (name === 'indexingPipeline') {
        return pipeline;
      }
      throw new Error(`Unexpected service requested: ${name}`);
    });
    return { vector, pipeline, stats };
  }

  test.each([
    { useVectorService: true, clear: undefined, force: true },
    { useVectorService: false, clear: undefined, force: true },
    { useVectorService: true, clear: false, force: false },
    { useVectorService: false, clear: false, force: false },
  ])('passes one explicit rebuild request with no LLM (vectorService=$useVectorService, clear=$clear)', async ({
    useVectorService,
    clear,
    force,
  }) => {
    const { vector, pipeline, stats } = configuredBuild(useVectorService);
    mocks.container.singletons._embedProvider = createEmbeddingProvider(
      {},
      {
        ALEMBIC_EMBED_PROVIDER: 'ollama',
        ALEMBIC_EMBED_MODEL: 'qwen3-embedding:0.6b',
        ALEMBIC_EMBED_BASE_URL: 'http://embedding.invalid',
      }
    );
    const response = await invokeRouter(commandsRouter, {
      method: 'POST',
      mountPath: '/api/v1/commands',
      path: '/api/v1/commands/embed',
      body: { clear, force },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ success: true, data: stats });
    if (useVectorService) {
      expect(vector.clear).not.toHaveBeenCalled();
      expect(vector.fullBuild).toHaveBeenCalledExactlyOnceWith({ clear: clear !== false, force });
      expect(pipeline.run).not.toHaveBeenCalled();
    } else {
      expect(pipeline.run).toHaveBeenCalledExactlyOnceWith({ clear: clear !== false, force });
      expect(vector.clear).not.toHaveBeenCalled();
      expect(vector.fullBuild).not.toHaveBeenCalled();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    { useVectorService: true, legacyOnly: false },
    { useVectorService: false, legacyOnly: false },
    { useVectorService: true, legacyOnly: true },
    { useVectorService: false, legacyOnly: true },
  ])('rejects missing independent embedding before mutations despite a ready LLM: $useVectorService/$legacyOnly', async ({
    useVectorService,
    legacyOnly,
  }) => {
    const { vector, pipeline } = configuredBuild(useVectorService);
    const legacyEmbed = vi.fn();
    mocks.container.singletons.aiProvider = {
      name: 'openai',
      model: 'fixture-llm',
      embed: legacyEmbed,
    };
    mocks.container.singletons._aiProviderManager = { isReady: true, isMock: false };
    mocks.container.singletons._embedProvider = legacyOnly ? { embed: legacyEmbed } : null;
    const response = await invokeRouter(commandsRouter, {
      method: 'POST',
      mountPath: '/api/v1/commands',
      path: '/api/v1/commands/embed',
      body: {},
    });
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      success: false,
      error: {
        message:
          'Independent embedding provider unavailable. Configure embedding before rebuilding the semantic index.',
      },
      data: { ok: false, status: 'error' },
    });
    expect(mocks.container.get).not.toHaveBeenCalled();
    expect(vector.clear).not.toHaveBeenCalled();
    expect(vector.fullBuild).not.toHaveBeenCalled();
    expect(pipeline.run).not.toHaveBeenCalled();
    expect(legacyEmbed).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

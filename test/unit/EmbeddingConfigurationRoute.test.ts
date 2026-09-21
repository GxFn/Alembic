import fs from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AI_ENV_KEYS, WorkspaceSettingsStore } from '@alembic/core/shared';
import express from 'express';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createEmbeddingProvider } from '../../lib/injection/EmbeddingProvider.js';

const mocks = vi.hoisted(() => ({
  container: {
    singletons: {} as Record<string, unknown>,
    get: vi.fn(),
    reloadAiProvider: vi.fn(),
  },
  createProvider: vi.fn((options: Record<string, unknown>) => ({
    name: options.provider,
    model: options.model || 'fixture-generating-model',
  })),
}));

vi.mock('../../lib/injection/ServiceContainer.js', () => ({
  getServiceContainer: () => mocks.container,
}));
vi.mock('@alembic/agent/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@alembic/agent/ai')>()),
  createProvider: mocks.createProvider,
}));

import aiRouter from '../../lib/http/routes/ai.js';

const embeddingEnv = {
  ALEMBIC_EMBED_PROVIDER: 'ollama',
  ALEMBIC_EMBED_MODEL: 'qwen3-embedding:0.6b',
  ALEMBIC_EMBED_BASE_URL: 'http://embedding.invalid',
  ALEMBIC_EMBED_API_KEY: 'fixture-embedding-key-current',
};

describe('embedding configuration HTTP boundary', () => {
  let sandbox: string;
  let server: Server;
  let port: number;
  let writeConfig: ReturnType<typeof vi.spyOn<WorkspaceSettingsStore, 'writeAiConfig'>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'alembic-embedding-route-'));
    const projectRoot = path.join(sandbox, 'project');
    await fs.mkdir(projectRoot);
    // 保留真实SettingsStore读面，但所有路径和环境都落到当前用例的独立沙箱。
    vi.stubEnv('ALEMBIC_HOME', path.join(sandbox, 'home'));
    vi.stubEnv('ALEMBIC_PROJECT_DIR', projectRoot);
    for (const key of AI_ENV_KEYS) {
      vi.stubEnv(key, undefined);
    }
    for (const [key, value] of Object.entries(embeddingEnv)) {
      vi.stubEnv(key, value);
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Configuration routes must not contact an embedding or LLM service');
      })
    );
    mocks.container.singletons = {
      _projectRoot: projectRoot,
      _config: {},
      _embedProvider: createEmbeddingProvider({}, embeddingEnv),
    };
    writeConfig = vi
      .spyOn(WorkspaceSettingsStore.prototype, 'writeAiConfig')
      .mockImplementation(function (this: WorkspaceSettingsStore) {
        return this.readAiConfig();
      });
    const app = express();
    app.use(express.json());
    app.use('/api/v1/ai', aiRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Fixture HTTP server did not acquire a loopback port');
    }
    port = address.port;
  });

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (sandbox) {
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  });

  function post(body: Record<string, unknown>) {
    return new Promise<{ status: number; body: Record<string, unknown>; text: string }>(
      (resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/api/v1/ai/env-config',
            headers: { 'content-type': 'application/json' },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('error', reject);
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8');
              try {
                resolve({
                  status: res.statusCode || 0,
                  body: JSON.parse(text) as Record<string, unknown>,
                  text,
                });
              } catch (err: unknown) {
                reject(err);
              }
            });
          }
        );
        req.on('error', reject);
        req.setTimeout(5_000, () => req.destroy(new Error('Fixture HTTP request timed out')));
        req.end(JSON.stringify(body));
      }
    );
  }

  function currentEmbedding() {
    const current = mocks.container.singletons._embedProvider as ReturnType<
      typeof createEmbeddingProvider
    >;
    if (!current) {
      throw new Error('Fixture fixed embedding provider is missing');
    }
    return current;
  }

  function expectNoPrivateIdentity(text: string, nextEnv: Record<string, string> = embeddingEnv) {
    const current = currentEmbedding();
    const next = createEmbeddingProvider({}, nextEnv);
    if (!next) {
      throw new Error('Fixture comparison embedding provider is missing');
    }
    for (const provider of [current, next]) {
      expect(text).not.toContain(provider.profileId);
      expect(text).not.toContain(provider.configurationId);
    }
    expect(text).not.toContain('profileId');
    expect(text).not.toContain('configurationId');
    expect(text).not.toContain(embeddingEnv.ALEMBIC_EMBED_API_KEY);
    expect(text).not.toContain(nextEnv.ALEMBIC_EMBED_API_KEY);
  }

  test.each([
    { label: 'provider', update: { embedProvider: 'unsupported-embedding' } },
    { label: 'model', update: { embedModel: 'nomic-embed-text' } },
  ])('rejects unsupported embedding $label before persistence or LLM reload', async ({
    update,
  }) => {
    const current = currentEmbedding();
    const response = await post({ provider: 'openai', ...update });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      error: { code: 'EMBEDDING_CONFIG_INVALID' },
    });
    expect(writeConfig).not.toHaveBeenCalled();
    expect(mocks.createProvider).not.toHaveBeenCalled();
    expect(mocks.container.reloadAiProvider).not.toHaveBeenCalled();
    expect(mocks.container.singletons._embedProvider).toBe(current);
    for (const [key, value] of Object.entries(embeddingEnv)) {
      expect(process.env[key]).toBe(value);
    }
    expectNoPrivateIdentity(response.text);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    { label: 'LLM-only update', embeddingUpdate: {} },
    {
      label: 'unchanged embedding values',
      embeddingUpdate: {
        embedProvider: 'ollama',
        embedModel: 'qwen3-embedding:0.6b',
        embedBaseUrl: 'http://embedding.invalid',
        embedApiKey: embeddingEnv.ALEMBIC_EMBED_API_KEY,
      },
    },
  ])('does not require embedding restart or rebuild for $label', async ({ embeddingUpdate }) => {
    const current = currentEmbedding();
    const response = await post({
      provider: 'openai',
      model: 'fixture-next-llm',
      ...embeddingUpdate,
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        embeddingRestartRequired: false,
        embeddingRebuildRequired: false,
      },
    });
    expect(writeConfig).toHaveBeenCalledOnce();
    expect(writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ ALEMBIC_AI_MODEL: 'fixture-next-llm' })
    );
    expect(mocks.container.reloadAiProvider).toHaveBeenCalledOnce();
    expect(mocks.container.singletons._embedProvider).toBe(current);
    expectNoPrivateIdentity(response.text);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('requires restart and rebuild for a new embedding model without replacing the active provider', async () => {
    const current = currentEmbedding();
    const response = await post({ provider: 'openai', embedModel: 'qwen3-embedding:4b' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        embeddingRestartRequired: true,
        embeddingRebuildRequired: true,
      },
    });
    expect(writeConfig).toHaveBeenCalledExactlyOnceWith({
      ALEMBIC_AI_PROVIDER: 'openai',
      ALEMBIC_EMBED_MODEL: 'qwen3-embedding:4b',
    });
    expect(mocks.container.singletons._embedProvider).toBe(current);
    expect(current.describeCapabilities()).toMatchObject({
      model: 'qwen3-embedding:0.6b',
      dimension: 1024,
    });
    expectNoPrivateIdentity(response.text, {
      ...embeddingEnv,
      ALEMBIC_EMBED_MODEL: 'qwen3-embedding:4b',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('requires restart but not vector rebuild for an embedding credential rotation', async () => {
    const current = currentEmbedding();
    const credential = 'fixture-embedding-key-rotated';
    const response = await post({ provider: 'openai', embedApiKey: credential });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        embeddingRestartRequired: true,
        embeddingRebuildRequired: false,
      },
    });
    expect(writeConfig).toHaveBeenCalledExactlyOnceWith({
      ALEMBIC_AI_PROVIDER: 'openai',
      ALEMBIC_EMBED_API_KEY: credential,
    });
    expect(mocks.container.singletons._embedProvider).toBe(current);
    expectNoPrivateIdentity(response.text, { ...embeddingEnv, ALEMBIC_EMBED_API_KEY: credential });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('does not validate unrelated existing embedding config during a LLM-only update', async () => {
    const current = currentEmbedding();
    vi.stubEnv('ALEMBIC_EMBED_MODEL', 'legacy-unavailable-model');
    const response = await post({ provider: 'openai', model: 'fixture-next-llm' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        embeddingRestartRequired: false,
        embeddingRebuildRequired: false,
      },
    });
    expect(writeConfig).toHaveBeenCalledExactlyOnceWith({
      ALEMBIC_AI_PROVIDER: 'openai',
      ALEMBIC_AI_MODEL: 'fixture-next-llm',
    });
    expect(mocks.container.reloadAiProvider).toHaveBeenCalledOnce();
    expect(mocks.container.singletons._embedProvider).toBe(current);
    expectNoPrivateIdentity(response.text);
    expect(fetch).not.toHaveBeenCalled();
  });
});

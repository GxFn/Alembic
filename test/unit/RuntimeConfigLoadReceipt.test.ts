import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import { getGhostWorkspaceDir, ProjectRegistry } from '@alembic/core/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { AppRuntime } from '../../lib/Bootstrap.js';
import {
  alignDeepSeekReasoningEffort,
  createRuntimeConfigLoadReceiptV1,
} from '../../lib/infrastructure/config/RuntimeConfigLoadReceipt.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe('RuntimeConfigLoadReceiptV1', () => {
  it('records real precedence, aligns DeepSeek reasoning, and never serializes secrets or paths', async () => {
    const projectRoot = createGhostProject({
      settings: {
        ai: {
          model: 'deepseek-v4-pro',
          provider: 'deepseek',
          reasoningEffort: 'max',
        },
        version: 1,
      },
      secrets: {
        ai: { providerKeys: { deepseek: 'workspace-secret-value' } },
        version: 1,
      },
      config: {
        vector: {
          localEmbedding: {
            enabled: true,
            endpoint: 'http://127.0.0.1:11434/private-path',
            model: 'qwen3-embedding:0.6b',
          },
        },
        version: 2,
      },
    });
    process.env.ALEMBIC_PROJECT_DIR = projectRoot;
    process.env.ALEMBIC_AI_MODEL = 'deepseek-v4-flash';
    process.env.ALEMBIC_DEEPSEEK_BASE_URL = 'https://private.example.invalid/v1';
    delete process.env.ALEMBIC_DEEPSEEK_REASONING_EFFORT;

    await new AppRuntime().loadRuntimeSettings();
    alignDeepSeekReasoningEffort(process.env);

    const receipt = createRuntimeConfigLoadReceiptV1({
      artifactBindings: {
        promptSopEvaluatorBundleHash: sha('prompt-sop-evaluator'),
        vectorAdapterHash: sha('vector-adapter'),
      },
      env: process.env,
      planning: planning(),
      projectRoot,
      actualProvider: {
        name: 'deepseek',
        model: 'deepseek-v4-flash',
        baseUrl: 'https://private.example.invalid/v1',
        _transportExtras: { reasoningEffort: 'max' },
      },
      actualEmbeddingProvider: {
        describeCapabilities: () => ({
          provider: 'ollama',
          model: 'qwen3-embedding:0.6b',
          dimension: 768,
          normalization: 'l2',
          batchSupported: true,
        }),
      },
    });

    expect(process.env.ALEMBIC_DEEPSEEK_REASONING_EFFORT).toBe('max');
    expect(receipt.precedence).toEqual([
      'workspace-settings',
      'process-env/provider-specific-override',
      'workspace-resolver-vector-localEmbedding-fallback',
    ]);
    expect(receipt.keys.ALEMBIC_AI_PROVIDER).toMatchObject({
      presence: 'present',
      source: 'workspace-settings',
    });
    expect(receipt.keys.ALEMBIC_AI_MODEL).toMatchObject({
      presence: 'present',
      source: 'process-env',
    });
    expect(receipt.keys.ALEMBIC_DEEPSEEK_REASONING_EFFORT).toMatchObject({
      presence: 'present',
      source: 'derived-from-ALEMBIC_AI_REASONING_EFFORT',
    });
    expect(receipt.keys.ALEMBIC_EMBED_PROVIDER).toMatchObject({
      presence: 'present',
      source: 'workspace-resolver-vector-localEmbedding-fallback',
    });
    expect(receipt.effective).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      deepSeekEndpointSymbol: 'env:ALEMBIC_DEEPSEEK_BASE_URL',
      reasoningEffort: 'max',
      embedding: {
        provider: 'ollama',
        model: 'qwen3-embedding:0.6b',
        endpointSymbol: 'workspace-resolver:vector.localEmbedding.endpoint',
        dimensions: 768,
        normalization: 'l2',
        batchSupported: true,
      },
    });
    expect(receipt.promptSopBudgets).toMatchObject({
      promptHash: sha('prompt'),
      modelHash: sha('model'),
      promptSopEvaluatorBundleHash: sha('prompt-sop-evaluator'),
      strictConfigSourceArtifactHash: sha('strict-config'),
    });
    expect(receipt.vector).toMatchObject({
      store: 'json',
      schema: 'RecipeVectorGenerationManifestV1',
      distance: 'cosine-similarity',
      inspection: 'required-healthy',
      routeAdapter: 'active-generation-routing',
    });
    expect(receipt.configHash).toBe(
      hashCanonicalJson({
        effective: receipt.effective,
        keys: receipt.keys,
        precedence: receipt.precedence,
        promptSopBudgets: receipt.promptSopBudgets,
        vector: receipt.vector,
      })
    );

    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain('workspace-secret-value');
    expect(serialized).not.toContain('private.example.invalid');
    expect(serialized).not.toContain('127.0.0.1');
    expect(serialized).not.toContain(projectRoot);
  });

  it('uses typed not-applicable reasons for provider-specific and credential fields', async () => {
    const projectRoot = createGhostProject({
      settings: { ai: { provider: 'openai', model: 'gpt-5.5' }, version: 1 },
    });
    process.env.ALEMBIC_PROJECT_DIR = projectRoot;
    process.env.ALEMBIC_OPENAI_API_KEY = 'openai-secret';
    delete process.env.ALEMBIC_DEEPSEEK_API_KEY;
    delete process.env.ALEMBIC_DEEPSEEK_BASE_URL;
    delete process.env.ALEMBIC_DEEPSEEK_REASONING_EFFORT;
    delete process.env.ALEMBIC_EMBED_PROVIDER;

    await new AppRuntime().loadRuntimeSettings();
    const receipt = createRuntimeConfigLoadReceiptV1({
      artifactBindings: {
        promptSopEvaluatorBundleHash: sha('prompt-sop-evaluator'),
        vectorAdapterHash: sha('vector-adapter'),
      },
      env: process.env,
      planning: planning(),
      projectRoot,
    });

    expect(receipt.keys.ALEMBIC_DEEPSEEK_BASE_URL).toEqual({
      presence: 'not-applicable',
      source: 'not-applicable',
      reason: 'effective-provider-is-not-deepseek',
    });
    expect(receipt.keys.ALEMBIC_DEEPSEEK_API_KEY).toEqual({
      presence: 'not-applicable',
      source: 'not-applicable',
      reason: 'effective-provider-is-not-deepseek',
    });
    expect(receipt.keys.ALEMBIC_EMBED_API_KEY).toMatchObject({
      presence: 'not-applicable',
      reason: 'embedding-uses-primary-provider-fallback',
    });
    expect(JSON.stringify(receipt)).not.toContain('openai-secret');
  });

  it('fails closed instead of treating an unreadable existing vector config as absent', () => {
    const projectRoot = createGhostProject({ malformedConfig: true });
    process.env.ALEMBIC_PROJECT_DIR = projectRoot;
    process.env.ALEMBIC_AI_PROVIDER = 'deepseek';
    process.env.ALEMBIC_AI_MODEL = 'deepseek-v4-flash';

    expect(() =>
      createRuntimeConfigLoadReceiptV1({
        artifactBindings: {
          promptSopEvaluatorBundleHash: sha('prompt-sop-evaluator'),
          vectorAdapterHash: sha('vector-adapter'),
        },
        env: process.env,
        planning: planning(),
        projectRoot,
      })
    ).toThrow('STRICT_RUNTIME_CONFIG_WORKSPACE_RESOLVER_INVALID');
  });
});

function createGhostProject(input: {
  settings?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  config?: Record<string, unknown>;
  malformedConfig?: boolean;
}): string {
  process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-config-home-'));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-config-project-'));
  const entry = ProjectRegistry.register(projectRoot, true);
  const runtimeDir = path.join(getGhostWorkspaceDir(entry.id), '.asd');
  fs.mkdirSync(runtimeDir, { recursive: true });
  for (const [file, value] of [
    ['settings.json', input.settings],
    ['secrets.json', input.secrets],
    ['config.json', input.config],
  ] as const) {
    if (value) {
      fs.writeFileSync(path.join(runtimeDir, file), `${JSON.stringify(value)}\n`);
    }
  }
  if (input.malformedConfig) {
    fs.writeFileSync(path.join(runtimeDir, 'config.json'), '{malformed-json\n');
  }
  return projectRoot;
}

function planning() {
  return {
    factQueryFamilies: [],
    modelHash: sha('model'),
    promptHash: sha('prompt'),
    strictConfig: {
      sourceArtifactHash: sha('strict-config'),
      strictColdStart: {
        candidateAttemptCap: 3,
        cellWireBound: 50,
        costMicrousdCap: 1000,
        detailRequestCap: 4,
        factQueryObligationCap: 30,
        fileReadCap: 20,
        moduleWireBound: 20,
        providerRequestCap: 5,
        repairCap: 2,
        timeMsCap: 30_000,
        tokenCap: 10_000,
      },
      fieldSources: {},
    },
    reviewer: {
      calibrationReceiptHash: sha('calibration'),
      identity: { provider: 'fixture', model: 'reviewer', method: 'frozen' },
    },
  } as const;
}

function sha(value: string): `sha256:${string}` {
  return hashCanonicalJson(value);
}

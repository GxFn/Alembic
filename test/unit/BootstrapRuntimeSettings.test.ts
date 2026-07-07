import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectAiEnvOverrides,
  getGhostWorkspaceDir,
  ProjectRegistry,
  WorkspaceSettingsStore,
} from '@alembic/core/shared';
import { afterEach, describe, expect, test } from 'vitest';
import { AppRuntime } from '../../lib/Bootstrap.js';

const ORIGINAL_ENV = snapshotEnv();

function useTempAlembicHome(): void {
  process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-runtime-home-'));
}

function makeProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-runtime-project-'));
}

function clearAiEnv(): void {
  for (const key of [
    'ALEMBIC_PROJECT_DIR',
    'ALEMBIC_AI_PROVIDER',
    'ALEMBIC_AI_MODEL',
    'ALEMBIC_DEEPSEEK_API_KEY',
    'ALEMBIC_EMBED_PROVIDER',
    'ALEMBIC_EMBED_MODEL',
    'ALEMBIC_EMBED_BASE_URL',
    'ALEMBIC_EMBED_API_KEY',
  ]) {
    delete process.env[key];
  }
}

afterEach(() => {
  restoreEnv(ORIGINAL_ENV);
});

describe('AppRuntime.loadRuntimeSettings', () => {
  test('bridges v2 vector.localEmbedding config into dedicated embed env', async () => {
    useTempAlembicHome();
    clearAiEnv();
    const projectRoot = makeProjectRoot();
    const entry = ProjectRegistry.register(projectRoot, true);
    const runtimeDir = path.join(getGhostWorkspaceDir(entry.id), '.asd');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
      path.join(runtimeDir, 'settings.json'),
      JSON.stringify(
        {
          ai: {
            provider: 'deepseek',
            model: 'deepseek-v4-pro',
          },
          version: 1,
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(runtimeDir, 'config.json'),
      JSON.stringify(
        {
          vector: {
            localEmbedding: {
              enabled: true,
              endpoint: 'http://127.0.0.1:11434',
              model: 'qwen3-embedding:0.6b',
            },
          },
          version: 2,
        },
        null,
        2
      )
    );
    process.env.ALEMBIC_PROJECT_DIR = projectRoot;

    await new AppRuntime().loadRuntimeSettings();

    expect(process.env.ALEMBIC_AI_PROVIDER).toBe('deepseek');
    expect(process.env.ALEMBIC_AI_MODEL).toBe('deepseek-v4-pro');
    expect(process.env.ALEMBIC_EMBED_PROVIDER).toBe('ollama');
    expect(process.env.ALEMBIC_EMBED_MODEL).toBe('qwen3-embedding:0.6b');
    expect(process.env.ALEMBIC_EMBED_BASE_URL).toBe('http://127.0.0.1:11434');
  });

  test('keeps explicit embed provider env ahead of v2 localEmbedding config', async () => {
    useTempAlembicHome();
    clearAiEnv();
    const projectRoot = makeProjectRoot();
    const entry = ProjectRegistry.register(projectRoot, true);
    const runtimeDir = path.join(getGhostWorkspaceDir(entry.id), '.asd');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
      path.join(runtimeDir, 'config.json'),
      JSON.stringify(
        {
          vector: {
            localEmbedding: {
              enabled: true,
              endpoint: 'http://127.0.0.1:11434',
              model: 'qwen3-embedding:0.6b',
            },
          },
          version: 2,
        },
        null,
        2
      )
    );
    process.env.ALEMBIC_PROJECT_DIR = projectRoot;
    process.env.ALEMBIC_EMBED_PROVIDER = 'openai';
    process.env.ALEMBIC_EMBED_MODEL = 'text-embedding-3-small';

    await new AppRuntime().loadRuntimeSettings();

    expect(process.env.ALEMBIC_EMBED_PROVIDER).toBe('openai');
    expect(process.env.ALEMBIC_EMBED_MODEL).toBe('text-embedding-3-small');
    expect(process.env.ALEMBIC_EMBED_BASE_URL).toBeUndefined();
  });

  test('settings-store env-config observes the bridged embed env as process override', async () => {
    useTempAlembicHome();
    clearAiEnv();
    const projectRoot = makeProjectRoot();
    const entry = ProjectRegistry.register(projectRoot, true);
    const runtimeDir = path.join(getGhostWorkspaceDir(entry.id), '.asd');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
      path.join(runtimeDir, 'settings.json'),
      JSON.stringify({ ai: { provider: 'deepseek' }, version: 1 }, null, 2)
    );
    fs.writeFileSync(
      path.join(runtimeDir, 'config.json'),
      JSON.stringify(
        {
          vector: {
            localEmbedding: {
              enabled: true,
              endpoint: 'http://127.0.0.1:11434',
              model: 'qwen3-embedding:0.6b',
            },
          },
          version: 2,
        },
        null,
        2
      )
    );
    process.env.ALEMBIC_PROJECT_DIR = projectRoot;

    await new AppRuntime().loadRuntimeSettings();

    const settingsConfig = WorkspaceSettingsStore.fromProject(projectRoot).readAiConfig();
    const processConfig = collectAiEnvOverrides(settingsConfig.env, process.env);
    expect(settingsConfig.env).not.toHaveProperty('ALEMBIC_EMBED_PROVIDER');
    expect(processConfig).toMatchObject({
      ALEMBIC_EMBED_PROVIDER: 'ollama',
      ALEMBIC_EMBED_MODEL: 'qwen3-embedding:0.6b',
      ALEMBIC_EMBED_BASE_URL: 'http://127.0.0.1:11434',
    });
  });
});

function snapshotEnv(): Record<string, string | undefined> {
  return {
    ALEMBIC_AI_MODEL: process.env.ALEMBIC_AI_MODEL,
    ALEMBIC_AI_PROVIDER: process.env.ALEMBIC_AI_PROVIDER,
    ALEMBIC_DEEPSEEK_API_KEY: process.env.ALEMBIC_DEEPSEEK_API_KEY,
    ALEMBIC_EMBED_API_KEY: process.env.ALEMBIC_EMBED_API_KEY,
    ALEMBIC_EMBED_BASE_URL: process.env.ALEMBIC_EMBED_BASE_URL,
    ALEMBIC_EMBED_MODEL: process.env.ALEMBIC_EMBED_MODEL,
    ALEMBIC_EMBED_PROVIDER: process.env.ALEMBIC_EMBED_PROVIDER,
    ALEMBIC_HOME: process.env.ALEMBIC_HOME,
    ALEMBIC_PROJECT_DIR: process.env.ALEMBIC_PROJECT_DIR,
  };
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

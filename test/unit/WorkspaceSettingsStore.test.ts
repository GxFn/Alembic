import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectRegistry } from '@alembic/core/shared/ProjectRegistry';
import { WorkspaceSettingsStore } from '@alembic/core/shared/WorkspaceSettingsStore';
import { afterEach, describe, expect, test } from 'vitest';
import { Bootstrap } from '../../lib/bootstrap.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;
const ORIGINAL_PROJECT_DIR = process.env.ALEMBIC_PROJECT_DIR;
const ORIGINAL_PROVIDER = process.env.ALEMBIC_AI_PROVIDER;
const ORIGINAL_GOOGLE_KEY = process.env.ALEMBIC_GOOGLE_API_KEY;
const ORIGINAL_OPENAI_KEY = process.env.ALEMBIC_OPENAI_API_KEY;

function useTempAlembicHome(): void {
  process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-settings-home-'));
}

function makeProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-settings-project-'));
}

afterEach(() => {
  if (ORIGINAL_ALEMBIC_HOME === undefined) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
  }
  if (ORIGINAL_PROJECT_DIR === undefined) {
    delete process.env.ALEMBIC_PROJECT_DIR;
  } else {
    process.env.ALEMBIC_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
  }
  if (ORIGINAL_PROVIDER === undefined) {
    delete process.env.ALEMBIC_AI_PROVIDER;
  } else {
    process.env.ALEMBIC_AI_PROVIDER = ORIGINAL_PROVIDER;
  }
  if (ORIGINAL_GOOGLE_KEY === undefined) {
    delete process.env.ALEMBIC_GOOGLE_API_KEY;
  } else {
    process.env.ALEMBIC_GOOGLE_API_KEY = ORIGINAL_GOOGLE_KEY;
  }
  if (ORIGINAL_OPENAI_KEY === undefined) {
    delete process.env.ALEMBIC_OPENAI_API_KEY;
  } else {
    process.env.ALEMBIC_OPENAI_API_KEY = ORIGINAL_OPENAI_KEY;
  }
});

describe('WorkspaceSettingsStore', () => {
  test('stores non-secret AI settings separately from credentials in the ghost data root', () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    ProjectRegistry.register(projectRoot, true);
    const store = WorkspaceSettingsStore.fromProject(projectRoot);

    const result = store.writeAiConfig({
      ALEMBIC_AI_PROVIDER: 'google',
      ALEMBIC_AI_MODEL: 'gemini-3-flash-preview',
      ALEMBIC_GOOGLE_API_KEY: 'secret-google-key',
    });

    expect(result.env).toMatchObject({
      ALEMBIC_AI_PROVIDER: 'google',
      ALEMBIC_AI_MODEL: 'gemini-3-flash-preview',
      ALEMBIC_GOOGLE_API_KEY: 'secret-google-key',
    });
    expect(store.settingsPath).toContain(path.join('.asd', 'workspaces'));
    expect(store.settingsPath).not.toContain(projectRoot);
    expect(fs.existsSync(path.join(projectRoot, '.env'))).toBe(false);

    const settings = JSON.parse(fs.readFileSync(store.settingsPath, 'utf8')) as {
      ai: Record<string, string>;
    };
    const secrets = JSON.parse(fs.readFileSync(store.secretsPath, 'utf8')) as {
      ai: { providerKeys: Record<string, string> };
    };

    expect(settings.ai).toMatchObject({
      provider: 'google',
      model: 'gemini-3-flash-preview',
    });
    expect(JSON.stringify(settings)).not.toContain('secret-google-key');
    expect(secrets.ai.providerKeys.google).toBe('secret-google-key');
  });

  test('applies workspace settings without overriding explicit process env by default', () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    ProjectRegistry.register(projectRoot, true);
    const store = WorkspaceSettingsStore.fromProject(projectRoot);
    store.writeAiConfig({
      ALEMBIC_AI_PROVIDER: 'google',
      ALEMBIC_GOOGLE_API_KEY: 'secret-google-key',
    });
    process.env.ALEMBIC_AI_PROVIDER = 'openai';
    delete process.env.ALEMBIC_GOOGLE_API_KEY;

    store.applyToProcessEnv();

    expect(process.env.ALEMBIC_AI_PROVIDER).toBe('openai');
    expect(process.env.ALEMBIC_GOOGLE_API_KEY).toBe('secret-google-key');
  });

  test('bootstrap loads workspace settings without reading project env files', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    ProjectRegistry.register(projectRoot, true);
    fs.writeFileSync(
      path.join(projectRoot, '.env'),
      'ALEMBIC_AI_PROVIDER=openai\nALEMBIC_OPENAI_API_KEY=ignored-openai-key\n'
    );
    WorkspaceSettingsStore.fromProject(projectRoot).writeAiConfig({
      ALEMBIC_AI_PROVIDER: 'google',
      ALEMBIC_GOOGLE_API_KEY: 'secret-google-key',
    });
    process.env.ALEMBIC_PROJECT_DIR = projectRoot;
    delete process.env.ALEMBIC_AI_PROVIDER;
    delete process.env.ALEMBIC_GOOGLE_API_KEY;

    await new Bootstrap().loadRuntimeSettings();

    expect(process.env.ALEMBIC_AI_PROVIDER).toBe('google');
    expect(process.env.ALEMBIC_GOOGLE_API_KEY).toBe('secret-google-key');
    expect(process.env.ALEMBIC_OPENAI_API_KEY).toBeUndefined();
  });
});

import { WorkspaceResolver } from '../shared/WorkspaceResolver.js';
import {
  collectAiRuntimeOverrideDiff,
  maskAiRuntimeConfig,
  PROVIDER_KEY_ENV,
  WorkspaceSettingsStore,
} from '../shared/WorkspaceSettingsStore.js';

export type CodexAiConfigSource = 'empty' | 'runtime-overrides' | 'workspace-settings';

export interface CodexAiConfigState {
  allowsInternalBootstrap: boolean;
  hasRuntimeOverrides: boolean;
  hasSecretsFile: boolean;
  hasSettingsFile: boolean;
  missingKeyEnv: string | null;
  model: string | null;
  provider: string | null;
  ready: boolean;
  requiredKeyEnv: string | null;
  secretsPath: string;
  settingsPath: string;
  source: CodexAiConfigSource;
  vars: Record<string, string>;
}

export function inspectCodexAiConfig(
  projectRoot: string,
  env: Record<string, string | undefined> = process.env
): CodexAiConfigState {
  const resolver = WorkspaceResolver.fromProject(projectRoot);
  const store = new WorkspaceSettingsStore(resolver);
  const workspaceConfig = store.readAiConfig();
  const processConfig = collectAiRuntimeOverrideDiff(workspaceConfig.runtimeValues, env);
  const rawVars = {
    ...workspaceConfig.runtimeValues,
    ...processConfig,
  };
  const explicitProvider = normalizeProvider(rawVars.ALEMBIC_AI_PROVIDER);
  const inferredProvider = inferProviderFromKeys(rawVars);
  const provider =
    explicitProvider === 'auto' ? inferredProvider : explicitProvider || inferredProvider;
  const requiredKeyEnv = provider ? PROVIDER_KEY_ENV[provider] || null : null;
  const missingKeyEnv = requiredKeyEnv && !rawVars[requiredKeyEnv] ? requiredKeyEnv : null;
  const ready = Boolean(
    provider && provider !== 'mock' && (provider === 'ollama' || !missingKeyEnv)
  );

  return {
    allowsInternalBootstrap: ready,
    hasRuntimeOverrides: Object.keys(processConfig).length > 0,
    hasSecretsFile: workspaceConfig.hasSecretsFile,
    hasSettingsFile: workspaceConfig.hasSettingsFile,
    missingKeyEnv,
    model: rawVars.ALEMBIC_AI_MODEL || null,
    provider: provider || null,
    ready,
    requiredKeyEnv,
    secretsPath: workspaceConfig.secretsPath,
    settingsPath: workspaceConfig.settingsPath,
    source:
      Object.keys(processConfig).length > 0
        ? 'runtime-overrides'
        : workspaceConfig.hasSettingsFile || workspaceConfig.hasSecretsFile
          ? 'workspace-settings'
          : 'empty',
    vars: maskAiRuntimeConfig(rawVars),
  };
}

function normalizeProvider(provider: string | undefined): string | null {
  const normalized = provider?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === 'google-gemini' || normalized === 'gemini') {
    return 'google';
  }
  if (normalized === 'anthropic') {
    return 'claude';
  }
  return normalized;
}

function inferProviderFromKeys(vars: Record<string, string>): string | null {
  for (const [provider, envKey] of Object.entries(PROVIDER_KEY_ENV)) {
    if (vars[envKey]) {
      return provider;
    }
  }
  return null;
}

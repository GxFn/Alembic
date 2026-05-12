import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { WorkspaceResolver } from './WorkspaceResolver.js';

export const AI_SECRET_RUNTIME_KEYS = new Set([
  'ALEMBIC_GOOGLE_API_KEY',
  'ALEMBIC_OPENAI_API_KEY',
  'ALEMBIC_CLAUDE_API_KEY',
  'ALEMBIC_DEEPSEEK_API_KEY',
  'ALEMBIC_EMBED_API_KEY',
]);

export const AI_RUNTIME_OVERRIDE_KEYS = [
  'ALEMBIC_AI_PROVIDER',
  'ALEMBIC_AI_MODEL',
  'ALEMBIC_GOOGLE_API_KEY',
  'ALEMBIC_OPENAI_API_KEY',
  'ALEMBIC_CLAUDE_API_KEY',
  'ALEMBIC_DEEPSEEK_API_KEY',
  'ALEMBIC_AI_PROXY',
  'ALEMBIC_AI_REASONING_EFFORT',
  'ALEMBIC_EMBED_PROVIDER',
  'ALEMBIC_EMBED_MODEL',
  'ALEMBIC_EMBED_BASE_URL',
  'ALEMBIC_EMBED_API_KEY',
] as const;

export const PROVIDER_KEY_ENV: Record<string, string> = {
  google: 'ALEMBIC_GOOGLE_API_KEY',
  openai: 'ALEMBIC_OPENAI_API_KEY',
  claude: 'ALEMBIC_CLAUDE_API_KEY',
  deepseek: 'ALEMBIC_DEEPSEEK_API_KEY',
};

const ENV_TO_SETTING_FIELD: Record<string, keyof WorkspaceAiSettings> = {
  ALEMBIC_AI_PROVIDER: 'provider',
  ALEMBIC_AI_MODEL: 'model',
  ALEMBIC_AI_PROXY: 'proxy',
  ALEMBIC_AI_REASONING_EFFORT: 'reasoningEffort',
  ALEMBIC_EMBED_PROVIDER: 'embedProvider',
  ALEMBIC_EMBED_MODEL: 'embedModel',
  ALEMBIC_EMBED_BASE_URL: 'embedBaseUrl',
};

const SETTING_FIELD_TO_ENV: Record<keyof WorkspaceAiSettings, string> = {
  provider: 'ALEMBIC_AI_PROVIDER',
  model: 'ALEMBIC_AI_MODEL',
  proxy: 'ALEMBIC_AI_PROXY',
  reasoningEffort: 'ALEMBIC_AI_REASONING_EFFORT',
  embedProvider: 'ALEMBIC_EMBED_PROVIDER',
  embedModel: 'ALEMBIC_EMBED_MODEL',
  embedBaseUrl: 'ALEMBIC_EMBED_BASE_URL',
};

const ENV_TO_PROVIDER = Object.fromEntries(
  Object.entries(PROVIDER_KEY_ENV).map(([provider, envKey]) => [envKey, provider])
);

export interface WorkspaceAiSettings {
  provider?: string;
  model?: string;
  proxy?: string;
  reasoningEffort?: string;
  embedProvider?: string;
  embedModel?: string;
  embedBaseUrl?: string;
}

interface WorkspaceSettingsFile {
  ai?: WorkspaceAiSettings;
  updatedAt?: string;
  version?: number;
}

interface WorkspaceSecretsFile {
  ai?: {
    embedApiKey?: string;
    providerKeys?: Record<string, string>;
  };
  updatedAt?: string;
  version?: number;
}

export interface WorkspaceAiConfigRead {
  runtimeValues: Record<string, string>;
  hasSecretsFile: boolean;
  hasSettingsFile: boolean;
  secretsPath: string;
  settingsPath: string;
}

export type AiConfigSource = 'workspace-settings' | 'runtime-overrides' | 'empty';

export class WorkspaceSettingsStore {
  readonly resolver: WorkspaceResolver;
  readonly settingsPath: string;
  readonly secretsPath: string;

  constructor(resolver: WorkspaceResolver) {
    this.resolver = resolver;
    this.settingsPath = join(resolver.runtimeDir, 'settings.json');
    this.secretsPath = join(resolver.runtimeDir, 'secrets.json');
  }

  static fromProject(projectRoot: string): WorkspaceSettingsStore {
    return new WorkspaceSettingsStore(WorkspaceResolver.fromProject(resolve(projectRoot)));
  }

  readAiConfig(): WorkspaceAiConfigRead {
    const settings = this.#readSettings();
    const secrets = this.#readSecrets();
    const runtimeValues: Record<string, string> = {};

    for (const [field, envKey] of Object.entries(SETTING_FIELD_TO_ENV)) {
      const value = settings.ai?.[field as keyof WorkspaceAiSettings];
      if (typeof value === 'string' && value.length > 0) {
        runtimeValues[envKey] = value;
      }
    }

    const providerKeys = secrets.ai?.providerKeys || {};
    for (const [provider, envKey] of Object.entries(PROVIDER_KEY_ENV)) {
      const value = providerKeys[provider];
      if (typeof value === 'string' && value.length > 0) {
        runtimeValues[envKey] = value;
      }
    }
    if (typeof secrets.ai?.embedApiKey === 'string' && secrets.ai.embedApiKey.length > 0) {
      runtimeValues.ALEMBIC_EMBED_API_KEY = secrets.ai.embedApiKey;
    }

    return {
      runtimeValues,
      hasSecretsFile: existsSync(this.secretsPath),
      hasSettingsFile: existsSync(this.settingsPath),
      secretsPath: this.secretsPath,
      settingsPath: this.settingsPath,
    };
  }

  writeAiConfig(updates: Record<string, string>): WorkspaceAiConfigRead {
    const settings = this.#readSettings();
    const secrets = this.#readSecrets();
    settings.version = 1;
    settings.ai = settings.ai || {};
    secrets.version = 1;
    secrets.ai = secrets.ai || {};
    secrets.ai.providerKeys = secrets.ai.providerKeys || {};

    for (const [key, value] of Object.entries(updates)) {
      if (!value) {
        continue;
      }
      const settingField = ENV_TO_SETTING_FIELD[key];
      if (settingField) {
        settings.ai[settingField] = value;
        continue;
      }
      const provider = ENV_TO_PROVIDER[key];
      if (provider) {
        secrets.ai.providerKeys[provider] = value;
        continue;
      }
      if (key === 'ALEMBIC_EMBED_API_KEY') {
        secrets.ai.embedApiKey = value;
      }
    }

    const now = new Date().toISOString();
    settings.updatedAt = now;
    secrets.updatedAt = now;
    this.#writeJson(this.settingsPath, settings, 0o644);
    const hasSecrets =
      Boolean(secrets.ai.embedApiKey) ||
      Object.keys(secrets.ai.providerKeys || {}).length > 0 ||
      existsSync(this.secretsPath);
    if (hasSecrets) {
      this.#writeJson(this.secretsPath, secrets, 0o600);
    }
    return this.readAiConfig();
  }

  applyToProcessEnv(options: { override?: boolean } = {}): WorkspaceAiConfigRead {
    const config = this.readAiConfig();
    for (const [key, value] of Object.entries(config.runtimeValues)) {
      if (options.override || process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    return config;
  }

  #readSettings(): WorkspaceSettingsFile {
    return readJsonFile(this.settingsPath);
  }

  #readSecrets(): WorkspaceSecretsFile {
    return readJsonFile(this.secretsPath);
  }

  #writeJson(filePath: string, value: unknown, mode: number): void {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode });
    chmodSync(filePath, mode);
  }
}

export function isAiRuntimeConfigReady(runtimeValues: Record<string, string>): boolean {
  const provider = runtimeValues.ALEMBIC_AI_PROVIDER || '';
  const neededKey = PROVIDER_KEY_ENV[provider] || '';
  return Boolean(provider && (!neededKey || runtimeValues[neededKey]));
}

export function collectAiRuntimeOverrides(
  env: Record<string, string | undefined> = process.env
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of AI_RUNTIME_OVERRIDE_KEYS) {
    const value = env[key];
    if (typeof value === 'string' && value.length > 0) {
      result[key] = value;
    }
  }
  return result;
}

export function collectAiRuntimeOverrideDiff(
  baseEnv: Record<string, string>,
  env: Record<string, string | undefined> = process.env
): Record<string, string> {
  const processEnv = collectAiRuntimeOverrides(env);
  const overrides: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (baseEnv[key] !== value) {
      overrides[key] = value;
    }
  }
  return overrides;
}

export function maskAiSecret(value: string): string {
  if (!value) {
    return '';
  }
  if (value.length <= 8) {
    return '********';
  }
  return `${value.slice(0, 2)}...${value.slice(-4)}`;
}

export function maskAiRuntimeConfig(env: Record<string, string>): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if ((AI_RUNTIME_OVERRIDE_KEYS as readonly string[]).includes(key)) {
      vars[key] = AI_SECRET_RUNTIME_KEYS.has(key) ? maskAiSecret(value) : value;
    }
  }
  return vars;
}

function readJsonFile<T extends Record<string, unknown>>(filePath: string): T {
  try {
    if (!existsSync(filePath)) {
      return {} as T;
    }
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as T)
      : ({} as T);
  } catch {
    return {} as T;
  }
}

import { isAbsolute, join, resolve } from 'node:path';
import { getPackageVersion } from '../daemon/DaemonState.js';
import {
  ALEMBIC_CHANNEL_ID_ENV,
  ALEMBIC_CHANNEL_ID_FALLBACK_ENV,
  CODEX_CHANNEL_ID,
} from '../shared/channel.js';
import { PACKAGE_ROOT } from '../shared/package-root.js';

export const CODEX_PLUGIN_NAME = 'alembic-codex';
export const CODEX_RUNTIME_PACKAGE = 'alembic-ai';
export const CODEX_RUNTIME_BIN = 'alembic-codex-mcp';
export const CODEX_SETUP_PROFILE = 'codex-plugin';
export const CODEX_DEFAULT_MCP_TIER = 'agent';
export const ALEMBIC_RUNTIME_MODE_ENV = 'ALEMBIC_RUNTIME_MODE';
export const ALEMBIC_RUNTIME_MODE_PLUGIN = 'plugin';
export const ALEMBIC_PLUGIN_HOST_ENV = 'ALEMBIC_PLUGIN_HOST';
export const CODEX_PLUGIN_HOST = 'codex';
export const CODEX_MCP_MODE_ENV = 'ALEMBIC_MCP_MODE';
export const CODEX_MCP_SHIM_ENV = 'ALEMBIC_CODEX_MCP_MODE';
export const CODEX_MCP_TIER_ENV = 'ALEMBIC_MCP_TIER';
export const CODEX_ADMIN_ENABLE_ENV = 'ALEMBIC_CODEX_ENABLE_ADMIN';
export const CODEX_PLUGIN_ROOT_ENV = 'ALEMBIC_CODEX_PLUGIN_ROOT';
export const CODEX_EMBEDDED_RUNTIME_SPECIFIER = './runtime.tgz';

export interface CodexRuntimeContext {
  adminEnabled: boolean;
  channelId: string;
  channelPath: string;
  defaultTier: string;
  effectiveTier: string;
  expectedChannelId: string;
  expectedPluginHost: string;
  expectedRuntimeMode: string;
  marketplacePath: string;
  packageRoot: string;
  packageVersion: string;
  embeddedRuntimeSpecifier: string;
  pinnedRuntimeSpecifier: string;
  pluginHost: string;
  pluginRoot: string;
  requestedTier: string;
  runtimeBin: string;
  runtimeMode: string;
  runtimePackage: string;
}

export function ensureCodexRuntimeEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  env[ALEMBIC_RUNTIME_MODE_ENV] = env[ALEMBIC_RUNTIME_MODE_ENV] || ALEMBIC_RUNTIME_MODE_PLUGIN;
  env[ALEMBIC_PLUGIN_HOST_ENV] = env[ALEMBIC_PLUGIN_HOST_ENV] || CODEX_PLUGIN_HOST;
  env[CODEX_MCP_MODE_ENV] = '1';
  env[CODEX_MCP_SHIM_ENV] = '1';
  env[ALEMBIC_CHANNEL_ID_ENV] = env[ALEMBIC_CHANNEL_ID_ENV] || CODEX_CHANNEL_ID;
  env[CODEX_MCP_TIER_ENV] = env[CODEX_MCP_TIER_ENV] || CODEX_DEFAULT_MCP_TIER;
}

export function resolveCodexRuntimeContext(
  env: NodeJS.ProcessEnv = process.env
): CodexRuntimeContext {
  const packageVersion = getPackageVersion();
  const requestedTier = env[CODEX_MCP_TIER_ENV] || CODEX_DEFAULT_MCP_TIER;
  const adminEnabled = env[CODEX_ADMIN_ENABLE_ENV] === '1';
  const effectiveTier = resolveEffectiveCodexTier(requestedTier, adminEnabled);
  const channelId = resolveCodexChannelId(env);
  return {
    adminEnabled,
    channelId,
    channelPath: join(PACKAGE_ROOT, 'channels', CODEX_CHANNEL_ID, 'channel.json'),
    defaultTier: CODEX_DEFAULT_MCP_TIER,
    effectiveTier,
    expectedChannelId: CODEX_CHANNEL_ID,
    expectedPluginHost: CODEX_PLUGIN_HOST,
    expectedRuntimeMode: ALEMBIC_RUNTIME_MODE_PLUGIN,
    marketplacePath: join(PACKAGE_ROOT, '.agents', 'plugins', 'marketplace.json'),
    packageRoot: PACKAGE_ROOT,
    packageVersion,
    embeddedRuntimeSpecifier: CODEX_EMBEDDED_RUNTIME_SPECIFIER,
    pinnedRuntimeSpecifier: `${CODEX_RUNTIME_PACKAGE}@${packageVersion}`,
    pluginHost: normalizeRuntimeIdentity(env[ALEMBIC_PLUGIN_HOST_ENV]) || CODEX_PLUGIN_HOST,
    pluginRoot: resolveCodexPluginRoot(env),
    requestedTier,
    runtimeBin: CODEX_RUNTIME_BIN,
    runtimeMode:
      normalizeRuntimeIdentity(env[ALEMBIC_RUNTIME_MODE_ENV]) || ALEMBIC_RUNTIME_MODE_PLUGIN,
    runtimePackage: CODEX_RUNTIME_PACKAGE,
  };
}

function resolveCodexPluginRoot(env: NodeJS.ProcessEnv): string {
  const configured = env[CODEX_PLUGIN_ROOT_ENV]?.trim();
  if (configured) {
    return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  }
  return join(PACKAGE_ROOT, 'plugins', CODEX_PLUGIN_NAME);
}

export function resolveEffectiveCodexTier(tierName: string, adminEnabled: boolean): string {
  if (tierName === 'admin' && !adminEnabled) {
    return CODEX_DEFAULT_MCP_TIER;
  }
  return tierName || CODEX_DEFAULT_MCP_TIER;
}

export function resolveCodexChannelId(env: NodeJS.ProcessEnv = process.env): string {
  return (
    normalizeChannelId(env[ALEMBIC_CHANNEL_ID_ENV]) ||
    normalizeChannelId(env[ALEMBIC_CHANNEL_ID_FALLBACK_ENV]) ||
    CODEX_CHANNEL_ID
  );
}

function normalizeChannelId(value: string | undefined): string {
  return (value || '').trim().toLowerCase();
}

function normalizeRuntimeIdentity(value: string | undefined): string {
  return (value || '').trim().toLowerCase();
}

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CodexRuntimeContext, resolveCodexRuntimeContext } from './RuntimeContext.js';

export const CODEX_REQUIRED_SKILLS = [
  'alembic',
  'alembic-create',
  'alembic-devdocs',
  'alembic-guard',
  'alembic-recipes',
  'alembic-structure',
] as const;

export interface JsonReadResult {
  ok: boolean;
  path: string;
  value: Record<string, unknown> | null;
}

export interface CodexPluginRegistry {
  channel: JsonReadResult;
  context: CodexRuntimeContext;
  marketplace: JsonReadResult;
  mcp: {
    args: string[];
    env: Record<string, unknown> | null;
    json: JsonReadResult;
    server: Record<string, unknown> | null;
  };
  plugin: {
    assets: string[];
    manifest: JsonReadResult;
    readme: string;
    readmePath: string;
    root: string;
  };
}

export function loadCodexPluginRegistry(
  context: CodexRuntimeContext = resolveCodexRuntimeContext()
): CodexPluginRegistry {
  const manifestPath = join(context.pluginRoot, '.codex-plugin', 'plugin.json');
  const mcpPath = join(context.pluginRoot, '.mcp.json');
  const readmePath = join(context.pluginRoot, 'README.md');
  const manifest = readJsonObject(manifestPath);
  const mcpJson = readJsonObject(mcpPath);
  const server = asPlainRecord(asPlainRecord(mcpJson.value?.mcpServers)?.alembic);
  const args = Array.isArray(server?.args)
    ? server.args.filter((arg): arg is string => typeof arg === 'string')
    : [];
  const manifestInterface = asPlainRecord(manifest.value?.interface);

  return {
    channel: readJsonObject(context.channelPath),
    context,
    marketplace: readJsonObject(context.marketplacePath),
    mcp: {
      args,
      env: asPlainRecord(server?.env),
      json: mcpJson,
      server,
    },
    plugin: {
      assets: collectManifestAssetPaths(manifestInterface),
      manifest,
      readme: existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '',
      readmePath,
      root: context.pluginRoot,
    },
  };
}

export function readJsonObject(filePath: string): JsonReadResult {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return {
      ok: Boolean(parsed && typeof parsed === 'object'),
      path: filePath,
      value: asPlainRecord(parsed),
    };
  } catch {
    return { ok: false, path: filePath, value: null };
  }
}

export function collectManifestAssetPaths(
  manifestInterface: Record<string, unknown> | null
): string[] {
  const assets = [
    asString(manifestInterface?.composerIcon),
    asString(manifestInterface?.logo),
    ...(Array.isArray(manifestInterface?.screenshots)
      ? manifestInterface.screenshots.map((value) => asString(value))
      : []),
  ];
  return assets.filter((asset): asset is string => Boolean(asset));
}

export function asPlainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

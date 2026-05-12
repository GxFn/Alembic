#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const options = parseArgs(process.argv.slice(2));
const channel = readJson(join(projectRoot, 'channels', 'codex', 'channel.json'));
const pluginEntry = channel.plugins?.find((plugin) => plugin.name === 'alembic-codex');
if (!pluginEntry) {
  throw new Error('channels/codex/channel.json is missing the alembic-codex plugin entry');
}

const pluginRoot = join(projectRoot, pluginEntry.path);
const pluginManifest = readJson(join(pluginRoot, '.codex-plugin', 'plugin.json'));
const codexHome = resolve(options.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex'));
const marketplaceName = channel.marketplace?.name || 'gxfn';
const pluginName = pluginManifest.name || pluginEntry.name;
const pluginVersion = pluginManifest.version || pluginEntry.version || '0.1.0';
const targetRoot = join(codexHome, 'plugins', 'cache', marketplaceName, pluginName, pluginVersion);
const localMcpEntry = resolve(
  options.localMcpEntry || join(projectRoot, 'dist', 'bin', 'codex-mcp.js')
);

// 开发态 cache 同步只操作 Codex 插件缓存，不修改仓库内发布 manifest。
if (options.dryRun) {
  printSummary({ dryRun: true });
  process.exit(0);
}

if (options.clean) {
  rmSync(targetRoot, { force: true, recursive: true });
}
mkdirSync(dirname(targetRoot), { recursive: true });
cpSync(pluginRoot, targetRoot, { force: true, recursive: true });

if (options.localMcp) {
  rewriteCachedMcpForLocalDist(targetRoot);
}

printSummary({ dryRun: false });

function rewriteCachedMcpForLocalDist(cacheRoot) {
  if (!existsSync(localMcpEntry)) {
    throw new Error(`Local Codex MCP entry not found: ${localMcpEntry}. Run npm run build first.`);
  }

  const mcpPath = join(cacheRoot, '.mcp.json');
  const mcp = readJson(mcpPath);
  const serverNames = Object.keys(mcp.mcpServers || {});
  if (serverNames.length === 0) {
    throw new Error(`Cached MCP config has no mcpServers: ${mcpPath}`);
  }

  const serverName = serverNames.includes('alembic') ? 'alembic' : serverNames[0];
  const server = mcp.mcpServers[serverName] || {};
  const serverEnv = isRecord(server.env) ? server.env : {};
  mcp.mcpServers[serverName] = {
    ...server,
    command: process.execPath,
    args: [localMcpEntry],
    env: {
      ...serverEnv,
      ALEMBIC_CHANNEL_ID: 'codex',
      ALEMBIC_CODEX_MCP_MODE: '1',
      ALEMBIC_MCP_MODE: '1',
      ALEMBIC_MCP_TIER: serverEnv.ALEMBIC_MCP_TIER || 'agent',
    },
  };
  writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
}

function parseArgs(args) {
  const parsed = {
    clean: false,
    codexHome: '',
    dryRun: false,
    localMcpEntry: '',
    localMcp: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--clean') {
      parsed.clean = true;
    } else if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--local-mcp') {
      parsed.localMcp = true;
    } else if (arg === '--codex-home') {
      parsed.codexHome = args[index + 1] || '';
      index += 1;
    } else if (arg === '--local-mcp-entry') {
      parsed.localMcpEntry = args[index + 1] || '';
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function printSummary(input) {
  const summary = {
    dryRun: input.dryRun,
    marketplaceName,
    pluginName,
    pluginVersion,
    pluginRoot,
    targetRoot,
    clean: options.clean,
    ...(options.localMcp ? { localMcpEntry } : {}),
    localMcp: options.localMcp,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function printHelp() {
  process.stdout.write(`Sync Alembic Codex plugin into the local Codex plugin cache.

Usage:
  node scripts/sync-codex-plugin-cache.mjs [options]

Options:
  --dry-run             Print target paths without writing.
  --clean               Remove the cached plugin version before copying.
  --local-mcp           Rewrite cached .mcp.json to run local dist/bin/codex-mcp.js.
  --local-mcp-entry <path>
                        Override the local MCP entry used with --local-mcp.
  --codex-home <path>   Override CODEX_HOME, defaults to ~/.codex.
  -h, --help            Show this help.
`);
}

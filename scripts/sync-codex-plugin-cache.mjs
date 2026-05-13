#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
const pluginVersion = pluginManifest.version || pluginEntry.version || '0.1.1';
const localMcpEntry = resolve(
  options.localMcpEntry || join(projectRoot, 'dist', 'bin', 'codex-mcp.js')
);
const targetRoots = resolveTargetRoots();

// 开发态 cache 同步只操作 Codex 插件缓存，不修改仓库内发布 manifest。
if (options.dryRun) {
  printSummary({ dryRun: true });
  process.exit(0);
}

for (const targetRoot of targetRoots) {
  syncTarget(targetRoot);
}

printSummary({ dryRun: false });

function resolveTargetRoots() {
  const explicit = [];
  for (const target of options.targetRoots) {
    explicit.push(resolve(target));
  }
  if (options.marketplaceName) {
    explicit.push(
      join(codexHome, 'plugins', 'cache', options.marketplaceName, pluginName, pluginVersion)
    );
  }
  const defaultTarget = join(
    codexHome,
    'plugins',
    'cache',
    marketplaceName,
    pluginName,
    pluginVersion
  );
  explicit.push(defaultTarget);

  if (options.allInstalled) {
    for (const installed of findInstalledPluginRoots()) {
      explicit.push(installed);
    }
  }

  return [...new Set(explicit)];
}

function findInstalledPluginRoots() {
  const cacheRoot = join(codexHome, 'plugins', 'cache');
  if (!existsSync(cacheRoot)) {
    return [];
  }
  const found = [];
  for (const first of safeReaddir(cacheRoot)) {
    const firstPath = join(cacheRoot, first);
    if (!safeIsDirectory(firstPath)) {
      continue;
    }
    for (const second of safeReaddir(firstPath)) {
      const secondPath = join(firstPath, second);
      if (!safeIsDirectory(secondPath)) {
        continue;
      }
      for (const third of safeReaddir(secondPath)) {
        const candidate = join(secondPath, third);
        if (!safeIsDirectory(candidate)) {
          continue;
        }
        const manifestPath = join(candidate, '.codex-plugin', 'plugin.json');
        if (!existsSync(manifestPath)) {
          continue;
        }
        const manifest = readJson(manifestPath);
        if (manifest.name === pluginName && manifest.version === pluginVersion) {
          found.push(candidate);
        }
      }
    }
  }
  return found;
}

function syncTarget(targetRoot) {
  const stagingRoot = `${targetRoot}.tmp-${process.pid}-${Date.now()}`;
  rmSync(stagingRoot, { force: true, recursive: true });
  mkdirSync(dirname(stagingRoot), { recursive: true });
  cpSync(pluginRoot, stagingRoot, {
    force: true,
    recursive: true,
    filter(sourcePath) {
      return !sourcePath.split('/').includes('.git');
    },
  });

  if (options.localMcp) {
    rewriteCachedMcpForLocalDist(stagingRoot);
  }
  writeRefreshMarker(stagingRoot, targetRoot);

  if (options.clean || existsSync(targetRoot)) {
    rmSync(targetRoot, { force: true, recursive: true });
  }
  renameSync(stagingRoot, targetRoot);
}

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
      ALEMBIC_PLUGIN_HOST: 'codex',
      ALEMBIC_CODEX_MCP_MODE: '1',
      ALEMBIC_MCP_MODE: '1',
      ALEMBIC_MCP_TIER: serverEnv.ALEMBIC_MCP_TIER || 'agent',
      ALEMBIC_RUNTIME_MODE: 'plugin',
    },
  };
  writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
}

function parseArgs(args) {
  const parsed = {
    allInstalled: false,
    clean: false,
    codexHome: '',
    dryRun: false,
    localMcpEntry: '',
    localMcp: false,
    marketplaceName: '',
    targetRoots: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--clean') {
      parsed.clean = true;
    } else if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--local-mcp') {
      parsed.localMcp = true;
    } else if (arg === '--all-installed') {
      parsed.allInstalled = true;
    } else if (arg === '--codex-home') {
      parsed.codexHome = args[index + 1] || '';
      index += 1;
    } else if (arg === '--local-mcp-entry') {
      parsed.localMcpEntry = args[index + 1] || '';
      index += 1;
    } else if (arg === '--marketplace-name') {
      parsed.marketplaceName = args[index + 1] || '';
      index += 1;
    } else if (arg === '--target-root') {
      parsed.targetRoots.push(args[index + 1] || '');
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

function safeReaddir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function safeIsDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function writeRefreshMarker(cacheRoot, targetRoot) {
  const marker = {
    schemaVersion: 1,
    refreshedAt: new Date().toISOString(),
    mode: options.localMcp ? 'local-mcp' : 'packaged-runtime',
    sourceRoot: pluginRoot,
    targetRoot,
    packageVersion: readJson(join(projectRoot, 'package.json')).version,
    pluginVersion,
    gitHead: readGitHead(),
    localMcpEntry: options.localMcp ? localMcpEntry : null,
    hashes: {
      mcp: hashFile(join(cacheRoot, '.mcp.json')),
      manifest: hashFile(join(cacheRoot, '.codex-plugin', 'plugin.json')),
      runtimeTarball: hashFile(join(cacheRoot, 'runtime.tgz')),
      wrapper: hashFile(join(cacheRoot, 'bin', 'alembic-codex-mcp-wrapper.mjs')),
    },
  };
  writeFileSync(
    join(cacheRoot, '.alembic-dev-refresh.json'),
    `${JSON.stringify(marker, null, 2)}\n`
  );
}

function hashFile(path) {
  if (!existsSync(path)) {
    return null;
  }
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readGitHead() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function printSummary(input) {
  const summary = {
    dryRun: input.dryRun,
    marketplaceName,
    pluginName,
    pluginVersion,
    pluginRoot,
    targetRoots,
    clean: options.clean,
    ...(options.localMcp ? { localMcpEntry } : {}),
    localMcp: options.localMcp,
    allInstalled: options.allInstalled,
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
  --all-installed       Also refresh installed alembic-codex cache roots with the same version.
  --local-mcp           Rewrite cached .mcp.json to run local dist/bin/codex-mcp.js.
  --local-mcp-entry <path>
                        Override the local MCP entry used with --local-mcp.
  --codex-home <path>   Override CODEX_HOME, defaults to ~/.codex.
  --marketplace-name <name>
                        Refresh cache path for this marketplace name.
  --target-root <path>  Refresh this explicit installed plugin cache root.
  -h, --help            Show this help.
`);
}

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

const projectRoot = process.cwd();
const scriptPath = join(projectRoot, 'scripts', 'sync-codex-plugin-cache.mjs');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('Codex plugin cache sync script', () => {
  test('prints the gxfn cache target without writing during dry-run', () => {
    const codexHome = tempDir();
    const output = runSyncScript('--dry-run', '--codex-home', codexHome);
    const summary = JSON.parse(output) as { targetRoots: string[] };
    const [targetRoot] = summary.targetRoots;

    expect(targetRoot).toBe(join(codexHome, 'plugins', 'cache', 'gxfn', 'alembic-codex', '0.1.2'));
    expect(existsSync(targetRoot)).toBe(false);
  });

  test('copies the plugin and rewrites only the cached MCP config for local dist', () => {
    const codexHome = tempDir();
    const localEntry = join(tempDir(), 'codex-mcp.js');
    writeFileSync(localEntry, '#!/usr/bin/env node\n');

    const output = runSyncScript(
      '--codex-home',
      codexHome,
      '--local-mcp',
      '--local-mcp-entry',
      localEntry
    );
    const summary = JSON.parse(output) as { targetRoots: string[] };
    const [targetRoot] = summary.targetRoots;
    const cachedMcpPath = join(targetRoot, '.mcp.json');
    const repoMcpPath = join(projectRoot, 'plugins', 'alembic-codex', '.mcp.json');
    const cachedMcp = JSON.parse(readFileSync(cachedMcpPath, 'utf8'));
    const repoMcp = JSON.parse(readFileSync(repoMcpPath, 'utf8'));

    expect(existsSync(join(targetRoot, '.codex-plugin', 'plugin.json'))).toBe(true);
    expect(cachedMcp.mcpServers.alembic.command).toBe(process.execPath);
    expect(cachedMcp.mcpServers.alembic.args).toEqual([localEntry]);
    expect(cachedMcp.mcpServers.alembic.env.ALEMBIC_CHANNEL_ID).toBe('codex');
    expect(cachedMcp.mcpServers.alembic.env.ALEMBIC_RUNTIME_MODE).toBe('plugin');
    expect(cachedMcp.mcpServers.alembic.env.ALEMBIC_PLUGIN_HOST).toBe('codex');
    expect(repoMcp.mcpServers.alembic.command).toBe('node');
    expect(repoMcp.mcpServers.alembic.args).toContain('./bin/alembic-codex-mcp-wrapper.mjs');
  });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'alembic-codex-cache-sync-'));
  roots.push(dir);
  return dir;
}

function runSyncScript(...args: string[]) {
  return execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
}

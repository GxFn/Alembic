import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = process.cwd();

describe('resident service HTTP boundary', () => {
  test('does not expose the removed MCP compat bridge route', () => {
    const httpServerSource = readFileSync(join(repoRoot, 'lib/http/HttpServer.ts'), 'utf8');
    const removedRouteImport = 'routes' + '/mcp';
    const removedMount = '`${apiPrefix}' + '/mcp`';
    const removedRouteFile = join(repoRoot, 'lib/http/routes', 'mcp.ts');
    const removedDispatcherFile = join(repoRoot, 'lib/external/mcp', 'McpBridge' + 'Dispatcher.ts');

    // Codex-facing MCP tools belong to AlembicPlugin. Alembic daemon only exposes resident
    // service APIs such as search, so the removed HTTP bridge must stay absent.
    expect(httpServerSource).not.toContain(removedRouteImport);
    expect(httpServerSource).not.toContain(removedMount);
    expect(existsSync(removedRouteFile)).toBe(false);
    expect(existsSync(removedDispatcherFile)).toBe(false);
  });

  test('keeps Alembic-owned bootstrap and rescan consumers on resident handler paths', () => {
    const cliSource = readFileSync(join(repoRoot, 'bin/cli.ts'), 'utf8');
    const daemonRunnerSource = readFileSync(
      join(repoRoot, 'lib/daemon/DaemonJobRunner.ts'),
      'utf8'
    );
    const candidatesRouteSource = readFileSync(
      join(repoRoot, 'lib/http/routes/candidates.ts'),
      'utf8'
    );
    const oldBootstrapPath = 'external' + '/mcp/handlers/bootstrap-internal.js';
    const oldRescanPath = 'external' + '/mcp/handlers/rescan-internal.js';
    const residentBootstrapPath = 'resident' + '/tool-handlers/bootstrap-internal.js';
    const residentRescanPath = 'resident' + '/tool-handlers/rescan-internal.js';

    expect(cliSource).not.toContain(oldBootstrapPath);
    expect(cliSource).not.toContain(oldRescanPath);
    expect(daemonRunnerSource).not.toContain(oldBootstrapPath);
    expect(daemonRunnerSource).not.toContain(oldRescanPath);
    expect(candidatesRouteSource).not.toContain(oldBootstrapPath);
    expect(candidatesRouteSource).not.toContain(oldRescanPath);

    expect(cliSource).toContain(residentBootstrapPath);
    expect(cliSource).toContain(residentRescanPath);
    expect(daemonRunnerSource).toContain(residentBootstrapPath);
    expect(daemonRunnerSource).toContain(residentRescanPath);
    expect(candidatesRouteSource).toContain(residentBootstrapPath);
  });

  test('keeps legacy external MCP bootstrap/rescan files as resident compatibility aliases', () => {
    const legacyBootstrapSource = readFileSync(
      join(repoRoot, 'lib/external/mcp/handlers/bootstrap-internal.ts'),
      'utf8'
    );
    const legacyRescanSource = readFileSync(
      join(repoRoot, 'lib/external/mcp/handlers/rescan-internal.ts'),
      'utf8'
    );
    const legacyRefineSource = readFileSync(
      join(repoRoot, 'lib/external/mcp/handlers/bootstrap/refine.ts'),
      'utf8'
    );

    expect(legacyBootstrapSource).toContain('resident/tool-handlers/bootstrap-internal.js');
    expect(legacyRescanSource).toContain('resident/tool-handlers/rescan-internal.js');
    expect(legacyRefineSource).toContain('resident/tool-handlers/bootstrap/refine.js');
  });
});

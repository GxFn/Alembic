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
});

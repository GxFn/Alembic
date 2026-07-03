import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
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

  test('routes Alembic-owned bootstrap/rescan/refine consumers to project-index/service paths (RIC-3: off resident)', () => {
    const cliSource = readFileSync(join(repoRoot, 'bin/cli.ts'), 'utf8');
    const daemonRunnerSource = readFileSync(
      join(repoRoot, 'lib/daemon/DaemonJobRunner.ts'),
      'utf8'
    );
    const candidatesRouteSource = readFileSync(
      join(repoRoot, 'lib/http/routes/candidates.ts'),
      'utf8'
    );
    const oldBootstrapPath = 'external' + '/mcp/handlers/cold-start.js';
    const oldRescanPath = 'external' + '/mcp/handlers/knowledge-rescan.js';
    const residentHandlerPath = 'resident' + '/tool-handlers/';
    const projectIndexPath = 'recipe-pipeline' + '/generate/GenerateWorkflow.js';
    const bootstrapRefinePath = 'recipe-pipeline' + '/generate/runtime/GenerateRefine.js';

    // Legacy external MCP bridge handler paths stay gone.
    expect(cliSource).not.toContain(oldBootstrapPath);
    expect(cliSource).not.toContain(oldRescanPath);
    expect(daemonRunnerSource).not.toContain(oldBootstrapPath);
    expect(daemonRunnerSource).not.toContain(oldRescanPath);
    expect(candidatesRouteSource).not.toContain(oldBootstrapPath);
    expect(candidatesRouteSource).not.toContain(oldRescanPath);

    // RIC-3 (B1): the lib/resident/ MCP-mirror layer is deleted — no consumer touches it.
    expect(cliSource).not.toContain(residentHandlerPath);
    expect(daemonRunnerSource).not.toContain(residentHandlerPath);
    expect(candidatesRouteSource).not.toContain(residentHandlerPath);

    // CLI and daemon bootstrap/rescan now use the unified ProjectIndex workflow entry.
    // Legacy cold-start/rescan workflow wrappers stay internal compatibility surfaces.
    // W5-B4: daemon reaches the workflow through RecipePipelineFacade (O-3) — assert the
    // full chain: runner -> facade -> GenerateWorkflow, keeping the RIC-3 guard semantics.
    const facadePath = 'recipe-pipeline' + '/RecipePipelineFacade.js';
    const facadeSource = readFileSync(
      join(repoRoot, 'lib/recipe-pipeline/RecipePipelineFacade.ts'),
      'utf8'
    );
    expect(cliSource).toContain(projectIndexPath);
    expect(daemonRunnerSource).toContain(facadePath);
    expect(facadeSource).toContain('./generate/GenerateWorkflow.js');
    expect(candidatesRouteSource).toContain(bootstrapRefinePath);
  });

  test('removes legacy external MCP bootstrap/rescan compatibility aliases', () => {
    const legacyHandlersDir = join(repoRoot, 'lib/external/mcp/handlers');
    const legacyBootstrapFile = join(legacyHandlersDir, 'cold-start.ts');
    const legacyRescanFile = join(legacyHandlersDir, 'knowledge-rescan.ts');
    const legacyRefineFile = join(legacyHandlersDir, 'bootstrap', 'refine.ts');

    expect(existsSync(legacyBootstrapFile)).toBe(false);
    expect(existsSync(legacyRescanFile)).toBe(false);
    expect(existsSync(legacyRefineFile)).toBe(false);
  });

  test('keeps retired external MCP tree free of TypeScript entrypoints', () => {
    const legacyMcpRoot = join(repoRoot, 'lib/external/mcp');
    const leftoverModules = collectTypeScriptFiles(legacyMcpRoot).map((file) =>
      relative(repoRoot, file)
    );

    expect(leftoverModules).toEqual([]);
  });
});

function collectTypeScriptFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import Logger from '#infra/logging/Logger.js';
import { McpToolDiscovery } from '../../lib/external/mcp/McpToolDiscovery.js';

describe('McpToolDiscovery', () => {
  let projectRoot: string | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    if (projectRoot) {
      rmSync(projectRoot, { recursive: true, force: true });
      projectRoot = null;
    }
  });

  test('does not log server-only MCP configs as loaded zero tools', () => {
    projectRoot = makeProjectRoot();
    writeJson(join(projectRoot, '.vscode', 'mcp.json'), {
      servers: {
        alembic: {
          type: 'stdio',
          command: 'alembic-mcp',
          env: { ALEMBIC_PROJECT_DIR: '${workspaceFolder}' },
        },
      },
    });
    writeJson(join(projectRoot, '.cursor', 'mcp.json'), {
      mcpServers: {
        alembic: {
          command: 'alembic-mcp',
          env: { ALEMBIC_PROJECT_DIR: '${workspaceFolder}' },
        },
      },
    });
    const logger = mockLogger();

    const declarations = new McpToolDiscovery().discover(projectRoot);

    expect(declarations).toEqual([]);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledTimes(2);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('found 1 MCP server declarations without inline tool schemas')
    );
  });

  test('loads inline tool declarations from VSCode and Cursor MCP configs', () => {
    projectRoot = makeProjectRoot();
    writeJson(join(projectRoot, '.vscode', 'mcp.json'), {
      servers: {
        local: {
          command: 'node',
          tools: [
            {
              name: 'local_read',
              description: 'Read local data',
              inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
            },
          ],
        },
      },
    });
    writeJson(join(projectRoot, '.cursor', 'mcp.json'), {
      mcpServers: {
        remote: {
          command: 'node',
          tools: [{ name: 'remote_search' }],
        },
      },
    });
    const logger = mockLogger();

    const declarations = new McpToolDiscovery().discover(projectRoot);

    expect(declarations).toEqual([
      {
        name: 'local_read',
        description: 'Read local data',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
        serverId: 'local',
        serverSource: 'workspace-config',
      },
      {
        name: 'remote_search',
        description: undefined,
        inputSchema: undefined,
        serverId: 'remote',
        serverSource: 'workspace-config',
      },
    ]);
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('loaded 1 MCP tool declarations')
    );
  });
});

function makeProjectRoot() {
  const root = mkdtempSync(join(tmpdir(), 'alembic-mcp-discovery-'));
  mkdirSync(join(root, '.vscode'), { recursive: true });
  mkdirSync(join(root, '.cursor'), { recursive: true });
  return root;
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function mockLogger() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
  vi.spyOn(Logger, 'getInstance').mockReturnValue(
    logger as unknown as ReturnType<typeof Logger.getInstance>
  );
  return logger;
}

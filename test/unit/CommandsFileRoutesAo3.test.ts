import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { invokeRouter } from '../helpers/express.js';

const mocks = vi.hoisted(() => ({
  container: {
    get: vi.fn(),
    singletons: {} as Record<string, unknown>,
  },
}));

vi.mock('../../lib/injection/ServiceContainer.js', () => ({
  getServiceContainer: vi.fn(() => mocks.container),
}));

import commandsRouter from '../../lib/http/routes/commands.js';

const tempDirs: string[] = [];

describe('commands file routes AO3 path boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const projectRoot = mkdtempSync(join(tmpdir(), 'alembic-commands-route-'));
    tempDirs.push(projectRoot);
    mocks.container.singletons = { _projectRoot: projectRoot };
    mocks.container.get.mockImplementation((name: string) => {
      throw new Error(`Unexpected service requested: ${name}`);
    });
    writeFileSync(join(projectRoot, 'allowed.swift'), 'let value = 1\n');
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test('rejects traversal reads with the Core failure taxonomy envelope', async () => {
    const response = await invokeRouter(commandsRouter, {
      method: 'GET',
      mountPath: '/api/v1/commands',
      path: '/api/v1/commands/files/read?path=../secret.swift',
    });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toMatchObject({
      code: 'INVALID_FILE_PATH',
      reasonCode: 'invalid-input',
    });
  });

  test('rejects absolute save paths before reaching the filesystem', async () => {
    const response = await invokeRouter(commandsRouter, {
      body: { content: 'let escaped = true\n', path: '/tmp/escaped.swift' },
      method: 'POST',
      mountPath: '/api/v1/commands',
      path: '/api/v1/commands/files/save',
    });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toMatchObject({
      code: 'INVALID_FILE_PATH',
      reasonCode: 'invalid-input',
    });
  });
});

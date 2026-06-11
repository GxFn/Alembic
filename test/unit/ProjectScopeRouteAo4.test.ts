import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import projectScopeRouter from '../../lib/http/routes/project-scope.js';
import { invokeRouter } from '../helpers/express.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;
const tempRoots: string[] = [];

afterEach(() => {
  if (ORIGINAL_ALEMBIC_HOME === undefined) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
  }
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('AO4 ProjectScope route suite', () => {
  test('resolve-folder rejects missing folderPath instead of guessing scope', async () => {
    useTempAlembicHome();

    const response = await invokeRouter(projectScopeRouter, {
      body: {},
      method: 'POST',
      mountPath: '/api/v1/project-scope',
      path: '/api/v1/project-scope/resolve-folder',
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: 'folderPath is required',
      success: false,
    });
  });

  test('folders route rejects an unknown explicit ProjectScope id', async () => {
    useTempAlembicHome();
    const folder = tempRoot('alembic-ao4-project-scope-folder-');

    const response = await invokeRouter(projectScopeRouter, {
      body: {
        folderPath: folder,
        projectScopeId: 'missing-scope',
      },
      method: 'POST',
      mountPath: '/api/v1/project-scope',
      path: '/api/v1/project-scope/folders',
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
    });
    expect(String(response.body.error)).toContain('scope not found');
  });

  test('added folder resolves to the same ProjectScope summary', async () => {
    useTempAlembicHome();
    const controlRoot = tempRoot('alembic-ao4-control-');
    const folder = join(controlRoot, 'Alembic');
    mkdirSync(folder, { recursive: true });

    const add = await invokeRouter(projectScopeRouter, {
      body: {
        controlRoot,
        folderPath: folder,
        role: 'primary-source',
      },
      method: 'POST',
      mountPath: '/api/v1/project-scope',
      path: '/api/v1/project-scope/folders',
    });
    expect(add.status).toBe(201);

    const resolve = await invokeRouter(projectScopeRouter, {
      body: { folderPath: folder },
      method: 'POST',
      mountPath: '/api/v1/project-scope',
      path: '/api/v1/project-scope/resolve-folder',
    });
    const addData = add.body.data as { summary: { projectScopeId: string } };
    const resolveData = resolve.body.data as { summary: { projectScopeId: string } };

    expect(resolve.status).toBe(200);
    expect(resolveData.summary.projectScopeId).toBe(addData.summary.projectScopeId);
  });
});

function useTempAlembicHome(): void {
  process.env.ALEMBIC_HOME = tempRoot('alembic-ao4-project-scope-home-');
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

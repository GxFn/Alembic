import { describe, expect, it } from 'vitest';

import { resolveKnowledgeScanDirs } from '../../lib/shared/resolveProjectRoot.js';

describe('resolveKnowledgeScanDirs', () => {
  it('uses workspace dataRoot-relative knowledge paths in ghost mode', () => {
    const dirs = resolveKnowledgeScanDirs({
      singletons: {
        _workspaceResolver: {
          dataRoot: '/ghost/workspaces/abcd1234',
          recipesDir: '/ghost/workspaces/abcd1234/Alembic/recipes',
          candidatesDir: '/ghost/workspaces/abcd1234/Alembic/candidates',
        },
      },
    });

    expect(dirs).toContain('Alembic/recipes');
    expect(dirs).toContain('Alembic/candidates');
    expect(dirs).toContain('recipes');
    expect(dirs).toContain('candidates');
  });

  it('respects custom knowledge base directories from workspace resolver', () => {
    const dirs = resolveKnowledgeScanDirs({
      singletons: {
        _workspaceResolver: {
          dataRoot: '/ghost/workspaces/abcd1234',
          recipesDir: '/ghost/workspaces/abcd1234/Knowledge/recipes',
          candidatesDir: '/ghost/workspaces/abcd1234/Knowledge/candidates',
        },
      },
    });

    expect(dirs).toContain('Knowledge/recipes');
    expect(dirs).toContain('Knowledge/candidates');
    expect(dirs).not.toContain('Alembic/recipes');
    expect(dirs).not.toContain('Alembic/candidates');
  });
});

import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  getContextStoragePath,
  getProjectInternalDataPath,
  getProjectRecipesPath,
  getProjectSkillsPath,
} from '../../lib/infrastructure/config/Paths.js';

describe('project path helpers', () => {
  test('derive default project knowledge paths from shared folder names', () => {
    const projectRoot = path.join('/tmp', 'alembic-path-project');

    expect(getProjectInternalDataPath(projectRoot)).toBe(path.join(projectRoot, 'Alembic', '.asd'));
    expect(getContextStoragePath(projectRoot)).toBe(
      path.join(projectRoot, 'Alembic', '.asd', 'context')
    );
    expect(getProjectSkillsPath(projectRoot)).toBe(path.join(projectRoot, 'Alembic', 'skills'));
    expect(getProjectRecipesPath(projectRoot)).toBe(path.join(projectRoot, 'Alembic', 'recipes'));
  });

  test('keeps explicit recipes path overrides compatible', () => {
    const projectRoot = path.join('/tmp', 'alembic-recipes-override');

    expect(getProjectRecipesPath(projectRoot, { recipes: { dir: 'Docs/patterns' } })).toBe(
      path.join(projectRoot, 'Docs', 'patterns')
    );
  });
});

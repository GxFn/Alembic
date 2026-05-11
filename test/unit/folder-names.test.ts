import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_FOLDER_NAMES,
  resolveFolderNames,
  validateFolderNameSegment,
} from '../../lib/shared/folder-names.js';
import {
  CONFIG_DIR,
  DASHBOARD_DIR,
  INJECTABLE_SKILLS_DIR,
  INTERNAL_SKILLS_DIR,
  PACKAGE_ROOT,
  RESOURCES_DIR,
  SKILLS_DIR,
  TEMPLATES_DIR,
} from '../../lib/shared/package-root.js';

describe('folder names', () => {
  test('defines the default folder names used by Alembic path resolvers', () => {
    expect(DEFAULT_FOLDER_NAMES.package).toMatchObject({
      config: 'config',
      dashboard: 'dashboard',
      injectableSkills: 'injectable-skills',
      internalSkills: 'skills',
      resources: 'resources',
      templates: 'templates',
    });
    expect(DEFAULT_FOLDER_NAMES.project).toMatchObject({
      cache: 'cache',
      knowledgeBase: 'Alembic',
      runtime: '.asd',
      skills: 'skills',
    });
    expect(DEFAULT_FOLDER_NAMES.ide).toMatchObject({
      cursorRoot: '.cursor',
      cursorSkills: 'skills',
    });
  });

  test('merges partial overrides without dropping defaults', () => {
    const names = resolveFolderNames({
      dev: { scratch: 'tmp-scratch' },
      package: { injectableSkills: 'product-skills' },
      project: { skills: 'project-skills' },
    });

    expect(names.package.injectableSkills).toBe('product-skills');
    expect(names.package.internalSkills).toBe('skills');
    expect(names.dev.scratch).toBe('tmp-scratch');
    expect(names.dev.chainRuns).toBe('chain-runs');
    expect(names.project.skills).toBe('project-skills');
    expect(names.project.knowledgeBase).toBe('Alembic');
  });

  test('rejects invalid folder name segments', () => {
    const invalidNames = ['', ' skills', 'skills ', '.', '..', 'a/b', 'a\\b', '~/skills'];

    for (const invalidName of invalidNames) {
      expect(() => validateFolderNameSegment(invalidName, 'test.path')).toThrow(Error);
    }
  });

  test('validates override values while resolving folder names', () => {
    expect(() => resolveFolderNames({ package: { injectableSkills: '../skills' } })).toThrow(Error);
  });

  test('derives package paths from the shared default folder names', () => {
    expect(CONFIG_DIR).toBe(path.join(PACKAGE_ROOT, 'config'));
    expect(INTERNAL_SKILLS_DIR).toBe(path.join(PACKAGE_ROOT, 'skills'));
    expect(INJECTABLE_SKILLS_DIR).toBe(path.join(PACKAGE_ROOT, 'injectable-skills'));
    expect(SKILLS_DIR).toBe(INJECTABLE_SKILLS_DIR);
    expect(TEMPLATES_DIR).toBe(path.join(PACKAGE_ROOT, 'templates'));
    expect(RESOURCES_DIR).toBe(path.join(PACKAGE_ROOT, 'resources'));
    expect(DASHBOARD_DIR).toBe(path.join(PACKAGE_ROOT, 'dashboard'));
  });
});

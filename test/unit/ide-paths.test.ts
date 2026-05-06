import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { resolveFolderNames } from '../../lib/shared/folder-names.js';
import {
  getCursorRelativePath,
  getCursorRoot,
  getCursorRulesDir,
  getCursorRulesRelativePath,
  getCursorSkillsDir,
  getCursorSkillsRelativePath,
} from '../../lib/shared/ide-paths.js';

describe('ide path helpers', () => {
  test('derive default Cursor absolute paths', () => {
    const projectRoot = path.join('/tmp', 'alembic-ide-paths');

    expect(getCursorRoot(projectRoot)).toBe(path.join(projectRoot, '.cursor'));
    expect(getCursorRulesDir(projectRoot)).toBe(path.join(projectRoot, '.cursor', 'rules'));
    expect(getCursorSkillsDir(projectRoot)).toBe(path.join(projectRoot, '.cursor', 'skills'));
  });

  test('derive default Cursor relative paths for WriteZone', () => {
    expect(getCursorRelativePath('mcp.json')).toBe(path.join('.cursor', 'mcp.json'));
    expect(getCursorRulesRelativePath('alembic-skills.mdc')).toBe(
      path.join('.cursor', 'rules', 'alembic-skills.mdc')
    );
    expect(getCursorSkillsRelativePath('alembic-devdocs', 'SKILL.md')).toBe(
      path.join('.cursor', 'skills', 'alembic-devdocs', 'SKILL.md')
    );
  });

  test('honors resolved custom Cursor folder names for absolute helpers', () => {
    const projectRoot = path.join('/tmp', 'alembic-custom-ide-paths');
    const folderNames = resolveFolderNames({
      ide: {
        cursorRoot: '.agent',
        cursorRules: 'policy',
        cursorSkills: 'abilities',
      },
    });

    expect(getCursorRoot(projectRoot, folderNames)).toBe(path.join(projectRoot, '.agent'));
    expect(getCursorRulesDir(projectRoot, folderNames)).toBe(
      path.join(projectRoot, '.agent', 'policy')
    );
    expect(getCursorSkillsDir(projectRoot, folderNames)).toBe(
      path.join(projectRoot, '.agent', 'abilities')
    );
  });
});

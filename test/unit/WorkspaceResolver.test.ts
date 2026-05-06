import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { getGhostWorkspaceDir } from '../../lib/shared/ProjectRegistry.js';
import WorkspaceResolver from '../../lib/shared/WorkspaceResolver.js';

describe('WorkspaceResolver', () => {
  test('derives the standard data and knowledge paths from default folder names', () => {
    const projectRoot = path.join(os.tmpdir(), 'alembic-standard-project');
    const resolver = new WorkspaceResolver({ projectRoot });

    expect(resolver.projectRoot).toBe(projectRoot);
    expect(resolver.dataRoot).toBe(projectRoot);
    expect(resolver.runtimeDir).toBe(path.join(projectRoot, '.asd'));
    expect(resolver.databasePath).toBe(path.join(projectRoot, '.asd', 'alembic.db'));
    expect(resolver.logsDir).toBe(path.join(projectRoot, '.asd', 'logs'));
    expect(resolver.cacheDir).toBe(path.join(projectRoot, '.asd', 'cache'));
    expect(resolver.contextDir).toBe(path.join(projectRoot, '.asd', 'context'));
    expect(resolver.runtimeSkillsDir).toBe(path.join(projectRoot, '.asd', 'skills'));
    expect(resolver.knowledgeDir).toBe(path.join(projectRoot, 'Alembic'));
    expect(resolver.recipesDir).toBe(path.join(projectRoot, 'Alembic', 'recipes'));
    expect(resolver.skillsDir).toBe(path.join(projectRoot, 'Alembic', 'skills'));
    expect(resolver.wikiDir).toBe(path.join(projectRoot, 'Alembic', 'wiki'));
    expect(resolver.candidatesDir).toBe(path.join(projectRoot, 'Alembic', 'candidates'));
    expect(resolver.specPath).toBe(path.join(projectRoot, 'Alembic', 'Alembic.boxspec.json'));
  });

  test('derives ghost data paths from the global workspace folder names', () => {
    const projectRoot = path.join(os.tmpdir(), 'alembic-ghost-project');
    const resolver = new WorkspaceResolver({ projectRoot, ghost: true, projectId: 'abc12345' });

    const dataRoot = getGhostWorkspaceDir('abc12345');
    expect(resolver.projectRoot).toBe(projectRoot);
    expect(resolver.dataRoot).toBe(dataRoot);
    expect(resolver.runtimeDir).toBe(path.join(dataRoot, '.asd'));
    expect(resolver.skillsDir).toBe(path.join(dataRoot, 'Alembic', 'skills'));
  });

  test('uses folder name overrides without changing projectRoot semantics', () => {
    const projectRoot = path.join(os.tmpdir(), 'alembic-custom-folders');
    const resolver = new WorkspaceResolver({
      projectRoot,
      folderNames: {
        project: {
          knowledgeBase: 'Knowledge',
          recipes: 'patterns',
          runtime: '.runtime',
          skills: 'agent-skills',
          wiki: 'docs',
        },
      },
    });

    expect(resolver.dataRoot).toBe(projectRoot);
    expect(resolver.runtimeDir).toBe(path.join(projectRoot, '.runtime'));
    expect(resolver.knowledgeDir).toBe(path.join(projectRoot, 'Knowledge'));
    expect(resolver.recipesDir).toBe(path.join(projectRoot, 'Knowledge', 'patterns'));
    expect(resolver.skillsDir).toBe(path.join(projectRoot, 'Knowledge', 'agent-skills'));
    expect(resolver.wikiDir).toBe(path.join(projectRoot, 'Knowledge', 'docs'));
  });
});

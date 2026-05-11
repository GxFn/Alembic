import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { isAlembicProject } from '../../lib/shared/ProjectMarkers.js';
import {
  getGhostWorkspaceDir,
  getProjectRegistryPath,
  ProjectRegistry,
} from '../../lib/shared/ProjectRegistry.js';
import WorkspaceResolver from '../../lib/shared/WorkspaceResolver.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;

function useTempAlembicHome(): string {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-home-'));
  process.env.ALEMBIC_HOME = tempHome;
  return tempHome;
}

afterEach(() => {
  if (ORIGINAL_ALEMBIC_HOME === undefined) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
  }
});

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

  test('inspects ghost registry facts with an explicit marker and object-shaped registry', () => {
    useTempAlembicHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-ghost-source-'));
    const symlinkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-ghost-link-'));
    const symlinkRoot = path.join(symlinkParent, 'project');
    fs.symlinkSync(projectRoot, symlinkRoot, 'dir');

    const entry = ProjectRegistry.register(projectRoot, true);
    const workspaceDir = getGhostWorkspaceDir(entry.id);
    fs.mkdirSync(workspaceDir, { recursive: true });

    const inspection = ProjectRegistry.inspect(symlinkRoot);

    expect(ProjectRegistry.get(symlinkRoot)).toMatchObject(entry);
    expect(ProjectRegistry.isGhost(symlinkRoot)).toBe(true);
    expect(ProjectRegistry.getWorkspaceDir(symlinkRoot)).toBe(workspaceDir);
    expect(isAlembicProject(symlinkRoot)).toBe(true);
    expect(inspection).toMatchObject({
      inputProjectRoot: path.resolve(symlinkRoot),
      projectRoot: path.resolve(symlinkRoot),
      projectRealpath: fs.realpathSync(projectRoot),
      registryPath: getProjectRegistryPath(),
      registered: true,
      mode: 'ghost',
      ghost: true,
      projectId: entry.id,
      expectedProjectId: entry.id,
      dataRoot: workspaceDir,
      dataRootSource: 'ghost-registry',
      workspaceExists: true,
      ghostMarker: {
        kind: 'project-registry',
        registryPath: getProjectRegistryPath(),
        projectRoot: fs.realpathSync(projectRoot),
        projectId: entry.id,
      },
    });
  });

  test('exposes N0-ready workspace facts for ghost projects', () => {
    useTempAlembicHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-ghost-facts-'));
    const entry = ProjectRegistry.register(projectRoot, true);
    const dataRoot = getGhostWorkspaceDir(entry.id);
    fs.mkdirSync(dataRoot, { recursive: true });

    const resolver = WorkspaceResolver.fromProject(projectRoot);
    const facts = resolver.toFacts();

    expect(facts).toMatchObject({
      targetProjectRoot: path.resolve(projectRoot),
      projectRealpath: fs.realpathSync(projectRoot),
      registryPath: getProjectRegistryPath(),
      registered: true,
      mode: 'ghost',
      ghost: true,
      projectId: entry.id,
      expectedProjectId: entry.id,
      dataRoot,
      dataRootSource: 'ghost-registry',
      workspaceExists: true,
      runtimeDir: path.join(dataRoot, '.asd'),
      databasePath: path.join(dataRoot, '.asd', 'alembic.db'),
      knowledgeBaseDir: 'Alembic',
      knowledgeDir: path.join(dataRoot, 'Alembic'),
      recipesDir: path.join(dataRoot, 'Alembic', 'recipes'),
      skillsDir: path.join(dataRoot, 'Alembic', 'skills'),
      candidatesDir: path.join(dataRoot, 'Alembic', 'candidates'),
      wikiDir: path.join(dataRoot, 'Alembic', 'wiki'),
    });
    expect(facts.ghostMarker).toMatchObject({ kind: 'project-registry', projectId: entry.id });
  });

  test('inspects unregistered projects as standard mode without a ghost marker', () => {
    useTempAlembicHome();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-standard-unregistered-'));

    const inspection = ProjectRegistry.inspect(projectRoot);
    const resolver = WorkspaceResolver.fromProject(projectRoot);

    expect(inspection).toMatchObject({
      projectRoot: path.resolve(projectRoot),
      projectRealpath: fs.realpathSync(projectRoot),
      registered: false,
      mode: 'standard',
      ghost: false,
      projectId: null,
      dataRoot: path.resolve(projectRoot),
      dataRootSource: 'project-root',
      workspaceExists: true,
      ghostMarker: null,
    });
    expect(resolver.toFacts()).toMatchObject({
      mode: 'standard',
      ghost: false,
      dataRoot: path.resolve(projectRoot),
      dataRootSource: 'project-root',
      ghostMarker: null,
    });
    expect(isAlembicProject(projectRoot)).toBe(false);
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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ProjectScopeRegistryStore } from '../../lib/project-scope/ProjectScopeRegistry.js';

const projectContextCapabilitiesMock = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock('@alembic/core/project-context-capabilities', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@alembic/core/project-context-capabilities')>();
  return {
    ...actual,
    ProjectContextCapabilities: {
      ...actual.ProjectContextCapabilities,
      execute: projectContextCapabilitiesMock.execute,
    },
  };
});

import {
  loadProjectContextRepo,
  projectContextDependencyGraph,
} from '../../lib/project-facts/ProjectContextConsumerFacts.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;
const fixtures: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { force: true, recursive: true });
  }
  if (ORIGINAL_ALEMBIC_HOME === undefined) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
  }
});

describe('ProjectContextConsumerFacts', () => {
  test('uses ProjectScope members for control-root dependency graph instead of ambient repo facts', async () => {
    const { memberNames, workspaceRoot } = createProjectScopeFixture();
    projectContextCapabilitiesMock.execute.mockRejectedValue(
      new Error('ProjectContext repo should not run for a ProjectScope control root')
    );

    const repo = await loadProjectContextRepo(workspaceRoot);
    const graph = await projectContextDependencyGraph(workspaceRoot, repo);
    const expectedMembers = [...memberNames].sort();

    expect(projectContextCapabilitiesMock.execute).not.toHaveBeenCalled();
    expect(repo.repo.name).not.toBe('BiliDili');
    expect(repo.targets.map((target) => target.name)).toEqual(expectedMembers);
    expect(graph.projectRoot).toBe(workspaceRoot);
    expect(graph.edges).toEqual([]);
    expect(graph.nodes.map((node) => node.label)).toEqual(expectedMembers);
    expect(JSON.stringify(graph)).not.toContain('BiliDili');
  });
});

function createProjectScopeFixture(): { memberNames: string[]; workspaceRoot: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-consumer-facts-home-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'AlembicWorkspace-'));
  fixtures.push(home, workspaceRoot);
  process.env.ALEMBIC_HOME = home;

  const memberNames = [
    'Alembic',
    'AlembicCore',
    'AlembicPlugin',
    'AlembicDashboard',
    'AlembicAgent',
  ];
  const store = new ProjectScopeRegistryStore();
  memberNames.forEach((memberName, index) => {
    const folderPath = path.join(workspaceRoot, memberName);
    fs.mkdirSync(folderPath, { recursive: true });
    store.addFolder({
      controlRoot: workspaceRoot,
      displayName: memberName,
      folderPath,
      role: index === 0 ? 'primary-source' : 'source',
    });
  });

  return { memberNames, workspaceRoot };
}

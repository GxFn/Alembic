import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getGhostWorkspaceDir, ProjectRegistry } from '@alembic/core/workspace';
import { afterEach, describe, expect, test } from 'vitest';
import { SetupService } from '../../lib/cli/SetupService.js';
import { ProjectRuntimeControl } from '../../lib/daemon/ProjectRuntimeControl.js';

const ORIGINAL_ALEMBIC_HOME = process.env.ALEMBIC_HOME;

function useTempAlembicHome(): void {
  process.env.ALEMBIC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-setup-home-'));
}

function makeProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-setup-project-'));
}

afterEach(() => {
  if (ORIGINAL_ALEMBIC_HOME === undefined) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = ORIGINAL_ALEMBIC_HOME;
  }
});

describe('SetupService workspace mode convergence', () => {
  test('ordinary setup attaches a plugin-first ghost registry entry', () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const pluginEntry = ProjectRegistry.register(projectRoot, true);
    const ghostDataRoot = getGhostWorkspaceDir(pluginEntry.id);

    const service = new SetupService({ projectRoot, quiet: true });

    expect(service.ghost).toBe(true);
    expect(service.resolver?.dataRoot).toBe(ghostDataRoot);
    expect(service.runtimeDir).toBe(path.join(ghostDataRoot, '.asd'));
    expect(service.subRepoPath).toBe(path.join(ghostDataRoot, 'Alembic', 'recipes'));
    expect(ProjectRegistry.get(projectRoot)).toMatchObject({
      id: pluginEntry.id,
      ghost: true,
    });

    service.stepRuntime();

    expect(fs.existsSync(path.join(ghostDataRoot, '.asd', 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.asd', 'config.json'))).toBe(false);
  });

  test('project runtime control observes the setup-attached ghost data root', async () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const pluginEntry = ProjectRegistry.register(projectRoot, true);
    const ghostDataRoot = getGhostWorkspaceDir(pluginEntry.id);

    const service = new SetupService({ projectRoot, quiet: true });
    service.stepRuntime();

    const snapshot = await new ProjectRuntimeControl().snapshot();
    const project = snapshot.projects.find((item) => item.projectId === pluginEntry.id);

    expect(project).toMatchObject({
      dataRoot: ghostDataRoot,
      dataRootSource: 'ghost-registry',
      ghost: true,
      mode: 'ghost',
      projectId: pluginEntry.id,
      status: 'stopped',
    });
    expect(project?.databasePath).toBe(path.join(ghostDataRoot, '.asd', 'alembic.db'));
  });

  test('ordinary setup preserves an Alembic-first standard registry entry', () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const standardEntry = ProjectRegistry.register(projectRoot, false);

    const service = new SetupService({ projectRoot, quiet: true });

    expect(service.ghost).toBe(false);
    expect(service.resolver?.dataRoot).toBe(path.resolve(projectRoot));
    expect(service.runtimeDir).toBe(path.join(path.resolve(projectRoot), '.asd'));
    expect(service.subRepoPath).toBe(path.join(path.resolve(projectRoot), 'Alembic', 'recipes'));
    expect(ProjectRegistry.get(projectRoot)).toMatchObject({
      id: standardEntry.id,
      ghost: false,
    });
  });

  test('explicit ghost setup switches mode through the registry contract', () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const standardEntry = ProjectRegistry.register(projectRoot, false);

    const service = new SetupService({ projectRoot, ghost: true, quiet: true });
    const currentEntry = ProjectRegistry.get(projectRoot);

    expect(currentEntry).toMatchObject({ id: standardEntry.id, ghost: true });
    expect(service.ghost).toBe(true);
    expect(service.resolver?.dataRoot).toBe(getGhostWorkspaceDir(standardEntry.id));
  });

  test('explicit standard setup switches mode through the registry contract', () => {
    useTempAlembicHome();
    const projectRoot = makeProjectRoot();
    const ghostEntry = ProjectRegistry.register(projectRoot, true);

    const service = new SetupService({ projectRoot, ghost: false, quiet: true });
    const currentEntry = ProjectRegistry.get(projectRoot);

    expect(currentEntry).toMatchObject({ id: ghostEntry.id, ghost: false });
    expect(service.ghost).toBe(false);
    expect(service.resolver?.dataRoot).toBe(path.resolve(projectRoot));
  });
});

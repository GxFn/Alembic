import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectDescriptor, createProjectScopeRegistryDocument } from '@alembic/core/shared';
import {
  getGhostWorkspaceDir,
  getProjectRegistryDir,
  ProjectRegistry,
} from '@alembic/core/workspace';
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

function makeProjectScopeFixture(): {
  controlRoot: string;
  dataRoot: string;
  registryPath: string;
  repoA: string;
  repoB: string;
} {
  const controlRoot = makeProjectRoot();
  const repoA = path.join(controlRoot, 'Alembic');
  const repoB = path.join(controlRoot, 'AlembicCore');
  const dataRoot = getGhostWorkspaceDir('ecf32806');
  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(repoB, { recursive: true });
  const projectScope = createProjectDescriptor({
    controlRoot,
    dataRoot,
    displayName: 'Alembic workspace',
    folders: [
      { path: repoA, role: 'primary-source' },
      { path: repoB, role: 'source' },
    ],
    projectId: 'ecf32806',
    projectScopeId: 'project-scope-a8083fdb335c',
  });
  const registryPath = path.join(getProjectRegistryDir(), 'project-scopes.json');
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(
    registryPath,
    JSON.stringify(createProjectScopeRegistryDocument([projectScope]), null, 2)
  );
  return { controlRoot, dataRoot, registryPath, repoA, repoB };
}

function makeFreshTwoRepoCheckout(): string {
  const controlRoot = makeProjectRoot();
  for (const repoName of ['RepoA', 'RepoB']) {
    const repoRoot = path.join(controlRoot, repoName);
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'package.json'), '{"private":true}\n');
  }
  return controlRoot;
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
    const config = JSON.parse(
      fs.readFileSync(path.join(ghostDataRoot, '.asd', 'config.json'), 'utf8')
    ) as {
      ai?: unknown;
      core?: Record<string, unknown>;
      guard?: unknown;
      watch?: unknown;
    };
    expect(config.core).toMatchObject({ subRepoDir: 'Alembic/recipes' });
    expect(config.core).not.toHaveProperty('dir');
    expect(config.core).not.toHaveProperty('constitution');
    expect(config).not.toHaveProperty('watch');
    expect(config.ai).toMatchObject({ provider: 'auto' });
    expect(config.guard).toMatchObject({ enabled: true });
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

  test('native ProjectScope init is idempotent and does not create per-repo ghosts', () => {
    useTempAlembicHome();
    const { controlRoot, dataRoot, registryPath, repoA } = makeProjectScopeFixture();
    const beforeRegistry = fs.readFileSync(registryPath, 'utf8');

    const workspaceService = new SetupService({ projectRoot: controlRoot, quiet: true });
    workspaceService.stepRuntime();
    const memberService = new SetupService({ projectRoot: repoA, quiet: true });
    memberService.stepRuntime();

    expect(workspaceService.ghost).toBe(true);
    expect(memberService.ghost).toBe(true);
    expect(workspaceService.resolver?.projectScope?.projectScopeId).toBe(
      'project-scope-a8083fdb335c'
    );
    expect(memberService.resolver?.projectScope?.projectScopeId).toBe('project-scope-a8083fdb335c');
    expect(workspaceService.runtimeDir).toBe(path.join(dataRoot, '.asd'));
    expect(memberService.runtimeDir).toBe(path.join(dataRoot, '.asd'));
    expect(ProjectRegistry.get(controlRoot)).toBeNull();
    expect(ProjectRegistry.get(repoA)).toBeNull();
    expect(fs.existsSync(path.join(getProjectRegistryDir(), 'projects.json'))).toBe(false);
    expect(fs.readFileSync(registryPath, 'utf8')).toBe(beforeRegistry);
  });

  test('fresh multi-repo checkout without native scope refuses before registry writes', () => {
    useTempAlembicHome();
    const controlRoot = makeFreshTwoRepoCheckout();

    expect(() => new SetupService({ projectRoot: controlRoot, quiet: true })).toThrow(
      /No native project scope.*project-scope add <folder>/
    );
    expect(fs.existsSync(path.join(getProjectRegistryDir(), 'projects.json'))).toBe(false);
    expect(fs.existsSync(path.join(controlRoot, '.asd'))).toBe(false);
    expect(fs.existsSync(path.join(getProjectRegistryDir(), 'workspaces'))).toBe(false);
  });
});

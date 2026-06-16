import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectDescriptor } from '@alembic/core/shared';
import { WorkspaceResolver } from '@alembic/core/workspace';
import { afterEach, describe, expect, test } from 'vitest';
import {
  attachProjectScopeToScanOptions,
  buildProjectScopeSourceIdentityMap,
  collectProjectScopeSourceIdentities,
  normalizeProjectScopeSourceRefsForRuntime,
  resolveProjectScopeAnalysisContext,
} from '../../lib/project-scope/ProjectScopeAnalysis.js';

const tempDirs: string[] = [];

describe('ProjectScope analysis wiring', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test('attaches ProjectScope folders to Core scan options without adding control root or vendor snapshots', () => {
    const controlRoot = mkdtempSync(join(tmpdir(), 'alembic-project-scope-control-'));
    tempDirs.push(controlRoot);
    const dataRoot = join(controlRoot, '.ghost-data');
    const coreRepo = createNodeProject(controlRoot, 'AlembicCore');
    const pluginRepo = createNodeProject(controlRoot, 'AlembicPlugin');
    createNodeProject(join(controlRoot, 'vendor'), 'AlembicCore');
    writeFileSync(join(controlRoot, 'package.json'), '{"name":"control-root"}\n');
    mkdirSync(join(controlRoot, 'lib'), { recursive: true });
    writeFileSync(join(controlRoot, 'lib', 'control.ts'), 'export const control = true;\n');

    const projectScope = createProjectDescriptor({
      controlRoot,
      dataRoot,
      displayName: 'AlembicWorkspace',
      folders: [
        { displayName: 'AlembicCore', path: coreRepo, role: 'source' },
        { displayName: 'AlembicPlugin', path: pluginRepo, role: 'source' },
      ],
    });
    const resolver = WorkspaceResolver.fromProject(controlRoot, { projectScope });
    const container = {
      singletons: {
        _projectRoot: controlRoot,
        _workspaceResolver: resolver,
      },
    };
    const analysis = resolveProjectScopeAnalysisContext(container);

    const scan = attachProjectScopeToScanOptions(
      {
        generateAstContext: false,
        maxFiles: 20,
        skipGuard: true,
      },
      analysis
    );
    const projectScopeFolders =
      (scan.projectScope as typeof projectScope | undefined)?.folders.map((folder) => ({
        displayName: folder.displayName,
        path: folder.path,
      })) ?? [];
    const sourceIdentities = collectProjectScopeSourceIdentities({
      allFiles: [
        {
          path: join(coreRepo, 'lib', 'index.ts'),
          sourceIdentity: {
            absolutePath: join(coreRepo, 'lib', 'index.ts'),
            folderDisplayName: 'AlembicCore',
            folderId: projectScope.folders[0].id,
            folderPath: coreRepo,
            folderRelativeRoot: 'AlembicCore',
            projectScopeId: projectScope.projectScopeId,
            qualifiedPath: 'AlembicCore/lib/index.ts',
            relativePath: 'lib/index.ts',
          },
        },
        {
          path: join(pluginRepo, 'lib', 'index.ts'),
          sourceIdentity: {
            absolutePath: join(pluginRepo, 'lib', 'index.ts'),
            folderDisplayName: 'AlembicPlugin',
            folderId: projectScope.folders[1].id,
            folderPath: pluginRepo,
            folderRelativeRoot: 'AlembicPlugin',
            projectScopeId: projectScope.projectScopeId,
            qualifiedPath: 'AlembicPlugin/lib/index.ts',
            relativePath: 'lib/index.ts',
          },
        },
      ],
    });

    expect(analysis.projectScopeId).toBe(projectScope.projectScopeId);
    expect(projectScopeFolders).toEqual([
      { displayName: 'AlembicCore', path: coreRepo },
      { displayName: 'AlembicPlugin', path: pluginRepo },
    ]);
    expect(projectScopeFolders.map((folder) => folder.path)).not.toContain(
      join(controlRoot, 'vendor', 'AlembicCore')
    );
    expect(projectScopeFolders.map((folder) => folder.path)).not.toContain(controlRoot);
    expect(sourceIdentities.map((ref) => ref.qualifiedPath).sort()).toEqual([
      'AlembicCore/lib/index.ts',
      'AlembicPlugin/lib/index.ts',
    ]);
  });

  test('normalizes sourceRefs to qualified ProjectScope refs and rejects ambiguous or missing refs', () => {
    const controlRoot = mkdtempSync(join(tmpdir(), 'alembic-project-scope-refs-'));
    tempDirs.push(controlRoot);
    const coreRepo = createNodeProject(controlRoot, 'AlembicCore');
    const pluginRepo = createNodeProject(controlRoot, 'AlembicPlugin');
    const serverRepo = createNodeProject(controlRoot, 'Alembic');

    const identities = [
      {
        absolutePath: join(coreRepo, 'lib', 'index.ts'),
        folderDisplayName: 'AlembicCore',
        folderId: 'folder-core',
        folderPath: coreRepo,
        folderRelativeRoot: 'AlembicCore',
        projectScopeId: 'scope-a',
        qualifiedPath: 'AlembicCore/lib/index.ts',
        relativePath: 'lib/index.ts',
      },
      {
        absolutePath: join(pluginRepo, 'lib', 'index.ts'),
        folderDisplayName: 'AlembicPlugin',
        folderId: 'folder-plugin',
        folderPath: pluginRepo,
        folderRelativeRoot: 'AlembicPlugin',
        projectScopeId: 'scope-a',
        qualifiedPath: 'AlembicPlugin/lib/index.ts',
        relativePath: 'lib/index.ts',
      },
      {
        absolutePath: join(serverRepo, 'bin', 'api-server.ts'),
        folderDisplayName: 'Alembic',
        folderId: 'folder-alembic',
        folderPath: serverRepo,
        folderRelativeRoot: 'Alembic',
        projectScopeId: 'scope-a',
        qualifiedPath: 'Alembic/bin/api-server.ts',
        relativePath: 'bin/api-server.ts',
      },
    ];

    const identityMap = buildProjectScopeSourceIdentityMap(identities);
    const normalized = normalizeProjectScopeSourceRefsForRuntime(
      ['Alembic/bin/api-server.ts:12', 'lib/index.ts', 'AlembicCore/src/core/database.ts'],
      identities
    );

    expect(identityMap).toMatchObject({
      preferredRef: 'qualifiedPath',
      sourceCount: 3,
    });
    expect(normalized.activeSourceRefs).toEqual(['Alembic/bin/api-server.ts:12']);
    expect(normalized.rejected.map((ref) => [ref.input, ref.reason])).toEqual([
      ['lib/index.ts', 'not-found'],
      ['AlembicCore/src/core/database.ts', 'not-found'],
    ]);
  });
});

function createNodeProject(root: string, name: string): string {
  const projectRoot = join(root, name);
  mkdirSync(join(projectRoot, 'lib'), { recursive: true });
  writeFileSync(join(projectRoot, 'package.json'), `${JSON.stringify({ name })}\n`);
  writeFileSync(
    join(projectRoot, 'lib', 'index.ts'),
    `export const name = ${JSON.stringify(name)};\n`
  );
  return projectRoot;
}

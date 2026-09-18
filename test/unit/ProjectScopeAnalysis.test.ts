import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAlembicDatabase } from '@alembic/core/database';
import { pathGuard } from '@alembic/core/io';
import { KnowledgeEntry } from '@alembic/core/knowledge';
import { createAlembicRepositories } from '@alembic/core/repositories';
import { createCanonicalSourceIdentity, createProjectDescriptor } from '@alembic/core/shared';
import { WorkspaceResolver } from '@alembic/core/workspace';
import { afterEach, describe, expect, test } from 'vitest';
import * as KnowledgeModule from '../../lib/injection/modules/KnowledgeModule.js';
import { ServiceContainer } from '../../lib/injection/ServiceContainer.js';
import {
  attachProjectScopeSourceIdentitiesToView,
  attachProjectScopeToScanOptions,
  buildProjectScopeSourceIdentityMap,
  collectProjectScopeSourceIdentities,
  normalizeProjectScopeSourceRefsForRuntime,
  resolveProjectScopeAnalysisContext,
} from '../../lib/project-scope/ProjectScopeAnalysis.js';
import { initializeGenerateRuntime } from '../../lib/recipe-pipeline/generate/execution/RuntimeInitializer.js';

const tempDirs: string[] = [];

describe('ProjectScope analysis wiring', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test('keeps colliding folder identities and blocks ambiguous string refs without losing explicit paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'alembic-same-folder-name-'));
    tempDirs.push(root);
    const identities = sameNameIdentities(root);
    const carrier = attachProjectScopeSourceIdentitiesToView(
      {
        projectScopeSourceIdentityMap: null as ReturnType<
          typeof buildProjectScopeSourceIdentityMap
        >,
      },
      [...identities, identities[0]]
    );
    expect(carrier.projectScopeSourceIdentityMap?.sourceCount).toBe(2);
    expect(
      carrier.projectScopeSourceIdentityMap?.entries.map((identity) => identity.folderId)
    ).toEqual(identities.map((identity) => identity.folderId));
    for (const ordered of [identities, [...identities].reverse()]) {
      for (const suffix of [':1', ':1-1', '#L1-L1']) {
        const result = normalizeProjectScopeSourceRefsForRuntime(
          [`common/lib/index.ts${suffix}`],
          ordered
        );
        expect(result.activeSourceRefs).toEqual([]);
        expect(result.rejected[0]).toMatchObject({ status: 'ambiguous', reason: 'ambiguous-path' });
      }
    }
    const absoluteRef = `${identities[0].absolutePath}:1-1`;
    expect(
      normalizeProjectScopeSourceRefsForRuntime([absoluteRef], identities).activeSourceRefs
    ).toEqual([absoluteRef]);
  });

  test('registered singleton sees current runtime identities and preserves truth when resolution is blocked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'alembic-scope-reconcile-wiring-'));
    tempDirs.push(root);
    pathGuard.configure({ projectRoot: root, knowledgeBaseDir: 'Alembic' });
    const runtime = await openAlembicDatabase({ path: join(root, '.asd', 'alembic.db') });
    try {
      const container = new ServiceContainer();
      container.singletons._projectRoot = root;
      KnowledgeModule.register(container);
      const repositories = createAlembicRepositories(runtime.connection);
      for (const [name, repository] of Object.entries(repositories)) {
        container.register(name, () => repository);
      }
      container.register('database', () => runtime.connection.getDb());
      // Singleton可早于generate初始化创建；必须每次读取本轮真实生产者注册的identity快照。
      const reconciler = container.get('sourceRefReconciler');
      const identities = sameNameIdentities(root);
      await initializeGenerateRuntime({
        container,
        projectRoot: root,
        dataRoot: root,
        allFiles: [],
        projectScopeSourceIdentities: identities,
      });
      const entry = new KnowledgeEntry({
        title: 'Ambiguous source',
        content: { markdown: 'Track a real source reference.' },
        reasoning: { sources: ['common/lib/index.ts:1'] },
      });
      await repositories.knowledgeRepository.create(entry);
      const previous = {
        recipeId: entry.id,
        sourcePath: 'common/lib/index.ts:1',
        status: 'active',
        verifiedAt: Date.now(),
        contentFp: 'original-fingerprint',
      };
      repositories.recipeSourceRefRepository.upsert(previous);
      let snapshotsRead = 0;
      Object.defineProperty(container.singletons, '_projectScopeSourceIdentities', {
        configurable: true,
        get: () => {
          snapshotsRead++;
          return identities;
        },
      });

      const report = await reconciler.reconcile();
      expect.soft(snapshotsRead).toBe(1);
      expect.soft(report.failed).toBe(1);
      expect.soft(report.stale).toBe(0);
      expect.soft(report.blockers?.join(' ')).toContain('ambiguous');
      expect
        .soft(repositories.recipeSourceRefRepository.findOne(entry.id, previous.sourcePath))
        .toMatchObject(previous);

      const absoluteRef = `${identities[0].absolutePath}:1`;
      const explicit = new KnowledgeEntry({
        title: 'Explicit source identity',
        content: { markdown: 'A disambiguated file.' },
        reasoning: { sources: [absoluteRef] },
      });
      await repositories.knowledgeRepository.create(explicit);
      snapshotsRead = 0;
      const explicitReport = await reconciler.reconcileRecipeSourceRefs(explicit);
      expect(explicitReport.active).toBe(1);
      expect(snapshotsRead).toBe(1);
      expect(
        repositories.recipeSourceRefRepository.findOne(explicit.id, absoluteRef)?.contentFp
      ).toBeTruthy();

      Object.defineProperty(container.singletons, '_projectScopeSourceIdentities', {
        configurable: true,
        get: () => {
          throw new Error('identity provider unavailable');
        },
      });
      const blocked = await reconciler.reconcile({ force: true });
      expect.soft(blocked.failed).toBe(1);
      expect.soft(blocked.blockers?.join(' ')).toContain('identity provider unavailable');
      expect
        .soft(repositories.recipeSourceRefRepository.findOne(entry.id, previous.sourcePath))
        .toMatchObject(previous);
    } finally {
      runtime.close();
      pathGuard._reset();
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

function sameNameIdentities(root: string) {
  const folders = ['apps', 'tools'].map((parent) =>
    createNodeProject(join(root, parent), 'common')
  );
  const scope = createProjectDescriptor({
    controlRoot: root,
    dataRoot: join(root, '.ghost'),
    folders: folders.map((path) => ({ path })),
  });
  return scope.folders.map((folder) =>
    createCanonicalSourceIdentity({
      folderDisplayName: folder.displayName,
      folderId: folder.id,
      folderPath: folder.path,
      projectRoot: root,
      projectScopeId: scope.projectScopeId,
      sourcePath: 'lib/index.ts',
    })
  );
}

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

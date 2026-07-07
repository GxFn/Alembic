import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { buildPanoramaEndpointFacts } from '../../lib/project-facts/PanoramaEndpointFacts.js';
import type { ProjectScopeAnalysisContext } from '../../lib/project-scope/ProjectScopeAnalysis.js';

const fixtures: string[] = [];

describe('PanoramaEndpointFacts', () => {
  afterEach(async () => {
    await Promise.all(
      fixtures.splice(0).map((fixture) => rm(fixture, { force: true, recursive: true }))
    );
  });

  test('builds bounded ProjectScope member facts without scanning non-members', async () => {
    const controlRoot = await mkdtemp(join(tmpdir(), 'alembic-panorama-facts-'));
    fixtures.push(controlRoot);
    await writeSources(controlRoot, {
      'Alembic/lib/a.ts': 'export const a = 1;\n',
      'Alembic/lib/b.ts': 'export const b = 1;\n',
      'Alembic/lib/c.ts': 'export const c = 1;\n',
      'AlembicCore/src/core.ts': 'export const core = 1;\n',
      'AlembicCore/src/extra.ts': 'export const extra = 1;\n',
      'BiliDili/Sources/App.swift': 'public struct App {}\n',
      'wakeflow-ledger/private.ts': 'export const ledger = 1;\n',
    });

    const facts = await buildPanoramaEndpointFacts({
      analysisScope: projectScopeAnalysis(controlRoot, ['Alembic', 'AlembicCore']),
      maxFiles: 4,
    });

    expect(facts.projectRoot).toBe(controlRoot);
    expect(facts.fileCount).toBeLessThanOrEqual(4);
    expect(facts.projectMapModules).toEqual([
      expect.objectContaining({
        moduleId: 'target:Alembic:Alembic',
        moduleName: 'Alembic',
        modulePath: 'Alembic',
      }),
      expect.objectContaining({
        moduleId: 'target:AlembicCore:AlembicCore',
        moduleName: 'AlembicCore',
        modulePath: 'AlembicCore',
      }),
    ]);
    expect(JSON.stringify(facts)).not.toContain('BiliDili');
    expect(JSON.stringify(facts)).not.toContain('wakeflow-ledger');
  });

  test('preserves single-repo panorama facts without ProjectScope', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'alembic-panorama-single-'));
    fixtures.push(projectRoot);
    await writeSources(projectRoot, {
      'README.md': '# ignored\n',
      'src/index.ts': 'export const app = 1;\n',
      'src/service.ts': 'export const service = 1;\n',
    });

    const facts = await buildPanoramaEndpointFacts({
      analysisScope: singleRepoAnalysis(projectRoot),
      maxFiles: 10,
    });

    expect(facts.projectRoot).toBe(projectRoot);
    expect(facts.fileCount).toBe(2);
    expect(facts.moduleCount).toBe(1);
    expect(facts.projectMapModules[0]).toMatchObject({
      moduleName: basename(projectRoot),
      modulePath: 'src',
      ownedFileCount: 2,
      role: 'source',
    });
  });
});

async function writeSources(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(root, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }
}

function projectScopeAnalysis(
  controlRoot: string,
  folderNames: readonly string[]
): ProjectScopeAnalysisContext {
  return {
    controlRoot,
    currentFolderId: null,
    dataRoot: '/tmp/alembic-data',
    folderCount: folderNames.length,
    projectRoot: controlRoot,
    projectScope: {
      controlRoot: { path: controlRoot },
      currentFolderId: null,
      folders: folderNames.map((name) => ({
        displayName: name,
        id: name,
        path: join(controlRoot, name),
        role: 'source',
      })),
      projectScopeId: 'scope-facts',
    } as NonNullable<ProjectScopeAnalysisContext['projectScope']>,
    projectScopeId: 'scope-facts',
  };
}

function singleRepoAnalysis(projectRoot: string): ProjectScopeAnalysisContext {
  return {
    controlRoot: null,
    currentFolderId: null,
    dataRoot: '/tmp/alembic-data',
    folderCount: 0,
    projectRoot,
    projectScope: null,
    projectScopeId: null,
  };
}

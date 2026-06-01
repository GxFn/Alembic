import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectIntelligenceCapability } from '@alembic/core/project-intelligence';
import { createProjectDescriptor } from '@alembic/core/shared';
import { WorkspaceResolver } from '@alembic/core/workspace';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  attachProjectScopeToScanOptions,
  collectProjectScopeSourceIdentities,
  resolveProjectScopeAnalysisContext,
} from '../../lib/project-scope/ProjectScopeAnalysis.js';

const tempDirs: string[] = [];

describe('ProjectScope analysis wiring', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test('passes ProjectScope folders into ProjectIntelligence without scanning control root or vendor snapshots', async () => {
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

    const result = await ProjectIntelligenceCapability.run({
      ctx: {
        container,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
        },
      },
      materialize: {
        callGraph: false,
        codeEntityGraph: false,
        dependencyEdges: false,
        guardViolations: false,
        moduleEntities: false,
        panorama: false,
      },
      projectRoot: analysis.projectRoot,
      scan: attachProjectScopeToScanOptions(
        {
          generateAstContext: false,
          maxFiles: 20,
          skipGuard: true,
        },
        analysis
      ),
    });

    expect(result.allFiles.map((file) => file.relativePath).sort()).toEqual([
      'lib/index.ts',
      'lib/index.ts',
    ]);
    expect(collectProjectScopeSourceIdentities(result).map((ref) => ref.qualifiedPath).sort()).toEqual([
      'AlembicCore/lib/index.ts',
      'AlembicPlugin/lib/index.ts',
    ]);
    expect(result.allFiles.map((file) => file.path)).not.toEqual(
      expect.arrayContaining([
        join(controlRoot, 'lib', 'control.ts'),
        join(controlRoot, 'vendor', 'AlembicCore', 'lib', 'index.ts'),
      ])
    );
  });
});

function createNodeProject(root: string, name: string): string {
  const projectRoot = join(root, name);
  mkdirSync(join(projectRoot, 'lib'), { recursive: true });
  writeFileSync(join(projectRoot, 'package.json'), `${JSON.stringify({ name })}\n`);
  writeFileSync(join(projectRoot, 'lib', 'index.ts'), `export const name = ${JSON.stringify(name)};\n`);
  return projectRoot;
}

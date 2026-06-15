import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ProjectContextContract,
  ProjectContextEnvelope,
  ProjectContextRequest,
  ProjectContextResult,
} from '@alembic/core/project-context';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  AGENT_PROJECT_CONTEXT_MAPPED_ROUTES,
  runAgentProjectContextAnalysis,
} from '../../lib/workflows/agent-project-context/AgentProjectContextAnalysis.js';

const tempDirs: string[] = [];

describe('AgentProjectContextAnalysis', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test('routes built-in Agent project facts through the ProjectContext package facade', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'alembic-agent-project-context-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'lib'), { recursive: true });
    writeFileSync(join(projectRoot, 'package.json'), '{"name":"agent-context-fixture"}\n');
    writeFileSync(join(projectRoot, 'lib', 'index.ts'), 'export const local = true;\n');

    const calls: ProjectContextRequest[] = [];
    const projectContext: ProjectContextContract = {
      async execute(request) {
        calls.push(request);
        return createEnvelope(request);
      },
    };

    const result = await runAgentProjectContextAnalysis({
      ctx: {
        container: {},
        logger: { info: vi.fn(), warn: vi.fn() },
      },
      projectContext,
      projectRoot,
      scan: {
        contentMaxLines: 40,
        generateAstContext: true,
        generateReport: true,
        maxFiles: 10,
        skipGuard: true,
      },
    });

    expect(calls.map((call) => call.kind)).toEqual(
      expect.arrayContaining([...AGENT_PROJECT_CONTEXT_MAPPED_ROUTES])
    );
    expect(
      AGENT_PROJECT_CONTEXT_MAPPED_ROUTES.every((route) => calls.some((c) => c.kind === route))
    ).toBe(true);
    expect(result.allFiles.map((file) => file.relativePath)).toContain('lib/index.ts');
    expect(result.allFiles.find((file) => file.relativePath === 'lib/index.ts')?.content).toContain(
      'from project context'
    );
    expect(result.report.projectContext).toMatchObject({
      mappedRoutes: AGENT_PROJECT_CONTEXT_MAPPED_ROUTES,
    });
    expect(result.activeDimensions.length).toBeGreaterThan(0);
  });

  test('executes the public ProjectContext package facade against a local project', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'alembic-agent-project-context-real-'));
    tempDirs.push(projectRoot);
    mkdirSync(join(projectRoot, 'lib'), { recursive: true });
    writeFileSync(join(projectRoot, 'package.json'), '{"name":"agent-context-real"}\n');
    writeFileSync(
      join(projectRoot, 'lib', 'index.ts'),
      'export function realProbe() { return 1; }\n'
    );

    const result = await runAgentProjectContextAnalysis({
      ctx: {
        container: {},
        logger: { info: vi.fn(), warn: vi.fn() },
      },
      projectRoot,
      scan: {
        contentMaxLines: 20,
        generateReport: true,
        maxFiles: 4,
        skipGuard: true,
      },
    });

    expect(result.allFiles.map((file) => file.relativePath)).toContain('lib/index.ts');
    expect(result.report.projectContext).toMatchObject({
      mappedRoutes: AGENT_PROJECT_CONTEXT_MAPPED_ROUTES,
    });
    expect(JSON.stringify(result.report)).toContain('source-slice');
  });

  test('cold-start and rescan workflows no longer call the old ProjectIntelligence capability', () => {
    const coldStart = readFileSync('lib/workflows/cold-start/ColdStartWorkflow.ts', 'utf8');
    const rescan = readFileSync(
      'lib/workflows/knowledge-rescan/KnowledgeRescanWorkflow.ts',
      'utf8'
    );

    expect(coldStart).not.toContain('ProjectIntelligenceCapability.run');
    expect(rescan).not.toContain('ProjectIntelligenceCapability.run');
    expect(coldStart).toContain('runAgentProjectContextAnalysis');
    expect(rescan).toContain('runAgentProjectContextAnalysis');
  });
});

function createEnvelope(
  request: ProjectContextRequest
): ProjectContextEnvelope<ProjectContextResult> {
  switch (request.kind) {
    case 'space':
      return envelope(request, {
        activeRepo: undefined,
        boundaries: [],
        nextRefs: [],
        repos: [{ id: 'fixture', name: 'Fixture', root: '.', ref: ref('repo', 'fixture') }],
        sourceFolders: [],
        space: {
          id: 'fixture-space',
          root: String(request.scope.projectRoot),
          sourceFolders: [],
        },
        structuralHotspots: [],
      });
    case 'repo':
      return envelope(request, {
        buildSystems: [{ configRefs: [], kind: 'typescript' }],
        commands: [],
        configFiles: [],
        entrypoints: [],
        languages: [{ fileCount: 1, language: 'typescript' }],
        localPackages: [],
        mapSummary: {
          cycleCount: 0,
          dependencyEdgeCount: 1,
          hotspotCount: 0,
          layerCount: 1,
          moduleCount: 1,
          nextRefs: [],
        },
        nextRefs: [],
        packageSystems: [],
        repo: { id: 'fixture', name: 'Fixture', root: '.', ref: ref('repo', 'fixture') },
        sourceRoots: [{ path: 'lib', role: 'source' }],
        targets: [{ kind: 'library', name: 'Fixture', refs: [] }],
        topAreas: [{ path: 'lib', role: 'source' }],
      });
    case 'module':
      return envelope(request, {
        inflow: [],
        module: {
          id: 'module-lib',
          kind: 'source',
          name: 'lib',
          ownedFileCount: 1,
          ref: ref('module', 'module-lib'),
        },
        nextRefs: [],
        outflow: [],
        ownedFiles: [{ filePath: 'lib/index.ts', language: 'typescript' }],
        publicSurfaces: [],
      });
    case 'module-layers':
      return envelope(request, {
        boundaryCrossings: [],
        fileGroups: [],
        layers: [{ id: 'layer-source', name: 'source', order: 1 }],
        module: {
          id: 'module-lib',
          kind: 'source',
          name: 'lib',
          ownedFileCount: 1,
          ref: ref('module', 'module-lib'),
        },
        nextRefs: [],
      });
    case 'map':
      return envelope(request, {
        cycles: [],
        dependencySummary: { edgeCount: 1, notes: [] },
        externalDependencyHotspots: [],
        hotspots: [],
        layers: [{ id: 'layer-source', name: 'source', order: 1 }],
        majorFlows: [],
        modules: [{ id: 'module-lib', kind: 'source', name: 'lib', ownedFileCount: 1 }],
        nextRefs: [],
        repo: { id: 'fixture', name: 'Fixture', root: '.', ref: ref('repo', 'fixture') },
      });
    case 'source-slice':
      return envelope(request, {
        file: {
          filePath: String((request.payload as { filePath?: string }).filePath),
          language: 'typescript',
          lineCount: 1,
          ref: ref('file', 'lib-index'),
        },
        hash: 'hash',
        nextRefs: [],
        range: { endLine: 1, startLine: 1 },
        text: 'export const value = "from project context";\n',
      });
    case 'file-symbols':
      return envelope(request, {
        file: {
          filePath: String((request.payload as { filePath?: string }).filePath),
          language: 'typescript',
          lineCount: 1,
          ref: ref('file', 'lib-index'),
        },
        naming: { warnings: [] },
        nextRefs: [],
        symbols: [
          {
            exported: true,
            filePath: String((request.payload as { filePath?: string }).filePath),
            kind: 'function',
            name: 'value',
            ref: ref('symbol', 'value'),
          },
        ],
      });
    case 'file-flow':
      return envelope(request, {
        callees: [],
        callers: [],
        exports: [],
        file: {
          filePath: String((request.payload as { filePath?: string }).filePath),
          language: 'typescript',
          lineCount: 1,
          ref: ref('file', 'lib-index'),
        },
        imports: [],
        inflow: [],
        nextRefs: [],
        outflow: [],
      });
    case 'anchor-range':
      return envelope(request, {
        anchor: {
          filePath: String((request.payload as { filePath?: string }).filePath),
          kind: 'file-line',
          line: 1,
        },
        containingRefs: [],
        file: {
          filePath: String((request.payload as { filePath?: string }).filePath),
          language: 'typescript',
          lineCount: 1,
          ref: ref('file', 'lib-index'),
        },
        nextRefs: [],
        radius: { afterLines: 2, beforeLines: 2, relationHops: 0 },
        range: { endLine: 1, startLine: 1 },
        relatedRefs: [],
        relationSites: [],
        sourceSlices: [],
        symbols: [],
      });
  }
}

function envelope(
  request: ProjectContextRequest,
  data: ProjectContextResult
): ProjectContextEnvelope<ProjectContextResult> {
  return {
    contractVersion: 1,
    data,
    project: { projectRoot: String(request.scope.projectRoot) },
    queryLevel: request.kind,
    refs: [],
  };
}

function ref(kind: string, id: string) {
  return {
    id,
    kind,
    scope: { projectRoot: '' },
  } as never;
}

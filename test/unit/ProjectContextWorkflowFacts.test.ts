import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildProjectContextMissionArtifacts,
  buildProjectContextWorkflowFacts,
} from '../../lib/workflows/project-context/ProjectContextWorkflowFacts.js';

const fixtures: string[] = [];
const projectContextCapabilitiesMock = vi.hoisted(() => ({
  executeOverride: null as null | ((request: { kind: string }) => Promise<unknown>),
}));

vi.mock('@alembic/core/project-context-capabilities', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@alembic/core/project-context-capabilities')>();
  return {
    ...actual,
    ProjectContextCapabilities: {
      ...actual.ProjectContextCapabilities,
      execute: vi.fn((request: { kind: string }) =>
        projectContextCapabilitiesMock.executeOverride
          ? projectContextCapabilitiesMock.executeOverride(request)
          : actual.ProjectContextCapabilities.execute(request as never)
      ),
    },
  };
});

afterEach(async () => {
  projectContextCapabilitiesMock.executeOverride = null;
  vi.clearAllMocks();
  await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe('ProjectContextWorkflowFacts', () => {
  test('executes direct ProjectContext facts for built-in Agent workflow output', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'alembic-pci4-project-context-'));
    fixtures.push(projectRoot);

    await import('node:fs/promises').then(async (fs) => {
      await fs.mkdir(join(projectRoot, 'lib'), { recursive: true });
      await fs.writeFile(
        join(projectRoot, 'package.json'),
        JSON.stringify({ name: 'pci4-fixture', type: 'module' })
      );
      await fs.writeFile(
        join(projectRoot, 'lib/index.ts'),
        'export function answer(): number { return 42; }\n'
      );
    });

    const facts = await buildProjectContextWorkflowFacts({
      contentMaxLines: 8,
      ctx: { container: { get: () => null }, logger: console },
      projectRoot,
      source: 'alembic-main-bootstrap',
    });

    expect(facts.projectContextSummary).toMatchObject({ source: 'project-context' });
    expect(facts.requestKinds).toContain('space');
    expect(facts.requestKinds).toContain('repo');
    expect(facts.requestKinds).toContain('map');
    expect(facts.requestKinds).toContain('source-slice');
    expect(facts.allFiles.some((file) => file.relativePath.endsWith('lib/index.ts'))).toBe(true);
    expect(JSON.stringify(facts.projectContextSummary)).toContain('project-context');
  });

  test('derives ProjectMap modules from target refs and real files when map modules are empty', async () => {
    const projectRoot = '/tmp/alembic-swift-target-project';
    mockSwiftTargetProjectContext(projectRoot);

    const facts = await buildProjectContextWorkflowFacts({
      contentMaxLines: 8,
      ctx: { container: { get: () => null }, logger: console },
      projectRoot,
      source: 'alembic-main-rescan',
    });

    expect(facts.projectMapModules).toContainEqual(
      expect.objectContaining({
        moduleName: 'AOXFoundationKit',
        modulePath: 'Sources/AOXFoundationKit',
        ownedFiles: ['Sources/AOXFoundationKit/Client.swift'],
      })
    );
    expect(facts.moduleCount).toBeGreaterThan(0);
  });

  test('passes rescan evidence into ProjectContext mission briefing artifacts', async () => {
    const projectRoot = '/tmp/alembic-swift-target-project';
    mockSwiftTargetProjectContext(projectRoot);
    const facts = await buildProjectContextWorkflowFacts({
      contentMaxLines: 8,
      ctx: { container: { get: () => null }, logger: console },
      projectRoot,
      source: 'alembic-main-rescan',
    });

    const artifacts = buildProjectContextMissionArtifacts({
      dimensions: [{ id: 'architecture', label: 'Architecture' }],
      facts,
      profile: 'rescan',
      rescan: {
        evidencePlan: {
          allRecipes: [],
          coveredDimensions: 0,
          decayCount: 0,
          dimensionGaps: [],
          executionReasons: {},
          gapSummary: 'no existing recipes',
          occupiedTriggers: [],
          totalCreateBudget: 1,
          totalGap: 1,
        },
        prescreen: {
          autoResolved: [],
          dimensionGaps: {},
          needsVerification: [],
        },
      },
      session: { toJSON: () => ({ id: 'rescan-session' }) } as never,
    });

    expect(artifacts.briefing.meta).toMatchObject({ profile: 'rescan-host-agent' });
    expect(artifacts.briefing.evidenceHints).toMatchObject({
      rescanMode: true,
      evolutionPrescreen: {
        autoResolved: [],
        needsVerification: [],
      },
    });
  });

  test('removes built-in Agent legacy adapter and carrier imports from workflow routes', async () => {
    await expect(
      stat(
        join(process.cwd(), 'lib/workflows/agent-project-context/AgentProjectContextAnalysis.ts')
      )
    ).rejects.toThrow();

    const coldStart = await readFile(
      join(process.cwd(), 'lib/workflows/cold-start/ColdStartWorkflow.ts'),
      'utf8'
    );
    const rescan = await readFile(
      join(process.cwd(), 'lib/workflows/knowledge-rescan/KnowledgeRescanWorkflow.ts'),
      'utf8'
    );
    const combined = `${coldStart}\n${rescan}`;

    expect(combined).not.toContain('runAgentProjectContextAnalysis');
    expect(combined).not.toContain('AgentProjectContextAnalysis');
    expect(combined).not.toContain('buildProjectSnapshot');
    expect(combined).not.toContain('ProjectSnapshot');
    expect(combined).not.toContain('@alembic/core/workflows/capabilities/project-intelligence');
  });

  test('keeps the moduleSeeds detail loop separate from ProjectMap module fan-out facts', async () => {
    const source = await readFile(
      join(process.cwd(), 'lib/workflows/project-context/ProjectContextWorkflowFacts.ts'),
      'utf8'
    );

    expect(source).toContain('for (const seed of moduleSeeds.slice(0, maxModuleDetails)) {');
    expect(source).toContain(
      'const projectMapModules = buildProjectMapModules(presenterInput.map);'
    );
    expect(source).toContain('projectMapModules,');
  });
});

function mockSwiftTargetProjectContext(projectRoot: string): void {
  const targetRef = makeProjectContextRef(projectRoot, 'path:repo:Sources/AOXFoundationKit', {
    filePath: 'Sources/AOXFoundationKit',
    kind: 'path',
    label: 'Sources/AOXFoundationKit',
  });
  const fileRef = makeProjectContextRef(
    projectRoot,
    'file:repo:Sources/AOXFoundationKit/Client.swift',
    {
      filePath: 'Sources/AOXFoundationKit/Client.swift',
      kind: 'file',
      label: 'Client.swift',
    }
  );
  const repoRef = makeProjectContextRef(projectRoot, 'repo:repo', {
    kind: 'repo',
    label: 'SwiftTarget',
  });

  projectContextCapabilitiesMock.executeOverride = async (request) => {
    switch (request.kind) {
      case 'space':
        return projectContextEnvelope(projectRoot, 'space', {
          boundaries: [],
          nextRefs: [],
          repos: [],
          sourceFolders: [],
          space: { id: 'space', ref: repoRef },
          structuralHotspots: [],
        });
      case 'repo':
        return projectContextEnvelope(
          projectRoot,
          'repo',
          {
            buildSystems: [],
            commands: [],
            configFiles: [],
            entrypoints: [],
            languages: [{ fileCount: 1, language: 'swift' }],
            localPackages: [],
            nextRefs: [fileRef],
            packageSystems: [],
            repo: { name: 'SwiftTarget', ref: repoRef },
            sourceRoots: [],
            targets: [{ kind: 'target', name: 'AOXFoundationKit', refs: [targetRef] }],
            topAreas: [],
          },
          [repoRef, targetRef, fileRef]
        );
      case 'source-slice':
        return projectContextEnvelope(
          projectRoot,
          'source-slice',
          {
            file: {
              filePath: 'Sources/AOXFoundationKit/Client.swift',
              language: 'swift',
              lineCount: 1,
              ref: fileRef,
              repoId: 'repo',
            },
            nextRefs: [],
            range: { endLine: 1, startLine: 1 },
            text: 'public struct Client {}',
          },
          [fileRef]
        );
      case 'map':
      case 'module':
      case 'module-layers':
      case 'file-flow':
      case 'file-symbols':
      case 'anchor-range':
        return projectContextEnvelope(projectRoot, request.kind, {
          available: false,
          kind: request.kind,
          nextRefs: [fileRef],
          reason: 'fixture unavailable',
        });
      default:
        return projectContextEnvelope(projectRoot, request.kind, {
          available: false,
          kind: request.kind,
          nextRefs: [],
          reason: 'fixture unavailable',
        });
    }
  };
}

function projectContextEnvelope(
  projectRoot: string,
  queryLevel: string,
  data: Record<string, unknown>,
  refs: Array<Record<string, unknown>> = []
) {
  return {
    contractVersion: 1,
    data,
    project: { displayName: 'SwiftTarget', projectRoot },
    queryLevel,
    refs,
  } as never;
}

function makeProjectContextRef(
  projectRoot: string,
  id: string,
  input: {
    filePath?: string;
    kind: string;
    label: string;
  }
): Record<string, unknown> {
  return {
    id,
    kind: input.kind,
    label: input.label,
    level: 'repo',
    scope: {
      filePath: input.filePath,
      projectRoot,
      repoId: 'repo',
    },
  };
}

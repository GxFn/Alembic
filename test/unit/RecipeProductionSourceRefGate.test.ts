import type { CreateRecipeItem } from '@alembic/core/knowledge';
import { RecipeProductionGateway } from '@alembic/core/knowledge';
import { createCanonicalSourceIdentity } from '@alembic/core/shared';
import { describe, expect, test, vi } from 'vitest';
import { attachProjectScopeSourceRefGateToRecipeProductionGateway } from '../../lib/project-scope/RecipeProductionSourceRefGate.js';

const controlRoot = '/workspace';

const sourceIdentities = [
  createCanonicalSourceIdentity({
    folderDisplayName: 'Alembic',
    folderId: 'folder-alembic',
    folderPath: `${controlRoot}/Alembic`,
    projectRoot: controlRoot,
    projectScopeId: 'scope-a',
    sourcePath: 'bin/api-server.ts',
  }),
  createCanonicalSourceIdentity({
    folderDisplayName: 'Alembic',
    folderId: 'folder-alembic',
    folderPath: `${controlRoot}/Alembic`,
    projectRoot: controlRoot,
    projectScopeId: 'scope-a',
    sourcePath: 'lib/injection/ServiceContainer.ts',
  }),
];

describe('RecipeProductionSourceRefGate', () => {
  test('injects current ProjectScope source identities at create time', async () => {
    const deps = makeDeps();
    const container = { singletons: { _projectScopeSourceIdentities: [] as unknown[] } };
    const gateway = attachProjectScopeSourceRefGateToRecipeProductionGateway(
      new RecipeProductionGateway(deps),
      container
    );

    container.singletons._projectScopeSourceIdentities = sourceIdentities;

    const result = await gateway.create({
      source: 'agent-tool',
      items: [
        makeItem({
          reasoning: {
            whyStandard: 'ProjectScope sourceRef gate fixture',
            sources: ['package.json'],
            confidence: 0.9,
          },
          sourceRefs: ['Alembic/lib/injection/index.ts'],
        }),
      ],
      options: { skipConsolidation: true },
    });

    expect(result.created).toHaveLength(0);
    expect(result.rejected[0]).toMatchObject({ reason: 'source_ref_validation_failed' });
    expect(result.rejected[0].errors.join('\n')).toContain(
      'reasoning.sources rejected "package.json": not-found'
    );
    expect(result.rejected[0].errors.join('\n')).toContain(
      'sourceRefs rejected "Alembic/lib/injection/index.ts": not-found'
    );
    expect(deps.knowledgeService.create).not.toHaveBeenCalled();
  });

  test('keeps valid ProjectScope refs as canonical qualified refs', async () => {
    const deps = makeDeps();
    const gateway = attachProjectScopeSourceRefGateToRecipeProductionGateway(
      new RecipeProductionGateway(deps),
      { singletons: { _projectScopeSourceIdentities: sourceIdentities } }
    );

    const result = await gateway.create({
      source: 'agent-tool',
      items: [
        makeItem({
          reasoning: {
            whyStandard: 'ProjectScope sourceRef gate fixture',
            sources: ['api-server.ts'],
            confidence: 0.9,
          },
          sourceRefs: ['lib/injection/ServiceContainer.ts'],
        }),
      ],
      options: { skipConsolidation: true },
    });

    expect(result.rejected).toHaveLength(0);
    expect(result.created).toHaveLength(1);
    const saved = deps.knowledgeService.create.mock.calls[0][0] as {
      reasoning: { sources: string[] };
      sourceRefs: string[];
    };
    expect(saved.reasoning.sources).toEqual(['Alembic/bin/api-server.ts']);
    expect(saved.sourceRefs).toEqual([
      'Alembic/lib/injection/ServiceContainer.ts',
      'Alembic/bin/api-server.ts',
    ]);
  });

  test('rejects visible markdown and coreCode source markers before persistence', async () => {
    const deps = makeDeps();
    const gateway = attachProjectScopeSourceRefGateToRecipeProductionGateway(
      new RecipeProductionGateway(deps),
      { singletons: { _projectScopeSourceIdentities: sourceIdentities } }
    );

    const result = await gateway.create({
      source: 'agent-tool',
      items: [
        makeItem({
          content: {
            markdown: [
              '## Evidence',
              'Source: Alembic/lib/injection/index.ts',
              '',
              '```ts',
              'const rejectedSourceRef = true;',
              '```',
              '',
              'This fixture intentionally embeds a visible source marker that points to a path outside the current ProjectScope source identity index. The RecipeProductionSourceRefGate should promote visible markers into sourceRefs before Core validates the request so missing evidence cannot be persisted silently.',
            ].join('\n'),
            rationale:
              'Visible source markers can become persisted evidence unless the gateway promotes them into the Core ProjectScope sourceRef validation path.',
          },
          coreCode: '// source: package.json\nconst pattern = true;',
          reasoning: {
            whyStandard: 'ProjectScope sourceRef gate fixture',
            sources: ['Alembic/bin/api-server.ts'],
            confidence: 0.9,
          },
          sourceRefs: ['Alembic/bin/api-server.ts'],
        }),
      ],
      options: { skipConsolidation: true },
    });

    expect(result.created).toHaveLength(0);
    expect(result.rejected[0]).toMatchObject({ reason: 'source_ref_validation_failed' });
    expect(result.rejected[0].errors.join('\n')).toContain(
      'sourceRefs rejected "Alembic/lib/injection/index.ts": not-found'
    );
    expect(result.rejected[0].errors.join('\n')).toContain(
      'sourceRefs rejected "package.json": not-found'
    );
    expect(deps.knowledgeService.create).not.toHaveBeenCalled();
  });
});

function makeItem(overrides: Partial<CreateRecipeItem> = {}): CreateRecipeItem {
  return {
    title: 'ProjectScope sourceRef gate pattern',
    description: 'Ensure ProjectScope source refs are validated before persistence.',
    trigger: '@projectscope-source-ref-gate',
    kind: 'pattern',
    topicHint: 'project-scope',
    whenClause: 'When saving ProjectScope-aware Recipe candidates',
    doClause: 'Validate source refs before persisting Recipe candidates.',
    dontClause: 'Do not persist missing or ambiguous source refs.',
    coreCode: 'const sourceRefGate = true;',
    content: {
      markdown: [
        '## ProjectScope source refs',
        'Source: Alembic/bin/api-server.ts:1',
        '',
        '```ts',
        'const sourceRefGate = true;',
        '```',
        '',
        'ProjectScope source refs must be canonical before persistence so Recipe production cannot store stale workspace-root files or missing repository paths. The fixture is deliberately long enough to pass the Core V3 markdown quality gate while still keeping the unit test focused on the sourceRef production contract.',
      ].join('\n'),
      rationale:
        'The gateway must validate current ProjectScope source identities at create time before any Recipe candidate reaches persistence.',
    },
    reasoning: {
      whyStandard: 'ProjectScope sourceRef gate fixture',
      sources: ['Alembic/bin/api-server.ts'],
      confidence: 0.9,
    },
    tags: ['project-scope'],
    headers: [],
    language: 'typescript',
    category: 'ProjectScope',
    knowledgeType: 'code-pattern',
    usageGuide:
      '### Usage\nUse when validating ProjectScope-aware Recipe source refs before Recipe persistence.',
    ...overrides,
  };
}

function makeDeps() {
  return {
    knowledgeService: {
      create: vi.fn(async (data: Record<string, unknown>) => ({
        id: 'recipe-1',
        lifecycle: 'staging',
        title: data.title as string,
        kind: data.kind || 'pattern',
        ...data,
      })),
      updateQuality: vi.fn(async () => ({ score: 0.85 })),
    },
    projectRoot: '/tmp/project',
  };
}

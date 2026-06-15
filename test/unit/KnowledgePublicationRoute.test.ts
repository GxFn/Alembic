import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpContext } from '../../lib/resident/tool-schema/types.js';

const mocks = vi.hoisted(() => ({
  createRecipe: vi.fn(),
  findSimilarRecipes: vi.fn(),
  recordRejection: vi.fn(),
  recordSubmission: vi.fn(),
}));

vi.mock('@alembic/core/knowledge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@alembic/core/knowledge')>();
  return {
    ...actual,
    RecipeProductionGateway: class {
      create = mocks.createRecipe;
    },
  };
});

vi.mock('@alembic/core/service/candidate', () => ({
  findSimilarRecipes: mocks.findSimilarRecipes,
}));

import {
  describeSubmitKnowledgeProductionRoute,
  enhancedSubmitKnowledge,
} from '../../lib/resident/tool-handlers/consolidated.js';

function ctxWithServices(services: Record<string, unknown>, projectRoot = '/repo/asq'): McpContext {
  return {
    container: {
      singletons: { _projectRoot: projectRoot },
      get(name: string) {
        if (name in services) {
          return services[name];
        }
        return null;
      },
    },
  } as McpContext;
}

function productionSession(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'bs-asq',
    projectRoot: '/repo/asq',
    getProgress: vi.fn(() => ({ remainingDimIds: ['asq-publication'] })),
    submissionTracker: {
      getAllSubmittedTitles: vi.fn(() => new Set<string>()),
      getAllSubmittedTriggers: vi.fn(() => new Set<string>()),
      recordRejection: mocks.recordRejection,
      recordSubmission: mocks.recordSubmission,
    },
    toJSON: vi.fn(() => ({ id: 'bs-asq', projectRoot: '/repo/asq', total: 1 })),
    ...overrides,
  };
}

function sourceBackedItem(overrides: Record<string, unknown> = {}) {
  return {
    category: 'Tool',
    content: {
      markdown: 'Publication route keeps source relations visible.',
      rationale: 'Search output quality depends on source-backed context.',
    },
    coreCode: 'enhancedSubmitKnowledge(ctx, args)',
    description: 'Source-backed publication route',
    doClause: 'Preserve source and relation metadata through production gateway.',
    dontClause: 'Do not flatten relation metadata before Recipe creation.',
    graphRefs: ['sourceGraph:search-handler'],
    headerPaths: ['lib/resident/tool-handlers/consolidated.ts'],
    headers: ['import { enhancedSubmitKnowledge } from "./consolidated.js";'],
    includeHeaders: true,
    kind: 'fact',
    knowledgeType: 'event-and-data-flow',
    language: 'typescript',
    moduleName: 'resident-tools',
    reasoning: {
      confidence: 0.91,
      sources: ['Design ASQ4B1 publication route'],
      whyStandard: 'The publication route must be auditable from source evidence.',
    },
    relations: {
      related: [{ description: 'feeds search freshness validation', target: 'knowledge:k-asq' }],
    },
    sourceCandidateId: 'cand-asq',
    sourceFile: 'lib/resident/tool-handlers/consolidated.ts',
    sourceGraph: { ref: 'sourceGraph:search-handler' },
    sourceGraphRefs: ['sourceGraph:search-handler'],
    sourceRefs: ['lib/resident/tool-handlers/consolidated.ts:220'],
    title: 'ASQ source-backed publication route',
    trigger: 'asq-publication-route',
    usageGuide: '### When to use\nUse for ASQ source-backed production publication.',
    whenClause: 'When controller-authorized knowledge is submitted from source evidence.',
    ...overrides,
  };
}

async function submitAsqKnowledge(
  ctx: McpContext,
  overrides: Record<string, unknown> = {},
  itemOverrides: Record<string, unknown> = {}
) {
  return enhancedSubmitKnowledge(ctx, {
    client_id: `asq-route-${Math.random().toString(36).slice(2)}`,
    dimensionId: 'asq-publication',
    items: [sourceBackedItem(itemOverrides)],
    skipConsolidation: true,
    source: 'asq-controller',
    ...overrides,
  });
}

describe('knowledge publication production route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves source-backed metadata into RecipeProductionGateway and reports pending publication', async () => {
    const session = productionSession();
    const ctx = ctxWithServices({
      bootstrapSessionManager: { getSession: vi.fn(() => session) },
      knowledgeService: {},
    });
    mocks.createRecipe.mockResolvedValueOnce({
      blocked: [],
      created: [{ id: 'k-asq', title: 'ASQ source-backed publication route' }],
      merged: [],
      pendingSemanticReview: [],
      rejected: [],
    });

    const result = await submitAsqKnowledge(ctx, { sessionId: 'bs-asq' });

    expect(result.success).toBe(true);
    const gatewayCall = mocks.createRecipe.mock.calls[0][0];
    expect(gatewayCall.source).toBe('mcp-external');
    expect(gatewayCall.items[0]).toMatchObject({
      dimensionId: 'asq-publication',
      graphRefs: ['sourceGraph:search-handler'],
      headerPaths: ['lib/resident/tool-handlers/consolidated.ts'],
      includeHeaders: true,
      moduleName: 'resident-tools',
      relations: {
        related: [{ description: 'feeds search freshness validation', target: 'knowledge:k-asq' }],
      },
      source: 'asq-controller',
      sourceCandidateId: 'cand-asq',
      sourceFile: 'lib/resident/tool-handlers/consolidated.ts',
      sourceGraph: { ref: 'sourceGraph:search-handler' },
      sourceGraphRefs: ['sourceGraph:search-handler'],
      sourceRefs: ['lib/resident/tool-handlers/consolidated.ts:220'],
    });
    const data = result.data as Record<string, unknown>;
    expect(data.productionRoute).toMatchObject({
      createdIds: ['k-asq'],
      metadata: {
        itemsWithHeaderPaths: 1,
        itemsWithIncludeHeaders: 1,
        itemsWithModuleName: 1,
        itemsWithRelations: 1,
        itemsWithSourceCandidateId: 1,
        itemsWithSourceFile: 1,
        itemsWithSourceGraph: 3,
      },
      pendingPublication: true,
      publication: {
        defaultAgentPublishAllowed: false,
      },
      session: {
        activeSessionId: 'bs-asq',
        status: 'active',
        usable: true,
      },
    });
  });

  it('reports missing, invalid, no-produce, and project-mismatch session diagnostics', () => {
    expect(
      describeSubmitKnowledgeProductionRoute(
        ctxWithServices({ bootstrapSessionManager: { getSession: vi.fn(() => null) } }),
        { sessionId: 'missing-session' },
        [{ title: 'T' }]
      ).session
    ).toMatchObject({
      requestedSessionId: 'missing-session',
      status: 'missing',
      usable: false,
    });

    expect(
      describeSubmitKnowledgeProductionRoute(
        ctxWithServices({
          bootstrapSessionManager: { getSession: vi.fn(() => productionSession()) },
        }),
        { bootstrapSessionRef: 'bootstrap-session:other-session' },
        [{ title: 'T' }]
      ).session
    ).toMatchObject({
      activeSessionId: 'bs-asq',
      requestedSessionId: 'other-session',
      status: 'invalid-session',
      usable: false,
    });

    expect(
      describeSubmitKnowledgeProductionRoute(
        ctxWithServices({
          bootstrapSessionManager: {
            getSession: vi.fn(() =>
              productionSession({
                getProgress: vi.fn(() => ({ remainingDimIds: [] })),
                toJSON: vi.fn(() => ({ id: 'bs-asq', projectRoot: '/repo/asq', total: 0 })),
              })
            ),
          },
        }),
        { sessionId: 'bs-asq' },
        [{ title: 'T' }]
      ).session
    ).toMatchObject({
      activeSessionId: 'bs-asq',
      status: 'no-produce-session',
      usable: false,
    });

    expect(
      describeSubmitKnowledgeProductionRoute(
        ctxWithServices({
          bootstrapSessionManager: {
            getSession: vi.fn(() => productionSession({ projectRoot: '/repo/other' })),
          },
        }),
        { sessionId: 'bs-asq' },
        [{ title: 'T' }],
        '/repo/asq'
      ).session
    ).toMatchObject({
      activeProjectRoot: '/repo/other',
      activeSessionId: 'bs-asq',
      projectRoot: '/repo/asq',
      status: 'project-mismatch',
      usable: false,
    });
  });

  it('blocks ASQ/controller production submission when the session is missing before gateway create', async () => {
    const result = await submitAsqKnowledge(
      ctxWithServices({
        bootstrapSessionManager: { getSession: vi.fn(() => null) },
        knowledgeService: {},
      })
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PRODUCTION_SESSION_BLOCKED');
    expect(mocks.createRecipe).not.toHaveBeenCalled();
    const data = result.data as Record<string, Record<string, unknown>>;
    expect(data.productionRoute).toMatchObject({
      gate: {
        gatewayCalled: false,
        reasonCode: 'missing',
        status: 'blocked',
      },
      pendingPublication: false,
      session: { status: 'missing', usable: false },
    });
    expect(result.problem).toMatchObject({
      code: 'PRODUCTION_SESSION_BLOCKED',
      failingStep: 'production-session-gate',
      reasonCode: 'conflict',
    });
  });

  it('blocks ASQ/controller production submission when the requested session is invalid', async () => {
    const result = await submitAsqKnowledge(
      ctxWithServices({
        bootstrapSessionManager: { getSession: vi.fn(() => productionSession()) },
        knowledgeService: {},
      }),
      { sessionId: 'other-session' }
    );

    expect(result.success).toBe(false);
    expect(mocks.createRecipe).not.toHaveBeenCalled();
    const data = result.data as Record<string, Record<string, unknown>>;
    expect(data.productionRoute).toMatchObject({
      gate: { gatewayCalled: false, reasonCode: 'invalid-session', status: 'blocked' },
      session: {
        activeSessionId: 'bs-asq',
        requestedSessionId: 'other-session',
        status: 'invalid-session',
        usable: false,
      },
    });
  });

  it('blocks ASQ/controller production submission when the session has no produce work', async () => {
    const result = await submitAsqKnowledge(
      ctxWithServices({
        bootstrapSessionManager: {
          getSession: vi.fn(() =>
            productionSession({
              getProgress: vi.fn(() => ({ remainingDimIds: [] })),
              toJSON: vi.fn(() => ({ id: 'bs-asq', projectRoot: '/repo/asq', total: 0 })),
            })
          ),
        },
        knowledgeService: {},
      }),
      { sessionId: 'bs-asq' }
    );

    expect(result.success).toBe(false);
    expect(mocks.createRecipe).not.toHaveBeenCalled();
    const data = result.data as Record<string, Record<string, unknown>>;
    expect(data.productionRoute).toMatchObject({
      gate: { gatewayCalled: false, reasonCode: 'no-produce-session', status: 'blocked' },
      session: {
        activeSessionId: 'bs-asq',
        status: 'no-produce-session',
        usable: false,
      },
    });
  });

  it('blocks ASQ/controller production submission when the session project mismatches', async () => {
    const result = await submitAsqKnowledge(
      ctxWithServices({
        bootstrapSessionManager: {
          getSession: vi.fn(() => productionSession({ projectRoot: '/repo/other' })),
        },
        knowledgeService: {},
      }),
      { sessionId: 'bs-asq' }
    );

    expect(result.success).toBe(false);
    expect(mocks.createRecipe).not.toHaveBeenCalled();
    const data = result.data as Record<string, Record<string, unknown>>;
    expect(data.productionRoute).toMatchObject({
      gate: { gatewayCalled: false, reasonCode: 'project-mismatch', status: 'blocked' },
      session: {
        activeProjectRoot: '/repo/other',
        activeSessionId: 'bs-asq',
        projectRoot: '/repo/asq',
        status: 'project-mismatch',
        usable: false,
      },
    });
  });

  it('does not require a production session for ordinary MCP submissions', async () => {
    const ctx = ctxWithServices({
      bootstrapSessionManager: { getSession: vi.fn(() => null) },
      knowledgeService: {},
    });
    mocks.createRecipe.mockResolvedValueOnce({
      blocked: [],
      created: [{ id: 'k-mcp', title: 'Ordinary MCP recipe' }],
      merged: [],
      pendingSemanticReview: [],
      rejected: [],
    });

    const result = await enhancedSubmitKnowledge(ctx, {
      client_id: `ordinary-${Math.random().toString(36).slice(2)}`,
      items: [
        sourceBackedItem({
          source: 'mcp',
          sourceCandidateId: 'cand-ordinary',
          title: 'Ordinary MCP recipe',
          trigger: 'ordinary',
        }),
      ],
      skipConsolidation: true,
      source: 'mcp',
    });

    expect(result.success).toBe(true);
    expect(mocks.createRecipe).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, test, vi } from 'vitest';
import type { InternalToolHandlerContext } from '../../lib/tools/core/InternalToolHandler.js';
import { resolveGuardServicesFromContext } from '../../lib/tools/core/ToolGuardServices.js';
import { resolveInfraServicesFromContext } from '../../lib/tools/core/ToolInfraServices.js';
import {
  requireKnowledgeService,
  resolveKnowledgeServicesFromContext,
} from '../../lib/tools/core/ToolKnowledgeServices.js';
import { resolveLifecycleServicesFromContext } from '../../lib/tools/core/ToolLifecycleServices.js';
import {
  getFeedbackCollector,
  resolveQualityServicesFromContext,
} from '../../lib/tools/core/ToolQualityServices.js';

describe('tool service contract resolution', () => {
  test('does not rebuild internal service contracts from the raw container', () => {
    const context = baseContext();

    const knowledge = resolveKnowledgeServicesFromContext(context);
    const guard = resolveGuardServicesFromContext(context);
    const lifecycle = resolveLifecycleServicesFromContext(context);
    const infra = resolveInfraServicesFromContext(context);
    const quality = resolveQualityServicesFromContext(context);

    expect(context.container.get).not.toHaveBeenCalled();
    expect(knowledge.getKnowledgeService()).toBeNull();
    expect(guard.getGuardService()).toBeNull();
    expect(lifecycle.getKnowledgeLifecycleService()).toBeNull();
    expect(infra.getIndexingPipeline()).toBeNull();
    expect(quality.getQualityScorer()).toBeNull();
    expect(() => requireKnowledgeService(knowledge)).toThrow(
      'Knowledge service is not available in internal tool context'
    );
  });

  test('prefers typed service contracts provided by ToolCallContext', () => {
    const knowledgeService = {
      search: vi.fn(),
      list: vi.fn(),
      get: vi.fn(),
      getStats: vi.fn(),
    };
    const feedbackCollector = {
      getGlobalStats: vi.fn(),
      getTopRecipes: vi.fn(),
      getRecipeStats: vi.fn(),
    };
    const context = baseContext({
      toolCallContext: {
        serviceContracts: {
          knowledge: {
            getKnowledgeService: () => knowledgeService,
            getSearchEngine: () => null,
            getKnowledgeGraphService: () => null,
          },
          quality: {
            getQualityScorer: () => null,
            getRecipeCandidateValidator: () => null,
            getFeedbackCollector: () => feedbackCollector,
          },
        },
      },
    });

    expect(requireKnowledgeService(resolveKnowledgeServicesFromContext(context))).toBe(
      knowledgeService
    );
    expect(getFeedbackCollector(resolveQualityServicesFromContext(context))).toBe(
      feedbackCollector
    );
    expect(context.container.get).not.toHaveBeenCalled();
  });
});

function baseContext(
  overrides: { toolCallContext?: Partial<InternalToolHandlerContext['toolCallContext']> } = {}
): InternalToolHandlerContext {
  const containerGet = vi.fn(() => {
    throw new Error('raw container must not be used for service contract resolution');
  });
  return {
    container: { get: containerGet },
    projectRoot: '/tmp/project',
    toolCallContext: {
      callId: 'call_1',
      toolId: 'tool_1',
      surface: 'runtime',
      actor: { role: 'runtime' },
      source: { kind: 'runtime', name: 'test' },
      projectRoot: '/tmp/project',
      services: { get: containerGet },
      ...overrides.toolCallContext,
    },
  };
}

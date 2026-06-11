import { describe, expect, test, vi } from 'vitest';
import { search } from '../../lib/resident/tool-handlers/search.js';
import { taskHandler } from '../../lib/resident/tool-handlers/task.js';
import { createIdleIntent } from '../../lib/resident/tool-schema/types.js';
import {
  applyHostIntentContext,
  createHostIntentContextMeta,
  normalizeHostIntentContext,
} from '../../lib/service/task/HostIntentContext.js';
import { extract } from '../../lib/service/task/IntentExtractor.js';

describe('host intent context consumption', () => {
  test('normalizes Plugin host intent context while preserving canonical host values', () => {
    const context = normalizeHostIntentContext({
      activeFile: 'src/fallback.py',
      hostDeclaredIntent: {
        confidence: 0.83,
        intent: 'generate',
        keywords: ['factory', '注入'],
        query: 'compose service factory',
        sourceRefs: ['host:intent'],
      },
      hostTurnMeta: {
        activeFile: 'src/service.ts',
        language: 'typescript',
        sessionHistory: [{ content: 'previous turn about dependency injection' }],
      },
      language: 'python',
      userQuery: 'fallback query',
    });
    const extracted = applyHostIntentContext(
      extract(context.userQuery, context.activeFile, context.language),
      context
    );

    expect(context).toMatchObject({
      activeFile: 'src/service.ts',
      applied: true,
      compatibility: {
        cleanupTrigger:
          'Remove legacy userQuery/activeFile/language fallback after the Plugin host-intent frame is the only current consumer input path.',
        consumer: 'alembic-plugin',
        fallbackAllowed: true,
        fallbackFields: ['userQuery', 'activeFile', 'language'],
        mode: 'mixed-host-intent-and-legacy-args',
        owner: 'alembic-main',
        redacted: true,
      },
      confidence: 0.83,
      language: 'typescript',
      mode: 'mixed-host-intent-and-legacy-args',
      scenario: 'generate',
      searchIntent: 'generate',
      sourceRefs: ['host:intent'],
      userQuery: 'compose service factory',
    });
    expect(context.sessionHistory).toEqual([
      { content: 'previous turn about dependency injection' },
    ]);
    expect(extracted).toMatchObject({
      language: 'typescript',
      raw: {
        activeFile: 'src/service.ts',
        language: 'typescript',
        userQuery: 'compose service factory',
      },
      scenario: 'generate',
    });
    expect(extracted.keywordQueries.join(' ')).toContain('factory');

    const meta = createHostIntentContextMeta(context);
    expect(meta).toMatchObject({
      compatibility: {
        consumer: 'alembic-plugin',
        fallbackFields: ['userQuery', 'activeFile', 'language'],
        mode: 'mixed-host-intent-and-legacy-args',
        owner: 'alembic-main',
        redacted: true,
      },
      mode: 'mixed-host-intent-and-legacy-args',
    });
    expect(JSON.stringify(meta)).not.toContain('fallback query');
    expect(JSON.stringify(meta)).not.toContain('src/fallback.py');
  });

  test('exposes an explicit legacy-only mode without applying host intent', () => {
    const context = normalizeHostIntentContext({
      activeFile: 'src/legacy.ts',
      language: 'typescript',
      userQuery: 'legacy query',
    });

    expect(context).toMatchObject({
      applied: false,
      compatibility: {
        consumer: 'alembic-plugin',
        fallbackAllowed: true,
        fallbackFields: ['userQuery', 'activeFile', 'language'],
        mode: 'legacy-args-only',
        owner: 'alembic-main',
      },
      mode: 'legacy-args-only',
      userQuery: 'legacy query',
    });
    expect(createHostIntentContextMeta(context)).toBeNull();
  });

  test('task prime passes host context into PrimeSearchPipeline and response metadata', async () => {
    const pipeline = {
      search: vi.fn().mockResolvedValue({
        guardRules: [],
        relatedKnowledge: [
          {
            actionHint: 'Use the service factory recipe',
            id: 'recipe-1',
            kind: 'pattern',
            sourceRefs: ['recipes/service-factory.md'],
            title: 'Service Factory',
            trigger: 'service factory',
          },
        ],
        searchMeta: {
          filteredCount: 1,
          hostIntentApplied: true,
          hostIntentConfidence: 0.9,
          hostIntentDegraded: false,
          hostIntentSourceRefs: ['host:intent'],
          language: 'typescript',
          module: 'src/service.ts',
          queries: ['service factory'],
          resultCount: 1,
          scenario: 'generate',
        },
      }),
    };
    const ctx = {
      container: {
        get: vi.fn((name: string) => (name === 'primeSearchPipeline' ? pipeline : null)),
      },
      session: {
        id: 'session-1',
        intent: createIdleIntent(),
        lastActivityAt: Date.now(),
        startedAt: Date.now(),
        toolCallCount: 0,
        toolsUsed: new Set<string>(),
      },
    };

    const result = await taskHandler(ctx, {
      activeFile: 'src/fallback.ts',
      hostDeclaredIntent: {
        confidence: 0.9,
        intent: 'generate',
        query: 'service factory',
        sourceRefs: ['host:intent'],
      },
      hostTurnMeta: {
        activeFile: 'src/service.ts',
        language: 'typescript',
        sessionHistory: [{ content: 'previous turn' }],
      },
      operation: 'prime',
      userQuery: 'fallback query',
    });

    expect(pipeline.search).toHaveBeenCalledWith(
      expect.objectContaining({
        language: 'typescript',
        raw: expect.objectContaining({
          activeFile: 'src/service.ts',
          userQuery: 'service factory',
        }),
        scenario: 'generate',
      }),
      expect.objectContaining({
        hostIntent: expect.objectContaining({
          applied: true,
          confidence: 0.9,
          sourceRefs: ['host:intent'],
        }),
        intentSearchPlan: expect.objectContaining({
          applied: false,
          executableQuery: 'service factory',
        }),
        sessionHistory: [{ content: 'previous turn' }],
      })
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        intentContext: {
          applied: true,
          confidence: 0.9,
          degraded: false,
          sourceRefs: ['host:intent'],
        },
        searchMeta: {
          hostIntentApplied: true,
          hostIntentConfidence: 0.9,
        },
      },
    });
    expect(ctx.session.intent.primeQuery).toBe('service factory');
    expect(ctx.session.intent.primeActiveFile).toBe('src/service.ts');
  });

  test('resident search maps host context into SearchEngine query context', async () => {
    const searchEngine = {
      search: vi.fn().mockResolvedValue({
        items: [
          {
            description: 'A matching recipe',
            id: 'recipe-2',
            kind: 'pattern',
            language: 'typescript',
            score: 0.7,
            title: 'Intent Search',
            trigger: 'intent search',
          },
        ],
        mode: 'bm25',
        ranked: true,
      }),
    };
    const ctx = {
      container: {
        get: vi.fn((name: string) => {
          if (name === 'searchEngine') {
            return searchEngine;
          }
          throw new Error(`unexpected service: ${name}`);
        }),
      },
    };

    const result = await search(ctx, {
      hostDeclaredIntent: {
        intent: 'search',
        query: 'semantic source refs',
        sourceRefs: ['host:intent'],
      },
      hostTurnMeta: {
        language: 'typescript',
        sessionHistory: [{ content: 'previous search turn' }],
      },
      mode: 'bm25',
      query: 'fallback query',
    });

    expect(searchEngine.search).toHaveBeenCalledWith(
      'semantic source refs',
      expect.objectContaining({
        context: {
          intent: 'search',
          language: 'typescript',
          sessionHistory: [{ content: 'previous search turn' }],
        },
      })
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        intentContext: {
          applied: true,
          sourceRefs: ['host:intent'],
        },
        query: 'semantic source refs',
      },
    });
  });
});

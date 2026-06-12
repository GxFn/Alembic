/**
 * Train B MT3 — usage-error hardening regression negatives.
 *
 * One negative per harvested/matrix-flagged misuse case on Alembic-owned
 * surfaces:
 *   - submit_knowledge all-rejected answered zh-only prose with no
 *     field-level problem detail (certification matrix completeness-FAIL)
 *   - alembic_graph cross-field gaps threw opaque "<key> is required"
 *     errors although the schema marks the keys optional (schema-honesty)
 *   - bootstrap refine silently truncated the published-recipe list at 20
 *     inside the AI prompt (cap honesty, misuse-harvest resident class B)
 */

import { describe, expect, it, vi } from 'vitest';
import {
  formatPublishedTitles,
  PUBLISHED_TITLES_PROMPT_CAP,
} from '../../lib/resident/tool-handlers/bootstrap/refine.js';
import { enhancedSubmitKnowledge } from '../../lib/resident/tool-handlers/consolidated.js';
import { graphPath, graphQuery } from '../../lib/resident/tool-handlers/structure.js';
import { GraphInputChecked } from '../../lib/shared/schemas/mcp-tools.js';

function mockCtx(services: Record<string, unknown>) {
  return {
    container: {
      get: vi.fn((name: string) => {
        if (name in services) {
          return services[name];
        }
        return null;
      }),
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  } as never;
}

describe('MT3 usage-error hardening', () => {
  describe('submit_knowledge all-rejected carries a structured problem', () => {
    it('returns taxonomy problem with field-level detail instead of zh-only prose', async () => {
      const knowledgeService = {
        list: vi.fn(async () => ({ items: [], total: 0 })),
        get: vi.fn(async () => null),
      };
      const ctx = mockCtx({ knowledgeService });

      const result = await enhancedSubmitKnowledge(ctx, {
        items: [{ title: 'incomplete item with only a title' }],
        client_id: `mt3-test-${Math.random().toString(36).slice(2)}`,
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('INCOMPLETE_SUBMISSION');
      const problem = (result as { problem?: Record<string, unknown> }).problem;
      expect(problem).toBeDefined();
      expect(problem?.code).toBe('INCOMPLETE_SUBMISSION');
      expect(problem?.reasonCode).toBe('invalid-input');
      expect(problem?.failingStep).toBe('recipe-production-gateway-validation');
      expect(typeof problem?.nextAction).toBe('string');
      expect(problem?.retryable).toBe(true);
      const fieldProblems = problem?.fieldProblems as Array<{ field: string; error: string }>;
      expect(Array.isArray(fieldProblems)).toBe(true);
      expect(fieldProblems.length).toBeGreaterThan(0);
      expect(fieldProblems[0].field).toMatch(/^items\[\d+\]$/);
      // The message is no longer zh-only: it points at the structured detail.
      expect(result.message).toContain('problem.fieldProblems');
    });
  });

  describe('alembic_graph cross-field usage gates', () => {
    it('graphQuery without nodeId answers a problem envelope instead of throwing', async () => {
      const ctx = mockCtx({ knowledgeGraphService: {} });
      const result = await graphQuery(ctx, { operation: 'query' });
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GRAPH_ARG_MISSING');
      const problem = (result as { problem?: Record<string, unknown> }).problem;
      expect(problem?.reasonCode).toBe('invalid-input');
      expect(problem?.fieldProblems).toEqual([
        { field: 'nodeId', error: 'nodeId is required when operation=query' },
      ]);
    });

    it('graphPath reports every missing endpoint field', async () => {
      const ctx = mockCtx({ knowledgeGraphService: {} });
      const result = await graphPath(ctx, { operation: 'path' });
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('GRAPH_ARG_MISSING');
      const problem = (result as { problem?: Record<string, unknown> }).problem;
      const fields = (problem?.fieldProblems as Array<{ field: string }>).map((p) => p.field);
      expect(fields).toEqual(['fromId', 'toId']);
    });

    it('GraphInputChecked schema enforces the operation-dependent requirements', () => {
      expect(GraphInputChecked.safeParse({ operation: 'query' }).success).toBe(false);
      expect(GraphInputChecked.safeParse({ operation: 'query', nodeId: 'n1' }).success).toBe(true);
      expect(GraphInputChecked.safeParse({ operation: 'impact' }).success).toBe(false);
      const path = GraphInputChecked.safeParse({ operation: 'path', fromId: 'a' });
      expect(path.success).toBe(false);
      if (!path.success) {
        expect(path.error.issues.map((issue) => issue.path.join('.'))).toContain('toId');
      }
      expect(GraphInputChecked.safeParse({ operation: 'stats' }).success).toBe(true);
    });
  });

  describe('bootstrap refine prompt cap honesty', () => {
    it('declares truncation when more than the cap of published recipes exist', () => {
      const titles = Array.from({ length: 25 }, (_, i) => `Recipe-${i + 1}`);
      const rendered = formatPublishedTitles(titles);
      expect(rendered).toContain(`前 ${PUBLISHED_TITLES_PROMPT_CAP} 个`);
      expect(rendered).toContain('共 25 个');
      expect(rendered).toContain('Recipe-20');
      expect(rendered).not.toContain('Recipe-21');
    });

    it('renders the full list without truncation wording when under the cap', () => {
      const rendered = formatPublishedTitles(['A', 'B']);
      expect(rendered).toBe('已发布的 Recipe: A, B');
    });
  });
});

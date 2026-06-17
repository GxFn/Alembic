/**
 * Train B MT3 — usage-error hardening regression negatives (RIC-3 trim).
 *
 * The submit_knowledge all-rejected and alembic_graph cross-field negatives
 * exercised the resident MCP-mirror handlers (consolidated.ts / structure.ts),
 * which RIC-3 deleted (MCP capability unified into AlembicPlugin). The surviving
 * Alembic-owned negatives:
 *   - alembic_graph GraphInputChecked schema honesty (schema stays in mcp-tools)
 *   - bootstrap refine published-recipe cap honesty (relocated to service/bootstrap)
 */

import { describe, expect, it } from 'vitest';
import {
  formatPublishedTitles,
  PUBLISHED_TITLES_PROMPT_CAP,
} from '../../lib/service/bootstrap/BootstrapRefine.js';
import { GraphInputChecked } from '../../lib/shared/schemas/mcp-tools.js';

describe('MT3 usage-error hardening', () => {
  describe('alembic_graph cross-field usage gates', () => {
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
